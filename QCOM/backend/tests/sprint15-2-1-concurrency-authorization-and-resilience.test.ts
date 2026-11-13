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
import { outboxService } from '../src/modules/outbox/outboxService.js';
import { createSlidingWindowRateLimiter } from '../src/middleware/rateLimiter.js';

const REAL_PG_URL = process.env.TEST_DATABASE_URL || 'postgres://qcom_user:qcom_password@127.0.0.1:5432/qcom_test';

export async function runSprint15_2_1ConcurrencyAuthorizationAndResilienceTests(): Promise<void> {
  console.log('\n================================================================================');
  console.log('  SPRINT 15.2.1 — CONCURRENCY, AUTHORIZATION & RESILIENCE VERIFICATION SUITE');
  console.log('================================================================================');

  // 1. Establish Database Pool
  console.log('\n--- Step 1: Initializing Database & Environment ---');
  let realPool: pg.Pool;
  let isRealPg = false;
  try {
    const probePool = new pg.Pool({
      connectionString: REAL_PG_URL,
      connectionTimeoutMillis: 1500,
    });
    await probePool.query('SELECT 1');
    realPool = probePool;
    isRealPg = true;
    console.log('  ✓ Connected to Real PostgreSQL 16 database at:', REAL_PG_URL);
  } catch {
    console.log('  ℹ PostgreSQL not reachable. Using isolated pg-mem database.');
    realPool = createTestDatabase().pool;
  }
  setPool(realPool);

  // Apply migrations and seed data
  await runMigrations({ poolOverride: realPool });
  await runSeeds(realPool);
  console.log('  ✓ Database migrations and reference seeds loaded.');

  // Create Express application instance
  const app = createApp();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  // HTTP Helper
  async function apiCall(
    endpoint: string,
    options: {
      method?: string;
      body?: any;
      token?: string;
      headers?: Record<string, string>;
    } = {}
  ): Promise<{ status: number; headers: http.IncomingHttpHeaders; data: any }> {
    const url = new URL(endpoint, baseUrl);
    const reqHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    };
    if (options.token) {
      reqHeaders['Authorization'] = `Bearer ${options.token}`;
    }

    const res = await fetch(url.toString(), {
      method: options.method || 'GET',
      headers: reqHeaders,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    const text = await res.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: res.status, headers: res.headers as any, data };
  }

  // ---------------------------------------------------------------------------
  // Step 2: Authenticate Personas
  // ---------------------------------------------------------------------------
  console.log('\n--- Step 2: Authenticating Personas ---');

  // Customer
  const customerPhone = '+91-9988776655';
  const sellerAPhone = '+91-9845012345';
  const sellerBPhone = '+91-9845099999';
  const rider1Phone = '+91-9812345678';
  const rider2Phone = '+91-9812345679';
  const suspendedRiderPhone = '+91-9812345699';
  const adminPhone = '+91-8000000000';
  await realPool.query(`DELETE FROM otp_challenges WHERE phone IN ($1, $2, $3, $4, $5, $6, $7)`, [
    customerPhone, sellerAPhone, sellerBPhone, rider1Phone, rider2Phone, suspendedRiderPhone, adminPhone
  ]);

  const custOtpReq = await apiCall('/api/auth/request-otp', { method: 'POST', body: { phone: customerPhone } });
  const custVerify = await apiCall('/api/auth/verify-otp', {
    method: 'POST',
    body: { phone: customerPhone, otp: custOtpReq.data.debugOtp || '123456', name: 'Sprint Customer' },
  });
  const customerToken = custVerify.data.token || custVerify.data.accessToken;
  const customerId = custVerify.data.user.id;

  // Seller A (Merchant A: Suresh Babu)
  const sellerAOtpReq = await apiCall('/api/auth/request-otp', { method: 'POST', body: { phone: sellerAPhone } });
  const sellerAVerify = await apiCall('/api/auth/verify-otp', {
    method: 'POST',
    body: { phone: sellerAPhone, otp: sellerAOtpReq.data.debugOtp || '123456', name: 'Suresh Babu' },
  });
  const sellerAToken = sellerAVerify.data.token || sellerAVerify.data.accessToken;

  // Seller B (Merchant B: Ramesh Kaveri)
  const sellerBOtpReq = await apiCall('/api/auth/request-otp', { method: 'POST', body: { phone: sellerBPhone } });
  const sellerBVerify = await apiCall('/api/auth/verify-otp', {
    method: 'POST',
    body: { phone: sellerBPhone, otp: sellerBOtpReq.data.debugOtp || '123456', name: 'Ramesh Kaveri' },
  });
  const sellerBToken = sellerBVerify.data.token || sellerBVerify.data.accessToken;

  // Delivery Partner 1 (Arjun Teja - Active)
  const rider1OtpReq = await apiCall('/api/auth/request-otp', { method: 'POST', body: { phone: rider1Phone } });
  const rider1Verify = await apiCall('/api/auth/verify-otp', {
    method: 'POST',
    body: { phone: rider1Phone, otp: rider1OtpReq.data.debugOtp || '123456', name: 'Arjun Teja' },
  });
  const rider1Token = rider1Verify.data.token || rider1Verify.data.accessToken;

  // Delivery Partner 2 (Kiran Kumar - Active)
  const rider2OtpReq = await apiCall('/api/auth/request-otp', { method: 'POST', body: { phone: rider2Phone } });
  const rider2Verify = await apiCall('/api/auth/verify-otp', {
    method: 'POST',
    body: { phone: rider2Phone, otp: rider2OtpReq.data.debugOtp || '123456', name: 'Kiran Kumar' },
  });
  const rider2Token = rider2Verify.data.token || rider2Verify.data.accessToken;

  // Suspended Delivery Partner
  const suspUserRes = await realPool.query(`
    INSERT INTO users (phone, name, is_phone_verified, account_type)
    VALUES ($1, 'Suspended Partner', TRUE, 'individual')
    ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name RETURNING id
  `, [suspendedRiderPhone]);
  const suspUserId = suspUserRes.rows[0].id;
  const riderRoleRes = await realPool.query(`SELECT id FROM roles WHERE name = 'RIDER' LIMIT 1`);
  if (riderRoleRes.rows.length > 0) {
    await realPool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [suspUserId, riderRoleRes.rows[0].id]);
  }
  const suspRiderRes = await realPool.query(`
    INSERT INTO riders (rider_code, name, phone, vehicle_type, status, user_id)
    VALUES ('RIDER-SUSP', 'Suspended Partner', $1, 'bicycle', 'SUSPENDED', $2)
    ON CONFLICT (phone) DO UPDATE SET status = 'SUSPENDED' RETURNING id
  `, [suspendedRiderPhone, suspUserId]);
  const suspendedRiderId = suspRiderRes.rows[0].id;

  const suspOtpReq = await apiCall('/api/auth/request-otp', { method: 'POST', body: { phone: suspendedRiderPhone } });
  const suspVerify = await apiCall('/api/auth/verify-otp', {
    method: 'POST',
    body: { phone: suspendedRiderPhone, otp: suspOtpReq.data.debugOtp || '123456', role: 'DELIVERY_PARTNER', name: 'Suspended Partner' },
  });
  const suspendedRiderToken = suspVerify.data.token || suspVerify.data.accessToken;

  // Super Admin
  const adminOtpReq = await apiCall('/api/auth/request-otp', { method: 'POST', body: { phone: adminPhone } });
  const adminVerify = await apiCall('/api/auth/verify-otp', {
    method: 'POST',
    body: { phone: adminPhone, otp: adminOtpReq.data.debugOtp || '123456', name: 'Super Administrator' },
  });
  const adminToken = adminVerify.data.token || adminVerify.data.accessToken;

  // Query Merchant A and Merchant B IDs from seeded data
  const merchRes = await realPool.query(`SELECT id FROM merchants WHERE status = 'ACTIVE' ORDER BY created_at ASC LIMIT 2`);
  assert.ok(merchRes.rows.length >= 2, 'Must have at least 2 seeded merchants');
  const merchantAId = merchRes.rows[0].id;
  const merchantBId = merchRes.rows[1].id;

  console.log('  ✓ Customer, Seller A, Seller B, Riders (Active & Suspended), and Admin authenticated.');

  // ---------------------------------------------------------------------------
  // PILLAR 1: SELLER ORDER ACCEPTANCE AUTHORIZATION & TOCTOU INTEGRITY
  // ---------------------------------------------------------------------------
  console.log('\n--- Pillar 1: Seller Order Acceptance Authorization & Concurrency ---');

  // Create an order for Merchant A
  const orderAId = crypto.randomUUID();
  await realPool.query(`
    INSERT INTO orders (
      id, order_number, user_id, merchant_id, status, items_subtotal, delivery_fee, handling_fee, urgency_fee,
      discount_amount, taxable_amount, cgst_amount, sgst_amount, igst_amount, total_amount, withholding_amount,
      gst_tcs_amount, payment_method, payment_status, delivery_otp, handover_token, jobsite_address,
      place_of_supply_state_code, pricing_snapshot, estimated_delivery_at
    )
    VALUES (
      $1, 'QC-TEST-SELLER-A-' || substr(md5(random()::text), 1, 8), $2, $3, 'placed', 200.00, 30.00, 10.00, 0.00,
      0.00, 240.00, 21.60, 21.60, 0.00, 283.20, 0.00,
      0.00, 'Pay on Delivery', 'PENDING', '112233', 'TOK_A', '{"address":"Sector 17"}',
      '29', '{"grandTotal":283.20}', NOW() + INTERVAL '30 minutes'
    )
  `, [orderAId, customerId, merchantAId]);

  // Test 1.1: Unauthenticated request cannot accept order -> 401
  const unauthAccept = await apiCall(`/api/orders/${orderAId}/accept-seller`, { method: 'POST' });
  assert.strictEqual(unauthAccept.status, 401, 'Unauthenticated order acceptance must return HTTP 401');
  assert.strictEqual(unauthAccept.data.error, 'UNAUTHENTICATED');
  console.log('  ✓ Test 1.1 Passed: Unauthenticated order acceptance strictly blocked (HTTP 401).');

  // Test 1.2: Seller B cannot accept Seller A's order -> 403
  const crossSellerAccept = await apiCall(`/api/orders/${orderAId}/accept-seller`, {
    method: 'POST',
    token: sellerBToken,
  });
  assert.strictEqual(crossSellerAccept.status, 403, 'Cross-merchant seller acceptance must return HTTP 403');
  assert.strictEqual(crossSellerAccept.data.error, 'FORBIDDEN');
  console.log('  ✓ Test 1.2 Passed: Cross-merchant seller order acceptance strictly forbidden (HTTP 403).');

  // Test 1.3: Customer cannot accept seller order -> 403
  const custSellerAccept = await apiCall(`/api/orders/${orderAId}/accept-seller`, {
    method: 'POST',
    token: customerToken,
  });
  assert.strictEqual(custSellerAccept.status, 403, 'Customer role cannot accept seller orders (HTTP 403)');
  assert.strictEqual(custSellerAccept.data.error, 'FORBIDDEN');
  console.log('  ✓ Test 1.3 Passed: Non-merchant customer cannot accept seller orders (HTTP 403).');

  // Test 1.4: Competing concurrent acceptance requests by Seller A -> Exactly 1 winner (200), 1 conflict (409)
  const [compete1, compete2] = await Promise.all([
    apiCall(`/api/orders/${orderAId}/accept-seller`, { method: 'POST', token: sellerAToken }),
    apiCall(`/api/orders/${orderAId}/accept-seller`, { method: 'POST', token: sellerAToken }),
  ]);
  console.log('Compete 1:', JSON.stringify(compete1.data));
  console.log('Compete 2:', JSON.stringify(compete2.data));
  const sellerStatuses = [compete1.status, compete2.status].sort();
  assert.deepStrictEqual(sellerStatuses, [200, 409], `Concurrent seller acceptance must yield [200, 409], got [${compete1.status}, ${compete2.status}]`);
  const winner = compete1.status === 200 ? compete1 : compete2;
  const loser = compete1.status === 409 ? compete1 : compete2;
  assert.strictEqual(winner.data.success, true);
  assert.strictEqual(winner.data.order.status, 'accepted');
  assert.strictEqual(loser.data.error, 'ORDER_ALREADY_ACCEPTED');
  console.log('  ✓ Test 1.4 Passed: Atomic single-winner seller acceptance. 1 winner (HTTP 200), 1 conflict (HTTP 409).');

  // Test 1.5: Subsequent acceptance attempt receives 409 ORDER_ALREADY_ACCEPTED
  const repeatAccept = await apiCall(`/api/orders/${orderAId}/accept-seller`, {
    method: 'POST',
    token: sellerAToken,
  });
  assert.strictEqual(repeatAccept.status, 409);
  assert.strictEqual(repeatAccept.data.error, 'ORDER_ALREADY_ACCEPTED');
  console.log('  ✓ Test 1.5 Passed: Repeated acceptance attempt rejected with ORDER_ALREADY_ACCEPTED (HTTP 409).');

  // Test 1.6: Order with FAILED payment status cannot be accepted -> 400 INELIGIBLE_PAYMENT_STATUS
  const failedPaymentOrderId = crypto.randomUUID();
  await realPool.query(`
    INSERT INTO orders (
      id, order_number, user_id, merchant_id, status, items_subtotal, delivery_fee, handling_fee, urgency_fee,
      discount_amount, taxable_amount, cgst_amount, sgst_amount, igst_amount, total_amount, withholding_amount,
      gst_tcs_amount, payment_method, payment_status, delivery_otp, handover_token, jobsite_address,
      place_of_supply_state_code, pricing_snapshot, estimated_delivery_at
    )
    VALUES (
      $1, 'QC-TEST-FAIL-PAY-' || substr(md5(random()::text), 1, 8), $2, $3, 'placed', 100.00, 20.00, 5.00, 0.00,
      0.00, 125.00, 11.25, 11.25, 0.00, 147.50, 0.00,
      0.00, 'Instant UPI', 'FAILED', '998877', 'TOK_FAIL', '{"address":"Sector 12"}',
      '29', '{"grandTotal":147.50}', NOW() + INTERVAL '30 minutes'
    )
  `, [failedPaymentOrderId, customerId, merchantAId]);

  const failedPayAccept = await apiCall(`/api/orders/${failedPaymentOrderId}/accept-seller`, {
    method: 'POST',
    token: sellerAToken,
  });
  assert.strictEqual(failedPayAccept.status, 400, 'Failed payment order acceptance must return HTTP 400');
  assert.strictEqual(failedPayAccept.data.error, 'INELIGIBLE_PAYMENT_STATUS');
  console.log('  ✓ Test 1.6 Passed: Ineligible payment status (FAILED) strictly prevents order acceptance (HTTP 400).');

  // ---------------------------------------------------------------------------
  // PILLAR 2: DELIVERY TASK ACCEPTANCE AUTHORIZATION & EXCLUSIVE CLAIM
  // ---------------------------------------------------------------------------
  console.log('\n--- Pillar 2: Delivery Task Acceptance Authorization & Rider Assignment ---');

  const tripOrderId = crypto.randomUUID();
  const tripId = crypto.randomUUID();

  await realPool.query(`
    INSERT INTO orders (
      id, order_number, user_id, merchant_id, status, items_subtotal, delivery_fee, handling_fee, urgency_fee,
      discount_amount, taxable_amount, cgst_amount, sgst_amount, igst_amount, total_amount, withholding_amount,
      gst_tcs_amount, payment_method, payment_status, delivery_otp, handover_token, jobsite_address,
      place_of_supply_state_code, pricing_snapshot, estimated_delivery_at
    )
    VALUES (
      $1, 'QC-TEST-TRIP-ORDER-' || substr(md5(random()::text), 1, 8), $2, $3, 'accepted', 150.00, 30.00, 10.00, 0.00,
      0.00, 190.00, 17.10, 17.10, 0.00, 224.20, 0.00,
      0.00, 'Pay on Delivery', 'PENDING', '445566', 'TOK_TRIP', '{"address":"Hub Koramangala"}',
      '29', '{"grandTotal":224.20}', NOW() + INTERVAL '25 minutes'
    )
  `, [tripOrderId, customerId, merchantAId]);

  await realPool.query(`
    INSERT INTO delivery_trips (id, order_id, status, base_fare, distance_fare, surge_fare, total_rider_payout)
    VALUES ($1, $2, 'BROADCASTING', 35.00, 15.00, 0.00, 50.00)
  `, [tripId, tripOrderId]);

  // Test 2.1: Unauthenticated task acceptance -> 401
  const unauthTaskAccept = await apiCall(`/api/tasks/${tripId}/accept`, { method: 'POST' });
  assert.strictEqual(unauthTaskAccept.status, 401, 'Unauthenticated task acceptance must return HTTP 401');
  assert.strictEqual(unauthTaskAccept.data.error, 'UNAUTHENTICATED');
  console.log('  ✓ Test 2.1 Passed: Unauthenticated delivery task claim blocked (HTTP 401).');

  // Test 2.2: Customer attempting to claim delivery task -> 403
  const custTaskAccept = await apiCall(`/api/tasks/${tripId}/accept`, {
    method: 'POST',
    token: customerToken,
  });
  assert.strictEqual(custTaskAccept.status, 403, 'Customer role cannot claim delivery tasks (HTTP 403)');
  assert.strictEqual(custTaskAccept.data.error, 'FORBIDDEN');
  console.log('  ✓ Test 2.2 Passed: Non-rider customer cannot claim delivery task (HTTP 403).');

  // Test 2.3: Suspended delivery partner claiming task -> 403 RIDER_SUSPENDED
  const suspTaskAccept = await apiCall(`/api/tasks/${tripId}/accept`, {
    method: 'POST',
    token: suspendedRiderToken,
  });
  assert.strictEqual(suspTaskAccept.status, 403, 'Suspended rider must be rejected (HTTP 403)');
  assert.strictEqual(suspTaskAccept.data.error, 'RIDER_SUSPENDED');
  console.log('  ✓ Test 2.3 Passed: Suspended delivery partner blocked from claiming task (HTTP 403 RIDER_SUSPENDED).');

  // Test 2.4: Concurrent task claim competition between Rider 1 and Rider 2
  const [taskCompete1, taskCompete2] = await Promise.all([
    apiCall(`/api/tasks/${tripId}/accept`, { method: 'POST', token: rider1Token }),
    apiCall(`/api/tasks/${tripId}/accept`, { method: 'POST', token: rider2Token }),
  ]);
  const taskStatuses = [taskCompete1.status, taskCompete2.status].sort();
  assert.deepStrictEqual(taskStatuses, [200, 409], `Concurrent task accept must yield [200, 409], got [${taskCompete1.status}, ${taskCompete2.status}]`);
  const taskWinner = taskCompete1.status === 200 ? taskCompete1 : taskCompete2;
  const taskLoser = taskCompete1.status === 409 ? taskCompete1 : taskCompete2;
  assert.strictEqual(taskWinner.data.status, 'ACCEPTED');
  assert.strictEqual(taskLoser.data.error, 'TASK_ALREADY_CLAIMED');

  // Verify winning rider was atomically written into delivery_trips.rider_id in database
  const dbTripRes = await realPool.query(`SELECT id, rider_id, status FROM delivery_trips WHERE id = $1`, [tripId]);
  assert.strictEqual(dbTripRes.rows[0].status, 'ACCEPTED');
  assert.ok(dbTripRes.rows[0].rider_id, 'Delivery trip must have rider_id assigned');
  assert.strictEqual(dbTripRes.rows[0].rider_id, taskWinner.data.riderId, 'Database rider_id must match winning rider');
  console.log('  ✓ Test 2.4 Passed: Atomic single-winner task claim. Winner (HTTP 200) assigned to database row, concurrent competitor blocked (HTTP 409).');

  // Test 2.5: Winning rider idempotent re-acceptance returns 200
  const winnerToken = taskWinner === taskCompete1 ? rider1Token : rider2Token;
  const winnerReaccept = await apiCall(`/api/tasks/${tripId}/accept`, { method: 'POST', token: winnerToken });
  assert.strictEqual(winnerReaccept.status, 200, 'Winning rider re-accepting own task must return HTTP 200');
  assert.strictEqual(winnerReaccept.data.status, 'ACCEPTED');
  console.log('  ✓ Test 2.5 Passed: Winning rider idempotent re-acceptance safely returns HTTP 200.');

  // Test 2.6: Losing rider cannot steal accepted task -> 409
  const loserToken = taskWinner === taskCompete1 ? rider2Token : rider1Token;
  const stealAttempt = await apiCall(`/api/tasks/${tripId}/accept`, { method: 'POST', token: loserToken });
  assert.strictEqual(stealAttempt.status, 409, 'Other rider attempting to steal task must return HTTP 409');
  assert.strictEqual(stealAttempt.data.error, 'TASK_ALREADY_CLAIMED');
  console.log('  ✓ Test 2.6 Passed: Theft/takeover of claimed task by other rider prevented (HTTP 409).');

  // ---------------------------------------------------------------------------
  // PILLAR 3: ADMIN RIDER ASSIGNMENT SECURITY & AUDIT
  // ---------------------------------------------------------------------------
  console.log('\n--- Pillar 3: Admin Manual Rider Assignment & Audit Security ---');

  const adminTestOrderId = crypto.randomUUID();
  const adminTestTripId = crypto.randomUUID();

  await realPool.query(`
    INSERT INTO orders (
      id, order_number, user_id, merchant_id, status, items_subtotal, delivery_fee, handling_fee, urgency_fee,
      discount_amount, taxable_amount, cgst_amount, sgst_amount, igst_amount, total_amount, withholding_amount,
      gst_tcs_amount, payment_method, payment_status, delivery_otp, handover_token, jobsite_address,
      place_of_supply_state_code, pricing_snapshot, estimated_delivery_at
    )
    VALUES (
      $1, 'QC-TEST-ADMIN-ASSIGN-' || substr(md5(random()::text), 1, 8), $2, $3, 'accepted', 100.00, 30.00, 10.00, 0.00,
      0.00, 140.00, 12.60, 12.60, 0.00, 165.20, 0.00,
      0.00, 'Pay on Delivery', 'PENDING', '778899', 'TOK_ADMIN', '{"address":"Admin Dispatch Hub"}',
      '29', '{"grandTotal":165.20}', NOW() + INTERVAL '25 minutes'
    )
  `, [adminTestOrderId, customerId, merchantAId]);

  await realPool.query(`
    INSERT INTO delivery_trips (id, order_id, status, base_fare, distance_fare, surge_fare, total_rider_payout)
    VALUES ($1, $2, 'BROADCASTING', 40.00, 10.00, 0.00, 50.00)
  `, [adminTestTripId, adminTestOrderId]);

  // Query an active rider ID
  const activeRiderRes = await realPool.query(`SELECT id FROM riders WHERE status != 'SUSPENDED' LIMIT 1`);
  const activeRiderId = activeRiderRes.rows[0].id;

  // Test 3.1: Unauthenticated assign-rider -> 401
  const unauthAssign = await apiCall(`/api/admin/orders/${adminTestOrderId}/assign-rider`, {
    method: 'POST',
    body: { riderId: activeRiderId },
  });
  assert.strictEqual(unauthAssign.status, 401, 'Unauthenticated assign-rider must return HTTP 401');
  console.log('  ✓ Test 3.1 Passed: Unauthenticated manual dispatch assignment blocked (HTTP 401).');

  // Test 3.2: Non-admin caller (Customer or Seller) -> 403
  const nonAdminAssign = await apiCall(`/api/admin/orders/${adminTestOrderId}/assign-rider`, {
    method: 'POST',
    token: customerToken,
    body: { riderId: activeRiderId },
  });
  assert.strictEqual(nonAdminAssign.status, 403, 'Non-admin caller must receive HTTP 403');
  assert.strictEqual(nonAdminAssign.data.error, 'FORBIDDEN');
  console.log('  ✓ Test 3.2 Passed: Non-admin caller strictly blocked with FORBIDDEN (HTTP 403).');

  // Test 3.3: Assigning a suspended delivery partner -> 400 RIDER_SUSPENDED
  const suspAssign = await apiCall(`/api/admin/orders/${adminTestOrderId}/assign-rider`, {
    method: 'POST',
    token: adminToken,
    body: { riderId: suspendedRiderId },
  });
  assert.strictEqual(suspAssign.status, 400, 'Assigning suspended rider must return HTTP 400');
  assert.strictEqual(suspAssign.data.error, 'RIDER_SUSPENDED');
  console.log('  ✓ Test 3.3 Passed: Assigning suspended rider rejected (HTTP 400 RIDER_SUSPENDED).');

  // Test 3.4: Valid admin manual assignment succeeds -> 200 and logs audit record
  const validAdminAssign = await apiCall(`/api/admin/orders/${adminTestOrderId}/assign-rider`, {
    method: 'POST',
    token: adminToken,
    body: { riderId: activeRiderId },
  });
  assert.strictEqual(validAdminAssign.status, 200);
  assert.strictEqual(validAdminAssign.data.success, true);
  assert.strictEqual(validAdminAssign.data.status, 'ACCEPTED');

  // Verify trip in database is ACCEPTED with target rider
  const assignedTripDb = await realPool.query(`SELECT id, rider_id, status FROM delivery_trips WHERE order_id = $1`, [adminTestOrderId]);
  assert.strictEqual(assignedTripDb.rows[0].status, 'ACCEPTED');
  assert.strictEqual(assignedTripDb.rows[0].rider_id, activeRiderId);

  // Verify audit log entry was created
  const auditRes = await realPool.query(
    `SELECT * FROM audit_logs WHERE action = 'ADMIN_MANUAL_RIDER_ASSIGN' AND entity_id = $1`,
    [adminTestTripId]
  );
  assert.ok(auditRes.rows.length >= 1, 'Audit log must record admin manual rider assignment action');
  console.log('  ✓ Test 3.4 Passed: Valid admin manual rider assignment succeeds (HTTP 200) and writes audit log.');

  // Test 3.5: Cannot reassign already accepted trip -> 409 INVALID_TRIP_STATE
  const reassignAttempt = await apiCall(`/api/admin/orders/${adminTestOrderId}/assign-rider`, {
    method: 'POST',
    token: adminToken,
    body: { riderId: activeRiderId },
  });
  assert.strictEqual(reassignAttempt.status, 409, 'Reassigning accepted trip must return HTTP 409');
  assert.ok(
    reassignAttempt.data.error === 'INVALID_TRIP_STATE' || reassignAttempt.data.error === 'ALREADY_ASSIGNED',
    `Expected INVALID_TRIP_STATE or ALREADY_ASSIGNED, got ${reassignAttempt.data.error}`
  );
  console.log('  ✓ Test 3.5 Passed: Active trip status protection prevents double-assignment conflict (HTTP 409).');

  // ---------------------------------------------------------------------------
  // PILLAR 4: BACKPRESSURE & OUTBOX QUEUE MONITORING
  // ---------------------------------------------------------------------------
  console.log('\n--- Pillar 4: Backpressure, Queue Depth & Dead-Letter Recovery ---');

  // Test 4.1: Queue depth inquiry
  const depth = await outboxService.getPendingQueueDepth();
  assert.ok(typeof depth === 'number', 'Queue depth must be a number');

  // Test 4.2: Backpressure calculation
  const normalMetrics = await outboxService.getBackpressureMetrics(5000);
  assert.strictEqual(normalMetrics.isOverloaded, false);

  const overloadMetrics = await outboxService.getBackpressureMetrics(0);
  assert.strictEqual(overloadMetrics.isOverloaded, true);
  assert.ok(overloadMetrics.recommendedBackoffMs >= 500);
  console.log('  ✓ Test 4.1 Passed: Outbox backpressure monitoring tracks queue depth and calculates recommended backoff.');

  // Test 4.3: Dead-letter recovery via replayFailedEvents
  const testDeadLetterId = crypto.randomUUID();
  await realPool.query(`
    INSERT INTO outbox_events (id, event_type, aggregate_type, aggregate_id, payload, status, attempt_count, last_error)
    VALUES ($1, 'TEST_DEAD_LETTER', 'TEST', $1, '{"test":true}', 'DEAD_LETTER', 5, 'Network timeout')
  `, [testDeadLetterId]);

  const replayedCount = await outboxService.replayFailedEvents([testDeadLetterId]);
  assert.strictEqual(replayedCount, 1, 'Exactly 1 dead-letter event should be replayed');

  const checkReplayed = await realPool.query(`SELECT status, attempt_count, last_error FROM outbox_events WHERE id = $1`, [testDeadLetterId]);
  assert.strictEqual(checkReplayed.rows[0].status, 'PENDING');
  assert.strictEqual(checkReplayed.rows[0].attempt_count, 0);
  assert.strictEqual(checkReplayed.rows[0].last_error, null);
  console.log('  ✓ Test 4.2 Passed: Dead-letter recovery (replayFailedEvents) safely resets failed events to PENDING with zeroed attempts.');

  // ---------------------------------------------------------------------------
  // PILLAR 5: RATE LIMITING EVALUATION & DEGRADATION MODES
  // ---------------------------------------------------------------------------
  console.log('\n--- Pillar 5: Rate Limiting Algorithms & Degradation Modes ---');

  // Test 5.1: In-memory sliding window limiter
  const storage = new Map<string, number[]>();
  const customLimiter = createSlidingWindowRateLimiter({
    limit: 2,
    windowSec: 2,
    keyGenerator: () => 'test_actor_key',
    errorMessage: 'Actor rate exceeded',
    skipInTest: false,
    failureMode: 'closed',
  }, async (key, limit, windowSec) => {
    const now = Date.now();
    const timestamps = (storage.get(key) || []).filter(t => t > now - windowSec * 1000);
    if (timestamps.length >= limit) {
      return { allowed: false, remaining: 0, resetSec: 1 };
    }
    timestamps.push(now);
    storage.set(key, timestamps);
    return { allowed: true, remaining: limit - timestamps.length, resetSec: windowSec };
  });

  const mockReq: any = { baseUrl: '/api', path: '/test', requestId: 'req_123', headers: {} };
  let statusEmitted = 200;
  let headersEmitted: Record<string, string> = {};
  const mockRes: any = {
    setHeader: (k: string, v: string) => { headersEmitted[k] = v; },
    status: (s: number) => { statusEmitted = s; return { json: () => {} }; },
  };

  // Call 1 -> allowed
  await customLimiter(mockReq, mockRes, () => {});
  assert.strictEqual(statusEmitted, 200);
  assert.strictEqual(headersEmitted['X-RateLimit-Limit'], '2');

  // Call 2 -> allowed
  await customLimiter(mockReq, mockRes, () => {});
  assert.strictEqual(statusEmitted, 200);

  // Call 3 -> blocked (429)
  await customLimiter(mockReq, mockRes, () => {});
  assert.strictEqual(statusEmitted, 429);
  assert.ok(headersEmitted['Retry-After']);
  console.log('  ✓ Test 5.1 Passed: Sliding-window rate limiter enforces limit and emits Retry-After and X-RateLimit headers.');

  // Test 5.2: Rate limiter failureMode open vs closed
  const failOpenLimiter = createSlidingWindowRateLimiter({
    limit: 10,
    windowSec: 60,
    failureMode: 'open',
    skipInTest: false,
  }, async () => { throw new Error('Redis cluster down'); });

  let passedThrough = false;
  let failOpenHeaders: Record<string, string> = {};
  const failOpenRes: any = { setHeader: (k: string, v: string) => { failOpenHeaders[k] = v; } };
  await failOpenLimiter(mockReq, failOpenRes, () => { passedThrough = true; });
  assert.strictEqual(passedThrough, true, 'failureMode open must allow request when cache fails');
  assert.strictEqual(failOpenHeaders['X-RateLimit-Status'], 'unavailable');
  console.log('  ✓ Test 5.2 Passed: FailureMode "open" gracefully admits traffic with X-RateLimit-Status header during outages.');

  // Clean up server
  await new Promise<void>((resolve) => server.close(() => resolve()));

  console.log('\n================================================================================');
  console.log('  ALL SPRINT 15.2.1 CONCURRENCY, AUTHORIZATION & RESILIENCE TESTS PASSED!');
  console.log('================================================================================\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSprint15_2_1ConcurrencyAuthorizationAndResilienceTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
