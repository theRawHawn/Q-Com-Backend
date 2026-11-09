process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { setPool, getPool } from '../src/database/connection.js';
import { runMigrations } from '../src/database/migrator.js';
import { runSeeds } from '../seeds/seedData.js';
import { createTestDatabase } from './helpers/testDb.js';
import { env } from '../src/config/env.js';
import { orderService } from '../src/modules/orders/orderService.js';
import { outboxService } from '../src/modules/outbox/outboxService.js';
import { createSlidingWindowRateLimiter } from '../src/middleware/rateLimiter.js';

const REAL_PG_URL = process.env.TEST_DATABASE_URL || 'postgres://qcom_user:qcom_password@127.0.0.1:5432/qcom_test';

export async function runSprint15_2CapacityConcurrencyAndResilienceTests(): Promise<void> {
  console.log('\n================================================================================');
  console.log('  SPRINT 15.2 — CAPACITY, CONCURRENCY & OPERATIONAL RESILIENCE TEST SUITE');
  console.log('================================================================================');

  // 1. Establish Database Pool
  console.log('\n--- Step 1: Initializing Database & Environment ---');
  let realPool: pg.Pool;
  let isRealPg = false;
  try {
    const probePool = new pg.Pool({
      connectionString: REAL_PG_URL,
      max: 20,
      idleTimeoutMillis: 5000,
      connectionTimeoutMillis: 1500,
    });
    const versionRes = await probePool.query('SELECT version();');
    const pgVersion = versionRes.rows[0].version;
    console.log(`[Real PostgreSQL] Connected: ${pgVersion}`);
    realPool = probePool;
    isRealPg = true;
  } catch (err: any) {
    console.log(`[Database Notice] Real PostgreSQL 16 is unavailable (${err.message}). Using pg-mem database.`);
    realPool = createTestDatabase().pool;
  }

  setPool(realPool);
  await runMigrations({ poolOverride: realPool });
  await runSeeds(realPool);

  // 2. Start HTTP Server
  const app = createApp();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as import('net').AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  async function apiCall(path: string, options: { method?: string; token?: string; body?: any; headers?: any } = {}) {
    const headers: any = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (options.token) {
      headers['Authorization'] = `Bearer ${options.token}`;
    }
    const res = await fetch(`${baseUrl}${path}`, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    let data: any = null;
    const text = await res.text();
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: res.status, headers: res.headers, data };
  }

  // Authenticate Customer
  const authCustomer = await apiCall('/api/auth/request-otp', { method: 'POST', body: { phone: '+91-9988776655', role: 'CUSTOMER' } });
  const verifyCustomer = await apiCall('/api/auth/verify-otp', {
    method: 'POST',
    body: { phone: '+91-9988776655', otp: authCustomer.data.debugOtp || '123456', name: 'Capacity Test Customer' }
  });
  const customerToken = verifyCustomer.data.token || verifyCustomer.data.accessToken;
  const customerId = verifyCustomer.data.user.id;

  // Authenticate Admin / Operations (Seeded Super Administrator +91-8000000000)
  const authAdmin = await apiCall('/api/auth/request-otp', { method: 'POST', body: { phone: '+91-8000000000', role: 'ADMIN' } });
  const verifyAdmin = await apiCall('/api/auth/verify-otp', {
    method: 'POST',
    body: { phone: '+91-8000000000', otp: authAdmin.data.debugOtp || '123456', name: 'Super Administrator' }
  });
  const adminToken = verifyAdmin.data.token || verifyAdmin.data.accessToken;

  // Obtain merchant ID from seeded merchants
  const merchantRes = await realPool.query(`SELECT id FROM merchants WHERE status = 'ACTIVE' LIMIT 1`);
  assert.ok(merchantRes.rows.length > 0, 'Seeded merchant must exist');
  const merchantId = merchantRes.rows[0].id;

  // ---------------------------------------------------------------------------
  // PILLAR 1: RATE LIMITING & GRACEFUL DEGRADATION
  // ---------------------------------------------------------------------------
  console.log('\n--- Pillar 1: Rate Limiting & Graceful Degradation Verification ---');

  // Test 1.1: Verify custom rate limiter enforces sliding window threshold and emits standard headers
  const mockStorage = new Map<string, number>();
  const testLimiter = createSlidingWindowRateLimiter(
    {
      limit: 3,
      windowSec: 60,
      scope: 'test-capacity-limit',
      errorMessage: 'Test rate limit reached.',
    },
    async (key, limit, windowSec) => {
      const current = (mockStorage.get(key) || 0) + 1;
      mockStorage.set(key, current);
      return {
        allowed: current <= limit,
        remaining: Math.max(0, limit - current),
        resetSec: windowSec,
      };
    }
  );

  let reqCount = 0;
  const mockReq: any = { ip: '127.0.0.1', socket: {}, baseUrl: '/api', path: '/test' };
  const mockRes: any = {
    headers: {} as Record<string, string>,
    statusCode: 200,
    body: null as any,
    setHeader(name: string, val: string) { this.headers[name] = val; },
    status(code: number) { this.statusCode = code; return this; },
    json(payload: any) { this.body = payload; },
  };

  // 1st request -> allowed
  await testLimiter(mockReq, mockRes, () => { reqCount++; });
  assert.strictEqual(reqCount, 1, 'First request should be allowed');
  assert.strictEqual(mockRes.headers['X-RateLimit-Limit'], '3');
  assert.strictEqual(mockRes.headers['X-RateLimit-Remaining'], '2');

  // 2nd request -> allowed
  await testLimiter(mockReq, mockRes, () => { reqCount++; });
  assert.strictEqual(reqCount, 2, 'Second request should be allowed');

  // 3rd request -> allowed
  await testLimiter(mockReq, mockRes, () => { reqCount++; });
  assert.strictEqual(reqCount, 3, 'Third request should be allowed');
  assert.strictEqual(mockRes.headers['X-RateLimit-Remaining'], '0');

  // 4th request -> blocked with HTTP 429 and Retry-After header
  await testLimiter(mockReq, mockRes, () => { reqCount++; });
  assert.strictEqual(reqCount, 3, 'Fourth request must be blocked');
  assert.strictEqual(mockRes.statusCode, 429, 'Blocked request must return HTTP 429');
  assert.strictEqual(mockRes.headers['Retry-After'], '60', 'Must emit Retry-After header');
  assert.strictEqual(mockRes.body.error.code, 'RATE_LIMIT_EXCEEDED');
  console.log('  ✓ Test 1.1 Passed: Sliding-window rate limiter enforces threshold, emits Retry-After and X-RateLimit-* headers.');

  // Test 1.2: Verify failureMode: 'open' safely passes requests when distributed cache fails
  const openDegradedLimiter = createSlidingWindowRateLimiter(
    {
      limit: 10,
      windowSec: 60,
      failureMode: 'open',
    },
    async () => {
      throw new Error('Redis connection ECONNREFUSED simulation');
    }
  );

  let degradedAllowed = false;
  const mockDegradedRes: any = {
    headers: {} as Record<string, string>,
    setHeader(name: string, val: string) { this.headers[name] = val; },
  };
  await openDegradedLimiter(mockReq, mockDegradedRes, () => { degradedAllowed = true; });
  assert.strictEqual(degradedAllowed, true, 'failureMode: open must not block users on cache downtime');
  assert.strictEqual(mockDegradedRes.headers['X-RateLimit-Status'], 'unavailable');
  console.log('  ✓ Test 1.2 Passed: Graceful degradation (failureMode: open) allows traffic during cache unavailability.');

  // ---------------------------------------------------------------------------
  // PILLAR 2: LATENCY & N+1 QUERY RESOLUTION
  // ---------------------------------------------------------------------------
  console.log('\n--- Pillar 2: Latency & N+1 Query Resolution Verification ---');

  // Create multiple orders with items for the customer
  const prodRes = await realPool.query(`SELECT id FROM products LIMIT 2`);
  const prodA = prodRes.rows[0].id;
  const prodB = prodRes.rows[1]?.id || prodA;

  // Insert 3 test orders with items directly in DB
  const testOrderIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  for (let idx = 0; idx < testOrderIds.length; idx++) {
    const oId = testOrderIds[idx];
    await realPool.query(`
      INSERT INTO orders (id, order_number, user_id, merchant_id, status, items_subtotal, delivery_fee, handling_fee, urgency_fee, discount_amount, taxable_amount, cgst_amount, sgst_amount, igst_amount, total_amount, withholding_amount, gst_tcs_amount, payment_method, payment_status, delivery_otp, handover_token, jobsite_address, place_of_supply_state_code, pricing_snapshot, estimated_delivery_at)
      VALUES ($1, $2, $3, $4, 'placed', 200.00, 30.00, 10.00, 0.00, 0.00, 240.00, 21.60, 21.60, 0.00, 283.20, 0.00, 0.00, 'Pay on Delivery', 'PENDING', '123456', 'TOK123', '{"address":"Bangalore"}', '29', '{"grandTotal":283.20}', NOW() + INTERVAL '25 minutes')
    `, [oId, `QC-TEST-${idx + 1}`, customerId, merchantId]);

    // Insert 2 items for each order
    await realPool.query(`
      INSERT INTO order_items (id, order_id, product_id, product_name, unit_price, quantity, total_price, hsn_code, taxable_amount, gst_rate_percent, cgst_amount, sgst_amount, igst_amount)
      VALUES 
        ($1, $2, $3, 'Product A', 100.00, 1, 100.00, '8481', 100.00, 18.00, 9.00, 9.00, 0.00),
        ($4, $2, $5, 'Product B', 100.00, 1, 100.00, '8481', 100.00, 18.00, 9.00, 9.00, 0.00)
    `, [crypto.randomUUID(), oId, prodA, crypto.randomUUID(), prodB]);
  }

  // Intercept pool query calls to verify query count
  let queryCount = 0;
  const originalQuery = realPool.query.bind(realPool);
  realPool.query = async (...args: any[]) => {
    queryCount++;
    return (originalQuery as any)(...args);
  };

  queryCount = 0;
  const retrievedOrders = await orderService.getOrders(customerId);
  realPool.query = originalQuery; // Restore original

  assert.ok(retrievedOrders.length >= 3, 'Must retrieve all customer orders');
  const firstOrder = retrievedOrders[0];
  assert.ok(firstOrder && firstOrder.items, 'First order and items must exist');
  assert.strictEqual(firstOrder.items.length, 2, 'Each order must have its items populated');
  // With N+1 resolved, total queries must be exactly 2 (1 for orders + 1 bulk fetch for items), NOT 1 + N (4+)
  assert.strictEqual(queryCount, 2, `getOrders must execute exactly 2 queries (orders + batch items), got: ${queryCount}`);
  console.log(`  ✓ Test 2.1 Passed: N+1 query eliminated. Retrieved ${retrievedOrders.length} orders and all items in exactly ${queryCount} database round-trips.`);

  // ---------------------------------------------------------------------------
  // PILLAR 3: THROUGHPUT & STATEMENT TIMEOUT CONFIGURATION
  // ---------------------------------------------------------------------------
  console.log('\n--- Pillar 3: Throughput & Database Statement Timeout Protection ---');

  assert.ok(env.DATABASE_STATEMENT_TIMEOUT_MS > 0, 'DATABASE_STATEMENT_TIMEOUT_MS must be configured');
  assert.ok(env.DATABASE_QUERY_TIMEOUT_MS > 0, 'DATABASE_QUERY_TIMEOUT_MS must be configured');
  assert.strictEqual(env.DATABASE_STATEMENT_TIMEOUT_MS, 10000, 'Default statement timeout should be 10000ms');
  console.log(`  ✓ Test 3.1 Passed: Database pool configured with statement_timeout: ${env.DATABASE_STATEMENT_TIMEOUT_MS}ms to protect connections from long-running lock tie-ups.`);

  // ---------------------------------------------------------------------------
  // PILLAR 4: CONCURRENCY — ATOMIC SELLER ORDER ACCEPTANCE
  // ---------------------------------------------------------------------------
  console.log('\n--- Pillar 4: Concurrency — Atomic Single-Winner Seller Acceptance ---');

  // Create a fresh placed order
  const raceOrderId = crypto.randomUUID();
  await realPool.query(`
    INSERT INTO orders (id, order_number, user_id, merchant_id, status, items_subtotal, delivery_fee, handling_fee, urgency_fee, discount_amount, taxable_amount, cgst_amount, sgst_amount, igst_amount, total_amount, withholding_amount, gst_tcs_amount, payment_method, payment_status, delivery_otp, handover_token, jobsite_address, place_of_supply_state_code, pricing_snapshot, estimated_delivery_at)
    VALUES ($1, 'QC-RACE-001', $2, $3, 'placed', 100.00, 30.00, 10.00, 0.00, 0.00, 140.00, 12.60, 12.60, 0.00, 165.20, 0.00, 0.00, 'Pay on Delivery', 'PENDING', '654321', 'TOK999', '{"address":"Race Order"}', '29', '{"grandTotal":165.20}', NOW() + INTERVAL '25 minutes')
  `, [raceOrderId, customerId, merchantId]);

  // Two concurrent seller terminals attempt to accept the order simultaneously
  const [acceptRes1, acceptRes2] = await Promise.all([
    apiCall(`/api/orders/${raceOrderId}/accept-seller`, {
      method: 'POST',
      token: adminToken, // Admin has authorized global operations role
    }),
    apiCall(`/api/orders/${raceOrderId}/accept-seller`, {
      method: 'POST',
      token: adminToken,
    }),
  ]);

  const statuses = [acceptRes1.status, acceptRes2.status].sort();
  assert.deepStrictEqual(statuses, [200, 409], `Concurrent accept must result in [200, 409], got [${acceptRes1.status}, ${acceptRes2.status}]`);
  const winner = acceptRes1.status === 200 ? acceptRes1 : acceptRes2;
  const loser = acceptRes1.status === 409 ? acceptRes1 : acceptRes2;

  assert.strictEqual(winner.data.success, true);
  assert.strictEqual(winner.data.order.status, 'accepted');
  assert.strictEqual(loser.data.error, 'ORDER_ALREADY_ACCEPTED');
  console.log('  ✓ Test 4.1 Passed: Atomic single-winner seller order acceptance. Exactly 1 winner (HTTP 200) and 1 conflict (HTTP 409).');

  // ---------------------------------------------------------------------------
  // PILLAR 5: CONCURRENCY — ATOMIC RIDER TASK ACCEPTANCE
  // ---------------------------------------------------------------------------
  console.log('\n--- Pillar 5: Concurrency — Atomic Single-Winner Delivery Task Acceptance ---');

  const tripId = crypto.randomUUID();
  const tripOrderId = crypto.randomUUID();

  // Create delivery trip in BROADCASTING status
  await realPool.query(`
    INSERT INTO orders (id, order_number, user_id, merchant_id, status, items_subtotal, delivery_fee, handling_fee, urgency_fee, discount_amount, taxable_amount, cgst_amount, sgst_amount, igst_amount, total_amount, withholding_amount, gst_tcs_amount, payment_method, payment_status, delivery_otp, handover_token, jobsite_address, place_of_supply_state_code, pricing_snapshot, estimated_delivery_at)
    VALUES ($1, 'QC-TRIP-001', $2, $3, 'placed', 100.00, 30.00, 10.00, 0.00, 0.00, 140.00, 12.60, 12.60, 0.00, 165.20, 0.00, 0.00, 'Pay on Delivery', 'PENDING', '654321', 'TOK999', '{"address":"Trip Order"}', '29', '{"grandTotal":165.20}', NOW() + INTERVAL '25 minutes')
  `, [tripOrderId, customerId, merchantId]);

  await realPool.query(`
    INSERT INTO delivery_trips (id, order_id, status, base_fare, distance_fare, surge_fare, total_rider_payout)
    VALUES ($1, $2, 'BROADCASTING', 40.00, 10.00, 0.00, 50.00)
  `, [tripId, tripOrderId]);

  // Authenticate two distinct delivery partners
  const rider1Phone = '+91-9812345678';
  const rider1OtpReq = await apiCall('/api/auth/request-otp', { method: 'POST', body: { phone: rider1Phone } });
  const rider1Otp = await apiCall('/api/auth/verify-otp', {
    method: 'POST',
    body: { phone: rider1Phone, otp: rider1OtpReq.data.debugOtp || '123456', name: 'Arjun Teja' },
  });
  const rider1Token = rider1Otp.data.token || rider1Otp.data.accessToken;

  const rider2Phone = '+91-9812345679';
  const rider2OtpReq = await apiCall('/api/auth/request-otp', { method: 'POST', body: { phone: rider2Phone } });
  const rider2Otp = await apiCall('/api/auth/verify-otp', {
    method: 'POST',
    body: { phone: rider2Phone, otp: rider2OtpReq.data.debugOtp || '123456', name: 'Kiran Kumar' },
  });
  const rider2Token = rider2Otp.data.token || rider2Otp.data.accessToken;

  // Two delivery partners attempt to claim the broadcasted trip concurrently
  const [taskClaim1, taskClaim2] = await Promise.all([
    apiCall(`/api/tasks/${tripId}/accept`, { method: 'POST', token: rider1Token }),
    apiCall(`/api/tasks/${tripId}/accept`, { method: 'POST', token: rider2Token }),
  ]);

  const taskStatuses = [taskClaim1.status, taskClaim2.status].sort();
  assert.deepStrictEqual(taskStatuses, [200, 409], `Concurrent task accept must result in [200, 409], got [${taskClaim1.status}, ${taskClaim2.status}]`);
  const taskWinner = taskClaim1.status === 200 ? taskClaim1 : taskClaim2;
  const taskLoser = taskClaim1.status === 409 ? taskClaim1 : taskClaim2;

  assert.strictEqual(taskWinner.data.success, true);
  assert.strictEqual(taskWinner.data.status, 'ACCEPTED');
  assert.strictEqual(taskLoser.data.error, 'TASK_ALREADY_CLAIMED');
  console.log('  ✓ Test 5.1 Passed: Atomic single-winner delivery task acceptance. Exactly 1 rider claimed the task (HTTP 200), concurrent claimant blocked (HTTP 409).');

  // Test 5.2: Admin rider re-assignment guard prevents overwriting non-eligible trip
  const riderRes = await realPool.query(`SELECT id FROM riders LIMIT 1`);
  const validRiderId = riderRes.rows[0].id;
  const assignBlocked = await apiCall(`/api/admin/orders/${tripOrderId}/assign-rider`, {
    method: 'POST',
    token: adminToken,
    body: { riderId: validRiderId },
  });
  // Since status is already ACCEPTED, it should be protected from blind reassignment
  assert.strictEqual(assignBlocked.status, 409, 'Assigning rider to an already accepted trip must return HTTP 409');
  assert.ok(
    assignBlocked.data.error === 'INVALID_TRIP_STATE' || assignBlocked.data.error === 'ALREADY_ASSIGNED',
    `Expected INVALID_TRIP_STATE or ALREADY_ASSIGNED, got ${assignBlocked.data.error}`
  );
  console.log('  ✓ Test 5.2 Passed: Admin rider assignment guard prevents double-assignment conflict (HTTP 409).');

  // ---------------------------------------------------------------------------
  // PILLAR 6: BACKPRESSURE & QUEUE DEPTH MONITORING
  // ---------------------------------------------------------------------------
  console.log('\n--- Pillar 6: Backpressure & Outbox Queue Depth Monitoring ---');

  const initialQueueDepth = await outboxService.getPendingQueueDepth();
  assert.ok(typeof initialQueueDepth === 'number', 'Queue depth must be a number');

  const metrics = await outboxService.getBackpressureMetrics(5000);
  assert.ok(typeof metrics.pendingCount === 'number');
  assert.ok(typeof metrics.isOverloaded === 'boolean');
  assert.strictEqual(metrics.isOverloaded, false, 'Initial test queue should not be overloaded');

  // Test overload trigger at low threshold
  const testOverload = await outboxService.getBackpressureMetrics(0); // 0 threshold forces isOverloaded if depth >= 0
  assert.strictEqual(testOverload.isOverloaded, true, 'Threshold exceeded must flag isOverloaded: true');
  assert.ok(testOverload.recommendedBackoffMs >= 500, 'Overloaded metrics must recommend positive backoff');
  console.log('  ✓ Test 6.1 Passed: Outbox backpressure monitoring calculates queue depth and emits recommended backoff.');

  // Clean up server
  await new Promise<void>((resolve) => server.close(() => resolve()));

  console.log('\n================================================================================');
  console.log('  ALL SPRINT 15.2 CAPACITY, CONCURRENCY & RESILIENCE TESTS PASSED!');
  console.log('================================================================================\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSprint15_2CapacityConcurrencyAndResilienceTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
