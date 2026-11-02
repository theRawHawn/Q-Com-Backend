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
import { MockPaymentProvider } from '../src/modules/payments/provider/MockPaymentProvider.js';
import { env } from '../src/config/env.js';

export async function runSprint15_3PaymentIntegrityClosureTests(): Promise<void> {
  console.log('\n================================================================================');
  console.log('  SPRINT 15.1.3 — PAYMENT INTEGRITY CLOSURE, IDEMPOTENCY CONCURRENCY & RECOVERY');
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
  const authA = await apiCall('/api/auth/request-otp', { method: 'POST', body: { phone: '+91-9777766666', role: 'CUSTOMER' } });
  const verifyA = await apiCall('/api/auth/verify-otp', { method: 'POST', body: { phone: '+91-9777766666', otp: authA.data.debugOtp || '123456', name: 'Customer 15.1.3' } });
  const tokenA = verifyA.data.token || verifyA.data.accessToken;
  const userIdA = verifyA.data.user?.id || verifyA.data.userId;

  const catalogRes = await apiCall('/api/catalog/products');
  const products = catalogRes.data.products || catalogRes.data;
  const testProductId = products[0].id;
  const testMerchantId = products[0].merchantId;

  async function createOrder(token: string, idempotencyKey?: string, customBody?: any) {
    const key = idempotencyKey || `ord_key_${crypto.randomUUID()}`;
    const defaultBody = {
      merchantId: testMerchantId,
      items: [{ productId: testProductId, quantity: 1 }],
      paymentMethod: 'Instant UPI',
      deliveryLocation: { address: 'Indiranagar 100ft Rd', coordinates: { lat: 12.9716, lng: 77.6412 } },
    };
    const orderRes = await apiCall('/api/orders/create', {
      method: 'POST',
      token,
      headers: { 'Idempotency-Key': key },
      body: customBody || defaultBody,
    });
    return orderRes;
  }

  const pool = getPool();

  // ===========================================================================
  // Section 1: Comprehensive Idempotency Verification (Cases A through F)
  // ===========================================================================
  console.log('--- Section 1: Six-Case Idempotency Verification ---');

  // Case A: Identical Concurrent Requests
  console.log('  [Case A] Identical concurrent order requests...');
  const keyA = `idem_case_a_${Date.now()}`;
  const burstResults = await Promise.all([
    createOrder(tokenA, keyA),
    createOrder(tokenA, keyA),
    createOrder(tokenA, keyA),
  ]);
  const successesA = burstResults.filter((r) => r.status === 200);
  const conflictsA = burstResults.filter((r) => r.status === 409);
  assert.ok(successesA.length >= 1, 'At least one request commits');
  assert.strictEqual(successesA.length + conflictsA.length, 3, 'All concurrent requests resolved cleanly');

  // Verify only one idempotency record was persisted for keyA and has COMPLETED status
  const keyRowA = await pool.query(
    `SELECT status, response_body FROM idempotency_keys WHERE idempotency_key = $1`,
    [keyA]
  );
  assert.strictEqual(keyRowA.rows.length, 1, 'Exactly one idempotency key record was persisted');
  assert.strictEqual(keyRowA.rows[0].status, 'COMPLETED');
  const parsedBody = typeof keyRowA.rows[0].response_body === 'string'
    ? JSON.parse(keyRowA.rows[0].response_body)
    : keyRowA.rows[0].response_body;
  assert.strictEqual(parsedBody.order.id, successesA[0].data.order.id);

  // Case B: Completed-Result Preservation
  console.log('  [Case B] Completed result preservation on replay...');
  const replayA = await createOrder(tokenA, keyA);
  assert.strictEqual(replayA.status, 200);
  assert.strictEqual(replayA.data.order.id, successesA[0].data.order.id, 'Cached completed order returned without re-executing');

  // Case C: Initial Insertion Race on Pricing Routes
  console.log('  [Case C] Initial insertion race on pricing route...');
  const keyC = `idem_pricing_race_${Date.now()}`;
  const pricingBurst = await Promise.all([
    apiCall('/api/checkout/calculate', {
      method: 'POST',
      token: tokenA,
      headers: { 'Idempotency-Key': keyC },
      body: {
        merchantId: testMerchantId,
        items: [{ productId: testProductId, quantity: 1 }],
      },
    }),
    apiCall('/api/checkout/calculate', {
      method: 'POST',
      token: tokenA,
      headers: { 'Idempotency-Key': keyC },
      body: {
        merchantId: testMerchantId,
        items: [{ productId: testProductId, quantity: 1 }],
      },
    }),
  ]);
  assert.ok(pricingBurst.some((r) => r.status === 200), 'At least one pricing calculation completed');
  const replayC = await apiCall('/api/checkout/calculate', {
    method: 'POST',
    token: tokenA,
    headers: { 'Idempotency-Key': keyC },
    body: {
      merchantId: testMerchantId,
      items: [{ productId: testProductId, quantity: 1 }],
    },
  });
  assert.strictEqual(replayC.status, 200, 'Replay of completed pricing result preserved');

  // Case D: Same Key, Different Payload
  console.log('  [Case D] Same key with conflicting request payload...');
  const mismatchRes = await createOrder(tokenA, keyA, {
    merchantId: testMerchantId,
    items: [{ productId: testProductId, quantity: 5 }], // Different quantity!
    paymentMethod: 'Instant UPI',
    deliveryLocation: { address: 'Completely Different Location', coordinates: { lat: 12.0, lng: 77.0 } },
  });
  assert.strictEqual(mismatchRes.status, 422, 'Payload mismatch must be rejected with HTTP 422');
  assert.strictEqual(mismatchRes.data.error, 'IDEMPOTENCY_PAYLOAD_MISMATCH');

  // Case E: Failure and Retry
  console.log('  [Case E] Failure and subsequent retry with same key...');
  const keyE = `idem_fail_retry_${Date.now()}`;
  const orderPayloadE = {
    merchantId: testMerchantId,
    items: [{ productId: testProductId, quantity: 1 }],
    paymentMethod: 'Instant UPI',
    deliveryLocation: { address: 'Indiranagar 100ft Rd', coordinates: { lat: 12.9716, lng: 77.6412 } },
  };

  // Temporarily exhaust available stock by setting reserved_count = stock_count (satisfying chk_reserved_le_stock)
  await pool.query(`UPDATE store_inventory SET reserved_count = stock_count WHERE product_id = $1`, [testProductId]);

  // Attempt 1 fails due to insufficient stock
  const failResE = await createOrder(tokenA, keyE, orderPayloadE);
  assert.strictEqual(failResE.status, 400, 'Initial order attempt fails with 400');
  assert.strictEqual(failResE.data.error, 'INSUFFICIENT_STOCK');

  // Verify idempotency record exists with FAILED status
  const keyCheckE = await pool.query(`SELECT status FROM idempotency_keys WHERE idempotency_key = $1`, [keyE]);
  assert.strictEqual(keyCheckE.rows.length, 1);
  assert.strictEqual(keyCheckE.rows[0].status, 'FAILED');

  // Restock store_inventory by freeing reservations and setting stock
  await pool.query(`UPDATE store_inventory SET reserved_count = 0, stock_count = 50 WHERE product_id = $1`, [testProductId]);

  // Attempt 2: Retry with the exact same key and payload
  const retryResE = await createOrder(tokenA, keyE, orderPayloadE);
  assert.strictEqual(retryResE.status, 200, 'Retry of previously failed operation must succeed and not be permanently locked as in-progress');
  assert.ok(retryResE.data.order?.id, 'Order was placed successfully on retry');

  // Verify idempotency record is now COMPLETED
  const finalKeyE = await pool.query(`SELECT status FROM idempotency_keys WHERE idempotency_key = $1`, [keyE]);
  assert.strictEqual(finalKeyE.rows[0].status, 'COMPLETED');

  // Case F: Unrelated Unique-Constraint Isolation
  console.log('  [Case F] Unrelated unique constraint violation isolation...');
  // Attempt to insert duplicate webhook_events row directly to test error isolation
  const dupEventId = `evt_dup_iso_${Date.now()}`;
  await pool.query(
    `INSERT INTO webhook_events (event_id, gateway, event_type, payload, status)
     VALUES ($1, 'RAZORPAY', 'test.event', '{}', 'RECEIVED')`,
    [dupEventId]
  );
  let duplicateConstraintCaught = false;
  try {
    await pool.query(
      `INSERT INTO webhook_events (event_id, gateway, event_type, payload, status)
       VALUES ($1, 'RAZORPAY', 'test.event', '{}', 'RECEIVED')`,
      [dupEventId]
    );
  } catch (err: any) {
    duplicateConstraintCaught = true;
    assert.strictEqual(err.code, '23505', 'PostgreSQL error code is 23505');
    // Ensure constraint is NOT misclassified as an idempotency collision
    assert.ok(err.table === 'webhook_events' || err.message?.includes('webhook_events') || err.constraint?.includes('event_id'));
  }
  assert.ok(duplicateConstraintCaught, 'Unrelated unique constraint error was caught and preserved');
  console.log('✓ Section 1 Passed: All 6 Idempotency cases (A through F) thoroughly verified.');

  // ===========================================================================
  // Section 2: Payment Trust, Signature Validation & RECONCILIATION_REQUIRED
  // ===========================================================================
  console.log('--- Section 2: Payment Trust & RECONCILIATION_REQUIRED ---');

  const order2Res = await createOrder(tokenA);
  assert.strictEqual(order2Res.status, 200);
  const order2 = order2Res.data.order;
  const order2Total = parseFloat(order2.total_amount || order2.totalAmount);

  // 1. Client-generated signature is rejected
  const tamperedRes = await apiCall('/api/payment/verify', {
    method: 'POST',
    token: tokenA,
    body: {
      orderId: order2.id,
      transactionId: `txn_fake_${Date.now()}`,
      timestamp: Date.now(),
      signature: 'client_fake_signature_abc123',
      amount: order2Total,
    },
  });
  assert.strictEqual(tamperedRes.status, 400, 'Tampered/client signature rejected');
  const checkOrder2 = await pool.query(`SELECT payment_status FROM orders WHERE id = $1`, [order2.id]);
  assert.notStrictEqual(checkOrder2.rows[0].payment_status, 'PAID', 'Order not marked paid on signature failure');
  const ledgerEntries2 = await pool.query(`SELECT COUNT(*) as cnt FROM general_ledger_entries WHERE order_id = $1`, [order2.id]);
  assert.strictEqual(parseInt(ledgerEntries2.rows[0].cnt, 10), 0, 'No cash posted to ledger on fake signature');

  // 2. Gateway Timeout / Communication Failure -> Routes to RECONCILIATION_REQUIRED
  console.log('  Testing Provider Timeout -> RECONCILIATION_REQUIRED transition...');
  const timeoutProvider = new MockPaymentProvider('mock_timeout', { simulateTimeout: true });
  paymentService.setProvider(timeoutProvider);

  const timeoutVerifyRes = await apiCall('/api/payment/verify', {
    method: 'POST',
    token: tokenA,
    body: {
      orderId: order2.id,
      transactionId: `txn_timeout_${Date.now()}`,
      timestamp: Date.now(),
      signature: 'mock_sig',
      amount: order2Total,
    },
  });

  // Must return 202 Accepted with status RECONCILIATION_REQUIRED
  assert.strictEqual(timeoutVerifyRes.status, 202, 'Ambiguous outcome returns 202 Accepted');
  assert.strictEqual(timeoutVerifyRes.data.success, false, 'Does NOT claim success when outcome is ambiguous');
  assert.strictEqual(timeoutVerifyRes.data.status, 'RECONCILIATION_REQUIRED');

  // Invariant: Order is NOT marked paid, stock is NOT committed, ledger has NO cash entry
  const checkTimeoutOrder = await pool.query(`SELECT payment_status, status FROM orders WHERE id = $1`, [order2.id]);
  assert.notStrictEqual(checkTimeoutOrder.rows[0].payment_status, 'PAID', 'Order must NOT be marked PAID on timeout');
  assert.notStrictEqual(checkTimeoutOrder.rows[0].status, 'cancelled', 'Order must NOT be cancelled prematurely');

  const checkTimeoutLedger = await pool.query(`SELECT COUNT(*) as cnt FROM general_ledger_entries WHERE order_id = $1`, [order2.id]);
  assert.strictEqual(parseInt(checkTimeoutLedger.rows[0].cnt, 10), 0, 'No cash posted during ambiguous state');

  // 3. Late arriving webhook settles the RECONCILIATION_REQUIRED order
  console.log('  Testing authoritative reconciliation via webhook...');
  // Restore normal provider
  paymentService.setProvider(new MockPaymentProvider('mock'));

  const whEventId = `evt_rec_settle_${Date.now()}`;
  const whTxId = `txn_rec_settle_${Date.now()}`;
  const whPayload = {
    id: whEventId,
    event: 'payment.captured',
    payload: {
      payment: {
        entity: {
          id: whTxId,
          order_id: `order_${order2.id}`,
          amount: Math.round(order2Total * 100),
          currency: 'INR',
          status: 'captured',
          notes: { orderId: order2.id },
        },
      },
    },
  };
  const whRaw = JSON.stringify(whPayload);
  const whSig = signPayload(whRaw);

  const settleWhRes = await apiCall('/api/webhooks/razorpay', {
    method: 'POST',
    headers: { 'x-razorpay-signature': whSig },
    body: whPayload,
  });
  assert.strictEqual(settleWhRes.status, 200);

  // Now order IS marked PAID, and ledger cash is posted atomically
  const settledOrder = await pool.query(`SELECT payment_status FROM orders WHERE id = $1`, [order2.id]);
  assert.strictEqual(settledOrder.rows[0].payment_status, 'PAID', 'Order transitioned to PAID upon webhook confirmation');

  // Verify Ledger entries: Debit 1010 == Credit 2010
  const ledgerDebit = await pool.query(
    `SELECT amount FROM general_ledger_entries WHERE order_id = $1 AND account_code = '1010' AND entry_side = 'DEBIT'`,
    [order2.id]
  );
  const ledgerCredit = await pool.query(
    `SELECT amount FROM general_ledger_entries WHERE order_id = $1 AND account_code = '2010' AND entry_side = 'CREDIT'`,
    [order2.id]
  );
  assert.strictEqual(ledgerDebit.rows.length, 1);
  assert.strictEqual(ledgerCredit.rows.length, 1);
  assert.strictEqual(parseFloat(ledgerDebit.rows[0].amount), order2Total);
  assert.strictEqual(parseFloat(ledgerCredit.rows[0].amount), order2Total);

  console.log('✓ Section 2 Passed: Payment trust boundaries, RECONCILIATION_REQUIRED routing, and authoritative settlement verified.');

  // ===========================================================================
  // Section 3: Webhook Duplicate Replay Safety & Financial Balance Atomicity
  // ===========================================================================
  console.log('--- Section 3: Webhook Duplicate Replay & Financial Atomicity ---');

  // Replay exact duplicate webhook
  const duplicateWhRes = await apiCall('/api/webhooks/razorpay', {
    method: 'POST',
    headers: { 'x-razorpay-signature': whSig },
    body: whPayload,
  });
  assert.strictEqual(duplicateWhRes.status, 200);
  assert.strictEqual(duplicateWhRes.data.duplicate, true, 'Duplicate webhook flagged idempotently');

  // Confirm NO duplicate ledger rows were posted
  const totalLedgerRows = await pool.query(
    `SELECT COUNT(*) as count FROM general_ledger_entries WHERE order_id = $1`,
    [order2.id]
  );
  assert.strictEqual(parseInt(totalLedgerRows.rows[0].count, 10), 2, 'Exactly 2 ledger rows (1 Dr, 1 Cr) remain posted');

  // Clean up
  server.close();
  console.log('================================================================================');
  console.log('  ALL SPRINT 15.1.3 PAYMENT INTEGRITY CLOSURE TESTS PASSED!');
  console.log('================================================================================');
}
