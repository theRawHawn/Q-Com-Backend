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
import { ledgerService } from '../src/modules/ledger/ledgerService.js';
import { env } from '../src/config/env.js';

export async function runSprint15_1PaymentIdempotencyAndIntegrityTests(): Promise<void> {
  console.log('\n================================================================================');
  console.log('  SPRINT 15.1 — PAYMENT IDEMPOTENCY, DUPLICATE WEBHOOKS & FINANCIAL INTEGRITY');
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
  const userIdA = verifyA.data.user?.id || verifyA.data.userId || verifyA.data.id || (verifyA.data.user && verifyA.data.user.id);

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

  // ===========================================================================
  // Section 1: Atomic Idempotency Key Claiming, Fingerprinting & Concurrency
  // ===========================================================================
  console.log('--- Section 1: Atomic Idempotency Claiming & Concurrency ---');

  const order1 = await createOrder(tokenA);
  const idemKey1 = `idem_create_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

  // 1. Initial create-order with Idempotency-Key
  const createRes1 = await apiCall('/api/payment/create-order', {
    method: 'POST',
    token: tokenA,
    headers: { 'Idempotency-Key': idemKey1 },
    body: { orderId: order1.id },
  });
  assert.strictEqual(createRes1.status, 200);
  assert.strictEqual(createRes1.data.success, true);
  const paymentOrder = createRes1.data.paymentOrder;

  // 2. Replay with exact same key and payload returns cached response
  const replayRes1 = await apiCall('/api/payment/create-order', {
    method: 'POST',
    token: tokenA,
    headers: { 'Idempotency-Key': idemKey1 },
    body: { orderId: order1.id },
  });
  assert.strictEqual(replayRes1.status, 200);
  assert.deepStrictEqual(replayRes1.data, createRes1.data, 'Cached response must match original response');

  // 3. Reused key with different payload returns 422 IDEMPOTENCY_PAYLOAD_MISMATCH
  const otherOrder = await createOrder(tokenA);
  const mismatchRes = await apiCall('/api/payment/create-order', {
    method: 'POST',
    token: tokenA,
    headers: { 'Idempotency-Key': idemKey1 },
    body: { orderId: otherOrder.id },
  });
  assert.strictEqual(mismatchRes.status, 422);
  assert.strictEqual(mismatchRes.data.error, 'IDEMPOTENCY_PAYLOAD_MISMATCH');

  // 4. Cross-actor key isolation: User B attempting to use User A's key returns 403
  const crossUserRes = await apiCall('/api/payment/create-order', {
    method: 'POST',
    token: tokenB,
    headers: { 'Idempotency-Key': idemKey1 },
    body: { orderId: order1.id },
  });
  assert.strictEqual(crossUserRes.status, 403);
  assert.strictEqual(crossUserRes.data.error, 'UNAUTHORIZED_IDEMPOTENCY_KEY_ACCESS');

  // 5. Simultaneous concurrent requests with identical Idempotency-Key
  const concOrder = await createOrder(tokenA);
  const concKey = `idem_conc_${Date.now()}`;
  const [cRes1, cRes2] = await Promise.all([
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

  // One request must succeed with 200, the other gets 200 (if cached fast) or 409 (if caught in progress)
  assert.ok(
    (cRes1.status === 200 && (cRes2.status === 200 || cRes2.status === 409)) ||
    (cRes2.status === 200 && (cRes1.status === 200 || cRes1.status === 409)),
    `Expected exactly one initial claim, got statuses ${cRes1.status} and ${cRes2.status}`
  );
  console.log('✓ Section 1 Passed: Atomic idempotency key claim, payload mismatch, cross-user isolation & concurrency verified.');

  // ===========================================================================
  // Section 2: Payment Verification Idempotency & Duplicate Webhook Protection
  // ===========================================================================
  console.log('--- Section 2: Payment Verification & Duplicate Webhooks ---');

  const pool = getPool();
  const txId1 = `txn_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const verifyKey = `idem_verify_${Date.now()}`;

  // 1. Initial verify call with Idempotency-Key
  const verifyPayRes = await apiCall('/api/payment/verify', {
    method: 'POST',
    token: tokenA,
    headers: { 'Idempotency-Key': verifyKey },
    body: {
      orderId: order1.id,
      transactionId: txId1,
      timestamp: new Date(paymentOrder.timestamp).getTime(),
      signature: paymentOrder.signature,
      amount: paymentOrder.amount,
    },
  });
  assert.strictEqual(verifyPayRes.status, 200);
  assert.strictEqual(verifyPayRes.data.success, true);
  assert.strictEqual(verifyPayRes.data.isDuplicate, false);
  assert.strictEqual(verifyPayRes.data.order.payment_status, 'PAID');

  // 2. Replay of verify with same Idempotency-Key returns cached 200 response
  const verifyReplayRes = await apiCall('/api/payment/verify', {
    method: 'POST',
    token: tokenA,
    headers: { 'Idempotency-Key': verifyKey },
    body: {
      orderId: order1.id,
      transactionId: txId1,
      timestamp: new Date(paymentOrder.timestamp).getTime(),
      signature: paymentOrder.signature,
      amount: paymentOrder.amount,
    },
  });
  assert.strictEqual(verifyReplayRes.status, 200);
  assert.deepStrictEqual(verifyReplayRes.data, verifyPayRes.data, 'Cached verify response must match original');

  // 3. New verify request on already-paid order (without key or with new key) returns 409 duplicate
  const duplicateVerifyRes = await apiCall('/api/payment/verify', {
    method: 'POST',
    token: tokenA,
    headers: { 'Idempotency-Key': `idem_new_key_${Date.now()}` },
    body: {
      orderId: order1.id,
      transactionId: `txn_other_${Date.now()}`,
      timestamp: new Date(paymentOrder.timestamp).getTime(),
      signature: paymentOrder.signature,
      amount: paymentOrder.amount,
    },
  });
  assert.strictEqual(duplicateVerifyRes.status, 409);
  assert.strictEqual(duplicateVerifyRes.data.isDuplicate, true);

  // 4. Duplicate webhook delivery for this order
  const hookEventId = `evt_pay_dup_${Date.now()}`;
  const hookPayload = JSON.stringify({
    id: hookEventId,
    event: 'payment.captured',
    payload: {
      payment: {
        entity: {
          id: txId1,
          amount: Math.round(paymentOrder.amount * 100),
          currency: 'INR',
          status: 'captured',
          notes: { orderId: order1.id },
        },
      },
    },
  });
  const hookSig = signPayload(hookPayload);

  // First webhook delivery
  const hookRes1 = await apiCall('/api/webhooks/razorpay', {
    method: 'POST',
    headers: { 'x-razorpay-signature': hookSig },
    body: JSON.parse(hookPayload),
  });
  assert.strictEqual(hookRes1.status, 200);
  assert.strictEqual(hookRes1.data.duplicate, true, 'Order already PAID, webhook must detect duplicate');

  // Replay of exact same webhook event ID
  const hookRes2 = await apiCall('/api/webhooks/razorpay', {
    method: 'POST',
    headers: { 'x-razorpay-signature': hookSig },
    body: JSON.parse(hookPayload),
  });
  assert.strictEqual(hookRes2.status, 200);
  assert.strictEqual(hookRes2.data.duplicate, true);

  // 5. Simultaneous concurrent delivery of identical webhook event ID
  const concHookEventId = `evt_conc_hook_${Date.now()}`;
  const concHookOrder = await createOrder(tokenA);
  const concHookOrderIntent = await paymentService.createPaymentOrder(concHookOrder.id, userIdA);
  const concTxId = `txn_conc_hook_${Date.now()}`;

  const concHookPayload = JSON.stringify({
    id: concHookEventId,
    event: 'payment.captured',
    payload: {
      payment: {
        entity: {
          id: concTxId,
          amount: Math.round(parseFloat(String(concHookOrder.totalAmount ?? concHookOrder.total_amount)) * 100),
          currency: 'INR',
          status: 'captured',
          notes: { orderId: concHookOrder.id },
        },
      },
    },
  });
  const concHookSig = signPayload(concHookPayload);

  const [wRes1, wRes2] = await Promise.all([
    apiCall('/api/webhooks/razorpay', {
      method: 'POST',
      headers: { 'x-razorpay-signature': concHookSig },
      body: JSON.parse(concHookPayload),
    }),
    apiCall('/api/webhooks/razorpay', {
      method: 'POST',
      headers: { 'x-razorpay-signature': concHookSig },
      body: JSON.parse(concHookPayload),
    }),
  ]);
  if (wRes1.status !== 200 || wRes2.status !== 200) {
    console.error('Webhook error wRes1:', wRes1.data, 'wRes2:', wRes2.data);
  }
  assert.strictEqual(wRes1.status, 200);
  assert.strictEqual(wRes2.status, 200);
  const duplicates = [wRes1.data.duplicate, wRes2.data.duplicate];
  assert.ok(duplicates.includes(false), 'Exactly one webhook delivery must be primary capture');
  assert.ok(duplicates.includes(true), 'Concurrent delivery of same eventId must be marked duplicate');

  // Verify exactly 1 payment receipt and 1 ledger batch created
  const receipts = await pool.query(`SELECT COUNT(*) FROM payment_receipts WHERE order_id = $1`, [concHookOrder.id]);
  assert.strictEqual(parseInt(receipts.rows[0].count, 10), 1, 'Exactly one payment receipt must exist');

  const ledgerBatches = await pool.query(
    `SELECT COUNT(DISTINCT journal_batch_id) FROM general_ledger_entries WHERE order_id = $1`,
    [concHookOrder.id]
  );
  assert.strictEqual(parseInt(ledgerBatches.rows[0].count, 10), 1, 'Exactly one ledger journal batch must exist');

  console.log('✓ Section 2 Passed: Verification idempotency, webhook duplicate recognition & concurrent serialization verified.');

  // ===========================================================================
  // Section 3: Out-of-Order Webhooks & Late Payment Capture Safety
  // ===========================================================================
  console.log('--- Section 3: Out-of-Order Webhooks & Late Payment Safety ---');

  // 1. payment.failed event arriving AFTER payment is already captured
  const failEventPayload = JSON.stringify({
    id: `evt_fail_late_${Date.now()}`,
    event: 'payment.failed',
    payload: {
      payment: {
        entity: {
          id: concTxId,
          amount: Math.round(parseFloat(String(concHookOrder.totalAmount ?? concHookOrder.total_amount)) * 100),
          notes: { orderId: concHookOrder.id },
          error_code: 'BAD_REQUEST_ERROR',
        },
      },
    },
  });
  const failRes = await apiCall('/api/webhooks/razorpay', {
    method: 'POST',
    headers: { 'x-razorpay-signature': signPayload(failEventPayload) },
    body: JSON.parse(failEventPayload),
  });
  assert.strictEqual(failRes.status, 200);

  // Verify order is STILL PAID and not cancelled by out-of-order failure
  const postFailOrder = await pool.query(`SELECT payment_status, status FROM orders WHERE id = $1`, [concHookOrder.id]);
  assert.strictEqual(postFailOrder.rows[0].payment_status, 'PAID', 'Late failed event must not regress PAID status');
  assert.notStrictEqual(postFailOrder.rows[0].status, 'cancelled', 'Late failed event must not cancel paid order');

  // 2. Late payment on cancelled order:
  // Order is cancelled, then payment.captured arrives late
  const lateOrder = await createOrder(tokenA);
  const lateIntent = await paymentService.createPaymentOrder(lateOrder.id, userIdA);
  const cancelRes = await apiCall(`/api/orders/${lateOrder.id}/cancel`, { method: 'POST', token: tokenA });
  assert.strictEqual(cancelRes.status, 200);

  const lateTxId = `txn_late_${Date.now()}`;
  const lateHookPayload = JSON.stringify({
    id: `evt_late_${Date.now()}`,
    event: 'payment.captured',
    payload: {
      payment: {
        entity: {
          id: lateTxId,
          amount: Math.round(parseFloat(String(lateOrder.totalAmount ?? lateOrder.total_amount)) * 100),
          currency: 'INR',
          status: 'captured',
          notes: { orderId: lateOrder.id },
        },
      },
    },
  });
  const lateHookRes = await apiCall('/api/webhooks/razorpay', {
    method: 'POST',
    headers: { 'x-razorpay-signature': signPayload(lateHookPayload) },
    body: JSON.parse(lateHookPayload),
  });
  assert.strictEqual(lateHookRes.status, 200);

  // Late capture must NOT revive order, sets payment_status = REFUND_PENDING or triggers immediate REFUNDED, records escrow ledger
  const dbLateOrder = await pool.query(`SELECT payment_status, status FROM orders WHERE id = $1`, [lateOrder.id]);
  assert.strictEqual(dbLateOrder.rows[0].status, 'cancelled', 'Cancelled order must remain cancelled');
  assert.ok(
    dbLateOrder.rows[0].payment_status === 'REFUND_PENDING' || dbLateOrder.rows[0].payment_status === 'REFUNDED',
    `Payment status must be REFUND_PENDING or REFUNDED, got: ${dbLateOrder.rows[0].payment_status}`
  );

  // Escrow ledger entry must exist for late payment
  const lateLedger = await pool.query(
    `SELECT account_code, entry_side, amount FROM general_ledger_entries WHERE transaction_reference = $1`,
    [`TX_PAY_${lateOrder.id}`]
  );
  assert.strictEqual(lateLedger.rows.length, 2, 'Late payment must record balanced escrow entries (Dr 1010, Cr 2010)');

  console.log('✓ Section 3 Passed: Out-of-order failure protection and safe late-payment refund escalation verified.');

  // ===========================================================================
  // Section 4: Double-Entry Ledger Balancing, Unique Constraints & Atomic Rollback
  // ===========================================================================
  console.log('--- Section 4: Double-Entry Ledger Balancing & Rollback ---');

  // 1. Verify all posted general ledger entries have balanced debits and credits
  const ledgerBalanceRes = await pool.query(`
    SELECT journal_batch_id,
           SUM(CASE WHEN entry_side = 'DEBIT' THEN amount ELSE 0 END) AS total_debit,
           SUM(CASE WHEN entry_side = 'CREDIT' THEN amount ELSE 0 END) AS total_credit
    FROM general_ledger_entries
    GROUP BY journal_batch_id
  `);
  assert.ok(ledgerBalanceRes.rows.length > 0, 'Ledger entries must be present');
  for (const row of ledgerBalanceRes.rows) {
    const debit = parseFloat(row.total_debit);
    const credit = parseFloat(row.total_credit);
    assert.strictEqual(Math.abs(debit - credit) < 0.001, true, `Journal batch ${row.journal_batch_id} must balance. Dr: ${debit}, Cr: ${credit}`);
  }

  // 2. Duplicate ledger insertion rejection via database unique index
  const firstTxRef = `TX_PAY_${order1.id}`;
  let duplicateLedgerError = false;
  try {
    await pool.query(`
      INSERT INTO general_ledger_entries (
        journal_batch_id, transaction_reference, transaction_type,
        account_code, entry_side, amount, currency, order_id, narration
      )
      VALUES ($1, $2, 'CUSTOMER_PAYMENT', '1010', 'DEBIT', 500, 'INR', $3, 'Duplicate test')
    `, [crypto.randomUUID(), firstTxRef, order1.id]);
  } catch (err: any) {
    if (err.message.includes('unique constraint') || err.message.includes('duplicate key')) {
      duplicateLedgerError = true;
    }
  }
  assert.strictEqual(duplicateLedgerError, true, 'Database unique index uq_gl_ref_account_side must reject duplicate entries');

  // 3. Atomic transaction rollback test
  const rollbackOrder = await createOrder(tokenA);
  const rollbackTxId = `txn_rollback_${Date.now()}`;
  let rollbackCaught = false;

  try {
    await transaction(async (client) => {
      // Step A: update order
      await client.query(`UPDATE orders SET payment_status = 'PAID' WHERE id = $1`, [rollbackOrder.id]);
      // Step B: insert receipt
      await client.query(
        `INSERT INTO payment_receipts (order_id, transaction_id, amount, status, signature) VALUES ($1, $2, 100, 'SUCCESS', 'sig')`,
        [rollbackOrder.id, rollbackTxId]
      );
      // Step C: simulate crash/error before commit
      throw new Error('SIMULATED_TRANSACTION_FAILURE_BEFORE_COMMIT');
    });
  } catch (err: any) {
    if (err.message === 'SIMULATED_TRANSACTION_FAILURE_BEFORE_COMMIT') {
      rollbackCaught = true;
    }
  }
  assert.strictEqual(rollbackCaught, true);

  // Verify complete atomic rollback: order payment_status NOT PAID, receipt NOT present
  const checkOrder = await pool.query(`SELECT payment_status FROM orders WHERE id = $1`, [rollbackOrder.id]);
  assert.notStrictEqual(checkOrder.rows[0].payment_status, 'PAID', 'Order payment_status must roll back');
  const checkReceipt = await pool.query(`SELECT COUNT(*) FROM payment_receipts WHERE transaction_id = $1`, [rollbackTxId]);
  assert.strictEqual(parseInt(checkReceipt.rows[0].count, 10), 0, 'Payment receipt must roll back completely');

  console.log('✓ Section 4 Passed: Double-entry balancing, unique index constraint & atomic transaction rollback verified.');

  // ===========================================================================
  // Section 5: Unconfigured Gateway & Invalid Signature Rejection
  // ===========================================================================
  console.log('--- Section 5: Unconfigured Gateway & Tamper Resistance ---');

  // 1. Missing webhook signature strictly rejected with 400
  const missingSigRes = await apiCall('/api/webhooks/razorpay', {
    method: 'POST',
    body: { id: 'evt_1', event: 'payment.captured' },
  });
  assert.strictEqual(missingSigRes.status, 400);
  assert.strictEqual(missingSigRes.data.error, 'MISSING_WEBHOOK_SIGNATURE');

  // 2. Forged webhook signature strictly rejected with 400
  const forgedSigRes = await apiCall('/api/webhooks/razorpay', {
    method: 'POST',
    headers: { 'x-razorpay-signature': '0000000000000000000000000000000000000000000000000000000000000000' },
    body: { id: 'evt_2', event: 'payment.captured' },
  });
  assert.strictEqual(forgedSigRes.status, 400);
  assert.strictEqual(forgedSigRes.data.error, 'INVALID_WEBHOOK_SIGNATURE');

  // 3. Client amount tampering on verify strictly rejected with 400
  const tamperOrder = await createOrder(tokenA);
  const tamperIntent = await paymentService.createPaymentOrder(tamperOrder.id, userIdA);
  const tamperRes = await apiCall('/api/payment/verify', {
    method: 'POST',
    token: tokenA,
    body: {
      orderId: tamperOrder.id,
      transactionId: `txn_tamper_${Date.now()}`,
      timestamp: new Date(tamperIntent.timestamp).getTime(),
      signature: tamperIntent.signature,
      amount: 1.00, // Tampered amount (e.g. attempting to pay Rs 1 instead of actual total)
    },
  });
  assert.strictEqual(tamperRes.status, 400);
  assert.strictEqual(tamperRes.data.error, 'PAYMENT_AMOUNT_MISMATCH');

  console.log('✓ Section 5 Passed: Tamper-resistance and cryptographic signature enforcement verified.');

  // Cleanup server
  await new Promise<void>((resolve) => server.close(() => resolve()));

  console.log('================================================================================');
  console.log('  ALL SPRINT 15.1 PAYMENT IDEMPOTENCY & FINANCIAL INTEGRITY TESTS PASSED!');
  console.log('================================================================================\n');
}

if (process.argv[1]?.includes('sprint15-1-payment-idempotency-and-integrity.test')) {
  runSprint15_1PaymentIdempotencyAndIntegrityTests().catch((err) => {
    console.error('Sprint 15.1 tests failed:', err);
    process.exit(1);
  });
}
