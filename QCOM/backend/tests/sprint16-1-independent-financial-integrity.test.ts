import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { setPool, transaction } from '../src/database/connection.js';
import { runMigrations } from '../src/database/migrator.js';
import { runSeeds } from '../seeds/seedData.js';
import { AuthService } from '../src/modules/auth/authService.js';
import { invoiceService } from '../src/modules/invoices/invoiceService.js';
import { ledgerService } from '../src/modules/ledger/ledgerService.js';
import { cancellationService } from '../src/modules/orders/cancellationService.js';
import { orderService } from '../src/modules/orders/orderService.js';
import { returnService } from '../src/modules/orders/returnService.js';
import { couponPromotionService } from '../src/modules/pricing/couponPromotionService.js';
import { pricingEngine } from '../src/modules/pricing/pricingEngine.js';
import { roundCurrency, add, subtract, toDecimal } from '../src/modules/pricing/money.js';
import { paymentReconciliationService } from '../src/modules/reconciliation/paymentReconciliationService.js';
import { settlementAllocationService } from '../src/modules/settlements/settlementAllocationService.js';
import { createSlidingWindowRateLimiter } from '../src/middleware/rateLimiter.js';
import { createTestDatabase } from './helpers/testDb.js';

export async function runSprint16_1IndependentFinancialIntegrityTests(): Promise<void> {
  console.log('\n================================================================================');
  console.log('  SPRINT 16.1 — INDEPENDENT PRICING, GST, COUPON, REFUND & LEDGER INTEGRITY GATE');
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

  let passedGroups = 0;

  try {
    // -------------------------------------------------------------------------
    // Shared Test Actors & Catalog Setup
    // -------------------------------------------------------------------------
    const adminAuth = await authService.adminLogin(
      'EMP-001',
      process.env.SEED_ADMIN_PASSWORD || 'QcomSeedAdmin#2026',
      '127.0.0.1',
      'AdminPortal',
      pool
    );
    const adminUserId = adminAuth.user.id;

    const custAOtp = await authService.requestOtp('+91-9876543210', 'LOGIN', '127.0.0.1', pool);
    const custAAuth = await authService.verifyOtp(
      '+91-9876543210',
      custAOtp.debugOtp!,
      'LOGIN',
      '127.0.0.1',
      'CustomerApp',
      'Customer A',
      pool
    );
    const custAToken = custAAuth.accessToken;
    const custAId = custAAuth.user.id;

    const custBOtp = await authService.requestOtp('+91-9988776602', 'LOGIN', '127.0.0.1', pool);
    const custBAuth = await authService.verifyOtp(
      '+91-9988776602',
      custBOtp.debugOtp!,
      'LOGIN',
      '127.0.0.1',
      'CustomerApp',
      'Customer B',
      pool
    );
    const custBToken = custBAuth.accessToken;
    const custBId = custBAuth.user.id;

    const merchA = (
      await pool.query(`SELECT id, state_code FROM merchants WHERE merchant_code = 'MERCH-BLR-01' LIMIT 1`)
    ).rows[0];
    const merchB = (
      await pool.query(`SELECT id, state_code FROM merchants WHERE id != $1 LIMIT 1`, [merchA.id])
    ).rows[0];
    const merchantId = merchA.id as string;

    const prodRows = (
      await pool.query(
        `SELECT p.id, p.sku, p.category, si.selling_price
           FROM products p
           JOIN store_inventory si ON si.product_id = p.id
          WHERE si.merchant_id = $1 AND si.is_available = TRUE
          ORDER BY p.sku ASC LIMIT 2`,
        [merchantId]
      )
    ).rows;
    const prodA = prodRows[0];
    const prodB = prodRows[1];
    await pool.query(`UPDATE store_inventory SET stock_count = 500, reserved_count = 0 WHERE merchant_id = $1`, [merchantId]);

    // =========================================================================
    // GROUP A: Duplicate Item Stock Merge, Distance Validation, Quote Hardening & Idempotency Fingerprint
    // =========================================================================
    console.log('\n[Group A] Testing Duplicate-Line Merge, Quote IDOR/Reuse/Drift & Checkout Idempotency Fingerprint...');
    {
      // 1. Duplicate productId lines exceeding stock=4 must fail INSUFFICIENT_STOCK
      const lowProdId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO products (
           id, sku, name, category, subcategory, hsn_code, gst_rate_percent, cess_rate_percent,
           tax_category, tax_inclusive, is_tax_classification_verified, unit_weight_kg, is_active
         ) VALUES ($1, 'S161-DUP-STK', 'Dup Stock Item', 'hardware', 'tools', '8205', 18.00, 0.00, 'TAXABLE', FALSE, TRUE, 1.0, TRUE)`,
        [lowProdId]
      );
      await pool.query(
        `INSERT INTO store_inventory (merchant_id, product_id, selling_price, original_mrp, stock_count, reserved_count, bin_location, is_available)
         VALUES ($1, $2, 100.00, 120.00, 4, 0, 'A1', TRUE)`,
        [merchantId, lowProdId]
      );

      await assert.rejects(
        () =>
          pricingEngine.calculate(
            {
              merchantId,
              items: [
                { productId: lowProdId, quantity: 3 },
                { productId: lowProdId, quantity: 3 },
              ],
              placeOfSupplyStateCode: '29',
              userId: custAId,
            },
            pool
          ),
        /INSUFFICIENT_STOCK/
      );

      // Clean duplicate valid merge: 2 + 2 = 4 succeeds and returns 1 merged item of qty 4
      const mergedCalc = await pricingEngine.calculate(
        {
          merchantId,
          items: [
            { productId: lowProdId, quantity: 2 },
            { productId: lowProdId, quantity: 2 },
          ],
          placeOfSupplyStateCode: '29',
          userId: custAId,
        },
        pool
      );
      assert.strictEqual(mergedCalc.items.length, 1);
      assert.strictEqual(mergedCalc.items[0].quantity, 4);

      // 2. Negative / NaN distanceKm must fail with 400 INVALID_DISTANCE
      await assert.rejects(
        () =>
          pricingEngine.calculate(
            {
              merchantId,
              items: [{ productId: prodA.id, quantity: 1 }],
              placeOfSupplyStateCode: '29',
              distanceKm: -5,
            },
            pool
          ),
        /INVALID_DISTANCE|non-negative/
      );

      // 3. Quote ownership (403), cross-merchant mismatch (409), drift without expectedTotal (409), and single-use (409)
      const qCustRes = await apiCall('/api/v1/pricing/quote', {
        method: 'POST',
        token: custAToken,
        body: {
          merchantId,
          items: [{ productId: lowProdId, quantity: 1 }],
          placeOfSupplyStateCode: '29',
        },
      });
      assert.strictEqual(qCustRes.status, 200);
      const quoteAId = qCustRes.data.quote.quoteId;

      // Cross-customer quote IDOR blocked (403 QUOTE_ACCESS_DENIED)
      const idorOrderRes = await apiCall('/api/v1/orders/create', {
        method: 'POST',
        token: custBToken,
        headers: { 'Idempotency-Key': `s161-q-idor-${Date.now()}` },
        body: {
          merchantId,
          items: [{ productId: lowProdId, quantity: 1 }],
          quoteId: quoteAId,
          placeOfSupplyStateCode: '29',
          paymentMethod: 'Pay on Delivery',
          deliveryLocation: { address: 'Addr B', latitude: 12.9352, longitude: 77.6245 },
        },
      });
      assert.strictEqual(idorOrderRes.status, 403);
      assert.strictEqual(idorOrderRes.data.error, 'QUOTE_ACCESS_DENIED');

      // Cross-merchant mismatch blocked (409 QUOTE_MERCHANT_MISMATCH)
      if (merchB) {
        const crossMerchRes = await apiCall('/api/v1/orders/create', {
          method: 'POST',
          token: custAToken,
          headers: { 'Idempotency-Key': `s161-q-merch-${Date.now()}` },
          body: {
            merchantId: merchB.id,
            items: [{ productId: lowProdId, quantity: 1 }],
            quoteId: quoteAId,
            placeOfSupplyStateCode: '29',
            paymentMethod: 'Pay on Delivery',
            deliveryLocation: { address: 'Addr A', latitude: 12.9352, longitude: 77.6245 },
          },
        });
        assert.strictEqual(crossMerchRes.status, 409);
        assert.strictEqual(crossMerchRes.data.error, 'QUOTE_MERCHANT_MISMATCH');
      }

      // Price drift detection even when expectedTotal is omitted (using quoteId alone)
      await pool.query(
        `UPDATE store_inventory SET selling_price = 150.00, original_mrp = 160.00 WHERE merchant_id = $1 AND product_id = $2`,
        [merchantId, lowProdId]
      );
      const driftRes = await apiCall('/api/v1/orders/create', {
        method: 'POST',
        token: custAToken,
        headers: { 'Idempotency-Key': `s161-q-drift-${Date.now()}` },
        body: {
          merchantId,
          items: [{ productId: lowProdId, quantity: 1 }],
          quoteId: quoteAId,
          placeOfSupplyStateCode: '29',
          paymentMethod: 'Pay on Delivery',
          deliveryLocation: { address: 'Addr A', latitude: 12.9352, longitude: 77.6245 },
        },
      });
      assert.strictEqual(driftRes.status, 409);
      assert.strictEqual(driftRes.data.error, 'PRICE_CHANGED');

      // Restore price, place order once with quoteAId -> 201; reuse quoteAId -> 409 QUOTE_ALREADY_USED
      await pool.query(
        `UPDATE store_inventory SET selling_price = 100.00, original_mrp = 120.00 WHERE merchant_id = $1 AND product_id = $2`,
        [merchantId, lowProdId]
      );
      const reuseKey1 = `s161-q-use1-${Date.now()}`;
      const okQuoteOrder = await apiCall('/api/v1/orders/create', {
        method: 'POST',
        token: custAToken,
        headers: { 'Idempotency-Key': reuseKey1 },
        body: {
          merchantId,
          items: [{ productId: lowProdId, quantity: 1 }],
          quoteId: quoteAId,
          placeOfSupplyStateCode: '29',
          paymentMethod: 'Pay on Delivery',
          deliveryLocation: { address: 'Addr A', latitude: 12.9352, longitude: 77.6245 },
        },
      });
      assert.strictEqual(okQuoteOrder.status, 200);

      const reuseQuoteRes = await apiCall('/api/v1/orders/create', {
        method: 'POST',
        token: custAToken,
        headers: { 'Idempotency-Key': `s161-q-use2-${Date.now()}` },
        body: {
          merchantId,
          items: [{ productId: lowProdId, quantity: 1 }],
          quoteId: quoteAId,
          placeOfSupplyStateCode: '29',
          paymentMethod: 'Pay on Delivery',
          deliveryLocation: { address: 'Addr A', latitude: 12.9352, longitude: 77.6245 },
        },
      });
      assert.strictEqual(reuseQuoteRes.status, 409);
      assert.strictEqual(reuseQuoteRes.data.error, 'QUOTE_ALREADY_USED');

      // 4. Idempotency-Key fingerprint detects tampered placeOfSupplyStateCode
      const tamperPosRes = await apiCall('/api/v1/orders/create', {
        method: 'POST',
        token: custAToken,
        headers: { 'Idempotency-Key': reuseKey1 },
        body: {
          merchantId,
          items: [{ productId: lowProdId, quantity: 1 }],
          quoteId: quoteAId,
          placeOfSupplyStateCode: '27', // changed POS from 29 -> 27 with same Idempotency-Key!
          paymentMethod: 'Pay on Delivery',
          deliveryLocation: { address: 'Addr A', latitude: 12.9352, longitude: 77.6245 },
        },
      });
      assert.strictEqual(tamperPosRes.status, 422);
      assert.strictEqual(tamperPosRes.data.error, 'IDEMPOTENCY_PAYLOAD_MISMATCH');

      passedGroups++;
      console.log('✓ Group A Passed: Duplicate merge, distance guard, quote IDOR/reuse/drift & POS idempotency verified.');
    }

    // =========================================================================
    // GROUP B: Discount Rounding Remainder, Under-Lock Promo/Coupon Guards & FREE_DELIVERY Return Safety
    // =========================================================================
    console.log('\n[Group B] Testing Discount Rounding Remainder, Under-Lock Inactive Promo & FREE_DELIVERY Preservation...');
    {
      // 1. Fractional discount rounding remainder: 100.00 order across 3 tiny unequal lines + ₹10.00 50/50 split discount
      // Verify sum(item.appliedDiscounts.discountAmount) === appliedCoupon.discountAmount & funding shares match exact total
      const roundProd1 = crypto.randomUUID();
      const roundProd2 = crypto.randomUUID();
      const roundProd3 = crypto.randomUUID();
      for (const [id, sku, price] of [
        [roundProd1, 'S161-RND-1', 33.33],
        [roundProd2, 'S161-RND-2', 33.33],
        [roundProd3, 'S161-RND-3', 33.34],
      ] as Array<[string, string, number]>) {
        await pool.query(
          `INSERT INTO products (
             id, sku, name, category, subcategory, hsn_code, gst_rate_percent, cess_rate_percent,
             tax_category, tax_inclusive, is_tax_classification_verified, unit_weight_kg, is_active
           ) VALUES ($1, $2, $2, 'hardware', 'tools', '8205', 18.00, 0.00, 'TAXABLE', TRUE, TRUE, 0.5, TRUE)`,
          [id, sku]
        );
        await pool.query(
          `INSERT INTO store_inventory (merchant_id, product_id, selling_price, original_mrp, stock_count, reserved_count, bin_location, is_available)
           VALUES ($1, $2, $3, $3, 50, 0, 'B1', TRUE)`,
          [merchantId, id, price]
        );
      }

      const splitCode = `SPLIT161_${Date.now().toString().slice(-4)}`;
      await couponPromotionService.createCoupon({
        code: splitCode,
        title: 'Mixed Share Rounding Test',
        discountType: 'PERCENTAGE',
        discountValue: 15, // 15% of 100.00 = 15.00 split across 3 fractional items
        minOrderValueInr: 50,
        fundingSource: 'SHARED',
        sellerSharePercent: 33.33,
        actorId: adminUserId,
      });

      const rndQuote = await pricingEngine.calculate(
        {
          merchantId,
          items: [
            { productId: roundProd1, quantity: 1 },
            { productId: roundProd2, quantity: 1 },
            { productId: roundProd3, quantity: 1 },
          ],
          couponCode: splitCode,
          placeOfSupplyStateCode: '29',
          userId: custAId,
        },
        pool
      );
      assert.ok(rndQuote.appliedCoupon);
      assert.ok(rndQuote.appliedCoupon.sellerShareAmount !== undefined);
      assert.ok(rndQuote.appliedCoupon.platformShareAmount !== undefined);
      const itemDiscSum = rndQuote.items.reduce(
        (acc, it) =>
          add(
            acc,
            (it.appliedDiscounts || []).reduce((s, d) => add(s, d.discountAmount), toDecimal(0))
          ),
        toDecimal(0)
      );
      assert.strictEqual(
        roundCurrency(itemDiscSum),
        rndQuote.appliedCoupon.discountAmount,
        'Item discount sum must equal appliedCoupon.discountAmount to the exact paisa'
      );
      assert.strictEqual(
        roundCurrency(
          add(rndQuote.appliedCoupon.sellerShareAmount, rndQuote.appliedCoupon.platformShareAmount)
        ),
        rndQuote.appliedCoupon.discountAmount,
        'Coupon seller + platform funding shares must equal coupon discountAmount exactly'
      );

      // 2. Under-lock inactive promotion must throw 409 PROMOTION_INACTIVE (never leak silent free discount)
      const promoId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO promotions (
           id, code, title, promotion_type, discount_value, funding_source, seller_share_percent,
           is_stackable, is_active, valid_from, valid_to
         ) VALUES ($1, $2, 'Race Promo', 'PERCENTAGE', 10.00, 'PLATFORM', 0.00, TRUE, FALSE, NOW() - INTERVAL '1 hour', NOW() + INTERVAL '1 day')`,
        [promoId, `INACT161_${Date.now().toString().slice(-4)}`]
      );
      const tempOrderId = crypto.randomUUID();
      await assert.rejects(
        () =>
          transaction(async (client) => {
            await couponPromotionService.lockAndReserveForOrder({
              client,
              orderId: tempOrderId,
              userId: custAId,
              merchantId,
              appliedPromotions: [
                {
                  sourceType: 'PROMOTION',
                  sourceId: promoId,
                  code: 'INACT161',
                  discountAmount: '10.00',
                  sellerShareAmount: '0.00',
                  platformShareAmount: '10.00',
                  fundingSource: 'PLATFORM',
                  discountTarget: 'ITEMS',
                },
              ],
            });
          }),
        (err: any) => err?.code === 'PROMOTION_INACTIVE'
      );

      // 3. FREE_DELIVERY promotion must remain 'APPLIED' (NOT marked 'REVERSED') after full item return
      const freeDelPromoId = crypto.randomUUID();
      const freeDelCode = `FD161_${Date.now().toString().slice(-4)}`;
      await pool.query(
        `INSERT INTO promotions (
           id, code, title, promotion_type, discount_value, min_order_value_inr, funding_source,
           seller_share_percent, is_stackable, is_active, priority, valid_from, valid_to
         ) VALUES ($1, $2, 'Free Del Promo', 'FREE_DELIVERY', 100.00, 100.00, 'PLATFORM', 0.00, TRUE, TRUE, 10, NOW() - INTERVAL '1 hour', NOW() + INTERVAL '1 day')`,
        [freeDelPromoId, freeDelCode]
      );
      const fdOrderRes = await orderService.createOrder({
        userId: custBId,
        merchantId,
        items: [{ productId: roundProd1, quantity: 4 }],
        placeOfSupplyStateCode: '29',
        paymentMethod: 'Pay on Delivery',
        jobSite: { address: 'BLR FreeDel', latitude: 12.95, longitude: 77.65 },
        idempotencyKey: `s161-fd-${Date.now()}`,
      });
      await couponPromotionService.reverseForReturn(pool as any, fdOrderRes.order.id, 1, true);
      const paPost = await pool.query(
        `SELECT status, reversed_amount FROM promotion_applications WHERE order_id = $1 AND promotion_id = $2`,
        [fdOrderRes.order.id, freeDelPromoId]
      );
      if (paPost.rows.length > 0) {
        assert.strictEqual(paPost.rows[0].status, 'APPLIED', 'FREE_DELIVERY must NOT be marked REVERSED on item returns');
        assert.strictEqual(Number(paPost.rows[0].reversed_amount || 0), 0);
      }
      // Deactivate FD promo so it doesn't interfere with downstream delivery fee checks
      await pool.query(`UPDATE promotions SET is_active = FALSE WHERE id = $1`, [freeDelPromoId]);

      passedGroups++;
      console.log('✓ Group B Passed: Discount rounding reconciliation, inactive promo guard & FREE_DELIVERY preservation verified.');
    }

    // =========================================================================
    // GROUP C: Invoice Snapshot Fail-Closed GST, Parent Invoice Auto-Link & 3-Step Sequential Partial Returns
    // =========================================================================
    console.log('\n[Group C] Testing Fail-Closed Invoice GST, Auto-Linked Parent Invoice & 3-Step Partial Return Parity...');
    {
      // Product with price 10.00 tax-exclusive + 18% GST -> 11.80 per unit? Wait: qty=3 @ 3.33 = 9.99 + 18% GST = 11.79 OR qty=3 @ 10.00/3? Let's use 1 item qty=3, inclusive gross 3.9333 -> price = 10.00/ea -> wait: qty=3 at 3.93 => total 11.79; let's use price=3.93? Even better: tax-inclusive unit price = 3.933 -> not integer paisa! With tax-exclusive unitPrice = 10.00 * 3 = 30.00, with 18% GST -> wait: 30 * 0.18 = 5.40, divisible by 3; to force 1-paisa fractional GST across 3 equal unit returns, pick unitPrice = 10.01 * 3 = 30.03 * 0.18 = 5.4054 => 5.41 GST, total = 35.44! Splitting 35.44 into 3 returns: 11.81 + 11.81 + 11.82 = 35.44!
      const seqProdId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO products (
           id, sku, name, category, subcategory, hsn_code, gst_rate_percent, cess_rate_percent,
           tax_category, tax_inclusive, is_tax_classification_verified, unit_weight_kg, is_active
         ) VALUES ($1, 'S161-SEQ3', 'Odd GST Brick', 'bricks', 'clay', '6904', 18.00, 0.00, 'TAXABLE', FALSE, TRUE, 1.0, TRUE)`,
        [seqProdId]
      );
      await pool.query(
        `INSERT INTO store_inventory (merchant_id, product_id, selling_price, original_mrp, stock_count, reserved_count, bin_location, is_available)
         VALUES ($1, $2, 10.03, 12.00, 100, 0, 'C1', TRUE)`,
        [merchantId, seqProdId]
      );

      const seqOrd = await orderService.createOrder({
        userId: custAId,
        merchantId,
        items: [{ productId: seqProdId, quantity: 3 }],
        placeOfSupplyStateCode: '29',
        paymentMethod: 'Instant UPI',
        jobSite: { address: 'BLR Seq', latitude: 12.9352, longitude: 77.6245 },
        idempotencyKey: `s161-seq-${Date.now()}`,
      });
      const orderId = seqOrd.order.id;
      const oiId = seqOrd.order.items![0].id;

      // Mark order paid & delivered (deliberately do NOT pre-call getOrCreateOrderInvoices yet!)
      await ledgerService.recordOrderPayment({
        orderId,
        merchantId,
        grossAmount: seqOrd.order.totalAmount,
        taxableAmount: seqOrd.order.taxableAmount,
        cgstAmount: seqOrd.order.cgstAmount,
        sgstAmount: seqOrd.order.sgstAmount,
        deliveryFee: seqOrd.order.deliveryFee,
        handlingFee: seqOrd.order.handlingFee,
      });
      await transaction(async (txClient) => {
        await couponPromotionService.markRedeemedForOrder(txClient, orderId);
      });
      await pool.query(`UPDATE orders SET status = 'delivered', payment_status = 'PAID', delivered_at = NOW() WHERE id = $1`, [orderId]);
      await settlementAllocationService.allocateFulfilledOrder(orderId);

      // Also verify duplicate orderItemId return ceiling abuse is blocked!
      await assert.rejects(
        () =>
          returnService.requestReturn({
            orderId,
            userId: custAId,
            items: [
              { orderItemId: oiId, quantity: 2 },
              { orderItemId: oiId, quantity: 2 },
            ],
            reasonCode: 'DAMAGED',
          }),
        /RETURN_QUANTITY_EXCEEDED/
      );

      // Execute 3 sequential partial returns of 1 unit each
      const refundTotals: number[] = [];
      for (let step = 1; step <= 3; step++) {
        const reqRet = await returnService.requestReturn({
          orderId,
          userId: custAId,
          items: [{ orderItemId: oiId, quantity: 1 }],
          reasonCode: 'DAMAGED',
          customerNotes: `Step ${step}`,
        });
        await returnService.reviewReturn({
          returnId: reqRet.returnRequest.id,
          merchantId,
          adminId: adminUserId,
          action: 'APPROVE',
        });
        await returnService.receiveAtStore({
          returnId: reqRet.returnRequest.id,
          merchantId,
        });
        const qc = await returnService.qcInspectAndResolve({
          returnId: reqRet.returnRequest.id,
          merchantId,
          itemDecisions: [{ returnItemId: reqRet.returnRequest.items[0].id, qcPassed: true }],
        });
        refundTotals.push(qc.refund!.amount);
      }

      const cumRefund = roundCurrency(refundTotals.reduce((a, b) => add(a, b), new (await import('bignumber.js')).default(0)));
      const creditNotes = await invoiceService.getOrderCreditNotes(orderId);
      assert.strictEqual(creditNotes.length, 3);
      assert.ok(
        creditNotes.every((cn) => Boolean(cn.invoiceId)),
        'All credit notes must auto-link to SELLER_TAX_INVOICE even if invoice was not fetched before return'
      );
      const cumCnTotal = roundCurrency(creditNotes.reduce((a, cn) => add(a, cn.totalAmount), new (await import('bignumber.js')).default(0)));
      const expectedLineTotal = roundCurrency(seqOrd.order.items![0].lineTotalPayable ?? add(seqOrd.order.items![0].taxableAmount!, seqOrd.order.items![0].cgstAmount!, seqOrd.order.items![0].sgstAmount!));
      assert.strictEqual(cumRefund, expectedLineTotal, `Cumulative 3-step refund (${cumRefund}) must equal line payable (${expectedLineTotal})`);
      assert.strictEqual(cumCnTotal, expectedLineTotal, `Cumulative 3-step credit note total (${cumCnTotal}) must equal line payable (${expectedLineTotal}) with ZERO rounding drift`);

      // Verify fail-closed invoice GST when non-snapshot service tax rules are missing
      const unconfiguredOrd = await orderService.createOrder({
        userId: custAId,
        merchantId,
        items: [{ productId: seqProdId, quantity: 1 }],
        placeOfSupplyStateCode: '29',
        paymentMethod: 'Pay on Delivery',
        jobSite: { address: 'BLR FailInv', latitude: 12.95, longitude: 77.65 },
        idempotencyKey: `s161-invfail-${Date.now()}`,
      });
      await pool.query(
        `UPDATE orders SET pricing_snapshot = '{}'::jsonb, delivery_fee = 25.00, handling_fee = 0.00 WHERE id = $1`,
        [unconfiguredOrd.order.id]
      );
      await pool.query(`UPDATE statutory_tax_rules SET is_active = FALSE WHERE tax_type = 'DELIVERY_GST'`);
      await assert.rejects(
        () => invoiceService.getOrCreateOrderInvoices(unconfiguredOrd.order.id),
        (err: any) => err?.code === 'TAX_RULE_NOT_FOUND' || /TAX_RULE_NOT_FOUND|MISSING_TAX/.test(err?.message || '')
      );
      await pool.query(`UPDATE statutory_tax_rules SET is_active = TRUE WHERE tax_type = 'DELIVERY_GST'`);

      passedGroups++;
      console.log('✓ Group C Passed: Duplicate return item guard, auto-linked parent invoice, 3-step sequential partial return ₹0.00 parity & fail-closed invoice GST verified.');
    }

    // =========================================================================
    // GROUP D: 3-Phase QC Concurrency Lock, Phase 2->3 Crash Recovery & COA 5040 Full Return Unwind
    // =========================================================================
    console.log('\n[Group D] Testing 3-Phase QC Crash Recovery, In-Flight Lock & COA 5040 Full Return Unwind...');
    {
      // 1. Fulfill order with FIRST50 (₹50 PLATFORM-funded item coupon) and assert COA 5040 unwinds to 0.00 on full return
      const subProdId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO products (
           id, sku, name, category, subcategory, hsn_code, gst_rate_percent, cess_rate_percent,
           tax_category, tax_inclusive, is_tax_classification_verified, unit_weight_kg, is_active
         ) VALUES ($1, 'S161-SUB-50', 'Subsidized Drill', 'tools', 'power', '8467', 18.00, 0.00, 'TAXABLE', TRUE, TRUE, 1.0, TRUE)`,
        [subProdId]
      );
      await pool.query(
        `INSERT INTO store_inventory (merchant_id, product_id, selling_price, original_mrp, stock_count, reserved_count, bin_location, is_available)
         VALUES ($1, $2, 300.00, 350.00, 50, 0, 'D1', TRUE)`,
        [merchantId, subProdId]
      );

      // Fresh customer so FIRST50 applies
      const custCOtp = await authService.requestOtp('+91-9988776603', 'LOGIN', '127.0.0.1', pool);
      const custCAuth = await authService.verifyOtp(
        '+91-9988776603',
        custCOtp.debugOtp!,
        'LOGIN',
        '127.0.0.1',
        'CustomerApp',
        'Customer C',
        pool
      );
      const custCId = custCAuth.user.id;

      const subCode = `SUB50_${Date.now().toString().slice(-4)}`;
      await couponPromotionService.createCoupon({
        code: subCode,
        title: 'Platform Subsidy Test Coupon',
        discountType: 'FLAT_AMOUNT',
        discountValue: 50,
        minOrderValueInr: 100,
        fundingSource: 'PLATFORM',
        actorId: adminUserId,
      });

      const subOrd = await orderService.createOrder({
        userId: custCId,
        merchantId,
        items: [{ productId: subProdId, quantity: 1 }],
        couponCode: subCode,
        placeOfSupplyStateCode: '29',
        paymentMethod: 'Instant UPI',
        jobSite: { address: 'BLR Sub50', latitude: 12.9352, longitude: 77.6245 },
        idempotencyKey: `s161-sub50-${Date.now()}`,
      });
      const subOrderId = subOrd.order.id;
      const subOiId = subOrd.order.items![0].id;
      assert.ok(Number(subOrd.order.platformDiscountSubsidy) > 0, 'PLATFORM coupon must record platform_discount_subsidy > 0');

      await ledgerService.recordOrderPayment({
        orderId: subOrderId,
        merchantId,
        grossAmount: subOrd.order.totalAmount,
        taxableAmount: subOrd.order.taxableAmount,
        cgstAmount: subOrd.order.cgstAmount,
        sgstAmount: subOrd.order.sgstAmount,
        deliveryFee: subOrd.order.deliveryFee,
        handlingFee: subOrd.order.handlingFee,
      });
      await transaction(async (txClient) => {
        await couponPromotionService.markRedeemedForOrder(txClient, subOrderId);
      });
      await pool.query(`UPDATE orders SET status = 'delivered', payment_status = 'PAID', delivered_at = NOW() WHERE id = $1`, [subOrderId]);

      const sellerBalBefore = Number(
        (
          await pool.query(
            `SELECT running_balance FROM seller_ledgers WHERE merchant_id = $1 ORDER BY created_at DESC, seq_no DESC LIMIT 1`,
            [merchantId]
          )
        ).rows[0]?.running_balance || 0
      );

      await settlementAllocationService.allocateFulfilledOrder(subOrderId);

      // Initiate return -> simulate Phase 1+2 completed refund BEFORE Phase 3 (crash between Phase 2 & Phase 3)
      const subRetReq = await returnService.requestReturn({
        orderId: subOrderId,
        userId: custCId,
        items: [{ orderItemId: subOiId, quantity: 1 }],
        reasonCode: 'DEFECTIVE',
      });
      await returnService.reviewReturn({
        returnId: subRetReq.returnRequest.id,
        merchantId,
        adminId: adminUserId,
        action: 'APPROVE',
      });
      await returnService.receiveAtStore({
        returnId: subRetReq.returnRequest.id,
        merchantId,
      });

      // Simulate an in-flight PROCESSING refund attached -> concurrent QC must fail RETURN_QC_IN_PROGRESS
      const simRefAmount = subOrd.order.items![0].lineTotalPayable ?? roundCurrency(subtract(subOrd.order.items![0].totalPrice, 0));
      const simRefId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO refunds (id, refund_number, order_id, payment_id, refund_type, amount, reason_code, status, idempotency_key)
         VALUES ($1, $2, $3, 'pay_sim', 'FULL', $4, 'RETURN_DEFECTIVE', 'PROCESSING', $5)`,
        [simRefId, `RFND-SIM-${Date.now()}`, subOrderId, simRefAmount, `ret_qc_${subRetReq.returnRequest.id}`]
      );
      await pool.query(`UPDATE order_returns SET refund_id = $1 WHERE id = $2`, [simRefId, subRetReq.returnRequest.id]);

      await assert.rejects(
        () =>
          returnService.qcInspectAndResolve({
            returnId: subRetReq.returnRequest.id,
            merchantId,
            itemDecisions: [{ returnItemId: subRetReq.returnRequest.items[0].id, qcPassed: true }],
          }),
        /RETURN_QC_IN_PROGRESS/
      );

      // Now simulate Phase 2 completed refund ('COMPLETED') after crash before Phase 3 -> retry finalizes cleanly WITHOUT creating a second refund!
      await pool.query(`UPDATE refunds SET status = 'COMPLETED', processed_at = NOW() WHERE id = $1`, [simRefId]);
      const qcRecovered = await returnService.qcInspectAndResolve({
        returnId: subRetReq.returnRequest.id,
        merchantId,
        itemDecisions: [{ returnItemId: subRetReq.returnRequest.items[0].id, qcPassed: true }],
      });
      assert.strictEqual(qcRecovered.returnRecord.status, 'ACCEPTED');
      assert.strictEqual(qcRecovered.refund?.id, simRefId, 'Crash recovery must reuse Phase-2 completed refund without duplicate refund creation');

      const refCountForOrder = Number(
        (await pool.query(`SELECT COUNT(*) AS cnt FROM refunds WHERE order_id = $1`, [subOrderId])).rows[0].cnt
      );
      assert.strictEqual(refCountForOrder, 1, 'Strictly 1 refund row may exist after Phase 2->3 crash recovery');

      // Verify COA 5040 netted cleanly to 0.00 (DR == CR for this order) & allocation reversed_platform_subsidy matches
      const gl5040 = (
        await pool.query(
          `SELECT
             COALESCE(SUM(CASE WHEN entry_side = 'DEBIT' THEN amount ELSE 0 END), 0) AS dr,
             COALESCE(SUM(CASE WHEN entry_side = 'CREDIT' THEN amount ELSE 0 END), 0) AS cr
           FROM general_ledger_entries
           WHERE order_id = $1 AND account_code = '5040'`,
          [subOrderId]
        )
      ).rows[0];
      assert.strictEqual(roundCurrency(gl5040.dr), roundCurrency(gl5040.cr), 'Full return of subsidized order must net COA 5040 to ₹0.00');

      const allocPost = (
        await pool.query(
          `SELECT status, platform_discount_subsidy, reversed_platform_subsidy FROM order_settlement_allocations WHERE order_id = $1`,
          [subOrderId]
        )
      ).rows[0];
      assert.strictEqual(allocPost.status, 'REVERSED');
      assert.strictEqual(roundCurrency(allocPost.reversed_platform_subsidy), roundCurrency(allocPost.platform_discount_subsidy));

      const sellerBalAfter = Number(
        (
          await pool.query(
            `SELECT running_balance FROM seller_ledgers WHERE merchant_id = $1 ORDER BY created_at DESC, seq_no DESC LIMIT 1`,
            [merchantId]
          )
        ).rows[0]?.running_balance || 0
      );
      assert.strictEqual(
        roundCurrency(sellerBalAfter),
        roundCurrency(sellerBalBefore),
        'Full return on unsettled subsidized order must restore seller running balance cleanly'
      );

      // Global trial balance exact equality
      const tb = await ledgerService.getTrialBalance();
      assert.strictEqual(tb.isBalanced, true, `Global trial balance must remain exact (diff=${tb.difference})`);

      passedGroups++;
      console.log('✓ Group D Passed: In-flight QC block, crash recovery & COA 5040 full return unwind to ₹0.00 verified.');
    }

    // =========================================================================
    // GROUP E: Reconciliation Check 14 (14E-14J) & Rate Limiter Failure-Mode Security
    // =========================================================================
    console.log('\n[Group E] Testing Expanded Check 14 (14E-14J), Route Security & Redis Failure Behavior...');
    {
      // Verify clean reconciliation first (zero synthetic discrepancies from prior valid groups)
      const cleanRecon = await paymentReconciliationService.runReconciliation({ triggeredBy: adminUserId });
      const badCategories = new Set([
        'ORDER_ITEM_TOTALS_DRIFT',
        'ORDER_INVOICE_TOTAL_DRIFT',
        'INVOICE_LINE_ITEMS_DRIFT',
        'CREDIT_NOTE_INTEGRITY_DRIFT',
        'COUPON_CANCELLED_ORDER_UNRELEASED',
        'COA_5040_SUBSIDY_DRIFT',
        'UNBALANCED_JOURNAL_BATCH',
      ]);
      const unexpectedBefore = cleanRecon.discrepancies.filter((d) => badCategories.has(d.category));
      assert.strictEqual(
        unexpectedBefore.length,
        0,
        `Valid Sprint 16.1 transactions must have 0 Check 14E-14J discrepancies; found ${JSON.stringify(unexpectedBefore)}`
      );

      // Inject an unbalanced GL batch temporarily? Wait: DB has immutable GL triggers, so we test Check 14E/14G/14H/14I
      // with non-GL drift: e.g. coupon_redemption stuck RESERVED on a cancelled order + invoice_line_item mismatch
      const reconCpnCode = `REC161_${Date.now().toString().slice(-4)}`;
      await couponPromotionService.createCoupon({
        code: reconCpnCode,
        title: 'Check 14H Recon Coupon',
        discountType: 'FLAT_AMOUNT',
        discountValue: 10,
        minOrderValueInr: 10,
        fundingSource: 'PLATFORM',
        actorId: adminUserId,
      });

      const cancelledOrdRes = await orderService.createOrder({
        userId: custAId,
        merchantId,
        items: [{ productId: prodA.id, quantity: 1 }],
        couponCode: reconCpnCode,
        placeOfSupplyStateCode: '29',
        paymentMethod: 'Pay on Delivery',
        jobSite: { address: 'BLR CancRecon', latitude: 12.9352, longitude: 77.6245 },
        idempotencyKey: `s161-cancrecon-${Date.now()}`,
      });
      await cancellationService.cancelByCustomer({
        orderId: cancelledOrdRes.order.id,
        userId: custAId,
        reason: 'Synthetic Check 14H test',
      });
      await pool.query(`UPDATE coupon_redemptions SET status = 'RESERVED' WHERE order_id = $1`, [cancelledOrdRes.order.id]);

      const synthRecon = await paymentReconciliationService.runReconciliation({
        orderId: cancelledOrdRes.order.id,
        triggeredBy: adminUserId,
      });
      assert.ok(
        synthRecon.discrepancies.some((d) => d.category === 'COUPON_CANCELLED_ORDER_UNRELEASED'),
        'Check 14H must detect cancelled order with unreleased coupon redemption'
      );
      await pool.query(`UPDATE coupon_redemptions SET status = 'RELEASED' WHERE order_id = $1`, [cancelledOrdRes.order.id]);

      // Verify rate limiter failure modes directly (Redis outage -> closed returns 503 vs open sets X-RateLimit-Status: unavailable)
      const failingEval = async () => {
        throw new Error('ECONNREFUSED');
      };
      const closedLimiter = createSlidingWindowRateLimiter(
        { limit: 5, windowSec: 60, scope: 'test:closed', failureMode: 'closed', skipInTest: false },
        failingEval
      );
      const openLimiter = createSlidingWindowRateLimiter(
        { limit: 5, windowSec: 60, scope: 'test:open', failureMode: 'open', skipInTest: false },
        failingEval
      );

      let closedStatus = 0;
      let closedJson: any = null;
      await closedLimiter(
        { ip: '127.0.0.1', socket: { remoteAddress: '127.0.0.1' }, baseUrl: '/api/v1/pricing', path: '/coupons/validate', headers: {} } as any,
        {
          setHeader() {},
          status(code: number) {
            closedStatus = code;
            return this;
          },
          json(body: any) {
            closedJson = body;
          },
        } as any,
        () => {
          throw new Error('Closed limiter should not invoke next() on Redis outage');
        }
      );
      assert.strictEqual(closedStatus, 503);
      assert.strictEqual(closedJson.error.code, 'RATE_LIMIT_UNAVAILABLE');

      const openHeaders: Record<string, string> = {};
      let openNextCalled = false;
      await openLimiter(
        { ip: '127.0.0.1', socket: { remoteAddress: '127.0.0.1' }, baseUrl: '/api/v1/cart', path: '/items', headers: {} } as any,
        {
          setHeader(k: string, v: string) {
            openHeaders[k] = v;
          },
        } as any,
        () => {
          openNextCalled = true;
        }
      );
      assert.strictEqual(openNextCalled, true);
      assert.strictEqual(openHeaders['X-RateLimit-Status'], 'unavailable');

      passedGroups++;
      console.log('✓ Group E Passed: Expanded Check 14, rate-limiter failure modes (503 closed vs open header) verified.');
    }

    // =========================================================================
    // GROUP F: GST Edge Cases, Expired Quotes, Promo Conflict Groups & RBAC/IDOR
    // =========================================================================
    console.log('\n[Group F] Testing GST Edge Cases, Expired Quotes, Conflict Groups & RBAC/IDOR...');
    {
      // 1. Expired quote rejected
      const expQ = await apiCall('/api/v1/pricing/quote', {
        method: 'POST',
        token: custAToken,
        body: { merchantId, items: [{ productId: prodA.id, quantity: 1 }], placeOfSupplyStateCode: '29' },
      });
      assert.strictEqual(expQ.status, 200);
      await pool.query(`UPDATE pricing_calculation_snapshots SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [
        expQ.data.quote.quoteId,
      ]);
      const expOrder = await apiCall('/api/v1/orders/create', {
        method: 'POST',
        token: custAToken,
        headers: { 'Idempotency-Key': `s161-expq-${Date.now()}` },
        body: {
          merchantId,
          items: [{ productId: prodA.id, quantity: 1 }],
          quoteId: expQ.data.quote.quoteId,
          placeOfSupplyStateCode: '29',
          paymentMethod: 'Pay on Delivery',
          deliveryLocation: { address: 'Addr A', latitude: 12.9352, longitude: 77.6245 },
        },
      });
      assert.strictEqual(expOrder.status, 409);
      assert.strictEqual(expOrder.data.error, 'QUOTE_EXPIRED');

      // 2. GST edge cases: invalid POS state code, unverified HSN, exempt + cess supply
      await assert.rejects(
        () =>
          pricingEngine.calculate(
            { merchantId, items: [{ productId: prodA.id, quantity: 1 }], placeOfSupplyStateCode: '99' },
            pool
          ),
        (err: any) => err?.code === 'INVALID_STATE_CODE' || /not an active Indian GST state/.test(err?.message || '')
      );

      const unverifiedProdId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO products (
           id, sku, name, category, subcategory, hsn_code, gst_rate_percent, cess_rate_percent,
           tax_category, tax_inclusive, is_tax_classification_verified, unit_weight_kg, is_active
         ) VALUES ($1, 'S161-UNVER', 'Unverified Tax Brick', 'bricks', 'clay', '6904', 12.00, 0.00, 'TAXABLE', FALSE, FALSE, 1.0, TRUE)`,
        [unverifiedProdId]
      );
      await pool.query(
        `INSERT INTO store_inventory (merchant_id, product_id, selling_price, original_mrp, stock_count, reserved_count, bin_location, is_available)
         VALUES ($1, $2, 100.00, 120.00, 20, 0, 'E1', TRUE)`,
        [merchantId, unverifiedProdId]
      );
      await assert.rejects(
        () =>
          pricingEngine.calculate(
            { merchantId, items: [{ productId: unverifiedProdId, quantity: 1 }], placeOfSupplyStateCode: '29' },
            pool
          ),
        (err: any) => err?.code === 'UNVERIFIED_TAX_CLASSIFICATION' || /verified GST\/HSN/i.test(err?.message || '')
      );

      // Inter-state supply (29 -> 27) produces IGST > 0 and CGST = SGST = 0
      const igstCalc = await pricingEngine.calculate(
        { merchantId, items: [{ productId: prodA.id, quantity: 1 }], placeOfSupplyStateCode: '27' },
        pool
      );
      assert.strictEqual(igstCalc.isInterState, true);
      assert.ok(Number(igstCalc.totalIgst) > 0);
      assert.strictEqual(Number(igstCalc.totalCgst), 0);
      assert.strictEqual(Number(igstCalc.totalSgst), 0);

      // 3. Promotion conflict_group resolution (higher priority wins exclusively)
      const cgHighId = crypto.randomUUID();
      const cgLowId = crypto.randomUUID();
      const cgSuffix = Date.now().toString().slice(-4);
      await pool.query(
        `INSERT INTO promotions (
           id, code, title, promotion_type, discount_value, min_order_value_inr, funding_source,
           seller_share_percent, conflict_group, priority, is_stackable, is_active, valid_from, valid_to
         ) VALUES
           ($1, $3, 'High Priority 12%', 'PERCENTAGE', 12.00, 50.00, 'PLATFORM', 0.00, 'SEASONAL_A', 5, TRUE, TRUE, NOW() - INTERVAL '1 hour', NOW() + INTERVAL '1 day'),
           ($2, $4, 'Low Priority 5%', 'PERCENTAGE', 5.00, 50.00, 'PLATFORM', 0.00, 'SEASONAL_A', 50, TRUE, TRUE, NOW() - INTERVAL '1 hour', NOW() + INTERVAL '1 day')`,
        [cgHighId, cgLowId, `CGH_${cgSuffix}`, `CGL_${cgSuffix}`]
      );
      const cgQuote = await pricingEngine.calculate(
        { merchantId, items: [{ productId: prodA.id, quantity: 1 }], placeOfSupplyStateCode: '29' },
        pool
      );
      assert.ok(cgQuote.appliedPromotions.some((p) => p.sourceId === cgHighId), 'Higher priority promo in conflict_group must apply');
      assert.ok(!cgQuote.appliedPromotions.some((p) => p.sourceId === cgLowId), 'Lower priority promo in same conflict_group must be excluded');
      await pool.query(`UPDATE promotions SET is_active = FALSE WHERE id IN ($1, $2)`, [cgHighId, cgLowId]);

      // 4. IDOR & RBAC verification: customer cart isolation & customer denied admin reconciliation
      await apiCall('/api/v1/cart/items', {
        method: 'POST',
        token: custAToken,
        body: { merchantId, productId: prodA.id, quantity: 2, placeOfSupplyStateCode: '29' },
      });
      const custBCart = await apiCall(`/api/v1/cart?merchantId=${merchantId}`, {
        method: 'GET',
        token: custBToken,
      });
      assert.strictEqual(custBCart.status, 200);
      assert.strictEqual(custBCart.data.cart?.items?.length || 0, 0, 'Customer B must never see Customer A cart items');

      const custReconDeny = await apiCall('/api/v1/admin/reconciliation/payments/run', {
        method: 'POST',
        token: custAToken,
        body: {},
      });
      assert.strictEqual(custReconDeny.status, 403, 'Non-admin customer must receive 403 on admin reconciliation endpoint');

      const custAdminCpnDeny = await apiCall('/api/v1/admin/coupons', {
        method: 'GET',
        token: custAToken,
      });
      assert.strictEqual(custAdminCpnDeny.status, 403, 'Non-admin customer must receive 403 on /api/v1/admin/coupons');

      // Cross-customer invoice IDOR check on recent order owned by Customer A
      const custAOrd = await apiCall('/api/v1/orders', { method: 'GET', token: custAToken });
      const targetOrderId = custAOrd.data?.orders?.[0]?.id;
      if (targetOrderId) {
        const crossInv = await apiCall(`/api/v1/invoices/order/${targetOrderId}`, {
          method: 'GET',
          token: custBToken,
        });
        assert.strictEqual(crossInv.status, 403, 'Customer B must receive 403 when requesting Customer A invoice');
      }

      passedGroups++;
      console.log('✓ Group F Passed: Expired quote, GST edge cases, conflict_group priority & IDOR/RBAC verified.');
    }

    assert.strictEqual(passedGroups, 6);
    console.log(`\n✓ ALL ${passedGroups}/6 SPRINT 16.1 INDEPENDENT FINANCIAL INTEGRITY GROUPS PASSED!\n`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    setPool(null);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSprint16_1IndependentFinancialIntegrityTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ Sprint 16.1 suite failed:', err);
      process.exit(1);
    });
}
