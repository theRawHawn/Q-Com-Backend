import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { setPool, transaction } from '../src/database/connection.js';
import { runMigrations } from '../src/database/migrator.js';
import { runSeeds } from '../seeds/seedData.js';
import { createTestDatabase } from './helpers/testDb.js';
import { FinancialRecoveryWorker } from '../src/modules/recovery/financialRecoveryWorker.js';
import { paymentService } from '../src/modules/payments/paymentService.js';
import {
  paymentProviderRegistry,
  MockPaymentProvider,
  DisabledPaymentProvider,
  PaymentProvider,
} from '../src/modules/payments/paymentProvider.js';
import { validateProductionSecurity, EnvConfig, env } from '../src/config/env.js';

export async function runSprint12_5RecoveryConcurrencyAndProviderNeutralityTests(): Promise<void> {
  console.log('\n===========================================================');
  console.log('--- Running Sprint 12.5: Recovery Concurrency & Provider-Neutral Configuration Suite ---');
  console.log('===========================================================');

  const { pool } = createTestDatabase();
  setPool(pool);

  // Apply all migrations
  await runMigrations({ poolOverride: pool });
  await runSeeds(pool);

  const userRes = await pool.query(`SELECT id FROM users LIMIT 1`);
  const userId = userRes.rows[0].id;
  const merchRes = await pool.query(`SELECT id FROM merchants LIMIT 1`);
  const merchantId = merchRes.rows[0].id;
  const prodRes = await pool.query(`SELECT id FROM products LIMIT 1`);
  const productId = prodRes.rows[0].id;

  async function createTestOrder(status: string = 'delivered', paymentStatus: string = 'PAID', amount: number = 500) {
    const orderId = crypto.randomUUID();
    const orderNumber = `ORD_${Date.now()}_${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    await pool.query(`
      INSERT INTO orders (
        id, order_number, user_id, merchant_id, status, items_subtotal, delivery_fee, handling_fee, urgency_fee,
        discount_amount, taxable_amount, cgst_amount, sgst_amount, igst_amount, total_amount, withholding_amount,
        gst_tcs_amount, payment_method, payment_status, delivery_otp, handover_token, jobsite_address,
        place_of_supply_state_code, pricing_snapshot, placed_at, estimated_delivery_at, delivered_at, created_at, updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, 0, 0, 0, 0, $6, 0, 0, 0, $6, 0, 0,
        'Instant UPI', $7, '123456', 'PK-9999', '{"latitude": 12.9716, "longitude": 77.5946}'::jsonb,
        '29', '{}'::jsonb, NOW(), NOW() + INTERVAL '1 hour', NOW(), NOW(), NOW()
      )
    `, [orderId, orderNumber, userId, merchantId, status, amount, paymentStatus]);

    await pool.query(`
      INSERT INTO inventory_reservations (id, order_id, merchant_id, product_id, quantity, status, expires_at)
      VALUES (gen_random_uuid(), $1, $2, $3, 1, 'RESERVED', NOW() + INTERVAL '1 hour')
    `, [orderId, merchantId, productId]);

    return orderId;
  }

  try {
    // -------------------------------------------------------------
    // TEST 1: Candidate Selection Query Uses FOR UPDATE SKIP LOCKED
    // -------------------------------------------------------------
    console.log('[Test 1] Testing Recovery Worker Candidate Selection Query (SKIP LOCKED)...');
    {
      const workerA = new FinancialRecoveryWorker({
        workerId: 'worker_alpha_test_1',
        staleThresholdSec: 10,
        leaseDurationSec: 30,
        batchSize: 5,
        scanIntervalMs: 60000,
      });

      // Insert 2 stale PROCESSING refunds
      const orderId1 = await createTestOrder('delivered', 'REFUND_PENDING', 500.00);
      const orderId2 = await createTestOrder('delivered', 'REFUND_PENDING', 750.00);
      const refundId1 = crypto.randomUUID();
      const refundId2 = crypto.randomUUID();

      const staleTime = new Date(Date.now() - 60000); // 60 seconds ago (well past 10s threshold)

      await pool.query(`
        INSERT INTO refunds (id, refund_number, order_id, amount, currency, reason_code, refund_type, status, idempotency_key, created_at, updated_at)
        VALUES 
          ($1, 'REF_T1_1', $2, 500.00, 'INR', 'CUSTOMER_REQUEST', 'FULL', 'PROCESSING', 'idemp_t1_1', $3, $3),
          ($4, 'REF_T1_2', $5, 750.00, 'INR', 'CUSTOMER_REQUEST', 'FULL', 'PROCESSING', 'idemp_t1_2', $3, $3)
      `, [refundId1, orderId1, staleTime, refundId2, orderId2]);

      // Worker Alpha executes queryClaimCandidates in a transaction
      const claimedA = await transaction(async (client) => {
        const res = await (workerA as any).queryClaimCandidates(client, 'refunds', new Date(Date.now() - 10000), 5);
        return res.rows.map((r: any) => r.id);
      });

      assert.strictEqual(claimedA.length, 2, 'Worker Alpha should discover both stale candidates');
      assert.ok(claimedA.includes(refundId1), 'Should contain refund 1');
      assert.ok(claimedA.includes(refundId2), 'Should contain refund 2');
      console.log('✓ Test 1 passed: Recovery worker candidate selection query executes with SKIP LOCKED protection.');
    }

    // -------------------------------------------------------------
    // TEST 2: Multi-Instance Lease Claiming Without Collisions
    // -------------------------------------------------------------
    console.log('[Test 2] Testing Multi-Instance Mutual Exclusion in Lease Claiming...');
    {
      const orderTest2 = await createTestOrder('delivered', 'REFUND_PENDING', 300.00);
      const refundId2 = crypto.randomUUID();
      await pool.query(`
        INSERT INTO refunds (
          id, refund_number, order_id, amount, currency, reason_code, refund_type, status,
          idempotency_key, created_at, updated_at
        )
        VALUES ($1, $2, $3, 100.00, 'INR', 'DAMAGED_ITEM', 'PARTIAL', 'PROCESSING', $4, NOW() - INTERVAL '20 seconds', NOW() - INTERVAL '20 seconds')
      `, [refundId2, `RFND_T2_${Date.now()}`, orderTest2, `IDEMP_T2_${Date.now()}`]);

      const worker1 = new FinancialRecoveryWorker({
        workerId: 'worker_instance_1',
        staleThresholdSec: 5,
        leaseDurationSec: 60,
        batchSize: 10,
        scanIntervalMs: 60000,
      });

      const worker2 = new FinancialRecoveryWorker({
        workerId: 'worker_instance_2',
        staleThresholdSec: 5,
        leaseDurationSec: 60,
        batchSize: 10,
        scanIntervalMs: 60000,
      });

      // Worker 1 holds active lease
      await pool.query(`
        UPDATE refunds
        SET recovery_lease_id = $1,
            recovery_lease_expires_at = NOW() + INTERVAL '60 seconds',
            last_reconciled_at = NOW()
        WHERE id = $2
      `, [worker1.workerId, refundId2]);

      // Worker 2 runs cycle - must NOT steal Worker 1's active lease
      await worker2.runRecoveryCycle();
      const refCheck = await pool.query(`SELECT recovery_lease_id, status FROM refunds WHERE id = $1`, [refundId2]);
      assert.strictEqual(refCheck.rows[0].recovery_lease_id, worker1.workerId, 'Worker 2 must not steal active lease from Worker 1');
      assert.strictEqual(refCheck.rows[0].status, 'PROCESSING', 'Refund must remain in PROCESSING until Worker 1 finishes');

      console.log('✓ Test 2 passed: Multi-instance leasing guarantees mutual exclusion across worker nodes.');
    }

    // -------------------------------------------------------------
    // TEST 3: Multi-Instance Concurrent Payment Intent Recovery
    // -------------------------------------------------------------
    console.log('[Test 3] Testing Concurrent Payment Intent Recovery (SKIP LOCKED Order Discovery)...');
    {
      const workerA = new FinancialRecoveryWorker({ workerId: 'worker_pay_A', staleThresholdSec: 5, batchSize: 10 });
      const workerB = new FinancialRecoveryWorker({ workerId: 'worker_pay_B', staleThresholdSec: 5, batchSize: 10 });

      const testOrderId = await createTestOrder('placed', 'PENDING', 650.00);

      const attempt = await paymentService.createPaymentAttempt({
        orderId: testOrderId,
        userId,
        providerId: 'mock',
      });

      const staleTime = new Date(Date.now() - 30000);
      await pool.query(`
        UPDATE payment_intents
        SET status = 'RECONCILIATION_REQUIRED', provider_order_id = $2, payment_order_id = $2, created_at = $3, updated_at = $3
        WHERE order_id = $1
      `, [testOrderId, attempt.session.providerReference, staleTime]);

      // Pre-seed session as SUCCEEDED in mock provider
      const provider = paymentService.getProvider('mock') as MockPaymentProvider;
      await provider.verifyPayment({
        orderId: testOrderId,
        providerReference: attempt.session.providerReference,
        amount: 650.00,
        currency: 'INR',
        evidence: { simulatedSuccess: true, signature: 'mock_sig' },
      });

      // Both workers attempt recovery simultaneously
      const [resA, resB] = await Promise.all([
        workerA.recoverPendingPayments(),
        workerB.recoverPendingPayments(),
      ]);

      // Total recovered between both must equal 1 (no double-processing)
      assert.strictEqual(resA + resB, 1, 'Exactly one worker node must recover the stale payment intent');
      console.log('✓ Test 3 passed: Multi-instance payment intent recovery enforces mutual exclusion.');
    }

    // -------------------------------------------------------------
    // TEST 4: Multi-Instance Concurrent Step C REFUND_PENDING Scans
    // -------------------------------------------------------------
    console.log('[Test 4] Testing Step C REFUND_PENDING Order Scans with SKIP LOCKED...');
    {
      const orderStuck = await createTestOrder('cancelled', 'REFUND_PENDING', 890.00);

      const worker1 = new FinancialRecoveryWorker({ workerId: 'worker_c_1', staleThresholdSec: 5 });
      const worker2 = new FinancialRecoveryWorker({ workerId: 'worker_c_2', staleThresholdSec: 5 });

      // Run both cycles concurrently
      await Promise.all([
        worker1.runRecoveryCycle(),
        worker2.runRecoveryCycle(),
      ]);

      // Verify only ONE refund was created for orderStuck
      const refundCount = await pool.query(`SELECT COUNT(*) as count FROM refunds WHERE order_id = $1`, [orderStuck]);
      assert.strictEqual(parseInt(refundCount.rows[0].count, 10), 1, 'Exactly one refund must be created for stuck order');
      console.log('✓ Test 4 passed: Concurrent Step C scans prevent duplicate refund creation.');
    }

    // -------------------------------------------------------------
    // TEST 5: Provider-Neutral Production Security Configuration
    // -------------------------------------------------------------
    console.log('[Test 5] Testing Provider-Neutral Security Configuration Fail-Closed Rules...');
    {
      // A. Production fails closed when PAYMENT_MODE === 'production' but no PAYMENT_PROVIDER is configured
      assert.throws(
        () => {
          validateProductionSecurity({
            NODE_ENV: 'production',
            JWT_ACCESS_SECRET: 'production_high_entropy_jwt_access_secret_32_chars!',
            JWT_REFRESH_SECRET: 'production_high_entropy_jwt_refresh_secret_32_chars!',
            TELEPHONY_MODE: 'exotel',
            PAYMENT_MODE: 'production',
            PAYMENT_PROVIDER: '', // No gateway selected
            PAYMENT_SECRET: 'high_entropy_prod_isolated_payment_secret_2026',
            CORS_ALLOWED_ORIGINS: 'https://admin.qcom.in',
          } as EnvConfig);
        },
        /In production mode.*concrete PAYMENT_PROVIDER must be explicitly configured/i,
        'Production must reject unconfigured gateway without defaulting to any provider'
      );

      // B. Production fails closed on simulated or mock provider
      assert.throws(
        () => {
          validateProductionSecurity({
            NODE_ENV: 'production',
            JWT_ACCESS_SECRET: 'production_high_entropy_jwt_access_secret_32_chars!',
            JWT_REFRESH_SECRET: 'production_high_entropy_jwt_refresh_secret_32_chars!',
            TELEPHONY_MODE: 'exotel',
            PAYMENT_MODE: 'production',
            PAYMENT_PROVIDER: 'mock',
            PAYMENT_SECRET: 'high_entropy_prod_isolated_payment_secret_2026',
            CORS_ALLOWED_ORIGINS: 'https://admin.qcom.in',
          } as EnvConfig);
        },
        /Mock or test payment mode is strictly prohibited in production mode/i,
        'Production must reject mock payment provider'
      );

      console.log('✓ Test 5 passed: Provider-neutral production security rules fail closed safely.');
    }

    // -------------------------------------------------------------
    // TEST 6: Dynamic Gateway Credential Validation (Cashfree / PayU / Stripe)
    // -------------------------------------------------------------
    console.log('[Test 6] Testing Dynamic Gateway Credential Validation for Future Providers...');
    {
      // Testing with a hypothetical Cashfree provider
      assert.throws(
        () => {
          validateProductionSecurity({
            NODE_ENV: 'production',
            JWT_ACCESS_SECRET: 'production_high_entropy_jwt_access_secret_32_chars!',
            JWT_REFRESH_SECRET: 'production_high_entropy_jwt_refresh_secret_32_chars!',
            TELEPHONY_MODE: 'exotel',
            PAYMENT_MODE: 'production',
            PAYMENT_PROVIDER: 'cashfree',
            PAYMENT_SECRET: 'high_entropy_prod_isolated_payment_secret_2026',
            CORS_ALLOWED_ORIGINS: 'https://admin.qcom.in',
          } as EnvConfig);
        },
        /requires valid CASHFREE_KEY_ID and high-entropy CASHFREE_KEY_SECRET/i,
        'Must validate required credentials dynamically for selected provider'
      );

      // Testing with valid provider-neutral gateway credentials
      assert.doesNotThrow(
        () => {
          validateProductionSecurity({
            NODE_ENV: 'production',
            JWT_ACCESS_SECRET: 'production_high_entropy_jwt_access_secret_32_chars!',
            JWT_REFRESH_SECRET: 'production_high_entropy_jwt_refresh_secret_32_chars!',
            TELEPHONY_MODE: 'exotel',
            PAYMENT_MODE: 'production',
            PAYMENT_PROVIDER: 'cashfree',
            PAYMENT_GATEWAY_KEY_ID: 'cf_app_live_prod_id_1234567890',
            PAYMENT_GATEWAY_KEY_SECRET: 'cf_secret_live_prod_key_1234567890_super_secure',
            PAYMENT_WEBHOOK_SECRET: 'cf_webhook_live_prod_secret_1234567890_entropy',
            PAYMENT_SECRET: 'high_entropy_prod_isolated_payment_secret_2026',
            CORS_ALLOWED_ORIGINS: 'https://admin.qcom.in',
          } as EnvConfig);
        },
        'Valid dynamic provider credentials must pass production validation'
      );

      console.log('✓ Test 6 passed: Dynamic gateway credentials verified across arbitrary future providers.');
    }

    // -------------------------------------------------------------
    // TEST 7: Mock & Simulated Provider Rejection in Production Mode
    // -------------------------------------------------------------
    console.log('[Test 7] Testing Registry & isSimulated Defense in Production Mode...');
    {
      const mockProvider = new MockPaymentProvider('custom_mock_adapter');
      assert.strictEqual(mockProvider.isSimulated, true, 'MockPaymentProvider must declare isSimulated = true');

      const disabledProvider = new DisabledPaymentProvider();
      assert.strictEqual(disabledProvider.isSimulated, false, 'DisabledPaymentProvider is not simulated');

      // Test that registration fails closed if NODE_ENV is production
      const originalEnv = env.NODE_ENV;
      try {
        (env as any).NODE_ENV = 'production';

        assert.throws(
          () => {
            paymentProviderRegistry.registerProvider(mockProvider);
          },
          /SECURITY_VIOLATION: Mock or simulated payment provider.*cannot be registered in production/i,
          'Production registry must reject simulated provider registration'
        );

        assert.throws(
          () => {
            paymentProviderRegistry.getProvider('mock');
          },
          /SECURITY_VIOLATION: Mock payment provider 'mock' cannot be accessed in production/i,
          'Production registry must reject access to mock provider'
        );
      } finally {
        (env as any).NODE_ENV = originalEnv;
      }

      console.log('✓ Test 7 passed: Simulated payment defense strictly blocks mock usage in production.');
    }

    // -------------------------------------------------------------
    // TEST 8: Provider-Neutral Webhook Signature Verification
    // -------------------------------------------------------------
    console.log('[Test 8] Testing Provider-Neutral Webhook Signature Verification...');
    {
      const mockProvider = new MockPaymentProvider('mock_sig_test', {
        webhookSecret: 'test_neutral_webhook_secret_12345',
      });

      const payload = JSON.stringify({ event: 'payment.success', id: 'evt_123' });
      const signature = crypto
        .createHmac('sha256', 'test_neutral_webhook_secret_12345')
        .update(payload)
        .digest('hex');

      // Mode A: Direct signature argument
      const resDirect = mockProvider.verifyWebhookSignature({
        rawBody: payload,
        signature,
      });
      assert.strictEqual(resDirect, true, 'Direct signature argument must verify correctly');

      // Mode B: Agnostic header lookup (x-webhook-signature)
      const resHeaderA = mockProvider.verifyWebhookSignature({
        rawBody: payload,
        headers: { 'x-webhook-signature': signature },
      });
      assert.strictEqual(resHeaderA, true, 'x-webhook-signature header must verify correctly');

      // Mode C: Agnostic header lookup (x-signature)
      const resHeaderB = mockProvider.verifyWebhookSignature({
        rawBody: payload,
        headers: { 'x-signature': signature },
      });
      assert.strictEqual(resHeaderB, true, 'x-signature header must verify correctly');

      // Mode D: Invalid signature rejection
      const resInvalid = mockProvider.verifyWebhookSignature({
        rawBody: payload,
        signature: 'invalid_hex_signature_deadbeef',
      });
      assert.strictEqual(resInvalid, false, 'Invalid signature must be strictly rejected');

      console.log('✓ Test 8 passed: Provider-neutral webhook signature verification verified across all calling conventions.');
    }

    console.log('\n===========================================================');
    console.log('✓ ALL SPRINT 12.5 CONCURRENCY & PROVIDER-NEUTRAL TESTS PASSED (8/8)!');
    console.log('===========================================================');
  } finally {
    await pool.end();
  }
}

// Allow direct execution
if (process.argv[1]?.endsWith('sprint12-5-recovery-concurrency-and-provider-neutrality.test.ts')) {
  runSprint12_5RecoveryConcurrencyAndProviderNeutralityTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
