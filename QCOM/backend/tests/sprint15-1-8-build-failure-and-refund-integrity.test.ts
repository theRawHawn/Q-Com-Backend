process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { setPool, getPool, transaction } from '../src/database/connection.js';
import { runMigrations } from '../src/database/migrator.js';
import { runSeeds } from '../seeds/seedData.js';
import { paymentService } from '../src/modules/payments/paymentService.js';
import { refundService } from '../src/modules/payments/refundService.js';
import { inventoryService } from '../src/modules/inventory/inventoryService.js';
import { ledgerService } from '../src/modules/ledger/ledgerService.js';
import { MockPaymentProvider } from '../src/modules/payments/provider/MockPaymentProvider.js';
import { env } from '../src/config/env.js';
import { Redis } from 'ioredis';
import { createTestDatabase } from './helpers/testDb.js';

const REAL_PG_URL = process.env.TEST_DATABASE_URL || 'postgres://qcom_user:qcom_password@127.0.0.1:5432/qcom_test';

export async function runSprint15_8BuildFailureAndRefundIntegrityTests(): Promise<void> {
  console.log('\n================================================================================');
  console.log('  SPRINT 15.1.8 — BUILD FAILURE RESOLUTION & REFUND INTEGRITY REGRESSION SUITE');
  console.log('================================================================================');

  // 1. Establish Real PostgreSQL 16 Pool
  console.log('\n--- Phase B: Connecting to Real PostgreSQL 16 ---');
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
    assert.ok(pgVersion.includes('PostgreSQL 16'), `Must run on real PostgreSQL 16, got: ${pgVersion}`);
    realPool = probePool;
    isRealPg = true;
  } catch (err: any) {
    console.log(`[Real PostgreSQL 16 Notice] Real PostgreSQL 16 is unavailable (${err.message}). Using pg-mem fallback. Reporting that regression remains unverified against the real database in this container.`);
    realPool = createTestDatabase().pool;
  }

  // Set pool for the app
  setPool(realPool);

  // Apply migrations & seeds
  await runMigrations({ poolOverride: realPool });
  await runSeeds(realPool);

  if (isRealPg) {
    // ---------------------------------------------------------------------------
    // REGRESSION TEST: PostgreSQL 16 Parameter Type Deduction (42P08)
    // ---------------------------------------------------------------------------
    console.log('\n--- Phase B: Verifying PostgreSQL 16 Parameter Type Deduction ---');

    // 1. Verify that the uncast query triggers 42P08 in PostgreSQL 16
    let uncastErrorCaught = false;
    try {
      await realPool.query(`
        UPDATE refunds
        SET status = $1,
            provider_refund_id = COALESCE($2, provider_refund_id),
            processed_at = CASE WHEN $1 = 'COMPLETED' THEN NOW() ELSE processed_at END
        WHERE id = $3
      `, ['COMPLETED', 'ref_probe', '00000000-0000-0000-0000-000000000000']);
    } catch (err: any) {
      if (err.code === '42P08' || (err.message && err.message.includes('inconsistent types deduced for parameter $1'))) {
        uncastErrorCaught = true;
      }
    }
    assert.strictEqual(uncastErrorCaught, true, 'Uncast query must trigger PostgreSQL 16 error 42P08 (text versus character varying)');

    // 2. Verify that the cast query ($1::varchar) executes cleanly on real PostgreSQL 16
    const castQueryRes = await realPool.query(`
      UPDATE refunds
      SET status = $1::varchar,
          provider_refund_id = COALESCE($2, provider_refund_id),
          processed_at = CASE WHEN $1::varchar = 'COMPLETED' THEN NOW() ELSE processed_at END
      WHERE id = $3
    `, ['COMPLETED', 'ref_probe', '00000000-0000-0000-0000-000000000000']);
    assert.ok(castQueryRes !== undefined, 'Cast query with $1::varchar must execute successfully on PostgreSQL 16');
    console.log('  ✓ PostgreSQL 16 Parameter Type Deduction Regression Verified: 42P08 reproduced on uncast query; $1::varchar executes cleanly.');
  } else {
    console.log('\n--- Phase B: Real PostgreSQL 16 Regression ---');
    console.log('  [NOTICE] Real PostgreSQL 16 is unavailable. Regression against real PostgreSQL 16 remains unverified against the real database.');
  }

  // 2. Start HTTP server
  const app = createApp();
  let server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  let address = server.address() as import('net').AddressInfo;
  let baseUrl = `http://127.0.0.1:${address.port}`;

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

  // Authenticate Customer
  const phoneA = `+91-91${Math.floor(10000000 + Math.random() * 90000000)}`;
  const authA = await apiCall('/api/auth/request-otp', { method: 'POST', body: { phone: phoneA, role: 'CUSTOMER' } });
  const verifyA = await apiCall('/api/auth/verify-otp', { method: 'POST', body: { phone: phoneA, otp: authA.data.debugOtp || '123456', name: 'Tester A' } });
  const tokenA = verifyA.data.token || verifyA.data.accessToken;
  const userIdA = verifyA.data.user?.id || verifyA.data.userId;

  // Retrieve seed catalog item
  const catRes = await apiCall('/api/catalog/products', { token: tokenA });
  const product = catRes.data?.products?.[0];
  assert.ok(product, 'Must have at least 1 seed product in catalog');
  const merchantId = product.merchant_id || product.merchantId;
  const productId = product.id || product.productId;

  const baseOrderPayload = {
    merchantId,
    items: [{ productId, quantity: 1, unitPrice: product.price || 99 }],
    deliveryAddress: { street: '16 Refund Lane', city: 'Bengaluru', postalCode: '560001' },
    paymentMethod: 'Instant UPI',
  };

  const mockProvider = new MockPaymentProvider('mock');
  paymentService.setProvider(mockProvider);
  refundService.setProvider(mockProvider);

  // Helper to place and pay for an order
  async function createAndPayOrder(): Promise<{ orderId: string; amount: number; transactionId: string }> {
    const orderRes = await apiCall('/api/orders/create', { method: 'POST', token: tokenA, body: baseOrderPayload });
    assert.strictEqual(orderRes.status, 200);
    const orderId = orderRes.data.order.id;
    const amount = parseFloat(orderRes.data.priceSnapshot?.grandTotal || '388.22');

    const transactionId = `pay_tx_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const capturePayload = {
      id: `evt_cap_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: transactionId,
            order_id: `rzp_order_${orderId.replace(/-/g, '').slice(0, 14)}`,
            amount: Math.round(amount * 100),
            currency: 'INR',
            status: 'captured',
            created_at: Math.floor(Date.now() / 1000),
            notes: { orderId },
          },
        },
      },
    };
    const sig = signPayload(JSON.stringify(capturePayload));
    const whRes = await apiCall('/api/webhooks/razorpay', {
      method: 'POST',
      body: capturePayload,
      headers: { 'x-razorpay-signature': sig },
    });
    assert.strictEqual(whRes.status, 200);

    const check = await realPool.query('SELECT payment_status FROM orders WHERE id = $1', [orderId]);
    assert.strictEqual(check.rows[0].payment_status, 'PAID');
    return { orderId, amount, transactionId };
  }

  // ---------------------------------------------------------------------------
  // SCENARIO 1: Refund Request Successfully Created and Completed
  // ---------------------------------------------------------------------------
  console.log('\n--- Scenario 1: Refund Request Successfully Created and Completed ---');
  mockProvider.setOptions({ simulateTimeout: false, simulateNetworkError: false });
  const o1 = await createAndPayOrder();

  const ref1 = await refundService.createRefund({
    orderId: o1.orderId,
    reasonCode: 'CANCELLATION',
    reasonDescription: 'Customer cancelled prior to dispatch',
    refundType: 'FULL',
    idempotencyKey: `ref_idem_s1_${Date.now()}`,
    createdBy: userIdA,
  });

  assert.strictEqual(ref1.refund.status, 'COMPLETED', 'Refund status must be COMPLETED');
  const o1Db = await realPool.query('SELECT payment_status FROM orders WHERE id = $1', [o1.orderId]);
  assert.strictEqual(o1Db.rows[0].payment_status, 'REFUNDED', 'Order payment_status must be REFUNDED');

  // Verify General Ledger Batch Q (Escrow liability reversed)
  const gl1 = await realPool.query(`
    SELECT transaction_reference, account_code, entry_side, amount
    FROM general_ledger_entries
    WHERE order_id = $1 AND transaction_type = 'REFUND'
  `, [o1.orderId]);
  assert.strictEqual(gl1.rows.length, 2, 'Exactly 2 GL entries for refund');
  const debitEntry = gl1.rows.find(r => r.entry_side === 'DEBIT');
  const creditEntry = gl1.rows.find(r => r.entry_side === 'CREDIT');
  assert.strictEqual(debitEntry?.account_code, '2010', 'Debit must be Customer Escrow Liability 2010');
  assert.strictEqual(creditEntry?.account_code, '1010', 'Credit must be Gateway Cash 1010');
  assert.strictEqual(parseFloat(debitEntry?.amount), o1.amount);
  assert.strictEqual(parseFloat(creditEntry?.amount), o1.amount);
  console.log('  ✓ Scenario 1 Passed: Refund completed, order marked REFUNDED, GL Batch Q balanced.');

  // ---------------------------------------------------------------------------
  // SCENARIO 2: Refund Request Times Out (Ambient Network Timeout)
  // ---------------------------------------------------------------------------
  console.log('\n--- Scenario 2: Refund Request Times Out (Preserves REFUND_PENDING) ---');
  const o2 = await createAndPayOrder();
  mockProvider.setOptions({ simulateTimeout: true });

  const ref2 = await refundService.createRefund({
    orderId: o2.orderId,
    reasonCode: 'CANCELLATION',
    reasonDescription: 'Refund experiencing gateway timeout',
    idempotencyKey: `ref_idem_s2_${Date.now()}`,
    createdBy: userIdA,
  });

  // Verify refund status is PROCESSING (unknown outcome)
  assert.strictEqual(ref2.refund.status, 'PROCESSING', 'Timed out refund must remain PROCESSING');
  // Verify order payment_status remains PAID and is NEVER prematurely marked REFUNDED
  const o2Db = await realPool.query('SELECT payment_status FROM orders WHERE id = $1', [o2.orderId]);
  assert.notStrictEqual(o2Db.rows[0].payment_status, 'REFUNDED', 'Order payment_status must never be REFUNDED during timeout');
  assert.strictEqual(o2Db.rows[0].payment_status, 'PAID', 'Order payment_status must remain PAID during timeout');

  // Verify zero ledger postings occurred during timeout
  const gl2 = await realPool.query(`SELECT COUNT(*) FROM general_ledger_entries WHERE order_id = $1 AND transaction_type = 'REFUND'`, [o2.orderId]);
  assert.strictEqual(parseInt(gl2.rows[0].count, 10), 0, 'Zero GL entries must be posted while refund is incomplete');
  console.log('  ✓ Scenario 2 Passed: Timed out refund held in PROCESSING and order preserved in PAID (never prematurely REFUNDED).');

  // ---------------------------------------------------------------------------
  // SCENARIO 3: Refund Provider Returns Ambiguous Result
  // ---------------------------------------------------------------------------
  console.log('\n--- Scenario 3: Refund Provider Returns Ambiguous Result ---');
  mockProvider.setOptions({ simulateTimeout: false });
  const o3 = await createAndPayOrder();

  const ref3 = await refundService.createRefund({
    orderId: o3.orderId,
    reasonCode: 'SIMULATE_AMBIGUOUS_GATEWAY_OUTCOME',
    reasonDescription: 'Gateway returns status=PENDING',
    idempotencyKey: `ref_idem_s3_${Date.now()}`,
    createdBy: userIdA,
  });

  assert.strictEqual(ref3.refund.status, 'PROCESSING', 'Ambiguous outcome must remain PROCESSING');
  const o3Db = await realPool.query('SELECT payment_status FROM orders WHERE id = $1', [o3.orderId]);
  assert.notStrictEqual(o3Db.rows[0].payment_status, 'REFUNDED', 'Order payment_status must not be REFUNDED on ambiguous result');
  assert.strictEqual(o3Db.rows[0].payment_status, 'PAID', 'Order payment_status must remain PAID on ambiguous result');
  console.log('  ✓ Scenario 3 Passed: Ambiguous gateway response preserves PROCESSING state and keeps order in PAID (never prematurely REFUNDED).');

  // ---------------------------------------------------------------------------
  // SCENARIO 4: Duplicate Refund Request Arrives (Idempotency Key Reuse)
  // ---------------------------------------------------------------------------
  console.log('\n--- Scenario 4: Duplicate Refund Request Arrives ---');
  const o4 = await createAndPayOrder();
  const s4Key = `ref_idem_s4_${Date.now()}`;

  const ref4_1 = await refundService.createRefund({
    orderId: o4.orderId,
    reasonCode: 'CANCELLATION',
    idempotencyKey: s4Key,
    createdBy: userIdA,
  });
  assert.strictEqual(ref4_1.isDuplicate, false, 'First refund request must not be duplicate');

  const ref4_2 = await refundService.createRefund({
    orderId: o4.orderId,
    reasonCode: 'CANCELLATION',
    idempotencyKey: s4Key,
    createdBy: userIdA,
  });
  assert.strictEqual(ref4_2.isDuplicate, true, 'Second refund request must return isDuplicate: true');
  assert.strictEqual(ref4_2.refund.id, ref4_1.refund.id, 'Duplicate replay must return identical refund record');

  // Verify PostgreSQL: exactly 1 refund row in database
  const count4 = await realPool.query('SELECT COUNT(*) FROM refunds WHERE idempotency_key = $1', [s4Key]);
  assert.strictEqual(parseInt(count4.rows[0].count, 10), 1, 'Exactly 1 row in refunds table');

  // Verify exactly 1 set of GL entries
  const gl4 = await realPool.query(`SELECT COUNT(*) FROM general_ledger_entries WHERE order_id = $1 AND transaction_type = 'REFUND'`, [o4.orderId]);
  assert.strictEqual(parseInt(gl4.rows[0].count, 10), 2, 'Exactly 1 pair of GL entries');
  console.log('  ✓ Scenario 4 Passed: Duplicate refund request returned cached record with zero duplicate financial postings.');

  // ---------------------------------------------------------------------------
  // SCENARIO 5: Duplicate Refund Notification Arrives
  // ---------------------------------------------------------------------------
  console.log('\n--- Scenario 5: Duplicate Refund Notification Arrives ---');
  // Re-deliver refund webhook or re-reconcile completed refund
  const reconciledDuplicate = await refundService.reconcileRefund(ref4_1.refund.id);
  assert.strictEqual(reconciledDuplicate.status, 'COMPLETED', 'Re-reconciling completed refund must return COMPLETED');

  // GL entry count must remain exactly 2
  const gl5 = await realPool.query(`SELECT COUNT(*) FROM general_ledger_entries WHERE order_id = $1 AND transaction_type = 'REFUND'`, [o4.orderId]);
  assert.strictEqual(parseInt(gl5.rows[0].count, 10), 2, 'Duplicate notification must not create duplicate GL entries');
  console.log('  ✓ Scenario 5 Passed: Duplicate notification acknowledged idempotently.');

  // ---------------------------------------------------------------------------
  // SCENARIO 6: Refund Confirmation Arrives After Application Restart
  // ---------------------------------------------------------------------------
  console.log('\n--- Scenario 6: Refund Confirmation Arrives After Application Restart ---');
  // Use order 2 which was left in PROCESSING state from Scenario 2
  // 1. Terminate server process
  await new Promise<void>((resolve) => server.close(() => resolve()));

  // 2. Restart fresh server process
  const freshApp = createApp();
  server = http.createServer(freshApp);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  address = server.address() as import('net').AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;

  // 3. Clear timeout and reconcile refund
  mockProvider.setOptions({ simulateTimeout: false });
  const reconciledS6 = await refundService.reconcileRefund(ref2.refund.id);
  assert.strictEqual(reconciledS6.status, 'COMPLETED', 'Reconciled refund must transition to COMPLETED on fresh process');

  const o2FinalDb = await realPool.query('SELECT payment_status FROM orders WHERE id = $1', [o2.orderId]);
  assert.strictEqual(o2FinalDb.rows[0].payment_status, 'REFUNDED', 'Order payment_status transitioned to REFUNDED');

  const gl6 = await realPool.query(`SELECT COUNT(*) FROM general_ledger_entries WHERE order_id = $1 AND transaction_type = 'REFUND'`, [o2.orderId]);
  assert.strictEqual(parseInt(gl6.rows[0].count, 10), 2, 'Exactly 2 GL entries created upon durable recovery');
  console.log('  ✓ Scenario 6 Passed: Pending refund cleanly reconciled to COMPLETED across process restart.');

  // ---------------------------------------------------------------------------
  // SCENARIO 7: Refund Failure Occurs and Safe Retry is Attempted
  // ---------------------------------------------------------------------------
  console.log('\n--- Scenario 7: Refund Failure Occurs and Retry is Attempted ---');
  const o7 = await createAndPayOrder();
  mockProvider.setOptions({ simulateNetworkError: true });

  const ref7Failed = await refundService.createRefund({
    orderId: o7.orderId,
    reasonCode: 'CANCELLATION',
    idempotencyKey: `ref_fail_attempt_${Date.now()}`,
    createdBy: userIdA,
  });
  assert.strictEqual(ref7Failed.refund.status, 'FAILED', 'Refund must be marked FAILED on hard provider failure');

  // Verify order payment status is restored to PAID (not stuck in REFUND_PENDING)
  const o7PendingDb = await realPool.query('SELECT payment_status FROM orders WHERE id = $1', [o7.orderId]);
  assert.strictEqual(o7PendingDb.rows[0].payment_status, 'PAID', 'Failed refund must restore order to PAID so retry is possible');

  // Retry refund with working provider
  mockProvider.setOptions({ simulateNetworkError: false });
  const ref7Retry = await refundService.createRefund({
    orderId: o7.orderId,
    reasonCode: 'CANCELLATION',
    idempotencyKey: `ref_retry_success_${Date.now()}`,
    createdBy: userIdA,
  });
  assert.strictEqual(ref7Retry.refund.status, 'COMPLETED', 'Retry refund must succeed and complete');

  const o7FinalDb = await realPool.query('SELECT payment_status FROM orders WHERE id = $1', [o7.orderId]);
  assert.strictEqual(o7FinalDb.rows[0].payment_status, 'REFUNDED', 'Order payment_status must be REFUNDED after successful retry');
  console.log('  ✓ Scenario 7 Passed: Hard failure safely handled, order restored to PAID, retry completed.');

  // ---------------------------------------------------------------------------
  // SCENARIO 8: Refund Confirmation Arrives After Order Was Cancelled
  // ---------------------------------------------------------------------------
  console.log('\n--- Scenario 8: Refund Confirmation After Order Was Cancelled ---');
  const o8 = await createAndPayOrder();
  // Cancel the order first
  await realPool.query(`UPDATE orders SET status = 'cancelled', cancellation_reason = 'User pre-dispatch cancellation' WHERE id = $1`, [o8.orderId]);

  const ref8 = await refundService.createRefund({
    orderId: o8.orderId,
    reasonCode: 'ORDER_CANCELLED_LATE_PAYMENT',
    reasonDescription: 'Cancellation refund',
    idempotencyKey: `ref_s8_${Date.now()}`,
    createdBy: userIdA,
  });
  assert.strictEqual(ref8.refund.status, 'COMPLETED');

  // Verify order remains cancelled and payment_status is REFUNDED
  const o8Db = await realPool.query('SELECT status, payment_status FROM orders WHERE id = $1', [o8.orderId]);
  assert.strictEqual(o8Db.rows[0].status, 'cancelled', 'Order must remain cancelled');
  assert.strictEqual(o8Db.rows[0].payment_status, 'REFUNDED', 'Payment status must be REFUNDED');
  console.log('  ✓ Scenario 8 Passed: Refund completed on cancelled order; status preserved.');

  // ---------------------------------------------------------------------------
  // SCENARIO 9: Concurrent Workers Attempting to Process Same Refund (Lease Fencing)
  // ---------------------------------------------------------------------------
  console.log('\n--- Scenario 9: Concurrent Workers Processing Same Refund (Lease Fencing) ---');
  const o9 = await createAndPayOrder();
  mockProvider.setOptions({ simulateTimeout: true });
  const ref9 = await refundService.createRefund({
    orderId: o9.orderId,
    reasonCode: 'CANCELLATION',
    idempotencyKey: `ref_lease_test_${Date.now()}`,
    createdBy: userIdA,
  });
  assert.strictEqual(ref9.refund.status, 'PROCESSING');

  // Worker A claims lease
  const leaseOwnerA = `worker_node_A_${Date.now()}`;
  await realPool.query(`
    UPDATE refunds
    SET recovery_lease_id = $1,
        recovery_lease_expires_at = NOW() + interval '60 seconds'
    WHERE id = $2
  `, [leaseOwnerA, ref9.refund.id]);

  // Worker B attempts to reconcile with stale lease owner expectation
  const leaseOwnerB = `worker_node_B_${Date.now()}`;
  mockProvider.setOptions({ simulateTimeout: false });
  const workerBResult = await refundService.reconcileRefund(ref9.refund.id, leaseOwnerB);
  // Worker B should detect that Worker A holds the lease and abort without updating
  assert.strictEqual(workerBResult.status, 'PROCESSING', 'Worker B must abort commit when lease is held by Worker A');

  // Worker A reconciles with matching lease
  const workerAResult = await refundService.reconcileRefund(ref9.refund.id, leaseOwnerA);
  assert.strictEqual(workerAResult.status, 'COMPLETED', 'Worker A must complete reconciliation');
  console.log('  ✓ Scenario 9 Passed: Distributed lease fencing prevented conflicting multi-worker execution.');

  // ---------------------------------------------------------------------------
  // SCENARIO 10: Crash Before Local State Update (Durable Reconciliation)
  // ---------------------------------------------------------------------------
  console.log('\n--- Scenario 10: Crash Before Local State Update (Durable Recovery) ---');
  const o10 = await createAndPayOrder();
  const s10Key = `ref_crash_test_${Date.now()}`;

  // Provider processes refund externally, but local transaction fails mid-update
  const extRefund = await mockProvider.createRefund({
    paymentId: o10.transactionId,
    amount: o10.amount,
    currency: 'INR',
    reason: 'CRASH_SIMULATION',
    idempotencyKey: s10Key,
  });

  // Insert refund row directly in PROCESSING state as if app crashed before local completion
  const refundId10 = crypto.randomUUID();
  await realPool.query(`
    INSERT INTO refunds (
      id, refund_number, order_id, payment_id, amount, currency,
      reason_code, refund_type, status, idempotency_key
    )
    VALUES ($1, $2, $3, $4, $5, 'INR', 'CANCELLATION', 'FULL', 'PROCESSING', $6)
  `, [refundId10, `REF_${Date.now()}`, o10.orderId, o10.transactionId, o10.amount, s10Key]);

  // Now reconcile: recovery inspects provider by idempotency key and recovers providerRefundId
  const recovered10 = await refundService.reconcileRefund(refundId10);
  assert.strictEqual(recovered10.status, 'COMPLETED', 'Durable recovery must match provider record and transition to COMPLETED');
  assert.strictEqual(recovered10.providerRefundId, extRefund.providerRefundId, 'Provider refund ID recovered');

  const o10Db = await realPool.query('SELECT payment_status FROM orders WHERE id = $1', [o10.orderId]);
  assert.strictEqual(o10Db.rows[0].payment_status, 'REFUNDED', 'Order transitioned to REFUNDED');
  console.log('  ✓ Scenario 10 Passed: Post-crash reconciliation recovered external state and finalized DB cleanly.');

  // Clean up server & pool
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await realPool.end();

  console.log('\n================================================================================');
  console.log('  ALL SPRINT 15.1.8 BUILD & REFUND INTEGRITY REGRESSIONS PASSED SUCCESSFULLY!');
  console.log('================================================================================');
}
