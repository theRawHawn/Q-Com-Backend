import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'crypto';
import { createApp } from '../src/app.js';
import { setPool, getPool } from '../src/database/connection.js';
import { runMigrations } from '../src/database/migrator.js';
import { runSeeds } from '../seeds/seedData.js';
import { createTestDatabase } from './helpers/testDb.js';
import { paymentService } from '../src/modules/payments/paymentService.js';
import { MockPaymentProvider } from '../src/modules/payments/provider/MockPaymentProvider.js';
import { env } from '../src/config/env.js';

export async function runSprint15_4GitRecoveryAndReconciliationClosureTests(): Promise<void> {
  console.log('\n================================================================================');
  console.log('  SPRINT 15.1.4 — GIT RECOVERY, IDEMPOTENCY RECLAMATION & RECONCILIATION CLOSURE');
  console.log('================================================================================');

  // 1. Initialize Test Database & Server
  const testDb = createTestDatabase();
  setPool(testDb.pool);
  await runMigrations({ poolOverride: testDb.pool });
  await runSeeds(testDb.pool);

  const app = createApp();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as import('net').AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  function signPayload(payloadStr: string): string {
    return crypto.createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET).update(payloadStr).digest('hex');
  }

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

  // 2. Setup Test Customer Accounts
  // Customer A
  const authA = await apiCall('/api/auth/request-otp', { method: 'POST', body: { phone: '+91-9111122222', role: 'CUSTOMER' } });
  const verifyA = await apiCall('/api/auth/verify-otp', { method: 'POST', body: { phone: '+91-9111122222', otp: authA.data.debugOtp || '123456', name: 'Actor A' } });
  const tokenA = verifyA.data.token || verifyA.data.accessToken;
  const userIdA = verifyA.data.user?.id || verifyA.data.userId;

  // Customer B
  const authB = await apiCall('/api/auth/request-otp', { method: 'POST', body: { phone: '+91-9333344444', role: 'CUSTOMER' } });
  const verifyB = await apiCall('/api/auth/verify-otp', { method: 'POST', body: { phone: '+91-9333344444', otp: authB.data.debugOtp || '123456', name: 'Actor B' } });
  const tokenB = verifyB.data.token || verifyB.data.accessToken;
  const userIdB = verifyB.data.user?.id || verifyB.data.userId;

  // Catalog item
  const catRes = await apiCall('/api/catalog/products', { token: tokenA });
  const sampleProduct = catRes.data?.products?.[0] || { id: 'prod_test_1', price: 99 };
  const prodId = sampleProduct.id || sampleProduct.productId;

  const validLocation = {
    address: '100 Indiranagar 100ft Road, Bangalore',
    latitude: 12.9716,
    longitude: 77.5946,
  };

  // -------------------------------------------------------------------------
  // SECTION 1: Actor & Tenant Scoping on Idempotency Keys (Cases 1 & 2)
  // -------------------------------------------------------------------------
  console.log('\n--- Section 1: Actor & Tenant Scoping in Idempotency Keys ---');

  // Case 1: Customer A creates an order under Key-Alpha. Customer B cannot reuse Key-Alpha.
  const keyAlpha = `idemp_alpha_${Date.now()}`;
  const orderPayloadA = {
    items: [{ productId: prodId, quantity: 1 }],
    deliveryLocation: validLocation,
    paymentMethod: 'Instant UPI',
  };

  const createA = await apiCall('/api/orders/create', {
    method: 'POST',
    token: tokenA,
    headers: { 'idempotency-key': keyAlpha },
    body: orderPayloadA,
  });
  assert.equal(createA.status, 200, 'Customer A order creation should succeed');
  assert.ok(createA.data.order?.id, 'Customer A received order ID');

  // Customer B attempts to submit request reusing Customer A's key
  const attackB = await apiCall('/api/orders/create', {
    method: 'POST',
    token: tokenB,
    headers: { 'idempotency-key': keyAlpha },
    body: {
      items: [{ productId: prodId, quantity: 1 }],
      deliveryLocation: validLocation,
      paymentMethod: 'Instant UPI',
    },
  });
  assert.equal(attackB.status, 403, 'Customer B reusing Customer A key must receive HTTP 403');
  assert.equal(attackB.data.error, 'IDEMPOTENCY_KEY_ACTOR_MISMATCH', 'Must return IDEMPOTENCY_KEY_ACTOR_MISMATCH');
  console.log('  ✓ Case 1 Passed: Customer B cannot access or reuse Customer A idempotency key (HTTP 403).');

  // Case 2: Customer A encounters an order failure (e.g. empty items). Key is marked FAILED.
  // Customer B attempts to reclaim Customer A's FAILED key.
  const keyBeta = `idemp_beta_fail_${Date.now()}`;
  // Directly simulate a FAILED key created by Customer A
  const pool = getPool();
  await pool.query(
    `INSERT INTO idempotency_keys (idempotency_key, actor_id, endpoint, status, request_fingerprint, created_at, expires_at)
     VALUES ($1, $2, '/api/orders/create', 'FAILED', 'fingerprint_fail', NOW(), NOW() + interval '24 hours')`,
    [keyBeta, userIdA]
  );

  // Customer B attempts to reclaim Customer A's failed key
  const reclaimB = await apiCall('/api/orders/create', {
    method: 'POST',
    token: tokenB,
    headers: { 'idempotency-key': keyBeta },
    body: orderPayloadA,
  });
  assert.equal(reclaimB.status, 403, 'Customer B attempting to reclaim Customer A failed key must receive HTTP 403');
  assert.equal(reclaimB.data.error, 'IDEMPOTENCY_KEY_ACTOR_MISMATCH', 'Must return IDEMPOTENCY_KEY_ACTOR_MISMATCH');
  console.log('  ✓ Case 2 Passed: Customer B cannot reclaim Customer A failed key (HTTP 403).');

  // -------------------------------------------------------------------------
  // SECTION 2: Concurrent Reclamation Safety (Case 3)
  // -------------------------------------------------------------------------
  console.log('\n--- Section 2: Concurrent Reclamation Safety ---');

  // Customer A has a FAILED key
  const keyGamma = `idemp_gamma_fail_${Date.now()}`;
  const payloadFingerprint = crypto.createHash('sha256').update(JSON.stringify({
    userId: userIdA,
    items: [{ productId: prodId, quantity: 1 }],
    deliveryLocation: {
      latitude: validLocation.latitude,
      longitude: validLocation.longitude,
      address: validLocation.address,
    },
    paymentMethod: 'Instant UPI',
    couponCode: null,
    isGstEnabled: false,
    gstin: null,
  })).digest('hex');

  await pool.query(
    `INSERT INTO idempotency_keys (idempotency_key, actor_id, endpoint, status, request_fingerprint, created_at, expires_at)
     VALUES ($1, $2, '/api/orders/create', 'FAILED', $3, NOW(), NOW() + interval '24 hours')`,
    [keyGamma, userIdA, payloadFingerprint]
  );

  // 3 concurrent requests from Customer A to reclaim the FAILED key
  const concurrentReclaims = await Promise.all([
    apiCall('/api/orders/create', { method: 'POST', token: tokenA, headers: { 'idempotency-key': keyGamma }, body: orderPayloadA }),
    apiCall('/api/orders/create', { method: 'POST', token: tokenA, headers: { 'idempotency-key': keyGamma }, body: orderPayloadA }),
    apiCall('/api/orders/create', { method: 'POST', token: tokenA, headers: { 'idempotency-key': keyGamma }, body: orderPayloadA }),
  ]);

  const successes = concurrentReclaims.filter(r => r.status === 200);
  const conflicts = concurrentReclaims.filter(r => r.status === 409);
  assert.ok(successes.length >= 1, 'At least 1 request succeeded');
  assert.equal(successes.length + conflicts.length, 3, 'All concurrent requests either completed (200) or received 409 conflict');
  console.log(`  ✓ Case 3 Passed: Concurrent reclamation resolved safely (${successes.length} 200 OK, ${conflicts.length} 409 Conflict).`);

  // -------------------------------------------------------------------------
  // SECTION 3: Payment Reconciliation Response-Caching Closure (Case 4)
  // -------------------------------------------------------------------------
  console.log('\n--- Section 3: Payment Reconciliation Response-Caching Closure ---');

  // Step A: Create order for Customer A
  const orderForRecRes = await apiCall('/api/orders/create', {
    method: 'POST',
    token: tokenA,
    body: {
      items: [{ productId: prodId, quantity: 1 }],
      deliveryLocation: validLocation,
      paymentMethod: 'Instant UPI',
    },
  });
  const recOrderId = orderForRecRes.data.order.id;

  // Step B: Set Mock Provider to simulate ambiguous outcome (RECONCILIATION_REQUIRED)
  const mockProvider = new MockPaymentProvider('mock', { simulateTimeout: true });
  paymentService.setProvider(mockProvider);

  const recKey = `idemp_rec_pay_${Date.now()}`;
  const recTxnId = `txn_rec_${Date.now()}`;
  const recTimestamp = Date.now();
  const verifyRes = await apiCall('/api/payment/verify', {
    method: 'POST',
    token: tokenA,
    headers: { 'idempotency-key': recKey },
    body: {
      orderId: recOrderId,
      transactionId: recTxnId,
      timestamp: recTimestamp,
      signature: 'prov_sig_placeholder',
    },
  });

  assert.equal(verifyRes.status, 202, 'Initial ambiguous outcome should return HTTP 202');
  assert.equal(verifyRes.data.status, 'RECONCILIATION_REQUIRED', 'Response status is RECONCILIATION_REQUIRED');
  assert.equal(verifyRes.data.isReconciliationRequired, true, 'isReconciliationRequired is true');
  console.log('  ✓ Step A: Ambient timeout returned HTTP 202 and was cached under Idempotency-Key.');

  // Step C: Authoritative webhook arrives to capture the payment
  paymentService.setProvider(new MockPaymentProvider('mock'));

  const whEventId = `evt_rec_settle_${Date.now()}`;
  const settleTxnId = `txn_settle_webhook_${Date.now()}`;
  const orderDbRow = await pool.query(`SELECT total_amount FROM orders WHERE id = $1`, [recOrderId]);
  const authoritativeOrderTotal = parseFloat(orderDbRow.rows[0].total_amount);
  const webhookAmount = Math.round(authoritativeOrderTotal * 100);

  const webhookPayload = {
    id: whEventId,
    event: 'payment.captured',
    payload: {
      payment: {
        entity: {
          id: settleTxnId,
          order_id: `order_${recOrderId}`,
          amount: webhookAmount,
          currency: 'INR',
          status: 'captured',
          method: 'upi',
          captured: true,
          created_at: Math.floor(Date.now() / 1000),
          notes: { orderId: recOrderId },
        },
      },
    },
  };

  const rawWebhookBody = JSON.stringify(webhookPayload);
  const webhookSig = signPayload(rawWebhookBody);

  const hookRes = await apiCall('/api/webhooks/razorpay', {
    method: 'POST',
    headers: { 'x-razorpay-signature': webhookSig },
    body: webhookPayload,
  });
  if (hookRes.status !== 200) {
    console.error('HOOK_RES_DEBUG:', hookRes.status, hookRes.data);
  }
  assert.equal(hookRes.status, 200, 'Authoritative webhook should succeed with HTTP 200: ' + JSON.stringify(hookRes.data));
  console.log('  ✓ Step B: Authoritative payment.captured webhook processed and captured payment in DB.');

  // Step D: Replay /api/payment/verify with the SAME Idempotency-Key and IDENTICAL payload
  // It must NOT permanently return stale 202; it must detect PostgreSQL state evolved to CAPTURED and return HTTP 200!
  const replayVerifyRes = await apiCall('/api/payment/verify', {
    method: 'POST',
    token: tokenA,
    headers: { 'idempotency-key': recKey },
    body: {
      orderId: recOrderId,
      transactionId: recTxnId,
      timestamp: recTimestamp,
      signature: 'prov_sig_placeholder',
    },
  });

  assert.equal(replayVerifyRes.status, 200, 'Replay with same key must now return HTTP 200 CAPTURED instead of stale 202');
  assert.equal(replayVerifyRes.data.status, 'CAPTURED', 'Replay response status must be CAPTURED');
  assert.equal(replayVerifyRes.data.isReconciliationRequired, false, 'isReconciliationRequired must now be false');
  console.log('  ✓ Step C: Idempotency replay with same key returned updated HTTP 200 CAPTURED.');

  // -------------------------------------------------------------------------
  // SECTION 4: Explicit Status Route (Case 5)
  // -------------------------------------------------------------------------
  console.log('\n--- Section 4: Explicit Payment Status Route ---');

  // Customer A queries own order status
  const statusA = await apiCall(`/api/payment/status/${recOrderId}`, { token: tokenA });
  assert.equal(statusA.status, 200, 'Status query should return HTTP 200');
  assert.equal(statusA.data.payment.orderId, recOrderId, 'Returned payment status matches order ID');
  assert.equal(statusA.data.payment.paymentStatus, 'PAID', 'Payment status is PAID');

  // Customer B tries to query Customer A's order status (IDOR test)
  const statusB = await apiCall(`/api/payment/status/${recOrderId}`, { token: tokenB });
  assert.equal(statusB.status, 403, 'Customer B accessing Customer A order status must receive HTTP 403');
  console.log('  ✓ Case 5 Passed: GET /api/payment/status/:orderId works and enforces ownership (403 IDOR blocked).');

  // -------------------------------------------------------------------------
  // SECTION 5: Double-Entry General Ledger Balance (Case 6)
  // -------------------------------------------------------------------------
  console.log('\n--- Section 5: Double-Entry General Ledger Balance ---');

  const ledgerRes = await pool.query(`
    SELECT
      SUM(CASE WHEN entry_side = 'DEBIT' THEN amount ELSE 0 END) AS total_debit,
      SUM(CASE WHEN entry_side = 'CREDIT' THEN amount ELSE 0 END) AS total_credit
    FROM general_ledger_entries
    WHERE transaction_type = 'CUSTOMER_PAYMENT'
  `);

  const totalDebit = parseFloat(ledgerRes.rows[0]?.total_debit || '0');
  const totalCredit = parseFloat(ledgerRes.rows[0]?.total_credit || '0');
  const delta = Math.abs(totalDebit - totalCredit);
  assert.ok(delta < 0.001, `Ledger must be balanced. Debit: ${totalDebit}, Credit: ${totalCredit}, Diff: ${delta}`);
  console.log(`  ✓ Case 6 Passed: General Ledger perfectly balanced (Debits ₹${totalDebit.toFixed(2)} == Credits ₹${totalCredit.toFixed(2)}).`);

  // Cleanup
  await new Promise<void>((resolve) => server.close(() => resolve()));
  console.log('\n================================================================================');
  console.log('  ALL SPRINT 15.1.4 VERIFICATIONS PASSED SUCCESSFULLY!');
  console.log('================================================================================\n');
}
