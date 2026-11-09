import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'crypto';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { setPool, getPool, transaction } from '../src/database/connection.js';
import { runMigrations } from '../src/database/migrator.js';
import { runSeeds } from '../seeds/seedData.js';
import { createTestDatabase } from './helpers/testDb.js';
import { paymentService } from '../src/modules/payments/paymentService.js';
import { financialWebhookService } from '../src/modules/payments/financialWebhookService.js';
import { refundService } from '../src/modules/payments/refundService.js';
import { ledgerService } from '../src/modules/ledger/ledgerService.js';
import { env } from '../src/config/env.js';

export async function runSprint15_2RealPostgresqlPaymentIntegrityTests(): Promise<void> {
  console.log('\n================================================================================');
  console.log('  SPRINT 15.1.2 — PAYMENT INTEGRITY, CONCURRENCY & FINANCIAL REMEDIATION');
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

  // Create test customer session
  const authA = await apiCall('/api/auth/request-otp', { method: 'POST', body: { phone: '+91-9888877777', role: 'CUSTOMER' } });
  const verifyA = await apiCall('/api/auth/verify-otp', { method: 'POST', body: { phone: '+91-9888877777', otp: authA.data.debugOtp || '123456', name: 'Customer 15.1.2' } });
  const tokenA = verifyA.data.token || verifyA.data.accessToken;
  const userIdA = verifyA.data.user?.id || verifyA.data.userId;

  const catalogRes = await apiCall('/api/catalog/products');
  const products = catalogRes.data.products || catalogRes.data;
  const testProductId = products[0].id;
  const testMerchantId = products[0].merchantId;

  async function createOrder(token: string, idempotencyKey?: string) {
    const key = idempotencyKey || `ord_key_${crypto.randomUUID()}`;
    const quote = await apiCall('/api/checkout/quote', {
      method: 'POST',
      token,
      body: {
        items: [{ productId: testProductId, quantity: 1 }],
        deliveryCoordinates: { lat: 12.9352, lng: 77.6245 },
      },
    });
    assert.strictEqual(quote.status, 200);

    const orderRes = await apiCall('/api/orders/create', {
      method: 'POST',
      token,
      headers: { 'Idempotency-Key': key },
      body: {
        merchantId: testMerchantId,
        items: [{ productId: testProductId, quantity: 1 }],
        paymentMethod: 'Instant UPI',
        deliveryLocation: { address: 'Koramangala 4th Block', coordinates: { lat: 12.9352, lng: 77.6245 } },
      },
    });
    return orderRes;
  }

  const pool = getPool();

  // ===========================================================================
  // Section 1: Prevent Imaginary Cash & Strict Verification Proof
  // ===========================================================================
  console.log('--- Section 1: Prevent Imaginary Cash & Verification Proof ---');

  const order1Res = await createOrder(tokenA);
  assert.strictEqual(order1Res.status, 200);
  const order1 = order1Res.data.order;

  const paymentOrder = await paymentService.createPaymentOrder(order1.id, userIdA);

  // Attempt payment verification with bogus/tampered signature
  const bogusVerifyRes = await apiCall('/api/payment/verify', {
    method: 'POST',
    token: tokenA,
    body: {
      orderId: order1.id,
      transactionId: `txn_bogus_${Date.now()}`,
      timestamp: Date.now(),
      signature: 'bogus_unverified_client_signature_12345',
      amount: parseFloat(order1.total_amount || order1.totalAmount),
    },
  });

  // MUST be rejected with HTTP 400 signature verification failed
  assert.strictEqual(bogusVerifyRes.status, 400);
  assert.strictEqual(bogusVerifyRes.data.success, false);

  // Verify order payment_status remains UNPAID in database
  const checkOrder1 = await pool.query(`SELECT payment_status FROM orders WHERE id = $1`, [order1.id]);
  assert.notStrictEqual(checkOrder1.rows[0].payment_status, 'PAID', 'Order must NOT be marked PAID with bogus signature');

  // Verify NO general ledger cash entries were posted
  const checkLedger1 = await pool.query(`SELECT COUNT(*) as cnt FROM general_ledger_entries WHERE order_id = $1`, [order1.id]);
  assert.strictEqual(parseInt(checkLedger1.rows[0].cnt, 10), 0, 'No imaginary ledger cash entries posted');

  console.log('✓ Section 1 Passed: Unverified client signature strictly rejected without marking order paid or posting fake cash.');

  // ===========================================================================
  // Section 2: Order Creation Parallel Burst Concurrency Safety
  // ===========================================================================
  console.log('--- Section 2: Order Creation Parallel Burst Concurrency Safety ---');

  const parallelKey = `idem_order_burst_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

  const burstResults = await Promise.all([
    createOrder(tokenA, parallelKey),
    createOrder(tokenA, parallelKey),
    createOrder(tokenA, parallelKey),
    createOrder(tokenA, parallelKey),
  ]);

  const burst200 = burstResults.filter((r) => r.status === 200);
  const burst409 = burstResults.filter((r) => r.status === 409);

  assert.ok(burst200.length >= 1, 'At least one order creation request succeeded');
  assert.strictEqual(burst200.length + burst409.length, 4, 'Parallel requests resolved cleanly as 200 or 409 Conflict');

  // Verify exactly ONE idempotency key row exists and has NOT been overwritten or corrupted
  const keyCheck = await pool.query(`SELECT status, response_body FROM idempotency_keys WHERE idempotency_key = $1`, [parallelKey]);
  assert.strictEqual(keyCheck.rows.length, 1);
  assert.strictEqual(keyCheck.rows[0].status, 'COMPLETED');

  // Replay request with same key returns cached response
  const replayOrderRes = await createOrder(tokenA, parallelKey);
  assert.strictEqual(replayOrderRes.status, 200);
  assert.strictEqual(replayOrderRes.data.order.id, burst200[0].data.order.id, 'Cached order response returned');

  console.log('✓ Section 2 Passed: Order placement concurrency burst handled atomically without creating duplicate orders.');

  // ===========================================================================
  // Section 3: Webhook State Progression & Retry Safety
  // ===========================================================================
  console.log('--- Section 3: Webhook State Progression & Retry Safety ---');

  const whOrderRes = await createOrder(tokenA);
  const whOrder = whOrderRes.data.order;
  const whEventId = `evt_wh_lifecycle_${Date.now()}`;
  const whTxId = `txn_wh_life_${Date.now()}`;
  const whTotal = parseFloat(whOrder.total_amount || whOrder.totalAmount);

  const whPayload = {
    id: whEventId,
    event: 'payment.captured',
    payload: {
      payment: {
        entity: {
          id: whTxId,
          order_id: `order_${whOrder.id}`,
          amount: Math.round(whTotal * 100),
          currency: 'INR',
          status: 'captured',
          notes: { orderId: whOrder.id },
        },
      },
    },
  };
  const whRaw = JSON.stringify(whPayload);
  const whSig = signPayload(whRaw);

  // Deliver webhook
  const whRes1 = await apiCall('/api/webhooks/razorpay', {
    method: 'POST',
    headers: { 'x-razorpay-signature': whSig },
    body: whPayload,
  });
  assert.strictEqual(whRes1.status, 200);

  // Verify webhook_events status is PROCESSED
  const whDbRow = await pool.query(`SELECT status, processed_at FROM webhook_events WHERE event_id = $1`, [whEventId]);
  assert.strictEqual(whDbRow.rows.length, 1);
  assert.strictEqual(whDbRow.rows[0].status, 'PROCESSED');
  assert.ok(whDbRow.rows[0].processed_at !== null);

  // Deliver exact duplicate webhook
  const whRes2 = await apiCall('/api/webhooks/razorpay', {
    method: 'POST',
    headers: { 'x-razorpay-signature': whSig },
    body: whPayload,
  });
  assert.strictEqual(whRes2.status, 200);
  assert.strictEqual(whRes2.data.duplicate, true);

  console.log('✓ Section 3 Passed: Webhook lifecycle (RECEIVED -> PROCESSED) and duplicate replay safety verified.');

  // Clean up
  server.close();
  console.log('================================================================================');
  console.log('  ALL SPRINT 15.1.2 PAYMENT INTEGRITY & REMEDIATION TESTS PASSED!');
  console.log('================================================================================');
}
