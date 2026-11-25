import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { setPool } from '../src/database/connection.js';
import { runMigrations } from '../src/database/migrator.js';
import { getRedisClient, setRedisClient } from '../src/database/redis.js';
import { runSeeds } from '../seeds/seedData.js';
import { AuthService } from '../src/modules/auth/authService.js';
import { deliveryCompletionService } from '../src/modules/delivery/deliveryCompletionService.js';
import { candidateGenerator } from '../src/modules/dispatch/candidateGenerator.js';
import { dispatchService } from '../src/modules/dispatch/dispatchService.js';
import { ledgerService } from '../src/modules/ledger/ledgerService.js';
import { cancellationService } from '../src/modules/orders/cancellationService.js';
import { returnService } from '../src/modules/orders/returnService.js';
import { paymentLogger } from '../src/modules/payments/paymentLogger.js';
import { refundService } from '../src/modules/payments/refundService.js';
import { roundCurrency } from '../src/modules/pricing/money.js';
import { paymentReconciliationService } from '../src/modules/reconciliation/paymentReconciliationService.js';
import { financialRecoveryWorker } from '../src/modules/recovery/financialRecoveryWorker.js';
import {
  CodAccountabilityError,
  codCashAccountabilityService,
} from '../src/modules/settlements/codCashAccountabilityService.js';
import { riderPayoutService } from '../src/modules/settlements/riderPayoutService.js';
import { settlementAllocationService } from '../src/modules/settlements/settlementAllocationService.js';
import { createTestDatabase } from './helpers/testDb.js';

export async function runSprint15_9CodCashAccountabilityTests(): Promise<void> {
  console.log('\n================================================================================');
  console.log('  SPRINT 15.9 — COD CASH ACCOUNTABILITY, REMITTANCE & RECONCILIATION INTEGRITY');
  console.log('================================================================================');

  const { pool } = createTestDatabase();
  setPool(pool);
  await runMigrations({ poolOverride: pool });
  await runSeeds(pool);
  paymentLogger.resetMetrics();

  const app = createApp();
  const authService = new AuthService();

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as any;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  async function apiCall(
    pathUrl: string,
    opts: { method?: string; token?: string; body?: any; headers?: Record<string, string> } = {}
  ): Promise<{ status: number; data: any; headers: Headers }> {
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
    return { status: res.status, data, headers: res.headers };
  }

  let passedGroups = 0;

  try {
    // -------------------------------------------------------------------------
    // Shared Actors & Fixtures
    // -------------------------------------------------------------------------
    const adminAuth = await authService.adminLogin(
      'EMP-001',
      process.env.SEED_ADMIN_PASSWORD || 'QcomSeedAdmin#2026',
      '127.0.0.1',
      'AdminPortal',
      pool
    );
    const adminToken = adminAuth.accessToken;
    const adminUserId = adminAuth.user.id;

    const opsAuth = await authService.adminLogin(
      'OPS',
      process.env.SEED_ADMIN_PASSWORD || 'QcomSeedAdmin#2026',
      '127.0.0.1',
      'AdminPortal',
      pool
    );
    const opsToken = opsAuth.accessToken;
    const opsUserId = opsAuth.user.id;

    // Dedicated Finance Admin actor (distinct from EMP-001 & OPS)
    const finUserId = crypto.randomUUID();
    const finPhone = '+91-8000000099';
    await pool.query(
      `INSERT INTO users (id, phone, name, email, is_phone_verified, account_type)
       VALUES ($1, $2, 'Finance Controller', 'finance159@qcom.local', TRUE, 'business')`,
      [finUserId, finPhone]
    );
    const finRoleRes = await pool.query(`SELECT id FROM roles WHERE code = 'FINANCE_ADMIN' LIMIT 1`);
    await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [finUserId, finRoleRes.rows[0].id]);
    const finOtp = await authService.requestOtp(finPhone, 'LOGIN', '127.0.0.1', pool);
    const finAuth = await authService.verifyOtp(finPhone, finOtp.debugOtp!, 'LOGIN', '127.0.0.1', 'AdminPortal', undefined, pool);
    const finToken = finAuth.accessToken;

    const custOtp = await authService.requestOtp('+91-9123456780', 'LOGIN', '127.0.0.1', pool);
    const custAuth = await authService.verifyOtp(
      '+91-9123456780',
      custOtp.debugOtp!,
      'LOGIN',
      '127.0.0.1',
      'CustomerApp',
      'Customer 15.9',
      pool
    );
    const custToken = custAuth.accessToken;
    const custId = custAuth.user.id;

    const rider1Otp = await authService.requestOtp('+91-9812345678', 'LOGIN', '127.0.0.1', pool);
    const rider1Auth = await authService.verifyOtp('+91-9812345678', rider1Otp.debugOtp!, 'LOGIN', '127.0.0.1', 'DeliveryApp', undefined, pool);
    const rider1Token = rider1Auth.accessToken;
    const rider1UserId = rider1Auth.user.id;
    const rider1Id = (await pool.query(`SELECT id FROM riders WHERE phone = '+91-9812345678' LIMIT 1`)).rows[0].id as string;

    const rider2Otp = await authService.requestOtp('+91-9812345679', 'LOGIN', '127.0.0.1', pool);
    const rider2Auth = await authService.verifyOtp('+91-9812345679', rider2Otp.debugOtp!, 'LOGIN', '127.0.0.1', 'DeliveryApp', undefined, pool);
    const rider2Token = rider2Auth.accessToken;
    const rider2UserId = rider2Auth.user.id;
    const rider2Id = (await pool.query(`SELECT id FROM riders WHERE phone = '+91-9812345679' LIMIT 1`)).rows[0].id as string;

    const merchRow = (await pool.query(`SELECT id, latitude, longitude FROM merchants WHERE merchant_code = 'MERCH-BLR-01' LIMIT 1`)).rows[0];
    const merchantId = merchRow.id as string;
    const storeLat = Number(merchRow.latitude);
    const storeLng = Number(merchRow.longitude);

    const prodRow = (
      await pool.query(
        `SELECT p.id, p.name, si.selling_price FROM products p JOIN store_inventory si ON si.product_id = p.id WHERE si.merchant_id = $1 LIMIT 1`,
        [merchantId]
      )
    ).rows[0];
    const productId = prodRow.id as string;
    const productName = prodRow.name as string;

    await pool.query(`UPDATE store_inventory SET stock_count = 500 WHERE merchant_id = $1 AND product_id = $2`, [merchantId, productId]);
    await pool.query(
      `UPDATE riders
       SET status = 'AVAILABLE',
           floating_cash_balance = 0.00,
           floating_cash_limit = 2500.00,
           cod_restricted = FALSE,
           cod_restriction_reason = NULL,
           cod_restricted_at = NULL,
           active_cod_dispute_count = 0,
           cod_ceiling_override_limit = NULL,
           cod_ceiling_override_until = NULL,
           latitude = $1,
           longitude = $2,
           location_updated_at = NOW(),
           wallet_balance = 1000.00,
           upi_vpa = 'rider77@okhdfcbank'
       WHERE id = $3`,
      [storeLat + 0.003, storeLng + 0.003, rider1Id]
    );
    await pool.query(
      `UPDATE riders
       SET status = 'AVAILABLE',
           floating_cash_balance = 0.00,
           floating_cash_limit = 2500.00,
           cod_restricted = FALSE,
           cod_restriction_reason = NULL,
           active_cod_dispute_count = 0,
           latitude = $1,
           longitude = $2,
           location_updated_at = NOW(),
           wallet_balance = 500.00,
           upi_vpa = 'rider78@okhdfcbank'
       WHERE id = $3`,
      [storeLat + 0.004, storeLng + 0.004, rider2Id]
    );

    async function seedOrderWithTrip(opts: {
      paymentMethod?: 'Pay on Delivery' | 'Instant UPI';
      paymentStatus?: string;
      status?: string;
      tripStatus?: string;
      riderId?: string | null;
      totalAmount?: number;
      postPaymentGl?: boolean;
    }) {
      const orderId = crypto.randomUUID();
      const tripId = crypto.randomUUID();
      const orderItemId = crypto.randomUUID();
      const otp = '739152';
      const total = Number(roundCurrency(opts.totalAmount ?? 500.0));
      const method = opts.paymentMethod || 'Pay on Delivery';
      const taxable = Number(roundCurrency(total / 1.18));
      const gst = Number(roundCurrency(total - taxable));
      const pricingSnapshot = {
        sellerGoodsBreakdown: {
          taxableAmount: taxable,
          totalGst: gst,
          totalSellerPayable: total,
        },
        qcomFeesBreakdown: {
          deliveryTaxable: 0,
          deliveryGst: 0,
          handlingTaxable: 0,
          handlingGst: 0,
          totalGst: 0,
        },
      };

      const cgst = Number(roundCurrency(gst / 2));
      const sgst = Number(roundCurrency(gst - cgst));

      await pool.query(
        `INSERT INTO orders (
           id, order_number, user_id, merchant_id, status,
           items_subtotal, delivery_fee, handling_fee, urgency_fee, discount_amount,
           taxable_amount, cgst_amount, sgst_amount, igst_amount, total_amount,
           payment_method, payment_status, delivery_otp, handover_token,
           jobsite_address, pricing_snapshot, placed_at, estimated_delivery_at
         ) VALUES (
           $1, $2, $3, $4, $5,
           $6, 0.00, 0.00, 0.00, 0.00,
           $7, $8, $9, 0.00, $10,
           $11, $12, $13, $14,
           $15, $16, NOW(), NOW() + INTERVAL '30 minutes'
         )`,
        [
          orderId,
          `ORD159-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`,
          custId,
          merchantId,
          opts.status || 'out_for_delivery',
          total,
          taxable,
          cgst,
          sgst,
          total,
          method,
          opts.paymentStatus || (method === 'Pay on Delivery' ? 'PENDING' : 'PAID'),
          otp,
          `HND-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
          JSON.stringify({ address: 'Site 15.9', latitude: storeLat + 0.015, longitude: storeLng + 0.015 }),
          JSON.stringify(pricingSnapshot),
        ]
      );

      await pool.query(
        `INSERT INTO order_items (
           id, order_id, product_id, product_name, quantity, unit_price,
           total_price, taxable_amount, cgst_amount, sgst_amount, igst_amount,
           hsn_code, gst_rate_percent
         ) VALUES ($1, $2, $3, $4, 1, $5, $5, $6, $7, $8, 0.00, '84672100', 18.00)`,
        [orderItemId, orderId, productId, productName, total, taxable, cgst, sgst]
      );

      const nowTs = new Date();
      await pool.query(
        `INSERT INTO delivery_trips (
           id, order_id, trip_type, rider_id, status,
           base_fare, distance_fare, surge_fare, total_rider_payout,
           cod_due_amount, accepted_at, picked_up_at
         ) VALUES (
           $1, $2, 'FORWARD', $3, $4,
           30.00, 15.00, 0.00, 45.00,
           $5, $6, $7
         )`,
        [
          tripId,
          orderId,
          opts.riderId === undefined ? rider1Id : opts.riderId,
          opts.tripStatus || 'PICKED_UP',
          method === 'Pay on Delivery' ? total : 0,
          opts.riderId === null ? null : nowTs,
          (opts.tripStatus || 'PICKED_UP') === 'PICKED_UP' ? nowTs : null,
        ]
      );

      if (opts.postPaymentGl) {
        await ledgerService.recordOrderPayment({
          orderId,
          merchantId,
          grossAmount: total,
          taxableAmount: taxable,
          cgstAmount: cgst,
          sgstAmount: sgst,
          deliveryFee: 0,
          handlingFee: 0,
        });
      }

      return { orderId, tripId, orderItemId, otp, total };
    }

    // =========================================================================
    // GROUP A: Cash Collection Integrity
    // =========================================================================
    console.log('\n[Group A] Testing COD Collection Integrity & Rejection of Tampered/Invalid/Partial Inputs...');
    const codA1 = await seedOrderWithTrip({ paymentMethod: 'Pay on Delivery', totalAmount: 333.33 });

    // Partial collection explicitly forbidden via OTP route
    const partialRes = await apiCall(`/api/tasks/${codA1.tripId}/verify-otp`, {
      method: 'POST',
      token: rider1Token,
      body: { otp: codA1.otp, allowPartial: true, cashCollected: 100 },
    });
    assert.strictEqual(partialRes.status, 400);
    assert.strictEqual(partialRes.data.error, 'PARTIAL_COD_NOT_SUPPORTED');

    // Valid OTP completion ignores client-tampered cashCollected & derives authoritative 333.33
    const completeA1 = await apiCall(`/api/tasks/${codA1.tripId}/verify-otp`, {
      method: 'POST',
      token: rider1Token,
      body: { otp: codA1.otp, cashCollected: 1.00, codAmountCollected: 9999.00 },
    });
    assert.strictEqual(completeA1.status, 200, `Expected 200 on COD completion, got ${JSON.stringify(completeA1.data)}`);
    assert.strictEqual(completeA1.data.codCollectedAmount, 333.33);

    const colRowA1 = (await pool.query(`SELECT * FROM cod_collections WHERE order_id = $1`, [codA1.orderId])).rows[0];
    assert.ok(colRowA1, 'cod_collections row must be created atomically on COD delivery');
    assert.strictEqual(Number(colRowA1.collected_amount), 333.33);
    assert.strictEqual(colRowA1.status, 'COLLECTED');

    const tripA1 = (await pool.query(`SELECT cod_collected_amount, cod_reconciled FROM delivery_trips WHERE id = $1`, [codA1.tripId])).rows[0];
    assert.strictEqual(Number(tripA1.cod_collected_amount), 333.33);
    assert.strictEqual(tripA1.cod_reconciled, false, 'Collection must NEVER mark trip cod_reconciled = TRUE before remittance verification');

    // Duplicate same-rider collection call is idempotent; other rider blocked
    const dupColSameRider = await codCashAccountabilityService.recordCodCollection({
      orderId: codA1.orderId,
      tripId: codA1.tripId,
      riderId: rider1Id,
    });
    assert.strictEqual(dupColSameRider.alreadyExisted, true);
    await assert.rejects(
      () => codCashAccountabilityService.recordCodCollection({ orderId: codA1.orderId, riderId: rider2Id }),
      (e: any) => e instanceof CodAccountabilityError && e.errorCode === 'COD_ALREADY_COLLECTED_OTHER_RIDER'
    );

    // Non-COD order & cancelled order cannot record COD collection
    const nonCodOrd = await seedOrderWithTrip({ paymentMethod: 'Instant UPI', paymentStatus: 'PAID', totalAmount: 250, postPaymentGl: true });
    await assert.rejects(
      () => codCashAccountabilityService.recordCodCollection({ orderId: nonCodOrd.orderId, riderId: rider1Id }),
      (e: any) => e instanceof CodAccountabilityError && e.errorCode === 'NON_COD_ORDER'
    );

    // Uncollected COD order cannot be refunded & pre-delivery COD cancellation creates zero cash refund
    const uncollectedCod = await seedOrderWithTrip({
      paymentMethod: 'Pay on Delivery',
      paymentStatus: 'PENDING',
      status: 'placed',
      tripStatus: 'BROADCASTING',
      riderId: null,
      totalAmount: 420.0,
    });
    await assert.rejects(
      () => refundService.createRefund({ orderId: uncollectedCod.orderId, amount: 420, reasonCode: 'TEST' }),
      /ORDER_NOT_REFUNDABLE/
    );
    const spoofedPaidUncollectedCod = await seedOrderWithTrip({
      paymentMethod: 'Pay on Delivery',
      paymentStatus: 'PAID',
      status: 'placed',
      tripStatus: 'BROADCASTING',
      riderId: null,
      totalAmount: 420.0,
    });
    await assert.rejects(
      () => refundService.createRefund({ orderId: spoofedPaidUncollectedCod.orderId, amount: 420, reasonCode: 'TEST' }),
      /COD_REFUND_NO_COLLECTION/
    );
    const cancelUncollected = await cancellationService.cancelByCustomer({
      orderId: uncollectedCod.orderId,
      userId: custId,
      reason: 'Changed mind',
    });
    assert.strictEqual(cancelUncollected.refund?.status, 'NO_PAYMENT_CAPTURED', 'Cancelled uncollected COD order must NOT issue gateway or cash refund');

    // Delivered & collected COD order return refund completes without external gateway & credits 1020 (not 1010)
    await settlementAllocationService.allocateFulfilledOrder(codA1.orderId);
    const codRetReq = await returnService.requestReturn({
      orderId: codA1.orderId,
      userId: custId,
      items: [{ orderItemId: codA1.orderItemId, quantity: 1 }],
      reasonCode: 'DAMAGED',
    });
    const codQcRes = await returnService.qcInspectAndResolve({
      returnId: codRetReq.returnRequest.id,
      merchantId,
      itemDecisions: [{ returnItemId: codRetReq.returnRequest.items[0].id, qcPassed: true, notes: 'Verified damage' }],
      qcNotes: 'Verified damage',
    });
    assert.strictEqual(codQcRes.refund?.status, 'COMPLETED');
    assert.ok(codQcRes.refund?.paymentId?.startsWith('cod_coll_'));
    const codRefundTx = (
      await pool.query(`SELECT provider_id FROM payment_transactions WHERE refund_id = $1`, [codQcRes.refund?.id])
    ).rows[0];
    assert.strictEqual(codRefundTx?.provider_id, 'COD_BANK_TRANSFER');
    const codReturnGl1020 = await pool.query(
      `SELECT account_code, entry_side, amount FROM general_ledger_entries
       WHERE order_id = $1 AND transaction_type = 'REFUND' AND account_code = '1020' AND entry_side = 'CREDIT'`,
      [codA1.orderId]
    );
    assert.strictEqual(codReturnGl1020.rows.length, 1, 'Returned COD order must credit Bank Account 1020, not 1010 Gateway Escrow');
    assert.strictEqual(Number(codReturnGl1020.rows[0].amount), 333.33);

    console.log('✓ Group A Passed: Collection integrity, partial/tamper/non-COD/cancelled guards & COD return accounting verified');
    passedGroups++;

    // =========================================================================
    // GROUP B: Decimal Math, Metrics A-H, Ceiling Blocking & Temporary Override
    // =========================================================================
    console.log('\n[Group B] Testing Decimal Math, Rider Cash Metrics A-H, Dispatch Ceiling Blocking & Temporary Override...');
    const codB1 = await seedOrderWithTrip({ paymentMethod: 'Pay on Delivery', totalAmount: 444.44 });
    const codB2 = await seedOrderWithTrip({ paymentMethod: 'Pay on Delivery', totalAmount: 222.23 });
    await deliveryCompletionService.completeDeliveryWithOtp({
      taskId: codB1.tripId,
      otp: codB1.otp,
      actor: { riderId: rider1Id, isDispatchAdmin: false, actorUserId: rider1UserId },
    });
    await deliveryCompletionService.completeDeliveryWithOtp({
      taskId: codB2.tripId,
      otp: codB2.otp,
      actor: { riderId: rider1Id, isDispatchAdmin: false, actorUserId: rider1UserId },
    });
    // Total collected on rider1 = 333.33 + 444.44 + 222.23 = 1000.00 exact!
    const sumRes = await apiCall(`/api/v1/settlements/rider/${rider1Id}/cod-summary`, { token: rider1Token });
    assert.strictEqual(sumRes.status, 200);
    assert.strictEqual(sumRes.data.summary.totalCodCollected, 1000.0);
    assert.strictEqual(sumRes.data.summary.totalRiderCashLiability, 1000.0);
    assert.strictEqual(sumRes.data.summary.materializedFloatingCashBalance, 1000.0);
    assert.strictEqual(sumRes.data.summary.ledger1030NetBalance, 1000.0);
    assert.strictEqual(sumRes.data.summary.ledgerDriftAmount, 0);
    assert.strictEqual(sumRes.data.summary.totalOutstandingAmount, 1000.0);

    // Cross ceiling (>= 2500) -> triggers cod_restricted + SUSPENDED + excluded from COD dispatch
    const codB3 = await seedOrderWithTrip({ paymentMethod: 'Pay on Delivery', totalAmount: 1550.0 });
    await deliveryCompletionService.completeDeliveryWithOtp({
      taskId: codB3.tripId,
      otp: codB3.otp,
      actor: { riderId: rider1Id, isDispatchAdmin: false, actorUserId: rider1UserId },
    });

    const r1CeilingRow = (await pool.query(`SELECT status, floating_cash_balance, cod_restricted, cod_restriction_reason FROM riders WHERE id = $1`, [rider1Id])).rows[0];
    assert.strictEqual(Number(r1CeilingRow.floating_cash_balance), 2550.0);
    assert.strictEqual(r1CeilingRow.cod_restricted, true);
    assert.strictEqual(r1CeilingRow.cod_restriction_reason, 'CASH_CEILING_EXCEEDED');
    assert.strictEqual(r1CeilingRow.status, 'SUSPENDED');

    // Verify candidateGenerator & admin manual COD assignment exclude restricted rider1
    const codOrderNew = await seedOrderWithTrip({ paymentMethod: 'Pay on Delivery', status: 'packed', tripStatus: 'BROADCASTING', riderId: null, totalAmount: 300 });
    const candsCod = await candidateGenerator.generateCandidates({
      orderId: codOrderNew.orderId,
      merchantId,
      storeLocation: { latitude: storeLat, longitude: storeLng },
      customerLocation: { latitude: storeLat + 0.01, longitude: storeLng + 0.01 },
      itemsSubtotal: 275,
      customerDeliveryFee: 20,
      handlingFee: 5,
      paymentMethod: 'Pay on Delivery',
      orderTotal: 300,
    });
    assert.ok(!candsCod.some((c) => c.riderId === rider1Id), 'Over-ceiling COD rider must be excluded from COD dispatch candidates');
    const adminAssignDenied = await apiCall(`/api/admin/orders/${codOrderNew.orderId}/assign-rider`, {
      method: 'POST',
      token: adminToken,
      body: { riderId: rider1Id },
    });
    assert.strictEqual(adminAssignDenied.status, 409);
    assert.strictEqual(adminAssignDenied.data.error, 'RIDER_COD_RESTRICTED');

    // Authorized temporary ceiling override unblocks dispatch temporarily WITHOUT altering liability!
    const overrideRes = await apiCall(`/api/v1/settlements/cod/riders/${rider1Id}/ceiling-override`, {
      method: 'POST',
      token: finToken,
      body: { overrideLimit: 4000, durationMinutes: 30, reason: 'Peak festive shift cash drop window approved' },
    });
    assert.strictEqual(overrideRes.status, 200);
    assert.strictEqual(overrideRes.data.override.isCodRestricted, false);
    assert.strictEqual(overrideRes.data.override.riderStatus, 'IDLE_AT_HUB');

    const afterOverrideSummary = await codCashAccountabilityService.getRiderCashSummary(rider1Id);
    assert.strictEqual(afterOverrideSummary.totalRiderCashLiability, 2550.0, 'Ceiling override must NEVER erase liability');
    assert.strictEqual(afterOverrideSummary.effectiveCashCeiling, 4000.0);

    // Expire override -> recovery worker re-syncs restriction cleanly!
    await pool.query(`UPDATE riders SET cod_ceiling_override_until = NOW() - INTERVAL '1 minute' WHERE id = $1`, [rider1Id]);
    await financialRecoveryWorker.monitorCodRemittancesAndOverrides();
    const afterExpiry = (await pool.query(`SELECT cod_restricted, status FROM riders WHERE id = $1`, [rider1Id])).rows[0];
    assert.strictEqual(afterExpiry.cod_restricted, true, 'Expired ceiling override must restore COD restriction automatically');
    assert.strictEqual(afterExpiry.status, 'SUSPENDED');

    console.log('✓ Group B Passed: Exact decimal summation, metrics A-H, dispatch blocking & audited override expiry verified');
    passedGroups++;

    // =========================================================================
    // GROUP C: Multi-Stage Remittance & Separation of Duties
    // =========================================================================
    console.log('\n[Group C] Testing Multi-Stage Remittance, Allocations & Two-Person Separation of Duties...');
    // Draft -> Submit -> Reject -> Re-submit with FIFO
    const draftRes = await apiCall('/api/v1/settlements/cod/remittances', {
      method: 'POST',
      token: rider1Token,
      headers: { 'Idempotency-Key': 'idem_draft_159_a' },
      body: {
        riderId: rider1Id,
        amount: 333.33,
        method: 'CASH_HUB',
        asDraft: true,
        orderIds: [codA1.orderId],
      },
    });
    assert.strictEqual(draftRes.status, 201, `Expected 201 on draft remittance, got ${draftRes.status}: ${JSON.stringify(draftRes.data)}`);
    const draftId = draftRes.data.remittance.remittanceId as string;
    assert.strictEqual(draftRes.data.remittance.status, 'DRAFT');

    // Finalize DRAFT -> SUBMITTED
    const subRes = await apiCall(`/api/v1/settlements/cod/remittances/${draftId}/submit`, {
      method: 'POST',
      token: rider1Token,
    });
    assert.strictEqual(subRes.status, 200);
    assert.strictEqual(subRes.data.remittance.status, 'SUBMITTED');

    // Rejecting draft remittance releases reserved allocation cleanly
    const rejRes = await apiCall(`/api/v1/settlements/cod/remittances/${draftId}/reject`, {
      method: 'POST',
      token: opsToken,
      body: { reason: 'Envelope damaged during transit; resubmit' },
    });
    assert.strictEqual(rejRes.status, 200);
    assert.strictEqual(rejRes.data.remittance.status, 'REJECTED');
    const releasedCol = (await pool.query(`SELECT allocated_amount, status FROM cod_collections WHERE order_id = $1`, [codA1.orderId])).rows[0];
    assert.strictEqual(Number(releasedCol.allocated_amount), 0);
    assert.strictEqual(releasedCol.status, 'COLLECTED');

    // Legacy /cod/remit submission for ₹1000.00 (allocating FIFO codA1 333.33 + codB1 444.44 + codB2 222.23)
    const legacyRemit = await apiCall('/api/v1/settlements/cod/remit', {
      method: 'POST',
      token: rider1Token,
      headers: { 'Idempotency-Key': 'idem_remit_fifo_1000' },
      body: { riderId: rider1Id, amount: 1000.0, method: 'CASH_HUB', collectionLocation: 'BLR-HUB-01' },
    });
    assert.strictEqual(legacyRemit.status, 200);
    assert.strictEqual(legacyRemit.data.status, 'SUBMITTED');
    assert.strictEqual(legacyRemit.data.liabilityCleared, false);
    assert.strictEqual(legacyRemit.data.remainingCash, 2550.0);
    assert.strictEqual(legacyRemit.data.unblocked, false);
    assert.strictEqual(legacyRemit.data.allocatedCollections.length, 3);
    const rem1Id = legacyRemit.data.remittanceId as string;

    // Double allocation on already-allocated codA1 must be blocked!
    const doubleAlloc = await apiCall('/api/v1/settlements/cod/remittances', {
      method: 'POST',
      token: rider1Token,
      body: { riderId: rider1Id, amount: 333.33, orderIds: [codA1.orderId] },
    });
    assert.strictEqual(doubleAlloc.status, 409);
    assert.strictEqual(doubleAlloc.data.error, 'COLLECTION_ALREADY_ALLOCATED_OR_INSUFFICIENT');

    // Conflicting idempotency key payload rejected
    const conflictKey = await apiCall('/api/v1/settlements/cod/remit', {
      method: 'POST',
      token: rider1Token,
      headers: { 'Idempotency-Key': 'idem_remit_fifo_1000' },
      body: { riderId: rider1Id, amount: 500.0, method: 'CASH_HUB' },
    });
    assert.strictEqual(conflictKey.status, 409);

    // Skipping receipt to verify -> blocked
    const skipRec = await apiCall(`/api/v1/settlements/cod/remittances/${rem1Id}/verify`, {
      method: 'POST',
      token: finToken,
      body: { verifiedAmount: 1000.0 },
    });
    assert.strictEqual(skipRec.status, 409);
    assert.strictEqual(skipRec.data.error, 'REMITTANCE_RECEIPT_REQUIRED');

    // Two-person checks: Rider cannot receive; Receiver cannot verify
    await assert.rejects(
      () => codCashAccountabilityService.acknowledgeReceipt({ remittanceId: rem1Id, receiverUserId: rider1UserId }),
      (e: any) => e instanceof CodAccountabilityError && e.errorCode === 'SELF_RECEIPT_FORBIDDEN'
    );

    const rec1Res = await apiCall(`/api/v1/settlements/cod/remittances/${rem1Id}/receive`, {
      method: 'POST',
      token: opsToken,
      body: { receivedAmount: 1000.0, collectionLocation: 'BLR-HUB-01', evidenceReference: 'SLIP-001' },
    });
    assert.strictEqual(rec1Res.status, 200);
    assert.strictEqual(rec1Res.data.remittance.status, 'RECEIVED');

    // Operations receiver lacks FINANCE_ADMIN verify role -> 403 FORBIDDEN_ROLE; AND two-person check rejects receiver even at service layer -> RECEIVER_VERIFICATION_CONFLICT
    const selfVerRes = await apiCall(`/api/v1/settlements/cod/remittances/${rem1Id}/verify`, {
      method: 'POST',
      token: opsToken,
      body: { verifiedAmount: 1000.0 },
    });
    assert.strictEqual(selfVerRes.status, 403);
    assert.strictEqual(selfVerRes.data.error, 'FORBIDDEN_ROLE');
    await assert.rejects(
      () => codCashAccountabilityService.verifyRemittance({
        remittanceId: rem1Id,
        verifierUserId: opsUserId,
        verifiedAmount: 1000.0,
      }),
      (e: any) => e instanceof CodAccountabilityError && e.errorCode === 'RECEIVER_VERIFICATION_CONFLICT'
    );

    // Independent Finance Admin verifies exact ₹1000.00 -> LIABILITY_CLEARED; remaining ₹1550 stays under ₹2500 ceiling -> unblocked!
    const ver1Res = await apiCall(`/api/v1/settlements/cod/remittances/${rem1Id}/verify`, {
      method: 'POST',
      token: finToken,
      headers: { 'Idempotency-Key': 'idem_verify_fifo_1000' },
      body: { verifiedAmount: 1000.0 },
    });
    assert.strictEqual(ver1Res.status, 200);
    assert.strictEqual(ver1Res.data.remittance.status, 'LIABILITY_CLEARED');
    assert.strictEqual(ver1Res.data.remittance.clearedAmount, 1000.0);
    assert.strictEqual(ver1Res.data.remittance.remainingCash, 1550.0);
    assert.strictEqual(ver1Res.data.remittance.unblocked, true);

    const reconciledTripCheck = (await pool.query(`SELECT cod_reconciled FROM delivery_trips WHERE id = $1`, [codA1.tripId])).rows[0];
    assert.strictEqual(reconciledTripCheck.cod_reconciled, true);

    console.log('✓ Group C Passed: 3-stage handover, allocations, rejection release & two-person integrity verified');
    passedGroups++;

    // =========================================================================
    // GROUP D: Shortages, Excesses, Disputes & Reversal
    // =========================================================================
    console.log('\n[Group D] Testing Shortage/Excess Disputes, Resolutions & Verified Remittance Reversal...');
    // Remit remaining ₹1550, receive ₹1550, but finance count verifies only ₹1200 -> ₹350 SHORTAGE
    const remShortSub = await apiCall('/api/v1/settlements/cod/remittances', {
      method: 'POST',
      token: rider1Token,
      body: { riderId: rider1Id, amount: 1550.0, method: 'CASH_HUB' },
    });
    assert.strictEqual(remShortSub.status, 201);
    const remShortId = remShortSub.data.remittance.remittanceId as string;

    await apiCall(`/api/v1/settlements/cod/remittances/${remShortId}/receive`, {
      method: 'POST',
      token: opsToken,
      body: { receivedAmount: 1550.0 },
    });
    const shortVer = await apiCall(`/api/v1/settlements/cod/remittances/${remShortId}/verify`, {
      method: 'POST',
      token: finToken,
      body: { verifiedAmount: 1200.0, discrepancyNotes: 'Counted ₹1200, missing ₹350 notes' },
    });
    assert.strictEqual(shortVer.status, 200);
    assert.strictEqual(shortVer.data.remittance.status, 'SHORTAGE');
    assert.strictEqual(shortVer.data.remittance.clearedAmount, 1200.0);
    assert.strictEqual(shortVer.data.remittance.shortageAmount, 350.0);
    assert.strictEqual(shortVer.data.remittance.remainingCash, 350.0, 'Shortage ₹350 must remain rider liability');
    assert.ok(shortVer.data.remittance.disputeId, 'Shortage must open durable cod_cash_disputes row');

    // Rider payout MUST be held while open COD shortage dispute exists
    await assert.rejects(
      () => riderPayoutService.executeRiderPayout({ riderId: rider1Id, amount: 100, method: 'UPI' }),
      /PAYOUT_HELD/
    );

    // Resolve shortage via RECOVERED_FROM_WALLET (wallet was 1000 -> becomes 650, float becomes 0, dispute closes)
    const resolveShort = await apiCall(`/api/v1/settlements/cod/disputes/${shortVer.data.remittance.disputeId}/resolve`, {
      method: 'POST',
      token: finToken,
      body: { resolutionType: 'RECOVERED_FROM_WALLET', notes: 'Approved deduction from rider earnings wallet' },
    });
    assert.strictEqual(resolveShort.status, 200);
    assert.strictEqual(resolveShort.data.resolution.status, 'RESOLVED');
    assert.strictEqual(resolveShort.data.resolution.remainingCash, 0);

    // Test ESCALATED_TO_RECEIVABLE -> RECEIVABLE_COLLECTED & WRITTEN_OFF on Rider 2
    const r2Cod1 = await seedOrderWithTrip({ paymentMethod: 'Pay on Delivery', riderId: rider2Id, totalAmount: 600.0 });
    await deliveryCompletionService.completeDeliveryWithOtp({
      taskId: r2Cod1.tripId,
      otp: r2Cod1.otp,
      actor: { riderId: rider2Id, isDispatchAdmin: false, actorUserId: rider2UserId },
    });

    const r2Sub = await codCashAccountabilityService.submitRemittance({
      riderId: rider2Id,
      amount: 600.0,
      submittedByUserId: rider2UserId,
    });
    await codCashAccountabilityService.acknowledgeReceipt({ remittanceId: r2Sub.remittanceId, receiverUserId: opsUserId, receivedAmount: 600.0 });
    const r2Excess = await codCashAccountabilityService.verifyRemittance({
      remittanceId: r2Sub.remittanceId,
      verifierUserId: finUserId,
      verifiedAmount: 750.0, // ₹150 EXCESS
    });
    assert.strictEqual(r2Excess.status, 'EXCESS');
    assert.strictEqual(r2Excess.clearedAmount, 600.0);
    assert.strictEqual(r2Excess.excessAmount, 150.0);
    assert.strictEqual(r2Excess.remainingCash, 0);

    // Return excess cash from Suspense 2080
    const retExcess = await codCashAccountabilityService.resolveDispute({
      disputeId: r2Excess.disputeId!,
      resolverUserId: adminUserId,
      resolutionType: 'EXCESS_RETURNED',
      notes: 'Returned excess ₹150 bank transfer to rider',
    });
    assert.strictEqual(retExcess.status, 'RESOLVED');

    // Manual dispute on missing collection & write-off + reversal test
    const r2Cod2 = await seedOrderWithTrip({ paymentMethod: 'Pay on Delivery', riderId: rider2Id, totalAmount: 200.0 });
    await deliveryCompletionService.completeDeliveryWithOtp({
      taskId: r2Cod2.tripId,
      otp: r2Cod2.otp,
      actor: { riderId: rider2Id, isDispatchAdmin: false, actorUserId: rider2UserId },
    });
    const manDisp = await apiCall('/api/v1/settlements/cod/disputes', {
      method: 'POST',
      token: opsToken,
      body: {
        riderId: rider2Id,
        orderId: r2Cod2.orderId,
        disputeType: 'CUSTOMER_DISPUTE',
        disputedAmount: 200.0,
        reason: 'Counterfeit note returned by hub audit',
      },
    });
    assert.strictEqual(manDisp.status, 201);
    const woRes = await apiCall(`/api/v1/settlements/cod/disputes/${manDisp.data.dispute.disputeId}/resolve`, {
      method: 'POST',
      token: adminToken,
      body: { resolutionType: 'WRITTEN_OFF', notes: 'Approved finance write-off after police FIR' },
    });
    assert.strictEqual(woRes.status, 200);
    assert.strictEqual(woRes.data.resolution.remainingCash, 0);

    // Reverse a previously verified remittance (rem1Id ₹1000) -> restores liability ₹1000 without deleting GL rows
    const revRes = await apiCall(`/api/v1/settlements/cod/remittances/${rem1Id}/reverse`, {
      method: 'POST',
      token: adminToken,
      body: { reason: 'Deposited cheque bounced upon clearing house return' },
    });
    assert.strictEqual(revRes.status, 200);
    assert.strictEqual(revRes.data.reversal.restoredLiability, 1000.0);
    assert.strictEqual(revRes.data.reversal.remainingCash, 1000.0);
    const restoredTrip = (await pool.query(`SELECT cod_reconciled FROM delivery_trips WHERE id = $1`, [codA1.tripId])).rows[0];
    assert.strictEqual(restoredTrip.cod_reconciled, false);

    // Global Trial Balance MUST stay 100% balanced across every GL mutation!
    const tb = await ledgerService.getTrialBalance();
    assert.strictEqual(tb.isBalanced, true, `Trial balance must remain balanced! Diff: ${tb.difference}`);
    assert.strictEqual(tb.difference, 0);

    console.log('✓ Group D Passed: Shortage, excess (2080), wallet/write-off resolutions, remittance reversal & 0.00 trial balance verified');
    passedGroups++;

    // =========================================================================
    // GROUP E: COD Reconciliation & Safe vs Unsafe Repair
    // =========================================================================
    console.log('\n[Group E] Testing Internal COD Reconciliation & Safe vs Manual-Review Classification...');
    // Clear rider1 reversed state into clean liability, and seed:
    // 1. Delivered COD order missing cod_collections -> UNRECONCILED_COD_COLLECTION
    const brokenCod = await seedOrderWithTrip({
      paymentMethod: 'Pay on Delivery',
      status: 'delivered',
      tripStatus: 'DELIVERED',
      riderId: rider2Id,
      totalAmount: 190.0,
    });
    // 2. Cleared collection whose trip flag was drifted FALSE -> AUTO_REPAIRED when verified remittance exists
    await pool.query(`UPDATE delivery_trips SET cod_reconciled = FALSE WHERE order_id = $1`, [r2Cod1.orderId]);

    const reconReport = await paymentReconciliationService.runReconciliation({
      runType: 'TEST',
      triggeredBy: finUserId,
      autoRepair: true,
    });
    assert.ok(
      reconReport.discrepancies.some((d) => d.category === 'UNRECONCILED_COD_COLLECTION' && d.orderId === brokenCod.orderId && d.status === 'REQUIRES_REVIEW'),
      'Delivered COD order missing cod_collections must require manual review'
    );
    assert.ok(
      reconReport.discrepancies.some((d) => d.category === 'COD_TRIP_RECONCILED_FLAG_DRIFT' && d.orderId === r2Cod1.orderId && d.status === 'AUTO_REPAIRED'),
      'Cleared COD collection with drifted cod_reconciled=FALSE must safely auto-repair'
    );

    const fixedTripRow = (await pool.query(`SELECT cod_reconciled FROM delivery_trips WHERE order_id = $1`, [r2Cod1.orderId])).rows[0];
    assert.strictEqual(fixedTripRow.cod_reconciled, true);

    console.log('✓ Group E Passed: Missing COD collection detection & safe deterministic trip flag auto-repair verified');
    passedGroups++;

    // =========================================================================
    // GROUP F: Recovery Worker & Redis Outage Fail-Closed Check
    // =========================================================================
    console.log('\n[Group F] Testing Stale Remittance Escalation & Redis Outage Fail-Closed Handling...');
    const staleSub = await codCashAccountabilityService.submitRemittance({
      riderId: rider1Id,
      amount: 100.0,
      submittedByUserId: rider1UserId,
    });
    await pool.query(
      `UPDATE cod_remittances SET submitted_at = NOW() - INTERVAL '6 hours', created_at = NOW() - INTERVAL '6 hours' WHERE id = $1`,
      [staleSub.remittanceId]
    );
    const workerOut = await financialRecoveryWorker.monitorCodRemittancesAndOverrides();
    assert.ok(workerOut.staleRemittancesEscalated >= 1);
    const staleRowAfter = (await pool.query(`SELECT status FROM cod_remittances WHERE id = $1`, [staleSub.remittanceId])).rows[0];
    assert.strictEqual(staleRowAfter.status, 'SUBMITTED', 'Recovery worker must escalate stale remittance, NEVER auto-verify it');

    // Simulate Redis error in production mode on rate-limited COD remittance route -> must fail closed 503
    const prevNodeEnv = env.NODE_ENV;
    const prevProcessEnv = process.env.NODE_ENV;
    const prevRedis = getRedisClient();
    process.env.NODE_ENV = 'production';
    env.NODE_ENV = 'production';
    setRedisClient({
      eval: async () => { throw new Error('ECONNREFUSED'); },
      get: async () => { throw new Error('ECONNREFUSED'); },
      set: async () => { throw new Error('ECONNREFUSED'); },
    } as any);
    try {
      const outageRes = await apiCall('/api/v1/settlements/cod/remit', {
        method: 'POST',
        token: rider1Token,
        body: { riderId: rider1Id, amount: 50.0 },
      });
      assert.strictEqual(outageRes.status, 503);
    } finally {
      setRedisClient(prevRedis);
      process.env.NODE_ENV = prevProcessEnv;
      env.NODE_ENV = prevNodeEnv;
    }

    console.log('✓ Group F Passed: Stale remittance escalation & Redis outage fail-closed behavior verified');
    passedGroups++;

    // =========================================================================
    // GROUP G: Security, RBAC, IDOR, Trigger Immutability & Observability
    // =========================================================================
    console.log('\n[Group G] Testing Unauthenticated/RBAC/IDOR Controls, Append-Only Triggers & Observability...');
    // 401 unauthenticated
    const unauthSummary = await apiCall(`/api/v1/settlements/rider/${rider1Id}/cod-summary`);
    assert.strictEqual(unauthSummary.status, 401);

    // 403 cross-rider IDOR on summary, remit, submit, cancel
    const crossSummary = await apiCall(`/api/v1/settlements/rider/${rider1Id}/cod-summary`, { token: rider2Token });
    assert.strictEqual(crossSummary.status, 403);
    const crossCancel = await apiCall(`/api/v1/settlements/cod/remittances/${staleSub.remittanceId}/cancel`, {
      method: 'POST',
      token: rider2Token,
      body: { reason: 'Malicious cancel attempt' },
    });
    assert.strictEqual(crossCancel.status, 403);

    // 403 RBAC: Rider cannot call /receive, /verify, /disputes/resolve, /ceiling-override, /cod/observability
    const riderRecv = await apiCall(`/api/v1/settlements/cod/remittances/${staleSub.remittanceId}/receive`, {
      method: 'POST',
      token: rider2Token,
      body: { receivedAmount: 100 },
    });
    assert.strictEqual(riderRecv.status, 403);
    const opsVerify = await apiCall(`/api/v1/settlements/cod/remittances/${staleSub.remittanceId}/verify`, {
      method: 'POST',
      token: opsToken,
      body: { verifiedAmount: 100 },
    });
    assert.strictEqual(opsVerify.status, 403, 'OPERATIONS must not have FINANCE_ADMIN verification privilege');
    const riderObs = await apiCall('/api/v1/settlements/cod/observability', { token: rider1Token });
    assert.strictEqual(riderObs.status, 403);

    // Observability endpoints return live counters + PG state counts
    const codObsRes = await apiCall('/api/v1/settlements/cod/observability', { token: finToken });
    assert.strictEqual(codObsRes.status, 200);
    assert.ok(codObsRes.data.metrics.totalCodCollected > 0);
    assert.ok(codObsRes.data.metrics.unverifiedRemittancesCount >= 1);

    const payObsRes = await apiCall('/api/v1/admin/payments/observability', { token: finToken });
    assert.strictEqual(payObsRes.status, 200);
    assert.ok(payObsRes.data.observability.counters.codCollectionsRecorded > 0);
    assert.ok(payObsRes.data.observability.counters.codRemittancesVerified > 0);
    assert.ok(payObsRes.data.observability.databaseStateCounts.codPendingRemittances >= 1);

    // Append-only trigger protection against UPDATE / DELETE on general_ledger_entries (real PG executes PL/pgSQL; pg-mem stubs plpgsql)
    if (!(pool as any).__pgMemDb) {
      await assert.rejects(
        () => pool.query(`UPDATE general_ledger_entries SET amount = 0.01 WHERE account_code = '1030'`),
        /append-only|immutable|cannot be modified/i
      );
      await assert.rejects(
        () => pool.query(`DELETE FROM general_ledger_entries WHERE account_code = '1030'`),
        /append-only|immutable|cannot be deleted/i
      );
    } else {
      const coaCheck = await pool.query(
        `SELECT account_code FROM general_ledger_accounts WHERE account_code IN ('1030', '1050', '2080', '5030')`
      );
      assert.strictEqual(coaCheck.rows.length, 4, 'COA must include 1030, 1050, 2080, 5030');
    }

    console.log('✓ Group G Passed: Auth/RBAC/IDOR, COA accounts, and observability verified');
    passedGroups++;

    // =========================================================================
    // GROUP H: Sprint 15.9.1 Independent Audit Scenarios (Examples A-E & Repaired Edge Cases)
    // =========================================================================
    console.log('\n[Group H] Testing Sprint 15.9.1 Examples A-E, Escalated Receivable Lifecycle, Excess Allocation & Reconciliation Idempotency...');
    // Isolated Rider H with clean ₹0 float and high ceiling for exact ₹5,000 / ₹8,000 math checks
    const riderHUserId = crypto.randomUUID();
    const riderHPhone = `+91-98123${Math.floor(10000 + Math.random() * 89999)}`;
    await pool.query(
      `INSERT INTO users (id, phone, name, is_phone_verified) VALUES ($1, $2, 'Rider H 1591', TRUE)`,
      [riderHUserId, riderHPhone]
    );
    const riderHId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO riders (id, user_id, rider_code, name, phone, status, vehicle_type, payload_capacity_kg, floating_cash_balance, floating_cash_limit, wallet_balance)
       VALUES ($1, $2, $3, 'Rider H 1591', $4, 'AVAILABLE', 'ev_scooter', 25, 0.00, 15000.00, 500.00)`,
      [riderHId, riderHUserId, `RDR-1591-${Date.now()}`, riderHPhone]
    );

    // Example A: Rider liability ₹5,000, Submitted ₹5,000, Received ₹5,000, Verified ₹4,800 -> ₹200 remains unresolved & traceable
    const exAOrd = await seedOrderWithTrip({ paymentMethod: 'Pay on Delivery', riderId: riderHId, totalAmount: 5000.0 });
    await deliveryCompletionService.completeDeliveryWithOtp({
      taskId: exAOrd.tripId,
      otp: exAOrd.otp,
      actor: { riderId: riderHId, isDispatchAdmin: false, actorUserId: riderHUserId },
    });
    const exASub = await codCashAccountabilityService.submitRemittance({
      riderId: riderHId,
      amount: 5000.0,
      submittedByUserId: riderHUserId,
    });
    await codCashAccountabilityService.acknowledgeReceipt({
      remittanceId: exASub.remittanceId,
      receiverUserId: opsUserId,
      receivedAmount: 5000.0,
    });
    const exAVer = await codCashAccountabilityService.verifyRemittance({
      remittanceId: exASub.remittanceId,
      verifierUserId: finUserId,
      verifiedAmount: 4800.0,
      idempotencyKey: 'idem_verify_ex_a',
    });
    assert.strictEqual(exAVer.status, 'SHORTAGE');
    assert.strictEqual(exAVer.clearedAmount, 4800.0);
    assert.strictEqual(exAVer.shortageAmount, 200.0);
    assert.strictEqual(exAVer.remainingCash, 200.0);
    assert.ok(exAVer.disputeId);

    // Example D & E on Example A: concurrent/duplicate different verifier blocked; retry by same verifier after lost response is idempotent
    await assert.rejects(
      () => codCashAccountabilityService.verifyRemittance({
        remittanceId: exASub.remittanceId,
        verifierUserId: adminUserId,
        verifiedAmount: 4800.0,
      }),
      (e: any) => e instanceof CodAccountabilityError && e.errorCode === 'REMITTANCE_ALREADY_VERIFIED'
    );
    const exARetry = await codCashAccountabilityService.verifyRemittance({
      remittanceId: exASub.remittanceId,
      verifierUserId: finUserId,
      verifiedAmount: 4800.0,
      idempotencyKey: 'idem_verify_ex_a',
    });
    assert.strictEqual(exARetry.idempotentReplay, true);
    assert.strictEqual(exARetry.journalBatchId, exAVer.journalBatchId);

    // RECEIVABLE_COLLECTED MUST be blocked before ESCALATED_TO_RECEIVABLE
    await assert.rejects(
      () => codCashAccountabilityService.resolveDispute({
        disputeId: exAVer.disputeId!,
        resolverUserId: finUserId,
        resolutionType: 'RECEIVABLE_COLLECTED',
        notes: 'Premature receivable collection without escalation',
      }),
      (e: any) => e instanceof CodAccountabilityError && e.errorCode === 'RECEIVABLE_NOT_ESCALATED'
    );

    // Escalate ₹200 shortage to 1050 Receivable -> then collect via RECEIVABLE_COLLECTED
    const exAEsc = await codCashAccountabilityService.resolveDispute({
      disputeId: exAVer.disputeId!,
      resolverUserId: finUserId,
      resolutionType: 'ESCALATED_TO_RECEIVABLE',
      notes: 'Escalate ₹200 shortage to payroll receivable',
      idempotencyKey: 'idem_esc_a',
    });
    assert.strictEqual(exAEsc.status, 'ESCALATED');
    assert.strictEqual(exAEsc.remainingCash, 0);

    // Retrying escalation with same key is idempotent
    const exAEscRetry = await codCashAccountabilityService.resolveDispute({
      disputeId: exAVer.disputeId!,
      resolverUserId: finUserId,
      resolutionType: 'ESCALATED_TO_RECEIVABLE',
      notes: 'Escalate ₹200 shortage to payroll receivable',
      idempotencyKey: 'idem_esc_a',
    });
    assert.strictEqual(exAEscRetry.idempotentReplay, true);

    const exACollect = await codCashAccountabilityService.resolveDispute({
      disputeId: exAVer.disputeId!,
      resolverUserId: finUserId,
      resolutionType: 'RECEIVABLE_COLLECTED',
      notes: 'Collected ₹200 receivable from rider',
    });
    assert.strictEqual(exACollect.status, 'RESOLVED');

    // Also verify ESCALATED -> WRITTEN_OFF settles 1050 (fromReceivable=true) even when rider float is 0!
    const escWoOrd = await seedOrderWithTrip({ paymentMethod: 'Pay on Delivery', riderId: riderHId, totalAmount: 300.0 });
    await deliveryCompletionService.completeDeliveryWithOtp({
      taskId: escWoOrd.tripId,
      otp: escWoOrd.otp,
      actor: { riderId: riderHId, isDispatchAdmin: false, actorUserId: riderHUserId },
    });
    const escWoSub = await codCashAccountabilityService.submitRemittance({
      riderId: riderHId,
      amount: 300.0,
      submittedByUserId: riderHUserId,
    });
    await codCashAccountabilityService.acknowledgeReceipt({
      remittanceId: escWoSub.remittanceId,
      receiverUserId: opsUserId,
      receivedAmount: 300.0,
    });
    const escWoVer = await codCashAccountabilityService.verifyRemittance({
      remittanceId: escWoSub.remittanceId,
      verifierUserId: finUserId,
      verifiedAmount: 200.0,
    });
    assert.strictEqual(escWoVer.shortageAmount, 100.0);
    await codCashAccountabilityService.resolveDispute({
      disputeId: escWoVer.disputeId!,
      resolverUserId: finUserId,
      resolutionType: 'ESCALATED_TO_RECEIVABLE',
      notes: 'Escalate ₹100 shortage to 1050 receivable',
    });
    const escWoDone = await codCashAccountabilityService.resolveDispute({
      disputeId: escWoVer.disputeId!,
      resolverUserId: adminUserId,
      resolutionType: 'WRITTEN_OFF',
      notes: 'Approved finance write-off of unrecoverable 1050 receivable',
    });
    assert.strictEqual(escWoDone.status, 'RESOLVED');
    const rH1050 = (
      await pool.query(
        `SELECT COALESCE(SUM(CASE WHEN entry_side = 'DEBIT' THEN amount ELSE -amount END), 0) AS net1050
         FROM general_ledger_entries WHERE rider_id = $1 AND account_code = '1050'`,
        [riderHId]
      )
    ).rows[0];
    assert.strictEqual(Number(roundCurrency(rH1050.net1050)), 0, 'Account 1050 receivable must net to 0 after collection and write-off');

    // Example B: Rider liability ₹5,000, Submitted ₹5,000, Received ₹5,100 -> ₹100 excess separately in 2080
    const exBOrd = await seedOrderWithTrip({ paymentMethod: 'Pay on Delivery', riderId: riderHId, totalAmount: 5000.0 });
    await deliveryCompletionService.completeDeliveryWithOtp({
      taskId: exBOrd.tripId,
      otp: exBOrd.otp,
      actor: { riderId: riderHId, isDispatchAdmin: false, actorUserId: riderHUserId },
    });
    const exBSub = await codCashAccountabilityService.submitRemittance({
      riderId: riderHId,
      amount: 5000.0,
      submittedByUserId: riderHUserId,
    });
    await codCashAccountabilityService.acknowledgeReceipt({
      remittanceId: exBSub.remittanceId,
      receiverUserId: opsUserId,
      receivedAmount: 5100.0,
    });
    const exBVer = await codCashAccountabilityService.verifyRemittance({
      remittanceId: exBSub.remittanceId,
      verifierUserId: finUserId,
      verifiedAmount: 5100.0,
    });
    assert.strictEqual(exBVer.status, 'EXCESS');
    assert.strictEqual(exBVer.clearedAmount, 5000.0);
    assert.strictEqual(exBVer.excessAmount, 100.0);
    assert.strictEqual(exBVer.remainingCash, 0);

    // Attempting reverse after EXCESS resolution fails, and EXCESS_ALLOCATED_TO_COLLECTION without open float fails cleanly
    await assert.rejects(
      () => codCashAccountabilityService.resolveDispute({
        disputeId: exBVer.disputeId!,
        resolverUserId: adminUserId,
        resolutionType: 'EXCESS_ALLOCATED_TO_COLLECTION',
        notes: 'No open collections yet',
      }),
      (e: any) => e instanceof CodAccountabilityError && e.errorCode === 'INSUFFICIENT_FLOAT_FOR_EXCESS_ALLOCATION'
    );

    // Seed a ₹250 open COD order, then allocate ₹100 excess -> float, GL 1030, and collection cleared_amount stay 100% synced!
    const exBOpenOrd = await seedOrderWithTrip({ paymentMethod: 'Pay on Delivery', riderId: riderHId, totalAmount: 250.0 });
    await deliveryCompletionService.completeDeliveryWithOtp({
      taskId: exBOpenOrd.tripId,
      otp: exBOpenOrd.otp,
      actor: { riderId: riderHId, isDispatchAdmin: false, actorUserId: riderHUserId },
    });
    const allocExcessRes = await codCashAccountabilityService.resolveDispute({
      disputeId: exBVer.disputeId!,
      resolverUserId: adminUserId,
      resolutionType: 'EXCESS_ALLOCATED_TO_COLLECTION',
      notes: 'Apply ₹100 excess toward next COD order liability',
    });
    assert.strictEqual(allocExcessRes.status, 'RESOLVED');
    assert.strictEqual(allocExcessRes.remainingCash, 150.0);

    const exHSummary = await codCashAccountabilityService.getRiderCashSummary(riderHId);
    assert.strictEqual(exHSummary.ledgerDriftAmount, 0, 'EXCESS_ALLOCATED_TO_COLLECTION must maintain zero GL 1030 drift');
    assert.strictEqual(exHSummary.materializedFloatingCashBalance, 150.0);

    // Clear remaining ₹150 cleanly so Example C starts at 0
    const clr150Sub = await codCashAccountabilityService.submitRemittance({
      riderId: riderHId,
      amount: 150.0,
      submittedByUserId: riderHUserId,
    });
    await codCashAccountabilityService.acknowledgeReceipt({
      remittanceId: clr150Sub.remittanceId,
      receiverUserId: opsUserId,
      receivedAmount: 150.0,
    });
    await codCashAccountabilityService.verifyRemittance({
      remittanceId: clr150Sub.remittanceId,
      verifierUserId: finUserId,
      verifiedAmount: 150.0,
    });

    // Attempting reverseVerifiedRemittance on exBSub whose excess dispute is already RESOLVED must fail (409)
    await assert.rejects(
      () => codCashAccountabilityService.reverseVerifiedRemittance({
        remittanceId: exBSub.remittanceId,
        actorUserId: adminUserId,
        reason: 'Attempt reversal after excess already allocated',
      }),
      (e: any) => e instanceof CodAccountabilityError && e.errorCode === 'REMITTANCE_DISPUTE_ALREADY_PROCESSED'
    );

    // Example C: Rider liability ₹8,000, verified partial remittance ₹3,000 -> ₹5,000 outstanding
    const exCOrd = await seedOrderWithTrip({ paymentMethod: 'Pay on Delivery', riderId: riderHId, totalAmount: 8000.0 });
    await deliveryCompletionService.completeDeliveryWithOtp({
      taskId: exCOrd.tripId,
      otp: exCOrd.otp,
      actor: { riderId: riderHId, isDispatchAdmin: false, actorUserId: riderHUserId },
    });
    const exCSub = await codCashAccountabilityService.submitRemittance({
      riderId: riderHId,
      amount: 3000.0,
      submittedByUserId: riderHUserId,
    });
    await codCashAccountabilityService.acknowledgeReceipt({
      remittanceId: exCSub.remittanceId,
      receiverUserId: opsUserId,
      receivedAmount: 3000.0,
    });
    const exCVer = await codCashAccountabilityService.verifyRemittance({
      remittanceId: exCSub.remittanceId,
      verifierUserId: finUserId,
      verifiedAmount: 3000.0,
    });
    assert.strictEqual(exCVer.status, 'LIABILITY_CLEARED');
    assert.strictEqual(exCVer.clearedAmount, 3000.0);
    assert.strictEqual(exCVer.remainingCash, 5000.0);

    const exCSum = await codCashAccountabilityService.getRiderCashSummary(riderHId);
    assert.strictEqual(exCSum.totalRiderCashLiability, 5000.0);
    assert.strictEqual(exCSum.totalOutstandingAmount, 5000.0);
    const exCTrip = (await pool.query(`SELECT cod_reconciled FROM delivery_trips WHERE id = $1`, [exCOrd.tripId])).rows[0];
    assert.strictEqual(exCTrip.cod_reconciled, false, 'Partial remittance must NOT mark trip cod_reconciled=TRUE');

    // Reversal of a SHORTAGE remittance with an OPEN dispute cleanly closes the open dispute & restores disputed_amount
    const revShortOrd = await seedOrderWithTrip({ paymentMethod: 'Pay on Delivery', riderId: riderHId, totalAmount: 400.0 });
    await deliveryCompletionService.completeDeliveryWithOtp({
      taskId: revShortOrd.tripId,
      otp: revShortOrd.otp,
      actor: { riderId: riderHId, isDispatchAdmin: false, actorUserId: riderHUserId },
    });
    const revShortSub = await codCashAccountabilityService.submitRemittance({
      riderId: riderHId,
      amount: 400.0,
      orderIds: [revShortOrd.orderId],
      submittedByUserId: riderHUserId,
    });
    await codCashAccountabilityService.acknowledgeReceipt({
      remittanceId: revShortSub.remittanceId,
      receiverUserId: opsUserId,
      receivedAmount: 400.0,
    });
    const revShortVer = await codCashAccountabilityService.verifyRemittance({
      remittanceId: revShortSub.remittanceId,
      verifierUserId: finUserId,
      verifiedAmount: 250.0,
    });
    assert.strictEqual(revShortVer.status, 'SHORTAGE');
    const revShortDone = await codCashAccountabilityService.reverseVerifiedRemittance({
      remittanceId: revShortSub.remittanceId,
      actorUserId: adminUserId,
      reason: 'Cash deposit batch voided before settlement cut-off',
    });
    assert.strictEqual(revShortDone.restoredLiability, 250.0);
    const closedDisp = (await pool.query(`SELECT status, resolution_type FROM cod_cash_disputes WHERE id = $1`, [revShortVer.disputeId])).rows[0];
    assert.strictEqual(closedDisp.status, 'REJECTED');
    assert.strictEqual(closedDisp.resolution_type, 'REVERSED');
    const rHDisputeCnt = Number((await pool.query(`SELECT active_cod_dispute_count FROM riders WHERE id = $1`, [riderHId])).rows[0].active_cod_dispute_count);
    assert.strictEqual(rHDisputeCnt, 0);

    // Reconciliation repeatability/idempotency + clean Rider H ledger check
    const rHRecon1 = await paymentReconciliationService.runReconciliation({ runType: 'TEST', triggeredBy: finUserId, autoRepair: false });
    const rHRecon2 = await paymentReconciliationService.runReconciliation({ runType: 'TEST', triggeredBy: finUserId, autoRepair: false });
    assert.ok(!rHRecon1.discrepancies.some((d) => d.riderId === riderHId && d.category === 'RIDER_CASH_LIABILITY_DRIFT'), 'Rider H must have zero GL 1030 drift');
    const dupKeyRow = (
      await pool.query(
        `SELECT occurrence_count FROM reconciliation_discrepancies WHERE discrepancy_key = $1`,
        [`UNRECONCILED_COD_COLLECTION:${brokenCod.orderId}`]
      )
    ).rows[0];
    assert.ok(Number(dupKeyRow.occurrence_count) >= 3, 'Repeated reconciliation runs must upsert occurrence_count idempotently');
    assert.strictEqual(rHRecon1.discrepanciesFound, rHRecon2.discrepanciesFound);

    // Persistent audit_logs verification for COD lifecycle actions
    const auditActionsRes = await pool.query(
      `SELECT action FROM audit_logs WHERE action IN (
         'COD_REMITTANCE_SUBMITTED',
         'COD_REMITTANCE_RECEIVED',
         'COD_REMITTANCE_VERIFIED_WITH_SHORTAGE',
         'COD_REMITTANCE_VERIFIED_WITH_EXCESS',
         'COD_REMITTANCE_VERIFIED_AND_CLEARED',
         'COD_DISPUTE_RESOLVED',
         'COD_REMITTANCE_REVERSED'
       )`
    );
    const seenActions = new Set(auditActionsRes.rows.map((r: any) => String(r.action)));
    for (const reqAction of [
      'COD_REMITTANCE_SUBMITTED',
      'COD_REMITTANCE_RECEIVED',
      'COD_REMITTANCE_VERIFIED_WITH_SHORTAGE',
      'COD_REMITTANCE_VERIFIED_WITH_EXCESS',
      'COD_REMITTANCE_VERIFIED_AND_CLEARED',
      'COD_DISPUTE_RESOLVED',
      'COD_REMITTANCE_REVERSED',
    ]) {
      assert.ok(seenActions.has(reqAction), `Expected persistent audit_logs record for ${reqAction}`);
    }

    // Synthetic anomaly probe verifying all 4 newly added COD reconciliation detectors trigger REQUIRES_REVIEW
    const anomalyOrd = await seedOrderWithTrip({ paymentMethod: 'Pay on Delivery', riderId: riderHId, totalAmount: 350.0 });
    await deliveryCompletionService.completeDeliveryWithOtp({
      taskId: anomalyOrd.tripId,
      otp: anomalyOrd.otp,
      actor: { riderId: riderHId, isDispatchAdmin: false, actorUserId: riderHUserId },
    });
    const anomalyCol = (await pool.query(`SELECT id FROM cod_collections WHERE order_id = $1`, [anomalyOrd.orderId])).rows[0];
    // 1) COD_PREMATURE_LIABILITY_CLEARANCE + 2) COD_ALLOCATION_MISMATCH
    await pool.query(`UPDATE delivery_trips SET cod_reconciled = TRUE WHERE id = $1`, [anomalyOrd.tripId]);
    await pool.query(`UPDATE cod_collections SET allocated_amount = 120.00 WHERE id = $1`, [anomalyCol.id]);
    // 3) COD_PREMATURE_REMITTANCE_CLEARANCE
    const premRemId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO cod_remittances (id, remittance_reference, rider_id, submitted_by, status, submitted_amount, cleared_amount)
       VALUES ($1, $2, $3, $4, 'SUBMITTED', 100.00, 100.00)`,
      [premRemId, `REM_ANOM_PREM_${Date.now()}`, riderHId, riderHUserId]
    );
    // 4) COD_INVALID_REVERSAL
    const invRevRemId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO cod_remittances (id, remittance_reference, rider_id, submitted_by, status, submitted_amount, verified_amount, reversal_journal_batch_id)
       VALUES ($1, $2, $3, $4, 'REVERSED', 100.00, 100.00, NULL)`,
      [invRevRemId, `REM_ANOM_INVREV_${Date.now()}`, riderHId, riderHUserId]
    );

    const anomalyRecon = await paymentReconciliationService.runReconciliation({
      runType: 'TEST',
      triggeredBy: finUserId,
      autoRepair: true,
    });
    assert.ok(
      anomalyRecon.discrepancies.some((d) => d.category === 'COD_PREMATURE_LIABILITY_CLEARANCE' && d.orderId === anomalyOrd.orderId && d.status === 'REQUIRES_REVIEW'),
      'Must detect COD_PREMATURE_LIABILITY_CLEARANCE without auto-clearing'
    );
    assert.ok(
      anomalyRecon.discrepancies.some((d) => d.category === 'COD_ALLOCATION_MISMATCH' && d.collectionId === anomalyCol.id && d.status === 'REQUIRES_REVIEW'),
      'Must detect COD_ALLOCATION_MISMATCH without auto-clearing'
    );
    assert.ok(
      anomalyRecon.discrepancies.some((d) => d.category === 'COD_PREMATURE_REMITTANCE_CLEARANCE' && d.remittanceId === premRemId && d.status === 'REQUIRES_REVIEW'),
      'Must detect COD_PREMATURE_REMITTANCE_CLEARANCE without auto-clearing'
    );
    assert.ok(
      anomalyRecon.discrepancies.some((d) => d.category === 'COD_INVALID_REVERSAL' && d.remittanceId === invRevRemId && d.status === 'REQUIRES_REVIEW'),
      'Must detect COD_INVALID_REVERSAL without auto-clearing'
    );

    // Simulated PostgreSQL outage (57P01 / ECONNREFUSED) -> HTTP 503 + Retry-After: 3
    const origPoolQuery = pool.query.bind(pool);
    const origPoolConnect = pool.connect.bind(pool);
    (pool as any).query = async () => {
      const e: any = new Error('terminating connection due to administrator command');
      e.code = '57P01';
      throw e;
    };
    (pool as any).connect = async () => {
      const e: any = new Error('connect ECONNREFUSED 127.0.0.1:5432');
      e.code = 'ECONNREFUSED';
      throw e;
    };
    try {
      const dbOutageRes = await apiCall(`/api/v1/settlements/rider/${riderHId}/cod-summary`, { token: finToken });
      assert.strictEqual(dbOutageRes.status, 503, 'PG outage on COD route must return HTTP 503');
      assert.strictEqual(dbOutageRes.data.error, 'DATABASE_UNAVAILABLE');
    } finally {
      (pool as any).query = origPoolQuery;
      (pool as any).connect = origPoolConnect;
    }

    const finalTb = await ledgerService.getTrialBalance();
    assert.strictEqual(finalTb.isBalanced, true);
    assert.strictEqual(finalTb.difference, 0);

    console.log('✓ Group H Passed: Examples A-E, escalated receivable, excess allocation, shortage reversal, audit logs, 4 recon detectors & DB outage 503 verified');
    passedGroups++;

    console.log(`\n✓ Sprint 15.9 COD Cash Accountability Test Suite PASSED (${passedGroups}/8 Groups Verified)!`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  }
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1] && process.argv[1].endsWith('sprint15-9-cod-cash-accountability.test.ts'))
) {
  runSprint15_9CodCashAccountabilityTests().catch((err) => {
    console.error('❌ Sprint 15.9 suite failed:', err);
    process.exit(1);
  });
}
