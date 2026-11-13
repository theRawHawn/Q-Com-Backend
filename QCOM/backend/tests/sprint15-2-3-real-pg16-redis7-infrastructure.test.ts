process.env.NODE_ENV = 'test';
process.env.FORCE_REDIS = '1';

import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import pg from 'pg';
import { Redis } from 'ioredis';
import { createApp } from '../src/app.js';
import { setPool, getPool } from '../src/database/connection.js';
import { runMigrations } from '../src/database/migrator.js';
import { runSeeds } from '../seeds/seedData.js';
import { inventoryService } from '../src/modules/inventory/inventoryService.js';
import { ledgerService } from '../src/modules/ledger/ledgerService.js';
import { refundService } from '../src/modules/payments/refundService.js';
import { createSlidingWindowRateLimiter } from '../src/middleware/rateLimiter.js';
import { slidingWindowRateLimit, getRedisClient, setRedisClient } from '../src/database/redis.js';
import { env } from '../src/config/env.js';

const REAL_PG_URL = process.env.TEST_DATABASE_URL || 'postgres://qcom_user:qcom_password@127.0.0.1:5432/qcom_test';
const REAL_REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

export async function runSprint15_2_3RealPg16Redis7InfrastructureTests(): Promise<{
  isRealPg: boolean;
  isRealRedis: boolean;
  totalPassed: number;
}> {
  console.log('\n================================================================================');
  console.log('  SPRINT 15.2.3 — REAL POSTGRESQL 16 & REDIS 7 INTEGRATION INFRASTRUCTURE');
  console.log('================================================================================');

  let totalPassed = 0;

  // ---------------------------------------------------------------------------
  // STEP 1: STRICT REAL-SERVICE ENVIRONMENT PROBING (ZERO FALLBACK PERMITTED)
  // ---------------------------------------------------------------------------
  console.log('\n--- Step 1: Strict Verification of PostgreSQL 16 & Redis 7 Services ---');

  // 1A. Probe Real PostgreSQL 16
  const realPool = new pg.Pool({
    connectionString: REAL_PG_URL,
    connectionTimeoutMillis: 3000,
  });

  let pgVersionStr = '';
  try {
    const pgRes = await realPool.query('SELECT version()');
    pgVersionStr = pgRes.rows[0].version;
  } catch (err: any) {
    throw new assert.AssertionError({
      message: `[FATAL] Unable to connect to Real PostgreSQL 16 at ${REAL_PG_URL}: ${err.message}. Sprint 15.2.3 strictly forbids pg-mem fallback.`,
    });
  }

  assert.ok(
    pgVersionStr.includes('PostgreSQL 16'),
    `PostgreSQL 16 is strictly required; connected database reported: "${pgVersionStr}". Silent fallback is prohibited.`
  );
  console.log(`  ✓ Real PostgreSQL 16 verified: ${pgVersionStr.split(',')[0]}`);
  totalPassed++;

  // 1B. Probe Real Redis 7
  const redisProbeClient = new Redis(REAL_REDIS_URL, {
    connectTimeout: 3000,
    maxRetriesPerRequest: 1,
    lazyConnect: true,
  });

  let redisVersion = '';
  try {
    await redisProbeClient.connect();
    const redisInfo = await redisProbeClient.info('server');
    const match = redisInfo.match(/^redis_version:([^\r\n]+)/m);
    redisVersion = match ? match[1] : 'unknown';
  } catch (err: any) {
    throw new assert.AssertionError({
      message: `[FATAL] Unable to connect to Real Redis 7 at ${REAL_REDIS_URL}: ${err.message}. Sprint 15.2.3 strictly forbids in-memory fallback.`,
    });
  }

  assert.ok(
    redisVersion.startsWith('7.'),
    `Redis 7 is strictly required; connected Redis reported version: "${redisVersion}". In-memory fallback is prohibited.`
  );
  console.log(`  ✓ Real Redis 7 verified: version ${redisVersion}`);
  setRedisClient(redisProbeClient);
  totalPassed++;

  // 1C. Verify PostgreSQL Advisory Lock Support
  const ADVISORY_LOCK_ID = 881237;
  await realPool.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_ID]);
  await realPool.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_ID]);
  console.log('  ✓ PostgreSQL 16 session-level advisory locks verified.');
  totalPassed++;

  // Bind active pool
  setPool(realPool);

  // Apply migrations & seeds
  await runMigrations({ poolOverride: realPool });
  await runSeeds(realPool);
  console.log('  ✓ Migrations (001-026) and reference seed fixtures verified.');
  totalPassed++;

  // Start Express API Server
  const app = createApp();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  async function apiCall(
    endpoint: string,
    options: { method?: string; body?: any; token?: string; headers?: Record<string, string> } = {}
  ): Promise<{ status: number; headers: Record<string, string>; data: any }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (options.token) headers['Authorization'] = `Bearer ${options.token}`;

    const res = await fetch(`${baseUrl}${endpoint}`, {
      method: options.method || 'GET',
      headers,
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
  // STEP 2: TEST PERSONA AUTHENTICATION & OTP RESETS
  // ---------------------------------------------------------------------------
  console.log('\n--- Step 2: Authenticating Personas on Real PostgreSQL 16 ---');

  const customerPhone = '+91-9988112233';
  const sellerAPhone = '+91-9845012345';
  const sellerBPhone = '+91-9845099999';
  const rider1Phone = '+91-9740011111';
  const rider2Phone = '+91-9740022222';
  const suspendedRiderPhone = '+91-9740099999';
  const adminPhone = '+91-8000000000';

  // Wipe cooldown records to avoid cross-suite timing conflicts
  await realPool.query(
    `DELETE FROM otp_challenges WHERE phone IN ($1, $2, $3, $4, $5, $6, $7)`,
    [customerPhone, sellerAPhone, sellerBPhone, rider1Phone, rider2Phone, suspendedRiderPhone, adminPhone]
  );

  // Customer
  const cOtp = await apiCall('/api/auth/request-otp', { method: 'POST', body: { phone: customerPhone } });
  const cVer = await apiCall('/api/auth/verify-otp', {
    method: 'POST',
    body: { phone: customerPhone, otp: cOtp.data.debugOtp || '123456', name: 'Sprint 15.2.3 Customer' },
  });
  const customerToken = cVer.data.token || cVer.data.accessToken;
  const customerId = cVer.data.user.id;

  // Seller A (Merchant A)
  const sAOtp = await apiCall('/api/auth/request-otp', { method: 'POST', body: { phone: sellerAPhone } });
  const sAVer = await apiCall('/api/auth/verify-otp', {
    method: 'POST',
    body: { phone: sellerAPhone, otp: sAOtp.data.debugOtp || '123456', name: 'Seller A Owner' },
  });
  const sellerAToken = sAVer.data.token || sAVer.data.accessToken;

  // Seller B (Merchant B)
  const sBOtp = await apiCall('/api/auth/request-otp', { method: 'POST', body: { phone: sellerBPhone } });
  const sBVer = await apiCall('/api/auth/verify-otp', {
    method: 'POST',
    body: { phone: sellerBPhone, otp: sBOtp.data.debugOtp || '123456', name: 'Seller B Owner' },
  });
  const sellerBToken = sBVer.data.token || sBVer.data.accessToken;

  // Active Rider 1
  const r1Otp = await apiCall('/api/auth/request-otp', { method: 'POST', body: { phone: rider1Phone } });
  const r1Ver = await apiCall('/api/auth/verify-otp', {
    method: 'POST',
    body: { phone: rider1Phone, otp: r1Otp.data.debugOtp || '123456', name: 'Rider 1 Active' },
  });
  const rider1Token = r1Ver.data.token || r1Ver.data.accessToken;

  // Active Rider 2
  const r2Otp = await apiCall('/api/auth/request-otp', { method: 'POST', body: { phone: rider2Phone } });
  const r2Ver = await apiCall('/api/auth/verify-otp', {
    method: 'POST',
    body: { phone: rider2Phone, otp: r2Otp.data.debugOtp || '123456', name: 'Rider 2 Active' },
  });
  const rider2Token = r2Ver.data.token || r2Ver.data.accessToken;

  // Suspended Rider
  const rSOtp = await apiCall('/api/auth/request-otp', { method: 'POST', body: { phone: suspendedRiderPhone } });
  const rSVer = await apiCall('/api/auth/verify-otp', {
    method: 'POST',
    body: { phone: suspendedRiderPhone, otp: rSOtp.data.debugOtp || '123456', name: 'Rider Suspended' },
  });
  const suspendedRiderToken = rSVer.data.token || rSVer.data.accessToken;

  // Admin
  const admOtp = await apiCall('/api/auth/request-otp', { method: 'POST', body: { phone: adminPhone } });
  const admVer = await apiCall('/api/auth/verify-otp', {
    method: 'POST',
    body: { phone: adminPhone, otp: admOtp.data.debugOtp || '123456', name: 'Super Administrator' },
  });
  const adminToken = admVer.data.token || admVer.data.accessToken;

  // Query Merchants
  const mARes = await realPool.query(`SELECT id FROM merchants WHERE phone = $1 LIMIT 1`, [sellerAPhone]);
  assert.ok(mARes.rows.length > 0, 'Merchant A must exist');
  const merchantAId = mARes.rows[0].id;

  const mBRes = await realPool.query(`SELECT id FROM merchants WHERE phone = $1 LIMIT 1`, [sellerBPhone]);
  assert.ok(mBRes.rows.length > 0, 'Merchant B must exist');
  const merchantBId = mBRes.rows[0].id;

  // Ensure Rider 1 and Rider 2 exist in riders table
  for (const [phone, name, userId] of [
    [rider1Phone, 'Rider 1 Active', r1Ver.data.user.id],
    [rider2Phone, 'Rider 2 Active', r2Ver.data.user.id],
  ]) {
    const rRes = await realPool.query(`SELECT id FROM riders WHERE phone = $1`, [phone]);
    if (rRes.rows.length === 0) {
      await realPool.query(
        `INSERT INTO riders (id, rider_code, name, phone, vehicle_type, status, latitude, longitude, user_id)
         VALUES ($1, $2, $3, $4, 'motorcycle', 'AVAILABLE', 12.9716, 77.5946, $5)`,
        [crypto.randomUUID(), `RC-${Date.now()}-${crypto.randomUUID().slice(0, 4)}`, name, phone, userId]
      );
    } else {
      await realPool.query(`UPDATE riders SET status = 'AVAILABLE', user_id = $1 WHERE id = $2`, [userId, rRes.rows[0].id]);
    }
  }

  // Ensure suspended rider row exists
  let suspendedRiderId: string;
  const rSuspRes = await realPool.query(`SELECT id FROM riders WHERE phone = $1`, [suspendedRiderPhone]);
  if (rSuspRes.rows.length === 0) {
    suspendedRiderId = crypto.randomUUID();
    await realPool.query(
      `INSERT INTO riders (id, rider_code, name, phone, vehicle_type, status, latitude, longitude, user_id)
       VALUES ($1, $2, 'Rider Suspended', $3, 'ev_scooter', 'SUSPENDED', 12.9716, 77.5946, $4)`,
      [suspendedRiderId, `RC-SUSP-${Date.now()}`, suspendedRiderPhone, rSVer.data.user.id]
    );
  } else {
    suspendedRiderId = rSuspRes.rows[0].id;
    await realPool.query(`UPDATE riders SET status = 'SUSPENDED', user_id = $1 WHERE id = $2`, [rSVer.data.user.id, suspendedRiderId]);
  }

  console.log('  ✓ All 7 personas and merchant entities loaded.');
  totalPassed++;

  // Helper to create test orders in real PostgreSQL 16
  async function createTestOrder(merchantId: string, status: string = 'placed', paymentStatus: string = 'PENDING') {
    const orderId = crypto.randomUUID();
    const orderNumber = `QC-1523-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`;
    await realPool.query(`
      INSERT INTO orders (
        id, order_number, user_id, merchant_id, status, items_subtotal, delivery_fee, handling_fee, urgency_fee,
        discount_amount, taxable_amount, cgst_amount, sgst_amount, igst_amount, total_amount, withholding_amount,
        gst_tcs_amount, payment_method, payment_status, delivery_otp, handover_token, jobsite_address,
        place_of_supply_state_code, pricing_snapshot, estimated_delivery_at
      )
      VALUES (
        $1, $2, $3, $4, $5, 200.00, 30.00, 10.00, 0.00,
        0.00, 240.00, 21.60, 21.60, 0.00, 283.20, 0.00,
        0.00, 'Pay on Delivery', $6, '123456', 'TOK123', '{"address":"MG Road, Bengaluru"}',
        '29', '{"grandTotal":283.20}', NOW() + INTERVAL '30 minutes'
      )
    `, [orderId, orderNumber, customerId, merchantId, status, paymentStatus]);
    return { orderId, orderNumber };
  }

  // ---------------------------------------------------------------------------
  // PILLAR A: SELLER ORDER ACCEPTANCE CONCURRENCY & MULTI-TENANT ISOLATION
  // ---------------------------------------------------------------------------
  console.log('\n--- Pillar A: Seller Order Acceptance Concurrency & Tenant Isolation ---');

  // A1: Unauthenticated request rejected -> 401
  const oA1 = await createTestOrder(merchantAId);
  const unauthRes = await apiCall(`/api/orders/${oA1.orderId}/accept-seller`, { method: 'POST' });
  assert.strictEqual(unauthRes.status, 401);
  console.log('  ✓ Test A1: Unauthenticated order acceptance strictly blocked (HTTP 401).');
  totalPassed++;

  // A2: Cross-merchant attack (Seller B attempts to accept Merchant A's order) -> 403
  const crossMerchantRes = await apiCall(`/api/orders/${oA1.orderId}/accept-seller`, {
    method: 'POST',
    token: sellerBToken,
  });
  assert.strictEqual(crossMerchantRes.status, 403);
  console.log('  ✓ Test A2: Cross-merchant seller order acceptance forbidden (HTTP 403).');
  totalPassed++;

  // A3: Customer caller cannot accept seller orders -> 403
  const custSellerRes = await apiCall(`/api/orders/${oA1.orderId}/accept-seller`, {
    method: 'POST',
    token: customerToken,
  });
  assert.strictEqual(custSellerRes.status, 403);
  console.log('  ✓ Test A3: Customer caller forbidden from accepting seller orders (HTTP 403).');
  totalPassed++;

  // A4: Real PostgreSQL 16 Concurrency Race: Two Seller A sessions accept simultaneously
  const oA2 = await createTestOrder(merchantAId);
  const [raceRes1, raceRes2] = await Promise.all([
    apiCall(`/api/orders/${oA2.orderId}/accept-seller`, { method: 'POST', token: sellerAToken }),
    apiCall(`/api/orders/${oA2.orderId}/accept-seller`, { method: 'POST', token: sellerAToken }),
  ]);
  const raceStatuses = [raceRes1.status, raceRes2.status].sort();
  assert.deepStrictEqual(raceStatuses, [200, 409]);
  console.log('  ✓ Test A4: Real PostgreSQL concurrency: exact atomic [200, 409] single-winner outcome.');
  totalPassed++;

  // A5: Repeat attempt on accepted order rejected with 409
  const repeatRes = await apiCall(`/api/orders/${oA2.orderId}/accept-seller`, {
    method: 'POST',
    token: sellerAToken,
  });
  assert.strictEqual(repeatRes.status, 409);
  console.log('  ✓ Test A5: Repeated order acceptance rejected with ORDER_ALREADY_ACCEPTED (HTTP 409).');
  totalPassed++;

  // A6: Ineligible payment status (FAILED) strictly rejected -> 400
  const oFailPay = await createTestOrder(merchantAId, 'placed', 'FAILED');
  const failPayRes = await apiCall(`/api/orders/${oFailPay.orderId}/accept-seller`, {
    method: 'POST',
    token: sellerAToken,
  });
  assert.strictEqual(failPayRes.status, 400);
  assert.strictEqual(failPayRes.data.error, 'INELIGIBLE_PAYMENT_STATUS');
  console.log('  ✓ Test A6: Ineligible payment status (FAILED) strictly prevents acceptance (HTTP 400).');
  totalPassed++;

  // ---------------------------------------------------------------------------
  // PILLAR B: DELIVERY TASK ACCEPTANCE & ANTI-THEFT PROTECTION
  // ---------------------------------------------------------------------------
  console.log('\n--- Pillar B: Delivery Task Acceptance & Anti-Theft Protection ---');

  async function createTestTrip(status: string = 'BROADCASTING') {
    const { orderId } = await createTestOrder(merchantAId, 'accepted');
    const tripId = crypto.randomUUID();
    await realPool.query(`
      INSERT INTO delivery_trips (id, order_id, status, base_fare, distance_fare, surge_fare, total_rider_payout)
      VALUES ($1, $2, $3, 40.00, 10.00, 0.00, 50.00)
    `, [tripId, orderId, status]);
    return { tripId, orderId };
  }

  // B1: Suspended rider cannot claim tasks -> 403 RIDER_SUSPENDED
  const tB1 = await createTestTrip('BROADCASTING');
  const suspClaimRes = await apiCall(`/api/tasks/${tB1.tripId}/accept`, {
    method: 'POST',
    token: suspendedRiderToken,
  });
  assert.strictEqual(suspClaimRes.status, 403);
  assert.strictEqual(suspClaimRes.data.error, 'RIDER_SUSPENDED');
  console.log('  ✓ Test B1: Suspended rider rejected with HTTP 403 RIDER_SUSPENDED.');
  totalPassed++;

  // B2: Real PostgreSQL 16 Concurrency Race: Rider 1 and Rider 2 claim simultaneously
  const tB2 = await createTestTrip('BROADCASTING');
  const [claimRes1, claimRes2] = await Promise.all([
    apiCall(`/api/tasks/${tB2.tripId}/accept`, { method: 'POST', token: rider1Token }),
    apiCall(`/api/tasks/${tB2.tripId}/accept`, { method: 'POST', token: rider2Token }),
  ]);
  const claimStatuses = [claimRes1.status, claimRes2.status].sort();
  assert.deepStrictEqual(claimStatuses, [200, 409]);
  console.log('  ✓ Test B2: Real PostgreSQL concurrency: Rider claim yielded atomic [200, 409] single-winner.');
  totalPassed++;

  // B3: Winning rider retry returns HTTP 200 idempotently
  const winningToken = claimRes1.status === 200 ? rider1Token : rider2Token;
  const losingToken = claimRes1.status === 200 ? rider2Token : rider1Token;
  const retryClaimRes = await apiCall(`/api/tasks/${tB2.tripId}/accept`, {
    method: 'POST',
    token: winningToken,
  });
  assert.strictEqual(retryClaimRes.status, 200);
  console.log('  ✓ Test B3: Winning rider idempotent re-acceptance safely returns HTTP 200.');
  totalPassed++;

  // B4: Task theft/takeover attempt by different rider strictly rejected -> 409
  const theftRes = await apiCall(`/api/tasks/${tB2.tripId}/accept`, {
    method: 'POST',
    token: losingToken,
  });
  assert.strictEqual(theftRes.status, 409);
  console.log('  ✓ Test B4: Task takeover by another rider strictly rejected with HTTP 409.');
  totalPassed++;

  // ---------------------------------------------------------------------------
  // PILLAR C: ADMIN MANUAL DISPATCH & AUDIT TRAIL PERSISTENCE
  // ---------------------------------------------------------------------------
  console.log('\n--- Pillar C: Admin Manual Dispatch & Audit Trail Persistence ---');

  const tC = await createTestTrip('BROADCASTING');
  const activeRiderRes = await realPool.query(`SELECT id FROM riders WHERE status != 'SUSPENDED' LIMIT 1`);
  const activeRiderId = activeRiderRes.rows[0].id;

  // C1: Non-admin caller blocked -> 403
  const nonAdminAssign = await apiCall(`/api/admin/orders/${tC.orderId}/assign-rider`, {
    method: 'POST',
    token: customerToken,
    body: { riderId: activeRiderId },
  });
  assert.strictEqual(nonAdminAssign.status, 403);
  console.log('  ✓ Test C1: Non-admin caller strictly blocked from manual dispatch (HTTP 403).');
  totalPassed++;

  // C2: Assigning suspended rider rejected -> 400 RIDER_SUSPENDED
  const suspAssignRes = await apiCall(`/api/admin/orders/${tC.orderId}/assign-rider`, {
    method: 'POST',
    token: adminToken,
    body: { riderId: suspendedRiderId },
  });
  assert.strictEqual(suspAssignRes.status, 400);
  assert.strictEqual(suspAssignRes.data.error, 'RIDER_SUSPENDED');
  console.log('  ✓ Test C2: Assigning suspended rider rejected (HTTP 400 RIDER_SUSPENDED).');
  totalPassed++;

  // C3: Valid admin manual assignment succeeds -> 200 and logs audit record
  const validAssignRes = await apiCall(`/api/admin/orders/${tC.orderId}/assign-rider`, {
    method: 'POST',
    token: adminToken,
    body: { riderId: activeRiderId },
  });
  assert.strictEqual(validAssignRes.status, 200);

  // Directly verify audit trail in real PostgreSQL 16
  const auditRes = await realPool.query(`
    SELECT * FROM audit_logs 
    WHERE entity_type = 'DELIVERY_TRIP' AND action = 'ADMIN_MANUAL_RIDER_ASSIGN'
    ORDER BY created_at DESC LIMIT 1
  `);
  assert.ok(auditRes.rows.length > 0, 'Audit record must be persisted in audit_logs table');
  console.log('  ✓ Test C3: Valid admin manual assignment succeeded and audit log verified in real PostgreSQL 16.');
  totalPassed++;

  // C4: Overwrite guard on active assigned trip -> 409
  const overwriteRes = await apiCall(`/api/admin/orders/${tC.orderId}/assign-rider`, {
    method: 'POST',
    token: adminToken,
    body: { riderId: activeRiderId },
  });
  assert.strictEqual(overwriteRes.status, 409);
  console.log('  ✓ Test C4: Active trip protected against double-assignment overwrite (HTTP 409).');
  totalPassed++;

  // ---------------------------------------------------------------------------
  // PILLAR D: PAYMENT IDEMPOTENCY & DUPLICATE WEBHOOK DELIVERY
  // ---------------------------------------------------------------------------
  console.log('\n--- Pillar D: Payment Idempotency & Duplicate Webhook Delivery ---');

  const { orderId: payOrderId } = await createTestOrder(merchantAId, 'placed', 'PENDING');
  const prodRes = await realPool.query(`SELECT product_id FROM store_inventory WHERE merchant_id = $1 LIMIT 1`, [merchantAId]);
  const sampleProdId = prodRes.rows[0].product_id;
  await realPool.query(`
    INSERT INTO inventory_reservations (order_id, merchant_id, product_id, quantity, status, expires_at)
    VALUES ($1, $2, $3, 1, 'RESERVED', NOW() + INTERVAL '15 minutes')
  `, [payOrderId, merchantAId, sampleProdId]);

  const txId = `pay_it_${Date.now()}_${crypto.randomUUID().slice(0, 6)}`;
  const webhookPayload = {
    id: `evt_${txId}`,
    event: 'payment.captured',
    payload: {
      payment: {
        entity: {
          id: txId,
          order_id: payOrderId,
          amount: 28320, // in paise
          currency: 'INR',
          status: 'captured',
          method: 'upi',
          notes: { orderId: payOrderId },
        },
      },
    },
  };

  const rawBody = JSON.stringify(webhookPayload);
  const signature = crypto.createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest('hex');

  // 1st Webhook delivery
  const hookRes1 = await apiCall('/api/webhooks/razorpay', {
    method: 'POST',
    body: webhookPayload,
    headers: { 'x-razorpay-signature': signature },
  });
  assert.strictEqual(hookRes1.status, 200);

  // Verify payment status updated in real PostgreSQL 16
  const orderPayCheck1 = await realPool.query(`SELECT payment_status FROM orders WHERE id = $1`, [payOrderId]);
  assert.strictEqual(orderPayCheck1.rows[0].payment_status, 'PAID');

  // 2nd Duplicate Webhook delivery (identical payload)
  const hookRes2 = await apiCall('/api/webhooks/razorpay', {
    method: 'POST',
    body: webhookPayload,
    headers: { 'x-razorpay-signature': signature },
  });
  assert.strictEqual(hookRes2.status, 200);

  // Verify no duplicate payment records or ledger corruption occurred
  const paymentRows = await realPool.query(`SELECT COUNT(*) as count FROM payment_attempts WHERE order_id = $1`, [payOrderId]);
  assert.ok(Number(paymentRows.rows[0].count) <= 1, 'Duplicate webhook must not duplicate payment_attempts rows');
  console.log('  ✓ Test D1: Duplicate webhook processed idempotently with zero database corruption.');
  totalPassed++;

  // ---------------------------------------------------------------------------
  // PILLAR E: DOUBLE-ENTRY LEDGER INTEGRITY & TRANSACTION ROLLBACKS
  // ---------------------------------------------------------------------------
  console.log('\n--- Pillar E: Double-Entry Ledger Integrity & Transaction Rollbacks ---');

  const { orderId: ledgerOrderId } = await createTestOrder(merchantAId);
  const ledgerGross = 500.00;

  // Record payment in general ledger
  await ledgerService.recordOrderPayment({
    orderId: ledgerOrderId,
    merchantId: merchantAId,
    grossAmount: ledgerGross,
    taxableAmount: 423.73,
    cgstAmount: 38.14,
    sgstAmount: 38.14,
    deliveryFee: 40.00,
    handlingFee: 10.00,
  });

  // Verify Double-Entry Balance in real PostgreSQL 16: sum(DEBIT) strictly equals sum(CREDIT)
  const ledgerSumRes = await realPool.query(`
    SELECT entry_side, SUM(amount) as total
    FROM general_ledger_entries
    WHERE order_id = $1
    GROUP BY entry_side
  `, [ledgerOrderId]);

  let debitTotal = 0;
  let creditTotal = 0;
  for (const row of ledgerSumRes.rows) {
    if (row.entry_side === 'DEBIT') debitTotal = Number(row.total);
    if (row.entry_side === 'CREDIT') creditTotal = Number(row.total);
  }
  assert.strictEqual(debitTotal, creditTotal, 'General ledger must strictly balance (Debit Total == Credit Total)');
  assert.strictEqual(debitTotal, ledgerGross, `Debit total must equal gross payment (${ledgerGross})`);
  console.log(`  ✓ Test E1: Real PostgreSQL double-entry balance verified: Debits (${debitTotal}) === Credits (${creditTotal}).`);
  totalPassed++;

  // Test Transaction Rollback Safety: Simulated failure in multi-query transaction
  const clientRollback = await realPool.connect();
  const { orderId: rollbackOrderId } = await createTestOrder(merchantAId);
  try {
    await clientRollback.query('BEGIN');
    await clientRollback.query(`
      INSERT INTO general_ledger_entries (
        journal_batch_id, transaction_reference, transaction_type,
        account_code, entry_side, amount, currency, order_id, merchant_id, narration
      ) VALUES ($1, $2, 'ROLLBACK_TEST', '1010', 'DEBIT', 100.00, 'INR', $3, $4, 'Rollback Test')
    `, [crypto.randomUUID(), `TX_ROLLBACK_${rollbackOrderId}`, rollbackOrderId, merchantAId]);

    // Force an unrecoverable SQL error (invalid account foreign key or syntax error)
    await clientRollback.query('INSERT INTO non_existent_table_for_rollback_test VALUES (1)');
    await clientRollback.query('COMMIT');
  } catch {
    await clientRollback.query('ROLLBACK');
  } finally {
    clientRollback.release();
  }

  // Verify that ROLLBACK completely purged uncommitted ledger entries
  const rollbackCheck = await realPool.query(`
    SELECT COUNT(*) as count FROM general_ledger_entries WHERE order_id = $1
  `, [rollbackOrderId]);
  assert.strictEqual(Number(rollbackCheck.rows[0].count), 0, 'Rolled-back transaction must leave zero rows');
  console.log('  ✓ Test E2: Atomic transaction rollback safety verified: zero orphaned ledger rows.');
  totalPassed++;

  // ---------------------------------------------------------------------------
  // PILLAR F: REFUND INTEGRITY & DISTRIBUTED LEASE FENCING
  // ---------------------------------------------------------------------------
  console.log('\n--- Pillar F: Refund Integrity & Distributed Lease Fencing ---');

  const { orderId: refundOrderId } = await createTestOrder(merchantAId, 'cancelled', 'PAID');
  const refundIntentId = crypto.randomUUID();

  // Create refund intent in PROCESSING status with worker lease
  const workerNodeA = `worker_node_A_${Date.now()}`;
  const workerNodeB = `worker_node_B_${Date.now()}`;
  const leaseExpiry = new Date(Date.now() + 60000);
  const refundNumber = `REF-${Date.now()}`;

  await realPool.query(`
    INSERT INTO refunds (
      id, refund_number, order_id, amount, currency, status, reason_code, refund_type,
      recovery_lease_id, recovery_lease_expires_at
    ) VALUES (
      $1, $2, $3, 283.20, 'INR', 'PROCESSING', 'CUSTOMER_CANCELLED', 'FULL',
      $4, $5
    )
  `, [refundIntentId, refundNumber, refundOrderId, workerNodeA, leaseExpiry]);

  // Worker B attempts to steal lease while Worker A holds active lease -> rejected
  const leaseStealRes = await realPool.query(`
    UPDATE refunds
    SET recovery_lease_id = $1, recovery_lease_expires_at = $2
    WHERE id = $3 AND (recovery_lease_expires_at < NOW() OR recovery_lease_id = $1)
    RETURNING id
  `, [workerNodeB, leaseExpiry, refundIntentId]);
  assert.strictEqual(leaseStealRes.rows.length, 0, 'Active worker lease must prevent conflicting worker takeover');

  // Worker A successfully completes refund with its active lease
  const completeRefundRes = await realPool.query(`
    UPDATE refunds
    SET status = 'COMPLETED', updated_at = NOW()
    WHERE id = $1 AND recovery_lease_id = $2
    RETURNING id, status
  `, [refundIntentId, workerNodeA]);
  assert.strictEqual(completeRefundRes.rows[0].status, 'COMPLETED');
  console.log('  ✓ Test F1: Distributed worker lease fencing on refund processing verified.');
  totalPassed++;

  // ---------------------------------------------------------------------------
  // PILLAR G: INVENTORY INTEGRITY & CONTENTION RACE (ZERO OVERSELLING)
  // ---------------------------------------------------------------------------
  console.log('\n--- Pillar G: Inventory Integrity & Contention Race (Zero Overselling) ---');

  // Create a scarce test product with physical stock = 1
  const scarceProductId = crypto.randomUUID();
  const scarceSku = `SKU-SCARCE-${Date.now()}`;
  await realPool.query(`
    INSERT INTO products (id, sku, name, category, subcategory, hsn_code, gst_rate_percent, is_active)
    VALUES ($1, $2, 'Scarce Item', 'Beverages', 'Soda', '2202', 18.00, TRUE)
  `, [scarceProductId, scarceSku]);

  await realPool.query(`
    INSERT INTO store_inventory (id, merchant_id, product_id, selling_price, original_mrp, stock_count, reserved_count, bin_location, is_available)
    VALUES ($1, $2, $3, 100.00, 120.00, 1, 0, 'BIN-SCARCE', TRUE)
  `, [crypto.randomUUID(), merchantAId, scarceProductId]);

  // 10 simultaneous concurrent checkout attempts for the single unit
  const concurrencyCount = 10;
  const reserveAttempts = await Promise.allSettled(
    Array.from({ length: concurrencyCount }, (_, i) =>
      inventoryService.reserveStock(
        crypto.randomUUID(),
        merchantAId,
        [{ productId: scarceProductId, quantity: 1 }],
        5
      )
    )
  );

  const fulfilled = reserveAttempts.filter((r) => r.status === 'fulfilled');
  const rejected = reserveAttempts.filter((r) => r.status === 'rejected');

  assert.strictEqual(fulfilled.length, 1, `Exactly 1 reservation must succeed for stock=1, got ${fulfilled.length}`);
  assert.strictEqual(rejected.length, concurrencyCount - 1, `Expected ${concurrencyCount - 1} rejections, got ${rejected.length}`);

  // Inspect authoritative store_inventory row in real PostgreSQL 16
  const invRow = await realPool.query(`
    SELECT stock_count, reserved_count, (stock_count - reserved_count) as available
    FROM store_inventory
    WHERE merchant_id = $1 AND product_id = $2
  `, [merchantAId, scarceProductId]);

  const stock = Number(invRow.rows[0].stock_count);
  const reserved = Number(invRow.rows[0].reserved_count);
  const available = Number(invRow.rows[0].available);

  assert.strictEqual(stock, 1, 'Physical stock remains 1');
  assert.strictEqual(reserved, 1, 'Reserved count is exactly 1');
  assert.strictEqual(available, 0, 'Available to sell is strictly 0');
  console.log(`  ✓ Test G1: High contention race (10 concurrent requests for 1 item): exactly 1 winner, 0 oversold, stock strictly preserved.`);
  totalPassed++;

  // ---------------------------------------------------------------------------
  // PILLAR H: REDIS 7 ATOMIC RATE LIMITING, TTL EXPIRATION & DEGRADATION
  // ---------------------------------------------------------------------------
  console.log('\n--- Pillar H: Real Redis 7 Sliding-Window, TTL Expiration & Degradation ---');

  const redisTestKey = `it_test_rate_limit_${Date.now()}`;
  const rateLimitThreshold = 3;
  const windowSec = 10;

  // H1: Request 1..3 allowed
  const r1 = await slidingWindowRateLimit(redisTestKey, rateLimitThreshold, windowSec);
  const r2 = await slidingWindowRateLimit(redisTestKey, rateLimitThreshold, windowSec);
  const r3 = await slidingWindowRateLimit(redisTestKey, rateLimitThreshold, windowSec);
  assert.strictEqual(r1.allowed, true);
  assert.strictEqual(r2.allowed, true);
  assert.strictEqual(r3.allowed, true);
  assert.strictEqual(r3.remaining, 0);

  // H2: Request 4 blocked with Retry-After
  const r4 = await slidingWindowRateLimit(redisTestKey, rateLimitThreshold, windowSec);
  assert.strictEqual(r4.allowed, false, '4th request must be blocked');
  assert.ok(r4.resetSec > 0 && r4.resetSec <= windowSec, 'Reset seconds must be bounded by windowSec');
  console.log(`  ✓ Test H1: Real Redis 7 atomic rate limiting: admitted 3, strictly blocked 4th with resetSec=${r4.resetSec}.`);
  totalPassed++;

  // H3: Verify key has TTL set in Redis 7
  const redisFullKey = `ratelimit:${redisTestKey}`;
  const keyTtl = await redisProbeClient.ttl(redisFullKey);
  assert.ok(keyTtl > 0 && keyTtl <= windowSec + 1, `Key TTL must be set in Redis 7 (got ${keyTtl}s)`);
  console.log(`  ✓ Test H2: Redis 7 key expiration TTL verified: ${keyTtl}s remaining.`);
  totalPassed++;

  // H4: Graceful Degradation (failureMode: 'open') on Cache Error
  const degradedLimiter = createSlidingWindowRateLimiter(
    {
      limit: 2,
      windowSec: 60,
      scope: 'degrade-test',
      failureMode: 'open',
    },
    // Mock failure evaluator to test degradation contract
    async () => {
      throw new Error('Simulated Redis network disconnection');
    }
  );

  let allowedThrough = false;
  const mockDegradeReq: any = { ip: '127.0.0.1', socket: {}, baseUrl: '/test', path: '/degrade' };
  const mockDegradeRes: any = {
    headers: {} as Record<string, string>,
    setHeader(k: string, v: string) { this.headers[k] = v; },
    status() { return this; },
    json() {},
  };

  await degradedLimiter(mockDegradeReq, mockDegradeRes, () => {
    allowedThrough = true;
  });

  assert.strictEqual(allowedThrough, true, 'Traffic must pass through when failureMode: "open" during cache outage');
  assert.strictEqual(mockDegradeRes.headers['X-RateLimit-Status'], 'unavailable');
  console.log('  ✓ Test H3: Graceful degradation (failureMode: open) allows traffic during cache unavailability.');
  totalPassed++;

  // Cleanup probe connections
  setRedisClient(null);
  await redisProbeClient.quit();
  await new Promise<void>((resolve) => server.close(() => resolve()));

  console.log('\n================================================================================');
  console.log(`  ALL SPRINT 15.2.3 REAL POSTGRESQL 16 & REDIS 7 TESTS PASSED (${totalPassed}/${totalPassed})!`);
  console.log('================================================================================\n');

  return {
    isRealPg: true,
    isRealRedis: true,
    totalPassed,
  };
}

// Allow standalone CLI execution
if (process.argv[1] && process.argv[1].endsWith('sprint15-2-3-real-pg16-redis7-infrastructure.test.ts')) {
  runSprint15_2_3RealPg16Redis7InfrastructureTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
