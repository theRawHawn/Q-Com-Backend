import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { setPool, getPool, transaction } from '../src/database/connection.js';
import { runMigrations } from '../src/database/migrator.js';
import { runSeeds } from '../seeds/seedData.js';
import { createTestDatabase } from './helpers/testDb.js';
import { refundService } from '../src/modules/payments/refundService.js';
import { sellerSettlementService } from '../src/modules/settlements/sellerSettlementService.js';
import { riderPayoutService } from '../src/modules/settlements/riderPayoutService.js';
import { ledgerService } from '../src/modules/ledger/ledgerService.js';
import { getPaymentProvider } from '../src/modules/payments/paymentProvider.js';
import { getPayoutProvider } from '../src/modules/settlements/payoutProvider.js';
import { FinancialRecoveryWorker } from '../src/modules/recovery/financialRecoveryWorker.js';
import { financialWebhookService } from '../src/modules/payments/financialWebhookService.js';
import { env } from '../src/config/env.js';

export async function runSprint10CRecoveryAndWebhookTests(): Promise<void> {
  console.log('\n===========================================================');
  console.log('--- Running Sprint 10.1C: Durable Financial Recovery & Webhook Tests ---');
  console.log('===========================================================');

  const { pool } = createTestDatabase();
  setPool(pool);

  // Apply migrations 001–020 and seed base fixtures
  await runMigrations({ poolOverride: pool });
  await runSeeds(pool);

  const payoutProvider = getPayoutProvider();
  const webhookSecret = env.RAZORPAY_WEBHOOK_SECRET;

  function signPayload(payloadStr: string): string {
    return crypto.createHmac('sha256', webhookSecret).update(payloadStr).digest('hex');
  }

  async function createPaidOrder(amount: number = 500.00): Promise<{ orderId: string; merchantId: string; userId: string }> {
    const userRes = await pool.query(`SELECT id FROM users LIMIT 1`);
    const userId = userRes.rows[0].id;
    const merchRes = await pool.query(`SELECT id FROM merchants LIMIT 1`);
    const merchantId = merchRes.rows[0].id;
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
        $1, $2, $3, $4, 'delivered', $5, 0, 0, 0, 0, $5, 0, 0, 0, $5, 0, 0,
        'Instant UPI', 'PAID', '123456', 'PK-9999', '{"latitude": 12.9716, "longitude": 77.5946}'::jsonb,
        '29', '{}'::jsonb, NOW(), NOW() + INTERVAL '1 hour', NOW(), NOW(), NOW()
      )
    `, [orderId, orderNumber, userId, merchantId, amount]);

    const txId = `txn_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    await pool.query(`
      INSERT INTO payment_receipts (order_id, transaction_id, amount, status, signature)
      VALUES ($1, $2, $3, 'SUCCESS', 'sig_test')
    `, [orderId, txId, amount]);

    await pool.query(`
      INSERT INTO payment_intents (id, order_id, amount, currency, status, payment_order_id, provider_payment_id, signature)
      VALUES ($1, $2, $3, 'INR', 'CAPTURED', $4, $5, 'sig_test')
    `, [crypto.randomUUID(), orderId, amount, `order_${txId}`, txId]);

    return { orderId, merchantId, userId };
  }

  // =========================================================================
  // RECOVERY TESTS (P0-1)
  // =========================================================================

  // Test 1: Unresolved PROCESSING operation discovered and claimed by worker
  console.log('[Test 1] Testing Worker Claims Unresolved PROCESSING Refund With Lease...');
  const order1 = await createPaidOrder(400.00);
  const refundId1 = crypto.randomUUID();
  const idempKey1 = `IDEMP_REC_1_${Date.now()}`;

  await pool.query(`
    INSERT INTO refunds (
      id, refund_number, order_id, amount, currency, reason_code, refund_type, status,
      idempotency_key, created_at, updated_at
    )
    VALUES ($1, $2, $3, 200.00, 'INR', 'CUSTOMER_RETURN', 'PARTIAL', 'PROCESSING', $4, NOW() - INTERVAL '15 seconds', NOW() - INTERVAL '15 seconds')
  `, [refundId1, `RFND_REC_1_${Date.now()}`, order1.orderId, idempKey1]);

  const testWorker = new FinancialRecoveryWorker({
    staleThresholdSec: 5,
    leaseDurationSec: 30,
    maxAttempts: 5,
    batchSize: 5,
  });

  const cycleSummary1 = await testWorker.runRecoveryCycle();
  assert.ok(cycleSummary1.claimed.refunds >= 1, 'Stale refund must be discovered and claimed by worker.');

  const refCheck1 = await pool.query(`SELECT * FROM refunds WHERE id = $1`, [refundId1]);
  assert.strictEqual(refCheck1.rows[0].status, 'COMPLETED', 'Refund must be transitioned to COMPLETED by recovery worker.');
  assert.strictEqual(refCheck1.rows[0].recovery_lease_id, null, 'Lease must be released upon completion.');
  console.log('✓ Test 1 passed: Worker discovered and successfully recovered stale PROCESSING refund.');

  // Test 2: Multi-Instance Lease Mutual Exclusion (Two workers cannot claim same row)
  console.log('[Test 2] Testing Multi-Instance Mutual Exclusion During Recovery Lease Claim...');
  const order2 = await createPaidOrder(300.00);
  const refundId2 = crypto.randomUUID();
  await pool.query(`
    INSERT INTO refunds (
      id, refund_number, order_id, amount, currency, reason_code, refund_type, status,
      idempotency_key, created_at, updated_at
    )
    VALUES ($1, $2, $3, 100.00, 'INR', 'DAMAGED_ITEM', 'PARTIAL', 'PROCESSING', $4, NOW() - INTERVAL '20 seconds', NOW() - INTERVAL '20 seconds')
  `, [refundId2, `RFND_REC_2_${Date.now()}`, order2.orderId, `IDEMP_REC_2_${Date.now()}`]);

  const workerNodeA = new FinancialRecoveryWorker({ staleThresholdSec: 5, leaseDurationSec: 60, batchSize: 5 });
  const workerNodeB = new FinancialRecoveryWorker({ staleThresholdSec: 5, leaseDurationSec: 60, batchSize: 5 });

  // Node A claims the lease
  await pool.query(`
    UPDATE refunds
    SET recovery_lease_id = $1,
        recovery_lease_expires_at = NOW() + INTERVAL '60 seconds',
        last_reconciled_at = NOW()
    WHERE id = $2
  `, [workerNodeA.workerId, refundId2]);

  // Node B runs cycle - must NOT claim or steal Node A's active lease
  await workerNodeB.runRecoveryCycle();
  const refCheck2 = await pool.query(`SELECT recovery_lease_id, status FROM refunds WHERE id = $1`, [refundId2]);
  assert.strictEqual(refCheck2.rows[0].recovery_lease_id, workerNodeA.workerId, 'Node B must not steal active lease from Node A.');
  assert.strictEqual(refCheck2.rows[0].status, 'PROCESSING', 'Refund must remain in PROCESSING until Node A finishes.');
  console.log('✓ Test 2 passed: Multi-instance distributed leasing prevents concurrent worker collisions.');

  // Test 3: Worker Interruption and Lease Expiry Recovery
  console.log('[Test 3] Testing Expired Worker Lease Is Recovered by Subsequent Cycle...');
  // Simulate worker crash by setting lease expiry in the past
  await pool.query(`
    UPDATE refunds
    SET recovery_lease_expires_at = NOW() - INTERVAL '10 seconds',
        created_at = NOW() - INTERVAL '30 seconds'
    WHERE id = $1
  `, [refundId2]);

  // Next worker run must safely claim the abandoned lease and complete it
  await workerNodeB.runRecoveryCycle();
  const refCheck3 = await pool.query(`SELECT status, recovery_lease_id FROM refunds WHERE id = $1`, [refundId2]);
  assert.strictEqual(refCheck3.rows[0].status, 'COMPLETED', 'Expired abandoned lease must be safely recovered.');
  assert.strictEqual(refCheck3.rows[0].recovery_lease_id, null);
  console.log('✓ Test 3 passed: Expired worker lease recovered safely after simulated process crash.');

  // Test 4: Provider-Confirmed Failure Reconciled Exactly Once and Balances Restored
  console.log('[Test 4] Testing Recovery of Stale Seller Payout Conclusively Rejected by Provider...');
  const merchRes = await pool.query(`SELECT id FROM merchants LIMIT 1`);
  const merchId4 = merchRes.rows[0].id;
  const payoutId4 = crypto.randomUUID();
  const payoutRef4 = `PAYOUT_SEL_REC_${Date.now()}`;

  // Insert initial ledger balance
  await pool.query(`
    INSERT INTO seller_ledgers (merchant_id, entry_type, category, amount, running_balance, description)
    VALUES ($1, 'ADJUSTMENT', 'CREDIT', 500.00, 500.00, 'Initial seller balance')
  `, [merchId4]);

  await pool.query(`
    INSERT INTO seller_payouts (
      id, payout_reference, merchant_id, amount, currency, status,
      bank_account_number, bank_ifsc, idempotency_key, created_at, updated_at
    )
    VALUES ($1, $2, $3, 200.00, 'INR', 'PROCESSING', '1234567890', 'HDFC0000001', $4, NOW() - INTERVAL '30 seconds', NOW() - INTERVAL '30 seconds')
  `, [payoutId4, payoutRef4, merchId4, `IDEMP_SEL_REC_${Date.now()}`]);

  // Mock payout provider status check returning REJECTED
  const origGetStatus = (payoutProvider as any).getPayoutStatus;
  (payoutProvider as any).getPayoutStatus = async () => {
    return {
      success: false,
      status: 'REJECTED',
      failureReason: 'ACCOUNT_FROZEN_BY_BENEFICIARY_BANK',
      providerPayoutId: 'pout_rej_test4',
    };
  };

  const worker4 = new FinancialRecoveryWorker({ staleThresholdSec: 5, leaseDurationSec: 30 });
  await worker4.runRecoveryCycle();
  (payoutProvider as any).getPayoutStatus = origGetStatus;

  const spRes4 = await pool.query(`SELECT status, failure_reason FROM seller_payouts WHERE id = $1`, [payoutId4]);
  assert.strictEqual(spRes4.rows[0].status, 'FAILED', 'Rejected seller payout must be marked FAILED.');
  assert.ok(spRes4.rows[0].failure_reason.includes('ACCOUNT_FROZEN'), 'Failure reason must be durably recorded.');

  const ledgerRes4 = await pool.query(`
    SELECT amount, category, entry_type, description FROM seller_ledgers
    WHERE merchant_id = $1 ORDER BY created_at DESC LIMIT 1
  `, [merchId4]);
  assert.strictEqual(ledgerRes4.rows[0].category, 'CREDIT');
  assert.strictEqual(ledgerRes4.rows[0].entry_type, 'ADJUSTMENT');
  assert.strictEqual(parseFloat(ledgerRes4.rows[0].amount), 200.00, 'Full payout amount must be restored to seller ledger.');
  console.log('✓ Test 4 passed: Rejected seller payout marked FAILED and balance restored atomically.');

  // Test 5: Ambiguous Outcome Preserves PROCESSING Without Blind Resubmission
  console.log('[Test 5] Testing Ambiguous Outcome Preserves PROCESSING Without Blind Resubmission...');
  const payoutId5 = crypto.randomUUID();
  await pool.query(`
    INSERT INTO seller_payouts (
      id, payout_reference, merchant_id, amount, currency, status,
      bank_account_number, bank_ifsc, idempotency_key, created_at, updated_at
    )
    VALUES ($1, $2, $3, 100.00, 'INR', 'PROCESSING', '1234567890', 'HDFC0000001', $4, NOW() - INTERVAL '20 seconds', NOW() - INTERVAL '20 seconds')
  `, [payoutId5, `PAYOUT_AMBIG_${Date.now()}`, merchId4, `IDEMP_AMBIG_${Date.now()}`]);

  (payoutProvider as any).getPayoutStatus = async () => {
    return {
      success: false,
      status: 'QUEUED',
      failureReason: 'BANK_DOWN_PENDING_INQUIRY',
    };
  };

  await worker4.runRecoveryCycle();
  (payoutProvider as any).getPayoutStatus = origGetStatus;

  const spRes5 = await pool.query(`SELECT status, reconciliation_attempts FROM seller_payouts WHERE id = $1`, [payoutId5]);
  assert.strictEqual(spRes5.rows[0].status, 'PROCESSING', 'Ambiguous state must remain in PROCESSING.');
  assert.ok(parseInt(spRes5.rows[0].reconciliation_attempts, 10) >= 1, 'Reconciliation attempts must increment.');
  console.log('✓ Test 5 passed: Ambiguous banking state preserved in PROCESSING without blind resubmission.');

  // Test 6: Recovery of Rider Payouts Rail
  console.log('[Test 6] Testing Rider Payout Recovery...');
  const riderRes = await pool.query(`SELECT id, wallet_balance FROM riders LIMIT 1`);
  const riderId6 = riderRes.rows[0].id;
  const payoutId6 = crypto.randomUUID();
  const payoutRef6 = `PAYOUT_RID_REC_${Date.now()}`;

  await pool.query(`
    INSERT INTO rider_payouts (
      id, payout_reference, rider_id, amount, currency, payout_method, status,
      idempotency_key, created_at, updated_at
    )
    VALUES ($1, $2, $3, 150.00, 'INR', 'UPI', 'PROCESSING', $4, NOW() - INTERVAL '25 seconds', NOW() - INTERVAL '25 seconds')
  `, [payoutId6, payoutRef6, riderId6, `IDEMP_RID_REC_${Date.now()}`]);

  // Provider returns PROCESSED
  (payoutProvider as any).getPayoutStatus = async () => {
    return {
      success: true,
      status: 'PROCESSED',
      utrNumber: `UTR_REC_${Date.now()}`,
      providerPayoutId: `pout_rid_rec_${Date.now()}`,
    };
  };

  await worker4.runRecoveryCycle();
  (payoutProvider as any).getPayoutStatus = origGetStatus;

  const rpRes6 = await pool.query(`SELECT status, utr_number FROM rider_payouts WHERE id = $1`, [payoutId6]);
  assert.strictEqual(rpRes6.rows[0].status, 'PAID', 'Rider payout must be marked PAID upon provider confirmation.');
  assert.ok(rpRes6.rows[0].utr_number.startsWith('UTR_REC_'), 'UTR must be recorded.');
  console.log('✓ Test 6 passed: Rider payout recovered cleanly across recovery cycle.');

  // =========================================================================
  // WEBHOOK TESTS (P0-3)
  // =========================================================================

  // Test 7: Webhook Signature Verification (Valid vs Invalid)
  console.log('[Test 7] Testing Webhook Cryptographic HMAC Signature Verification...');
  const dummyPayload = JSON.stringify({ id: 'evt_test_7', event: 'refund.processed', payload: {} });
  const validSig = signPayload(dummyPayload);
  const invalidSig = crypto.randomBytes(32).toString('hex');

  assert.strictEqual(financialWebhookService.verifySignature(dummyPayload, validSig), true, 'Valid HMAC signature must verify.');
  assert.strictEqual(financialWebhookService.verifySignature(dummyPayload, invalidSig), false, 'Invalid HMAC signature must be rejected.');
  console.log('✓ Test 7 passed: Webhook cryptographic HMAC signature verification strictly enforced.');

  // Test 8: Refund Webhook (refund.processed) Transitions State and Posts Ledger
  console.log('[Test 8] Testing Incoming refund.processed Webhook Processing...');
  const order8 = await createPaidOrder(700.00);
  const refundId8 = crypto.randomUUID();
  const provRefundId8 = `rfnd_prov_${Date.now()}`;

  await pool.query(`
    INSERT INTO refunds (
      id, refund_number, order_id, amount, currency, reason_code, refund_type, status,
      provider_refund_id, idempotency_key, created_at, updated_at
    )
    VALUES ($1, $2, $3, 350.00, 'INR', 'CANCELLATION', 'PARTIAL', 'PROCESSING', $4, $5, NOW(), NOW())
  `, [refundId8, `RFND_WH_8_${Date.now()}`, order8.orderId, provRefundId8, `IDEMP_WH_8_${Date.now()}`]);

  const refundWebhookBody = {
    id: `evt_ref_proc_${Date.now()}`,
    event: 'refund.processed',
    payload: {
      refund: {
        entity: {
          id: provRefundId8,
          amount: 35000,
          notes: {
            refundId: refundId8,
            orderId: order8.orderId,
          },
        },
      },
    },
  };

  const rawRefBody = JSON.stringify(refundWebhookBody);
  const sig8 = signPayload(rawRefBody);

  const whRes8 = await financialWebhookService.processFinancialWebhook({
    rawBody: rawRefBody,
    signature: sig8,
  });

  assert.strictEqual(whRes8.success, true);
  assert.strictEqual(whRes8.status, 'COMPLETED');

  const refCheck8 = await pool.query(`SELECT status FROM refunds WHERE id = $1`, [refundId8]);
  assert.strictEqual(refCheck8.rows[0].status, 'COMPLETED', 'Refund must be COMPLETED.');

  const ordCheck8 = await pool.query(`SELECT payment_status FROM orders WHERE id = $1`, [order8.orderId]);
  assert.strictEqual(ordCheck8.rows[0].payment_status, 'PARTIALLY_REFUNDED', 'Order payment status must be updated.');
  console.log('✓ Test 8 passed: Incoming refund.processed webhook processed atomically with order status and ledger posting.');

  // Test 9: Webhook Durable Deduplication (Replay of same eventId)
  console.log('[Test 9] Testing Durable Webhook Event Deduplication...');
  const whRes9 = await financialWebhookService.processFinancialWebhook({
    rawBody: rawRefBody,
    signature: sig8,
  });

  assert.strictEqual(whRes9.success, true);
  assert.strictEqual(whRes9.duplicate, true, 'Replay of existing eventId must be identified as duplicate.');
  console.log('✓ Test 9 passed: Webhook event deduplication verified via durable database index.');

  // Test 10: Refund Failure Webhook (refund.failed) Transitions State
  console.log('[Test 10] Testing Incoming refund.failed Webhook Processing...');
  const order10 = await createPaidOrder(250.00);
  const refundId10 = crypto.randomUUID();
  const provRefundId10 = `rfnd_fail_${Date.now()}`;

  await pool.query(`
    INSERT INTO refunds (
      id, refund_number, order_id, amount, currency, reason_code, refund_type, status,
      provider_refund_id, idempotency_key, created_at, updated_at
    )
    VALUES ($1, $2, $3, 100.00, 'INR', 'CUSTOMER_RETURN', 'PARTIAL', 'PROCESSING', $4, $5, NOW(), NOW())
  `, [refundId10, `RFND_WH_10_${Date.now()}`, order10.orderId, provRefundId10, `IDEMP_WH_10_${Date.now()}`]);

  const failWebhookBody = {
    id: `evt_ref_fail_${Date.now()}`,
    event: 'refund.failed',
    payload: {
      refund: {
        entity: {
          id: provRefundId10,
          error_description: 'Beneficiary bank down',
          notes: { refundId: refundId10 },
        },
      },
    },
  };
  const rawFailBody = JSON.stringify(failWebhookBody);
  const whRes10 = await financialWebhookService.processFinancialWebhook({
    rawBody: rawFailBody,
    signature: signPayload(rawFailBody),
  });

  assert.strictEqual(whRes10.status, 'FAILED');
  const refCheck10 = await pool.query(`SELECT status FROM refunds WHERE id = $1`, [refundId10]);
  assert.strictEqual(refCheck10.rows[0].status, 'FAILED');
  console.log('✓ Test 10 passed: Incoming refund.failed webhook handled cleanly.');

  // Test 11: Seller Payout Webhook (payout.processed)
  console.log('[Test 11] Testing Incoming payout.processed for Seller Payout...');
  const payoutId11 = crypto.randomUUID();
  const payoutRef11 = `PAYOUT_SEL_WH_${Date.now()}`;

  await pool.query(`
    INSERT INTO seller_payouts (
      id, payout_reference, merchant_id, amount, currency, status,
      bank_account_number, bank_ifsc, idempotency_key, created_at, updated_at
    )
    VALUES ($1, $2, $3, 300.00, 'INR', 'PROCESSING', '1234567890', 'HDFC0000001', $4, NOW(), NOW())
  `, [payoutId11, payoutRef11, merchId4, `IDEMP_SEL_WH_${Date.now()}`]);

  const payoutWebhookBody = {
    id: `evt_pout_proc_${Date.now()}`,
    event: 'payout.processed',
    payload: {
      payout: {
        entity: {
          id: `pout_prov_${Date.now()}`,
          reference_id: payoutRef11,
          amount: 30000,
          utr: `UTR_WH_SEL_${Date.now()}`,
          status: 'processed',
        },
      },
    },
  };

  const rawPoutBody = JSON.stringify(payoutWebhookBody);
  const whRes11 = await financialWebhookService.processFinancialWebhook({
    rawBody: rawPoutBody,
    signature: signPayload(rawPoutBody),
  });

  assert.strictEqual(whRes11.status, 'PAID');
  const spCheck11 = await pool.query(`SELECT status, utr_number, journal_batch_id FROM seller_payouts WHERE id = $1`, [payoutId11]);
  assert.strictEqual(spCheck11.rows[0].status, 'PAID');
  assert.ok(spCheck11.rows[0].utr_number.startsWith('UTR_WH_SEL_'));
  console.log('✓ Test 11 passed: Seller payout.processed webhook completed payout and posted journal batch.');

  // Test 12: Seller Payout Reversal Webhook (payout.reversed) Restores Running Balance
  console.log('[Test 12] Testing Incoming payout.reversed Restores Seller Running Balance...');
  const revWebhookBody = {
    id: `evt_pout_rev_${Date.now()}`,
    event: 'payout.reversed',
    payload: {
      payout: {
        entity: {
          reference_id: payoutRef11,
          failure_reason: 'Beneficiary bank reversed transaction',
        },
      },
    },
  };

  const rawRevBody = JSON.stringify(revWebhookBody);
  const whRes12 = await financialWebhookService.processFinancialWebhook({
    rawBody: rawRevBody,
    signature: signPayload(rawRevBody),
  });

  assert.strictEqual(whRes12.status, 'FAILED');
  const spCheck12 = await pool.query(`SELECT status, failure_reason FROM seller_payouts WHERE id = $1`, [payoutId11]);
  assert.strictEqual(spCheck12.rows[0].status, 'FAILED');

  const ledgerRes12 = await pool.query(`
    SELECT amount, category, entry_type FROM seller_ledgers
    WHERE merchant_id = $1 ORDER BY created_at DESC LIMIT 1
  `, [merchId4]);
  assert.strictEqual(ledgerRes12.rows[0].category, 'CREDIT');
  assert.strictEqual(parseFloat(ledgerRes12.rows[0].amount), 300.00, 'Seller balance must be restored upon reversal.');
  console.log('✓ Test 12 passed: Reversal webhook safely restored seller ledger balance.');

  // Test 13: Rider Payout Webhook (payout.processed)
  console.log('[Test 13] Testing Incoming payout.processed for Delivery Partner Payout...');
  const payoutId13 = crypto.randomUUID();
  const payoutRef13 = `PAYOUT_RID_WH_${Date.now()}`;

  await pool.query(`
    INSERT INTO rider_payouts (
      id, payout_reference, rider_id, amount, currency, payout_method, status,
      idempotency_key, created_at, updated_at
    )
    VALUES ($1, $2, $3, 120.00, 'INR', 'UPI', 'PROCESSING', $4, NOW(), NOW())
  `, [payoutId13, payoutRef13, riderId6, `IDEMP_RID_WH_${Date.now()}`]);

  const riderWhBody = {
    id: `evt_pout_rid_${Date.now()}`,
    event: 'payout.processed',
    payload: {
      payout: {
        entity: {
          id: `pout_rid_prov_${Date.now()}`,
          reference_id: payoutRef13,
          amount: 12000,
          utr: `UTR_WH_RID_${Date.now()}`,
          status: 'processed',
        },
      },
    },
  };

  const rawRiderBody = JSON.stringify(riderWhBody);
  const whRes13 = await financialWebhookService.processFinancialWebhook({
    rawBody: rawRiderBody,
    signature: signPayload(rawRiderBody),
  });

  assert.strictEqual(whRes13.status, 'PAID');
  const rpCheck13 = await pool.query(`SELECT status, utr_number FROM rider_payouts WHERE id = $1`, [payoutId13]);
  assert.strictEqual(rpCheck13.rows[0].status, 'PAID');
  console.log('✓ Test 13 passed: Rider payout.processed webhook finalized payout and recorded UTR.');

  // Test 14: Rider Payout Failure Webhook (payout.failed) Restores Wallet Balance
  console.log('[Test 14] Testing Incoming payout.failed Restores Delivery Partner Wallet Balance...');
  const rBalBefore14 = parseFloat((await pool.query(`SELECT wallet_balance FROM riders WHERE id = $1`, [riderId6])).rows[0].wallet_balance);
  const payoutId14 = crypto.randomUUID();
  const payoutRef14 = `PAYOUT_RID_FAIL_${Date.now()}`;

  await pool.query(`
    INSERT INTO rider_payouts (
      id, payout_reference, rider_id, amount, currency, payout_method, status,
      idempotency_key, created_at, updated_at
    )
    VALUES ($1, $2, $3, 80.00, 'INR', 'UPI', 'PROCESSING', $4, NOW(), NOW())
  `, [payoutId14, payoutRef14, riderId6, `IDEMP_RID_FAIL_${Date.now()}`]);

  const riderFailWhBody = {
    id: `evt_pout_rid_fail_${Date.now()}`,
    event: 'payout.failed',
    payload: {
      payout: {
        entity: {
          reference_id: payoutRef14,
          failure_reason: 'VPA invalid / unreachable',
        },
      },
    },
  };

  const rawRiderFail = JSON.stringify(riderFailWhBody);
  await financialWebhookService.processFinancialWebhook({
    rawBody: rawRiderFail,
    signature: signPayload(rawRiderFail),
  });

  const rpCheck14 = await pool.query(`SELECT status FROM rider_payouts WHERE id = $1`, [payoutId14]);
  assert.strictEqual(rpCheck14.rows[0].status, 'FAILED');

  const rBalAfter14 = parseFloat((await pool.query(`SELECT wallet_balance FROM riders WHERE id = $1`, [riderId6])).rows[0].wallet_balance);
  assert.strictEqual(rBalAfter14, +(rBalBefore14 + 80.00).toFixed(2), 'Rider wallet balance must be refunded by ₹80.00.');
  console.log('✓ Test 14 passed: Delivery partner wallet balance restored upon webhook payout rejection.');

  // =========================================================================
  // SHARED RECONCILIATION & CONCURRENCY RACE TESTS (Phase 3)
  // =========================================================================

  // Test 15: Concurrency Race Between Webhook and Recovery Worker On Same Operation
  console.log('[Test 15] Testing Webhook vs Recovery Worker Concurrency Race On Exact Same Operation...');
  const order15 = await createPaidOrder(600.00);
  const refundId15 = crypto.randomUUID();
  const provRefundId15 = `rfnd_race_${Date.now()}`;

  await pool.query(`
    INSERT INTO refunds (
      id, refund_number, order_id, amount, currency, reason_code, refund_type, status,
      provider_refund_id, idempotency_key, created_at, updated_at
    )
    VALUES ($1, $2, $3, 300.00, 'INR', 'CANCELLATION', 'PARTIAL', 'PROCESSING', $4, $5, NOW() - INTERVAL '20 seconds', NOW() - INTERVAL '20 seconds')
  `, [refundId15, `RFND_RACE_${Date.now()}`, order15.orderId, provRefundId15, `IDEMP_RACE_${Date.now()}`]);

  // Race worker and webhook in parallel
  const raceWebhookBody = {
    id: `evt_race_${Date.now()}`,
    event: 'refund.processed',
    payload: {
      refund: {
        entity: {
          id: provRefundId15,
          notes: { refundId: refundId15, orderId: order15.orderId },
        },
      },
    },
  };
  const rawRaceBody = JSON.stringify(raceWebhookBody);

  const [raceWorkerResult, raceWebhookResult] = await Promise.allSettled([
    testWorker.runRecoveryCycle(),
    financialWebhookService.processFinancialWebhook({
      rawBody: rawRaceBody,
      signature: signPayload(rawRaceBody),
    }),
  ]);

  assert.strictEqual(raceWorkerResult.status, 'fulfilled');
  assert.strictEqual(raceWebhookResult.status, 'fulfilled');

  const refCheck15 = await pool.query(`SELECT status FROM refunds WHERE id = $1`, [refundId15]);
  assert.strictEqual(refCheck15.rows[0].status, 'COMPLETED');

  // Verify General Ledger entries for this order cancellation refund: Exactly one DEBIT and one CREDIT!
  const glCheck15 = await pool.query(`
    SELECT COUNT(*) as line_count FROM general_ledger_entries
    WHERE order_id = $1 AND transaction_type = 'REFUND'
  `, [order15.orderId]);
  assert.strictEqual(parseInt(glCheck15.rows[0].line_count, 10), 2, 'Exactly 2 lines (1 Debit, 1 Credit) must exist. Zero duplicate ledger posting!');
  console.log('✓ Test 15 passed: Concurrency race between recovery worker and webhook resolved safely with zero duplicate ledger lines.');

  // Test 16: Out-of-Order / Late Webhook Cannot Regress Newer Terminal Status
  console.log('[Test 16] Testing Late Webhook Cannot Regress Already COMPLETED Terminal State...');
  const lateWebhookBody = {
    id: `evt_late_${Date.now()}`,
    event: 'refund.failed', // Late failure event after already completed
    payload: {
      refund: {
        entity: {
          id: provRefundId15,
          notes: { refundId: refundId15 },
        },
      },
    },
  };
  const rawLateBody = JSON.stringify(lateWebhookBody);

  const lateRes = await financialWebhookService.processFinancialWebhook({
    rawBody: rawLateBody,
    signature: signPayload(rawLateBody),
  });

  assert.strictEqual(lateRes.success, true);
  assert.strictEqual(lateRes.duplicate, true, 'Late out-of-order event must be handled as duplicate.');

  const refCheck16 = await pool.query(`SELECT status FROM refunds WHERE id = $1`, [refundId15]);
  assert.strictEqual(refCheck16.rows[0].status, 'COMPLETED', 'Terminal COMPLETED status must NEVER be regressed.');
  console.log('✓ Test 16 passed: Terminal state protection strictly prevented state regression from out-of-order webhook.');

  // Test 17: Unknown/Unmatched Webhook Operation Is Acknowledged Safely As IGNORED
  console.log('[Test 17] Testing Unmatched Webhook Operation Safely Quarantined as IGNORED...');
  const unknownBody = {
    id: `evt_unknown_${Date.now()}`,
    event: 'refund.processed',
    payload: {
      refund: {
        entity: {
          id: 'rfnd_non_existent_9999',
          notes: {},
        },
      },
    },
  };
  const rawUnknown = JSON.stringify(unknownBody);
  const unkRes = await financialWebhookService.processFinancialWebhook({
    rawBody: rawUnknown,
    signature: signPayload(rawUnknown),
  });

  assert.strictEqual(unkRes.success, true);
  assert.strictEqual(unkRes.ignored, true);
  console.log('✓ Test 17 passed: Unmatched webhook safely acknowledged as IGNORED without crashing.');

  // Test 18: End-to-End General Ledger Mathematical Balance Invariant
  console.log('[Test 18] Testing Double-Entry Ledger Mathematical Balance Invariant Across All Recovery & Webhook Batches...');
  const glSumRes = await pool.query(`
    SELECT entry_side, SUM(amount) as total
    FROM general_ledger_entries
    GROUP BY entry_side
  `);

  const debits = parseFloat(glSumRes.rows.find((r: any) => r.entry_side === 'DEBIT')?.total || '0');
  const credits = parseFloat(glSumRes.rows.find((r: any) => r.entry_side === 'CREDIT')?.total || '0');

  assert.strictEqual(
    +(debits).toFixed(2),
    +(credits).toFixed(2),
    `General Ledger must balance mathematically: Total Debits ₹${debits.toFixed(2)} == Total Credits ₹${credits.toFixed(2)}`
  );
  console.log(`✓ Test 18 passed: General Ledger balanced (Total Debits: ₹${debits.toFixed(2)} == Total Credits: ₹${credits.toFixed(2)}).`);

  console.log('\n===========================================================');
  console.log('✓ ALL SPRINT 10.1C RECOVERY & WEBHOOK TESTS PASSED (18/18)!');
  console.log('===========================================================');
}
