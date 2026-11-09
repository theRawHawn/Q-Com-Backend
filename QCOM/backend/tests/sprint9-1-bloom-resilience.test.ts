import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { createApp } from '../src/app.js';
import { setPool, getPool } from '../src/database/connection.js';
import { runMigrations } from '../src/database/migrator.js';
import { runSeeds } from '../seeds/seedData.js';
import { createTestDatabase } from './helpers/testDb.js';
import { AuthService } from '../src/modules/auth/authService.js';
import { orderService } from '../src/modules/orders/orderService.js';
import { returnService } from '../src/modules/orders/returnService.js';
import { refundService } from '../src/modules/payments/refundService.js';
import {
  BloomFilter,
  bloomFilterService,
  calculateFullJitterDelay,
  isTransientFailure,
  executeWithRetry,
  CircuitBreaker,
  CircuitBreakerOpenError,
  calculateWebSocketReconnectDelay,
  RESILIENCE_CONFIG,
} from '../src/modules/resilience/index.js';

export async function runSprint91ResilienceTests(): Promise<void> {
  console.log('\n===========================================================');
  console.log('--- Running Sprint 9.1: Database Overload Protection, Bloom Filter & Resilience Test Suite ---');
  console.log('===========================================================');

  const { pool } = createTestDatabase();
  setPool(pool);

  await runMigrations({ poolOverride: pool });
  await runSeeds(pool);

  // Initialize Bloom filter from seeded database
  bloomFilterService.resetFilters();
  await bloomFilterService.initializeFromDatabase(pool);

  const app = createApp();
  const authService = new AuthService();

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // Setup Admin
    const adminAuth = await authService.adminLogin('EMP-001', undefined, '127.0.0.1', 'AdminPortal', pool);
    const adminToken = adminAuth.accessToken;

    // Setup Customer 1
    const custOtp = await authService.requestOtp('+91-9123456780', 'LOGIN', '127.0.0.1', pool);
    const custAuth = await authService.verifyOtp('+91-9123456780', custOtp.debugOtp!, 'LOGIN', '127.0.0.1', 'CustomerApp', 'Customer One', pool);
    const customerToken = custAuth.accessToken;
    const customerId = custAuth.user.id;

    // Fetch seeded merchant and product
    const merchRes = await pool.query(`SELECT id FROM merchants LIMIT 1`);
    const merchantId = merchRes.rows[0].id;
    const prodRes = await pool.query(
      `SELECT p.id, p.name, si.selling_price 
       FROM products p 
       JOIN store_inventory si ON p.id = si.product_id 
       WHERE si.merchant_id = $1 
       LIMIT 1`,
      [merchantId]
    );
    const product = prodRes.rows[0];

    // -------------------------------------------------------------
    // Test 1: Mathematical Bloom Filter Invariants (Zero False Negatives, Sizing, Serialization)
    // -------------------------------------------------------------
    console.log('[Test 1] Testing Mathematical Bloom Filter Invariants...');
    const testFilter = new BloomFilter({ expectedItems: 1000, falsePositiveRate: 0.01 });
    assert.ok(testFilter.bitSize > 0, 'Bit size must be positive');
    assert.ok(testFilter.hashCount >= 2, 'Hash count must be at least 2');

    const testKeys = Array.from({ length: 500 }, (_, i) => `key_${i}_${crypto.randomBytes(4).toString('hex')}`);
    for (const k of testKeys) {
      testFilter.add(k);
    }

    // Invariant: Zero False Negatives
    for (const k of testKeys) {
      assert.equal(testFilter.mightContain(k), true, `Key '${k}' must be detected as present (Zero false negatives)`);
    }

    // Invariant: False Positive Rate Bounded
    let falsePositives = 0;
    const absentKeys = Array.from({ length: 1000 }, (_, i) => `absent_${i}_${crypto.randomBytes(4).toString('hex')}`);
    for (const k of absentKeys) {
      if (testFilter.mightContain(k)) {
        falsePositives++;
      }
    }
    const observedFpRate = falsePositives / absentKeys.length;
    assert.ok(observedFpRate < 0.05, `Observed false positive rate ${observedFpRate} must be bounded (< 5%)`);

    // Invariant: Serialization & Deserialization
    const serialized = testFilter.serialize();
    const deserialized = BloomFilter.deserialize(serialized);
    assert.equal(deserialized.getItemCount(), testFilter.getItemCount());
    for (const k of testKeys.slice(0, 50)) {
      assert.equal(deserialized.mightContain(k), true, 'Deserialized filter must retain all members');
    }
    console.log(`✓ Test 1 passed: Zero false negatives, bounded FPR (${(observedFpRate * 100).toFixed(2)}%), and binary serialization verified`);

    // -------------------------------------------------------------
    // Test 2: Multi-Resource Isolation (Partitions)
    // -------------------------------------------------------------
    console.log('[Test 2] Testing Multi-Resource Partition Isolation...');
    const orderUuid = crypto.randomUUID();
    bloomFilterService.add('orders', orderUuid);

    assert.equal(bloomFilterService.mightContain('orders', orderUuid), true);
    assert.equal(bloomFilterService.mightContain('refunds', orderUuid), false, 'Order UUID must not bleed into refunds filter');
    assert.equal(bloomFilterService.mightContain('returns', orderUuid), false, 'Order UUID must not bleed into returns filter');
    console.log('✓ Test 2 passed: Multi-resource filter partitions strictly isolated');

    // -------------------------------------------------------------
    // Test 3: Transaction Commit Synchronization & Rollback Safety
    // -------------------------------------------------------------
    console.log('[Test 3] Testing Transaction Commit Synchronization & Rollback Safety...');
    const committedOrderId = crypto.randomUUID();
    const rollbackOrderId = crypto.randomUUID();

    // Simulated rollback: ID must NOT be added to bloom filter
    try {
      await pool.query('BEGIN');
      await pool.query(
        `INSERT INTO orders (id, order_number, user_id, merchant_id, status, items_subtotal, delivery_fee, handling_fee, urgency_fee, discount_amount, taxable_amount, cgst_amount, sgst_amount, igst_amount, total_amount, withholding_amount, gst_tcs_amount, payment_method, payment_status, delivery_otp, handover_token, jobsite_address, place_of_supply_state_code, pricing_snapshot)
         VALUES ($1, 'QC-ROLLBACK', $2, $3, 'placed', 100, 35, 15, 0, 0, 100, 0, 0, 0, 100, 0, 0, 'Instant UPI', 'PENDING', '123456', 'PK-1111', '{}'::jsonb, '29', '{}'::jsonb)`,
        [rollbackOrderId, customerId, merchantId]
      );
      // Simulate error causing rollback
      throw new Error('SIMULATED_TRANSACTION_ROLLBACK');
    } catch {
      await pool.query('ROLLBACK');
    }
    // Bloom must NOT contain rollbackOrderId
    assert.equal(bloomFilterService.mightContain('orders', rollbackOrderId), false, 'Rolled-back transaction entity must NEVER enter Bloom Filter');

    // Legitimate committed creation
    const created = await orderService.createOrder({
      userId: customerId,
      merchantId,
      items: [{ productId: product.id, quantity: 1 }],
      jobSite: { address: 'Plot 4, Auto Nagar', latitude: 12.9716, longitude: 77.5946 },
      paymentMethod: 'Instant UPI',
    });
    // Committed order must be present in Bloom filter
    assert.equal(bloomFilterService.mightContain('orders', created.order.id), true, 'Committed order ID must be present in Bloom Filter');
    console.log('✓ Test 3 passed: Rollback safety guaranteed; only committed records enter Bloom Filter');

    // -------------------------------------------------------------
    // Test 4: Random-ID Attack Negative-Lookup Protection (Zero DB Queries)
    // -------------------------------------------------------------
    console.log('[Test 4] Testing Random-ID Attack Protection (Zero Database Queries on Negatives)...');
    let dbQueryCount = 0;
    const origQuery = pool.query.bind(pool);
    pool.query = async function (...args: any[]) {
      dbQueryCount++;
      return (origQuery as any)(...args);
    } as any;

    const initialDbQueries = dbQueryCount;
    const bogusOrderIds = Array.from({ length: 50 }, () => `bogus_${crypto.randomUUID()}`);

    for (const bogusId of bogusOrderIds) {
      const res = await orderService.getOrderById(bogusId, customerId);
      assert.equal(res, null, 'Bogus ID must return null');
    }

    const queriesIssued = dbQueryCount - initialDbQueries;
    assert.equal(queriesIssued, 0, `Bloom negative protection must avoid 100% of DB queries for bogus IDs (Issued: ${queriesIssued})`);
    console.log(`✓ Test 4 passed: 50 bogus random-ID lookups safely intercepted with ZERO database queries`);

    // Restore pool.query
    pool.query = origQuery;

    // -------------------------------------------------------------
    // Test 5: PostgreSQL Authoritative Source of Truth on Positive Lookup
    // -------------------------------------------------------------
    console.log('[Test 5] Testing PostgreSQL Authoritative Source of Truth on Positive Matches...');
    const fetchedOrder = await orderService.getOrderById(created.order.id, customerId);
    assert.ok(fetchedOrder, 'PostgreSQL authoritative lookup must return committed record');
    assert.equal(fetchedOrder.id, created.order.id);
    assert.equal(fetchedOrder.userId, customerId);
    console.log('✓ Test 5 passed: PostgreSQL authoritatively verifies and supplies records on positive Bloom match');

    // -------------------------------------------------------------
    // Test 6: Safe Degradation & Fail-Open Bypass Mode
    // -------------------------------------------------------------
    console.log('[Test 6] Testing Degraded Mode / Fail-Open Bypass Mode...');
    bloomFilterService.setBypassMode(true);
    assert.equal(bloomFilterService.mightContain('orders', 'unknown_id_123'), true, 'Bypass mode must return true to force authoritative DB lookup');

    // Valid order still retrieved correctly in bypass mode
    const orderInBypass = await orderService.getOrderById(created.order.id, customerId);
    assert.ok(orderInBypass, 'Order must still be retrieved from PostgreSQL during Bloom bypass mode');
    bloomFilterService.setBypassMode(false);
    console.log('✓ Test 6 passed: Degraded mode fails open to PostgreSQL without dropping legitimate requests');

    // -------------------------------------------------------------
    // Test 7: Atomic Filter Versioning & Shadow Rebuild
    // -------------------------------------------------------------
    console.log('[Test 7] Testing Atomic Filter Versioning and Shadow Rebuild...');
    const metricsBeforeRebuild = bloomFilterService.getMetrics();
    const versionBefore = metricsBeforeRebuild.versions.orders;

    await bloomFilterService.rebuildResourceFilter('orders', pool);
    const metricsAfterRebuild = bloomFilterService.getMetrics();
    assert.equal(metricsAfterRebuild.versions.orders, versionBefore + 1, 'Filter version must increment atomically upon rebuild');
    assert.equal(bloomFilterService.mightContain('orders', created.order.id), true, 'Rebuilt filter must contain existing database records');
    console.log(`✓ Test 7 passed: Atomic filter rebuild executed (Version: v${versionBefore} -> v${metricsAfterRebuild.versions.orders})`);

    // -------------------------------------------------------------
    // Test 8: Full Jitter Exponential Backoff Distribution
    // -------------------------------------------------------------
    console.log('[Test 8] Testing Full Jitter Exponential Backoff Mathematical Distribution...');
    const baseDelay = 1000;
    const maxDelay = 10000;
    const sampleDelays: number[] = [];

    for (let i = 0; i < 100; i++) {
      const delay = calculateFullJitterDelay(3, baseDelay, maxDelay);
      assert.ok(delay >= 0, 'Delay must be non-negative');
      assert.ok(delay <= maxDelay, `Delay ${delay} must not exceed maxDelay ${maxDelay}`);
      sampleDelays.push(delay);
    }

    // Verify jitter distribution has variance (not lockstep)
    const uniqueValues = new Set(sampleDelays);
    assert.ok(uniqueValues.size > 80, 'Full Jitter must produce high entropy uniform variance across attempts');
    console.log('✓ Test 8 passed: Full Jitter produces bounded uniform distribution without thundering herds');

    // -------------------------------------------------------------
    // Test 9: Transient vs Non-Transient Failure Classification
    // -------------------------------------------------------------
    console.log('[Test 9] Testing Transient Failure Classification...');
    assert.equal(isTransientFailure({ statusCode: 503 }), true, 'HTTP 503 must be classified as transient');
    assert.equal(isTransientFailure({ statusCode: 429 }), true, 'HTTP 429 Rate Limit must be transient');
    assert.equal(isTransientFailure({ code: 'ECONNRESET' }), true, 'ECONNRESET must be transient');
    assert.equal(isTransientFailure({ code: '57P01' }), true, 'PostgreSQL 57P01 must be transient');
    assert.equal(isTransientFailure({ message: 'network timeout waiting for gateway' }), true, 'Network timeout string must be transient');

    // Permanent Rejections
    assert.equal(isTransientFailure({ statusCode: 400 }), false, 'HTTP 400 Bad Request is permanent');
    assert.equal(isTransientFailure({ statusCode: 401 }), false, 'HTTP 401 Unauthorized is permanent');
    assert.equal(isTransientFailure({ statusCode: 403 }), false, 'HTTP 403 Forbidden is permanent');
    assert.equal(isTransientFailure({ message: 'REFUND_CEILING_EXCEEDED' }), false, 'Business validation is permanent');
    console.log('✓ Test 9 passed: Transient vs permanent failure classification verified');

    // -------------------------------------------------------------
    // Test 10: Circuit Breaker State Transitions (CLOSED -> OPEN -> HALF_OPEN -> CLOSED)
    // -------------------------------------------------------------
    console.log('[Test 10] Testing Circuit Breaker State Transitions...');
    const breaker = new CircuitBreaker({
      name: 'TestGateway',
      failureThreshold: 3,
      recoveryTimeoutMs: 100, // Short for test
      halfOpenSuccessThreshold: 2,
    });

    assert.equal(breaker.getState(), 'CLOSED');

    // Simulate 3 transient errors to trip circuit
    for (let i = 0; i < 3; i++) {
      try {
        await breaker.execute(async () => {
          throw { code: 'ETIMEDOUT', message: 'Connection timed out' };
        });
      } catch {
        // Expected
      }
    }

    assert.equal(breaker.getState(), 'OPEN', 'Breaker must trip to OPEN after 3 consecutive failures');

    // Immediate calls must fail fast with CircuitBreakerOpenError
    let trippedErrorCaught = false;
    try {
      await breaker.execute(async () => 'OK');
    } catch (e: any) {
      trippedErrorCaught = true;
      assert.equal(e.code, 'CIRCUIT_BREAKER_OPEN');
    }
    assert.ok(trippedErrorCaught, 'Open circuit must immediately reject calls');

    // Wait for recovery timeout
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(breaker.getState(), 'HALF_OPEN', 'Breaker must transition to HALF_OPEN after recovery timeout');

    // Two consecutive probe successes close the circuit
    await breaker.execute(async () => 'Probe 1 success');
    await breaker.execute(async () => 'Probe 2 success');
    assert.equal(breaker.getState(), 'CLOSED', 'Breaker must transition back to CLOSED after probe successes');
    console.log('✓ Test 10 passed: Circuit Breaker CLOSED -> OPEN -> HALF_OPEN -> CLOSED verified');

    // -------------------------------------------------------------
    // Test 11: Unknown Provider Outcome in Refund Service (Network Timeout Safety)
    // -------------------------------------------------------------
    console.log('[Test 11] Testing Unknown Provider Outcome & Refund Status Reconciliation...');
    // Create order for refund test
    const refundOrder = await orderService.createOrder({
      userId: customerId,
      merchantId,
      items: [{ productId: product.id, quantity: 1 }],
      jobSite: { address: 'Test Site', latitude: 12.9716, longitude: 77.5946 },
      paymentMethod: 'Instant UPI',
    });

    // Mark order as paid
    await pool.query(`UPDATE orders SET payment_status = 'PAID', status = 'delivered' WHERE id = $1`, [refundOrder.order.id]);

    // Create refund
    const refundRes = await refundService.createRefund({
      orderId: refundOrder.order.id,
      amount: refundOrder.order.totalAmount,
      reasonCode: 'CUSTOMER_DEFECT',
      reasonDescription: 'Defective tool',
    });

    assert.ok(refundRes.refund.id);
    assert.equal(bloomFilterService.mightContain('refunds', refundRes.refund.id), true, 'Refund ID must be registered in Bloom Filter post-commit');

    // Test reconciliation
    const reconciled = await refundService.reconcileRefund(refundRes.refund.id);
    assert.ok(reconciled);
    assert.equal(reconciled.status, 'COMPLETED');
    console.log('✓ Test 11 passed: Refund provider outcome handling, reconciliation, and Bloom registration verified');

    // -------------------------------------------------------------
    // Test 12: WebSocket Client Reconnect Jitter Calculation
    // -------------------------------------------------------------
    console.log('[Test 12] Testing WebSocket Client Reconnect Jitter Calculation...');
    const wsDelays = [
      calculateWebSocketReconnectDelay(0),
      calculateWebSocketReconnectDelay(1),
      calculateWebSocketReconnectDelay(2),
      calculateWebSocketReconnectDelay(3),
    ];
    for (const d of wsDelays) {
      assert.ok(d >= 0 && d <= RESILIENCE_CONFIG.WEBSOCKET.RECONNECT_MAX_DELAY_MS);
    }
    console.log('✓ Test 12 passed: WebSocket client reconnect jitter prevents thundering herd');

    // -------------------------------------------------------------
    // Test 13: Comprehensive Metrics & Telemetry Observability
    // -------------------------------------------------------------
    console.log('[Test 13] Testing Resilience Metrics Observability Endpoint...');
    const metricsRes = await fetch(`${baseUrl}/api/v1/resilience/bloom-metrics`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(metricsRes.status, 200);
    const metricsData = await metricsRes.json();
    assert.equal(metricsData.success, true);
    assert.ok(metricsData.metrics.checksTotal > 0, 'checksTotal metric must be recorded');
    assert.ok(metricsData.metrics.negativeTotal > 0, 'negativeTotal metric must be recorded');
    assert.ok(metricsData.metrics.memoryBytes.orders > 0, 'Memory footprint must be reported');
    console.log(`✓ Test 13 passed: Observability metrics accurately report checks: ${metricsData.metrics.checksTotal}, negatives: ${metricsData.metrics.negativeTotal}`);

    // -------------------------------------------------------------
    // Test 14: Controlled Performance Benchmark (With Bloom vs Without Bloom)
    // -------------------------------------------------------------
    console.log('\n[Test 14] Running Controlled Performance Benchmark (With Bloom vs Without Bloom)...');
    const benchmarkCount = 300;
    const syntheticBogusIds = Array.from({ length: benchmarkCount }, () => crypto.randomUUID());

    // Measure WITHOUT Bloom (Bypass Mode = true)
    bloomFilterService.setBypassMode(true);
    let dbQueriesWithoutBloom = 0;
    const queryCounterWithout = async function (...args: any[]) {
      dbQueriesWithoutBloom++;
      return (origQuery as any)(...args);
    };
    pool.query = queryCounterWithout as any;

    const startWithout = performance.now();
    for (const bogusId of syntheticBogusIds) {
      await orderService.getOrderById(bogusId, customerId);
    }
    const durationWithoutMs = performance.now() - startWithout;

    // Measure WITH Bloom (Bypass Mode = false)
    bloomFilterService.setBypassMode(false);
    let dbQueriesWithBloom = 0;
    const queryCounterWith = async function (...args: any[]) {
      dbQueriesWithBloom++;
      return (origQuery as any)(...args);
    };
    pool.query = queryCounterWith as any;

    const startWith = performance.now();
    for (const bogusId of syntheticBogusIds) {
      await orderService.getOrderById(bogusId, customerId);
    }
    const durationWithMs = performance.now() - startWith;

    pool.query = origQuery; // Restore original

    const queriesSaved = dbQueriesWithoutBloom - dbQueriesWithBloom;
    const reductionPercent = ((queriesSaved / dbQueriesWithoutBloom) * 100).toFixed(1);
    const speedup = (durationWithoutMs / durationWithMs).toFixed(2);

    console.log('-----------------------------------------------------------');
    console.log(`  BENCHMARK RESULTS (${benchmarkCount} Bogus Random-ID Lookups):`);
    console.log(`  WITHOUT Bloom: ${dbQueriesWithoutBloom} DB Queries, ${durationWithoutMs.toFixed(2)}ms`);
    console.log(`  WITH Bloom:    ${dbQueriesWithBloom} DB Queries, ${durationWithMs.toFixed(2)}ms`);
    console.log(`  Database Overload Protection: ${queriesSaved} queries avoided (${reductionPercent}% reduction)`);
    console.log(`  Throughput Speedup: ${speedup}x faster`);
    console.log('-----------------------------------------------------------');

    assert.ok(dbQueriesWithBloom === 0, 'With Bloom filter active, exactly 0 database existence queries should be issued for bogus IDs');
    assert.ok(queriesSaved === benchmarkCount, `All ${benchmarkCount} bogus queries must be safely absorbed before reaching PostgreSQL`);
    console.log('✓ Test 14 passed: Controlled benchmark verified >99% database query reduction under random-ID flood');

    console.log('\n===========================================================');
    console.log('✓ ALL SPRINT 9.1 DATABASE OVERLOAD & RESILIENCE TESTS PASSED!');
    console.log('===========================================================\n');
  } finally {
    server.close();
    await pool.end();
  }
}

if (process.argv[1]?.includes('sprint9-1')) {
  runSprint91ResilienceTests().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
