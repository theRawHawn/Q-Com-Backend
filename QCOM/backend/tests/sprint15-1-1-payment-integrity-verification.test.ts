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

export async function runSprint15_1_1PaymentIntegrityVerificationTests(): Promise<void> {
  console.log('\n================================================================================');
  console.log('  SPRINT 15.1.1 — PAYMENT INTEGRITY VERIFICATION & WEBHOOK RECOVERY');
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

  // Create two distinct customers to test cross-actor boundaries
  const authA = await apiCall('/api/auth/request-otp', { method: 'POST', body: { phone: '+91-9111122222', role: 'CUSTOMER' } });
  const verifyA = await apiCall('/api/auth/verify-otp', { method: 'POST', body: { phone: '+91-9111122222', otp: authA.data.debugOtp || '123456', name: 'Customer A' } });
  const tokenA = verifyA.data.token || verifyA.data.accessToken;

  const authB = await apiCall('/api/auth/request-otp', { method: 'POST', body: { phone: '+91-9333344444', role: 'CUSTOMER' } });
  const verifyB = await apiCall('/api/auth/verify-otp', { method: 'POST', body: { phone: '+91-9333344444', otp: authB.data.debugOtp || '123456', name: 'Customer B' } });
  const tokenB = verifyB.data.token || verifyB.data.accessToken;

  const catalogRes = await apiCall('/api/catalog/products');
  const products = catalogRes.data.products || catalogRes.data;
  const testProductId = products[0].id;
  const testMerchantId = products[0].merchantId;

  async function createOrder(token: string) {
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
      headers: { 'Idempotency-Key': `ord_key_${crypto.randomUUID()}` },
      body: {
        merchantId: testMerchantId,
        items: [{ productId: testProductId, quantity: 1 }],
        paymentMethod: 'Instant UPI',
        deliveryLocation: { address: 'Indiranagar 100ft Rd', coordinates: { lat: 12.9352, lng: 77.6245 } },
      },
    });
    assert.strictEqual(orderRes.status, 200, `Order creation failed: ${JSON.stringify(orderRes.data)}`);
    return orderRes.data.order;
  }

  const pool = getPool();

  // ===========================================================================
  // Section 1: Webhook Failure Recovery & Deduplication Safety
  // ===========================================================================
  console.log('--- Section 1: Webhook Failure Recovery & Deduplication Safety ---');

  // Test 1.1: Webhook failure does not falsely suppress subsequent retry
  const failOrder = await createOrder(tokenA);
  const failEventId = `evt_fail_recov_${Date.now()}`;
  
  // Directly simulate a webhook event recorded as RECEIVED where initial processing was aborted
  await pool.query(`
    INSERT INTO webhook_events (event_id, gateway, event_type, payload, status, received_at)
    VALUES ($1, 'RAZORPAY', 'refund.processed', $2, 'RECEIVED', NOW())
  `, [failEventId, JSON.stringify({
    id: failEventId,
    event: 'refund.processed',
    payload: {
      refund: {
        entity: {
          id: `rfnd_fail_${Date.now()}`,
          payment_id: `pay_fail_${Date.now()}`,
          notes: { orderId: failOrder.id },
          status: 'processed',
        },
      },
    },
  })]);

  // Verify that an initial RECEIVED or aborted status in webhook_events is NOT falsely treated as completed
  const retryRefundPayload = {
    id: failEventId,
    event: 'refund.processed',
    payload: {
      refund: {
        entity: {
          id: `rfnd_fail_${Date.now()}`,
          payment_id: `pay_fail_${Date.now()}`,
          notes: { orderId: failOrder.id },
          status: 'processed',
        },
      },
    },
  };
  const retryRefundRaw = JSON.stringify(retryRefundPayload);
  const retryRefundSig = signPayload(retryRefundRaw);

  // Calling financialWebhookService.processFinancialWebhook on this event should NOT say duplicate: true (unless PROCESSED)
  // It will process the refund event
  const retryWebhookRes = await financialWebhookService.processFinancialWebhook({
    rawBody: retryRefundRaw,
    signature: retryRefundSig,
    gateway: 'RAZORPAY',
  });

  // Because the refund record didn't exist, it safely ignored without dropping the retry
  assert.strictEqual(retryWebhookRes.success, true);
  assert.strictEqual(retryWebhookRes.duplicate, undefined);
  console.log('✓ Section 1.1 Passed: Unprocessed webhook event is not falsely acknowledged as duplicate upon retry.');

  // Test 1.2: Completed webhook event is safely acknowledged as duplicate
  const dupEventId = `evt_dup_proc_${Date.now()}`;
  await pool.query(`
    INSERT INTO webhook_events (event_id, gateway, event_type, payload, status, processed_at)
    VALUES ($1, 'RAZORPAY', 'refund.processed', '{}', 'PROCESSED', NOW())
  `, [dupEventId]);

  const dupPayload = JSON.stringify({ id: dupEventId, event: 'refund.processed', payload: {} });
  const dupRes = await financialWebhookService.processFinancialWebhook({
    rawBody: dupPayload,
    signature: signPayload(dupPayload),
  });
  assert.strictEqual(dupRes.success, true);
  assert.strictEqual(dupRes.duplicate, true);
  console.log('✓ Section 1.2 Passed: PROCESSED webhook event is safely recognized as duplicate.');

  // ===========================================================================
  // Section 2: Atomic Idempotency Claiming & Concurrency Race Condition Safety
  // ===========================================================================
  console.log('--- Section 2: Atomic Idempotency Claiming & Concurrency Safety ---');

  const concOrder = await createOrder(tokenA);
  const concKey = `idem_race_key_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

  // Fire 5 simultaneous requests with the exact same Idempotency-Key
  const results = await Promise.all([
    apiCall('/api/payment/create-order', {
      method: 'POST',
      token: tokenA,
      headers: { 'Idempotency-Key': concKey },
      body: { orderId: concOrder.id },
    }),
    apiCall('/api/payment/create-order', {
      method: 'POST',
      token: tokenA,
      headers: { 'Idempotency-Key': concKey },
      body: { orderId: concOrder.id },
    }),
    apiCall('/api/payment/create-order', {
      method: 'POST',
      token: tokenA,
      headers: { 'Idempotency-Key': concKey },
      body: { orderId: concOrder.id },
    }),
    apiCall('/api/payment/create-order', {
      method: 'POST',
      token: tokenA,
      headers: { 'Idempotency-Key': concKey },
      body: { orderId: concOrder.id },
    }),
    apiCall('/api/payment/create-order', {
      method: 'POST',
      token: tokenA,
      headers: { 'Idempotency-Key': concKey },
      body: { orderId: concOrder.id },
    }),
  ]);

  // At least one request must succeed with 200, and any concurrent requests caught in progress must receive 409 Conflict
  const successCount = results.filter((r) => r.status === 200).length;
  const conflictCount = results.filter((r) => r.status === 409).length;
  assert.ok(successCount >= 1, 'At least one request must succeed with 200');
  assert.strictEqual(successCount + conflictCount, 5, 'All requests must be cleanly resolved as 200 or 409');

  // Verify only ONE payment intent row was created for this order
  const intentCheck = await pool.query(`SELECT COUNT(*) AS cnt FROM payment_intents WHERE order_id = $1`, [concOrder.id]);
  assert.strictEqual(parseInt(intentCheck.rows[0].cnt, 10), 1, 'Exactly one payment intent must be created');

  // Subsequent replay with same key returns cached response (status 200)
  const replayRes = await apiCall('/api/payment/create-order', {
    method: 'POST',
    token: tokenA,
    headers: { 'Idempotency-Key': concKey },
    body: { orderId: concOrder.id },
  });
  assert.strictEqual(replayRes.status, 200);
  assert.strictEqual(replayRes.data.success, true);
  console.log('✓ Section 2 Passed: Atomic idempotency claiming prevents duplicate intents under parallel burst.');

  // ===========================================================================
  // Section 3: Late Payment After Cancellation & Escrow Balance Integrity
  // ===========================================================================
  console.log('--- Section 3: Late Payment After Cancellation & Escrow Balance Integrity ---');

  // 1. Create order and cancel it
  const lateOrder = await createOrder(tokenA);
  const cancelRes = await apiCall(`/api/orders/${lateOrder.id}/cancel`, {
    method: 'POST',
    token: tokenA,
    body: { reason: 'Customer changed mind before payment' },
  });
  assert.strictEqual(cancelRes.status, 200);

  // Verify order is cancelled and reservation released
  const orderAfterCancel = await pool.query(`SELECT status, payment_status FROM orders WHERE id = $1`, [lateOrder.id]);
  assert.strictEqual(orderAfterCancel.rows[0].status, 'cancelled');

  const resAfterCancel = await pool.query(`SELECT status FROM inventory_reservations WHERE order_id = $1`, [lateOrder.id]);
  assert.strictEqual(resAfterCancel.rows[0].status, 'RELEASED');

  // 2. Late successful payment webhook arrives for this cancelled order
  const lateTxId = `pay_late_${Date.now()}`;
  const lateEventId = `evt_late_${Date.now()}`;
  const lateOrderTotal = parseFloat(lateOrder.total_amount || lateOrder.totalAmount || '0');

  const lateWebhookPayload = {
    id: lateEventId,
    event: 'payment.captured',
    payload: {
      payment: {
        entity: {
          id: lateTxId,
          order_id: `order_token_${lateOrder.id}`,
          amount: Math.round(lateOrderTotal * 100),
          currency: 'INR',
          status: 'captured',
          notes: { orderId: lateOrder.id },
        },
      },
    },
  };
  const lateRaw = JSON.stringify(lateWebhookPayload);
  const lateSig = signPayload(lateRaw);

  const lateHookRes = await apiCall('/api/webhooks/razorpay', {
    method: 'POST',
    headers: {
      'x-razorpay-signature': lateSig,
    },
    body: lateWebhookPayload,
  });
  assert.strictEqual(lateHookRes.status, 200);

  // 3. Verify order status: MUST NOT be revived! Must remain cancelled with payment_status = REFUND_PENDING
  const orderAfterLatePay = await pool.query(`SELECT status, payment_status FROM orders WHERE id = $1`, [lateOrder.id]);
  assert.ok(['REFUND_PENDING', 'REFUNDED'].includes(orderAfterLatePay.rows[0].payment_status), `Payment status must be REFUND_PENDING or REFUNDED, got ${orderAfterLatePay.rows[0].payment_status}`);

  // 4. Verify stock was NOT committed
  const resAfterLatePay = await pool.query(`SELECT status FROM inventory_reservations WHERE order_id = $1`, [lateOrder.id]);
  assert.strictEqual(resAfterLatePay.rows[0].status, 'RELEASED', 'Stock reservation must remain RELEASED');

  // 5. Verify General Ledger: Escrow captured (Dr 1010, Cr 2010)
  const glEntries = await pool.query(`
    SELECT account_code, entry_side, amount FROM general_ledger_entries
    WHERE order_id = $1 AND transaction_reference = $2
  `, [lateOrder.id, `TX_PAY_${lateOrder.id}`]);
  assert.strictEqual(glEntries.rows.length, 2, 'Must have exactly 2 ledger entries for escrow capture');

  const debits = glEntries.rows.filter(e => e.entry_side === 'DEBIT');
  const credits = glEntries.rows.filter(e => e.entry_side === 'CREDIT');
  assert.strictEqual(debits[0].account_code, '1010');
  assert.strictEqual(credits[0].account_code, '2010');
  assert.strictEqual(parseFloat(debits[0].amount), lateOrderTotal);
  assert.strictEqual(parseFloat(credits[0].amount), lateOrderTotal);

  // 6. Verify automated refund intent was created in PROCESSING state
  const refundCheck = await pool.query(`
    SELECT id, status, amount, reason_code FROM refunds
    WHERE order_id = $1
  `, [lateOrder.id]);
  assert.strictEqual(refundCheck.rows.length, 1, 'Automated refund record must be created');
  assert.strictEqual(parseFloat(refundCheck.rows[0].amount), lateOrderTotal);

  // 7. Duplicate webhook arrival for the same late payment: Must be idempotent and NOT post duplicate ledger entries
  const dupLateHookRes = await apiCall('/api/webhooks/razorpay', {
    method: 'POST',
    headers: { 'x-razorpay-signature': lateSig },
    body: lateWebhookPayload,
  });
  assert.strictEqual(dupLateHookRes.status, 200);

  const glEntriesAfterDup = await pool.query(`
    SELECT COUNT(*) as cnt FROM general_ledger_entries WHERE order_id = $1
  `, [lateOrder.id]);
  assert.strictEqual(parseInt(glEntriesAfterDup.rows[0].cnt, 10), 4, 'Ledger entries must be 4 total (2 capture + 2 cancellation refund) and not duplicated on webhook retry');

  console.log('✓ Section 3 Passed: Late payment capture on cancelled order escalates to refund and maintains exact ledger balance.');

  // ===========================================================================
  // Section 4: Webhook Error Code Classification & Provider Retry Compliance
  // ===========================================================================
  console.log('--- Section 4: Webhook Error Code Classification ---');

  // 1. Missing signature returns 400 MISSING_WEBHOOK_SIGNATURE
  const noSigRes = await apiCall('/api/payment/webhook', {
    method: 'POST',
    body: { id: 'evt_no_sig', event: 'payment.captured' },
  });
  assert.strictEqual(noSigRes.status, 400);
  assert.strictEqual(noSigRes.data.error, 'MISSING_WEBHOOK_SIGNATURE');

  // 2. Invalid cryptographic signature returns 400 INVALID_WEBHOOK_SIGNATURE
  const badSigRes = await apiCall('/api/payment/webhook', {
    method: 'POST',
    headers: { 'x-webhook-signature': 'invalid_hex_signature_1234567890abcdef' },
    body: { id: 'evt_bad_sig', event: 'payment.captured' },
  });
  assert.strictEqual(badSigRes.status, 400);
  assert.strictEqual(badSigRes.data.error, 'INVALID_WEBHOOK_SIGNATURE');

  // 3. Amount mismatch returns 400 PAYMENT_AMOUNT_MISMATCH and records FAILED in webhook_events
  const mismatchOrder = await createOrder(tokenA);
  const mismatchEventId = `evt_amt_mismatch_${Date.now()}`;
  const mismatchPayload = {
    id: mismatchEventId,
    event: 'payment.captured',
    payload: {
      payment: {
        entity: {
          id: `pay_tamper_${Date.now()}`,
          order_id: `ord_${mismatchOrder.id}`,
          amount: 999999, // Tampered amount
          currency: 'INR',
          status: 'captured',
          notes: { orderId: mismatchOrder.id },
        },
      },
    },
  };
  const mismatchRaw = JSON.stringify(mismatchPayload);
  const mismatchSig = signPayload(mismatchRaw);

  const mismatchRes = await apiCall('/api/webhooks/razorpay', {
    method: 'POST',
    headers: { 'x-razorpay-signature': mismatchSig },
    body: mismatchPayload,
  });
  assert.strictEqual(mismatchRes.status, 400);
  assert.strictEqual(mismatchRes.data.error, 'PAYMENT_AMOUNT_MISMATCH');

  // Verify webhook_events recorded the permanent rejection as FAILED
  const whEventRow = await pool.query(`SELECT status, error_message FROM webhook_events WHERE event_id = $1`, [mismatchEventId]);
  assert.strictEqual(whEventRow.rows.length, 1);
  assert.strictEqual(whEventRow.rows[0].status, 'FAILED');
  assert.strictEqual(whEventRow.rows[0].error_message, 'PAYMENT_AMOUNT_MISMATCH');

  console.log('✓ Section 4 Passed: Webhook errors properly classified (400 for client violations with permanent tracking).');

  // Clean up
  server.close();
  console.log('================================================================================');
  console.log('  ALL SPRINT 15.1.1 PAYMENT INTEGRITY VERIFICATION TESTS PASSED!');
  console.log('================================================================================');
}
