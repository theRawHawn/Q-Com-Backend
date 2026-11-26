import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { setPool, transaction } from '../src/database/connection.js';
import { runMigrations } from '../src/database/migrator.js';
import { runSeeds } from '../seeds/seedData.js';
import { AuthService } from '../src/modules/auth/authService.js';
import { computeIndianFinancialYear, invoiceService } from '../src/modules/invoices/invoiceService.js';
import { ledgerService } from '../src/modules/ledger/ledgerService.js';
import { cancellationService } from '../src/modules/orders/cancellationService.js';
import { orderService } from '../src/modules/orders/orderService.js';
import { returnService } from '../src/modules/orders/returnService.js';
import { couponPromotionService } from '../src/modules/pricing/couponPromotionService.js';
import { pricingEngine } from '../src/modules/pricing/pricingEngine.js';
import { roundCurrency, add, subtract, multiply } from '../src/modules/pricing/money.js';
import { paymentReconciliationService } from '../src/modules/reconciliation/paymentReconciliationService.js';
import { settlementAllocationService } from '../src/modules/settlements/settlementAllocationService.js';
import { createTestDatabase } from './helpers/testDb.js';

export async function runSprint16_0PricingGstCouponsPromotionsTests(): Promise<void> {
  console.log('\n================================================================================');
  console.log('  SPRINT 16.0 — PRICING, GST, COUPONS, DISCOUNTS & PROMOTION FINANCIAL INTEGRITY');
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
    // Setup Shared Actors & Seed Catalog
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

    // Customer A (+91-9876543210, Karnataka saved address seeded)
    const custAOtp = await authService.requestOtp('+91-9876543210', 'LOGIN', '127.0.0.1', pool);
    const custAAuth = await authService.verifyOtp('+91-9876543210', custAOtp.debugOtp!, 'LOGIN', '127.0.0.1', 'CustomerApp', 'Customer A', pool);
    const custAToken = custAAuth.accessToken;
    const custAId = custAAuth.user.id;

    // Customer B (fresh customer for first_order_only & multi-user tests)
    const custBOtp = await authService.requestOtp('+91-9988776601', 'LOGIN', '127.0.0.1', pool);
    const custBAuth = await authService.verifyOtp('+91-9988776601', custBOtp.debugOtp!, 'LOGIN', '127.0.0.1', 'CustomerApp', 'Customer B', pool);
    const custBToken = custBAuth.accessToken;
    const custBId = custBAuth.user.id;

    const merchRow = (
      await pool.query(`SELECT id, state_code, gstin FROM merchants WHERE merchant_code = 'MERCH-BLR-01' LIMIT 1`)
    ).rows[0];
    const merchantId = merchRow.id as string;
    assert.strictEqual(merchRow.state_code, '29');

    const prodRows = (
      await pool.query(
        `SELECT p.id, p.sku, p.category, si.selling_price
         FROM products p
         JOIN store_inventory si ON si.product_id = p.id
         WHERE si.merchant_id = $1 AND si.is_available = TRUE
         ORDER BY p.sku ASC LIMIT 3`,
        [merchantId]
      )
    ).rows;
    assert.ok(prodRows.length >= 2, 'Expected seeded inventory items for MERCH-BLR-01');
    const prodA = prodRows[0];
    const prodB = prodRows[1];

    await pool.query(`UPDATE store_inventory SET stock_count = 500 WHERE merchant_id = $1`, [merchantId]);

    // Clean any pre-existing carts / promo overrides
    await pool.query(`DELETE FROM carts`);

    // =========================================================================
    // GROUP A: Tax-Inclusive vs Tax-Exclusive, Cess, Exempt/Nil/Zero-Rated, Fail-Closed Unverified Tax
    // =========================================================================
    console.log('\n[Group A] Testing GST Modes (Inclusive/Exclusive/Cess/Exempt) & Fail-Closed Tax Classification...');
    {
      // Create 3 distinct tax-mode test products on MERCH-BLR-01
      const prodInclId = crypto.randomUUID();
      const prodCessId = crypto.randomUUID();
      const prodExemptId = crypto.randomUUID();
      const prodUnverifiedId = crypto.randomUUID();

      await pool.query(
        `INSERT INTO products (
           id, sku, name, category, subcategory, hsn_code, gst_rate_percent, cess_rate_percent,
           tax_category, tax_inclusive, is_tax_classification_verified, unit_weight_kg, is_active
         ) VALUES
           ($1, 'S16-INCL-18', 'Inclusive Cement 18%', 'cement', 'grey_cement', '2523', 18.00, 0.00, 'TAXABLE', TRUE, TRUE, 1.000, TRUE),
           ($2, 'S16-CESS-28', 'Luxury Paint + 12% Cess', 'paints', 'enamel', '3208', 28.00, 12.00, 'TAXABLE', FALSE, TRUE, 1.000, TRUE),
           ($3, 'S16-EXEMPT-0', 'Exempt Brick', 'bricks', 'clay_brick', '6904', 0.00, 0.00, 'EXEMPT', FALSE, TRUE, 1.000, TRUE),
           ($4, 'S16-UNVERIFIED', 'Unverified Item', 'hardware', 'misc', '7318', 18.00, 0.00, 'TAXABLE', FALSE, FALSE, 0.500, TRUE)`,
        [prodInclId, prodCessId, prodExemptId, prodUnverifiedId]
      );

      await pool.query(
        `INSERT INTO store_inventory (merchant_id, product_id, selling_price, original_mrp, stock_count, reserved_count, bin_location, is_available)
         VALUES
           ($1, $2, 118.00, 118.00, 100, 0, 'A-01', TRUE),
           ($1, $3, 100.00, 100.00, 100, 0, 'A-02', TRUE),
           ($1, $4, 50.00, 50.00, 100, 0, 'A-03', TRUE),
           ($1, $5, 40.00, 40.00, 100, 0, 'A-04', TRUE)`,
        [merchantId, prodInclId, prodCessId, prodExemptId, prodUnverifiedId]
      );

      // 1. Tax-inclusive product: sellingPrice=118 at 18% GST -> base taxable=100.00, CGST=9.00, SGST=9.00, lineTotal=118.00
      const inclQuote = await pricingEngine.calculate({
        merchantId,
        items: [{ productId: prodInclId, quantity: 2 }],
        placeOfSupplyStateCode: '29',
        distanceKm: 1.5,
      });
      const inclLine = inclQuote.items[0];
      assert.strictEqual(inclLine.taxInclusive, true);
      assert.strictEqual(inclLine.taxableAmount, '200.00');
      assert.strictEqual(inclLine.cgstAmount, '18.00');
      assert.strictEqual(inclLine.sgstAmount, '18.00');
      assert.strictEqual(inclLine.igstAmount, '0.00');
      assert.strictEqual(inclLine.lineTotal, '236.00');

      // 2. Tax-exclusive + Cess product: 100.00 + 28% GST + 12% Cess -> taxable=100.00, CGST=14.00, SGST=14.00, Cess=12.00, total=140.00
      const cessQuote = await pricingEngine.calculate({
        merchantId,
        items: [{ productId: prodCessId, quantity: 1 }],
        placeOfSupplyStateCode: '29',
        distanceKm: 1.5,
      });
      const cessLine = cessQuote.items[0];
      assert.strictEqual(cessLine.taxInclusive, false);
      assert.strictEqual(cessLine.taxableAmount, '100.00');
      assert.strictEqual(cessLine.cgstAmount, '14.00');
      assert.strictEqual(cessLine.sgstAmount, '14.00');
      assert.strictEqual(cessLine.cessAmount, '12.00');
      assert.strictEqual(cessLine.lineTotal, '140.00');

      // 3. EXEMPT product: 0 tax enforced
      const exQuote = await pricingEngine.calculate({
        merchantId,
        items: [{ productId: prodExemptId, quantity: 3 }],
        placeOfSupplyStateCode: '29',
        distanceKm: 1.5,
      });
      const exLine = exQuote.items[0];
      assert.strictEqual(exLine.taxCategory, 'EXEMPT');
      assert.strictEqual(exLine.cgstAmount, '0.00');
      assert.strictEqual(exLine.sgstAmount, '0.00');
      assert.strictEqual(exLine.cessAmount, '0.00');
      assert.strictEqual(exLine.lineTotal, '150.00');

      // 4. Fail-closed unverified product tax classification -> 422
      const unvRes = await apiCall('/api/v1/pricing/quote', {
        method: 'POST',
        token: custAToken,
        body: {
          merchantId,
          items: [{ productId: prodUnverifiedId, quantity: 1 }],
          placeOfSupplyStateCode: '29',
        },
      });
      assert.strictEqual(unvRes.status, 422);
      assert.match(String(unvRes.data.error || unvRes.data.message), /TAX|HSN|UNVERIFIED/i);

      // Clean temporary products back to inactive after testing (or leave verified products cleanly)
      await pool.query(`UPDATE products SET is_active = FALSE WHERE id = $1`, [prodUnverifiedId]);

      passedGroups++;
      console.log('✓ Group A Passed: Inclusive, Exclusive + Cess, Exempt, and Fail-Closed Tax Classification verified.');
    }

    // =========================================================================
    // GROUP B: Dynamic Place of Supply (Intra-State vs Inter-State & Missing/Invalid POS)
    // =========================================================================
    console.log('\n[Group B] Testing Dynamic Place of Supply & Intra-State CGST+SGST vs Inter-State IGST...');
    {
      // Saved Maharashtra ('27') address for Customer A
      const mhAddrId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO saved_addresses (id, user_id, address, landmark, site_contact_name, site_phone, trade_type, latitude, longitude, state_code)
         VALUES ($1, $2, 'Bandra West Site', 'Near Linking Road', 'Site Lead', '+91-9876543210', 'plumbing', 19.0596, 72.8295, '27')`,
        [mhAddrId, custAId]
      );

      // Inter-state via deliveryAddressId (merchant '29' -> delivery '27')
      const interQuote = await apiCall('/api/v1/pricing/quote', {
        method: 'POST',
        token: custAToken,
        body: {
          merchantId,
          items: [{ productId: prodA.id, quantity: 2 }],
          deliveryAddressId: mhAddrId,
          distanceKm: 2,
        },
      });
      assert.strictEqual(interQuote.status, 200);
      assert.strictEqual(interQuote.data.quote.isInterState, true);
      assert.strictEqual(interQuote.data.quote.placeOfSupplyStateCode, '27');
      assert.strictEqual(interQuote.data.quote.placeOfSupplyStateName, 'Maharashtra');
      assert.strictEqual(Number(interQuote.data.quote.sellerGoodsBreakdown.cgstAmount), 0);
      assert.strictEqual(Number(interQuote.data.quote.sellerGoodsBreakdown.sgstAmount), 0);
      assert.ok(Number(interQuote.data.quote.sellerGoodsBreakdown.igstAmount) > 0);

      // Intra-state ('29') -> CGST == SGST > 0 and IGST == 0
      const intraQuote = await apiCall('/api/v1/pricing/quote', {
        method: 'POST',
        token: custAToken,
        body: {
          merchantId,
          items: [{ productId: prodA.id, quantity: 2 }],
          placeOfSupplyStateCode: '29',
          distanceKm: 2,
        },
      });
      assert.strictEqual(intraQuote.status, 200);
      assert.strictEqual(intraQuote.data.quote.isInterState, false);
      assert.strictEqual(intraQuote.data.quote.sellerGoodsBreakdown.cgstAmount, intraQuote.data.quote.sellerGoodsBreakdown.sgstAmount);
      assert.strictEqual(Number(intraQuote.data.quote.sellerGoodsBreakdown.igstAmount), 0);

      // Invalid state code '99' -> 422 fail closed (never falls back to '29')
      const badStateRes = await apiCall('/api/v1/pricing/quote', {
        method: 'POST',
        token: custAToken,
        body: {
          merchantId,
          items: [{ productId: prodA.id, quantity: 1 }],
          placeOfSupplyStateCode: '99',
        },
      });
      assert.strictEqual(badStateRes.status, 422);

      passedGroups++;
      console.log('✓ Group B Passed: Intra-State (CGST+SGST), Inter-State (IGST) & invalid state 422 verified.');
    }

    // =========================================================================
    // GROUP C: Promotions Engine, Conflict Groups, Stackability & Active Promotions API
    // =========================================================================
    console.log('\n[Group C] Testing Promotions (Slab/BOGO/Free-Delivery), Priority & Conflict Resolution...');
    {
      // Create 2 promotions in same conflict_group ('CART_PROMO') -> higher priority (lower number) wins
      const slabRes = await apiCall('/api/v1/admin/promotions', {
        method: 'POST',
        token: adminToken,
        body: {
          code: 'S16_SLAB_HIGH',
          title: 'Spend 500 Save 60',
          promotionType: 'CART_SLAB',
          slabRules: [{ minAmount: 500, discountType: 'FLAT_AMOUNT', discountValue: 60 }],
          minOrderValueInr: 500,
          priority: 10,
          conflictGroup: 'CART_PROMO',
          isStackable: true,
          stackableWithCoupons: true,
          fundingSource: 'PLATFORM',
        },
      });
      assert.strictEqual(slabRes.status, 201);

      const lowPrioRes = await apiCall('/api/v1/admin/promotions', {
        method: 'POST',
        token: adminToken,
        body: {
          code: 'S16_PCT_LOW',
          title: 'Conflicting 5% Off',
          promotionType: 'PERCENTAGE',
          discountValue: 5,
          minOrderValueInr: 100,
          priority: 50,
          conflictGroup: 'CART_PROMO',
          isStackable: true,
          stackableWithCoupons: true,
          fundingSource: 'SELLER',
        },
      });
      assert.strictEqual(lowPrioRes.status, 201);

      // Free Delivery promo in separate conflict group (applies when deliveryFee > 0, i.e., cart below ₹499 threshold)
      const freeDelRes = await apiCall('/api/v1/admin/promotions', {
        method: 'POST',
        token: adminToken,
        body: {
          code: 'S16_FREE_DEL',
          title: 'Free Delivery >= 100',
          promotionType: 'FREE_DELIVERY',
          minOrderValueInr: 100,
          priority: 20,
          conflictGroup: 'DELIVERY_PROMO',
          isStackable: true,
          stackableWithCoupons: true,
          fundingSource: 'PLATFORM',
        },
      });
      assert.strictEqual(freeDelRes.status, 201);

      // Active promotions endpoint lists them cleanly
      const activePromos = await apiCall('/api/v1/pricing/promotions/active');
      assert.strictEqual(activePromos.status, 200);
      assert.ok(activePromos.data.promotions.some((p: any) => p.code === 'S16_SLAB_HIGH'));

      // Sub-threshold cart (1 unit < 499): S16_FREE_DEL waives delivery charge!
      const freeDelQuote = await pricingEngine.calculate({
        merchantId,
        userId: custAId,
        items: [{ productId: prodA.id, quantity: 1 }],
        placeOfSupplyStateCode: '29',
        distanceKm: 3.5,
      });
      assert.ok(freeDelQuote.appliedPromotions.some((p) => p.code === 'S16_FREE_DEL'), 'FREE_DELIVERY must waive fee on sub-threshold cart');
      assert.ok(Number(freeDelQuote.deliveryDiscountAmount) > 0);

      // Multi-item quote >= 500: S16_SLAB_HIGH wins over S16_PCT_LOW!
      const quoteRes = await pricingEngine.calculate({
        merchantId,
        userId: custAId,
        items: [
          { productId: prodA.id, quantity: 3 },
          { productId: prodB.id, quantity: 2 },
        ],
        placeOfSupplyStateCode: '29',
        distanceKm: 3.5,
      });

      const appliedCodes = quoteRes.appliedPromotions.map((p) => p.code);
      assert.ok(appliedCodes.includes('S16_SLAB_HIGH'), 'Higher-priority conflict-group winner must apply');
      assert.ok(!appliedCodes.includes('S16_PCT_LOW'), 'Lower-priority conflicting promotion must be suppressed');

      // Verify exact total identity: sum(lineTotals) + sum(charges) === grandTotal and no negative taxable values
      let lineSum = '0.00';
      for (const li of quoteRes.items) {
        assert.ok(Number(li.taxableAmount) >= 0);
        assert.ok(Number(li.discountAmount) <= Number(li.inclusiveGrossAmount));
        lineSum = roundCurrency(add(lineSum, li.lineTotal));
      }
      let chargeSum = '0.00';
      for (const ch of quoteRes.charges) {
        chargeSum = roundCurrency(add(chargeSum, ch.totalAmount));
      }
      assert.strictEqual(roundCurrency(add(lineSum, chargeSum)), quoteRes.grandTotal);

      // Disable test promos before Group D so coupons test cleanly without promo interference unless needed
      await apiCall(`/api/v1/admin/promotions/${slabRes.data.promotion.id}`, {
        method: 'PATCH',
        token: adminToken,
        body: { isActive: false },
      });
      await apiCall(`/api/v1/admin/promotions/${lowPrioRes.data.promotion.id}`, {
        method: 'PATCH',
        token: adminToken,
        body: { isActive: false },
      });
      await apiCall(`/api/v1/admin/promotions/${freeDelRes.data.promotion.id}`, {
        method: 'PATCH',
        token: adminToken,
        body: { isActive: false },
      });

      passedGroups++;
      console.log('✓ Group C Passed: Promotion priority, conflict groups, free delivery, and line-item discount allocation verified.');
    }

    // =========================================================================
    // GROUP D: Coupon Lifecycle, Concurrent 10-Way Race, Cancellation Release & Validate API
    // =========================================================================
    console.log('\n[Group D] Testing Coupon Rules, Concurrent Redemption Limit Race & Cancellation Release...');
    {
      // Coupon with global usage_limit = 3, per_user_limit = 5, 50/50 SHARED funding
      const raceCouponRes = await apiCall('/api/v1/admin/coupons', {
        method: 'POST',
        token: adminToken,
        body: {
          code: 'S16RACE3',
          title: 'Race Test Shared Coupon',
          discountType: 'FLAT_AMOUNT',
          discountValue: 50,
          minOrderValueInr: 100,
          usageLimit: 3,
          perUserLimit: 5,
          fundingSource: 'SHARED',
          sellerSharePercent: 50,
        },
      });
      assert.strictEqual(raceCouponRes.status, 201);

      // Validate endpoint preview
      const valRes = await apiCall('/api/v1/pricing/coupons/validate', {
        method: 'POST',
        token: custAToken,
        body: {
          merchantId,
          items: [{ productId: prodA.id, quantity: 2 }],
          couponCode: 'S16RACE3',
          placeOfSupplyStateCode: '29',
        },
      });
      assert.strictEqual(valRes.status, 200);
      assert.strictEqual(valRes.data.valid, true);
      assert.strictEqual(valRes.data.appliedCoupon.sellerShareAmount, '25.00');
      assert.strictEqual(valRes.data.appliedCoupon.platformShareAmount, '25.00');

      // Fire 10 simultaneous COD orders attempting S16RACE3 -> strictly 3 succeed, 7 rejected!
      const racePromises = Array.from({ length: 10 }, (_, idx) =>
        orderService.createOrder({
          userId: custAId,
          merchantId,
          items: [{ productId: prodA.id, quantity: 1 }],
          couponCode: 'S16RACE3',
          placeOfSupplyStateCode: '29',
          jobSite: { address: `Race Site ${idx}`, latitude: 12.935, longitude: 77.624 },
          paymentMethod: 'Pay on Delivery',
          idempotencyKey: `s16_race_ord_${idx}_${Date.now()}`,
        })
      );
      const settled = await Promise.allSettled(racePromises);
      const fulfilled = settled.filter((r) => r.status === 'fulfilled') as Array<PromiseFulfilledResult<any>>;
      const rejected = settled.filter((r) => r.status === 'rejected');
      assert.strictEqual(fulfilled.length, 3, 'Strictly 3 of 10 concurrent checkouts may redeem usage_limit=3 coupon');
      assert.strictEqual(rejected.length, 7);

      const cUsageRow = (await pool.query(`SELECT usage_count FROM coupons WHERE code = 'S16RACE3'`)).rows[0];
      assert.strictEqual(Number(cUsageRow.usage_count), 3);

      // Cancel 1 of the 3 winning orders -> usage_count decrements from 3 to 2 and ledger becomes RELEASED!
      const orderToCancel = fulfilled[0].value.order;
      await cancellationService.cancelByCustomer({
        orderId: orderToCancel.id,
        userId: custAId,
        reason: 'Changed mind',
      });
      const cUsagePostCancel = (await pool.query(`SELECT usage_count FROM coupons WHERE code = 'S16RACE3'`)).rows[0];
      assert.strictEqual(Number(cUsagePostCancel.usage_count), 2);
      const redStatus = (
        await pool.query(`SELECT status FROM coupon_redemptions WHERE order_id = $1`, [orderToCancel.id])
      ).rows[0];
      assert.strictEqual(redStatus.status, 'RELEASED');

      // First-order-only coupon check: Customer A already has orders -> blocked; Customer B succeeds
      const firstOrdRes = await apiCall('/api/v1/admin/coupons', {
        method: 'POST',
        token: adminToken,
        body: {
          code: 'FIRST50',
          title: 'First Order Only',
          discountType: 'FLAT_AMOUNT',
          discountValue: 50,
          minOrderValueInr: 100,
          firstOrderOnly: true,
          fundingSource: 'PLATFORM',
        },
      });
      assert.strictEqual(firstOrdRes.status, 201);

      const failFirstA = await apiCall('/api/v1/pricing/coupons/validate', {
        method: 'POST',
        token: custAToken,
        body: {
          merchantId,
          items: [{ productId: prodA.id, quantity: 2 }],
          couponCode: 'FIRST50',
          placeOfSupplyStateCode: '29',
        },
      });
      assert.strictEqual(failFirstA.status, 422);

      const okFirstB = await apiCall('/api/v1/pricing/coupons/validate', {
        method: 'POST',
        token: custBToken,
        body: {
          merchantId,
          items: [{ productId: prodA.id, quantity: 2 }],
          couponCode: 'FIRST50',
          placeOfSupplyStateCode: '29',
        },
      });
      assert.strictEqual(okFirstB.status, 200);
      assert.strictEqual(okFirstB.data.valid, true);

      passedGroups++;
      console.log('✓ Group D Passed: Coupon limits, 10-way concurrent race, cancellation release, and first-order check verified.');
    }

    // =========================================================================
    // GROUP E: DB-Backed Cart & Checkout Price Drift 409 PRICE_CHANGED / QUOTE_EXPIRED
    // =========================================================================
    console.log('\n[Group E] Testing Persistent DB Cart & Checkout 409 PRICE_CHANGED / QUOTE_EXPIRED...');
    {
      const addItem = await apiCall('/api/v1/cart/items', {
        method: 'POST',
        token: custBToken,
        body: { merchantId, productId: prodA.id, quantity: 2, placeOfSupplyStateCode: '29' },
      });
      assert.strictEqual(addItem.status, 200);
      assert.strictEqual(addItem.data.cart.items.length, 1);

      const applyCpn = await apiCall('/api/v1/cart/coupon', {
        method: 'POST',
        token: custBToken,
        body: { merchantId, couponCode: 'FIRST50' },
      });
      assert.strictEqual(applyCpn.status, 200);
      const quotedTotal = Number(applyCpn.data.cart.quote.grandTotal);
      const quoteId = applyCpn.data.cart.quote.quoteId;

      // Price increases in store_inventory BEFORE checkout -> expectedTotal mismatch returns 409 PRICE_CHANGED
      const oldPrice = Number(prodA.selling_price);
      await pool.query(
        `UPDATE store_inventory SET selling_price = $1 WHERE merchant_id = $2 AND product_id = $3`,
        [oldPrice + 25, merchantId, prodA.id]
      );

      const cartDriftView = await apiCall(`/api/v1/cart?merchantId=${merchantId}`, { token: custBToken });
      assert.strictEqual(cartDriftView.status, 200);
      assert.strictEqual(cartDriftView.data.cart.priceChanges.length, 1);

      const staleCheckout = await apiCall('/api/v1/orders/create', {
        method: 'POST',
        token: custBToken,
        body: {
          merchantId,
          items: [{ productId: prodA.id, quantity: 2 }],
          couponCode: 'FIRST50',
          placeOfSupplyStateCode: '29',
          expectedTotal: quotedTotal,
          paymentMethod: 'Pay on Delivery',
          jobSite: { address: 'Cart Drift Site', latitude: 12.935, longitude: 77.624 },
        },
      });
      assert.strictEqual(staleCheckout.status, 409);
      assert.strictEqual(staleCheckout.data.error, 'PRICE_CHANGED');

      // Expired quoteId also returns 409 QUOTE_EXPIRED
      await pool.query(
        `UPDATE pricing_calculation_snapshots SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`,
        [quoteId]
      );
      const expCheckout = await apiCall('/api/v1/orders/create', {
        method: 'POST',
        token: custBToken,
        body: {
          merchantId,
          items: [{ productId: prodA.id, quantity: 2 }],
          couponCode: 'FIRST50',
          placeOfSupplyStateCode: '29',
          quoteId,
          paymentMethod: 'Pay on Delivery',
          jobSite: { address: 'Expired Quote Site', latitude: 12.935, longitude: 77.624 },
        },
      });
      assert.strictEqual(expCheckout.status, 409);
      assert.strictEqual(expCheckout.data.error, 'QUOTE_EXPIRED');

      // Restore original selling price cleanly
      await pool.query(
        `UPDATE store_inventory SET selling_price = $1 WHERE merchant_id = $2 AND product_id = $3`,
        [oldPrice, merchantId, prodA.id]
      );

      passedGroups++;
      console.log('✓ Group E Passed: DB cart, live price-change detection, and 409 PRICE_CHANGED/QUOTE_EXPIRED verified.');
    }

    // =========================================================================
    // GROUP F: Prorated Partial & Full Returns, Credit Notes, Honest IRN & Dynamic Indian FY
    // =========================================================================
    console.log('\n[Group F] Testing Partial/Full Return Prorated GST/Discount Refunds, Credit Notes & Indian FY...');
    {
      // Assert Indian Financial Year helper boundaries dynamically (Jan-Mar -> prior year start, Apr-Dec -> current year start)
      assert.strictEqual(computeIndianFinancialYear('2026-03-31T10:00:00Z'), '2025-26');
      assert.strictEqual(computeIndianFinancialYear('2026-04-01T10:00:00Z'), '2026-27');

      // Customer B places Instant UPI order with quantity 2 of prodA using FIRST50 coupon
      const ordRes = await orderService.createOrder({
        userId: custBId,
        merchantId,
        items: [{ productId: prodA.id, quantity: 2 }],
        couponCode: 'FIRST50',
        placeOfSupplyStateCode: '29',
        paymentMethod: 'Instant UPI',
        jobSite: { address: 'Return Site', latitude: 12.935, longitude: 77.624 },
        idempotencyKey: `s16_ret_ord_${Date.now()}`,
      });
      const ord = ordRes.order;

      // Record UPI payment and mark delivered + settle allocation so return flow runs end-to-end
      await ledgerService.recordOrderPayment({
        orderId: ord.id,
        merchantId,
        grossAmount: ord.totalAmount,
        taxableAmount: ord.taxableAmount,
        cgstAmount: ord.cgstAmount,
        sgstAmount: ord.sgstAmount,
        deliveryFee: ord.deliveryFee,
        handlingFee: ord.handlingFee,
      });
      await transaction(async (txClient) => {
        await couponPromotionService.markRedeemedForOrder(txClient, ord.id);
      });
      await pool.query(
        `UPDATE orders SET status = 'delivered', payment_status = 'PAID', delivered_at = NOW() WHERE id = $1`,
        [ord.id]
      );
      await settlementAllocationService.allocateFulfilledOrder(ord.id);

      // Verify GST Invoice carries honest null IRN & NOT_APPLICABLE when EINVOICING_ENABLED=false
      const invRes = await apiCall(`/api/v1/invoices/order/${ord.id}`, { token: custBToken });
      assert.strictEqual(invRes.status, 200);
      const sellerInv = invRes.data.invoices.find((i: any) => i.invoiceType === 'SELLER_TAX_INVOICE');
      assert.ok(sellerInv);
      assert.strictEqual(sellerInv.irn, null);
      assert.strictEqual(sellerInv.eInvoicingStatus, 'NOT_APPLICABLE');

      const orderItemRow = (await pool.query(`SELECT * FROM order_items WHERE order_id = $1 LIMIT 1`, [ord.id])).rows[0];
      const lineTotalPaid = Number(orderItemRow.line_total_payable ?? orderItemRow.total_price);

      // Request & QC-accept PARTIAL return: 1 out of 2 units
      const ret1 = await returnService.requestReturn({
        orderId: ord.id,
        userId: custBId,
        items: [{ orderItemId: orderItemRow.id, quantity: 1 }],
        reasonCode: 'DEFECTIVE',
      });
      await returnService.reviewReturn({ returnId: ret1.returnRequest.id, merchantId, action: 'APPROVE' });
      await returnService.receiveAtStore({ returnId: ret1.returnRequest.id, merchantId });
      const qc1 = await returnService.qcInspectAndResolve({
        returnId: ret1.returnRequest.id,
        merchantId,
        itemDecisions: [{ returnItemId: ret1.returnRequest.items[0].id, qcPassed: true }],
      });

      const refund1Amt = Number(qc1.refund!.amount);
      const expectedHalf = Number(roundCurrency(lineTotalPaid / 2));
      assert.ok(Math.abs(refund1Amt - expectedHalf) <= 0.01, `Partial return must refund discounted tax-inclusive 1/2 (~₹${expectedHalf}), got ₹${refund1Amt}`);

      const midOrdRow = (await pool.query(`SELECT status FROM orders WHERE id = $1`, [ord.id])).rows[0];
      assert.strictEqual(midOrdRow.status, 'partially_returned');

      // Attempting to return qty 2 when 1 already returned -> rejected!
      await assert.rejects(
        () =>
          returnService.requestReturn({
            orderId: ord.id,
            userId: custBId,
            items: [{ orderItemId: orderItemRow.id, quantity: 2 }],
            reasonCode: 'DEFECTIVE',
          }),
        /RETURN_QUANTITY_EXCEEDED/
      );

      // Return remaining 1 unit -> order transitions to 'returned', total refunds equal exact lineTotalPaid, coupon REVERSED!
      const ret2 = await returnService.requestReturn({
        orderId: ord.id,
        userId: custBId,
        items: [{ orderItemId: orderItemRow.id, quantity: 1 }],
        reasonCode: 'DEFECTIVE',
      });
      await returnService.reviewReturn({ returnId: ret2.returnRequest.id, merchantId, action: 'APPROVE' });
      await returnService.receiveAtStore({ returnId: ret2.returnRequest.id, merchantId });
      const qc2 = await returnService.qcInspectAndResolve({
        returnId: ret2.returnRequest.id,
        merchantId,
        itemDecisions: [{ returnItemId: ret2.returnRequest.items[0].id, qcPassed: true }],
      });
      const totalRefunded = Number(roundCurrency(refund1Amt + Number(qc2.refund!.amount)));
      assert.strictEqual(totalRefunded, Number(roundCurrency(lineTotalPaid)), 'Cumulative partial+full refund must match discounted tax-inclusive item total');

      const finalOrdRow = (await pool.query(`SELECT status FROM orders WHERE id = $1`, [ord.id])).rows[0];
      assert.strictEqual(finalOrdRow.status, 'returned');

      // Fetch generated GST Credit Notes via API (JSON and printable text)
      const cnJsonRes = await apiCall(`/api/v1/invoices/order/${ord.id}/credit-notes`, { token: custBToken });
      assert.strictEqual(cnJsonRes.status, 200);
      assert.strictEqual(cnJsonRes.data.creditNotes.length, 2, 'Two return resolutions must yield 2 formal GST credit notes');
      const cnSum = cnJsonRes.data.creditNotes.reduce((acc: number, c: any) => acc + Number(c.totalAmount), 0);
      assert.strictEqual(roundCurrency(cnSum), roundCurrency(lineTotalPaid));

      const cnTextRes = await apiCall(`/api/v1/invoices/order/${ord.id}/credit-notes/text`, { token: custBToken });
      assert.strictEqual(cnTextRes.status, 200);
      assert.match(String(cnTextRes.data.raw || ''), /CREDIT NOTE/i);

      passedGroups++;
      console.log('✓ Group F Passed: Prorated partial/full returns, credit notes, coupon reversal, honest IRN & Indian FY verified.');
    }

    // =========================================================================
    // GROUP G: GL Account 5040 (Platform Subsidy) & Balanced Settlement Allocation
    // =========================================================================
    console.log('\n[Group G] Testing COA 5040 Discount Subsidy Accounting & Trial Balance Identity...');
    {
      // Verify COA 5040 exists
      const acc5040 = await pool.query(`SELECT account_code, category, normal_balance FROM general_ledger_accounts WHERE account_code = '5040'`);
      assert.strictEqual(acc5040.rowCount, 1);
      assert.strictEqual(acc5040.rows[0].category, 'EXPENSE');

      // Verify trial balance across all GL entries equals exactly 0.00 difference
      const tbRes = await pool.query(`
        SELECT
          COALESCE(SUM(CASE WHEN entry_side = 'DEBIT' THEN amount ELSE 0 END), 0) AS debits,
          COALESCE(SUM(CASE WHEN entry_side = 'CREDIT' THEN amount ELSE 0 END), 0) AS credits
        FROM general_ledger_entries
      `);
      const debits = roundCurrency(tbRes.rows[0].debits);
      const credits = roundCurrency(tbRes.rows[0].credits);
      assert.strictEqual(debits, credits, `GL trial balance mismatch: DR ${debits} != CR ${credits}`);

      // Verify fulfillment batch containing DR 5040 was posted for FIRST50 platform-funded order
      const subGlRes = await pool.query(
        `SELECT SUM(amount) AS amt FROM general_ledger_entries WHERE account_code = '5040' AND entry_side = 'DEBIT'`
      );
      assert.ok(Number(subGlRes.rows[0].amt) >= 50, 'Platform-funded discount must post DEBIT to COA 5040');

      passedGroups++;
      console.log(`✓ Group G Passed: COA 5040 debits & global trial balance parity (₹${debits} == ₹${credits}) verified.`);
    }

    // =========================================================================
    // GROUP H: Reconciliation Check 14, Admin Discount Report & RBAC Governance
    // =========================================================================
    console.log('\n[Group H] Testing Reconciliation Check 14 Discrepancies, Admin Discount Report & RBAC...');
    {
      // 1. Seed synthetic defects caught by Check 14:
      // 1a. Fake IRN on NOT_APPLICABLE invoice -> INVALID_FABRICATED_IRN
      const fakeInvId = crypto.randomUUID();
      const anyOrdId = (await pool.query(`SELECT id FROM orders LIMIT 1`)).rows[0].id;
      await pool.query(
        `INSERT INTO invoices (id, invoice_number, order_id, invoice_type, irn, e_invoicing_status, qr_data, taxable_amount, cgst_amount, sgst_amount, igst_amount, total_amount)
         VALUES ($1, $2, $3, 'SELLER_TAX_INVOICE', $4, 'NOT_APPLICABLE', 'qr', 100, 9, 9, 0, 118)`,
        [fakeInvId, `INV-FAKE-${Date.now()}`, anyOrdId, 'a'.repeat(64)]
      );

      // 1b. Coupon usage_count drift -> COUPON_USAGE_COUNT_DRIFT
      await pool.query(`UPDATE coupons SET usage_count = usage_count + 5 WHERE code = 'S16RACE3'`);

      const reconRes = await paymentReconciliationService.runReconciliation({ triggeredBy: adminUserId });
      const cats = reconRes.discrepancies.map((d) => d.category);
      assert.ok(cats.includes('INVALID_FABRICATED_IRN'), 'Check 14C must flag fabricated IRN when e_invoicing_status=NOT_APPLICABLE');
      assert.ok(cats.includes('COUPON_USAGE_COUNT_DRIFT'), 'Check 14D must flag coupon usage_count drift vs active ledger');

      // Clean synthetic defects
      await pool.query(`DELETE FROM invoices WHERE id = $1`, [fakeInvId]);
      await pool.query(`UPDATE coupons SET usage_count = usage_count - 5 WHERE code = 'S16RACE3'`);

      // 2. Admin Discount Funding Report + RBAC check (customer blocked 403)
      const custBlock = await apiCall('/api/v1/admin/discounts/report', { token: custAToken });
      assert.strictEqual(custBlock.status, 403);

      const repRes = await apiCall('/api/v1/admin/discounts/report', { token: adminToken });
      assert.strictEqual(repRes.status, 200);
      assert.ok(repRes.data.report.coupons && repRes.data.report.coupons.total_discount !== undefined);
      assert.ok(repRes.data.report.promotions && repRes.data.report.promotions.total_discount !== undefined);

      // Verify audit log captured coupon/promo admin mutations
      const auditRes = await pool.query(
        `SELECT action FROM audit_logs WHERE action IN ('COUPON_CREATED', 'PROMOTION_CREATED')`
      );
      assert.ok(auditRes.rowCount! >= 2);

      passedGroups++;
      console.log('✓ Group H Passed: Check 14 discrepancies, Admin RBAC, Audit Logs & Discount Funding Report verified.');
    }

    assert.strictEqual(passedGroups, 8);
    console.log(`\n✓ ALL ${passedGroups}/8 SPRINT 16.0 PRICING, GST, COUPONS & PROMOTION GROUPS PASSED!\n`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    setPool(null);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSprint16_0PricingGstCouponsPromotionsTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ Sprint 16.0 suite failed:', err);
      process.exit(1);
    });
}
