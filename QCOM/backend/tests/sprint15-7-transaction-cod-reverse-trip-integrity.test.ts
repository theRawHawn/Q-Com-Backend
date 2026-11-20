import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { setPool } from '../src/database/connection.js';
import { runMigrations } from '../src/database/migrator.js';
import { runSeeds } from '../seeds/seedData.js';
import { AuthService } from '../src/modules/auth/authService.js';
import { dispatchService } from '../src/modules/dispatch/dispatchService.js';
import { candidateGenerator } from '../src/modules/dispatch/candidateGenerator.js';
import { riderPayoutService } from '../src/modules/settlements/riderPayoutService.js';
import { settlementAllocationService } from '../src/modules/settlements/settlementAllocationService.js';
import { cancellationService } from '../src/modules/orders/cancellationService.js';
import { returnService } from '../src/modules/orders/returnService.js';
import { refundService } from '../src/modules/payments/refundService.js';
import { ledgerService } from '../src/modules/ledger/ledgerService.js';
import { liveLocationService } from '../src/modules/realtime/liveLocationService.js';
import { createTestDatabase } from './helpers/testDb.js';

export async function runSprint15_7TransactionCodReverseTripIntegrityTests(): Promise<void> {
  console.log('\n================================================================================');
  console.log('  SPRINT 15.7 — TRANSACTION, COD, REVERSE-TRIP & GPS INTEGRITY TEST SUITE');
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

  let passed = 0;

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
      'Customer Alpha',
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
      'Customer Beta',
      pool
    );
    const custToken2 = custAuth2.accessToken;

    const rider1Otp = await authService.requestOtp('+91-9812345678', 'LOGIN', '127.0.0.1', pool);
    const rider1Auth = await authService.verifyOtp(
      '+91-9812345678',
      rider1Otp.debugOtp!,
      'LOGIN',
      '127.0.0.1',
      'DeliveryApp',
      undefined,
      pool
    );
    const rider1Token = rider1Auth.accessToken;
    const rider1Id = (
      await pool.query(`SELECT id FROM riders WHERE phone = '+91-9812345678' LIMIT 1`)
    ).rows[0].id as string;

    const rider2Otp = await authService.requestOtp('+91-9812345679', 'LOGIN', '127.0.0.1', pool);
    const rider2Auth = await authService.verifyOtp(
      '+91-9812345679',
      rider2Otp.debugOtp!,
      'LOGIN',
      '127.0.0.1',
      'DeliveryApp',
      undefined,
      pool
    );
    const rider2Token = rider2Auth.accessToken;
    const rider2Id = (
      await pool.query(`SELECT id FROM riders WHERE phone = '+91-9812345679' LIMIT 1`)
    ).rows[0].id as string;

    const merchRes = await pool.query(
      `SELECT id, latitude, longitude FROM merchants WHERE merchant_code = 'MERCH-BLR-01' LIMIT 1`
    );
    const merchantId = merchRes.rows[0].id as string;
    const storeLat = Number(merchRes.rows[0].latitude);
    const storeLng = Number(merchRes.rows[0].longitude);

    const prodRes = await pool.query(
      `SELECT p.id, p.name, si.selling_price FROM products p
       JOIN store_inventory si ON si.product_id = p.id
       WHERE si.merchant_id = $1 LIMIT 1`,
      [merchantId]
    );
    const productId = prodRes.rows[0].id as string;
    const unitPrice = Number(prodRes.rows[0].selling_price);

    await pool.query(
      `UPDATE store_inventory SET stock_count = 500 WHERE merchant_id = $1 AND product_id = $2`,
      [merchantId, productId]
    );

    async function seedOrderWithTrip(opts: {
      paymentMethod?: 'Pay on Delivery' | 'Instant UPI';
      paymentStatus?: string;
      status?: string;
      tripStatus?: string;
      riderId?: string;
      totalAmount?: number;
      baseFare?: number;
      distanceFare?: number;
      postPaymentGl?: boolean;
    }) {
      const orderId = crypto.randomUUID();
      const tripId = crypto.randomUUID();
      const orderItemId = crypto.randomUUID();
      const subtotal = opts.totalAmount ?? unitPrice;
      const total = +(subtotal).toFixed(2);
      const otp = '518294';
      const paymentMethod = opts.paymentMethod || 'Pay on Delivery';
      const paymentStatus = opts.paymentStatus || (paymentMethod === 'Pay on Delivery' ? 'PENDING' : 'PAID');
      const snapshot = {
        sellerGoodsBreakdown: {
          taxableAmount: +(total / 1.18).toFixed(2),
          totalGst: +(total - total / 1.18).toFixed(2),
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

      await pool.query(
        `INSERT INTO orders (
           id, order_number, user_id, merchant_id, status,
           items_subtotal, delivery_fee, handling_fee, urgency_fee, discount_amount,
           taxable_amount, cgst_amount, sgst_amount, igst_amount, total_amount,
           payment_method, payment_status, delivery_otp, handover_token,
           jobsite_address, pricing_snapshot, placed_at, estimated_delivery_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, 0, 0, 0, 0, $7, 0, 0, 0, $8, $9, $10, $11, $12, $13, $14, NOW(), NOW() + INTERVAL '30 minutes')`,
        [
          orderId,
          `ORD-157-${Date.now().toString().slice(-4)}-${crypto.randomBytes(2).toString('hex')}`,
          custId1,
          merchantId,
          opts.status || 'packed',
          total,
          +(total / 1.18).toFixed(2),
          total,
          paymentMethod,
          paymentStatus,
          otp,
          `HND-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
          JSON.stringify({ address: 'Test Delivery Site', latitude: storeLat + 0.02, longitude: storeLng + 0.02 }),
          JSON.stringify(snapshot),
        ]
      );

      await pool.query(
        `INSERT INTO order_items (
           id, order_id, product_id, product_name, quantity, unit_price, hsn_code, gst_rate_percent, taxable_amount, cgst_amount, sgst_amount, total_price
         )
         VALUES ($1, $2, $3, $4, 1, $5, '6810', 18.00, $6, 0, 0, $5)`,
        [orderItemId, orderId, productId, prodRes.rows[0].name, total, +(total / 1.18).toFixed(2)]
      );

      if (opts.postPaymentGl) {
        await ledgerService.recordOrderPayment({
          orderId,
          merchantId,
          grossAmount: total,
          taxableAmount: +(total / 1.18).toFixed(2),
          cgstAmount: 0,
          sgstAmount: 0,
          deliveryFee: 0,
          handlingFee: 0,
        });
      }

      await pool.query(
        `INSERT INTO delivery_trips (
           id, order_id, trip_type, rider_id, status,
           base_fare, distance_fare, surge_fare, total_rider_payout, accepted_at
         )
         VALUES ($1, $2, 'FORWARD', $3, $4, $5, $6, 0, $7, CASE WHEN $3 IS NOT NULL THEN NOW() ELSE NULL END)`,
        [
          tripId,
          orderId,
          opts.riderId ?? null,
          opts.tripStatus || 'BROADCASTING',
          opts.baseFare ?? 45,
          opts.distanceFare ?? 12,
          (opts.baseFare ?? 45) + (opts.distanceFare ?? 12),
        ]
      );

      return { orderId, tripId, orderItemId, otp, total };
    }

    async function assertLedgerBalanced(): Promise<void> {
      const res = await pool.query(`
        SELECT journal_batch_id,
               SUM(CASE WHEN entry_side = 'DEBIT' THEN amount ELSE 0 END) AS debits,
               SUM(CASE WHEN entry_side = 'CREDIT' THEN amount ELSE 0 END) AS credits
        FROM general_ledger_entries
        GROUP BY journal_batch_id
      `);
      for (const row of res.rows) {
        const diff = Math.abs(Number(row.debits) - Number(row.credits));
        assert.ok(diff <= 0.01, `GL batch ${row.journal_batch_id} imbalanced: Dr=${row.debits} Cr=${row.credits}`);
      }
    }

    // =========================================================================
    // TEST 1: Delivery Pickup Lifecycle & Ownership & Unpaid Non-COD Guard
    // =========================================================================
    console.log('\n[1/9] Delivery completion lifecycle, wrong rider, unpaid prepaid & OTP lockout...');
    const t1 = await seedOrderWithTrip({ paymentMethod: 'Instant UPI', paymentStatus: 'PENDING' });

    // Accept without driver claim check -> Rider 1 claims
    const acc1 = await apiCall(`/api/tasks/${t1.tripId}/accept`, { method: 'POST', token: rider1Token });
    assert.strictEqual(acc1.status, 200);

    // Wrong rider blocked (403)
    const wrongRiderVerify = await apiCall(`/api/tasks/${t1.tripId}/verify-otp`, {
      method: 'POST',
      token: rider2Token,
      body: { otp: t1.otp },
    });
    assert.strictEqual(wrongRiderVerify.status, 403, 'Wrong rider must be blocked from verify-otp');

    // Cannot verify OTP directly from ACCEPTED without pickup
    const verifyBeforePickup = await apiCall(`/api/tasks/${t1.tripId}/verify-otp`, {
      method: 'POST',
      token: rider1Token,
      body: { otp: t1.otp },
    });
    assert.strictEqual(verifyBeforePickup.status, 409);
    assert.strictEqual(verifyBeforePickup.data.error, 'PICKUP_NOT_COMPLETED');

    // Arrived pickup -> still cannot complete before pickup-confirm
    const arr1 = await apiCall(`/api/tasks/${t1.tripId}/arrived-pickup`, { method: 'POST', token: rider1Token });
    assert.strictEqual(arr1.status, 200);
    const verifyAfterArriveOnly = await apiCall(`/api/tasks/${t1.tripId}/verify-otp`, {
      method: 'POST',
      token: rider1Token,
      body: { otp: t1.otp },
    });
    assert.strictEqual(verifyAfterArriveOnly.status, 409);
    assert.strictEqual(verifyAfterArriveOnly.data.error, 'PICKUP_NOT_COMPLETED');

    // Pickup confirm succeeds -> order transitions to out_for_delivery
    const pick1 = await apiCall(`/api/tasks/${t1.tripId}/pickup-confirm`, { method: 'POST', token: rider1Token });
    assert.strictEqual(pick1.status, 200);

    // Non-COD unpaid order blocked from completion
    const unpaidComplete = await apiCall(`/api/tasks/${t1.tripId}/verify-otp`, {
      method: 'POST',
      token: rider1Token,
      body: { otp: t1.otp },
    });
    assert.strictEqual(unpaidComplete.status, 409);
    assert.strictEqual(unpaidComplete.data.error, 'ORDER_NOT_PAID');

    // Clean up t1 back to delivered? Cancel it so rider1 is idle
    await pool.query(`UPDATE orders SET payment_status = 'PAID' WHERE id = $1`, [t1.orderId]);
    await ledgerService.recordOrderPayment({
      orderId: t1.orderId,
      merchantId,
      grossAmount: t1.total,
      taxableAmount: +(t1.total / 1.18).toFixed(2),
      cgstAmount: 0,
      sgstAmount: 0,
      deliveryFee: 0,
      handlingFee: 0,
    });

    // Wrong OTP increments otp_failed_attempts and locks out at 5
    for (let i = 1; i <= 5; i++) {
      const bad = await apiCall(`/api/tasks/${t1.tripId}/verify-otp`, {
        method: 'POST',
        token: rider1Token,
        body: { otp: '000000' },
      });
      assert.strictEqual(bad.status, 400);
    }
    const lockedOut = await apiCall(`/api/tasks/${t1.tripId}/verify-otp`, {
      method: 'POST',
      token: rider1Token,
      body: { otp: t1.otp },
    });
    assert.strictEqual(lockedOut.status, 429);
    assert.strictEqual(lockedOut.data.error, 'OTP_ATTEMPTS_EXCEEDED');

    // Finish t1 cleanly via admin unlock for next checks or direct DB cleanup
    await pool.query(`UPDATE delivery_trips SET otp_failed_attempts = 0 WHERE id = $1`, [t1.tripId]);
    const t1Ok = await apiCall(`/api/tasks/${t1.tripId}/verify-otp`, {
      method: 'POST',
      token: rider1Token,
      body: { otp: t1.otp, cashCollected: 99999 }, // Prepaid order -> must ignore cashCollected=99999!
    });
    assert.strictEqual(t1Ok.status, 200);
    assert.strictEqual(t1Ok.data.codCollectedAmount, 0, 'Prepaid order must record codCollectedAmount=0');
    console.log('  ✓ Pickup lifecycle, wrong-rider/unpaid guards, OTP lockout, and prepaid cash tampering passed');
    passed++;

    // =========================================================================
    // TEST 2: Failure Injection Inside Completion TX (Rollback) + Safe Retry
    // =========================================================================
    console.log('\n[2/9] Mid-transaction settlement allocation failure rollback + safe retry...');
    const tFail = await seedOrderWithTrip({
      paymentMethod: 'Pay on Delivery',
      paymentStatus: 'PENDING',
      status: 'packed',
      totalAmount: 420,
    });
    await apiCall(`/api/tasks/${tFail.tripId}/accept`, { method: 'POST', token: rider1Token });
    await apiCall(`/api/tasks/${tFail.tripId}/arrived-pickup`, { method: 'POST', token: rider1Token });
    await apiCall(`/api/tasks/${tFail.tripId}/pickup-confirm`, { method: 'POST', token: rider1Token });

    const riderBeforeFail = (
      await pool.query(`SELECT wallet_balance, floating_cash_balance, status FROM riders WHERE id = $1`, [rider1Id])
    ).rows[0];

    const origAlloc = settlementAllocationService.allocateFulfilledOrder.bind(settlementAllocationService);
    (settlementAllocationService as any).allocateFulfilledOrder = async () => {
      throw new Error('INJECTED_SETTLEMENT_FAILURE');
    };

    let failResp: any;
    try {
      failResp = await apiCall(`/api/tasks/${tFail.tripId}/verify-otp`, {
        method: 'POST',
        token: rider1Token,
        body: { otp: tFail.otp, cashCollected: 10 }, // Tampered low cashCollected!
      });
    } finally {
      (settlementAllocationService as any).allocateFulfilledOrder = origAlloc;
    }
    assert.strictEqual(failResp.status, 500, 'Injected mid-TX failure must fail cleanly without partial commit');

    const orderAfterFail = (await pool.query(`SELECT status, payment_status FROM orders WHERE id = $1`, [tFail.orderId])).rows[0];
    const tripAfterFail = (await pool.query(`SELECT status, cod_collected_amount FROM delivery_trips WHERE id = $1`, [tFail.tripId])).rows[0];
    const riderAfterFail = (
      await pool.query(`SELECT wallet_balance, floating_cash_balance, status FROM riders WHERE id = $1`, [rider1Id])
    ).rows[0];
    const allocCountFail = Number((await pool.query(`SELECT COUNT(*) AS cnt FROM order_settlement_allocations WHERE order_id = $1`, [tFail.orderId])).rows[0].cnt);

    assert.strictEqual(orderAfterFail.status, 'out_for_delivery', 'Order status must roll back on mid-TX error');
    assert.strictEqual(orderAfterFail.payment_status, 'PENDING', 'COD payment_status must roll back');
    assert.strictEqual(tripAfterFail.status, 'PICKED_UP', 'Trip status must roll back');
    assert.strictEqual(Number(riderAfterFail.wallet_balance), Number(riderBeforeFail.wallet_balance), 'Rider wallet must roll back');
    assert.strictEqual(Number(riderAfterFail.floating_cash_balance), Number(riderBeforeFail.floating_cash_balance), 'Floating cash must roll back');
    assert.strictEqual(allocCountFail, 0, 'Zero allocation rows on TX rollback');

    // Negative cashCollected check
    const negCod = await apiCall(`/api/tasks/${tFail.tripId}/verify-otp`, {
      method: 'POST',
      token: rider1Token,
      body: { otp: tFail.otp, cashCollected: -50 },
    });
    assert.strictEqual(negCod.status, 400);
    assert.strictEqual(negCod.data.error, 'INVALID_COD_AMOUNT');

    // Retry cleanly -> authoritative COD (420) must be recorded despite client passing cashCollected=1
    const retryOk = await apiCall(`/api/tasks/${tFail.tripId}/verify-otp`, {
      method: 'POST',
      token: rider1Token,
      body: { otp: tFail.otp, cashCollected: 1 },
    });
    assert.strictEqual(retryOk.status, 200);
    assert.strictEqual(retryOk.data.codCollectedAmount, 420, 'Authoritative DB order total must override tampered cashCollected');

    const allocPostRetry = (
      await pool.query(`SELECT * FROM order_settlement_allocations WHERE order_id = $1`, [tFail.orderId])
    ).rows[0];
    assert.ok(allocPostRetry, 'Allocation must be created atomically on completion');
    assert.strictEqual(Number(allocPostRetry.order_total), 420);
    const orderPostRetry = (await pool.query(`SELECT status, payment_status FROM orders WHERE id = $1`, [tFail.orderId])).rows[0];
    assert.strictEqual(orderPostRetry.status, 'delivered');
    assert.strictEqual(orderPostRetry.payment_status, 'PAID', 'COD order must transition payment_status to PAID');
    const riderPostRetry = (await pool.query(`SELECT floating_cash_balance, status FROM riders WHERE id = $1`, [rider1Id])).rows[0];
    assert.strictEqual(Number(riderPostRetry.floating_cash_balance), Number(riderBeforeFail.floating_cash_balance) + 420);
    assert.strictEqual(riderPostRetry.status, 'IDLE_AT_HUB');
    await assertLedgerBalanced();
    console.log('  ✓ Mid-TX rollback, negative COD clamp, tampered COD rejection & retry passed');
    passed++;

    // =========================================================================
    // TEST 3: Concurrent Completion & Exactly-Once Financial Effects
    // =========================================================================
    console.log('\n[3/9] Concurrent delivery completion race & duplicate financial protection...');
    const tConc = await seedOrderWithTrip({
      paymentMethod: 'Pay on Delivery',
      paymentStatus: 'PENDING',
      status: 'packed',
      totalAmount: 300,
    });
    await apiCall(`/api/tasks/${tConc.tripId}/accept`, { method: 'POST', token: rider1Token });
    await apiCall(`/api/tasks/${tConc.tripId}/arrived-pickup`, { method: 'POST', token: rider1Token });
    await apiCall(`/api/tasks/${tConc.tripId}/pickup-confirm`, { method: 'POST', token: rider1Token });

    const floatBeforeConc = Number(
      (await pool.query(`SELECT floating_cash_balance FROM riders WHERE id = $1`, [rider1Id])).rows[0].floating_cash_balance
    );

    const [rConc1, rConc2] = await Promise.all([
      apiCall(`/api/tasks/${tConc.tripId}/verify-otp`, {
        method: 'POST',
        token: rider1Token,
        body: { otp: tConc.otp },
      }),
      apiCall(`/api/tasks/${tConc.tripId}/verify-otp`, {
        method: 'POST',
        token: rider1Token,
        body: { otp: tConc.otp },
      }),
    ]);
    assert.deepStrictEqual([rConc1.status, rConc2.status].sort((a, b) => a - b), [200, 409]);

    const floatAfterConc = Number(
      (await pool.query(`SELECT floating_cash_balance FROM riders WHERE id = $1`, [rider1Id])).rows[0].floating_cash_balance
    );
    assert.strictEqual(floatAfterConc, floatBeforeConc + 300, 'Floating cash must increment strictly once on concurrent completion');

    const concAllocs = await pool.query(`SELECT COUNT(*) AS cnt FROM order_settlement_allocations WHERE order_id = $1`, [tConc.orderId]);
    const concCodGl = await pool.query(
      `SELECT COUNT(*) AS cnt FROM general_ledger_entries WHERE transaction_reference = $1`,
      [`TX_COD_COLLECT_${tConc.orderId}`]
    );
    assert.strictEqual(Number(concAllocs.rows[0].cnt), 1);
    assert.strictEqual(Number(concCodGl.rows[0].cnt), 2, 'Strictly 1 Dr + 1 Cr COD GL pair');
    await assertLedgerBalanced();
    console.log('  ✓ Concurrent completion produced [200, 409] with single allocation, single COD increment, single GL batch');
    passed++;

    // =========================================================================
    // TEST 4: Dynamic Delivery Economics Fare & Zero Fake 35.00 Statement Fallback
    // =========================================================================
    console.log('\n[4/9] Dynamic delivery economics config & zero hardcoded Rs 35 fallback...');
    const customConfigId = crypto.randomUUID();
    await pool.query(`UPDATE delivery_economics_configs SET is_active = FALSE`);
    await pool.query(
      `INSERT INTO delivery_economics_configs (id, key, rider_base_payout, rider_per_km_rate, max_delivery_subsidy, is_active)
       VALUES ($1, 'sprint15_7_custom', 77.00, 12.50, 45.00, TRUE)`,
      [customConfigId]
    );
    // Ensure rider1 is AVAILABLE with fresh valid GPS near store
    await pool.query(
      `UPDATE riders SET status = 'AVAILABLE', latitude = $2, longitude = $3, location_updated_at = NOW() WHERE id = $1`,
      [rider1Id, storeLat + 0.005, storeLng + 0.005]
    );
    // Temporarily put rider2 offline so dispatch selects rider1 predictably
    await pool.query(`UPDATE riders SET status = 'OFFLINE' WHERE id = $1`, [rider2Id]);

    const dynOrderId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO orders (
         id, order_number, user_id, merchant_id, status,
         items_subtotal, delivery_fee, handling_fee, urgency_fee, discount_amount,
         taxable_amount, cgst_amount, sgst_amount, igst_amount, total_amount,
         payment_method, payment_status, delivery_otp, handover_token,
         jobsite_address, pricing_snapshot, estimated_delivery_at
       )
       VALUES ($1, $2, $3, $4, 'placed', 500, 0, 0, 0, 0, 423.73, 38.14, 38.13, 0, 500, 'Pay on Delivery', 'PENDING', '112233', 'HND-DYN1', $5, $6, NOW() + INTERVAL '30 minutes')`,
      [
        dynOrderId,
        `ORD-DYN-${Date.now()}`,
        custId1,
        merchantId,
        JSON.stringify({ address: '4km Away', latitude: storeLat + 0.04, longitude: storeLng + 0.04 }),
        JSON.stringify({ sellerGoodsBreakdown: { taxableAmount: 423.73, totalGst: 76.27, totalSellerPayable: 500 } }),
      ]
    );

    const assigned = await dispatchService.assignOrder({ orderId: dynOrderId });
    const accepted = await dispatchService.acceptOffer(assigned.offer.id, assigned.selectedRider.riderId);
    const dynTrip = (await pool.query(`SELECT * FROM delivery_trips WHERE id = $1`, [accepted.tripId])).rows[0];
    assert.strictEqual(Number(dynTrip.base_fare), 77, 'acceptOffer must compute base_fare from active delivery_economics_configs');
    assert.ok(Number(dynTrip.distance_fare) > 0, 'acceptOffer must compute positive distance_fare for multi-km route');
    assert.strictEqual(
      Number(dynTrip.total_rider_payout),
      +(Number(dynTrip.base_fare) + Number(dynTrip.distance_fare)).toFixed(2)
    );

    // Zero base_fare statement check (must NOT substitute 35.00!)
    const zeroFareTripId = crypto.randomUUID();
    const zeroOrder = await seedOrderWithTrip({
      paymentMethod: 'Instant UPI',
      paymentStatus: 'PAID',
      status: 'delivered',
      tripStatus: 'DELIVERED',
      riderId: rider2Id,
      baseFare: 0,
      distanceFare: 0,
      postPaymentGl: true,
    });
    void zeroFareTripId;
    const stmtR2 = await riderPayoutService.getRiderEarningsStatement(rider2Id);
    const zeroTripEntry = stmtR2.trips.find((t) => t.tripId === zeroOrder.tripId);
    assert.ok(zeroTripEntry);
    assert.strictEqual(zeroTripEntry.baseFare, 0, 'Statement must NOT invent fake Rs 35.00 when base_fare is 0');

    // Restore rider2 & standard delivery economics
    await dispatchService.cancelOrderDispatch(dynOrderId);
    await pool.query(`UPDATE delivery_economics_configs SET is_active = FALSE WHERE id = $1`, [customConfigId]);
    await pool.query(`UPDATE delivery_economics_configs SET is_active = TRUE WHERE key = 'default'`);
    await pool.query(`UPDATE riders SET status = 'AVAILABLE', location_updated_at = NOW() WHERE id IN ($1, $2)`, [rider1Id, rider2Id]);
    console.log('  ✓ Dynamic config fare calculation & removal of 35.00 fallback verified');
    passed++;

    // =========================================================================
    // TEST 5: Multi-Trip Rider Status Guard & Active-Delivery Offline Blocking + COD Suspension Preserved
    // =========================================================================
    console.log('\n[5/9] Multi-trip availability, duty-status offline guard & COD suspension priority...');
    const m1 = await seedOrderWithTrip({ paymentMethod: 'Instant UPI', paymentStatus: 'PAID', status: 'packed', postPaymentGl: true });
    const m2 = await seedOrderWithTrip({ paymentMethod: 'Instant UPI', paymentStatus: 'PAID', status: 'packed', postPaymentGl: true });

    await apiCall(`/api/tasks/${m1.tripId}/accept`, { method: 'POST', token: rider1Token });
    await apiCall(`/api/tasks/${m2.tripId}/accept`, { method: 'POST', token: rider1Token });
    await apiCall(`/api/tasks/${m1.tripId}/arrived-pickup`, { method: 'POST', token: rider1Token });
    await apiCall(`/api/tasks/${m1.tripId}/pickup-confirm`, { method: 'POST', token: rider1Token });

    // Rider tries to go offline while m1 & m2 active -> 409 ACTIVE_DELIVERY_CANNOT_GO_OFFLINE
    const offlineBlocked = await apiCall('/api/partner/duty-status', {
      method: 'POST',
      token: rider1Token,
      body: { isOnline: false },
    });
    assert.strictEqual(offlineBlocked.status, 409);
    assert.strictEqual(offlineBlocked.data.error, 'ACTIVE_DELIVERY_CANNOT_GO_OFFLINE');

    // Even if DB riders.status drifted stale to 'AVAILABLE', duty-status check still inspects active trips and blocks!
    await pool.query(`UPDATE riders SET status = 'AVAILABLE' WHERE id = $1`, [rider1Id]);
    const offlineBlockedEvenStale = await apiCall('/api/partner/duty-status', {
      method: 'POST',
      token: rider1Token,
      body: { isOnline: false },
    });
    assert.strictEqual(offlineBlockedEvenStale.status, 409);
    await pool.query(`UPDATE riders SET status = 'ASSIGNED' WHERE id = $1`, [rider1Id]);

    // Seed Redis live location for rider1; verify completing m1 keeps ASSIGNED and preserves or resets only on last trip
    await liveLocationService.ingestRiderLocation({
      riderId: rider1Id,
      latitude: storeLat + 0.001,
      longitude: storeLng + 0.001,
      timestamp: Date.now(),
    });
    const m1Done = await apiCall(`/api/tasks/${m1.tripId}/verify-otp`, {
      method: 'POST',
      token: rider1Token,
      body: { otp: m1.otp },
    });
    assert.strictEqual(m1Done.status, 200);
    assert.strictEqual(m1Done.data.riderStatus, 'ASSIGNED', 'Rider holding active m2 must remain ASSIGNED after m1 completion');

    // Complete m2 -> now rider has 0 active trips -> IDLE_AT_HUB & Redis cleared
    await apiCall(`/api/tasks/${m2.tripId}/arrived-pickup`, { method: 'POST', token: rider1Token });
    await apiCall(`/api/tasks/${m2.tripId}/pickup-confirm`, { method: 'POST', token: rider1Token });
    const m2Done = await apiCall(`/api/tasks/${m2.tripId}/verify-otp`, {
      method: 'POST',
      token: rider1Token,
      body: { otp: m2.otp },
    });
    assert.strictEqual(m2Done.status, 200);
    assert.strictEqual(m2Done.data.riderStatus, 'IDLE_AT_HUB');

    // Stale ASSIGNED status with 0 active trips -> can toggle offline cleanly
    await pool.query(`UPDATE riders SET status = 'ASSIGNED' WHERE id = $1`, [rider1Id]);
    const offlineReconcile = await apiCall('/api/partner/duty-status', {
      method: 'POST',
      token: rider1Token,
      body: { isOnline: false },
    });
    assert.strictEqual(offlineReconcile.status, 200);
    assert.strictEqual(offlineReconcile.data.status, 'OFFLINE');

    // Invalid coordinates on duty-status -> 400
    const badCoords = await apiCall('/api/partner/duty-status', {
      method: 'POST',
      token: rider1Token,
      body: { isOnline: true, latitude: 0, longitude: 0 },
    });
    assert.strictEqual(badCoords.status, 400);

    // Put rider1 online with valid coords & test COD ceiling suspension overrides IDLE_AT_HUB on completion
    await apiCall('/api/partner/duty-status', {
      method: 'POST',
      token: rider1Token,
      body: { isOnline: true, latitude: storeLat + 0.002, longitude: storeLng + 0.002 },
    });
    const bigCod = await seedOrderWithTrip({
      paymentMethod: 'Pay on Delivery',
      paymentStatus: 'PENDING',
      status: 'packed',
      totalAmount: 3000, // Exceeds 2500 floating_cash_limit
    });
    await apiCall(`/api/tasks/${bigCod.tripId}/accept`, { method: 'POST', token: rider1Token });
    await apiCall(`/api/tasks/${bigCod.tripId}/arrived-pickup`, { method: 'POST', token: rider1Token });
    await apiCall(`/api/tasks/${bigCod.tripId}/pickup-confirm`, { method: 'POST', token: rider1Token });
    const suspDone = await apiCall(`/api/tasks/${bigCod.tripId}/verify-otp`, {
      method: 'POST',
      token: rider1Token,
      body: { otp: bigCod.otp },
    });
    assert.strictEqual(suspDone.status, 200);
    assert.strictEqual(suspDone.data.riderStatus, 'SUSPENDED', 'Rider crossing COD limit must remain SUSPENDED (not reset to IDLE_AT_HUB)');

    // Remit full cash -> unblocks rider back to IDLE_AT_HUB
    const curFloat = Number(
      (await pool.query(`SELECT floating_cash_balance FROM riders WHERE id = $1`, [rider1Id])).rows[0].floating_cash_balance
    );
    const remRes = await riderPayoutService.remitCodCash({
      riderId: rider1Id,
      amount: curFloat,
      method: 'UPI',
      reference: `REM_157_${Date.now()}`,
    });
    assert.strictEqual(remRes.unblocked, true);
    assert.strictEqual(remRes.remainingCash, 0);
    console.log('  ✓ Multi-trip guard, offline interlock, COD ceiling suspension preserved & remitted passed');
    passed++;

    // =========================================================================
    // TEST 6: Cancellation Actor Validation & Non-Transactional Refund Execution
    // =========================================================================
    console.log('\n[6/9] Cancellation idempotency actor validation & lock-free external refund...');
    const cOrder = await seedOrderWithTrip({
      paymentMethod: 'Instant UPI',
      paymentStatus: 'PAID',
      status: 'placed',
      postPaymentGl: true,
    });
    const origProvider = refundService.getProvider();
    let gatewayStartedBeforeOrderUpdated = false;
    const delayedProvider = Object.assign(Object.create(Object.getPrototypeOf(origProvider)), origProvider, {
      async createRefund(req: { paymentId: string; amount: number; currency: string }) {
        // By the time external gateway executes, Phase 1 TX MUST already have committed orders.status = 'cancelled'!
        const checkRow = await pool.query(`SELECT status FROM orders WHERE id = $1`, [cOrder.orderId]);
        gatewayStartedBeforeOrderUpdated = checkRow.rows[0]?.status === 'cancelled';
        return {
          providerRefundId: `rfnd_157_${Date.now()}`,
          paymentId: req.paymentId,
          amount: req.amount,
          currency: req.currency || 'INR',
          status: 'PROCESSED' as const,
          timestamp: new Date().toISOString(),
        };
      },
    });
    refundService.setProvider(delayedProvider);

    const idemKey = `cancel_actor_key_${Date.now()}`;
    const cOk = await apiCall(`/api/orders/${cOrder.orderId}/cancel`, {
      method: 'POST',
      token: custToken1,
      headers: { 'Idempotency-Key': idemKey },
      body: { reason: 'Customer changed mind' },
    });
    assert.strictEqual(cOk.status, 200);
    assert.strictEqual(gatewayStartedBeforeOrderUpdated, true, 'Order cancellation TX must commit BEFORE calling external refund provider');
    assert.strictEqual(cOk.data.order.status, 'cancelled');
    assert.strictEqual(cOk.data.order.payment_status, 'REFUNDED');

    // Same key reused by different actor (admin/another customer) -> 403 IDEMPOTENCY_KEY_ACTOR_MISMATCH
    const cOrder2 = await seedOrderWithTrip({ paymentMethod: 'Instant UPI', paymentStatus: 'PAID', status: 'placed', postPaymentGl: true });
    const crossActor = await apiCall(`/api/orders/admin/${cOrder2.orderId}/cancel`, {
      method: 'POST',
      token: adminToken,
      headers: { 'Idempotency-Key': idemKey },
      body: { reason: 'Admin trying customer key' },
    });
    assert.strictEqual(crossActor.status, 403, 'Reusing cancellation idempotency key by another actor must return 403');
    assert.strictEqual(crossActor.data.error, 'IDEMPOTENCY_KEY_ACTOR_MISMATCH');

    const crossCust = await apiCall(`/api/orders/${cOrder2.orderId}/cancel`, {
      method: 'POST',
      token: custToken2,
      headers: { 'Idempotency-Key': idemKey },
      body: { reason: 'Cross customer attempt' },
    });
    assert.strictEqual(crossCust.status, 403);

    refundService.setProvider(origProvider);
    await assertLedgerBalanced();
    console.log('  ✓ Lock-free cancellation gateway boundary & cross-actor idempotency rejection passed');
    passed++;

    // =========================================================================
    // TEST 7: Return QC Non-Transactional Refund & Atomic Failure Rollback
    // =========================================================================
    console.log('\n[7/9] Return QC external refund decoupling & rollback on gateway rejection...');
    const retOrd = await seedOrderWithTrip({
      paymentMethod: 'Instant UPI',
      paymentStatus: 'PAID',
      status: 'delivered',
      tripStatus: 'DELIVERED',
      riderId: rider1Id,
      postPaymentGl: true,
    });
    await settlementAllocationService.allocateFulfilledOrder(retOrd.orderId);
    const reqRet = await returnService.requestReturn({
      orderId: retOrd.orderId,
      userId: custId1,
      items: [{ orderItemId: retOrd.orderItemId, quantity: 1 }],
      reasonCode: 'DEFECTIVE',
    });

    const stockPre = Number(
      (await pool.query(`SELECT stock_count FROM store_inventory WHERE merchant_id = $1 AND product_id = $2`, [merchantId, productId])).rows[0].stock_count
    );

    const failProv = Object.assign(Object.create(Object.getPrototypeOf(origProvider)), origProvider, {
      async createRefund(req: { paymentId: string; amount: number; currency: string }) {
        // Ensure inventory has NOT been prematurely mutated while gateway is running
        const midStock = Number(
          (await pool.query(`SELECT stock_count FROM store_inventory WHERE merchant_id = $1 AND product_id = $2`, [merchantId, productId])).rows[0].stock_count
        );
        assert.strictEqual(midStock, stockPre, 'Stock must not mutate before gateway confirms refund');
        return {
          providerRefundId: 'rfnd_qc_fail',
          paymentId: req.paymentId,
          amount: req.amount,
          currency: 'INR',
          status: 'FAILED' as const,
          timestamp: new Date().toISOString(),
        };
      },
    });
    refundService.setProvider(failProv);

    await assert.rejects(
      () =>
        returnService.qcInspectAndResolve({
          returnId: reqRet.returnRequest.id,
          merchantId,
          itemDecisions: [{ returnItemId: reqRet.returnRequest.items[0].id, qcPassed: true }],
        }),
      /RETURN_REFUND_FAILED/
    );
    const stockPostFail = Number(
      (await pool.query(`SELECT stock_count FROM store_inventory WHERE merchant_id = $1 AND product_id = $2`, [merchantId, productId])).rows[0].stock_count
    );
    assert.strictEqual(stockPostFail, stockPre);

    refundService.setProvider(origProvider);
    const qcOk = await returnService.qcInspectAndResolve({
      returnId: reqRet.returnRequest.id,
      merchantId,
      itemDecisions: [{ returnItemId: reqRet.returnRequest.items[0].id, qcPassed: true }],
    });
    assert.strictEqual(qcOk.returnRecord.status, 'ACCEPTED');
    const stockPostPass = Number(
      (await pool.query(`SELECT stock_count FROM store_inventory WHERE merchant_id = $1 AND product_id = $2`, [merchantId, productId])).rows[0].stock_count
    );
    assert.strictEqual(stockPostPass, stockPre + 1);
    await assertLedgerBalanced();
    console.log('  ✓ Return QC external refund decoupling, failure isolation & restock/clawback verified');
    passed++;

    // =========================================================================
    // TEST 8: Reverse Pickup Preservation of Forward Trip, Idempotency, Reassignment & Cancellation
    // =========================================================================
    console.log('\n[8/9] Reverse pickup independent trip creation, forward preservation, reassignment & cancellation...');
    const revOrd = await seedOrderWithTrip({
      paymentMethod: 'Instant UPI',
      paymentStatus: 'PAID',
      status: 'delivered',
      tripStatus: 'DELIVERED',
      riderId: rider1Id,
      baseFare: 52,
      distanceFare: 14,
      postPaymentGl: true,
    });
    await settlementAllocationService.allocateFulfilledOrder(revOrd.orderId);

    const revReq1 = await returnService.requestReturn({
      orderId: revOrd.orderId,
      userId: custId1,
      items: [{ orderItemId: revOrd.orderItemId, quantity: 1 }],
      reasonCode: 'WRONG_ITEM',
    });
    const revApproved1 = await returnService.reviewReturn({
      returnId: revReq1.returnRequest.id,
      merchantId,
      action: 'APPROVE',
    });
    const revTripId = revApproved1.pickupTripId!;
    assert.ok(revTripId && revTripId !== revOrd.tripId, 'Reverse pickup trip must have distinct ID from forward trip');

    // Verify forward trip is completely preserved
    const fwdRow = (await pool.query(`SELECT * FROM delivery_trips WHERE id = $1`, [revOrd.tripId])).rows[0];
    const revRow = (await pool.query(`SELECT * FROM delivery_trips WHERE id = $1`, [revTripId])).rows[0];
    assert.strictEqual(fwdRow.trip_type, 'FORWARD');
    assert.strictEqual(fwdRow.status, 'DELIVERED');
    assert.strictEqual(fwdRow.rider_id, rider1Id);
    assert.strictEqual(revRow.trip_type, 'REVERSE_PICKUP');
    assert.strictEqual(revRow.return_id, revReq1.returnRequest.id);
    assert.strictEqual(revRow.status, 'BROADCASTING');

    // Duplicate creation call for same returnId must be idempotent
    const revTripDup = await dispatchService.createReversePickupTrip({
      returnId: revReq1.returnRequest.id,
      orderId: revOrd.orderId,
      merchantId,
    });
    assert.strictEqual(revTripDup, revTripId);

    // Reassign reverse trip to rider2 without affecting forward trip rider1
    const reassigned = await dispatchService.assignReversePickupRider({ tripId: revTripId, riderId: rider2Id });
    assert.strictEqual(reassigned.riderId, rider2Id);
    const fwdAfterReassign = (await pool.query(`SELECT rider_id, status FROM delivery_trips WHERE id = $1`, [revOrd.tripId])).rows[0];
    assert.strictEqual(fwdAfterReassign.rider_id, rider1Id);
    assert.strictEqual(fwdAfterReassign.status, 'DELIVERED');

    // Both rider1 (forward) and rider2 (reverse) can inspect the order via ownership check!
    const r2OrderRes = await apiCall(`/api/orders/${revOrd.orderId}`, { token: rider2Token });
    assert.strictEqual(r2OrderRes.status, 200, 'Reverse pickup rider must have order visibility alongside forward rider');

    // Cancel reverse pickup -> only reverse trip becomes CANCELLED; forward trip remains DELIVERED!
    await dispatchService.cancelReversePickupTrip({ returnId: revReq1.returnRequest.id });
    const revAfterCancel = (await pool.query(`SELECT status FROM delivery_trips WHERE id = $1`, [revTripId])).rows[0];
    const fwdAfterCancel = (await pool.query(`SELECT status FROM delivery_trips WHERE id = $1`, [revOrd.tripId])).rows[0];
    assert.strictEqual(revAfterCancel.status, 'CANCELLED');
    assert.strictEqual(fwdAfterCancel.status, 'DELIVERED');
    console.log('  ✓ Reverse pickup preservation, idempotency, reassignment & cancellation verified');
    passed++;

    // =========================================================================
    // TEST 9: GPS Coordinate Validity, Staleness & No Store-Location Substitution
    // =========================================================================
    console.log('\n[9/9] Rider GPS null/(0,0)/out-of-range/stale exclusion & valid acceptance...');
    const baseRiderCols = { status: 'AVAILABLE', is_payout_held: false };
    void baseRiderCols;

    const rNullGps = crypto.randomUUID();
    const rZeroGps = crypto.randomUUID();
    const rBadGps = crypto.randomUUID();
    const rStaleGps = crypto.randomUUID();
    const rValidGps = crypto.randomUUID();

    // Pause existing seeded riders temporarily
    await pool.query(`UPDATE riders SET status = 'OFFLINE'`);

    const staleAt = new Date(Date.now() - 25 * 60 * 1000);
    await pool.query(
      `INSERT INTO riders (id, rider_code, name, phone, status, vehicle_type, payload_capacity_kg, latitude, longitude, location_updated_at)
       VALUES
         ($1, 'R-NULL', 'Null GPS Rider', '+91-9000000001', 'AVAILABLE', 'ev_scooter', 25, NULL, NULL, NOW()),
         ($2, 'R-ZERO', 'Zero GPS Rider', '+91-9000000002', 'AVAILABLE', 'ev_scooter', 25, 0, 0, NOW()),
         ($3, 'R-BAD',  'Invalid GPS Rider', '+91-9000000003', 'AVAILABLE', 'ev_scooter', 25, 95.5, 200.1, NOW()),
         ($4, 'R-STALE','Stale GPS Rider', '+91-9000000004', 'AVAILABLE', 'ev_scooter', 25, $6, $7, $8),
         ($5, 'R-VALID','Valid GPS Rider', '+91-9000000005', 'AVAILABLE', 'ev_scooter', 25, $6, $7, NOW())`,
      [rNullGps, rZeroGps, rBadGps, rStaleGps, rValidGps, storeLat + 0.008, storeLng + 0.008, staleAt]
    );

    const candidates = await candidateGenerator.generateCandidates({
      orderId: revOrd.orderId,
      merchantId,
      storeLocation: { latitude: storeLat, longitude: storeLng },
      customerLocation: { latitude: storeLat + 0.02, longitude: storeLng + 0.02 },
      itemsSubtotal: 500,
      customerDeliveryFee: 20,
      handlingFee: 5,
    });

    const candidateIds = candidates.map((c) => c.riderId);
    assert.deepStrictEqual(
      candidateIds,
      [rValidGps],
      `Expected only valid non-stale GPS rider [${rValidGps}], got ${JSON.stringify(candidateIds)}`
    );
    assert.ok(
      candidates[0].distanceToStoreMeters > 0,
      'Valid GPS rider must not fall back to zero distance via store-location substitution'
    );
    console.log('  ✓ Null, (0,0), out-of-range, and stale (>10m) GPS riders strictly excluded');
    passed++;

    console.log(`\n✓ Sprint 15.7 Test Suite PASSED (${passed}/9 test sections verified)!`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  }
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1] && process.argv[1].endsWith('sprint15-7-transaction-cod-reverse-trip-integrity.test.ts'))
) {
  runSprint15_7TransactionCodReverseTripIntegrityTests().catch((err) => {
    console.error('❌ Sprint 15.7 suite failed:', err);
    process.exit(1);
  });
}
