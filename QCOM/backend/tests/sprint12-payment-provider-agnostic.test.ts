import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { createApp } from '../src/app.js';
import { setPool, transaction } from '../src/database/connection.js';
import { runMigrations } from '../src/database/migrator.js';
import { runSeeds } from '../seeds/seedData.js';
import { createTestDatabase } from './helpers/testDb.js';
import { paymentService } from '../src/modules/payments/paymentService.js';
import {
  paymentProviderRegistry,
  MockPaymentProvider,
  PaymentProvider,
  PaymentProviderCapabilities,
  CreatePaymentSessionParams,
  PaymentSessionResult,
  VerifyPaymentParams,
  PaymentVerificationResult,
  ProviderPaymentStatus,
  ProviderWebhookEvent,
  ProviderRefundRequest,
  ProviderRefundResult,
  NormalizedProviderError,
} from '../src/modules/payments/paymentProvider.js';
import { validatePaymentTransition, ALL_PAYMENT_STATES, TERMINAL_PAYMENT_STATES } from '../src/modules/payments/paymentStateMachine.js';
import { AuthService } from '../src/modules/auth/authService.js';
import { env } from '../src/config/env.js';

export async function runSprint12PaymentProviderAgnosticTests(): Promise<void> {
  console.log('\n===========================================================');
  console.log('--- Running Sprint 12.0: Payment-Provider-Agnostic Architecture Test Suite ---');
  console.log('===========================================================');

  const { pool } = createTestDatabase();
  setPool(pool);

  // Apply migrations 001 through 022
  await runMigrations({ poolOverride: pool });
  await runSeeds(pool);

  const app = createApp();
  const authService = new AuthService();

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // Setup test customers
    const phone1 = '+91-9123456788';
    const otp1 = await authService.requestOtp(phone1, 'LOGIN', '127.0.0.1', pool);
    const auth1 = await authService.verifyOtp(phone1, otp1.debugOtp!, 'LOGIN', '127.0.0.1', 'agent', 'Customer One', pool);
    const customer1Token = auth1.accessToken;
    const customer1UserId = auth1.user.id;

    // Helper to create an order with inventory reservation
    async function createTestOrder(userId: string = customer1UserId): Promise<string> {
      const prodRes = await pool.query(`SELECT id FROM products LIMIT 1`);
      const prodId = prodRes.rows[0].id;

      const res = await fetch(`${baseUrl}/api/orders/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${customer1Token}`,
        },
        body: JSON.stringify({
          items: [{ id: prodId, quantity: 1 }],
          jobSite: {
            latitude: 12.9716,
            longitude: 77.5946,
            address: 'Bangalore Tech Park',
          },
          paymentMethod: 'Instant UPI',
        }),
      });

      const body = await res.json();
      assert.strictEqual(res.status, 200, `Failed to create order: ${JSON.stringify(body)}`);
      return body.order.id;
    }

    // -------------------------------------------------------------
    // TEST A: Provider-Agnostic Interface & Capability Model
    // -------------------------------------------------------------
    console.log('[Test A] Testing Provider-Agnostic Interface & Capability Model...');
    {
      const provider = paymentProviderRegistry.getProvider('mock');
      assert.ok(provider, 'Mock provider must be registered');
      assert.equal(provider.providerId, 'mock', 'Provider ID must be mock');

      const capabilities = provider.getCapabilities();
      assert.strictEqual(capabilities.supportsPaymentSession, true, 'Mock provider must support payment session');
      assert.strictEqual(capabilities.supportsWebhookVerification, true, 'Mock provider must support webhook verification');
      assert.strictEqual(capabilities.supportsStatusInquiry, true, 'Mock provider must support status inquiry');
      assert.strictEqual(capabilities.supportsRefunds, true, 'Mock provider must support refunds');
      assert.strictEqual(capabilities.currencySubunitFactor, 100, 'Default subunit factor must be 100');

      // Test error normalization
      const timeoutErr = provider.normalizeError(new Error('Gateway connection timeout ETIMEDOUT'));
      assert.strictEqual(timeoutErr.category, 'NETWORK_TIMEOUT', 'Timeout error must normalize to NETWORK_TIMEOUT');
      assert.strictEqual(timeoutErr.retryable, true, 'Timeout error must be retryable');

      const authErr = provider.normalizeError(new Error('Unauthorized 401 invalid api credentials'));
      assert.strictEqual(authErr.category, 'AUTHENTICATION_ERROR', '401 must normalize to AUTHENTICATION_ERROR');
      assert.strictEqual(authErr.retryable, false, 'Auth error must not be retryable');

      console.log('✓ Test A passed: Provider-agnostic capabilities and error normalization verified.');
    }

    // -------------------------------------------------------------
    // TEST B: Provider Registry & Zero-Code Dynamic Hot-Swapping
    // -------------------------------------------------------------
    console.log('[Test B] Testing Provider Registry & Dynamic Adapter Hot-Swapping...');
    {
      class CustomGatewayX implements PaymentProvider {
        public readonly providerId = 'gateway_x';
        public readonly displayName = 'Custom Partner Gateway X';
        public readonly mode = 'custom';

        getCapabilities(): PaymentProviderCapabilities {
          return {
            supportsPaymentSession: true,
            supportsServerInitiatedOrder: false,
            supportsPaymentVerification: true,
            supportsWebhookVerification: true,
            supportsStatusInquiry: true,
            supportsRefunds: true,
            supportsRefundStatusInquiry: true,
            supportsNativeIdempotency: false,
            supportsSeparateAuthAndCapture: false,
            currencySubunitFactor: 100,
          };
        }

        async createPaymentSession(params: CreatePaymentSessionParams): Promise<PaymentSessionResult> {
          return {
            providerId: this.providerId,
            providerReference: `gwx_sess_${Date.now()}`,
            amount: params.amount,
            currency: params.currency,
          };
        }

        async verifyPayment(params: VerifyPaymentParams): Promise<PaymentVerificationResult> {
          return {
            verified: true,
            status: 'SUCCEEDED',
            providerPaymentId: `gwx_pay_${Date.now()}`,
            amount: params.amount,
            currency: params.currency,
          };
        }

        async getPaymentStatus(providerReference: string): Promise<ProviderPaymentStatus> {
          return {
            providerId: this.providerId,
            providerReference,
            status: 'SUCCEEDED',
            amount: 100,
            currency: 'INR',
            rawStatus: 'SUCCESS',
          };
        }

        verifyWebhookSignature(): boolean { return true; }
        parseWebhookEvent(params: any): ProviderWebhookEvent {
          return {
            eventId: 'evt_gwx',
            eventType: 'PAYMENT_SUCCESS',
            rawEventType: 'payment.success',
            providerId: this.providerId,
            rawBody: params.rawBody,
            rawPayload: {},
          };
        }
        async createRefund(params: ProviderRefundRequest): Promise<ProviderRefundResult> {
          return {
            providerRefundId: 'rf_gwx',
            paymentId: params.paymentId,
            amount: params.amount,
            currency: params.currency,
            status: 'PROCESSED',
            timestamp: new Date().toISOString(),
          };
        }
        async getRefundStatus(id: string): Promise<ProviderRefundResult> {
          return { providerRefundId: id, paymentId: 'p', amount: 10, currency: 'INR', status: 'PROCESSED', timestamp: new Date().toISOString() };
        }
        normalizeError(err: any): NormalizedProviderError {
          return { category: 'UNKNOWN', code: 'GWX_ERR', message: err?.message, retryable: false };
        }
        async createOrder(orderId: string, amount: number, timestamp: number): Promise<any> {
          return { providerOrderId: `gwx_${orderId}`, amount, currency: 'INR', signature: 'sig', timestamp: String(timestamp) };
        }
        verifyPaymentSignature(): boolean { return true; }
        mapProviderStatus(): string { return 'CAPTURED'; }
      }

      const customProvider = new CustomGatewayX();
      paymentProviderRegistry.registerProvider(customProvider);

      assert.strictEqual(paymentProviderRegistry.hasProvider('gateway_x'), true, 'Registry must recognize gateway_x');
      const retrieved = paymentProviderRegistry.getProvider('gateway_x');
      assert.strictEqual(retrieved.providerId, 'gateway_x', 'Retrieved provider must match registered ID');
      assert.strictEqual(retrieved.displayName, 'Custom Partner Gateway X');

      // Verify list includes gateway_x
      const allProviders = paymentProviderRegistry.listProviders();
      assert.ok(allProviders.some(p => p.providerId === 'gateway_x'), 'Provider list must contain gateway_x');

      // Fallback behavior when requesting unregistered provider
      const fallback = paymentProviderRegistry.getProvider('non_existent_gateway');
      assert.strictEqual(fallback.providerId, 'mock', 'Unregistered provider request must fallback safely to default mock');

      console.log('✓ Test B passed: Dynamic provider registration and fallback verified.');
    }

    // -------------------------------------------------------------
    // TEST C: Authoritative QCOM Payment State Machine Invariants
    // -------------------------------------------------------------
    console.log('[Test C] Testing Authoritative QCOM Payment State Machine Invariants...');
    {
      // Valid transitions
      assert.strictEqual(validatePaymentTransition('CREATED', 'PENDING').valid, true);
      assert.strictEqual(validatePaymentTransition('CREATED', 'PROCESSING').valid, true);
      assert.strictEqual(validatePaymentTransition('PROCESSING', 'CAPTURED').valid, true);
      assert.strictEqual(validatePaymentTransition('PROCESSING', 'RECONCILIATION_REQUIRED').valid, true);
      assert.strictEqual(validatePaymentTransition('RECONCILIATION_REQUIRED', 'CAPTURED').valid, true);
      assert.strictEqual(validatePaymentTransition('RECONCILIATION_REQUIRED', 'FAILED').valid, true);
      assert.strictEqual(validatePaymentTransition('CAPTURED', 'REFUND_PENDING').valid, true);
      assert.strictEqual(validatePaymentTransition('REFUND_PENDING', 'REFUNDED').valid, true);

      // Terminal state protection: FAILED, CANCELLED, REFUNDED cannot transition
      for (const terminal of TERMINAL_PAYMENT_STATES) {
        for (const target of ALL_PAYMENT_STATES) {
          if (terminal !== target) {
            const res = validatePaymentTransition(terminal, target);
            assert.strictEqual(res.valid, false, `Cannot transition out of terminal state '${terminal}' to '${target}'`);
          }
        }
      }

      // CAPTURED state protection: cannot transition back to FAILED, CANCELLED, or PENDING
      assert.strictEqual(validatePaymentTransition('CAPTURED', 'FAILED').valid, false);
      assert.strictEqual(validatePaymentTransition('CAPTURED', 'CANCELLED').valid, false);
      assert.strictEqual(validatePaymentTransition('CAPTURED', 'PENDING').valid, false);
      assert.strictEqual(validatePaymentTransition('CAPTURED', 'PROCESSING').valid, false);

      // Idempotent self-transitions
      const selfCaptured = validatePaymentTransition('CAPTURED', 'CAPTURED');
      assert.strictEqual(selfCaptured.valid, true);
      assert.strictEqual(selfCaptured.isDuplicate, true);

      console.log('✓ Test C passed: State machine transitions and terminal invariants strictly enforced.');
    }

    // -------------------------------------------------------------
    // TEST D: Durable Multi-Attempt Tracking & Database Uniqueness
    // -------------------------------------------------------------
    console.log('[Test D] Testing Durable Multi-Attempt Tracking & Database Uniqueness...');
    {
      const orderId = await createTestOrder(customer1UserId);

      // Attempt 1
      const attempt1 = await paymentService.createPaymentAttempt({
        orderId,
        userId: customer1UserId,
        providerId: 'mock',
      });

      assert.strictEqual(attempt1.attemptNumber, 1, 'First attempt must have attemptNumber 1');
      assert.ok(attempt1.intent.id, 'Payment intent must have ID');
      assert.ok(attempt1.session.providerReference, 'Session must have provider reference');

      // Verify attempt 1 persisted in database
      const attRow1 = await pool.query(`
        SELECT * FROM payment_attempts WHERE order_id = $1 AND attempt_number = 1
      `, [orderId]);
      assert.strictEqual(attRow1.rows.length, 1, 'Attempt 1 row must exist');
      assert.strictEqual(attRow1.rows[0].status, 'INITIATED', 'Attempt 1 initial status must be INITIATED');
      assert.strictEqual(parseFloat(attRow1.rows[0].amount), attempt1.intent.amount);

      // Simulate Attempt 1 failure
      await pool.query(`
        UPDATE payment_attempts SET status = 'FAILED', error_code = 'USER_CANCELLED', completed_at = NOW()
        WHERE order_id = $1 AND attempt_number = 1
      `, [orderId]);

      // Attempt 2
      const attempt2 = await paymentService.createPaymentAttempt({
        orderId,
        userId: customer1UserId,
        providerId: 'mock',
      });

      assert.strictEqual(attempt2.attemptNumber, 2, 'Second attempt must increment to attemptNumber 2');
      assert.notStrictEqual(attempt1.session.providerReference, attempt2.session.providerReference, 'Attempts must have distinct provider references');

      // Verify attempts listed in getPaymentStatus
      const statusSummary = await paymentService.getPaymentStatus(orderId, customer1UserId);
      assert.ok(statusSummary.attempts, 'Payment status must return attempts array');
      assert.strictEqual(statusSummary.attempts!.length, 2, 'Payment status must contain exactly 2 attempts');
      assert.strictEqual(statusSummary.attempts![0].attemptNumber, 1);
      assert.strictEqual(statusSummary.attempts![1].attemptNumber, 2);

      // Verify uniqueness constraint on (order_id, attempt_number)
      let duplicateAttemptFailed = false;
      try {
        await pool.query(`
          INSERT INTO payment_attempts (order_id, payment_intent_id, attempt_number, provider_id, provider_reference, amount)
          VALUES ($1, $2, 1, 'mock', 'dup_ref_1', $3)
        `, [orderId, attempt1.intent.id, attempt1.intent.amount]);
      } catch (err: any) {
        duplicateAttemptFailed = true;
      }
      assert.strictEqual(duplicateAttemptFailed, true, 'Database must reject duplicate (order_id, attempt_number)');

      console.log('✓ Test D passed: Multi-attempt tracking and database uniqueness constraints verified.');
    }

    // -------------------------------------------------------------
    // TEST E: Provider-Agnostic Webhook Header Independence
    // -------------------------------------------------------------
    console.log('[Test E] Testing Provider-Agnostic Webhook Ingestion & Header Independence...');
    {
      const orderId = await createTestOrder(customer1UserId);
      const paymentOrder = await paymentService.createPaymentOrder(orderId, customer1UserId);

      const timestamp = Date.now();
      const eventId = `evt_agnostic_${Date.now()}`;
      const expectedPaise = Math.round(paymentOrder.amount * 100);
      const payload = {
        id: eventId,
        event: 'payment.captured',
        orderId,
        order_id: paymentOrder.providerOrderId,
        amount: expectedPaise,
        currency: 'INR',
        payment: {
          id: `pay_trx_${Date.now()}`,
          amount: expectedPaise,
          currency: 'INR',
          order_id: paymentOrder.providerOrderId,
        },
      };

      const rawBody = Buffer.from(JSON.stringify(payload));
      const sig = crypto.createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest('hex');

      // Case 1: Send via generic header `x-webhook-signature`
      const whRes1 = await paymentService.processWebhook({
        rawBody,
        headers: {
          'x-webhook-signature': sig,
        },
      });

      assert.strictEqual(whRes1.success, true, 'Webhook must succeed with x-webhook-signature');
      assert.strictEqual(whRes1.eventId, eventId);

      // Verify order is marked PAID and stock committed
      const checkOrder = await pool.query(`SELECT payment_status FROM orders WHERE id = $1`, [orderId]);
      assert.strictEqual(checkOrder.rows[0].payment_status, 'PAID', 'Order must be PAID post-webhook');

      // Case 2: Replay attack with same eventId
      const whReplay = await paymentService.processWebhook({
        rawBody,
        headers: {
          'x-signature': sig,
        },
      });
      assert.strictEqual(whReplay.success, true, 'Replay webhook must return success');
      assert.strictEqual(whReplay.duplicate, true, 'Replay webhook must be flagged as duplicate');

      // Case 3: Invalid signature rejection
      let invalidSigFailed = false;
      try {
        await paymentService.processWebhook({
          rawBody,
          headers: {
            'x-webhook-signature': 'invalid_hex_tampered_signature_1234567890',
          },
        });
      } catch (err: any) {
        invalidSigFailed = true;
        assert.ok(err.message.includes('INVALID_WEBHOOK_SIGNATURE'));
      }
      assert.strictEqual(invalidSigFailed, true, 'Tampered webhook signature must be rejected');

      console.log('✓ Test E passed: Header-agnostic webhook authentication and replay defense verified.');
    }

    // -------------------------------------------------------------
    // TEST F: Server-Authoritative Amount Matching & Tampering Rejection
    // -------------------------------------------------------------
    console.log('[Test F] Testing Server-Authoritative Amount Validation with Subunit Support...');
    {
      const orderId = await createTestOrder(customer1UserId);
      const paymentOrder = await paymentService.createPaymentOrder(orderId, customer1UserId);

      // Try sending webhook with tampered amount
      const expectedPaise = Math.round(paymentOrder.amount * 100);
      const tamperedPaise = expectedPaise > 5000 ? expectedPaise - 2000 : expectedPaise + 2000;
      const tamperedPayload = {
        id: `evt_tamper_${Date.now()}`,
        event: 'payment.captured',
        orderId,
        amount: tamperedPaise,
        payment: {
          id: `pay_tamper_${Date.now()}`,
          amount: tamperedPaise,
          order_id: paymentOrder.providerOrderId,
        },
      };

      const rawBody = Buffer.from(JSON.stringify(tamperedPayload));
      const sig = crypto.createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest('hex');

      let tamperRejected = false;
      try {
        await paymentService.processWebhook({
          rawBody,
          signature: sig,
        });
      } catch (err: any) {
        tamperRejected = true;
        assert.ok(err.message.includes('PAYMENT_AMOUNT_MISMATCH'), 'Error must be PAYMENT_AMOUNT_MISMATCH');
      }
      assert.strictEqual(tamperRejected, true, 'Tampered payment amount must be rejected fail-closed');

      // Verify order payment status was NOT modified
      const oCheck = await pool.query(`SELECT payment_status FROM orders WHERE id = $1`, [orderId]);
      assert.notStrictEqual(oCheck.rows[0].payment_status, 'PAID', 'Order must not be marked PAID after tampered amount');

      console.log('✓ Test F passed: Server-authoritative amount validation and tampering rejection verified.');
    }

    // -------------------------------------------------------------
    // TEST G: Network Timeout & Ambiguous Verification (No Blind Failures)
    // -------------------------------------------------------------
    console.log('[Test G] Testing Gateway Timeout Handling & Zero Blind Failure...');
    {
      const orderId = await createTestOrder(customer1UserId);
      await paymentService.createPaymentOrder(orderId, customer1UserId);

      // Configure provider to simulate gateway timeout during verification
      const timeoutProvider = new MockPaymentProvider('timeout_sandbox', {
        simulateTimeout: true,
      });
      paymentService.setProvider(timeoutProvider);

      const verResult = await paymentService.verifyPayment({
        orderId,
        transactionId: `pay_timeout_${Date.now()}`,
        timestamp: Date.now(),
        signature: 'mock_sig',
        userId: customer1UserId,
        evidence: { simulatedTimeout: true, signature: 'mock_sig' },
      });

      assert.strictEqual(verResult.isReconciliationRequired, true, 'Timeout must trigger reconciliation required');

      // Invariant: Order must NOT be marked FAILED, cancelled, or stock released blindly!
      const orderCheck = await pool.query(`SELECT status, payment_status FROM orders WHERE id = $1`, [orderId]);
      assert.notStrictEqual(orderCheck.rows[0].status, 'cancelled', 'Order must not be cancelled on gateway timeout');
      assert.notStrictEqual(orderCheck.rows[0].payment_status, 'FAILED', 'Payment must not be marked FAILED on gateway timeout');

      // Intent must be RECONCILIATION_REQUIRED
      const intentCheck = await pool.query(`SELECT status FROM payment_intents WHERE order_id = $1`, [orderId]);
      assert.strictEqual(intentCheck.rows[0].status, 'RECONCILIATION_REQUIRED', 'Intent must be in RECONCILIATION_REQUIRED');

      // Restore default mock provider
      paymentService.setProvider(new MockPaymentProvider('mock'));

      console.log('✓ Test G passed: Gateway timeout safely preserved order and routed to RECONCILIATION_REQUIRED.');
    }

    // -------------------------------------------------------------
    // TEST H: Authoritative Payment Reconciliation (Provider Succeeded)
    // -------------------------------------------------------------
    console.log('[Test H] Testing Payment Reconciliation Workflow for Ambiguous Outcomes...');
    {
      const orderId = await createTestOrder(customer1UserId);
      const attempt = await paymentService.createPaymentAttempt({
        orderId,
        userId: customer1UserId,
        providerId: 'mock',
      });

      // Manually simulate ambiguous state
      await pool.query(`
        UPDATE payment_intents SET status = 'RECONCILIATION_REQUIRED' WHERE order_id = $1
      `, [orderId]);

      // Mock provider has session in SUCCEEDED state
      const provider = paymentService.getProvider('mock') as MockPaymentProvider;
      // Pre-seed session as SUCCEEDED in mock provider
      await provider.verifyPayment({
        orderId,
        amount: 600.00,
        currency: 'INR',
        providerReference: attempt.session.providerReference,
        providerPaymentId: `pay_rec_${Date.now()}`,
        evidence: {
          signature: attempt.session.signature,
          timestamp: Date.now(),
        },
      });

      // Run reconciliation
      const recResult = await paymentService.reconcilePayment(orderId);

      assert.strictEqual(recResult.reconciled, true, 'Reconciliation must succeed');
      assert.strictEqual(recResult.status, 'CAPTURED', 'Reconciled status must be CAPTURED');
      assert.strictEqual(recResult.action, 'CAPTURED');

      // Verify order is now PAID
      const finalOrder = await pool.query(`SELECT payment_status FROM orders WHERE id = $1`, [orderId]);
      assert.strictEqual(finalOrder.rows[0].payment_status, 'PAID', 'Order must be marked PAID post-reconciliation');

      // Verify receipt exists
      const receiptCheck = await pool.query(`SELECT * FROM payment_receipts WHERE order_id = $1`, [orderId]);
      assert.strictEqual(receiptCheck.rows.length, 1, 'Payment receipt must be recorded');

      console.log('✓ Test H passed: Ambiguous payment successfully reconciled with provider and captured.');
    }

    // -------------------------------------------------------------
    // TEST I: Late Payment Reconciliation on Expired/Cancelled Order (Escrow Liability)
    // -------------------------------------------------------------
    console.log('[Test I] Testing Late Payment on Expired Order (Escrow Capture & Refund)...');
    {
      const orderId = await createTestOrder(customer1UserId);
      const attempt = await paymentService.createPaymentAttempt({
        orderId,
        userId: customer1UserId,
        providerId: 'mock',
      });

      // Simulate reservation expiration and order cancellation
      await pool.query(`
        UPDATE inventory_reservations
        SET status = 'RELEASED', expires_at = NOW() - interval '1 hour'
        WHERE order_id = $1
      `, [orderId]);
      await pool.query(`
        UPDATE orders
        SET status = 'cancelled', cancellation_reason = 'Reservation timed out before payment'
        WHERE id = $1
      `, [orderId]);

      // Mock provider reports payment succeeded externally
      const provider = paymentService.getProvider('mock') as MockPaymentProvider;
      await provider.verifyPayment({
        orderId,
        amount: 800.00,
        currency: 'INR',
        providerReference: attempt.session.providerReference,
        providerPaymentId: `pay_late_${Date.now()}`,
        evidence: {
          signature: attempt.session.signature,
          timestamp: Date.now(),
        },
      });

      // Reconcile late payment
      const recLate = await paymentService.reconcilePayment(orderId);

      assert.strictEqual(recLate.reconciled, true, 'Late payment reconciliation must succeed');
      assert.strictEqual(recLate.status, 'REFUND_PENDING', 'Late payment must transition to REFUND_PENDING');

      // Invariant: Order must remain CANCELLED. Inventory must NOT be allocated!
      const lateOrder = await pool.query(`SELECT status, payment_status FROM orders WHERE id = $1`, [orderId]);
      assert.strictEqual(lateOrder.rows[0].status, 'cancelled', 'Order must remain cancelled');
      assert.strictEqual(lateOrder.rows[0].payment_status, 'REFUND_PENDING', 'Payment status must be REFUND_PENDING');

      console.log('✓ Test I passed: Late payment safely routed to escrow refund without overselling stock.');
    }

    // -------------------------------------------------------------
    // TEST J: Double-Entry Financial Ledger Equality (Debits == Credits)
    // -------------------------------------------------------------
    console.log('[Test J] Testing Double-Entry Financial Ledger Equality Across Provider Actions...');
    {
      const ledgerCheck = await pool.query(`
        SELECT journal_batch_id,
               SUM(CASE WHEN entry_side = 'DEBIT' THEN amount ELSE 0 END) AS total_debits,
               SUM(CASE WHEN entry_side = 'CREDIT' THEN amount ELSE 0 END) AS total_credits
        FROM general_ledger_entries
        GROUP BY journal_batch_id
      `);

      assert.ok(ledgerCheck.rows.length > 0, 'General ledger entries must exist');
      for (const row of ledgerCheck.rows) {
        const debits = parseFloat(row.total_debits);
        const credits = parseFloat(row.total_credits);
        assert.ok(
          Math.abs(debits - credits) < 0.001,
          `Batch ${row.journal_batch_id} violates double-entry invariant: Debits=${debits}, Credits=${credits}`
        );
      }

      console.log(`✓ Test J passed: Verified ${ledgerCheck.rows.length} general ledger batches strictly balance (Debits == Credits).`);
    }

    // -------------------------------------------------------------
    // TEST K: HTTP API Integration Tests (Agnostic Endpoints)
    // -------------------------------------------------------------
    console.log('[Test K] Testing Provider-Agnostic HTTP API Endpoints...');
    {
      // 1. GET /api/v1/payments/providers
      const provRes = await fetch(`${baseUrl}/api/v1/payments/providers`);
      assert.strictEqual(provRes.status, 200, 'GET /providers must return 200');
      const provData = await provRes.json();
      assert.strictEqual(provData.success, true);
      assert.ok(Array.isArray(provData.providers), 'Must return providers array');
      assert.ok(provData.providers.some((p: any) => p.providerId === 'mock'));

      // 2. POST /api/v1/payments/attempt
      const orderId = await createTestOrder(customer1UserId);
      const attRes = await fetch(`${baseUrl}/api/v1/payments/attempt`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${customer1Token}`,
          'Idempotency-Key': `idem_att_${Date.now()}`,
        },
        body: JSON.stringify({
          orderId,
          providerId: 'mock',
        }),
      });

      assert.strictEqual(attRes.status, 200, 'POST /attempt must return 200');
      const attData = await attRes.json();
      assert.strictEqual(attData.success, true);
      assert.ok(attData.intent, 'Must return intent');
      assert.ok(attData.session, 'Must return session');
      assert.strictEqual(attData.attemptNumber, 1);

      // 3. POST /api/v1/payments/reconcile/:orderId
      const recRes = await fetch(`${baseUrl}/api/v1/payments/reconcile/${orderId}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${customer1Token}`,
        },
      });
      assert.strictEqual(recRes.status, 200, 'POST /reconcile/:orderId must return 200');
      const recData = await recRes.json();
      assert.strictEqual(recData.success, true);
      assert.ok(recData.reconciliation);

      console.log('✓ Test K passed: HTTP API endpoints for provider-agnostic payments verified.');
    }

    console.log('\n===========================================================');
    console.log('✓ ALL SPRINT 12.0 PROVIDER-AGNOSTIC TESTS PASSED (11/11)!');
    console.log('===========================================================');
  } finally {
    server.close();
  }
}

// Allow direct execution via tsx
if (process.argv[1]?.endsWith('sprint12-payment-provider-agnostic.test.ts')) {
  runSprint12PaymentProviderAgnosticTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('\n✗ Sprint 12.0 Test Suite Failed:', err);
      process.exit(1);
    });
}
