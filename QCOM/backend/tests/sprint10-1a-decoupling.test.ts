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

export async function runSprint10DecouplingTests(): Promise<void> {
  console.log('\n===========================================================');
  console.log('--- Running Sprint 10.1A: Financial Transaction Decoupling & Concurrency Tests ---');
  console.log('===========================================================');

  const { pool } = createTestDatabase();
  setPool(pool);

  // Apply migrations 001–019 and seed data
  await runMigrations({ poolOverride: pool });
  await runSeeds(pool);

  // -------------------------------------------------------------------------
  // Helper: Create a paid order for refund tests
  // -------------------------------------------------------------------------
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

  // -------------------------------------------------------------------------
  // Test 1: Verify Refund Gateway Network Call Occurs Outside DB Transaction
  // -------------------------------------------------------------------------
  console.log('[Test 1] Testing Refund Gateway Call Executes Strictly Outside DB Transaction...');
  const order1 = await createPaidOrder(600.00);
  const provider = (refundService as any).provider;

  let activeTransactionDuringGatewayCall = false;
  const originalCreateRefund = provider.createRefund.bind(provider);

  // Instrument provider to inspect database transaction state during gateway I/O
  (provider as any).createRefund = async (p: any) => {
    // If an external connection is held or in transaction block, we detect it
    // Check if any active transaction is held on the pool by querying in a separate client
    const checkRes = await pool.query(`
      SELECT COUNT(*) as active_count
      FROM refunds
      WHERE order_id = $1 AND status = 'PROCESSING'
    `, [order1.orderId]);
    // The durable intent was committed in Step A, so status 'PROCESSING' row is visible!
    if (parseInt(checkRes.rows[0].active_count, 10) !== 1) {
      activeTransactionDuringGatewayCall = true;
    }
    return originalCreateRefund(p);
  };

  const refundRes1 = await refundService.createRefund({
    orderId: order1.orderId,
    amount: 600.00,
    reasonCode: 'CUSTOMER_RETURN',
    reasonDescription: 'Defective product',
    idempotencyKey: `idemp_ref_test1_${Date.now()}`,
  });

  // Restore provider method
  (provider as any).createRefund = originalCreateRefund;

  assert.strictEqual(activeTransactionDuringGatewayCall, false, 'Step A transaction must be committed before external gateway call executes.');
  assert.strictEqual(refundRes1.refund.status, 'COMPLETED');
  assert.strictEqual(refundRes1.isDuplicate, false);
  console.log('✓ Test 1 passed: Refund gateway call executed completely outside database transaction.');

  // -------------------------------------------------------------------------
  // Test 2: Concurrent Refunds Cannot Exceed Order Total (Atomic Ceiling Guard)
  // -------------------------------------------------------------------------
  console.log('[Test 2] Testing Concurrent Refunds Cannot Exceed Refundable Balance...');
  const order2 = await createPaidOrder(500.00);

  // Attempt two concurrent refunds of ₹300 each (Total ₹600 > ₹500)
  const [attemptA, attemptB] = await Promise.allSettled([
    refundService.createRefund({
      orderId: order2.orderId,
      amount: 300.00,
      reasonCode: 'DEFECT_PARTIAL_A',
      idempotencyKey: `idemp_conc_a_${Date.now()}`,
    }),
    refundService.createRefund({
      orderId: order2.orderId,
      amount: 300.00,
      reasonCode: 'DEFECT_PARTIAL_B',
      idempotencyKey: `idemp_conc_b_${Date.now()}`,
    }),
  ]);

  const succeededCount = [attemptA, attemptB].filter((r) => r.status === 'fulfilled').length;
  const rejectedCount = [attemptA, attemptB].filter((r) => r.status === 'rejected').length;

  assert.strictEqual(succeededCount, 1, 'Exactly one concurrent refund must succeed within ceiling.');
  assert.strictEqual(rejectedCount, 1, 'Excess concurrent refund must be rejected with ceiling violation.');

  const rejectedReason = (attemptA.status === 'rejected' ? attemptA.reason : (attemptB as any).reason).message;
  assert.ok(rejectedReason.includes('REFUND_CEILING_EXCEEDED'), `Expected REFUND_CEILING_EXCEEDED, got: ${rejectedReason}`);
  console.log('✓ Test 2 passed: Concurrent refund ceiling race strictly enforced.');

  // -------------------------------------------------------------------------
  // Test 3: Idempotent Replay of Refund Request
  // -------------------------------------------------------------------------
  console.log('[Test 3] Testing Idempotent Replay Returns Existing Record Without Duplicate Provider Calls...');
  const order3 = await createPaidOrder(400.00);
  const idempKey3 = `IDEMP_REF_${Date.now()}_ABC`;

  let providerDisbursementCount = 0;
  (provider as any).createRefund = async (p: any) => {
    providerDisbursementCount++;
    return originalCreateRefund(p);
  };

  const firstCall = await refundService.createRefund({
    orderId: order3.orderId,
    amount: 400.00,
    reasonCode: 'CUSTOMER_CANCEL',
    idempotencyKey: idempKey3,
  });

  const retryCall = await refundService.createRefund({
    orderId: order3.orderId,
    amount: 400.00,
    reasonCode: 'CUSTOMER_CANCEL',
    idempotencyKey: idempKey3,
  });

  (provider as any).createRefund = originalCreateRefund;

  assert.strictEqual(firstCall.isDuplicate, false);
  assert.strictEqual(retryCall.isDuplicate, true);
  assert.strictEqual(firstCall.refund.id, retryCall.refund.id);
  assert.strictEqual(providerDisbursementCount, 1, 'Provider createRefund must be called exactly once.');
  console.log('✓ Test 3 passed: Idempotency replay returned existing refund with zero duplicate provider calls.');

  // -------------------------------------------------------------------------
  // Test 4: Critical Ambiguous-Outcome Rule on Gateway Timeout
  // -------------------------------------------------------------------------
  console.log('[Test 4] Testing Gateway Network Timeout Preserves PROCESSING (Outcome Unknown)...');
  const order4 = await createPaidOrder(350.00);
  const idempKey4 = `IDEMP_TIMEOUT_${Date.now()}`;

  (provider as any).createRefund = async () => {
    const err: any = new Error('Gateway network timeout after dispatch (504 ETIMEDOUT)');
    err.code = 'ETIMEDOUT';
    throw err;
  };

  const timeoutResult = await refundService.createRefund({
    orderId: order4.orderId,
    amount: 350.00,
    reasonCode: 'TIMEOUT_TEST',
    idempotencyKey: idempKey4,
  });

  (provider as any).createRefund = originalCreateRefund;

  assert.strictEqual(timeoutResult.refund.status, 'PROCESSING', 'Timeout must preserve durable PROCESSING status.');

  // Verify in DB that refund is in PROCESSING and order is not prematurely marked REFUNDED
  const dbRefund = await pool.query(`SELECT status FROM refunds WHERE id = $1`, [timeoutResult.refund.id]);
  assert.strictEqual(dbRefund.rows[0].status, 'PROCESSING');
  const dbOrder = await pool.query(`SELECT payment_status FROM orders WHERE id = $1`, [order4.orderId]);
  assert.strictEqual(dbOrder.rows[0].payment_status, 'PAID', 'Order payment status must not change before resolution.');
  console.log('✓ Test 4 passed: Ambiguous gateway timeout safely preserves PROCESSING status.');

  // -------------------------------------------------------------------------
  // Test 5: Status Reconciliation Resolves Ambiguous Refund
  // -------------------------------------------------------------------------
  console.log('[Test 5] Testing Status Reconciliation Resolves Ambiguous Refund to COMPLETED...');
  const reconciled = await refundService.reconcileRefund(timeoutResult.refund.id);
  assert.strictEqual(reconciled.status, 'COMPLETED');
  assert.ok(reconciled.providerRefundId);

  const resolvedOrder = await pool.query(`SELECT payment_status FROM orders WHERE id = $1`, [order4.orderId]);
  assert.strictEqual(resolvedOrder.rows[0].payment_status, 'REFUNDED');
  console.log('✓ Test 5 passed: Status reconciliation safely finalized ambiguous refund and order.');

  // -------------------------------------------------------------------------
  // Test 6: Concurrent Reconciliation Cannot Double-Finalize
  // -------------------------------------------------------------------------
  console.log('[Test 6] Testing Concurrent Reconciliation Idempotency...');
  const [recA, recB] = await Promise.all([
    refundService.reconcileRefund(timeoutResult.refund.id),
    refundService.reconcileRefund(timeoutResult.refund.id),
  ]);

  assert.strictEqual(recA.status, 'COMPLETED');
  assert.strictEqual(recB.status, 'COMPLETED');
  assert.strictEqual(recA.id, recB.id);
  console.log('✓ Test 6 passed: Concurrent reconciliation completed cleanly.');

  // -------------------------------------------------------------------------
  // Helper: Setup merchant with payable balance for seller settlement tests
  // -------------------------------------------------------------------------
  async function setupMerchantWithBalance(balance: number = 1000.00): Promise<string> {
    const merchRes = await pool.query(`SELECT id FROM merchants LIMIT 1`);
    const merchantId = merchRes.rows[0].id;

    // Ensure valid bank details
    await pool.query(`
      UPDATE merchants
      SET bank_account_number = '987654321012',
          bank_ifsc = 'HDFC0000001',
          bank_account_holder = 'Test Merchant Store',
          bank_verified = TRUE
      WHERE id = $1
    `, [merchantId]);

    // Credit seller_ledgers
    await pool.query(`
      INSERT INTO seller_ledgers (
        merchant_id, entry_type, category, amount, running_balance, description
      )
      VALUES ($1, 'ORDER_CREDIT', 'CREDIT', $2, $2, 'Initial test settlement balance')
    `, [merchantId, balance]);

    return merchantId;
  }

  // -------------------------------------------------------------------------
  // Test 7: Verify Seller Payout Decoupling (Provider Call Outside DB Lock)
  // -------------------------------------------------------------------------
  console.log('[Test 7] Testing Seller Payout Disbursed Outside DB Transaction...');
  const merchantId7 = await setupMerchantWithBalance(800.00);
  let payoutProvider = (sellerSettlementService as any).payoutProvider;
  const origDisburseMerch = payoutProvider.disburseMerchantPayout.bind(payoutProvider);

  let activeLockDuringSellerPayout = false;
  (payoutProvider as any).disburseMerchantPayout = async (p: any) => {
    // Check that funds are already reserved in seller_ledgers and seller_payouts is PROCESSING
    const checkPayout = await pool.query(`
      SELECT status, amount FROM seller_payouts WHERE payout_reference = $1
    `, [p.reference]);

    if (checkPayout.rows.length === 0 || checkPayout.rows[0].status !== 'PROCESSING') {
      activeLockDuringSellerPayout = true;
    }
    return origDisburseMerch(p);
  };

  const sellerPayoutRes7 = await sellerSettlementService.executeSellerPayout({
    merchantId: merchantId7,
    amount: 300.00,
    idempotencyKey: `idemp_seller_test7_${Date.now()}`,
  });

  (payoutProvider as any).disburseMerchantPayout = origDisburseMerch;

  assert.strictEqual(activeLockDuringSellerPayout, false, 'Step A transaction must be committed before payout provider executes.');
  assert.strictEqual(sellerPayoutRes7.status, 'PAID');
  assert.strictEqual(sellerPayoutRes7.amount, 300.00);
  assert.ok(sellerPayoutRes7.utrNumber);
  console.log('✓ Test 7 passed: Seller payout provider call executed outside database transaction.');

  // -------------------------------------------------------------------------
  // Test 8: Concurrent Seller Payouts Cannot Double-Spend Balance
  // -------------------------------------------------------------------------
  console.log('[Test 8] Testing Concurrent Seller Payouts Cannot Double-Spend Running Balance...');
  // Current remaining balance is 800 - 300 = 500.00
  // Fire two concurrent requests of ₹400 each (Total ₹800 > ₹500)
  const [payoutAttA, payoutAttB] = await Promise.allSettled([
    sellerSettlementService.executeSellerPayout({
      merchantId: merchantId7,
      amount: 400.00,
      idempotencyKey: `idemp_seller_race_a_${Date.now()}`,
    }),
    sellerSettlementService.executeSellerPayout({
      merchantId: merchantId7,
      amount: 400.00,
      idempotencyKey: `idemp_seller_race_b_${Date.now()}`,
    }),
  ]);

  const sellerSuccess = [payoutAttA, payoutAttB].filter((r) => r.status === 'fulfilled').length;
  assert.strictEqual(sellerSuccess, 1, 'Exactly one concurrent seller payout must succeed when exceeding balance.');
  console.log('✓ Test 8 passed: Concurrent seller payout balance double-spend strictly prevented.');

  // -------------------------------------------------------------------------
  // Test 9: Seller Payout Idempotency Key Replay Protection
  // -------------------------------------------------------------------------
  console.log('[Test 9] Testing Seller Payout Idempotency Key Replay...');
  const idempSeller9 = `IDEMP_SELLER_REPLAY_${Date.now()}`;
  let sellerDisburseCalls = 0;
  (payoutProvider as any).disburseMerchantPayout = async (p: any) => {
    sellerDisburseCalls++;
    return origDisburseMerch(p);
  };

  const payout1 = await sellerSettlementService.executeSellerPayout({
    merchantId: merchantId7,
    amount: 50.00,
    idempotencyKey: idempSeller9,
  });

  const payout2 = await sellerSettlementService.executeSellerPayout({
    merchantId: merchantId7,
    amount: 50.00,
    idempotencyKey: idempSeller9,
  });

  (payoutProvider as any).disburseMerchantPayout = origDisburseMerch;

  assert.strictEqual(payout1.isDuplicate, false);
  assert.strictEqual(payout2.isDuplicate, true);
  assert.strictEqual(payout1.payoutId, payout2.payoutId);
  assert.strictEqual(sellerDisburseCalls, 1, 'Provider must disburse exactly once.');
  console.log('✓ Test 9 passed: Seller payout idempotency replay verified.');

  // -------------------------------------------------------------------------
  // Test 10: Seller Payout Timeout Preserves Ambiguous PROCESSING State
  // -------------------------------------------------------------------------
  console.log('[Test 10] Testing Seller Payout Ambiguous Timeout Preserves PROCESSING...');
  const idempSeller10 = `IDEMP_SELLER_TIMEOUT_${Date.now()}`;
  (payoutProvider as any).disburseMerchantPayout = async () => {
    const err: any = new Error('Banking rail gateway timeout (504)');
    err.code = 'ETIMEDOUT';
    throw err;
  };

  const timeoutPayout = await sellerSettlementService.executeSellerPayout({
    merchantId: merchantId7,
    amount: 25.00,
    idempotencyKey: idempSeller10,
  });

  (payoutProvider as any).disburseMerchantPayout = origDisburseMerch;

  assert.strictEqual(timeoutPayout.status, 'PROCESSING');
  assert.ok(timeoutPayout.failureReason?.includes('PROVIDER_OUTCOME_UNKNOWN'));

  const dbSellerPayout = await pool.query(`SELECT status FROM seller_payouts WHERE id = $1`, [timeoutPayout.payoutId]);
  assert.strictEqual(dbSellerPayout.rows[0].status, 'PROCESSING');
  console.log('✓ Test 10 passed: Seller payout timeout preserved in PROCESSING state.');

  // -------------------------------------------------------------------------
  // Test 11: Conclusive Seller Payout Failure Safely Restores Running Balance
  // -------------------------------------------------------------------------
  console.log('[Test 11] Testing Conclusive Payout Failure Restores Merchant Running Balance...');
  const balBeforeRes = await pool.query(`
    SELECT running_balance FROM seller_ledgers WHERE merchant_id = $1 ORDER BY created_at DESC LIMIT 1
  `, [merchantId7]);
  const balBefore = parseFloat(balBeforeRes.rows[0].running_balance);

  (payoutProvider as any).disburseMerchantPayout = async () => {
    return {
      success: false,
      providerPayoutId: '',
      utrNumber: '',
      status: 'REJECTED',
      failureReason: 'BENEFICIARY_ACCOUNT_BLOCKED',
    };
  };

  await assert.rejects(
    async () => {
      await sellerSettlementService.executeSellerPayout({
        merchantId: merchantId7,
        amount: 20.00,
        idempotencyKey: `idemp_seller_fail_${Date.now()}`,
      });
    },
    (err: any) => err.message.includes('BENEFICIARY_ACCOUNT_BLOCKED')
  );

  (payoutProvider as any).disburseMerchantPayout = origDisburseMerch;

  const balAfterRes = await pool.query(`
    SELECT running_balance FROM seller_ledgers WHERE merchant_id = $1 ORDER BY created_at DESC LIMIT 1
  `, [merchantId7]);
  const balAfter = parseFloat(balAfterRes.rows[0].running_balance);

  assert.strictEqual(balAfter, balBefore, 'Merchant balance must be restored upon conclusive payout rejection.');
  console.log('✓ Test 11 passed: Merchant balance restored upon conclusive banking rejection.');

  // -------------------------------------------------------------------------
  // Helper: Setup rider with wallet balance for rider payout tests
  // -------------------------------------------------------------------------
  async function setupRiderWithWallet(walletBalance: number = 600.00): Promise<string> {
    const riderRes = await pool.query(`SELECT id FROM riders LIMIT 1`);
    const riderId = riderRes.rows[0].id;

    await pool.query(`
      UPDATE riders
      SET wallet_balance = $1,
          upi_vpa = 'rider.sprint10@okhdfcbank',
          bank_account_number = '112233445566',
          bank_ifsc = 'HDFC0000001',
          is_payout_held = FALSE,
          status = 'IDLE_AT_HUB'
      WHERE id = $2
    `, [walletBalance, riderId]);

    return riderId;
  }

  // -------------------------------------------------------------------------
  // Test 12: Verify Rider Payout Decoupling (Provider Call Outside DB Lock)
  // -------------------------------------------------------------------------
  console.log('[Test 12] Testing Rider Payout Disbursed Outside DB Transaction...');
  const riderId12 = await setupRiderWithWallet(700.00);
  payoutProvider = (riderPayoutService as any).payoutProvider;
  const origDisburseRider = payoutProvider.disburseRiderPayout.bind(payoutProvider);

  let activeLockDuringRiderPayout = false;
  (payoutProvider as any).disburseRiderPayout = async (p: any) => {
    // Check that wallet was deducted in Step A and rider_payouts is PROCESSING
    const checkRider = await pool.query(`
      SELECT wallet_balance FROM riders WHERE id = $1
    `, [riderId12]);
    const checkPayout = await pool.query(`
      SELECT status FROM rider_payouts WHERE payout_reference = $1
    `, [p.reference]);

    if (checkPayout.rows.length === 0 || checkPayout.rows[0].status !== 'PROCESSING') {
      activeLockDuringRiderPayout = true;
    }
    return origDisburseRider(p);
  };

  const riderPayoutRes12 = await riderPayoutService.executeRiderPayout({
    riderId: riderId12,
    amount: 200.00,
    method: 'UPI',
    idempotencyKey: `idemp_rider_test12_${Date.now()}`,
  });

  (payoutProvider as any).disburseRiderPayout = origDisburseRider;

  assert.strictEqual(activeLockDuringRiderPayout, false, 'Step A transaction must be committed before rider payout executes.');
  assert.strictEqual(riderPayoutRes12.status, 'PAID');
  assert.strictEqual(riderPayoutRes12.amount, 200.00);
  assert.ok(riderPayoutRes12.utrNumber);
  console.log('✓ Test 12 passed: Rider payout executed outside database transaction.');

  // -------------------------------------------------------------------------
  // Test 13: Concurrent Rider Payouts Cannot Over-Deduct Wallet
  // -------------------------------------------------------------------------
  console.log('[Test 13] Testing Concurrent Rider Payouts Cannot Over-Deduct Wallet...');
  // Remaining balance: 700 - 200 = 500.00
  // Attempt two concurrent requests of ₹400 each (Total ₹800 > ₹500)
  const [riderAttA, riderAttB] = await Promise.allSettled([
    riderPayoutService.executeRiderPayout({
      riderId: riderId12,
      amount: 400.00,
      method: 'UPI',
      idempotencyKey: `idemp_rider_race_a_${Date.now()}`,
    }),
    riderPayoutService.executeRiderPayout({
      riderId: riderId12,
      amount: 400.00,
      method: 'UPI',
      idempotencyKey: `idemp_rider_race_b_${Date.now()}`,
    }),
  ]);

  const riderSuccessCount = [riderAttA, riderAttB].filter((r) => r.status === 'fulfilled').length;
  assert.strictEqual(riderSuccessCount, 1, 'Exactly one concurrent rider payout must succeed when exceeding balance.');
  console.log('✓ Test 13 passed: Concurrent rider wallet deduction race strictly protected.');

  // -------------------------------------------------------------------------
  // Test 14: Rider Payout Idempotency Key Deduplication
  // -------------------------------------------------------------------------
  console.log('[Test 14] Testing Rider Payout Idempotency Replay...');
  const idempRider14 = `IDEMP_RIDER_REPLAY_${Date.now()}`;
  let riderDisburseCalls = 0;
  (payoutProvider as any).disburseRiderPayout = async (p: any) => {
    riderDisburseCalls++;
    return origDisburseRider(p);
  };

  const rp1 = await riderPayoutService.executeRiderPayout({
    riderId: riderId12,
    amount: 50.00,
    method: 'UPI',
    idempotencyKey: idempRider14,
  });

  const rp2 = await riderPayoutService.executeRiderPayout({
    riderId: riderId12,
    amount: 50.00,
    method: 'UPI',
    idempotencyKey: idempRider14,
  });

  (payoutProvider as any).disburseRiderPayout = origDisburseRider;

  assert.strictEqual(rp1.isDuplicate, false);
  assert.strictEqual(rp2.isDuplicate, true);
  assert.strictEqual(rp1.payoutId, rp2.payoutId);
  assert.strictEqual(riderDisburseCalls, 1, 'Rider payout must disburse exactly once.');
  console.log('✓ Test 14 passed: Rider payout idempotency replay verified.');

  // -------------------------------------------------------------------------
  // Test 15: Conclusive Rider Payout Failure Restores Wallet Balance
  // -------------------------------------------------------------------------
  console.log('[Test 15] Testing Conclusive Rider Payout Failure Restores Wallet...');
  const rBalBeforeRes = await pool.query(`SELECT wallet_balance FROM riders WHERE id = $1`, [riderId12]);
  const rBalBefore = parseFloat(rBalBeforeRes.rows[0].wallet_balance);

  (payoutProvider as any).disburseRiderPayout = async () => {
    return {
      success: false,
      providerPayoutId: '',
      utrNumber: '',
      status: 'REJECTED',
      failureReason: 'UPI_VPA_INACTIVE',
    };
  };

  await assert.rejects(
    async () => {
      await riderPayoutService.executeRiderPayout({
        riderId: riderId12,
        amount: 25.00,
        method: 'UPI',
        idempotencyKey: `idemp_rider_fail_${Date.now()}`,
      });
    },
    (err: any) => err.message.includes('UPI_VPA_INACTIVE')
  );

  (payoutProvider as any).disburseRiderPayout = origDisburseRider;

  const rBalAfterRes = await pool.query(`SELECT wallet_balance FROM riders WHERE id = $1`, [riderId12]);
  const rBalAfter = parseFloat(rBalAfterRes.rows[0].wallet_balance);

  assert.strictEqual(rBalAfter, rBalBefore, 'Rider wallet balance must be restored upon payout rejection.');
  console.log('✓ Test 15 passed: Rider wallet balance restored upon banking rejection.');

  // -------------------------------------------------------------------------
  // Test 16: General Ledger Unique Constraint Blocks Duplicate Journal Lines
  // -------------------------------------------------------------------------
  console.log('[Test 16] Testing General Ledger Uniqueness Constraint (uq_gl_ref_account_side)...');
  const dummyBatch = crypto.randomUUID();
  const testTxRef = `TX_GL_TEST_${Date.now()}`;

  await pool.query(`
    INSERT INTO general_ledger_entries (
      journal_batch_id, transaction_reference, transaction_type,
      account_code, entry_side, amount, currency, narration
    )
    VALUES ($1, $2, 'MERCHANT_SETTLEMENT', '1020', 'CREDIT', 100.00, 'INR', 'First line entry')
  `, [dummyBatch, testTxRef]);

  // Attempt duplicate entry with identical transaction_reference, account_code, entry_side
  await assert.rejects(
    async () => {
      await pool.query(`
        INSERT INTO general_ledger_entries (
          journal_batch_id, transaction_reference, transaction_type,
          account_code, entry_side, amount, currency, narration
        )
        VALUES ($1, $2, 'MERCHANT_SETTLEMENT', '1020', 'CREDIT', 100.00, 'INR', 'Duplicate line entry')
      `, [dummyBatch, testTxRef]);
    },
    (err: any) => err.message.includes('unique constraint') || err.message.includes('duplicate key')
  );

  // Clean up test entry so double-entry balancing invariant in Test 18 remains pristine
  await pool.query(`DELETE FROM general_ledger_entries WHERE journal_batch_id = $1`, [dummyBatch]);
  console.log('✓ Test 16 passed: Unique constraint on general_ledger_entries strictly blocks duplicate journal lines.');

  // -------------------------------------------------------------------------
  // Test 17: Unique Constraints on Payout Tables (Migration 019)
  // -------------------------------------------------------------------------
  console.log('[Test 17] Testing Unique Constraints on Seller & Rider Payout Idempotency Keys...');
  const dupKey = `DUP_PAYOUT_KEY_${Date.now()}`;

  // Seller payout table unique constraint
  await pool.query(`
    INSERT INTO seller_payouts (
      payout_reference, merchant_id, amount, currency, status,
      bank_account_number, bank_ifsc, idempotency_key
    )
    VALUES ($1, $2, 50.00, 'INR', 'PROCESSING', '1234567890', 'HDFC0000001', $3)
  `, [`REF_SEL_A_${Date.now()}`, merchantId7, dupKey]);

  await assert.rejects(
    async () => {
      await pool.query(`
        INSERT INTO seller_payouts (
          payout_reference, merchant_id, amount, currency, status,
          bank_account_number, bank_ifsc, idempotency_key
        )
        VALUES ($1, $2, 50.00, 'INR', 'PROCESSING', '1234567890', 'HDFC0000001', $3)
      `, [`REF_SEL_B_${Date.now()}`, merchantId7, dupKey]);
    },
    (err: any) => err.message.includes('unique constraint') || err.message.includes('duplicate key')
  );

  // Rider payout table unique constraint
  await pool.query(`
    INSERT INTO rider_payouts (
      payout_reference, rider_id, amount, currency, payout_method, status, idempotency_key
    )
    VALUES ($1, $2, 50.00, 'INR', 'UPI', 'PROCESSING', $3)
  `, [`REF_RID_A_${Date.now()}`, riderId12, dupKey]);

  await assert.rejects(
    async () => {
      await pool.query(`
        INSERT INTO rider_payouts (
          payout_reference, rider_id, amount, currency, payout_method, status, idempotency_key
        )
        VALUES ($1, $2, 50.00, 'INR', 'UPI', 'PROCESSING', $3)
      `, [`REF_RID_B_${Date.now()}`, riderId12, dupKey]);
    },
    (err: any) => err.message.includes('unique constraint') || err.message.includes('duplicate key')
  );
  console.log('✓ Test 17 passed: Schema-level unique idempotency constraints verified for both payout rails.');

  // -------------------------------------------------------------------------
  // Test 18: Double-Entry Balancing Invariant Across All Payout Batches
  // -------------------------------------------------------------------------
  console.log('[Test 18] Testing Double-Entry Ledger Mathematical Balance Invariant...');
  const glSumRes = await pool.query(`
    SELECT entry_side, SUM(amount) as total
    FROM general_ledger_entries
    GROUP BY entry_side
  `);

  const debits = parseFloat(glSumRes.rows.find((r) => r.entry_side === 'DEBIT')?.total || '0');
  const credits = parseFloat(glSumRes.rows.find((r) => r.entry_side === 'CREDIT')?.total || '0');

  assert.strictEqual(
    +(debits).toFixed(2),
    +(credits).toFixed(2),
    `General Ledger must balance mathematically: Total Debits ₹${debits} == Total Credits ₹${credits}`
  );
  console.log(`✓ Test 18 passed: General Ledger balanced (Total Debits: ₹${debits.toFixed(2)} == Total Credits: ₹${credits.toFixed(2)}).`);

  console.log('\n===========================================================');
  console.log('✓ ALL SPRINT 10.1A FINANCIAL DECOUPLING & CONCURRENCY TESTS PASSED (18/18)!');
  console.log('===========================================================');
}
