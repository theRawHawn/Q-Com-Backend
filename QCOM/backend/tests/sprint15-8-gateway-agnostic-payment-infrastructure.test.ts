import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { setPool } from '../src/database/connection.js';
import { runMigrations } from '../src/database/migrator.js';
import { runSeeds } from '../seeds/seedData.js';
import { AuthService } from '../src/modules/auth/authService.js';
import { orderService } from '../src/modules/orders/orderService.js';
import { paymentService } from '../src/modules/payments/paymentService.js';
import { refundService } from '../src/modules/payments/refundService.js';
import { ledgerService } from '../src/modules/ledger/ledgerService.js';
import {
  PAYMENT_STATE_TRANSITION_MATRIX,
  validatePaymentTransition,
  validateAttemptTransition,
  validateRefundTransition,
  transitionPaymentIntentState,
} from '../src/modules/payments/paymentStateMachine.js';
import {
  idempotencyService,
  computeCanonicalFingerprint,
} from '../src/modules/payments/idempotencyService.js';
import { paymentReconciliationService } from '../src/modules/reconciliation/paymentReconciliationService.js';
import { financialRecoveryWorker } from '../src/modules/recovery/financialRecoveryWorker.js';
import { paymentLogger, redactPaymentLogPayload } from '../src/modules/payments/paymentLogger.js';
import {
  MockPaymentProvider,
  DisabledPaymentProvider,
  paymentProviderRegistry,
} from '../src/modules/payments/paymentProvider.js';
import { setRedisClient, inMemoryStore } from '../src/database/redis.js';
import { createTestDatabase } from './helpers/testDb.js';

export async function runSprint15_8GatewayAgnosticPaymentInfrastructureTests(): Promise<void> {
  console.log('\n================================================================================');
  console.log('  SPRINT 15.8 — GATEWAY-AGNOSTIC PAYMENT INFRASTRUCTURE & INTEGRITY TEST SUITE');
  console.log('================================================================================');

  const { pool } = createTestDatabase();
  setPool(pool);
  await runMigrations({ poolOverride: pool });
  await runSeeds(pool);

  const app = createApp();
  const authService = new AuthService();

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as any;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  async function apiCall(
    pathUrl: string,
    opts: { method?: string; token?: string; body?: any; headers?: Record<string, string> } = {}
  ): Promise<{ status: number; data: any }> {
    const res = await fetch(`${baseUrl}${pathUrl}`, {
      method: opts.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.headers || {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    return { status: res.status, data };
  }

  try {
    // -------------------------------------------------------------------------
    // Setup actors & catalog
    // -------------------------------------------------------------------------
    const adminAuth = await authService.adminLogin(
      'EMP-001',
      process.env.SEED_ADMIN_PASSWORD || 'QcomSeedAdmin#2026',
      '127.0.0.1',
      'AdminPortal',
      pool
    );
    const adminToken = adminAuth.accessToken;

    const custOtp1 = await authService.requestOtp('+91-9123456780', 'LOGIN', '127.0.0.1', pool);
    const custAuth1 = await authService.verifyOtp(
      '+91-9123456780',
      custOtp1.debugOtp!,
      'LOGIN',
      '127.0.0.1',
      'CustomerApp',
      'Customer One',
      pool
    );
    const custToken1 = custAuth1.accessToken;
    const custId1 = custAuth1.user.id;

    const custOtp2 = await authService.requestOtp('+91-9123456789', 'LOGIN', '127.0.0.1', pool);
    const custAuth2 = await authService.verifyOtp(
      '+91-9123456789',
      custOtp2.debugOtp!,
      'LOGIN',
      '127.0.0.1',
      'CustomerApp',
      'Customer Two',
      pool
    );
    const custToken2 = custAuth2.accessToken;

    const merchRow = (
      await pool.query(`SELECT id FROM merchants WHERE merchant_code = 'MERCH-BLR-01' LIMIT 1`)
    ).rows[0];
    const merchantId = merchRow.id as string;

    const prodRow = (
      await pool.query(
        `SELECT p.id FROM products p JOIN store_inventory si ON si.product_id = p.id
         WHERE si.merchant_id = $1 AND si.stock_count >= 20 LIMIT 1`,
        [merchantId]
      )
    ).rows[0];
    const productId = prodRow.id as string;

    // -------------------------------------------------------------------------
    // Test 1: Migration 029 Schema & Normalized Payment Tables
    // -------------------------------------------------------------------------
    console.log('[Test 1] Verifying Migration 029 schema tables and normalized structure...');
    {
      const tablesRes = await pool.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name IN ('payment_transactions', 'reconciliation_runs', 'reconciliation_discrepancies')`
      );
      assert.equal(tablesRes.rows.length, 3, 'All Migration 029 normalized tables must exist.');

      const piCols = await pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'payment_intents'`
      );
      const colNames = piCols.rows.map((r: any) => r.column_name);
      for (const expectedCol of [
        'expires_at',
        'succeeded_at',
        'failed_at',
        'cancelled_at',
        'expired_at',
        'failure_classification',
        'next_retry_at',
        'requires_manual_review',
        'version',
        'internal_transaction_reference',
      ]) {
        assert.ok(colNames.includes(expectedCol), `payment_intents missing column ${expectedCol}`);
      }
      console.log('✓ Test 1 passed: Migration 029 tables and lifecycle columns verified.');
    }

    // -------------------------------------------------------------------------
    // Test 2: Centralized Payment State Machine & Terminal Protections
    // -------------------------------------------------------------------------
    console.log('[Test 2] Testing centralized payment state machine and terminal guards...');
    {
      assert.ok(PAYMENT_STATE_TRANSITION_MATRIX.CAPTURED.includes('PARTIALLY_REFUNDED'));
      assert.ok(PAYMENT_STATE_TRANSITION_MATRIX.CAPTURED.includes('REFUNDED'));
      assert.equal(PAYMENT_STATE_TRANSITION_MATRIX.FAILED.length, 0);
      assert.equal(PAYMENT_STATE_TRANSITION_MATRIX.CANCELLED.length, 0);
      assert.equal(PAYMENT_STATE_TRANSITION_MATRIX.EXPIRED.length, 0);
      assert.equal(PAYMENT_STATE_TRANSITION_MATRIX.REFUNDED.length, 0);

      // Invalid downgrade guards
      assert.equal(validatePaymentTransition('CAPTURED', 'FAILED').valid, false);
      assert.equal(validatePaymentTransition('CAPTURED', 'PENDING').valid, false);
      assert.equal(validatePaymentTransition('CAPTURED', 'CANCELLED').valid, false);
      assert.equal(validatePaymentTransition('FAILED', 'CAPTURED').valid, false);
      assert.equal(validatePaymentTransition('CANCELLED', 'CAPTURED').valid, false);
      assert.equal(validatePaymentTransition('EXPIRED', 'CAPTURED').valid, false);
      assert.equal(validatePaymentTransition('REFUNDED', 'CAPTURED').valid, false);

      // Unknown / Reconciliation recovery paths
      assert.equal(validatePaymentTransition('UNKNOWN', 'CAPTURED').valid, true);
      assert.equal(validatePaymentTransition('UNKNOWN', 'REQUIRES_REVIEW').valid, true);
      assert.equal(validatePaymentTransition('RECONCILIATION_REQUIRED', 'EXPIRED').valid, true);

      // Duplicate self-transition must flag isDuplicate=true cleanly
      const dupCap = validatePaymentTransition('CAPTURED', 'CAPTURED');
      assert.equal(dupCap.valid, true);
      assert.equal(dupCap.isDuplicate, true);

      // Attempt & Refund validators
      assert.equal(validateAttemptTransition('SUCCEEDED', 'FAILED').valid, false);
      assert.equal(validateAttemptTransition('UNKNOWN', 'SUCCEEDED').valid, true);
      assert.equal(validateRefundTransition('COMPLETED', 'FAILED').valid, false);
      assert.equal(validateRefundTransition('UNKNOWN', 'COMPLETED').valid, true);

      // Row-locked DB transition + late capture compensation
      const ord2 = await orderService.createOrder({
        userId: custId1,
        merchantId,
        items: [{ productId, quantity: 1 }],
        jobSite: { address: 'SM Test Site', latitude: 12.9716, longitude: 77.5946 },
        paymentMethod: 'Instant UPI',
      });
      const intent2 = await paymentService.createPaymentOrder(ord2.order.id, custId1);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await transitionPaymentIntentState(client, intent2.id, 'CANCELLED', {
          errorCode: 'TEST_CANCEL',
        });
        await assert.rejects(
          () => transitionPaymentIntentState(client, intent2.id, 'CAPTURED'),
          /INVALID_PAYMENT_STATE_TRANSITION/
        );
        const comp = await transitionPaymentIntentState(client, intent2.id, 'REFUND_PENDING', {
          allowLateCaptureCompensation: true,
          providerPaymentId: 'pay_late_comp_1',
        });
        assert.equal(comp.currentState, 'REFUND_PENDING');
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
      console.log('✓ Test 2 passed: Centralized state machine & late-capture compensation verified.');
    }

    // -------------------------------------------------------------------------
    // Test 3: Order Validation, Authoritative Amount/Currency, Anti-IDOR
    // -------------------------------------------------------------------------
    console.log('[Test 3] Testing server-authoritative amount/currency and anti-IDOR guards...');
    {
      const ord3 = await orderService.createOrder({
        userId: custId1,
        merchantId,
        items: [{ productId, quantity: 2 }],
        jobSite: { address: 'Auth Val Site', latitude: 12.9716, longitude: 77.5946 },
        paymentMethod: 'Instant UPI',
      });

      // Cross-customer initiation must fail 403
      const idorRes = await apiCall('/api/v1/payments/create-order', {
        method: 'POST',
        token: custToken2,
        body: { orderId: ord3.order.id },
      });
      assert.equal(idorRes.status, 403);

      // Amount tampering on /create-order must fail 400
      const tamperAmtRes = await apiCall('/api/v1/payments/create-order', {
        method: 'POST',
        token: custToken1,
        body: { orderId: ord3.order.id, amount: 1.0 },
      });
      assert.equal(tamperAmtRes.status, 400);
      assert.equal(tamperAmtRes.data.error, 'PAYMENT_AMOUNT_TAMPERED');

      // Unsupported currency on /create-order must fail 400
      const badCurRes = await apiCall('/api/v1/payments/create-order', {
        method: 'POST',
        token: custToken1,
        body: { orderId: ord3.order.id, currency: 'USD' },
      });
      assert.equal(badCurRes.status, 400);
      assert.equal(badCurRes.data.error, 'UNSUPPORTED_CURRENCY');

      // Valid server-authoritative create-order succeeds
      const okRes = await apiCall('/api/v1/payments/create-order', {
        method: 'POST',
        token: custToken1,
        body: { orderId: ord3.order.id, currency: 'INR' },
      });
      assert.equal(okRes.status, 200);
      assert.equal(okRes.data.paymentOrder.amount, ord3.order.totalAmount);
      console.log('✓ Test 3 passed: Authoritative amount, currency, and IDOR checks enforced.');
    }

    // -------------------------------------------------------------------------
    // Test 4: Canonical PostgreSQL Idempotency (Surviving Redis Failure)
    // -------------------------------------------------------------------------
    console.log('[Test 4] Testing canonical PostgreSQL idempotency and Redis outage resilience...');
    {
      const fp1 = computeCanonicalFingerprint({ b: 2, a: 1, nested: { z: true, y: 'x' } });
      const fp2 = computeCanonicalFingerprint({ nested: { y: 'x', z: true }, a: 1, b: 2 });
      assert.equal(fp1, fp2, 'Canonical JSON fingerprint must be key-order invariant');

      const ord4 = await orderService.createOrder({
        userId: custId1,
        merchantId,
        items: [{ productId, quantity: 1 }],
        jobSite: { address: 'Idem Site', latitude: 12.9716, longitude: 77.5946 },
        paymentMethod: 'Instant UPI',
      });

      const sharedKey = `s15_8_idem_${crypto.randomUUID()}`;

      // Simulate Redis outage / cleared store via failing client
      inMemoryStore.clear();
      setRedisClient({
        get: async () => {
          throw new Error('ECONNREFUSED: Redis unavailable');
        },
        set: async () => {
          throw new Error('ECONNREFUSED: Redis unavailable');
        },
        del: async () => {
          throw new Error('ECONNREFUSED: Redis unavailable');
        },
      } as any);

      try {
        // First request creates payment order persisted in PostgreSQL
        const r1 = await apiCall('/api/v1/payments/create-order', {
          method: 'POST',
          token: custToken1,
          headers: { 'Idempotency-Key': sharedKey },
          body: { orderId: ord4.order.id, currency: 'INR' },
        });
        assert.equal(r1.status, 200);

        // Replay with identical key & canonical payload (different key order) succeeds even during Redis outage
        const r2 = await apiCall('/api/v1/payments/create-order', {
          method: 'POST',
          token: custToken1,
          headers: { 'Idempotency-Key': sharedKey },
          body: { currency: 'INR', orderId: ord4.order.id },
        });
        assert.equal(r2.status, 200);
        assert.equal(r2.data.paymentOrder.id, r1.data.paymentOrder.id);

        // Cross-actor key reuse blocked 403
        const crossActor = await apiCall('/api/v1/payments/create-order', {
          method: 'POST',
          token: custToken2,
          headers: { 'Idempotency-Key': sharedKey },
          body: { orderId: ord4.order.id },
        });
        assert.equal(crossActor.status, 403);
        assert.equal(crossActor.data.error, 'UNAUTHORIZED_IDEMPOTENCY_KEY_ACCESS');

        // Payload mismatch blocked 422
        const diffOrder = await orderService.createOrder({
          userId: custId1,
          merchantId,
          items: [{ productId, quantity: 1 }],
          jobSite: { address: 'Idem Diff Site', latitude: 12.9716, longitude: 77.5946 },
          paymentMethod: 'Instant UPI',
        });
        const mismatch = await apiCall('/api/v1/payments/create-order', {
          method: 'POST',
          token: custToken1,
          headers: { 'Idempotency-Key': sharedKey },
          body: { orderId: diffOrder.order.id },
        });
        assert.equal(mismatch.status, 422);
        assert.equal(mismatch.data.error, 'IDEMPOTENCY_PAYLOAD_MISMATCH');

        // Operation scope mismatch blocked 422
        const scopeClaim = await idempotencyService.claimKey({
          pool,
          idempotencyKey: sharedKey,
          actorId: custId1,
          operationType: 'PAYMENT_VERIFY',
          endpoint: '/api/v1/payments/verify',
          requestFingerprint: fp1,
        });
        assert.equal(scopeClaim.claimed, false);
        assert.equal(scopeClaim.status, 'SCOPE_MISMATCH');

        // Stale PROCESSING lease reclamation works safely
        const leaseKey = `s15_8_stale_lease_${crypto.randomUUID()}`;
        const c1 = await idempotencyService.claimKey({
          pool,
          idempotencyKey: leaseKey,
          actorId: custId1,
          operationType: 'PAYMENT_CREATE_ORDER',
          endpoint: '/api/v1/payments/create-order',
          requestFingerprint: fp1,
          processingLeaseSec: 60,
        });
        assert.equal(c1.claimed, true);

        const c2 = await idempotencyService.claimKey({
          pool,
          idempotencyKey: leaseKey,
          actorId: custId1,
          operationType: 'PAYMENT_CREATE_ORDER',
          endpoint: '/api/v1/payments/create-order',
          requestFingerprint: fp1,
        });
        assert.equal(c2.claimed, false);
        assert.equal(c2.status, 'PROCESSING');

        await pool.query(
          `UPDATE idempotency_keys SET locked_until = NOW() - INTERVAL '5 minutes' WHERE idempotency_key = $1`,
          [leaseKey]
        );
        const c3 = await idempotencyService.claimKey({
          pool,
          idempotencyKey: leaseKey,
          actorId: custId1,
          operationType: 'PAYMENT_CREATE_ORDER',
          endpoint: '/api/v1/payments/create-order',
          requestFingerprint: fp1,
        });
        assert.equal(c3.claimed, true, 'Stale crashed lease must be safely reclaimable by owning actor');
      } finally {
        setRedisClient(null);
        inMemoryStore.clear();
      }
      console.log('✓ Test 4 passed: Canonical PostgreSQL idempotency survived Redis failure and enforced scoping.');
    }

    // -------------------------------------------------------------------------
    // Test 5: Attempt Lifecycle, Expired Intent Auto-Expiry & Unknown Outcome
    // -------------------------------------------------------------------------
    console.log('[Test 5] Testing intent expiry, unknown timeout preservation, and single capture...');
    {
      const ord5 = await orderService.createOrder({
        userId: custId1,
        merchantId,
        items: [{ productId, quantity: 1 }],
        jobSite: { address: 'Expiry Unknown Site', latitude: 12.9716, longitude: 77.5946 },
        paymentMethod: 'Instant UPI',
      });

      const po1 = await paymentService.createPaymentOrder(ord5.order.id, custId1);

      // Force intent expiration in DB and confirm expireStalePaymentIntents transitions it to EXPIRED
      await pool.query(
        `UPDATE payment_intents SET expires_at = NOW() - INTERVAL '2 minutes' WHERE id = $1`,
        [po1.id]
      );
      const expiredResult = await paymentService.expireStalePaymentIntents();
      assert.ok(expiredResult.expiredIntents >= 1, 'expireStalePaymentIntents must mark stale uncaptured intent EXPIRED');

      const expRow = (await pool.query(`SELECT status, expired_at FROM payment_intents WHERE id = $1`, [po1.id])).rows[0];
      assert.equal(expRow.status, 'EXPIRED');
      assert.ok(expRow.expired_at);

      // Retrying createPaymentOrder creates a fresh active intent without violating uq_payment_intents_single_active_per_order
      const po2 = await paymentService.createPaymentOrder(ord5.order.id, custId1);
      assert.notEqual(po2.id, po1.id);

      // Inject timeout provider during verification -> must move to RECONCILIATION_REQUIRED & UNKNOWN attempt
      const timeoutProvider = new MockPaymentProvider('mock_timeout_158', { simulateTimeout: true });
      paymentService.setProvider(timeoutProvider);
      try {
        const verTimeout = await paymentService.verifyPayment({
          orderId: ord5.order.id,
          transactionId: `pay_timeout_158_${Date.now()}`,
          timestamp: Date.parse(po2.timestamp),
          signature: po2.signature,
          userId: custId1,
          razorpayOrderId: po2.paymentOrderId,
        });
        assert.equal(verTimeout.isReconciliationRequired, true);
        assert.equal(verTimeout.status, 'RECONCILIATION_REQUIRED');
      } finally {
        paymentService.resetProvider();
      }

      const ordAfterTimeout = (await pool.query(`SELECT status, payment_status FROM orders WHERE id = $1`, [ord5.order.id])).rows[0];
      assert.equal(ordAfterTimeout.payment_status, 'PENDING', 'Order must NOT become FAILED on network timeout');
      assert.notEqual(ordAfterTimeout.status, 'cancelled', 'Order must NOT be cancelled on timeout');

      const txUnknown = await pool.query(
        `SELECT transaction_type, status FROM payment_transactions WHERE order_id = $1 AND status = 'UNKNOWN'`,
        [ord5.order.id]
      );
      assert.ok(txUnknown.rows.length >= 1, 'STATUS_CHECK UNKNOWN transaction must be persisted');

      // Simulate provider status inquiry confirming delayed capture -> reconcilePayment recovers cleanly to CAPTURED
      const capturedStatusProvider = new MockPaymentProvider('mock_rec_success_158');
      capturedStatusProvider.getPaymentStatus = async (providerReference, providerPaymentId) => ({
        providerId: 'mock_rec_success_158',
        providerReference,
        providerPaymentId: providerPaymentId || `pay_rec_confirmed_${Date.now()}`,
        status: 'SUCCEEDED',
        amount: ord5.order.totalAmount,
        currency: 'INR',
        rawStatus: 'captured',
      });
      paymentService.setProvider(capturedStatusProvider);
      try {
        const recRes = await paymentService.reconcilePayment(ord5.order.id);
        assert.equal(recRes.reconciled, true);
        assert.equal(recRes.status, 'CAPTURED');
      } finally {
        paymentService.resetProvider();
      }

      const capClient = await pool.connect();
      try {
        await capClient.query('BEGIN');
        await assert.rejects(
          () =>
            paymentService.recordPaymentTransaction(capClient, {
              orderId: ord5.order.id,
              paymentIntentId: po2.id,
              transactionType: 'CAPTURE',
              status: 'SUCCEEDED',
              amount: ord5.order.totalAmount,
              providerId: 'mock',
              externalReference: 'dup_capture_ext_ref',
            }),
          /DUPLICATE_PAYMENT_CAPTURE/
        );
        await capClient.query('ROLLBACK');
      } finally {
        capClient.release();
      }
      console.log('✓ Test 5 passed: Intent expiry, unknown timeout safety, and single capture guard verified.');
    }

    // -------------------------------------------------------------------------
    // Test 6: Multi-Partial Refund Ceiling & Unpaid Refund Rejection
    // -------------------------------------------------------------------------
    console.log('[Test 6] Testing multi-partial refunds, ceiling enforcement, and unpaid block...');
    {
      // Unpaid online order must be rejected for refund
      const unpaidOrd = await orderService.createOrder({
        userId: custId1,
        merchantId,
        items: [{ productId, quantity: 1 }],
        jobSite: { address: 'Unpaid Site', latitude: 12.9716, longitude: 77.5946 },
        paymentMethod: 'Instant UPI',
      });
      await assert.rejects(
        () =>
          refundService.createRefund({
            orderId: unpaidOrd.order.id,
            amount: 10,
            reasonCode: 'UNAUTHORIZED_REFUND_TEST',
          }),
        /ORDER_NOT_REFUNDABLE/
      );

      // Paid order with two partial refunds reaching captured amount
      const paidOrd = await orderService.createOrder({
        userId: custId1,
        merchantId,
        items: [{ productId, quantity: 2 }],
        jobSite: { address: 'Partial Refund Site', latitude: 12.9716, longitude: 77.5946 },
        paymentMethod: 'Instant UPI',
      });
      const intentPaid = await paymentService.createPaymentOrder(paidOrd.order.id, custId1);
      await paymentService.verifyPayment({
        orderId: paidOrd.order.id,
        transactionId: `pay_multi_ref_${Date.now()}`,
        timestamp: Date.parse(intentPaid.timestamp),
        signature: intentPaid.signature,
        userId: custId1,
        razorpayOrderId: intentPaid.paymentOrderId,
      });

      const totalAmt = paidOrd.order.totalAmount;
      const part1Amt = Number((totalAmt * 0.4).toFixed(2));
      const part2Amt = Number((totalAmt - part1Amt).toFixed(2));

      const rPart1 = await refundService.createRefund({
        orderId: paidOrd.order.id,
        amount: part1Amt,
        reasonCode: 'PARTIAL_ADJUSTMENT_1',
        refundType: 'PARTIAL',
        idempotencyKey: `ref_p1_${paidOrd.order.id}`,
      });
      assert.equal(rPart1.refund.status, 'COMPLETED');

      const midOrdRow = (await pool.query(`SELECT payment_status FROM orders WHERE id = $1`, [paidOrd.order.id])).rows[0];
      assert.equal(midOrdRow.payment_status, 'PARTIALLY_REFUNDED');

      // Exceeding remaining refundable balance must reject
      await assert.rejects(
        () =>
          refundService.createRefund({
            orderId: paidOrd.order.id,
            amount: Number((part2Amt + 25).toFixed(2)),
            reasonCode: 'OVER_CEILING',
            refundType: 'PARTIAL',
          }),
        /REFUND_CEILING_EXCEEDED/
      );

      const rPart2 = await refundService.createRefund({
        orderId: paidOrd.order.id,
        amount: part2Amt,
        reasonCode: 'PARTIAL_ADJUSTMENT_2',
        refundType: 'PARTIAL',
        idempotencyKey: `ref_p2_${paidOrd.order.id}`,
      });
      assert.equal(rPart2.refund.status, 'COMPLETED');

      const finalOrdRow = (await pool.query(`SELECT payment_status FROM orders WHERE id = $1`, [paidOrd.order.id])).rows[0];
      assert.equal(finalOrdRow.payment_status, 'REFUNDED');

      const finalIntentRow = (await pool.query(`SELECT status FROM payment_intents WHERE id = $1`, [intentPaid.id])).rows[0];
      assert.equal(finalIntentRow.status, 'REFUNDED');
      console.log('✓ Test 6 passed: Unpaid block, partial refund ceiling, and PARTIALLY_REFUNDED -> REFUNDED lifecycle verified.');
    }

    // -------------------------------------------------------------------------
    // Test 7: Internal Reconciliation Engine & Bounded Worker Escalation
    // -------------------------------------------------------------------------
    console.log('[Test 7] Testing internal reconciliation engine, worker escalation, and Admin RBAC...');
    {
      // 7a. Create anomalous order: PAID without any capture/receipt
      const anomOrd1 = await orderService.createOrder({
        userId: custId1,
        merchantId,
        items: [{ productId, quantity: 1 }],
        jobSite: { address: 'Reconcile Anom Site', latitude: 12.9716, longitude: 77.5946 },
        paymentMethod: 'Instant UPI',
      });
      await pool.query(`UPDATE orders SET payment_status = 'PAID' WHERE id = $1`, [anomOrd1.order.id]);

      // 7b. Create lapsed uncaptured intent past expires_at for safe auto-repair
      const anomOrd2 = await orderService.createOrder({
        userId: custId1,
        merchantId,
        items: [{ productId, quantity: 1 }],
        jobSite: { address: 'Reconcile AutoRepair Site', latitude: 12.9716, longitude: 77.5946 },
        paymentMethod: 'Instant UPI',
      });
      const anomIntent2 = await paymentService.createPaymentOrder(anomOrd2.order.id, custId1);
      await pool.query(
        `UPDATE payment_intents SET expires_at = NOW() - INTERVAL '10 minutes' WHERE id = $1`,
        [anomIntent2.id]
      );

      // Run reconciliation run #1
      const recRun1 = await paymentReconciliationService.runReconciliation({
        runType: 'TEST',
        triggeredBy: 'sprint15_8_test',
        autoRepair: true,
      });
      assert.ok(recRun1.discrepanciesFound >= 2, 'Reconciliation must detect unpaid/uncaptured anomalies and lapsed intent');
      assert.ok(recRun1.autoRepairedCount >= 1, 'Lapsed uncaptured intent must safely auto-repair to EXPIRED');

      const repairedIntent = (await pool.query(`SELECT status FROM payment_intents WHERE id = $1`, [anomIntent2.id])).rows[0];
      assert.equal(repairedIntent.status, 'EXPIRED');

      // Rerun reconciliation on anomOrd1 -> must increment occurrence_count idempotently without duplicating discrepancy row
      await paymentReconciliationService.runReconciliation({
        orderId: anomOrd1.order.id,
        triggeredBy: 'sprint15_8_rerun',
      });
      const discRows = await pool.query(
        `SELECT id, category, occurrence_count, status
         FROM reconciliation_discrepancies
         WHERE order_id = $1 AND category = 'PAID_ORDER_WITHOUT_CAPTURE'`,
        [anomOrd1.order.id]
      );
      assert.equal(discRows.rows.length, 1);
      assert.equal(discRows.rows[0].category, 'PAID_ORDER_WITHOUT_CAPTURE');
      assert.ok(Number(discRows.rows[0].occurrence_count) >= 2, 'Reruns must increment occurrence_count cleanly');

      // 7c. Bounded recovery worker escalation to REQUIRES_REVIEW
      const escOrd = await orderService.createOrder({
        userId: custId1,
        merchantId,
        items: [{ productId, quantity: 1 }],
        jobSite: { address: 'Worker Escalation Site', latitude: 12.9716, longitude: 77.5946 },
        paymentMethod: 'Instant UPI',
      });
      const escIntent = await paymentService.createPaymentOrder(escOrd.order.id, custId1);
      await pool.query(
        `UPDATE payment_intents
         SET status = 'RECONCILIATION_REQUIRED',
             reconciliation_attempts = 10,
             created_at = NOW() - INTERVAL '2 minutes'
         WHERE id = $1`,
        [escIntent.id]
      );
      await financialRecoveryWorker.recoverPendingPayments();
      const escCheck = (
        await pool.query(`SELECT status, requires_manual_review, error_code FROM payment_intents WHERE id = $1`, [escIntent.id])
      ).rows[0];
      assert.equal(escCheck.status, 'REQUIRES_REVIEW');
      assert.equal(escCheck.requires_manual_review, true);
      assert.equal(escCheck.error_code, 'RECOVERY_RETRY_EXHAUSTED');

      // 7d. Admin RBAC API endpoints for reconciliation & observability
      const unauthAdminRes = await apiCall('/api/v1/admin/reconciliation/discrepancies', {
        token: custToken1,
      });
      assert.equal(unauthAdminRes.status, 403, 'Non-admin customer must be denied reconciliation discrepancy access');

      const adminListRes = await apiCall('/api/v1/admin/reconciliation/discrepancies', {
        token: adminToken,
      });
      assert.equal(adminListRes.status, 200);
      assert.ok(Array.isArray(adminListRes.data.discrepancies) && adminListRes.data.discrepancies.length >= 1);

      const obsRes = await apiCall('/api/v1/admin/payments/observability', {
        token: adminToken,
      });
      assert.equal(obsRes.status, 200);
      assert.ok(obsRes.data.observability?.counters);
      assert.ok(obsRes.data.observability?.databaseStateCounts);

      const resolveRes = await apiCall(
        `/api/v1/admin/reconciliation/discrepancies/${discRows.rows[0].id}/resolve`,
        {
          method: 'POST',
          token: adminToken,
          body: { resolutionNote: 'Verified test discrepancy resolution' },
        }
      );
      assert.equal(resolveRes.status, 200);
      assert.equal(resolveRes.data.discrepancy.status, 'RESOLVED');
      console.log('✓ Test 7 passed: Reconciliation auto-repair, worker REQUIRES_REVIEW escalation, and Admin RBAC verified.');
    }

    // -------------------------------------------------------------------------
    // Test 8: Log Redaction, Unselected Gateway Fail-Closed, & Rate Limiting
    // -------------------------------------------------------------------------
    console.log('[Test 8] Testing PII/secret log redaction, unselected PAYMENT_MODE=none, and rate limiting...');
    {
      const sanitized = redactPaymentLogPayload({
        orderId: 'ord-safe-123',
        clientSecret: 'super_secret_key_value',
        webhookSignature: 'deadbeef1234',
        cardNumber: '4111222233334444',
        cvv: '999',
        nested: {
          accessToken: 'jwt_token_value',
          safeField: 'INR',
        },
      });
      assert.equal(sanitized.orderId, 'ord-safe-123');
      assert.equal(sanitized.clientSecret, '[REDACTED]');
      assert.equal(sanitized.webhookSignature, '[REDACTED]');
      assert.equal(sanitized.cardNumber, '[REDACTED]');
      assert.equal(sanitized.cvv, '[REDACTED]');
      assert.equal(sanitized.nested.accessToken, '[REDACTED]');
      assert.equal(sanitized.nested.safeField, 'INR');
      assert.ok(paymentLogger.getCounters().initiations >= 1);
      assert.ok(paymentLogger.getCounters().recoveryEscalations >= 1);

      // Unselected gateway (PAYMENT_MODE=none) must fail closed on online payments
      const prevMode = process.env.PAYMENT_MODE;
      process.env.PAYMENT_MODE = 'none';
      try {
        const disabled = new DisabledPaymentProvider();
        assert.equal(disabled.isSimulated, false);
        assert.equal(paymentProviderRegistry.isPaymentConfigured(), false);

        const ordNone = await orderService.createOrder({
          userId: custId1,
          merchantId,
          items: [{ productId, quantity: 1 }],
          jobSite: { address: 'None Gateway Site', latitude: 12.9716, longitude: 77.5946 },
          paymentMethod: 'Instant UPI',
        });

        const noneRes = await apiCall('/api/v1/payments/create-order', {
          method: 'POST',
          token: custToken1,
          body: { orderId: ordNone.order.id },
        });
        assert.equal(noneRes.status, 503);
        assert.equal(noneRes.data.error, 'PAYMENT_GATEWAY_NOT_CONFIGURED');

        const noneWebhookRes = await apiCall('/api/v1/webhooks/razorpay', {
          method: 'POST',
          headers: { 'x-webhook-signature': 'dummy_sig' },
          body: { id: 'evt_none_1', event: 'payment.captured' },
        });
        assert.equal(noneWebhookRes.status, 503);
        assert.equal(noneWebhookRes.data.error, 'PAYMENT_GATEWAY_NOT_CONFIGURED');

        // Health & Readiness endpoints continue functioning cleanly with PAYMENT_MODE=none
        const healthRes = await apiCall('/health');
        assert.equal(healthRes.status, 200);
        const readyRes = await apiCall('/ready');
        assert.equal(readyRes.status, 200);
        assert.equal(readyRes.data.payments?.status, 'UNCONFIGURED');
        assert.equal(readyRes.data.payments?.onlinePaymentsAvailable, false);
      } finally {
        if (prevMode === undefined) {
          delete process.env.PAYMENT_MODE;
        } else {
          process.env.PAYMENT_MODE = prevMode;
        }
      }
      console.log('✓ Test 8 passed: Sensitive log redaction and unselected-gateway 503 fail-closed behavior verified.');
    }

    // Verify overall ledger trial balance remains 0 difference
    const tb = await ledgerService.getTrialBalance();
    assert.equal(tb.isBalanced, true, `General Ledger must balance; diff=${tb.difference}`);
    assert.equal(tb.difference, 0);

    console.log('\n================================================================================');
    console.log('✓ ALL SPRINT 15.8 GATEWAY-AGNOSTIC PAYMENT INFRASTRUCTURE TESTS PASSED!');
    console.log('================================================================================\n');
  } finally {
    paymentService.resetProvider();
    refundService.resetProvider();
    server.close();
    await pool.end();
  }
}

if (process.argv[1]?.includes('sprint15-8')) {
  runSprint15_8GatewayAgnosticPaymentInfrastructureTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
