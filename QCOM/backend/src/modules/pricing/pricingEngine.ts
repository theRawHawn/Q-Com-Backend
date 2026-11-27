import pg from 'pg';
import { v4 as uuidv4 } from 'uuid';
import BigNumber from 'bignumber.js';
import { getPool } from '../../database/connection.js';
import {
  PricingEngineInput,
  PricingQuote,
  PricingLineItem,
  PricingCharge,
  DeliveryPricingRuleRecord,
} from './pricingTypes.js';
import {
  toDecimal,
  roundCurrency,
  multiply,
  add,
  subtract,
  max,
  ROUNDING_POLICY,
  CURRENCY_CODE,
} from './money.js';
import { taxEngine, TaxEngineError } from './taxEngine.js';
import { couponPromotionService, CouponPromotionError } from './couponPromotionService.js';

export const PRICING_ENGINE_VERSION = '3.0.0';
export const QUOTE_TTL_MINUTES = 15;

export class PricingEngineError extends Error {
  code: string;
  statusCode: number;

  constructor(code: string, message: string, statusCode: number = 400) {
    super(message);
    this.name = 'PricingEngineError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class PricingEngine {
  readonly version = PRICING_ENGINE_VERSION;

  private calculateDistanceKm(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number
  ): number {
    const toRad = (deg: number) => (deg * Math.PI) / 180;
    const R = 6371;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return Number((R * c).toFixed(2));
  }

  async resolveDeliveryRule(
    transactionDate: Date = new Date(),
    poolOverride?: pg.Pool | pg.PoolClient
  ): Promise<DeliveryPricingRuleRecord> {
    const runner = poolOverride || getPool();
    const dateStr = transactionDate.toISOString().split('T')[0];

    const res = await runner.query(
      `SELECT id, rule_code, name, base_distance_km, base_fee_inr, per_km_fee_inr,
              free_delivery_threshold_inr, handling_fee_inr, platform_fee_inr,
              effective_from, effective_to
         FROM pricing_delivery_rules
        WHERE is_active = TRUE
          AND effective_from <= $1::date
          AND (effective_to IS NULL OR effective_to >= $1::date)
        ORDER BY effective_from DESC
        LIMIT 1`,
      [dateStr]
    );

    if (res.rows.length === 0) {
      throw new PricingEngineError(
        'DELIVERY_RULE_NOT_FOUND',
        `No active delivery pricing rule found for transaction date ${dateStr}. Please configure delivery slabs in pricing_delivery_rules table.`,
        422
      );
    }

    const row = res.rows[0];
    return {
      id: row.id,
      rule_code: row.rule_code,
      name: row.name,
      base_distance_km: toDecimal(row.base_distance_km).toFixed(2),
      base_fee_inr: toDecimal(row.base_fee_inr).toFixed(2),
      per_km_fee_inr: toDecimal(row.per_km_fee_inr).toFixed(2),
      free_delivery_threshold_inr: row.free_delivery_threshold_inr
        ? toDecimal(row.free_delivery_threshold_inr).toFixed(2)
        : null,
      handling_fee_inr: toDecimal(row.handling_fee_inr).toFixed(2),
      platform_fee_inr: toDecimal(row.platform_fee_inr).toFixed(2),
      effective_from: row.effective_from,
      effective_to: row.effective_to,
    };
  }

  async calculate(
    input: PricingEngineInput,
    poolOverride?: pg.Pool | pg.PoolClient
  ): Promise<PricingQuote> {
    const runner = poolOverride || getPool();
    const txnDate = input.transactionDate
      ? new Date(input.transactionDate)
      : new Date();

    if (isNaN(txnDate.getTime())) {
      throw new PricingEngineError('INVALID_TRANSACTION_DATE', 'Invalid transaction date provided.', 400);
    }

    // 1. Validate Input
    if (!input.merchantId || typeof input.merchantId !== 'string') {
      throw new PricingEngineError('MISSING_MERCHANT_ID', 'Valid merchantId is required.', 400);
    }

    if (!Array.isArray(input.items) || input.items.length === 0) {
      throw new PricingEngineError('EMPTY_CART', 'Cart must contain at least one line item.', 400);
    }

    if (input.distanceKm !== undefined && input.distanceKm !== null) {
      const distNum = Number(input.distanceKm);
      if (!Number.isFinite(distNum) || distNum < 0) {
        throw new PricingEngineError('INVALID_DISTANCE', 'distanceKm must be a finite non-negative number.', 400);
      }
    }

    const mergedItemMap = new Map<string, { productId: string; quantity: number }>();
    for (const itm of input.items) {
      if (!itm.productId || typeof itm.productId !== 'string') {
        throw new PricingEngineError('INVALID_ITEM', 'Each line item must have a valid productId.', 400);
      }
      if (!Number.isInteger(itm.quantity) || itm.quantity <= 0) {
        throw new PricingEngineError('INVALID_QUANTITY', `Quantity for product '${itm.productId}' must be a positive integer.`, 400);
      }
      const prev = mergedItemMap.get(itm.productId);
      const nextQty = (prev ? prev.quantity : 0) + itm.quantity;
      if (nextQty > 500) {
        throw new PricingEngineError('EXCESSIVE_QUANTITY', `Quantity for product '${itm.productId}' exceeds maximum order limit of 500.`, 400);
      }
      mergedItemMap.set(itm.productId, { productId: itm.productId, quantity: nextQty });
    }
    const normalizedItems = Array.from(mergedItemMap.values());

    // 2. Load Authoritative Merchant and Validate Statutory State Codes
    const merchRes = await runner.query(
      `SELECT m.id, m.merchant_code, m.name, m.business_name, m.state_code,
              m.latitude, m.longitude, m.pan_status, m.constitution_type, m.status,
              m.service_radius_meters
         FROM merchants m
        WHERE m.id = $1`,
      [input.merchantId]
    );

    if (merchRes.rows.length === 0) {
      throw new PricingEngineError('MERCHANT_NOT_FOUND', 'Specified merchant was not found.', 404);
    }

    const merchant = merchRes.rows[0];
    if (merchant.status !== 'ACTIVE') {
      throw new PricingEngineError('MERCHANT_NOT_ACTIVE', 'Merchant store is currently not active.', 422);
    }

    if (!merchant.state_code || String(merchant.state_code).trim() === '') {
      throw new PricingEngineError(
        'MISSING_MERCHANT_STATE_CODE',
        `Merchant '${merchant.merchant_code || merchant.id}' does not have a valid GST state code configured.`,
        422
      );
    }

    let merchantStateInfo: { code: string; name: string };
    let posResolution: { stateCode: string; stateName: string; source: string };
    try {
      merchantStateInfo = await taxEngine.validateStateCode(merchant.state_code, runner);
      posResolution = await taxEngine.resolvePlaceOfSupply(
        {
          explicitStateCode: input.placeOfSupplyStateCode,
          customerGstin: input.customerGstin,
          deliveryAddressId: input.deliveryAddressId,
          userId: input.userId,
          merchantStateCode: merchantStateInfo.code,
        },
        runner
      );
    } catch (err) {
      if (err instanceof TaxEngineError) {
        throw new PricingEngineError(err.code, err.message, err.statusCode);
      }
      throw err;
    }

    const merchantStateCode = merchantStateInfo.code;
    const placeOfSupplyStateCode = posResolution.stateCode;
    const isInterState = merchantStateCode !== placeOfSupplyStateCode;

    // Resolve Store
    let storeId = input.storeId;
    if (!storeId) {
      const storeRes = await runner.query(
        `SELECT id FROM merchant_stores WHERE merchant_id = $1 ORDER BY is_primary DESC LIMIT 1`,
        [input.merchantId]
      );
      if (storeRes.rows.length > 0) {
        storeId = storeRes.rows[0].id;
      }
    }

    // 3. Load Authoritative Product Data, Inventory, and Verified Tax Classification (ZERO TRUST)
    const productIds = normalizedItems.map(i => i.productId);
    const prodRes = await runner.query(
      `SELECT p.id as product_id, p.sku, p.name, p.category, p.hsn_code, p.gst_rate_percent,
              si.selling_price, si.original_mrp, si.stock_count, si.reserved_count, si.is_available
         FROM store_inventory si
         JOIN products p ON p.id = si.product_id
        WHERE si.merchant_id = $1
          AND si.product_id = ANY($2::uuid[])`,
      [input.merchantId, productIds]
    );

    const productMap = new Map<string, any>();
    prodRes.rows.forEach(r => productMap.set(r.product_id, r));

    const sellerTaxMap = new Map<string, Awaited<ReturnType<typeof taxEngine.resolveSellerProductTax>>>();
    let grossCatalogTotalBn = new BigNumber(0);

    for (const itm of normalizedItems) {
      if (!productMap.has(itm.productId)) {
        throw new PricingEngineError(
          'PRODUCT_NOT_AVAILABLE',
          `Product '${itm.productId}' is not carried or configured in this merchant's catalog.`,
          404
        );
      }
      const p = productMap.get(itm.productId);
      if (!p.is_available) {
        throw new PricingEngineError('PRODUCT_UNAVAILABLE', `Product '${p.name}' is currently marked unavailable.`, 422);
      }
      const stockCount = Number(p.stock_count);
      const reservedCount = Number(p.reserved_count || 0);
      const available = stockCount - reservedCount;
      if (available < itm.quantity) {
        throw new PricingEngineError(
          'INSUFFICIENT_STOCK',
          `INSUFFICIENT_STOCK: Insufficient stock for '${p.name}'. Requested ${itm.quantity}, but only ${Math.max(0, available)} available. Please reduce quantity or remove item.`,
          422
        );
      }

      try {
        const sellerTax = await taxEngine.resolveSellerProductTax(
          itm.productId,
          input.merchantId,
          txnDate,
          runner
        );
        sellerTaxMap.set(itm.productId, sellerTax);
      } catch (err) {
        if (err instanceof TaxEngineError) {
          throw new PricingEngineError(err.code, err.message, err.statusCode);
        }
        throw err;
      }

      grossCatalogTotalBn = grossCatalogTotalBn.plus(multiply(toDecimal(p.selling_price), itm.quantity));
    }

    // 4. Resolve Logistics & Distance BEFORE evaluating FREE_DELIVERY promotions
    const deliveryRule = await this.resolveDeliveryRule(txnDate, runner);

    let distanceKm: number;
    if (input.distanceKm !== undefined) {
      distanceKm = Number(toDecimal(input.distanceKm).toFixed(2));
    } else if (input.customerLocation && merchant.latitude && merchant.longitude) {
      distanceKm = this.calculateDistanceKm(
        Number(merchant.latitude),
        Number(merchant.longitude),
        input.customerLocation.latitude,
        input.customerLocation.longitude
      );
    } else if (input.userId && merchant.latitude && merchant.longitude) {
      const addrQuery = input.deliveryAddressId
        ? await runner.query(
            `SELECT latitude, longitude FROM saved_addresses WHERE id = $1 AND user_id = $2 AND latitude IS NOT NULL AND longitude IS NOT NULL LIMIT 1`,
            [input.deliveryAddressId, input.userId]
          )
        : await runner.query(
            `SELECT latitude, longitude FROM saved_addresses WHERE user_id = $1 AND latitude IS NOT NULL AND longitude IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
            [input.userId]
          );
      if (addrQuery.rows.length > 0 && addrQuery.rows[0].latitude && addrQuery.rows[0].longitude) {
        distanceKm = this.calculateDistanceKm(
          Number(merchant.latitude),
          Number(merchant.longitude),
          Number(addrQuery.rows[0].latitude),
          Number(addrQuery.rows[0].longitude)
        );
      } else {
        distanceKm = toDecimal(deliveryRule.base_distance_km).toNumber();
      }
    } else {
      distanceKm = toDecimal(deliveryRule.base_distance_km).toNumber();
    }

    const baseDist = toDecimal(deliveryRule.base_distance_km);
    const baseFee = toDecimal(deliveryRule.base_fee_inr);
    const perKmFee = toDecimal(deliveryRule.per_km_fee_inr);

    let rawDeliveryTaxableBn = baseFee;
    if (distanceKm > baseDist.toNumber()) {
      const excessDistRaw = distanceKm - baseDist.toNumber();
      const excessDistRounded = Math.ceil(excessDistRaw * 10) / 10;
      rawDeliveryTaxableBn = add(rawDeliveryTaxableBn, multiply(excessDistRounded, perKmFee));
    }

    if (deliveryRule.free_delivery_threshold_inr) {
      const threshold = toDecimal(deliveryRule.free_delivery_threshold_inr);
      if (grossCatalogTotalBn.isGreaterThanOrEqualTo(threshold)) {
        rawDeliveryTaxableBn = new BigNumber(0);
      }
    }

    // 5. Evaluate Automatic Promotions & Explicit Coupons with Eligibility, Stackability, and Conflict Control
    let discountEval: Awaited<ReturnType<typeof couponPromotionService.evaluateQuoteDiscounts>>;
    try {
      discountEval = await couponPromotionService.evaluateQuoteDiscounts(
        {
          merchantId: input.merchantId,
          userId: input.userId,
          items: normalizedItems.map((itm) => {
            const p = productMap.get(itm.productId);
            return {
              productId: itm.productId,
              category: p.category || '',
              quantity: itm.quantity,
              unitPrice: p.selling_price,
            };
          }),
          deliveryFeeTaxable: rawDeliveryTaxableBn,
          couponCode: input.couponCode,
          transactionDate: txnDate,
          isFirstOrderOverride: input.isFirstOrderOverride,
        },
        runner
      );
    } catch (err) {
      if (err instanceof CouponPromotionError) {
        throw new PricingEngineError(err.code, err.message, err.statusCode);
      }
      throw err;
    }

    // 6. Compute Line Item GST & Cess (Post-Discount, supporting Tax-Inclusive & Tax-Exclusive + All Tax Categories)
    const calculatedItems: PricingLineItem[] = [];
    let preDiscountTaxableSubtotalBn = new BigNumber(0);
    let totalItemDiscountTaxableBn = new BigNumber(0);

    for (let idx = 0; idx < normalizedItems.length; idx++) {
      const itm = normalizedItems[idx];
      const p = productMap.get(itm.productId);
      const cand = discountEval.items[idx];
      const sellerTax = sellerTaxMap.get(itm.productId)!;

      const unitPriceBn = toDecimal(p.selling_price);
      const grossCatalogLineBn = cand.grossLine;
      const netCatalogLineBn = cand.remainingLine;
      const inclusiveDiscBn = subtract(grossCatalogLineBn, netCatalogLineBn);

      if (sellerTax.taxInclusive) {
        const preDiscExtract = taxEngine.extractInclusiveBaseAndTaxes({
          inclusiveGross: grossCatalogLineBn,
          gstRatePercent: sellerTax.gstRatePercent,
          cessRatePercent: sellerTax.cessRatePercent,
          taxCategory: sellerTax.taxCategory,
          merchantStateCode,
          placeOfSupplyStateCode,
        });

        const postDiscExtract = taxEngine.extractInclusiveBaseAndTaxes({
          inclusiveGross: netCatalogLineBn,
          gstRatePercent: sellerTax.gstRatePercent,
          cessRatePercent: sellerTax.cessRatePercent,
          taxCategory: sellerTax.taxCategory,
          merchantStateCode,
          placeOfSupplyStateCode,
        });

        const preTaxDiscountBn = max(subtract(preDiscExtract.taxableAmount, postDiscExtract.taxableAmount), 0);

        preDiscountTaxableSubtotalBn = add(preDiscountTaxableSubtotalBn, preDiscExtract.taxableAmount);
        totalItemDiscountTaxableBn = add(totalItemDiscountTaxableBn, preTaxDiscountBn);

        calculatedItems.push({
          productId: itm.productId,
          productName: p.name,
          sku: p.sku,
          category: p.category,
          hsnCode: sellerTax.hsnCode,
          quantity: itm.quantity,
          unitPrice: roundCurrency(unitPriceBn),
          grossAmount: preDiscExtract.taxableAmount,
          inclusiveGrossAmount: roundCurrency(grossCatalogLineBn),
          discountAmount: roundCurrency(preTaxDiscountBn),
          inclusiveDiscountAmount: roundCurrency(inclusiveDiscBn),
          taxableAmount: postDiscExtract.taxableAmount,
          taxCategory: sellerTax.taxCategory,
          taxInclusive: true,
          taxBucket: 'SELLER_GOODS',
          taxRateSource: sellerTax.taxRateSource,
          gstRatePercent: postDiscExtract.gstRatePercent,
          cgstRatePercent: postDiscExtract.cgstRatePercent,
          cgstAmount: postDiscExtract.cgstAmount,
          sgstRatePercent: postDiscExtract.sgstRatePercent,
          sgstAmount: postDiscExtract.sgstAmount,
          igstRatePercent: postDiscExtract.igstRatePercent,
          igstAmount: postDiscExtract.igstAmount,
          cessRatePercent: postDiscExtract.cessRatePercent,
          cessAmount: postDiscExtract.cessAmount,
          totalGstAmount: postDiscExtract.totalGstAmount,
          totalTaxAmount: postDiscExtract.totalTaxWithCessAmount,
          lineTotal: postDiscExtract.inclusiveTotal,
          taxRuleId: sellerTax.ruleId,
          taxRuleCode: sellerTax.ruleCode,
          appliedDiscounts: cand.appliedDiscounts,
        });
      } else {
        const taxableAmtBn = netCatalogLineBn;
        const gstResult = taxEngine.calculateGst({
          taxableAmount: taxableAmtBn,
          taxRule: {
            gst_rate_percent: sellerTax.gstRatePercent,
            rule_code: sellerTax.ruleCode,
            id: sellerTax.ruleId,
          },
          cessRatePercent: sellerTax.cessRatePercent,
          taxCategory: sellerTax.taxCategory,
          merchantStateCode,
          placeOfSupplyStateCode,
        });

        const lineTotalBn = add(taxableAmtBn, gstResult.totalTaxWithCessAmount);

        preDiscountTaxableSubtotalBn = add(preDiscountTaxableSubtotalBn, grossCatalogLineBn);
        totalItemDiscountTaxableBn = add(totalItemDiscountTaxableBn, inclusiveDiscBn);

        calculatedItems.push({
          productId: itm.productId,
          productName: p.name,
          sku: p.sku,
          category: p.category,
          hsnCode: sellerTax.hsnCode,
          quantity: itm.quantity,
          unitPrice: roundCurrency(unitPriceBn),
          grossAmount: roundCurrency(grossCatalogLineBn),
          inclusiveGrossAmount: roundCurrency(grossCatalogLineBn),
          discountAmount: roundCurrency(inclusiveDiscBn),
          inclusiveDiscountAmount: roundCurrency(inclusiveDiscBn),
          taxableAmount: roundCurrency(taxableAmtBn),
          taxCategory: sellerTax.taxCategory,
          taxInclusive: false,
          taxBucket: 'SELLER_GOODS',
          taxRateSource: sellerTax.taxRateSource,
          gstRatePercent: gstResult.gstRatePercent,
          cgstRatePercent: gstResult.cgstRatePercent,
          cgstAmount: gstResult.cgstAmount,
          sgstRatePercent: gstResult.sgstRatePercent,
          sgstAmount: gstResult.sgstAmount,
          igstRatePercent: gstResult.igstRatePercent,
          igstAmount: gstResult.igstAmount,
          cessRatePercent: gstResult.cessRatePercent,
          cessAmount: gstResult.cessAmount,
          totalGstAmount: gstResult.totalGstAmount,
          totalTaxAmount: gstResult.totalTaxWithCessAmount,
          lineTotal: roundCurrency(lineTotalBn),
          taxRuleId: sellerTax.ruleId,
          taxRuleCode: sellerTax.ruleCode,
          appliedDiscounts: cand.appliedDiscounts,
        });
      }
    }

    // 7. Compute Final Service Charges (Delivery post FREE_DELIVERY promo + Handling + Platform)
    const deliveryDiscountBn = toDecimal(discountEval.deliveryDiscountAmount);
    const deliveryTaxableBn = max(subtract(rawDeliveryTaxableBn, deliveryDiscountBn), 0);

    const deliveryTaxRule = await taxEngine.resolveServiceTaxRule('DELIVERY_GST', txnDate, runner);
    const deliveryGst = taxEngine.calculateGst({
      taxableAmount: deliveryTaxableBn,
      taxRule: deliveryTaxRule,
      merchantStateCode,
      placeOfSupplyStateCode,
    });
    const deliveryTotalBn = add(deliveryTaxableBn, deliveryGst.totalGstAmount);

    const calculatedCharges: PricingCharge[] = [
      {
        chargeType: 'DELIVERY',
        description: `Express Delivery Fee (${distanceKm.toFixed(1)} km)`,
        grossTaxableAmount: roundCurrency(rawDeliveryTaxableBn),
        discountAmount: roundCurrency(deliveryDiscountBn),
        taxableAmount: roundCurrency(deliveryTaxableBn),
        taxBucket: 'QCOM_SERVICE_FEES',
        taxRateSource: 'QCOM_STATUTORY_RULE',
        sacCode: deliveryTaxRule.hsn_or_sac_code,
        gstRatePercent: deliveryGst.gstRatePercent,
        cgstAmount: deliveryGst.cgstAmount,
        sgstAmount: deliveryGst.sgstAmount,
        igstAmount: deliveryGst.igstAmount,
        taxAmount: deliveryGst.totalGstAmount,
        totalAmount: roundCurrency(deliveryTotalBn),
        taxRuleId: deliveryTaxRule.id,
      },
    ];

    const handlingTaxableBn = toDecimal(deliveryRule.handling_fee_inr);
    if (handlingTaxableBn.isGreaterThan(0)) {
      const handlingTaxRule = await taxEngine.resolveServiceTaxRule('HANDLING_GST', txnDate, runner);
      const handlingGst = taxEngine.calculateGst({
        taxableAmount: handlingTaxableBn,
        taxRule: handlingTaxRule,
        merchantStateCode,
        placeOfSupplyStateCode,
      });
      const handlingTotalBn = add(handlingTaxableBn, handlingGst.totalGstAmount);

      calculatedCharges.push({
        chargeType: 'HANDLING',
        description: 'Packaging & Platform Handling Fee',
        taxableAmount: roundCurrency(handlingTaxableBn),
        taxBucket: 'QCOM_SERVICE_FEES',
        taxRateSource: 'QCOM_STATUTORY_RULE',
        sacCode: handlingTaxRule.hsn_or_sac_code,
        gstRatePercent: handlingGst.gstRatePercent,
        cgstAmount: handlingGst.cgstAmount,
        sgstAmount: handlingGst.sgstAmount,
        igstAmount: handlingGst.igstAmount,
        taxAmount: handlingGst.totalGstAmount,
        totalAmount: roundCurrency(handlingTotalBn),
        taxRuleId: handlingTaxRule.id,
      });
    }

    // 8. Aggregate Totals — STRICT SEPARATION OF 3 TAX BUCKETS
    let totalItemsTaxableBn = new BigNumber(0);
    let sellerCgstBn = new BigNumber(0);
    let sellerSgstBn = new BigNumber(0);
    let sellerIgstBn = new BigNumber(0);
    let sellerCessBn = new BigNumber(0);

    for (const itm of calculatedItems) {
      totalItemsTaxableBn = totalItemsTaxableBn.plus(toDecimal(itm.taxableAmount));
      sellerCgstBn = sellerCgstBn.plus(toDecimal(itm.cgstAmount));
      sellerSgstBn = sellerSgstBn.plus(toDecimal(itm.sgstAmount));
      sellerIgstBn = sellerIgstBn.plus(toDecimal(itm.igstAmount));
      sellerCessBn = sellerCessBn.plus(toDecimal(itm.cessAmount));
    }
    const sellerGstBn = add(sellerCgstBn, sellerSgstBn, sellerIgstBn);
    const sellerTotalTaxWithCessBn = add(sellerGstBn, sellerCessBn);
    const totalSellerPayableBn = add(totalItemsTaxableBn, sellerTotalTaxWithCessBn);

    let qcomCgstBn = new BigNumber(0);
    let qcomSgstBn = new BigNumber(0);
    let qcomIgstBn = new BigNumber(0);
    let totalChargesAmountBn = new BigNumber(0);

    for (const chg of calculatedCharges) {
      totalChargesAmountBn = totalChargesAmountBn.plus(toDecimal(chg.totalAmount));
      qcomCgstBn = qcomCgstBn.plus(toDecimal(chg.cgstAmount));
      qcomSgstBn = qcomSgstBn.plus(toDecimal(chg.sgstAmount));
      qcomIgstBn = qcomIgstBn.plus(toDecimal(chg.igstAmount));
    }
    const qcomGstBn = add(qcomCgstBn, qcomSgstBn, qcomIgstBn);

    const totalCgstBn = add(sellerCgstBn, qcomCgstBn);
    const totalSgstBn = add(sellerSgstBn, qcomSgstBn);
    const totalIgstBn = add(sellerIgstBn, qcomIgstBn);
    const totalCessBn = sellerCessBn;
    const totalTaxBn = add(totalCgstBn, totalSgstBn, totalIgstBn, totalCessBn);
    const grandTotalBn = add(totalSellerPayableBn, totalChargesAmountBn);

    // 9. Bucket C: Statutory Collections
    const gstTcs = await taxEngine.resolveGstTcs({
      netTaxableSupplies: totalItemsTaxableBn,
      isInterState,
      transactionDate: txnDate,
      poolOverride: runner,
    });

    const withholding = await taxEngine.resolveWithholding({
      grossTaxableAmount: totalItemsTaxableBn,
      merchantConstitution: merchant.constitution_type || 'INDIVIDUAL',
      merchantPanStatus: merchant.pan_status || 'VALID_PAN',
      transactionDate: txnDate,
      poolOverride: runner,
    });

    const quoteId = uuidv4();
    const expiresAt = new Date(Date.now() + QUOTE_TTL_MINUTES * 60 * 1000);

    const quote: PricingQuote = {
      quoteId,
      userId: input.userId,
      pricingEngineVersion: this.version,
      calculationTimestamp: txnDate.toISOString(),
      currency: CURRENCY_CODE,
      merchantId: input.merchantId,
      storeId,
      placeOfSupplyStateCode,
      placeOfSupplyStateName: posResolution.stateName,
      placeOfSupplySource: posResolution.source,
      merchantStateCode,
      merchantStateName: merchantStateInfo.name,
      isInterState,
      items: calculatedItems,
      charges: calculatedCharges,
      itemsSubtotal: roundCurrency(preDiscountTaxableSubtotalBn),
      discountAmount: roundCurrency(totalItemDiscountTaxableBn),
      deliveryDiscountAmount: discountEval.deliveryDiscountAmount,
      platformDiscountSubsidy: discountEval.platformDiscountSubsidy,
      sellerDiscountAmount: discountEval.sellerDiscountAmount,
      taxableAmount: roundCurrency(totalItemsTaxableBn),
      totalCgst: roundCurrency(totalCgstBn),
      totalSgst: roundCurrency(totalSgstBn),
      totalIgst: roundCurrency(totalIgstBn),
      totalCess: roundCurrency(totalCessBn),
      totalTax: roundCurrency(totalTaxBn),
      totalCharges: roundCurrency(totalChargesAmountBn),
      grandTotal: roundCurrency(grandTotalBn),

      sellerGoodsBreakdown: {
        taxBucket: 'SELLER_GOODS',
        itemsSubtotal: roundCurrency(preDiscountTaxableSubtotalBn),
        discountAmount: roundCurrency(totalItemDiscountTaxableBn),
        taxableAmount: roundCurrency(totalItemsTaxableBn),
        cgstAmount: roundCurrency(sellerCgstBn),
        sgstAmount: roundCurrency(sellerSgstBn),
        igstAmount: roundCurrency(sellerIgstBn),
        cessAmount: roundCurrency(sellerCessBn),
        totalGst: roundCurrency(sellerGstBn),
        totalTaxWithCess: roundCurrency(sellerTotalTaxWithCessBn),
        totalSellerPayable: roundCurrency(totalSellerPayableBn),
      },
      qcomFeesBreakdown: {
        taxBucket: 'QCOM_SERVICE_FEES',
        deliveryTaxable: roundCurrency(deliveryTaxableBn),
        handlingTaxable: roundCurrency(handlingTaxableBn),
        platformTaxable: '0.00',
        cgstAmount: roundCurrency(qcomCgstBn),
        sgstAmount: roundCurrency(qcomSgstBn),
        igstAmount: roundCurrency(qcomIgstBn),
        totalGst: roundCurrency(qcomGstBn),
        totalCharges: roundCurrency(totalChargesAmountBn),
      },
      statutoryCollections: {
        taxBucket: 'STATUTORY_COLLECTIONS',
        gstTcs,
        withholding,
      },

      gstTcs,
      withholding,
      roundingPolicy: ROUNDING_POLICY,
      expiresAt: expiresAt.toISOString(),
      appliedPromotions: discountEval.appliedPromotions,
      appliedCoupon: discountEval.appliedCoupon,
    };

    const deliveryCharge = calculatedCharges.find(c => c.chargeType === 'DELIVERY');
    const handlingCharge = calculatedCharges.find(c => c.chargeType === 'HANDLING');
    const platformCharge = calculatedCharges.find(c => c.chargeType === 'PLATFORM');

    await runner.query(
      `INSERT INTO pricing_calculation_snapshots
        (id, idempotency_key, pricing_engine_version, user_id, merchant_id, store_id,
         place_of_supply_state_code, currency, items_subtotal, discount_amount, taxable_amount,
         delivery_fee, handling_fee, platform_fee, cgst_amount, sgst_amount, igst_amount,
         total_tax, grand_total, gst_tcs_amount, withholding_amount, snapshot_data, expires_at, created_at)
       VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, NOW())`,
      [
        quote.quoteId,
        input.idempotencyKey || null,
        quote.pricingEngineVersion,
        input.userId || null,
        quote.merchantId,
        quote.storeId || null,
        quote.placeOfSupplyStateCode,
        quote.currency,
        quote.itemsSubtotal,
        quote.discountAmount,
        quote.taxableAmount,
        deliveryCharge ? deliveryCharge.taxableAmount : '0.00',
        handlingCharge ? handlingCharge.taxableAmount : '0.00',
        platformCharge ? platformCharge.taxableAmount : '0.00',
        quote.totalCgst,
        quote.totalSgst,
        quote.totalIgst,
        quote.totalTax,
        quote.grandTotal,
        quote.gstTcs.totalTcsAmount,
        quote.withholding.withholdingAmount,
        JSON.stringify(quote),
        expiresAt,
      ]
    );

    return quote;
  }

  async getQuoteById(
    quoteId: string,
    poolOverride?: pg.Pool | pg.PoolClient
  ): Promise<PricingQuote | null> {
    const runner = poolOverride || getPool();
    const res = await runner.query(
      `SELECT snapshot_data, expires_at, is_converted_to_order
         FROM pricing_calculation_snapshots
        WHERE id = $1`,
      [quoteId]
    );

    if (res.rows.length === 0) {
      return null;
    }

    const row = res.rows[0];
    return typeof row.snapshot_data === 'string'
      ? JSON.parse(row.snapshot_data)
      : row.snapshot_data;
  }
}

export const pricingEngine = new PricingEngine();
