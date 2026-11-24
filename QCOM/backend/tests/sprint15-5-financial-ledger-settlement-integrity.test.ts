/**
 * SPRINT 15.5 — FINANCIAL LEDGER & SETTLEMENT INTEGRITY
 *
 * Verifies against real native PostgreSQL 16 and Redis 7.0.15:
 *  1. PostgreSQL 16 ledger immutability triggers (UPDATE/DELETE blocked on general_ledger_entries, seller_ledgers, rider_ledgers)
 *  2. Numeric & double-entry invariant validation (NaN/<=0 rejected; SUM(DEBIT) == SUM(CREDIT) enforced)
 *  3. Concurrent seller payout race condition prevention (1 winner, 0 double-spend)
 *  4. Concurrent fulfillment allocation + seller payout serialization + delivery/payment eligibility guard
 *  5. FIFO partial allocation settlement & statement outstandingBalance accuracy
 *  6. Partial & full post-payout return clawbacks + proportional fee reversal + subsequent allocation clawback offset (1040 -> 2020)
 *  7. Post-PAID bank payout reversals via webhook (seller & rider) + duplicate replay protection
 *  8. Idempotent COD remittance retry + floating cash suspension/unblocking
 *  9. Delivery OTP completion ignores tampered client cashCollected (authoritative server COD & wallet summary)
 * 10. Ambiguous cancellation refund preserves payment_status='PAID'; failed return refund aborts return acceptance
 * 11. Global General Ledger Trial Balance (Total Debits === Total Credits, difference === 0.00)
 */

process.env.NODE_ENV = 'test';
process.env.FORCE_REDIS = '1';

import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { Redis } from 'ioredis';
import { createApp } from '../src/app.js';
import { setPool } from '../src/database/connection.js';
import { runMigrations } from '../src/database/migrator.js';
import { runSeeds } from '../seeds/seedData.js';
import { setRedisClient } from '../src/database/redis.js';
import { REQUIRED_REDIS_VERSION, assertExactRedisVersion } from '../src/config/redisVersion.js';
import { ledgerService } from '../src/modules/ledger/ledgerService.js';
import { settlementAllocationService } from '../src/modules/settlements/settlementAllocationService.js';
import { SellerSettlementService, sellerSettlementService } from '../src/modules/settlements/sellerSettlementService.js';
import { RiderPayoutService, riderPayoutService } from '../src/modules/settlements/riderPayoutService.js';
import { codCashAccountabilityService } from '../src/modules/settlements/codCashAccountabilityService.js';
import { roundCurrency } from '../src/modules/pricing/money.js';
import { RefundService, refundService } from '../src/modules/payments/refundService.js';
import { cancellationService } from '../src/modules/orders/cancellationService.js';
import { returnService } from '../src/modules/orders/returnService.js';
import { financialWebhookService } from '../src/modules/payments/financialWebhookService.js';
import { env } from '../src/config/env.js';
import { realtimeGateway } from '../src/modules/realtime/websocketServer.js';

const REAL_PG_URL = process.env.TEST_DATABASE_URL || 'postgres://qcom_user:qcom_password@127.0.0.1:5432/qcom_test';
const REAL_REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

export async function runSprint15_5FinancialLedgerSettlementIntegrityTests(): Promise<{
  totalPassed: number;
  totalTests: number;
}> {
  console.log('\n================================================================================');
  console.log('  SPRINT 15.5 — FINANCIAL LEDGER & SETTLEMENT INTEGRITY VERIFICATION SUITE');
  console.log('================================================================================');

  let totalPassed = 0;

  const realPool = new pg.Pool({
    connectionString: REAL_PG_URL,
    connectionTimeoutMillis: 5000,
    max: 15,
  });

  const redisProbeClient = new Redis(REAL_REDIS_URL, {
    lazyConnect: true,
    connectTimeout: 4000,
  });

  const app = createApp();
  const server = http.createServer(app);
  const openSockets = new Set<any>();
  server.on('connection', (sock) => {
    openSockets.add(sock);
    sock.on('close', () => openSockets.delete(sock));
  });

  const originalRefundProvider = refundService.getProvider();

  try {
    // -------------------------------------------------------------------------
    // 0. Real PostgreSQL 16.16 & Redis 7.0.15 Preflight + Migration 027
    // -------------------------------------------------------------------------
    const pgRes = await realPool.query('SELECT version()');
    const pgVersion = String(pgRes.rows[0].version || '');
    assert.ok(pgVersion.includes('PostgreSQL 16'), `PostgreSQL 16 required. Found: ${pgVersion}`);

    await redisProbeClient.connect();
    const redisInfo = await redisProbeClient.info('server');
    const redisVersion = assertExactRedisVersion(redisInfo, REQUIRED_REDIS_VERSION);
    setRedisClient(redisProbeClient);

    setPool(realPool);
    await runMigrations({ poolOverride: realPool });
    await runSeeds(realPool);

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as any).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    async function apiCall(
      endpoint: string,
      options: { method?: string; body?: any; token?: string; headers?: Record<string, string> } = {}
    ) {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...options.headers,
      };
      if (options.token) headers['Authorization'] = `Bearer ${options.token}`;
      const res = await fetch(`${baseUrl}${endpoint}`, {
        method: options.method || 'GET',
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
      const text = await res.text();
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
      return { status: res.status, data };
    }

    function signWebhook(payloadStr: string): string {
      return crypto.createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET).update(payloadStr).digest('hex');
    }

    console.log(`  ✓ Connected to ${pgVersion.split(' on ')[0]} and Redis ${redisVersion}`);

    // Create isolated customer, merchant, and rider actors for Sprint 15.5
    const suffix = `${Date.now().toString().slice(-6)}${crypto.randomBytes(2).toString('hex')}`;
    const userId = crypto.randomUUID();
    const merchantId = crypto.randomUUID();
    const riderId = crypto.randomUUID();
    const productId = crypto.randomUUID();
    const custPhone = `+919800${suffix.slice(0, 6)}`;
    const merchPhone = `+919600${suffix.slice(0, 6)}`;
    const riderPhone = `+919700${suffix.slice(0, 6)}`;

    await realPool.query(
      `INSERT INTO users (id, phone, name, is_phone_verified) VALUES ($1, $2, $3, TRUE)`,
      [userId, custPhone, `Customer 15.5`]
    );
    await realPool.query(
      `INSERT INTO merchants (
         id, merchant_code, name, business_name, pan_number, pan_status,
         locality, address, latitude, longitude, phone, gstin, status,
         commission_rate_percent, bank_account_number, bank_ifsc, bank_account_holder, bank_name, bank_verified
       ) VALUES (
         $1, $2, $3, $4, 'ABCDE1234F', 'VALID_PAN',
         'Koramangala', 'Koramangala Store 15.5', 12.9352, 77.6245, $5, '29ABCDE1234F1Z5', 'ACTIVE',
         10.00, '91000011223344', 'HDFC0001234', 'Sprint 15.5 Merchant', 'HDFC Bank', TRUE
       )`,
      [merchantId, `Z155_MC_${suffix}`, `M155_${suffix}`, `Sprint 15.5 Hardware Co`, merchPhone]
    );
    await realPool.query(
      `INSERT INTO riders (
         id, rider_code, name, phone, status, vehicle_type, vehicle_plate, kyc_status,
         upi_vpa, wallet_balance, floating_cash_balance, floating_cash_limit, is_payout_held
       ) VALUES (
         $1, $2, 'Rider 15.5', $3, 'IDLE_AT_HUB', 'motorcycle', 'KA01AB1550', 'GREEN',
         'rider155@okaxis', 0.00, 0.00, 2500.00, FALSE
       )`,
      [riderId, `Z155_RD_${suffix}`, riderPhone]
    );
    await realPool.query(
      `INSERT INTO products (id, sku, name, category, subcategory, hsn_code, gst_rate_percent, is_active)
       VALUES ($1, $2, $3, 'Fasteners', 'Power Tools', '84672100', 18.00, TRUE)`,
      [productId, `SKU-155-${suffix}`, `Pro Drill ${suffix}`]
    );
    await realPool.query(
      `INSERT INTO store_inventory (merchant_id, product_id, selling_price, original_mrp, stock_count, reserved_count, bin_location, is_available)
       VALUES ($1, $2, 1000.00, 1200.00, 200, 0, 'A-01-155', TRUE)`,
      [merchantId, productId]
    );

    async function createDeliveredPaidOrder(opts: {
      totalAmount?: number;
      taxableAmount?: number;
      cgst?: number;
      sgst?: number;
      deliveryFee?: number;
      handlingFee?: number;
      paymentMethod?: string;
      paymentStatus?: string;
      status?: string;
      postPaymentGl?: boolean;
      postTrip?: boolean;
      netRiderPayout?: number;
      qty?: number;
    } = {}) {
      const orderId = crypto.randomUUID();
      const orderNumber = `QC-155-${Date.now().toString().slice(-6)}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
      const taxable = opts.taxableAmount ?? 1000.00;
      const cgst = opts.cgst ?? 90.00;
      const sgst = opts.sgst ?? 90.00;
      const deliveryFee = opts.deliveryFee ?? 30.00;
      const handlingFee = opts.handlingFee ?? 10.00;
      const total = opts.totalAmount ?? +(taxable + cgst + sgst + deliveryFee + handlingFee).toFixed(2);
      const pm = opts.paymentMethod ?? 'Instant UPI';
      const ps = opts.paymentStatus ?? 'PAID';
      const st = opts.status ?? 'delivered';
      const qty = opts.qty ?? 1;

      const deliveredAt = st === 'delivered' ? new Date() : null;

      await realPool.query(
        `INSERT INTO orders (
           id, order_number, user_id, merchant_id, status, items_subtotal, delivery_fee, handling_fee,
           urgency_fee, discount_amount, taxable_amount, cgst_amount, sgst_amount, igst_amount,
           total_amount, withholding_amount, gst_tcs_amount, payment_method, payment_status,
           delivery_otp, handover_token, jobsite_address, place_of_supply_state_code, pricing_snapshot,
           placed_at, estimated_delivery_at, delivered_at, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, 0, 0, $6, $9, $10, 0,
           $11, 0, 0, $12, $13, '445566', 'PK-155', '{"latitude":12.93,"longitude":77.62}'::jsonb,
           '29', '{}'::jsonb, NOW(), NOW() + INTERVAL '30 minutes',
           $14, NOW(), NOW()
         )`,
        [orderId, orderNumber, userId, merchantId, st, taxable, deliveryFee, handlingFee, cgst, sgst, total, pm, ps, deliveredAt]
      );

      const orderItemId = crypto.randomUUID();
      const unitPrice = +(total / qty).toFixed(2);
      await realPool.query(
        `INSERT INTO order_items (
           id, order_id, product_id, product_name, unit_price, quantity, total_price,
           hsn_code, taxable_amount, gst_rate_percent, cgst_amount, sgst_amount, igst_amount
         ) VALUES ($1, $2, $3, 'Pro Drill', $4, $5, $6, '84672100', $7, 18.00, $8, $9, 0)`,
        [orderItemId, orderId, productId, unitPrice, qty, total, taxable, cgst, sgst]
      );

      if (opts.postPaymentGl !== false && ps === 'PAID') {
        await ledgerService.recordOrderPayment({
          orderId,
          merchantId,
          grossAmount: total,
          taxableAmount: taxable,
          cgstAmount: cgst,
          sgstAmount: sgst,
          deliveryFee,
          handlingFee,
        });
      }

      let tripId: string | undefined;
      if (opts.postTrip !== false) {
        tripId = crypto.randomUUID();
        const rNet = opts.netRiderPayout ?? 45.00;
        const rTds = 0.00;
        await realPool.query(
          `INSERT INTO delivery_trips (
             id, order_id, rider_id, status, base_fare, distance_fare, surge_fare,
             tip_amount, rider_tip_payable, rider_withholding_amount, total_rider_payout,
             delivered_at
           ) VALUES ($1, $2, $3, $4, $5, 0, 0, 0, 0, $6, $5, $7)`,
          [tripId, orderId, riderId, st === 'delivered' ? 'DELIVERED' : 'PICKED_UP', rNet, rTds, deliveredAt]
        );
      }

      return { orderId, orderNumber, orderItemId, tripId, total };
    }

    // -------------------------------------------------------------------------
    // SECTION 1: PG 16 Ledger Immutability Triggers
    // -------------------------------------------------------------------------
    console.log('\n--- Section 1: PostgreSQL 16 Ledger Immutability Triggers ---');
    const immOrder = await createDeliveredPaidOrder();
    const glRowRes = await realPool.query(
      `SELECT id FROM general_ledger_entries WHERE order_id = $1 LIMIT 1`,
      [immOrder.orderId]
    );
    assert.ok(glRowRes.rows.length > 0);
    await assert.rejects(
      () => realPool.query(`UPDATE general_ledger_entries SET amount = 99999 WHERE id = $1`, [glRowRes.rows[0].id]),
      /LEDGER_IMMUTABLE/
    );
    await assert.rejects(
      () => realPool.query(`DELETE FROM general_ledger_entries WHERE id = $1`, [glRowRes.rows[0].id]),
      /LEDGER_IMMUTABLE/
    );

    const allocImm = await settlementAllocationService.allocateFulfilledOrder(immOrder.orderId);
    const slRowRes = await realPool.query(
      `SELECT id, seq_no FROM seller_ledgers WHERE merchant_id = $1 ORDER BY seq_no DESC LIMIT 1`,
      [merchantId]
    );
    assert.ok(Number(slRowRes.rows[0].seq_no) > 0, 'seller_ledgers seq_no trigger must assign monotonic sequence');
    await assert.rejects(
      () => realPool.query(`UPDATE seller_ledgers SET amount = 1 WHERE id = $1`, [slRowRes.rows[0].id]),
      /LEDGER_IMMUTABLE/
    );
    await assert.rejects(
      () => realPool.query(`DELETE FROM seller_ledgers WHERE id = $1`, [slRowRes.rows[0].id]),
      /LEDGER_IMMUTABLE/
    );

    const rlRowRes = await realPool.query(
      `SELECT id, seq_no FROM rider_ledgers WHERE rider_id = $1 ORDER BY seq_no DESC LIMIT 1`,
      [riderId]
    );
    assert.ok(Number(rlRowRes.rows[0].seq_no) > 0, 'rider_ledgers seq_no trigger must assign monotonic sequence');
    await assert.rejects(
      () => realPool.query(`UPDATE rider_ledgers SET amount = 1 WHERE id = $1`, [rlRowRes.rows[0].id]),
      /LEDGER_IMMUTABLE/
    );
    await assert.rejects(
      () => realPool.query(`DELETE FROM rider_ledgers WHERE id = $1`, [rlRowRes.rows[0].id]),
      /LEDGER_IMMUTABLE/
    );
    console.log(`  ✓ PG 16 immutability triggers blocked UPDATE/DELETE across GL, seller_ledgers, rider_ledgers`);
    totalPassed++;

    // -------------------------------------------------------------------------
    // SECTION 2: Numeric Validation & Double-Entry Unbalanced Batch Rejection
    // -------------------------------------------------------------------------
    console.log('\n--- Section 2: Numeric Validation & Unbalanced Ledger Rejection ---');
    await assert.rejects(
      () => sellerSettlementService.executeSellerPayout({ merchantId, amount: NaN }),
      /INVALID_PAYOUT_AMOUNT/
    );
    await assert.rejects(
      () => sellerSettlementService.executeSellerPayout({ merchantId, amount: -10 }),
      /INVALID_PAYOUT_AMOUNT/
    );
    await assert.rejects(
      () => riderPayoutService.executeRiderPayout({ riderId, amount: Infinity }),
      /INVALID_PAYOUT_AMOUNT/
    );
    await assert.rejects(
      () => riderPayoutService.remitCodCash({ riderId, amount: 0 }),
      /INVALID_REMITTANCE_AMOUNT/
    );
    await assert.rejects(
      () => refundService.createRefund({ orderId: immOrder.orderId, amount: -5, reasonCode: 'TEST' }),
      /INVALID_REFUND_AMOUNT/
    );
    await assert.rejects(
      () =>
        ledgerService.recordOrderFulfillmentAllocation({
          orderId: crypto.randomUUID(),
          merchantId,
          orderTotal: 1000,
          netSellerPayable: 500, // Deliberately unbalanced!
          grossRiderFare: 40,
          netRiderPayable: 40,
          riderTdsAmount: 0,
          platformCommission: 100,
          commissionGst: 18,
          customerDeliveryFee: 0,
          deliveryFeeGst: 0,
          customerHandlingFee: 0,
          handlingFeeGst: 0,
          storeDelayPenalty: 0,
          gstTcsAmount: 0,
          sellerTdsAmount: 0,
        }),
      /LEDGER_UNBALANCED/
    );
    console.log('  ✓ Invalid financial numbers (NaN/Infinity/<=0) and unbalanced GL batches rejected');
    totalPassed++;

    // -------------------------------------------------------------------------
    // SECTION 3: Concurrent Seller Payout Race Condition & Allocation Eligibility
    // -------------------------------------------------------------------------
    console.log('\n--- Section 3: Concurrent Seller Payout Race & Eligibility Guard ---');
    // Verify unpaid / undelivered orders cannot allocate merchant payable
    const undelivered = await createDeliveredPaidOrder({ status: 'packed', paymentStatus: 'PAID', postPaymentGl: false, postTrip: false });
    await assert.rejects(
      () => settlementAllocationService.allocateFulfilledOrder(undelivered.orderId),
      /ORDER_NOT_DELIVERED/
    );
    const unpaidOnline = await createDeliveredPaidOrder({ status: 'delivered', paymentStatus: 'PENDING', paymentMethod: 'Instant UPI', postPaymentGl: false, postTrip: false });
    await assert.rejects(
      () => settlementAllocationService.allocateFulfilledOrder(unpaidOnline.orderId),
      /ORDER_NOT_PAID/
    );

    // Concurrent full seller payout race against the allocated balance from immOrder
    const preRaceBalance = allocImm.netSellerPayable;
    const [raceA, raceB] = await Promise.allSettled([
      sellerSettlementService.executeSellerPayout({ merchantId, amount: preRaceBalance }),
      sellerSettlementService.executeSellerPayout({ merchantId, amount: preRaceBalance }),
    ]);
    const raceSuccesses = [raceA, raceB].filter((r) => r.status === 'fulfilled');
    const raceFailures = [raceA, raceB].filter((r) => r.status === 'rejected');
    assert.strictEqual(raceSuccesses.length, 1, 'Strictly 1 concurrent seller payout must succeed');
    assert.strictEqual(raceFailures.length, 1, 'Second concurrent seller payout must be rejected');

    const postRaceStmt = await sellerSettlementService.getSellerSettlementStatement(merchantId);
    assert.strictEqual(postRaceStmt.outstandingBalance, 0, 'Merchant outstanding balance must be 0.00 after single payout');
    console.log(`  ✓ Eligibility guards enforced & concurrent payout race allowed strictly 1 disbursement`);
    totalPassed++;

    // -------------------------------------------------------------------------
    // SECTION 4: Concurrent Allocation + Payout Serialization + FIFO Partial Settlement
    // -------------------------------------------------------------------------
    console.log('\n--- Section 4: FIFO Partial Allocation Settlement & Statement Balance ---');
    const fifoOrder1 = await createDeliveredPaidOrder({ taxableAmount: 1000, cgst: 90, sgst: 90, deliveryFee: 0, handlingFee: 0 });
    const fifoOrder2 = await createDeliveredPaidOrder({ taxableAmount: 1000, cgst: 90, sgst: 90, deliveryFee: 0, handlingFee: 0 });
    const fifoAlloc1 = await settlementAllocationService.allocateFulfilledOrder(fifoOrder1.orderId);
    const fifoAlloc2 = await settlementAllocationService.allocateFulfilledOrder(fifoOrder2.orderId);

    // Partial payout covering Allocation 1 + half of Allocation 2
    const halfAlloc2 = +(fifoAlloc2.netSellerPayable / 2).toFixed(2);
    const partialPayoutAmt = +(fifoAlloc1.netSellerPayable + halfAlloc2).toFixed(2);
    const partialPayout = await sellerSettlementService.executeSellerPayout({
      merchantId,
      amount: partialPayoutAmt,
    });
    assert.strictEqual(partialPayout.status, 'PAID');

    const alloc1Row = (await realPool.query(`SELECT status, settled_amount FROM order_settlement_allocations WHERE order_id = $1`, [fifoOrder1.orderId])).rows[0];
    const alloc2Row = (await realPool.query(`SELECT status, settled_amount FROM order_settlement_allocations WHERE order_id = $1`, [fifoOrder2.orderId])).rows[0];
    assert.strictEqual(alloc1Row.status, 'SETTLED', 'Oldest allocation (FIFO) must be SETTLED');
    assert.strictEqual(Number(alloc1Row.settled_amount), fifoAlloc1.netSellerPayable);
    assert.strictEqual(alloc2Row.status, 'ALLOCATED', 'Second allocation partially paid must remain ALLOCATED');
    assert.strictEqual(Number(alloc2Row.settled_amount), halfAlloc2);

    const midStmt = await sellerSettlementService.getSellerSettlementStatement(merchantId);
    const expectedRemaining = +(fifoAlloc2.netSellerPayable - halfAlloc2).toFixed(2);
    assert.ok(Math.abs(midStmt.outstandingBalance - expectedRemaining) <= 0.01, `Expected ${expectedRemaining}, got ${midStmt.outstandingBalance}`);

    // Settle remaining balance concurrently with a third allocation to verify serialization
    const fifoOrder3 = await createDeliveredPaidOrder({ taxableAmount: 500, cgst: 45, sgst: 45, deliveryFee: 0, handlingFee: 0 });
    await Promise.all([
      settlementAllocationService.allocateFulfilledOrder(fifoOrder3.orderId),
      sellerSettlementService.executeSellerPayout({ merchantId, amount: expectedRemaining }),
    ]);
    const alloc2After = (await realPool.query(`SELECT status, settled_amount FROM order_settlement_allocations WHERE order_id = $1`, [fifoOrder2.orderId])).rows[0];
    assert.strictEqual(alloc2After.status, 'SETTLED', 'Remaining payout must settle second allocation FIFO');
    console.log('  ✓ FIFO partial allocation tracking and concurrent allocation/payout serialization verified');
    totalPassed++;

    // -------------------------------------------------------------------------
    // SECTION 5: Post-Payout Partial & Full Return Clawbacks + Future Earnings Offset
    // -------------------------------------------------------------------------
    console.log('\n--- Section 5: Post-Payout Clawback & Clawback 1040 -> 2020 Offset ---');
    // fifoOrder1 is SETTLED and fifoOrder3's net payable is still sitting in balance; drain merchant balance first
    const drainStmt = await sellerSettlementService.getSellerSettlementStatement(merchantId);
    if (drainStmt.outstandingBalance > 0) {
      await sellerSettlementService.executeSellerPayout({ merchantId, amount: drainStmt.outstandingBalance });
    }

    // Now merchant balance == 0.00. Perform partial return (50%) on settled fifoOrder1
    const halfRefund = +(fifoOrder1.total / 2).toFixed(2);
    const claw1 = await sellerSettlementService.processSellerClawback({
      orderId: fifoOrder1.orderId,
      merchantId,
      refundAmount: halfRefund,
      returnId: `ret_part_${crypto.randomBytes(3).toString('hex')}`,
    });
    assert.strictEqual(claw1.isPostPayout, true);
    assert.ok(claw1.debitAmount > 0 && claw1.newBalance < 0, 'Post-payout clawback must push seller balance negative');

    const a1Mid = (await realPool.query(`SELECT status, refunded_amount FROM order_settlement_allocations WHERE order_id = $1`, [fifoOrder1.orderId])).rows[0];
    assert.notStrictEqual(a1Mid.status, 'REVERSED', 'Partial return must NOT prematurely mark allocation REVERSED');

    // Second half return completes reversal
    const claw2 = await sellerSettlementService.processSellerClawback({
      orderId: fifoOrder1.orderId,
      merchantId,
      refundAmount: halfRefund,
      returnId: `ret_full_${crypto.randomBytes(3).toString('hex')}`,
    });
    assert.ok(claw2.debitAmount > 0);

    const a1Final = (await realPool.query(`SELECT status FROM order_settlement_allocations WHERE order_id = $1`, [fifoOrder1.orderId])).rows[0];
    assert.strictEqual(a1Final.status, 'REVERSED', 'Full return must transition allocation to REVERSED');

    // Duplicate excess clawback on REVERSED allocation must be blocked (debitAmount === 0)
    const clawDup = await sellerSettlementService.processSellerClawback({
      orderId: fifoOrder1.orderId,
      merchantId,
      refundAmount: 100,
      returnId: `ret_dup_${crypto.randomBytes(3).toString('hex')}`,
    });
    assert.strictEqual(clawDup.debitAmount, 0, 'Duplicate clawback on REVERSED allocation must debit 0');

    // Verify next fulfilled allocation automatically posts Dr 2020 / Cr 1040 offset entry!
    const offsetOrder = await createDeliveredPaidOrder({ taxableAmount: 1500, cgst: 135, sgst: 135, deliveryFee: 0, handlingFee: 0 });
    await settlementAllocationService.allocateFulfilledOrder(offsetOrder.orderId);
    const offsetGlRes = await realPool.query(
      `SELECT account_code, entry_side, amount FROM general_ledger_entries WHERE transaction_reference = $1`,
      [`TX_CLAWBACK_OFFSET_${offsetOrder.orderId}`]
    );
    assert.strictEqual(offsetGlRes.rows.length, 2, 'Clawback offset must post balanced Dr 2020 / Cr 1040 entries');
    console.log('  ✓ Post-payout partial/full clawbacks, duplicate block, and 1040->2020 offset verified');
    totalPassed++;

    // -------------------------------------------------------------------------
    // SECTION 6: Post-PAID Bank Reversal Webhooks (Seller & Rider) + Replay Safety
    // -------------------------------------------------------------------------
    console.log('\n--- Section 6: Post-PAID Bank Reversal Webhooks & Replay Protection ---');
    // Trigger a fresh PAID seller payout so we can simulate bank reversal via webhook
    const revStmtBefore = await sellerSettlementService.getSellerSettlementStatement(merchantId);
    const revSellerPay = await sellerSettlementService.executeSellerPayout({
      merchantId,
      amount: revStmtBefore.outstandingBalance,
    });
    assert.strictEqual(revSellerPay.status, 'PAID');

    const sellerRevEvt = JSON.stringify({
      id: `evt_seller_rev_${Date.now()}`,
      event: 'payout.reversed',
      payload: { payout: { entity: { reference_id: revSellerPay.payoutReference, failure_reason: 'NEFT_BENEFICIARY_RETURN' } } },
    });
    const sellerRevRes = await financialWebhookService.processFinancialWebhook({
      rawBody: sellerRevEvt,
      signature: signWebhook(sellerRevEvt),
    });
    assert.strictEqual(sellerRevRes.success, true);

    const revGlSeller = await realPool.query(
      `SELECT account_code, entry_side, amount FROM general_ledger_entries WHERE transaction_reference = $1`,
      [`TX_PAYOUT_REV_${revSellerPay.payoutReference}`]
    );
    assert.strictEqual(revGlSeller.rows.length, 2, 'Post-PAID seller reversal webhook must post GL reversal batch');

    const revStmtAfter = await sellerSettlementService.getSellerSettlementStatement(merchantId);
    assert.ok(
      Math.abs(revStmtAfter.outstandingBalance - revStmtBefore.outstandingBalance) <= 0.01,
      'Seller payable balance must be restored after bank reversal'
    );

    // Duplicate reversal webhook replay with a different eventId must NOT double-credit!
    const sellerRevDupEvt = JSON.stringify({
      id: `evt_seller_rev_dup_${Date.now()}`,
      event: 'payout.reversed',
      payload: { payout: { entity: { reference_id: revSellerPay.payoutReference, failure_reason: 'REPLAY' } } },
    });
    const sellerRevDupRes = await financialWebhookService.processFinancialWebhook({
      rawBody: sellerRevDupEvt,
      signature: signWebhook(sellerRevDupEvt),
    });
    assert.strictEqual(sellerRevDupRes.duplicate, true, 'Duplicate seller reversal must be blocked by terminal status');
    const revStmtReplay = await sellerSettlementService.getSellerSettlementStatement(merchantId);
    assert.strictEqual(revStmtReplay.outstandingBalance, revStmtAfter.outstandingBalance, 'Balance must not double-credit');

    // Rider PAID payout followed by payout.reversed webhook
    const riderBalBeforePay = parseFloat(
      (await realPool.query(`SELECT wallet_balance FROM riders WHERE id = $1`, [riderId])).rows[0].wallet_balance
    );
    assert.ok(riderBalBeforePay > 0, 'Rider should have positive wallet balance from delivered orders');
    const riderPayRes = await riderPayoutService.executeRiderPayout({ riderId, method: 'UPI' });
    assert.strictEqual(riderPayRes.status, 'PAID');

    const riderRevEvt = JSON.stringify({
      id: `evt_rider_rev_${Date.now()}`,
      event: 'payout.reversed',
      payload: { payout: { entity: { reference_id: riderPayRes.payoutReference, failure_reason: 'VPA_INVALID_RETURN' } } },
    });
    const riderRevRes = await financialWebhookService.processFinancialWebhook({
      rawBody: riderRevEvt,
      signature: signWebhook(riderRevEvt),
    });
    assert.strictEqual(riderRevRes.status, 'REVERSED');

    const riderBalRestored = parseFloat(
      (await realPool.query(`SELECT wallet_balance FROM riders WHERE id = $1`, [riderId])).rows[0].wallet_balance
    );
    assert.ok(Math.abs(riderBalRestored - riderBalBeforePay) <= 0.01, 'Rider wallet must be restored after payout.reversed');

    const revGlRider = await realPool.query(
      `SELECT account_code, entry_side FROM general_ledger_entries WHERE transaction_reference = $1`,
      [`TX_PAYOUT_REV_${riderPayRes.payoutReference}`]
    );
    assert.strictEqual(revGlRider.rows.length, 2, 'Post-PAID rider reversal webhook must post GL reversal batch');

    // Duplicate rider reversal with different event ID must not double credit
    const riderRevDupEvt = JSON.stringify({
      id: `evt_rider_rev_dup_${Date.now()}`,
      event: 'payout.failed',
      payload: { payout: { entity: { reference_id: riderPayRes.payoutReference, failure_reason: 'DUP' } } },
    });
    const riderRevDupRes = await financialWebhookService.processFinancialWebhook({
      rawBody: riderRevDupEvt,
      signature: signWebhook(riderRevDupEvt),
    });
    assert.strictEqual(riderRevDupRes.duplicate, true);
    const riderBalAfterDup = parseFloat(
      (await realPool.query(`SELECT wallet_balance FROM riders WHERE id = $1`, [riderId])).rows[0].wallet_balance
    );
    assert.strictEqual(riderBalAfterDup, riderBalRestored, 'Rider wallet must not double-credit on duplicate webhook');
    console.log('  ✓ Seller & Rider post-PAID bank reversals and replay guards verified');
    totalPassed++;

    // -------------------------------------------------------------------------
    // SECTION 7: Idempotent COD Remittance Retry & Floating Cash Suspension
    // -------------------------------------------------------------------------
    console.log('\n--- Section 7: Idempotent COD Remittance & Floating Cash Ceiling ---');
    const codOrder = await createDeliveredPaidOrder({
      paymentMethod: 'Pay on Delivery',
      paymentStatus: 'PENDING',
      taxableAmount: 2600,
      cgst: 0,
      sgst: 0,
      deliveryFee: 0,
      handlingFee: 0,
    });
    await settlementAllocationService.allocateFulfilledOrder(codOrder.orderId);
    const riderSuspRow = (await realPool.query(`SELECT status, floating_cash_balance FROM riders WHERE id = $1`, [riderId])).rows[0];
    assert.strictEqual(riderSuspRow.status, 'SUSPENDED', 'Rider must be SUSPENDED when floating cash >= 2500');
    assert.strictEqual(Number(riderSuspRow.floating_cash_balance), 2600);

    const remitRef = `REMIT_IDEM_${Date.now()}`;
    const rem1 = await riderPayoutService.remitCodCash({ riderId, amount: 2600, method: 'UPI', reference: remitRef });
    assert.strictEqual(rem1.status, 'SUBMITTED');
    assert.strictEqual(rem1.liabilityCleared, false, 'Submission alone must NOT clear COD liability');
    assert.strictEqual(rem1.unblocked, false);
    assert.strictEqual(rem1.remainingCash, 2600);

    // Retry exact same reference -> must return idempotent success without duplicating remittance!
    const rem2 = await riderPayoutService.remitCodCash({ riderId, amount: 2600, method: 'UPI', reference: remitRef });
    assert.strictEqual(rem2.success, true);
    assert.strictEqual(rem2.idempotentReplay, true);
    assert.strictEqual(rem2.remainingCash, 2600);

    // Independent Operations receipt + Finance verification clears liability & unblocks rider
    const opsUser155 = (await realPool.query(`SELECT id FROM users WHERE email = 'ops@qcom.local' LIMIT 1`)).rows[0].id as string;
    const finUser155 = (await realPool.query(`SELECT id FROM users WHERE email = 'emp-001@qcom.local' LIMIT 1`)).rows[0].id as string;
    await codCashAccountabilityService.acknowledgeReceipt({
      remittanceId: rem1.remittanceId,
      receiverUserId: opsUser155,
      receivedAmount: 2600,
    });
    const ver155 = await codCashAccountabilityService.verifyRemittance({
      remittanceId: rem1.remittanceId,
      verifierUserId: finUser155,
      verifiedAmount: 2600,
    });
    assert.strictEqual(ver155.status, 'LIABILITY_CLEARED');
    assert.strictEqual(ver155.unblocked, true);
    assert.strictEqual(ver155.remainingCash, 0);
    console.log('  ✓ COD ceiling suspension, 3-step verification unblocking, and idempotent remittance retry verified');
    totalPassed++;

    // -------------------------------------------------------------------------
    // SECTION 8: Delivery OTP Endpoint Server-Derived COD & Wallet Summary
    // -------------------------------------------------------------------------
    console.log('\n--- Section 8: Delivery OTP Server-Derived COD & Wallet Integrity ---');
    const rOtpReq = await apiCall('/api/auth/request-otp', { method: 'POST', body: { phone: riderPhone } });
    assert.strictEqual(rOtpReq.status, 200);
    const rOtpVer = await apiCall('/api/auth/verify-otp', {
      method: 'POST',
      body: { phone: riderPhone, otp: rOtpReq.data.debugOtp || '123456', name: 'Rider 15.5' },
    });
    assert.strictEqual(rOtpVer.status, 200);
    const riderAccessToken = rOtpVer.data.accessToken as string;

    const onlineOrder = await createDeliveredPaidOrder({
      status: 'out_for_delivery',
      paymentMethod: 'Instant UPI',
      paymentStatus: 'PAID',
      postPaymentGl: true,
      postTrip: true,
    });
    const otpVerifyTamper = await apiCall(`/api/tasks/${onlineOrder.tripId}/verify-otp`, {
      method: 'POST',
      token: riderAccessToken,
      body: { otp: '445566', cashCollected: 99999 }, // Client tampers cashCollected on prepaid online order!
    });
    assert.strictEqual(otpVerifyTamper.status, 200);
    const tripRowAfterOtp = (
      await realPool.query(`SELECT cod_collected_amount FROM delivery_trips WHERE id = $1`, [onlineOrder.tripId])
    ).rows[0];
    assert.strictEqual(
      Number(tripRowAfterOtp.cod_collected_amount),
      0,
      'Online prepaid order verify-otp must record cod_collected_amount=0 regardless of tampered client input'
    );
    console.log('  ✓ /api/tasks/:id/verify-otp ignored tampered cashCollected on online order');
    totalPassed++;

    // -------------------------------------------------------------------------
    // SECTION 9: Ambiguous Refund Cancellation & Failed Return Refund Rollback
    // -------------------------------------------------------------------------
    console.log('\n--- Section 9: Ambiguous Cancellation Refund & Failed Return Refund Abort ---');
    const cancelOrder = await createDeliveredPaidOrder({
      status: 'placed',
      paymentMethod: 'Instant UPI',
      paymentStatus: 'PAID',
      postPaymentGl: true,
      postTrip: false,
    });
    const timeoutProvider = Object.assign(
      Object.create(Object.getPrototypeOf(originalRefundProvider)),
      originalRefundProvider,
      {
        async createRefund() {
          throw new Error('Gateway network ETIMEDOUT');
        },
        async getRefundStatus() {
          return { providerRefundId: 'rfnd_pending', status: 'PENDING' as const, amount: 100 };
        },
      }
    );
    refundService.setProvider(timeoutProvider);
    const cancelRes = await cancellationService.cancelByAdmin({
      orderId: cancelOrder.orderId,
      adminUserId: userId,
      reason: 'Timeout test',
    });
    assert.strictEqual(cancelRes.refund.status, 'PROCESSING');
    const cancelOrderRow = (
      await realPool.query(`SELECT status, payment_status FROM orders WHERE id = $1`, [cancelOrder.orderId])
    ).rows[0];
    assert.strictEqual(cancelOrderRow.status, 'cancelled');
    assert.strictEqual(
      cancelOrderRow.payment_status,
      'PAID',
      'Order with PROCESSING refund must keep payment_status=PAID (not falsely REFUNDED)'
    );

    // Failed return refund must abort return acceptance & roll back stock/status
    const retFailOrder = await createDeliveredPaidOrder({
      status: 'delivered',
      paymentMethod: 'Instant UPI',
      paymentStatus: 'PAID',
      postPaymentGl: true,
      postTrip: false,
    });
    refundService.setProvider(originalRefundProvider);
    const { returnRequest } = await returnService.requestReturn({
      orderId: retFailOrder.orderId,
      userId,
      items: [{ orderItemId: retFailOrder.orderItemId, quantity: 1 }],
      reasonCode: 'DAMAGED',
    });
    const stockBeforeFail = Number(
      (await realPool.query(`SELECT stock_count FROM store_inventory WHERE merchant_id = $1 AND product_id = $2`, [merchantId, productId])).rows[0].stock_count
    );
    const rejectProvider = Object.assign(
      Object.create(Object.getPrototypeOf(originalRefundProvider)),
      originalRefundProvider,
      {
        async createRefund(req: { paymentId: string; amount: number; currency: string }) {
          return {
            providerRefundId: 'rfnd_fail',
            paymentId: req.paymentId,
            amount: req.amount,
            currency: req.currency || 'INR',
            status: 'FAILED' as const,
            timestamp: new Date().toISOString(),
          };
        },
        async getRefundStatus() {
          return { providerRefundId: 'rfnd_fail', status: 'FAILED' as const, amount: retFailOrder.total };
        },
      }
    );
    refundService.setProvider(rejectProvider);
    await assert.rejects(
      () =>
        returnService.qcInspectAndResolve({
          returnId: returnRequest.id,
          merchantId,
          itemDecisions: [{ returnItemId: returnRequest.items[0].id, qcPassed: true }],
        }),
      /RETURN_REFUND_FAILED/
    );
    const retAfterFail = (
      await realPool.query(`SELECT status FROM order_returns WHERE id = $1`, [returnRequest.id])
    ).rows[0];
    const stockAfterFail = Number(
      (await realPool.query(`SELECT stock_count FROM store_inventory WHERE merchant_id = $1 AND product_id = $2`, [merchantId, productId])).rows[0].stock_count
    );
    assert.strictEqual(retAfterFail.status, 'REQUESTED', 'Failed return refund must roll back order_returns status');
    assert.strictEqual(stockAfterFail, stockBeforeFail, 'Failed return refund must roll back restocked inventory');
    refundService.setProvider(originalRefundProvider);
    console.log('  ✓ Ambiguous cancellation preserves PAID; failed return refund rolls back atomically');
    totalPassed++;

    // Verify canonical REVERSED status persisted for seller payout reversal in Section 6
    const sellerRevDbCheck = (
      await realPool.query(`SELECT status FROM seller_payouts WHERE id = $1`, [revSellerPay.payoutId])
    ).rows[0];
    assert.strictEqual(
      sellerRevDbCheck.status,
      'REVERSED',
      'Seller payout.reversed webhook must persist canonical REVERSED status'
    );

    // -------------------------------------------------------------------------
    // SECTION 10: Atomic Journal Batch Idempotency, Aggregation & Conflict Rejection
    // -------------------------------------------------------------------------
    console.log('\n--- Section 10: Atomic Journal Batch Idempotency & Conflict Guards ---');
    const multiLineTxRef = `TX_S1551_MULTILINE_${Date.now()}`;
    const multiBatch1 = await ledgerService.postJournalBatch({
      txRef: multiLineTxRef,
      transactionType: 'ADJUSTMENT',
      lines: [
        { account: '1010', side: 'DEBIT', amount: 40.25, merchantId, narration: 'Legit line 1' },
        { account: '1010', side: 'DEBIT', amount: 59.75, merchantId, narration: 'Legit line 2' },
        { account: '2020', side: 'CREDIT', amount: 100.00, merchantId, narration: 'Credit line' },
      ],
    });
    const multiBatchRows = await realPool.query(
      `SELECT account_code, entry_side, amount FROM general_ledger_entries WHERE transaction_reference = $1`,
      [multiLineTxRef]
    );
    assert.strictEqual(multiBatchRows.rows.length, 2, 'Same (account, side) lines must aggregate cleanly into 1 row per side');
    const debitRow1010 = multiBatchRows.rows.find((r) => r.account_code === '1010');
    assert.strictEqual(Number(debitRow1010?.amount), 100.00);

    // Exact replay with identical payload returns the same journalBatchId
    const multiBatchReplay = await ledgerService.postJournalBatch({
      txRef: multiLineTxRef,
      transactionType: 'ADJUSTMENT',
      lines: [
        { account: '1010', side: 'DEBIT', amount: 100.00, merchantId, narration: 'Replay' },
        { account: '2020', side: 'CREDIT', amount: 100.00, merchantId, narration: 'Replay' },
      ],
    });
    assert.strictEqual(multiBatchReplay, multiBatch1, 'Exact replay must return existing journalBatchId');

    // Conflicting payload under same txRef must reject loudly with LEDGER_TX_REF_CONFLICT
    await assert.rejects(
      () =>
        ledgerService.postJournalBatch({
          txRef: multiLineTxRef,
          transactionType: 'ADJUSTMENT',
          lines: [
            { account: '1010', side: 'DEBIT', amount: 101.00, merchantId, narration: 'Mismatch' },
            { account: '2020', side: 'CREDIT', amount: 101.00, merchantId, narration: 'Mismatch' },
          ],
        }),
      /LEDGER_TX_REF_CONFLICT/
    );

    // Failure mid-batch must leave zero partial rows
    const failTxRef = `TX_S1551_FAIL_${Date.now()}`;
    await assert.rejects(
      () =>
        ledgerService.postJournalBatch({
          txRef: failTxRef,
          transactionType: 'ADJUSTMENT',
          lines: [
            { account: '1010', side: 'DEBIT', amount: 50.00, orderId: crypto.randomUUID(), narration: 'Bad FK rollback' },
            { account: '2020', side: 'CREDIT', amount: 50.00, merchantId, narration: 'Bad FK rollback' },
          ],
        })
    );
    const partialBatchCheck = await realPool.query(
      `SELECT COUNT(*)::int AS cnt FROM ledger_journal_batches WHERE transaction_reference = $1`,
      [failTxRef]
    );
    const partialEntryCheck = await realPool.query(
      `SELECT COUNT(*)::int AS cnt FROM general_ledger_entries WHERE transaction_reference = $1`,
      [failTxRef]
    );
    assert.strictEqual(partialBatchCheck.rows[0].cnt, 0);
    assert.strictEqual(partialEntryCheck.rows[0].cnt, 0);
    console.log('  ✓ Journal batch aggregation, idempotent replay, conflict rejection, and atomic rollback verified');
    totalPassed++;

    // -------------------------------------------------------------------------
    // SECTION 11: Multi-Connection PG Concurrency & Monotonic seq_no Ordering
    // -------------------------------------------------------------------------
    console.log('\n--- Section 11: Multi-Instance PG Concurrency & Monotonic seq_no ---');
    const concMerchantId = crypto.randomUUID();
    const concSuffix = crypto.randomBytes(3).toString('hex');
    await realPool.query(
      `INSERT INTO merchants (
         id, merchant_code, name, business_name, pan_number, pan_status,
         locality, address, latitude, longitude, phone, gstin, status,
         commission_rate_percent, bank_account_number, bank_ifsc, bank_account_holder, bank_name, bank_verified
       ) VALUES (
         $1, $2, $3, $4, 'ABCDE1234F', 'VALID_PAN',
         'Indiranagar', 'Conc Store', 12.97, 77.64, $5, '29ABCDE1234F1Z5', 'ACTIVE',
         10.00, '92000011223344', 'HDFC0001234', 'Conc Merchant', 'HDFC Bank', TRUE
       )`,
      [concMerchantId, `ZCONC_${concSuffix}`, `MCONC_${concSuffix}`, `Conc Merchant Co`, `+919511${concSuffix}`]
    );
    await realPool.query(
      `INSERT INTO seller_ledgers (merchant_id, entry_type, category, amount, running_balance, description)
       VALUES ($1, 'ORDER_CREDIT', 'CREDIT', 500.00, 500.00, 'Initial balance for concurrency race')`,
      [concMerchantId]
    );

    // Separate SellerSettlementService instances bypass the shared in-memory AsyncKeyedMutex,
    // proving PostgreSQL row locks serialize independent worker/pod connections!
    const podA = new SellerSettlementService();
    const podB = new SellerSettlementService();
    const [podResA, podResB] = await Promise.allSettled([
      podA.executeSellerPayout({ merchantId: concMerchantId, amount: 500.00 }),
      podB.executeSellerPayout({ merchantId: concMerchantId, amount: 500.00 }),
    ]);
    assert.strictEqual(
      [podResA, podResB].filter((r) => r.status === 'fulfilled').length,
      1,
      'Independent service instances competing on PG row locks must allow strictly 1 payout'
    );
    assert.strictEqual(
      [podResA, podResB].filter((r) => r.status === 'rejected').length,
      1,
      'Second competing worker instance must be rejected by PG balance check after FOR UPDATE'
    );

    // Concurrent inserts across two independent pg.Client connections with IDENTICAL created_at timestamps
    const clientConnA = new pg.Client({ connectionString: REAL_PG_URL });
    const clientConnB = new pg.Client({ connectionString: REAL_PG_URL });
    await clientConnA.connect();
    await clientConnB.connect();
    try {
      const fixedTs = new Date('2026-01-01T12:00:00.000Z');
      await Promise.all([
        clientConnA.query(
          `INSERT INTO seller_ledgers (merchant_id, entry_type, category, amount, running_balance, description, created_at)
           VALUES ($1, 'ADJUSTMENT', 'CREDIT', 10.00, 10.00, 'Same-ts conn A', $2)`,
          [concMerchantId, fixedTs]
        ),
        clientConnB.query(
          `INSERT INTO seller_ledgers (merchant_id, entry_type, category, amount, running_balance, description, created_at)
           VALUES ($1, 'ADJUSTMENT', 'CREDIT', 20.00, 30.00, 'Same-ts conn B', $2)`,
          [concMerchantId, fixedTs]
        ),
      ]);
      const seqOrderCheck = await realPool.query(
        `SELECT seq_no, amount FROM seller_ledgers
         WHERE merchant_id = $1 AND created_at = $2
         ORDER BY created_at DESC, seq_no DESC`,
        [concMerchantId, fixedTs]
      );
      assert.strictEqual(seqOrderCheck.rows.length, 2);
      assert.ok(
        Number(seqOrderCheck.rows[0].seq_no) > Number(seqOrderCheck.rows[1].seq_no),
        'Monotonic seq_no must strictly break identical-timestamp ties across concurrent connections'
      );
    } finally {
      await clientConnA.end().catch(() => {});
      await clientConnB.end().catch(() => {});
    }
    console.log('  ✓ Dual-instance PG race serialization & multi-connection monotonic seq_no ordering verified');
    totalPassed++;

    // -------------------------------------------------------------------------
    // SECTION 12: Complete Immutability (UPDATE/DELETE/TRUNCATE) & Non-Superuser Role
    // -------------------------------------------------------------------------
    console.log('\n--- Section 12: Full Ledger Immutability & Non-Superuser Role Verification ---');
    const batchRowRes = await realPool.query(
      `SELECT transaction_reference FROM ledger_journal_batches WHERE transaction_reference = $1`,
      [multiLineTxRef]
    );
    assert.strictEqual(batchRowRes.rows.length, 1);

    // TRUNCATE and batch-table UPDATE/DELETE blocked for owner/superuser too
    await assert.rejects(
      () => realPool.query(`UPDATE ledger_journal_batches SET total_debits = 999 WHERE transaction_reference = $1`, [multiLineTxRef]),
      /LEDGER_IMMUTABLE/
    );
    await assert.rejects(
      () => realPool.query(`DELETE FROM ledger_journal_batches WHERE transaction_reference = $1`, [multiLineTxRef]),
      /LEDGER_IMMUTABLE/
    );
    await assert.rejects(() => realPool.query(`TRUNCATE TABLE general_ledger_entries`), /LEDGER_IMMUTABLE/);
    await assert.rejects(() => realPool.query(`TRUNCATE TABLE ledger_journal_batches`), /LEDGER_IMMUTABLE/);
    await assert.rejects(() => realPool.query(`TRUNCATE TABLE seller_ledgers`), /LEDGER_IMMUTABLE/);
    await assert.rejects(() => realPool.query(`TRUNCATE TABLE rider_ledgers`), /LEDGER_IMMUTABLE/);

    // Verify with a real NOSUPERUSER PostgreSQL role (lowest privilege principle)
    const appRole = `qcom_app_verify_${crypto.randomBytes(3).toString('hex')}`;
    await realPool.query(`CREATE ROLE ${appRole} LOGIN PASSWORD 'app_verify_pwd' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    const rolePool = new pg.Pool({
      connectionString: REAL_PG_URL.replace('qcom_user:qcom_password', `${appRole}:app_verify_pwd`),
      max: 2,
    });
    try {
      await realPool.query(`GRANT USAGE ON SCHEMA public TO ${appRole}`);
      await realPool.query(`GRANT SELECT, INSERT ON general_ledger_entries, ledger_journal_batches, seller_ledgers, rider_ledgers TO ${appRole}`);
      await realPool.query(`GRANT SELECT ON general_ledger_accounts, merchants, riders, orders TO ${appRole}`);
      await realPool.query(`GRANT USAGE, SELECT ON SEQUENCE seq_seller_ledgers_order, seq_rider_ledgers_order TO ${appRole}`);

      const selOk = await rolePool.query(`SELECT COUNT(*)::int AS cnt FROM ledger_journal_batches`);
      assert.ok(selOk.rows[0].cnt > 0, 'Application role must retain SELECT');

      await rolePool.query(
        `INSERT INTO seller_ledgers (merchant_id, entry_type, category, amount, running_balance, description)
         VALUES ($1, 'ADJUSTMENT', 'CREDIT', 1.00, 31.00, 'Non-superuser insert check')`,
        [concMerchantId]
      );

      for (const tbl of ['general_ledger_entries', 'ledger_journal_batches', 'seller_ledgers', 'rider_ledgers']) {
        const updCol = tbl === 'ledger_journal_batches' ? `transaction_type = 'X'` : `amount = 1`;
        await assert.rejects(() => rolePool.query(`UPDATE ${tbl} SET ${updCol}`), /permission denied|LEDGER_IMMUTABLE/);
        await assert.rejects(() => rolePool.query(`DELETE FROM ${tbl}`), /permission denied|LEDGER_IMMUTABLE/);
        await assert.rejects(() => rolePool.query(`TRUNCATE TABLE ${tbl}`), /permission denied|must be owner|LEDGER_IMMUTABLE/);
      }
    } finally {
      await rolePool.end().catch(() => {});
      await realPool.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${appRole}`).catch(() => {});
      await realPool.query(`REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM ${appRole}`).catch(() => {});
      await realPool.query(`REVOKE USAGE ON SCHEMA public FROM ${appRole}`).catch(() => {});
      await realPool.query(`DROP ROLE IF EXISTS ${appRole}`).catch(() => {});
    }
    console.log('  ✓ UPDATE/DELETE/TRUNCATE triggers and non-superuser ACL enforcement verified across all 4 ledger tables');
    totalPassed++;

    // -------------------------------------------------------------------------
    // SECTION 13: Out-of-Order Webhooks & Cross-Actor Idempotency/COD Conflict Guards
    // -------------------------------------------------------------------------
    console.log('\n--- Section 13: Out-of-Order Webhooks & Cross-Actor Conflict Guards ---');
    // Out-of-order payout.processed arriving after REVERSED must be blocked for both Seller & Rider
    const oooSellerEvt = JSON.stringify({
      id: `evt_ooo_sel_${Date.now()}`,
      event: 'payout.processed',
      payload: { payout: { entity: { reference_id: revSellerPay.payoutReference, utr: 'UTR_OOO_BAD', amount: 100 } } },
    });
    const oooSellerRes = await financialWebhookService.processFinancialWebhook({
      rawBody: oooSellerEvt,
      signature: signWebhook(oooSellerEvt),
    });
    assert.strictEqual(oooSellerRes.duplicate, true, 'Out-of-order seller payout.processed after REVERSED must be ignored');
    assert.strictEqual(
      (await realPool.query(`SELECT status FROM seller_payouts WHERE id = $1`, [revSellerPay.payoutId])).rows[0].status,
      'REVERSED'
    );

    const oooRiderEvt = JSON.stringify({
      id: `evt_ooo_rid_${Date.now()}`,
      event: 'payout.processed',
      payload: { payout: { entity: { reference_id: riderPayRes.payoutReference, utr: 'UTR_OOO_RID', amount: 100 } } },
    });
    const oooRiderRes = await financialWebhookService.processFinancialWebhook({
      rawBody: oooRiderEvt,
      signature: signWebhook(oooRiderEvt),
    });
    assert.strictEqual(oooRiderRes.duplicate, true, 'Out-of-order rider payout.processed after REVERSED must be ignored');
    assert.strictEqual(
      (await realPool.query(`SELECT status FROM rider_payouts WHERE id = $1`, [riderPayRes.payoutId])).rows[0].status,
      'REVERSED'
    );

    // Cross-actor & amount-mismatch idempotencyKey rejection
    const idemSellerKey = `IDEM_SELL_CONFLICT_${Date.now()}`;
    const idemSellerOrder = await createDeliveredPaidOrder({ taxableAmount: 600, cgst: 54, sgst: 54, deliveryFee: 0, handlingFee: 0 });
    await settlementAllocationService.allocateFulfilledOrder(idemSellerOrder.orderId);
    const sPay1 = await sellerSettlementService.executeSellerPayout({
      merchantId,
      amount: 100.00,
      idempotencyKey: idemSellerKey,
    });
    assert.strictEqual(sPay1.status, 'PAID');
    // Same merchant & amount replays cleanly
    const sPayReplay = await sellerSettlementService.executeSellerPayout({
      merchantId,
      amount: 100.00,
      idempotencyKey: idemSellerKey,
    });
    assert.strictEqual(sPayReplay.isDuplicate, true);
    // Different merchant rejects
    await assert.rejects(
      () => sellerSettlementService.executeSellerPayout({ merchantId: concMerchantId, amount: 100.00, idempotencyKey: idemSellerKey }),
      /IDEMPOTENCY_KEY_CONFLICT/
    );
    // Different amount rejects
    await assert.rejects(
      () => sellerSettlementService.executeSellerPayout({ merchantId, amount: 101.00, idempotencyKey: idemSellerKey }),
      /IDEMPOTENCY_KEY_CONFLICT/
    );

    // Rider idempotencyKey conflicts (cross-rider, amount mismatch, method mismatch)
    const idemRiderKey = `IDEM_RID_CONFLICT_${Date.now()}`;
    const otherRiderId = crypto.randomUUID();
    await realPool.query(
      `INSERT INTO riders (id, rider_code, name, phone, status, vehicle_type, vehicle_plate, kyc_status, upi_vpa, wallet_balance)
       VALUES ($1, $2, 'Other Rider', $3, 'IDLE_AT_HUB', 'motorcycle', 'KA01XY9999', 'GREEN', 'other@okaxis', 500.00)`,
      [otherRiderId, `ZORD_${concSuffix}`, `+919522${concSuffix}`]
    );
    const rPay1 = await riderPayoutService.executeRiderPayout({
      riderId: otherRiderId,
      amount: 50.00,
      method: 'UPI',
      idempotencyKey: idemRiderKey,
    });
    assert.strictEqual(rPay1.status, 'PAID');
    await assert.rejects(
      () => riderPayoutService.executeRiderPayout({ riderId, amount: 50.00, method: 'UPI', idempotencyKey: idemRiderKey }),
      /IDEMPOTENCY_KEY_CONFLICT/
    );
    await assert.rejects(
      () => riderPayoutService.executeRiderPayout({ riderId: otherRiderId, amount: 60.00, method: 'UPI', idempotencyKey: idemRiderKey }),
      /IDEMPOTENCY_KEY_CONFLICT/
    );
    await assert.rejects(
      () => riderPayoutService.executeRiderPayout({ riderId: otherRiderId, amount: 50.00, method: 'BANK', idempotencyKey: idemRiderKey }),
      /IDEMPOTENCY_KEY_CONFLICT/
    );

    // Refund idempotencyKey cross-order & amount-mismatch rejection
    const refOrderA = await createDeliveredPaidOrder({ status: 'placed', paymentStatus: 'PAID', postPaymentGl: true, postTrip: false });
    const refOrderB = await createDeliveredPaidOrder({ status: 'placed', paymentStatus: 'PAID', postPaymentGl: true, postTrip: false });
    const idemRefundKey = `IDEM_REF_CONFLICT_${Date.now()}`;
    await refundService.createRefund({ orderId: refOrderA.orderId, amount: 25.00, reasonCode: 'TEST', idempotencyKey: idemRefundKey });
    await assert.rejects(
      () => refundService.createRefund({ orderId: refOrderB.orderId, amount: 25.00, reasonCode: 'TEST', idempotencyKey: idemRefundKey }),
      /IDEMPOTENCY_KEY_CONFLICT/
    );
    await assert.rejects(
      () => refundService.createRefund({ orderId: refOrderA.orderId, amount: 30.00, reasonCode: 'TEST', idempotencyKey: idemRefundKey }),
      /IDEMPOTENCY_KEY_CONFLICT/
    );

    // COD reference cross-rider & amount-mismatch rejection
    await assert.rejects(
      () => riderPayoutService.remitCodCash({ riderId: otherRiderId, amount: 2600, method: 'UPI', reference: remitRef }),
      /COD_REFERENCE_CONFLICT/
    );
    await assert.rejects(
      () => riderPayoutService.remitCodCash({ riderId, amount: 1500, method: 'UPI', reference: remitRef }),
      /COD_REFERENCE_AMOUNT_MISMATCH/
    );
    console.log('  ✓ Out-of-order terminal webhooks and cross-actor idempotency/COD reference conflicts blocked');
    totalPassed++;

    // -------------------------------------------------------------------------
    // SECTION 14: Partially Settled Order Clawback Splitting (2020 + 1040)
    // -------------------------------------------------------------------------
    console.log('\n--- Section 14: Partially Settled Clawback Splitting (2020 & 1040) & Precision ---');
    const splitMerchantId = crypto.randomUUID();
    const splitSuffix = crypto.randomBytes(3).toString('hex');
    await realPool.query(
      `INSERT INTO merchants (
         id, merchant_code, name, business_name, pan_number, pan_status,
         locality, address, latitude, longitude, phone, gstin, status,
         commission_rate_percent, bank_account_number, bank_ifsc, bank_account_holder, bank_name, bank_verified
       ) VALUES (
         $1, $2, $3, $4, 'ABCDE1234F', 'VALID_PAN',
         'HSR', 'Split Store', 12.91, 77.64, $5, '29ABCDE1234F1Z5', 'ACTIVE',
         10.00, '93000011223344', 'HDFC0001234', 'Split Merchant', 'HDFC Bank', TRUE
       )`,
      [splitMerchantId, `ZSPLIT_${splitSuffix}`, `MSPLIT_${splitSuffix}`, `Split Merchant Co`, `+919533${splitSuffix}`]
    );
    const splitOrderId = crypto.randomUUID();
    await realPool.query(
      `INSERT INTO orders (
         id, order_number, user_id, merchant_id, status, items_subtotal, delivery_fee, handling_fee,
         urgency_fee, discount_amount, taxable_amount, cgst_amount, sgst_amount, igst_amount,
         total_amount, withholding_amount, gst_tcs_amount, payment_method, payment_status,
         delivery_otp, handover_token, jobsite_address, place_of_supply_state_code, pricing_snapshot,
         placed_at, estimated_delivery_at, delivered_at, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, 'delivered', 333.33, 0, 0, 0, 0, 333.33, 30.00, 30.00, 0,
         393.33, 0, 0, 'Instant UPI', 'PAID', '112233', 'PK-SPLIT',
         '{"latitude":12.91,"longitude":77.64}'::jsonb, '29', '{}'::jsonb,
         NOW(), NOW() + INTERVAL '30 minutes', NOW(), NOW(), NOW()
       )`,
      [splitOrderId, `QC-SPL-${splitSuffix}`, userId, splitMerchantId]
    );
    await ledgerService.recordOrderPayment({
      orderId: splitOrderId,
      merchantId: splitMerchantId,
      grossAmount: 393.33,
      taxableAmount: 333.33,
      cgstAmount: 30.00,
      sgstAmount: 30.00,
      deliveryFee: 0,
      handlingFee: 0,
    });
    const splitAlloc = await settlementAllocationService.allocateFulfilledOrder(splitOrderId);
    // Partially settle ₹100.00 out of netSellerPayable -> status stays ALLOCATED, settled_amount = 100.00
    const partialPaySplit = await sellerSettlementService.executeSellerPayout({
      merchantId: splitMerchantId,
      amount: 100.00,
    });
    assert.strictEqual(partialPaySplit.status, 'PAID');
    const splitAllocMid = (
      await realPool.query(`SELECT status, settled_amount FROM order_settlement_allocations WHERE order_id = $1`, [splitOrderId])
    ).rows[0];
    assert.strictEqual(splitAllocMid.status, 'ALLOCATED');
    assert.strictEqual(Number(splitAllocMid.settled_amount), 100.00);

    // Full return on partially settled order must debit unsettled portion from 2020 AND settled ₹100.00 from 1040!
    const splitRetId = `ret_split_${splitSuffix}`;
    const splitClaw = await sellerSettlementService.processSellerClawback({
      orderId: splitOrderId,
      merchantId: splitMerchantId,
      refundAmount: 393.33,
      returnId: splitRetId,
    });
    assert.strictEqual(splitClaw.isPostPayout, true);
    assert.strictEqual(splitClaw.debitAmount, splitAlloc.netSellerPayable);
    assert.strictEqual(splitClaw.newBalance, -100.00, 'Remaining balance after full clawback must equal settled -100.00');

    const splitGl = await realPool.query(
      `SELECT account_code, entry_side, amount FROM general_ledger_entries WHERE transaction_reference = $1`,
      [`TX_RETURN_REFUND_${splitRetId}`]
    );
    const row2020 = splitGl.rows.find((r) => r.account_code === '2020');
    const row1040 = splitGl.rows.find((r) => r.account_code === '1040');
    assert.ok(row2020 && row1040, 'GL must split debits across BOTH 2020 (unsettled) and 1040 (settled)');
    assert.strictEqual(Number(roundCurrency(Number(splitAlloc.netSellerPayable) - 100.00)), Number(row2020.amount));
    assert.strictEqual(Number(row1040.amount), 100.00);
    console.log('  ✓ Partial-settlement clawback accurately split Dr 2020 & Dr 1040 with BigNumber precision');
    totalPassed++;

    // -------------------------------------------------------------------------
    // SECTION 15: Historical Migration 027 Backfill Verification (Disposable DB)
    // -------------------------------------------------------------------------
    console.log('\n--- Section 15: Migration 027 Pre-027 Historical Backfill on Disposable DB ---');
    const maintUrl = REAL_PG_URL.replace(/\/[^/?]+(\?.*)?$/, '/postgres$1');
    const disposableDbName = `qcom_s1551_backfill_${crypto.randomBytes(2).toString('hex')}`;
    const maintClient = new pg.Client({ connectionString: maintUrl });
    let dispPool: pg.Pool | null = null;
    await maintClient.connect();
    try {
      await maintClient.query(`DROP DATABASE IF EXISTS ${disposableDbName}`);
      await maintClient.query(`CREATE DATABASE ${disposableDbName}`);

      const dispUrl = REAL_PG_URL.replace(/\/[^/?]+(\?.*)?$/, `/${disposableDbName}$1`);
      dispPool = new pg.Pool({ connectionString: dispUrl, max: 3 });

      // Apply migrations 001..026 cleanly
      const hereDir = path.dirname(fileURLToPath(import.meta.url));
      const migrationsDir = path.resolve(hereDir, '../migrations');
      const allMigrations = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
      const pre027Migrations = allMigrations.filter((f) => !f.startsWith('027_'));
      const mig027File = allMigrations.find((f) => f.startsWith('027_'));
      assert.ok(mig027File, 'Migration 027 file must exist');

      await dispPool.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          id SERIAL PRIMARY KEY,
          filename TEXT NOT NULL UNIQUE,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      for (const file of pre027Migrations) {
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
        await dispPool.query(sql);
        await dispPool.query(`INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING`, [file]);
      }

      // Seed historical pre-027 rows
      const histMerchId = crypto.randomUUID();
      const histUserId = crypto.randomUUID();
      const histOrdSettled = crypto.randomUUID();
      const histOrdRev = crypto.randomUUID();
      await dispPool.query(`INSERT INTO users (id, phone, name) VALUES ($1, '+919999000011', 'Hist Cust')`, [histUserId]);
      await dispPool.query(
        `INSERT INTO merchants (id, merchant_code, name, business_name, pan_number, pan_status, locality, address, latitude, longitude, phone, gstin, status)
         VALUES ($1, 'HIST_M1', 'Hist Store', 'Hist Hardware Pvt Ltd', 'ABCDE1234F', 'VALID_PAN', 'BLR', 'Addr', 12.9, 77.6, '+919999000022', '29ABCDE1234F1Z5', 'ACTIVE')`,
        [histMerchId]
      );
      for (const [oid, onum] of [[histOrdSettled, 'HIST-O1'], [histOrdRev, 'HIST-O2']]) {
        await dispPool.query(
          `INSERT INTO orders (
             id, order_number, user_id, merchant_id, status, items_subtotal, delivery_fee, handling_fee,
             urgency_fee, discount_amount, taxable_amount, cgst_amount, sgst_amount, igst_amount,
             total_amount, withholding_amount, gst_tcs_amount, payment_method, payment_status,
             delivery_otp, handover_token, jobsite_address, place_of_supply_state_code, pricing_snapshot,
             placed_at, estimated_delivery_at, delivered_at
           ) VALUES (
             $1, $2, $3, $4, 'delivered', 400, 0, 0, 0, 0, 400, 0, 0, 0,
             400, 0, 0, 'Instant UPI', 'PAID',
             '123456', 'PK-HIST', '{"latitude":12.9,"longitude":77.6}'::jsonb, '29', '{}'::jsonb,
             NOW(), NOW() + INTERVAL '30 minutes', NOW()
           )`,
          [oid, onum, histUserId, histMerchId]
        );
      }
      await dispPool.query(
        `INSERT INTO general_ledger_accounts (account_code, account_name, category, normal_balance)
         VALUES
           ('1010', 'Cash at Gateway (Escrow)', 'ASSET', 'DEBIT'),
           ('2010', 'Customer Funds Held in Escrow', 'LIABILITY', 'CREDIT'),
           ('2020', 'Merchant Accounts Payable', 'LIABILITY', 'CREDIT'),
           ('1040', 'Merchant Receivables / Clawbacks', 'ASSET', 'DEBIT')
         ON CONFLICT (account_code) DO NOTHING`
      );

      const histTxRef = `TX_HIST_PRE027_${Date.now()}`;
      const histBatchId = crypto.randomUUID();
      await dispPool.query(
        `INSERT INTO general_ledger_entries (journal_batch_id, transaction_reference, transaction_type, account_code, entry_side, amount, order_id, merchant_id, narration)
         VALUES
           ($1, $2, 'CUSTOMER_PAYMENT', '1010', 'DEBIT', 400.00, $3, $4, 'Hist pre-027 Dr'),
           ($1, $2, 'CUSTOMER_PAYMENT', '2010', 'CREDIT', 400.00, $3, $4, 'Hist pre-027 Cr')`,
        [histBatchId, histTxRef, histOrdSettled, histMerchId]
      );

      await dispPool.query(
        `INSERT INTO order_settlement_allocations
           (order_id, merchant_id, journal_batch_id, order_total, gross_gmv, seller_goods_taxable, seller_goods_gst, platform_commission, commission_gst, net_seller_payable, status)
         VALUES
           ($1, $3, $4, 400.00, 400.00, 340.00, 0, 60.00, 0, 340.00, 'SETTLED'),
           ($2, $3, $4, 400.00, 400.00, 340.00, 0, 60.00, 0, 340.00, 'REVERSED')`,
        [histOrdSettled, histOrdRev, histMerchId, histBatchId]
      );

      const sameHistTs = new Date('2025-12-01T10:00:00.000Z');
      await dispPool.query(
        `INSERT INTO seller_ledgers (merchant_id, entry_type, category, amount, running_balance, description, created_at)
         VALUES
           ($1, 'ORDER_CREDIT', 'CREDIT', 340.00, 340.00, 'Hist 1', $2),
           ($1, 'PAYOUT_SETTLED', 'DEBIT', 340.00, 0.00, 'Hist 2', $2)`,
        [histMerchId, sameHistTs]
      );

      // Apply Migration 027 onto historical pre-027 database
      const mig027Sql = fs.readFileSync(path.join(migrationsDir, mig027File), 'utf-8');
      await dispPool.query(mig027Sql);

      const histSettledRow = (
        await dispPool.query(`SELECT settled_amount, refunded_amount FROM order_settlement_allocations WHERE order_id = $1`, [histOrdSettled])
      ).rows[0];
      assert.strictEqual(Number(histSettledRow.settled_amount), 340.00, '027 must backfill settled_amount for pre-027 SETTLED rows');

      const histRevRow = (
        await dispPool.query(`SELECT refunded_amount FROM order_settlement_allocations WHERE order_id = $1`, [histOrdRev])
      ).rows[0];
      assert.strictEqual(Number(histRevRow.refunded_amount), 340.00, '027 must backfill refunded_amount for pre-027 REVERSED rows');

      const histSeqRows = (
        await dispPool.query(`SELECT seq_no FROM seller_ledgers WHERE merchant_id = $1 ORDER BY seq_no ASC`, [histMerchId])
      ).rows;
      assert.ok(Number(histSeqRows[0].seq_no) >= 1 && Number(histSeqRows[1].seq_no) > Number(histSeqRows[0].seq_no));

      const histBatchCheck = (
        await dispPool.query(`SELECT journal_batch_id, payload_hash FROM ledger_journal_batches WHERE transaction_reference = $1`, [histTxRef])
      ).rows[0];
      assert.strictEqual(histBatchCheck.journal_batch_id, histBatchId);
      assert.strictEqual(histBatchCheck.payload_hash, 'LEGACY_BACKFILL');

      // Test ledgerService replay + conflict check against backfilled LEGACY_BACKFILL batch
      setPool(dispPool);
      const legacyReplayBatch = await ledgerService.postJournalBatch({
        txRef: histTxRef,
        transactionType: 'CUSTOMER_PAYMENT',
        lines: [
          { account: '1010', side: 'DEBIT', amount: 400.00, orderId: histOrdSettled, merchantId: histMerchId, narration: 'Hist' },
          { account: '2010', side: 'CREDIT', amount: 400.00, orderId: histOrdSettled, merchantId: histMerchId, narration: 'Hist' },
        ],
      });
      assert.strictEqual(legacyReplayBatch, histBatchId);
      await assert.rejects(
        () =>
          ledgerService.postJournalBatch({
            txRef: histTxRef,
            transactionType: 'CUSTOMER_PAYMENT',
            lines: [
              { account: '1010', side: 'DEBIT', amount: 401.00, orderId: histOrdSettled, merchantId: histMerchId, narration: 'Conflict' },
              { account: '2010', side: 'CREDIT', amount: 401.00, orderId: histOrdSettled, merchantId: histMerchId, narration: 'Conflict' },
            ],
          }),
        /LEDGER_TX_REF_CONFLICT/
      );
      setPool(realPool);
    } finally {
      setPool(realPool);
      if (dispPool) await dispPool.end().catch(() => {});
      await maintClient.query(`DROP DATABASE IF EXISTS ${disposableDbName}`).catch(() => {});
      await maintClient.end().catch(() => {});
    }
    console.log('  ✓ Migration 027 historical backfill & legacy batch compatibility verified on disposable PG16 DB');
    totalPassed++;

    // -------------------------------------------------------------------------
    // SECTION 16: Real PG 16 Concurrency for Journal Posting, Rider Payout, Refunds, Clawbacks & rider_ledgers seq_no
    // -------------------------------------------------------------------------
    console.log('\n--- Section 16: Real PG 16 Concurrency (Journal, Rider Payout, Refund, Clawback, seq_no) ---');
    // 16A. Concurrent Journal Batch Posting (identical replay & payload conflict race)
    const concTxSame = `TX_CONC_SAME_${Date.now()}`;
    const [jRes1, jRes2] = await Promise.all([
      ledgerService.postJournalBatch({
        txRef: concTxSame,
        transactionType: 'ADJUSTMENT',
        lines: [
          { account: '1010', side: 'DEBIT', amount: 75.00, merchantId: concMerchantId, narration: 'Conc same 1' },
          { account: '2020', side: 'CREDIT', amount: 75.00, merchantId: concMerchantId, narration: 'Conc same 1' },
        ],
      }),
      ledgerService.postJournalBatch({
        txRef: concTxSame,
        transactionType: 'ADJUSTMENT',
        lines: [
          { account: '1010', side: 'DEBIT', amount: 75.00, merchantId: concMerchantId, narration: 'Conc same 2' },
          { account: '2020', side: 'CREDIT', amount: 75.00, merchantId: concMerchantId, narration: 'Conc same 2' },
        ],
      }),
    ]);
    assert.strictEqual(jRes1, jRes2, 'Concurrent identical journal batch posts must resolve to one canonical batch ID');
    const concSameRows = await realPool.query(
      `SELECT COUNT(*)::int AS cnt FROM ledger_journal_batches WHERE transaction_reference = $1`,
      [concTxSame]
    );
    assert.strictEqual(concSameRows.rows[0].cnt, 1);

    const concTxDiff = `TX_CONC_DIFF_${Date.now()}`;
    const [jDiffA, jDiffB] = await Promise.allSettled([
      ledgerService.postJournalBatch({
        txRef: concTxDiff,
        transactionType: 'ADJUSTMENT',
        lines: [
          { account: '1010', side: 'DEBIT', amount: 50.00, merchantId: concMerchantId, narration: 'Diff A' },
          { account: '2020', side: 'CREDIT', amount: 50.00, merchantId: concMerchantId, narration: 'Diff A' },
        ],
      }),
      ledgerService.postJournalBatch({
        txRef: concTxDiff,
        transactionType: 'ADJUSTMENT',
        lines: [
          { account: '1010', side: 'DEBIT', amount: 60.00, merchantId: concMerchantId, narration: 'Diff B' },
          { account: '2020', side: 'CREDIT', amount: 60.00, merchantId: concMerchantId, narration: 'Diff B' },
        ],
      }),
    ]);
    assert.strictEqual([jDiffA, jDiffB].filter((r) => r.status === 'fulfilled').length, 1);
    assert.strictEqual([jDiffA, jDiffB].filter((r) => r.status === 'rejected').length, 1);

    // 16B. Concurrent Rider Payouts across independent instances (bypass AsyncKeyedMutex -> test PG FOR UPDATE)
    const concRiderId = crypto.randomUUID();
    const concRCode = `ZRCONC_${concSuffix}`;
    await realPool.query(
      `INSERT INTO riders (id, rider_code, name, phone, status, vehicle_type, vehicle_plate, kyc_status, upi_vpa, wallet_balance)
       VALUES ($1, $2, 'Conc Rider', $3, 'IDLE_AT_HUB', 'motorcycle', 'KA01ZZ8888', 'GREEN', 'concrider@okaxis', 200.00)`,
      [concRiderId, concRCode, `+919544${concSuffix}`]
    );
    const riderPodA = new RiderPayoutService();
    const riderPodB = new RiderPayoutService();
    const [rpResA, rpResB] = await Promise.allSettled([
      riderPodA.executeRiderPayout({ riderId: concRiderId, amount: 200.00, method: 'UPI' }),
      riderPodB.executeRiderPayout({ riderId: concRiderId, amount: 200.00, method: 'UPI' }),
    ]);
    assert.strictEqual([rpResA, rpResB].filter((r) => r.status === 'fulfilled').length, 1, 'Strictly 1 concurrent rider payout must win');
    assert.strictEqual([rpResA, rpResB].filter((r) => r.status === 'rejected').length, 1, 'Second concurrent rider payout must fail');
    const concRiderBal = Number((await realPool.query(`SELECT wallet_balance FROM riders WHERE id = $1`, [concRiderId])).rows[0].wallet_balance);
    assert.strictEqual(concRiderBal, 0, 'Concurrent rider payout race must leave wallet at 0.00 (no negative/double payout)');

    // 16C. Concurrent rider_ledgers inserts across two PG connections with identical created_at
    const rConnA = new pg.Client({ connectionString: REAL_PG_URL });
    const rConnB = new pg.Client({ connectionString: REAL_PG_URL });
    await rConnA.connect();
    await rConnB.connect();
    try {
      const fixedRiderTs = new Date('2026-01-02T12:00:00.000Z');
      await Promise.all([
        rConnA.query(
          `INSERT INTO rider_ledgers (rider_id, entry_type, category, amount, running_balance, description, created_at)
           VALUES ($1, 'ADJUSTMENT', 'CREDIT', 10.00, 10.00, 'Rider seq A', $2)`,
          [concRiderId, fixedRiderTs]
        ),
        rConnB.query(
          `INSERT INTO rider_ledgers (rider_id, entry_type, category, amount, running_balance, description, created_at)
           VALUES ($1, 'ADJUSTMENT', 'CREDIT', 20.00, 30.00, 'Rider seq B', $2)`,
          [concRiderId, fixedRiderTs]
        ),
      ]);
      const rSeqCheck = await realPool.query(
        `SELECT seq_no FROM rider_ledgers WHERE rider_id = $1 AND created_at = $2 ORDER BY created_at DESC, seq_no DESC`,
        [concRiderId, fixedRiderTs]
      );
      assert.strictEqual(rSeqCheck.rows.length, 2);
      assert.ok(Number(rSeqCheck.rows[0].seq_no) > Number(rSeqCheck.rows[1].seq_no));
    } finally {
      await rConnA.end().catch(() => {});
      await rConnB.end().catch(() => {});
    }

    // 16D. Concurrent Refunds across independent RefundService instances (PG FOR UPDATE ceiling protection)
    const concRefundOrder = await createDeliveredPaidOrder({ status: 'placed', paymentStatus: 'PAID', postPaymentGl: true, postTrip: false });
    const refPodA = new RefundService();
    const refPodB = new RefundService();
    const [refRaceA, refRaceB] = await Promise.allSettled([
      refPodA.createRefund({ orderId: concRefundOrder.orderId, amount: concRefundOrder.total, reasonCode: 'CONC_TEST' }),
      refPodB.createRefund({ orderId: concRefundOrder.orderId, amount: concRefundOrder.total, reasonCode: 'CONC_TEST' }),
    ]);
    assert.strictEqual([refRaceA, refRaceB].filter((r) => r.status === 'fulfilled').length, 1, 'Strictly 1 concurrent full refund must succeed');
    assert.strictEqual([refRaceA, refRaceB].filter((r) => r.status === 'rejected').length, 1, 'Second concurrent full refund must hit ceiling/status guard');

    // 16E. Concurrent Clawbacks against the same settled order
    const concClawOrder = await createDeliveredPaidOrder({ taxableAmount: 800, cgst: 72, sgst: 72, deliveryFee: 0, handlingFee: 0 });
    await settlementAllocationService.allocateFulfilledOrder(concClawOrder.orderId);
    const clawRaceStmt = await sellerSettlementService.getSellerSettlementStatement(merchantId);
    if (clawRaceStmt.outstandingBalance > 0) {
      await sellerSettlementService.executeSellerPayout({ merchantId, amount: clawRaceStmt.outstandingBalance });
    }
    const [cwA, cwB] = await Promise.all([
      sellerSettlementService.processSellerClawback({
        orderId: concClawOrder.orderId,
        merchantId,
        refundAmount: concClawOrder.total,
        returnId: `ret_cwA_${concSuffix}`,
      }),
      sellerSettlementService.processSellerClawback({
        orderId: concClawOrder.orderId,
        merchantId,
        refundAmount: concClawOrder.total,
        returnId: `ret_cwB_${concSuffix}`,
      }),
    ]);
    const nonZeroClaws = [cwA, cwB].filter((c) => c.debitAmount > 0);
    const zeroClaws = [cwA, cwB].filter((c) => c.debitAmount === 0);
    assert.strictEqual(nonZeroClaws.length, 1, 'Concurrent clawbacks on same order must execute strictly once');
    assert.strictEqual(zeroClaws.length, 1, 'Second concurrent clawback must observe REVERSED allocation and debit 0');
    console.log('  ✓ Concurrent PG 16 journal posting, rider payout, refunds, clawbacks, and rider_ledgers seq_no verified');
    totalPassed++;

    // -------------------------------------------------------------------------
    // SECTION 17: Global General Ledger Trial Balance Invariant
    // -------------------------------------------------------------------------
    console.log('\n--- Section 17: Global General Ledger Trial Balance Invariant ---');
    const tb = await ledgerService.getTrialBalance();
    assert.strictEqual(tb.isBalanced, true, `Global trial balance must balance (diff=${tb.difference})`);
    assert.strictEqual(tb.difference, 0);
    assert.ok(tb.totalDebits > 0 && tb.totalDebits === tb.totalCredits);
    console.log(`  ✓ Global Trial Balance Balanced: Debits ₹${tb.totalDebits} === Credits ₹${tb.totalCredits}`);
    totalPassed++;

    console.log('\n================================================================================');
    console.log(`  ALL SPRINT 15.5.1 FINANCIAL INTEGRITY TESTS PASSED (${totalPassed} / ${totalPassed})!`);
    console.log('================================================================================\n');

    return { totalPassed, totalTests: totalPassed };
  } finally {
    refundService.setProvider(originalRefundProvider);
    for (const sock of openSockets) {
      try {
        sock.terminate();
      } catch {
        // Ignore socket cleanup errors
      }
    }
    realtimeGateway.close();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    setPool(null as any);
    setRedisClient(null);
    await redisProbeClient.quit().catch(() => {});
    await realPool.end().catch(() => {});
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runSprint15_5FinancialLedgerSettlementIntegrityTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Sprint 15.5 Financial Ledger & Settlement Integrity Suite Failed:', err);
      process.exit(1);
    });
}
