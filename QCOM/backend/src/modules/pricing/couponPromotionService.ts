import pg from 'pg';
import BigNumber from 'bignumber.js';
import { getPool } from '../../database/connection.js';
import {
  AppliedDiscountDetail,
  DiscountFundingSource,
  LineItemDiscountShare,
} from './pricingTypes.js';
import {
  toDecimal,
  roundCurrency,
  multiply,
  divide,
  add,
  subtract,
} from './money.js';
import { recordAuditEvent } from '../audit/auditService.js';

export class CouponPromotionError extends Error {
  code: string;
  statusCode: number;

  constructor(code: string, message: string, statusCode: number = 422) {
    super(message);
    this.name = 'CouponPromotionError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface DiscountCandidateItem {
  productId: string;
  category: string;
  quantity: number;
  unitPrice: BigNumber;
  grossLine: BigNumber;
  remainingLine: BigNumber;
  appliedDiscounts: LineItemDiscountShare[];
}

export interface EvaluatedDiscountResult {
  items: DiscountCandidateItem[];
  totalItemDiscount: string;
  deliveryDiscountAmount: string;
  platformDiscountSubsidy: string;
  sellerDiscountAmount: string;
  appliedPromotions: AppliedDiscountDetail[];
  appliedCoupon?: {
    couponId: string;
    code: string;
    discountAmount: string;
    fundingSource: DiscountFundingSource;
    sellerShareAmount: string;
    platformShareAmount: string;
  };
}

function parseJsonStringArray(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map((v) => String(v).trim()).filter(Boolean);
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map((v) => String(v).trim()).filter(Boolean) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function splitFundingShares(
  totalDiscount: BigNumber,
  fundingSource: DiscountFundingSource,
  sellerSharePercentRaw: number | string | null | undefined
): { sellerShare: BigNumber; platformShare: BigNumber } {
  const totalRounded = toDecimal(roundCurrency(totalDiscount));
  if (totalRounded.isZero()) {
    return { sellerShare: new BigNumber(0), platformShare: new BigNumber(0) };
  }
  if (fundingSource === 'SELLER') {
    return { sellerShare: totalRounded, platformShare: new BigNumber(0) };
  }
  if (fundingSource === 'PLATFORM') {
    return { sellerShare: new BigNumber(0), platformShare: totalRounded };
  }
  const pct = toDecimal(sellerSharePercentRaw ?? 50);
  const sellerShare = toDecimal(roundCurrency(multiply(totalRounded, divide(pct, 100))));
  const platformShare = subtract(totalRounded, sellerShare);
  return { sellerShare, platformShare };
}

function allocateDiscountProportionally(
  eligibleItems: DiscountCandidateItem[],
  targetDiscount: BigNumber,
  sourceType: 'PROMOTION' | 'COUPON',
  sourceId: string,
  code: string,
  fundingSource: DiscountFundingSource,
  sellerSharePercent: number | string | null | undefined
): { actualDiscount: BigNumber; sellerShare: BigNumber; platformShare: BigNumber } {
  const totalRemaining = eligibleItems.reduce(
    (acc, it) => acc.plus(it.remainingLine),
    new BigNumber(0)
  );
  if (totalRemaining.isLessThanOrEqualTo(0) || targetDiscount.isLessThanOrEqualTo(0)) {
    return {
      actualDiscount: new BigNumber(0),
      sellerShare: new BigNumber(0),
      platformShare: new BigNumber(0),
    };
  }

  const cappedTotal = toDecimal(roundCurrency(BigNumber.min(targetDiscount, totalRemaining)));
  if (cappedTotal.isLessThanOrEqualTo(0)) {
    return {
      actualDiscount: new BigNumber(0),
      sellerShare: new BigNumber(0),
      platformShare: new BigNumber(0),
    };
  }

  const { sellerShare, platformShare } = splitFundingShares(
    cappedTotal,
    fundingSource,
    sellerSharePercent
  );

  let remainingDiscount = cappedTotal;
  let remainingSeller = sellerShare;
  let remainingPlatform = platformShare;

  for (let i = 0; i < eligibleItems.length; i++) {
    const it = eligibleItems[i];
    const isLast = i === eligibleItems.length - 1;
    let share: BigNumber;
    let itemSeller: BigNumber;
    let itemPlatform: BigNumber;

    if (isLast) {
      share = BigNumber.min(remainingDiscount, it.remainingLine);
      itemSeller = BigNumber.min(remainingSeller, share);
      itemPlatform = subtract(share, itemSeller);
    } else {
      const ratio = divide(it.remainingLine, totalRemaining);
      share = BigNumber.min(toDecimal(roundCurrency(multiply(cappedTotal, ratio))), it.remainingLine);
      remainingDiscount = subtract(remainingDiscount, share);

      if (cappedTotal.isGreaterThan(0)) {
        itemSeller = toDecimal(roundCurrency(multiply(sellerShare, divide(share, cappedTotal))));
        itemSeller = BigNumber.min(itemSeller, remainingSeller, share);
        itemPlatform = subtract(share, itemSeller);
        remainingSeller = subtract(remainingSeller, itemSeller);
        remainingPlatform = subtract(remainingPlatform, itemPlatform);
      } else {
        itemSeller = new BigNumber(0);
        itemPlatform = new BigNumber(0);
      }
    }

    if (share.isGreaterThan(0)) {
      it.remainingLine = subtract(it.remainingLine, share);
      it.appliedDiscounts.push({
        sourceType,
        sourceId,
        code,
        discountAmount: roundCurrency(share),
        sellerShareAmount: roundCurrency(itemSeller),
        platformShareAmount: roundCurrency(itemPlatform),
        fundingSource,
      });
    }
  }

  return { actualDiscount: cappedTotal, sellerShare, platformShare };
}

export class CouponPromotionService {
  /**
   * Evaluates active automatic promotions + optional explicit coupon code cleanly with
   * eligibility scoping, stackability, conflict groups, BOGO, slabs, and funding attribution.
   */
  async evaluateQuoteDiscounts(
    params: {
      merchantId: string;
      userId?: string;
      items: Array<{ productId: string; category: string; quantity: number; unitPrice: string | number }>;
      deliveryFeeTaxable?: string | number | BigNumber;
      couponCode?: string;
      transactionDate?: Date;
      isFirstOrderOverride?: boolean;
    },
    runnerOverride?: pg.Pool | pg.PoolClient
  ): Promise<EvaluatedDiscountResult> {
    const runner = runnerOverride || getPool();
    const txnDate = params.transactionDate || new Date();
    const nowIso = txnDate.toISOString();

    const candidateItems: DiscountCandidateItem[] = params.items.map((it) => {
      const unitPrice = toDecimal(it.unitPrice);
      const grossLine = multiply(unitPrice, it.quantity);
      return {
        productId: it.productId,
        category: (it.category || '').toLowerCase(),
        quantity: it.quantity,
        unitPrice,
        grossLine,
        remainingLine: grossLine,
        appliedDiscounts: [],
      };
    });

    const cartGross = candidateItems.reduce((acc, it) => acc.plus(it.grossLine), new BigNumber(0));
    const deliveryFeeBn = toDecimal(params.deliveryFeeTaxable ?? 0);

    // Lazy first-order lookup (only queried if a rule checks first_order_only)
    let isFirstOrderCached: boolean | null =
      params.isFirstOrderOverride !== undefined ? params.isFirstOrderOverride : null;

    const checkIsFirstOrder = async (): Promise<boolean> => {
      if (isFirstOrderCached !== null) return isFirstOrderCached;
      if (!params.userId) {
        isFirstOrderCached = true;
        return true;
      }
      const orderCntRes = await runner.query(
        `SELECT COUNT(*) AS cnt FROM orders WHERE user_id = $1 AND status != 'cancelled'`,
        [params.userId]
      );
      isFirstOrderCached = Number(orderCntRes.rows[0]?.cnt || 0) === 0;
      return isFirstOrderCached;
    };

    // 1. Evaluate Active Automatic Promotions (ordered deterministically by priority ASC)
    const promoRes = await runner.query(
      `SELECT id, code, title, description, promotion_type, discount_value, max_discount_inr,
              min_order_value_inr, min_quantity, max_quantity, buy_quantity, get_quantity,
              applicable_merchant_id, applicable_categories, applicable_product_ids, slab_rules,
              first_order_only, priority, conflict_group, is_stackable, stackable_with_coupons,
              funding_source, seller_share_percent, usage_limit, usage_count, per_user_limit
         FROM promotions
        WHERE is_active = TRUE
          AND valid_from <= $1::timestamptz
          AND (valid_to IS NULL OR valid_to >= $1::timestamptz)
          AND (applicable_merchant_id IS NULL OR applicable_merchant_id = $2)
        ORDER BY priority ASC, created_at ASC`,
      [nowIso, params.merchantId]
    );

    const appliedPromotions: Array<AppliedDiscountDetail & { stackableWithCoupons: boolean; isStackable: boolean }> = [];
    const usedConflictGroups = new Set<string>();
    let hasNonStackableItemPromo = false;
    let totalItemDiscountBn = new BigNumber(0);
    let deliveryDiscountBn = new BigNumber(0);
    let platformSubsidyBn = new BigNumber(0);
    let sellerDiscountBn = new BigNumber(0);

    for (const promo of promoRes.rows) {
      if (promo.usage_limit !== null && Number(promo.usage_count) >= Number(promo.usage_limit)) {
        continue;
      }

      if (promo.per_user_limit !== null && params.userId) {
        const userUseRes = await runner.query(
          `SELECT COUNT(*) AS cnt FROM promotion_applications
            WHERE promotion_id = $1 AND user_id = $2 AND status IN ('RESERVED', 'APPLIED')`,
          [promo.id, params.userId]
        );
        if (Number(userUseRes.rows[0]?.cnt || 0) >= Number(promo.per_user_limit)) {
          continue;
        }
      }

      if (promo.first_order_only && !(await checkIsFirstOrder())) {
        continue;
      }

      if (promo.conflict_group && usedConflictGroups.has(promo.conflict_group)) {
        continue;
      }

      const promoType = promo.promotion_type as string;
      const fundingSource = (promo.funding_source || 'PLATFORM') as DiscountFundingSource;

      if (promoType === 'FREE_DELIVERY') {
        if (deliveryFeeBn.isLessThanOrEqualTo(0) || deliveryDiscountBn.isGreaterThanOrEqualTo(deliveryFeeBn)) {
          continue;
        }
        const minOrder = toDecimal(promo.min_order_value_inr || 0);
        if (cartGross.isLessThan(minOrder)) {
          continue;
        }
        const maxOff = toDecimal(promo.discount_value || 0).isGreaterThan(0)
          ? toDecimal(promo.discount_value)
          : deliveryFeeBn;
        const availableDelDisc = subtract(deliveryFeeBn, deliveryDiscountBn);
        const delDisc = toDecimal(roundCurrency(BigNumber.min(maxOff, availableDelDisc)));
        if (delDisc.isGreaterThan(0)) {
          const { sellerShare, platformShare } = splitFundingShares(delDisc, fundingSource, promo.seller_share_percent);
          deliveryDiscountBn = add(deliveryDiscountBn, delDisc);
          platformSubsidyBn = add(platformSubsidyBn, platformShare);
          sellerDiscountBn = add(sellerDiscountBn, sellerShare);
          if (promo.conflict_group) usedConflictGroups.add(promo.conflict_group);
          appliedPromotions.push({
            sourceType: 'PROMOTION',
            sourceId: promo.id,
            code: promo.code,
            title: promo.title,
            discountAmount: roundCurrency(delDisc),
            sellerShareAmount: roundCurrency(sellerShare),
            platformShareAmount: roundCurrency(platformShare),
            fundingSource,
            discountTarget: 'DELIVERY',
            stackableWithCoupons: Boolean(promo.stackable_with_coupons),
            isStackable: Boolean(promo.is_stackable),
          });
        }
        continue;
      }

      // Item-targeted promotions
      if (hasNonStackableItemPromo || (!promo.is_stackable && appliedPromotions.some((p) => p.discountTarget === 'ITEMS'))) {
        continue;
      }

      const catFilter = parseJsonStringArray(promo.applicable_categories).map((c) => c.toLowerCase());
      const prodFilter = parseJsonStringArray(promo.applicable_product_ids);

      const eligibleItems = candidateItems.filter((it) => {
        if (catFilter.length > 0 && !catFilter.includes(it.category)) return false;
        if (prodFilter.length > 0 && !prodFilter.includes(it.productId)) return false;
        return it.remainingLine.isGreaterThan(0);
      });

      if (eligibleItems.length === 0) continue;

      const eligibleGross = eligibleItems.reduce((acc, it) => acc.plus(it.grossLine), new BigNumber(0));
      const eligibleRemaining = eligibleItems.reduce((acc, it) => acc.plus(it.remainingLine), new BigNumber(0));
      const eligibleQty = eligibleItems.reduce((acc, it) => acc + it.quantity, 0);

      const minOrder = toDecimal(promo.min_order_value_inr || 0);
      if (eligibleGross.isLessThan(minOrder)) continue;
      if (eligibleQty < Number(promo.min_quantity || 1)) continue;

      let targetDisc = new BigNumber(0);

      if (promoType === 'FLAT_AMOUNT') {
        targetDisc = toDecimal(promo.discount_value);
      } else if (promoType === 'PERCENTAGE' || promoType === 'CATEGORY_DISCOUNT') {
        targetDisc = multiply(eligibleRemaining, divide(toDecimal(promo.discount_value), 100));
        if (promo.max_discount_inr) {
          targetDisc = BigNumber.min(targetDisc, toDecimal(promo.max_discount_inr));
        }
      } else if (promoType === 'CART_SLAB') {
        const slabsRaw = Array.isArray(promo.slab_rules)
          ? promo.slab_rules
          : typeof promo.slab_rules === 'string'
            ? JSON.parse(promo.slab_rules || '[]')
            : [];
        const sortedSlabs = [...slabsRaw].sort((a: any, b: any) => Number(b.minAmount || 0) - Number(a.minAmount || 0));
        const matched = sortedSlabs.find((s: any) => eligibleGross.isGreaterThanOrEqualTo(toDecimal(s.minAmount || 0)));
        if (matched) {
          if (matched.discountType === 'PERCENTAGE') {
            targetDisc = multiply(eligibleRemaining, divide(toDecimal(matched.discountValue || 0), 100));
            const slabCap = matched.maxDiscountInr || promo.max_discount_inr;
            if (slabCap) targetDisc = BigNumber.min(targetDisc, toDecimal(slabCap));
          } else {
            targetDisc = toDecimal(matched.discountValue || 0);
          }
        }
      } else if (promoType === 'BOGO') {
        const buyQty = Math.max(1, Number(promo.buy_quantity || 1));
        const getQty = Math.max(1, Number(promo.get_quantity || 1));
        let freeUnits = Math.floor(eligibleQty / (buyQty + getQty)) * getQty;
        if (promo.max_quantity) {
          freeUnits = Math.min(freeUnits, Number(promo.max_quantity));
        }
        if (freeUnits > 0) {
          // Discount lowest-priced units first across eligible items (standard retail BOGO rule)
          const unitPrices: BigNumber[] = [];
          for (const it of eligibleItems) {
            for (let q = 0; q < it.quantity; q++) {
              unitPrices.push(it.unitPrice);
            }
          }
          unitPrices.sort((a, b) => a.comparedTo(b) ?? 0);
          for (let f = 0; f < Math.min(freeUnits, unitPrices.length); f++) {
            targetDisc = add(targetDisc, unitPrices[f]);
          }
          if (promo.max_discount_inr) {
            targetDisc = BigNumber.min(targetDisc, toDecimal(promo.max_discount_inr));
          }
        }
      }

      if (targetDisc.isLessThanOrEqualTo(0)) continue;

      const allocated = allocateDiscountProportionally(
        eligibleItems,
        targetDisc,
        'PROMOTION',
        promo.id,
        promo.code,
        fundingSource,
        promo.seller_share_percent
      );

      if (allocated.actualDiscount.isGreaterThan(0)) {
        totalItemDiscountBn = add(totalItemDiscountBn, allocated.actualDiscount);
        sellerDiscountBn = add(sellerDiscountBn, allocated.sellerShare);
        platformSubsidyBn = add(platformSubsidyBn, allocated.platformShare);
        if (promo.conflict_group) usedConflictGroups.add(promo.conflict_group);
        if (!promo.is_stackable) hasNonStackableItemPromo = true;

        appliedPromotions.push({
          sourceType: 'PROMOTION',
          sourceId: promo.id,
          code: promo.code,
          title: promo.title,
          discountAmount: roundCurrency(allocated.actualDiscount),
          sellerShareAmount: roundCurrency(allocated.sellerShare),
          platformShareAmount: roundCurrency(allocated.platformShare),
          fundingSource,
          discountTarget: 'ITEMS',
          stackableWithCoupons: Boolean(promo.stackable_with_coupons),
          isStackable: Boolean(promo.is_stackable),
        });
      }
    }

    // 2. Evaluate Explicit Customer Coupon Code
    let appliedCoupon: EvaluatedDiscountResult['appliedCoupon'] | undefined;

    if (params.couponCode && params.couponCode.trim() !== '') {
      const cleanCode = params.couponCode.trim().toUpperCase();
      const couponRes = await runner.query(
        `SELECT id, code, title, description, discount_type, discount_value, min_order_value_inr, max_discount_inr,
                applicable_merchant_id, usage_limit, usage_count, per_user_limit, first_order_only,
                applicable_categories, applicable_product_ids, is_stackable, funding_source, seller_share_percent,
                valid_from, valid_to, is_active
           FROM coupons
          WHERE UPPER(code) = $1
            AND is_active = TRUE
            AND valid_from <= $2::timestamptz
            AND (valid_to IS NULL OR valid_to >= $2::timestamptz)
            AND (applicable_merchant_id IS NULL OR applicable_merchant_id = $3)
          LIMIT 1`,
        [cleanCode, nowIso, params.merchantId]
      );

      if (couponRes.rows.length === 0) {
        throw new CouponPromotionError(
          'INVALID_COUPON',
          `Coupon code '${cleanCode}' is invalid, expired, or does not apply to this merchant.`,
          422
        );
      }

      const coupon = couponRes.rows[0];

      if (coupon.usage_limit !== null && Number(coupon.usage_count) >= Number(coupon.usage_limit)) {
        throw new CouponPromotionError(
          'COUPON_USAGE_LIMIT_EXCEEDED',
          `Coupon code '${coupon.code}' has reached its maximum global redemption limit.`,
          422
        );
      }

      if (coupon.per_user_limit !== null && params.userId) {
        const userRedeemRes = await runner.query(
          `SELECT COUNT(*) AS cnt FROM coupon_redemptions
            WHERE coupon_id = $1 AND user_id = $2 AND status IN ('RESERVED', 'REDEEMED')`,
          [coupon.id, params.userId]
        );
        if (Number(userRedeemRes.rows[0]?.cnt || 0) >= Number(coupon.per_user_limit)) {
          throw new CouponPromotionError(
            'COUPON_USER_LIMIT_EXCEEDED',
            `You have already reached the per-user redemption limit for coupon '${coupon.code}'.`,
            422
          );
        }
      }

      if (coupon.first_order_only && !(await checkIsFirstOrder())) {
        throw new CouponPromotionError(
          'COUPON_FIRST_ORDER_ONLY',
          `Coupon '${coupon.code}' is valid exclusively for a customer's first order.`,
          422
        );
      }

      const itemPromosApplied = appliedPromotions.filter((p) => p.discountTarget === 'ITEMS');
      if (itemPromosApplied.length > 0) {
        const promoBlocksCoupon = itemPromosApplied.some((p) => !p.stackableWithCoupons);
        if (promoBlocksCoupon || !coupon.is_stackable) {
          throw new CouponPromotionError(
            'COUPON_NOT_STACKABLE',
            `Coupon '${coupon.code}' cannot be combined with the currently active automatic promotion.`,
            422
          );
        }
      }

      const catFilter = parseJsonStringArray(coupon.applicable_categories).map((c) => c.toLowerCase());
      const prodFilter = parseJsonStringArray(coupon.applicable_product_ids);

      const eligibleItems = candidateItems.filter((it) => {
        if (catFilter.length > 0 && !catFilter.includes(it.category)) return false;
        if (prodFilter.length > 0 && !prodFilter.includes(it.productId)) return false;
        return it.remainingLine.isGreaterThan(0);
      });

      if (eligibleItems.length === 0) {
        throw new CouponPromotionError(
          'COUPON_NOT_APPLICABLE_TO_ITEMS',
          `Coupon '${coupon.code}' does not apply to any items currently in your cart.`,
          422
        );
      }

      const eligibleGross = eligibleItems.reduce((acc, it) => acc.plus(it.grossLine), new BigNumber(0));
      const eligibleRemaining = eligibleItems.reduce((acc, it) => acc.plus(it.remainingLine), new BigNumber(0));
      const minOrderVal = toDecimal(coupon.min_order_value_inr || 0);

      if (eligibleGross.isLessThan(minOrderVal)) {
        throw new CouponPromotionError(
          'COUPON_MIN_ORDER_NOT_MET',
          `Coupon '${coupon.code}' requires a minimum eligible order subtotal of ₹${minOrderVal.toFixed(2)}.`,
          422
        );
      }

      let rawCouponDisc = new BigNumber(0);
      if (coupon.discount_type === 'FLAT_AMOUNT') {
        rawCouponDisc = toDecimal(coupon.discount_value);
      } else if (coupon.discount_type === 'PERCENTAGE') {
        rawCouponDisc = multiply(eligibleRemaining, divide(toDecimal(coupon.discount_value), 100));
        if (coupon.max_discount_inr) {
          rawCouponDisc = BigNumber.min(rawCouponDisc, toDecimal(coupon.max_discount_inr));
        }
      }

      const fundingSource = (coupon.funding_source || 'SELLER') as DiscountFundingSource;
      const allocated = allocateDiscountProportionally(
        eligibleItems,
        rawCouponDisc,
        'COUPON',
        coupon.id,
        coupon.code,
        fundingSource,
        coupon.seller_share_percent
      );

      totalItemDiscountBn = add(totalItemDiscountBn, allocated.actualDiscount);
      sellerDiscountBn = add(sellerDiscountBn, allocated.sellerShare);
      platformSubsidyBn = add(platformSubsidyBn, allocated.platformShare);

      appliedCoupon = {
        couponId: coupon.id,
        code: coupon.code,
        discountAmount: roundCurrency(allocated.actualDiscount),
        fundingSource,
        sellerShareAmount: roundCurrency(allocated.sellerShare),
        platformShareAmount: roundCurrency(allocated.platformShare),
      };
    }

    return {
      items: candidateItems,
      totalItemDiscount: roundCurrency(totalItemDiscountBn),
      deliveryDiscountAmount: roundCurrency(deliveryDiscountBn),
      platformDiscountSubsidy: roundCurrency(platformSubsidyBn),
      sellerDiscountAmount: roundCurrency(sellerDiscountBn),
      appliedPromotions: appliedPromotions.map(({ stackableWithCoupons: _s, isStackable: _i, ...rest }) => rest),
      appliedCoupon,
    };
  }

  /**
   * Atomically locks coupon/promotion rows (`SELECT ... FOR UPDATE`), re-validates limits under lock,
   * increments usage_count, and inserts RESERVED ledger records inside the order creation transaction.
   */
  async lockAndReserveForOrder(params: {
    client: pg.PoolClient;
    orderId: string;
    userId: string;
    merchantId: string;
    appliedCoupon?: {
      couponId?: string;
      code: string;
      discountAmount: string;
      fundingSource?: DiscountFundingSource;
      sellerShareAmount?: string;
      platformShareAmount?: string;
    };
    appliedPromotions?: AppliedDiscountDetail[];
    initialStatus?: 'RESERVED' | 'REDEEMED';
  }): Promise<void> {
    const { client, orderId, userId, merchantId, appliedCoupon, appliedPromotions } = params;
    const targetCouponStatus = params.initialStatus === 'REDEEMED' ? 'REDEEMED' : 'RESERVED';
    const targetPromoStatus = params.initialStatus === 'REDEEMED' ? 'APPLIED' : 'RESERVED';

    if (appliedCoupon && appliedCoupon.code) {
      const lockRes = await client.query(
        `SELECT id, code, usage_limit, usage_count, per_user_limit, first_order_only, is_active, valid_from, valid_to
           FROM coupons
          WHERE UPPER(code) = $1
          FOR UPDATE`,
        [appliedCoupon.code.trim().toUpperCase()]
      );

      if (lockRes.rows.length === 0 || !lockRes.rows[0].is_active) {
        throw new CouponPromotionError('INVALID_COUPON', `Coupon '${appliedCoupon.code}' is no longer active.`, 422);
      }

      const c = lockRes.rows[0];
      if (c.usage_limit !== null && Number(c.usage_count) >= Number(c.usage_limit)) {
        throw new CouponPromotionError(
          'COUPON_USAGE_LIMIT_EXCEEDED',
          `Coupon '${c.code}' usage limit (${c.usage_limit}) was exhausted concurrently.`,
          422
        );
      }

      if (c.per_user_limit !== null) {
        const userCntRes = await client.query(
          `SELECT COUNT(*) AS cnt FROM coupon_redemptions
            WHERE coupon_id = $1 AND user_id = $2 AND status IN ('RESERVED', 'REDEEMED')`,
          [c.id, userId]
        );
        if (Number(userCntRes.rows[0]?.cnt || 0) >= Number(c.per_user_limit)) {
          throw new CouponPromotionError(
            'COUPON_USER_LIMIT_EXCEEDED',
            `Per-user limit reached for coupon '${c.code}'.`,
            422
          );
        }
      }

      if (c.first_order_only) {
        const priorOrders = await client.query(
          `SELECT COUNT(*) AS cnt FROM orders WHERE user_id = $1 AND id != $2 AND status != 'cancelled'`,
          [userId, orderId]
        );
        if (Number(priorOrders.rows[0]?.cnt || 0) > 0) {
          throw new CouponPromotionError(
            'COUPON_FIRST_ORDER_ONLY',
            `Coupon '${c.code}' is valid exclusively for a customer's first order.`,
            422
          );
        }
      }

      // Check if already reserved for this order (idempotent safeguard)
      const existingRedeem = await client.query(
        `SELECT id FROM coupon_redemptions WHERE coupon_id = $1 AND order_id = $2`,
        [c.id, orderId]
      );

      if (existingRedeem.rows.length === 0) {
        const incRes = await client.query(
          `UPDATE coupons
              SET usage_count = usage_count + 1, updated_at = NOW()
            WHERE id = $1
              AND (usage_limit IS NULL OR usage_count < usage_limit)
          RETURNING usage_count`,
          [c.id]
        );
        if (incRes.rows.length === 0) {
          throw new CouponPromotionError(
            'COUPON_USAGE_LIMIT_EXCEEDED',
            `Coupon '${c.code}' usage limit exhausted under lock.`,
            422
          );
        }

        await client.query(
          `INSERT INTO coupon_redemptions
            (coupon_id, order_id, user_id, merchant_id, coupon_code, discount_amount,
             seller_share_amount, platform_share_amount, status, redeemed_at, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
          [
            c.id,
            orderId,
            userId,
            merchantId,
            c.code,
            appliedCoupon.discountAmount,
            appliedCoupon.sellerShareAmount || '0.00',
            appliedCoupon.platformShareAmount || '0.00',
            targetCouponStatus,
            targetCouponStatus === 'REDEEMED' ? new Date() : null,
            JSON.stringify({ fundingSource: appliedCoupon.fundingSource || 'SELLER' }),
          ]
        );
      }
    }

    if (appliedPromotions && appliedPromotions.length > 0) {
      for (const promo of appliedPromotions) {
        const pLock = await client.query(
          `SELECT id, code, usage_limit, usage_count, per_user_limit, first_order_only, is_active
             FROM promotions
            WHERE id = $1
            FOR UPDATE`,
          [promo.sourceId]
        );
        if (pLock.rows.length === 0 || !pLock.rows[0].is_active) continue;
        const p = pLock.rows[0];

        if (p.usage_limit !== null && Number(p.usage_count) >= Number(p.usage_limit)) {
          throw new CouponPromotionError(
            'PROMOTION_USAGE_LIMIT_EXCEEDED',
            `Promotion '${p.code}' usage limit was exhausted concurrently.`,
            422
          );
        }

        if (p.per_user_limit !== null) {
          const userPromoCnt = await client.query(
            `SELECT COUNT(*) AS cnt FROM promotion_applications
              WHERE promotion_id = $1 AND user_id = $2 AND status IN ('RESERVED', 'APPLIED')`,
            [p.id, userId]
          );
          if (Number(userPromoCnt.rows[0]?.cnt || 0) >= Number(p.per_user_limit)) {
            throw new CouponPromotionError(
              'PROMOTION_USER_LIMIT_EXCEEDED',
              `Per-user limit reached for promotion '${p.code}'.`,
              422
            );
          }
        }

        const existingApp = await client.query(
          `SELECT id FROM promotion_applications WHERE promotion_id = $1 AND order_id = $2`,
          [p.id, orderId]
        );
        if (existingApp.rows.length === 0) {
          const incPromo = await client.query(
            `UPDATE promotions
                SET usage_count = usage_count + 1, updated_at = NOW()
              WHERE id = $1
                AND (usage_limit IS NULL OR usage_count < usage_limit)
            RETURNING usage_count`,
            [p.id]
          );
          if (incPromo.rows.length === 0) {
            throw new CouponPromotionError(
              'PROMOTION_USAGE_LIMIT_EXCEEDED',
              `Promotion '${p.code}' usage limit exhausted.`,
              422
            );
          }

          await client.query(
            `INSERT INTO promotion_applications
              (promotion_id, order_id, user_id, merchant_id, promotion_code, discount_amount,
               seller_share_amount, platform_share_amount, status, metadata)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
            [
              p.id,
              orderId,
              userId,
              merchantId,
              promo.code,
              promo.discountAmount,
              promo.sellerShareAmount,
              promo.platformShareAmount,
              targetPromoStatus,
              JSON.stringify({ fundingSource: promo.fundingSource, discountTarget: promo.discountTarget }),
            ]
          );
        }
      }
    }
  }

  /**
   * Transitions RESERVED coupon redemptions & promotion applications to REDEEMED / APPLIED on payment capture.
   */
  async markRedeemedForOrder(client: pg.PoolClient, orderId: string): Promise<void> {
    await client.query(
      `UPDATE coupon_redemptions
          SET status = 'REDEEMED', redeemed_at = COALESCE(redeemed_at, NOW()), updated_at = NOW()
        WHERE order_id = $1 AND status = 'RESERVED'`,
      [orderId]
    );
    await client.query(
      `UPDATE promotion_applications
          SET status = 'APPLIED', updated_at = NOW()
        WHERE order_id = $1 AND status = 'RESERVED'`,
      [orderId]
    );
  }

  /**
   * Releases RESERVED (or pre-fulfillment cancelled REDEEMED) coupon & promotion slots idempotently
   * and decrements usage_count atomically.
   */
  async releaseForOrder(client: pg.PoolClient, orderId: string): Promise<void> {
    const releasedCoupons = await client.query(
      `UPDATE coupon_redemptions
          SET status = 'RELEASED', released_at = NOW(), updated_at = NOW()
        WHERE order_id = $1 AND status IN ('RESERVED', 'REDEEMED')
        RETURNING coupon_id`,
      [orderId]
    );

    for (const row of releasedCoupons.rows) {
      await client.query(
        `UPDATE coupons
            SET usage_count = GREATEST(0, usage_count - 1), updated_at = NOW()
          WHERE id = $1`,
        [row.coupon_id]
      );
    }

    const releasedPromos = await client.query(
      `UPDATE promotion_applications
          SET status = 'RELEASED', updated_at = NOW()
        WHERE order_id = $1 AND status IN ('RESERVED', 'APPLIED')
        RETURNING promotion_id`,
      [orderId]
    );

    for (const row of releasedPromos.rows) {
      await client.query(
        `UPDATE promotions
            SET usage_count = GREATEST(0, usage_count - 1), updated_at = NOW()
          WHERE id = $1`,
        [row.promotion_id]
      );
    }
  }

  /**
   * Proportionally reverses coupon/promotion discount tracking on full or partial returns.
   */
  async reverseForReturn(
    client: pg.PoolClient,
    orderId: string,
    returnRatio: number,
    isFullReturn: boolean
  ): Promise<void> {
    const ratio = Math.max(0, Math.min(1, returnRatio));

    const couponRows = await client.query(
      `SELECT id, discount_amount, reversed_amount, status FROM coupon_redemptions WHERE order_id = $1 FOR UPDATE`,
      [orderId]
    );
    for (const row of couponRows.rows) {
      const totalDisc = toDecimal(row.discount_amount);
      const currRev = toDecimal(row.reversed_amount || 0);
      const addRev = isFullReturn
        ? subtract(totalDisc, currRev)
        : toDecimal(roundCurrency(multiply(totalDisc, ratio)));
      const nextRev = BigNumber.min(totalDisc, add(currRev, addRev));
      const newStatus = isFullReturn || nextRev.isGreaterThanOrEqualTo(totalDisc) ? 'REVERSED' : row.status;

      await client.query(
        `UPDATE coupon_redemptions
            SET reversed_amount = $1,
                status = $2,
                reversed_at = CASE WHEN $2 = 'REVERSED' THEN COALESCE(reversed_at, NOW()) ELSE reversed_at END,
                updated_at = NOW()
          WHERE id = $3`,
        [roundCurrency(nextRev), newStatus, row.id]
      );
    }

    const promoRows = await client.query(
      `SELECT id, discount_amount, reversed_amount, status FROM promotion_applications WHERE order_id = $1 FOR UPDATE`,
      [orderId]
    );
    for (const row of promoRows.rows) {
      const totalDisc = toDecimal(row.discount_amount);
      const currRev = toDecimal(row.reversed_amount || 0);
      const addRev = isFullReturn
        ? subtract(totalDisc, currRev)
        : toDecimal(roundCurrency(multiply(totalDisc, ratio)));
      const nextRev = BigNumber.min(totalDisc, add(currRev, addRev));
      const newStatus = isFullReturn || nextRev.isGreaterThanOrEqualTo(totalDisc) ? 'REVERSED' : row.status;

      await client.query(
        `UPDATE promotion_applications
            SET reversed_amount = $1,
                status = $2,
                updated_at = NOW()
          WHERE id = $3`,
        [roundCurrency(nextRev), newStatus, row.id]
      );
    }
  }

  // =========================================================================
  // ADMIN GOVERNANCE & AUDIT-LOGGED COUPON / PROMOTION CRUD
  // =========================================================================

  async listCoupons(runnerOverride?: pg.Pool | pg.PoolClient) {
    const runner = runnerOverride || getPool();
    const res = await runner.query(
      `SELECT id, code, title, description, discount_type, discount_value, min_order_value_inr, max_discount_inr,
              applicable_merchant_id, usage_limit, usage_count, per_user_limit, first_order_only,
              applicable_categories, applicable_product_ids, is_stackable, funding_source, seller_share_percent,
              valid_from, valid_to, is_active, created_at, updated_at
         FROM coupons
        ORDER BY created_at DESC`
    );
    return res.rows;
  }

  async createCoupon(
    params: {
      code: string;
      title?: string;
      description?: string;
      discountType: 'FLAT_AMOUNT' | 'PERCENTAGE';
      discountValue: number;
      minOrderValueInr?: number;
      maxDiscountInr?: number | null;
      applicableMerchantId?: string | null;
      usageLimit?: number | null;
      perUserLimit?: number | null;
      firstOrderOnly?: boolean;
      applicableCategories?: string[];
      applicableProductIds?: string[];
      isStackable?: boolean;
      fundingSource?: DiscountFundingSource;
      sellerSharePercent?: number;
      validFrom?: string;
      validTo?: string | null;
      actorId: string;
    },
    runnerOverride?: pg.Pool
  ) {
    const runner = runnerOverride || getPool();
    const cleanCode = params.code.trim().toUpperCase();
    if (!cleanCode || params.discountValue <= 0) {
      throw new CouponPromotionError('INVALID_COUPON_PAYLOAD', 'Valid coupon code and positive discount value are required.', 400);
    }
    if (params.discountType === 'PERCENTAGE' && params.discountValue > 100) {
      throw new CouponPromotionError('INVALID_COUPON_PAYLOAD', 'Percentage discount cannot exceed 100%.', 400);
    }

    const fundingSource: DiscountFundingSource = params.fundingSource || 'SELLER';
    const sellerSharePct =
      fundingSource === 'SELLER' ? 100 : fundingSource === 'PLATFORM' ? 0 : (params.sellerSharePercent ?? 50);

    const res = await runner.query(
      `INSERT INTO coupons (
        code, title, description, discount_type, discount_value, min_order_value_inr, max_discount_inr,
        applicable_merchant_id, usage_limit, per_user_limit, first_order_only,
        applicable_categories, applicable_product_ids, is_stackable, funding_source, seller_share_percent,
        valid_from, valid_to, is_active
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14, $15, $16, COALESCE($17::timestamptz, NOW()), $18::timestamptz, TRUE)
      RETURNING *`,
      [
        cleanCode,
        params.title || cleanCode,
        params.description || params.title || `${cleanCode} promotional coupon`,
        params.discountType,
        params.discountValue,
        params.minOrderValueInr ?? 0,
        params.maxDiscountInr ?? null,
        params.applicableMerchantId ?? null,
        params.usageLimit ?? null,
        params.perUserLimit ?? null,
        Boolean(params.firstOrderOnly),
        JSON.stringify(params.applicableCategories || []),
        JSON.stringify(params.applicableProductIds || []),
        Boolean(params.isStackable),
        fundingSource,
        sellerSharePct,
        params.validFrom || null,
        params.validTo || null,
      ]
    );

    const created = res.rows[0];
    await recordAuditEvent({
      actorId: params.actorId,
      actorType: 'ADMIN',
      action: 'COUPON_CREATED',
      entityType: 'COUPON',
      entityId: created.id,
      newState: created,
      poolOverride: runner,
    });
    return created;
  }

  async updateCoupon(
    couponId: string,
    updates: {
      isActive?: boolean;
      usageLimit?: number | null;
      perUserLimit?: number | null;
      validTo?: string | null;
      title?: string;
    },
    actorId: string,
    runnerOverride?: pg.Pool
  ) {
    const runner = runnerOverride || getPool();
    const prevRes = await runner.query(`SELECT * FROM coupons WHERE id = $1`, [couponId]);
    if (prevRes.rows.length === 0) {
      throw new CouponPromotionError('COUPON_NOT_FOUND', `Coupon '${couponId}' not found.`, 404);
    }
    const prev = prevRes.rows[0];

    const res = await runner.query(
      `UPDATE coupons
          SET is_active = COALESCE($1, is_active),
              usage_limit = CASE WHEN $2::boolean THEN $3::int ELSE usage_limit END,
              per_user_limit = CASE WHEN $4::boolean THEN $5::int ELSE per_user_limit END,
              valid_to = CASE WHEN $6::boolean THEN $7::timestamptz ELSE valid_to END,
              title = COALESCE($8, title),
              updated_at = NOW()
        WHERE id = $9
        RETURNING *`,
      [
        updates.isActive ?? null,
        updates.usageLimit !== undefined,
        updates.usageLimit ?? null,
        updates.perUserLimit !== undefined,
        updates.perUserLimit ?? null,
        updates.validTo !== undefined,
        updates.validTo ?? null,
        updates.title ?? null,
        couponId,
      ]
    );

    await recordAuditEvent({
      actorId,
      actorType: 'ADMIN',
      action: 'COUPON_UPDATED',
      entityType: 'COUPON',
      entityId: couponId,
      oldState: prev,
      newState: res.rows[0],
      poolOverride: runner,
    });
    return res.rows[0];
  }

  async listPromotions(runnerOverride?: pg.Pool | pg.PoolClient) {
    const runner = runnerOverride || getPool();
    const res = await runner.query(`SELECT * FROM promotions ORDER BY priority ASC, created_at DESC`);
    return res.rows;
  }

  async createPromotion(
    params: {
      code: string;
      title: string;
      description?: string;
      promotionType: 'PERCENTAGE' | 'FLAT_AMOUNT' | 'CART_SLAB' | 'CATEGORY_DISCOUNT' | 'BOGO' | 'FREE_DELIVERY';
      discountValue?: number;
      maxDiscountInr?: number | null;
      minOrderValueInr?: number;
      minQuantity?: number;
      maxQuantity?: number | null;
      buyQuantity?: number | null;
      getQuantity?: number | null;
      applicableMerchantId?: string | null;
      applicableCategories?: string[];
      applicableProductIds?: string[];
      slabRules?: any[];
      firstOrderOnly?: boolean;
      priority?: number;
      conflictGroup?: string | null;
      isStackable?: boolean;
      stackableWithCoupons?: boolean;
      fundingSource?: DiscountFundingSource;
      sellerSharePercent?: number;
      usageLimit?: number | null;
      perUserLimit?: number | null;
      validFrom?: string;
      validTo?: string | null;
      actorId: string;
    },
    runnerOverride?: pg.Pool
  ) {
    const runner = runnerOverride || getPool();
    const cleanCode = params.code.trim().toUpperCase();
    const fundingSource: DiscountFundingSource = params.fundingSource || 'PLATFORM';
    const sellerSharePct =
      fundingSource === 'SELLER' ? 100 : fundingSource === 'PLATFORM' ? 0 : (params.sellerSharePercent ?? 50);

    const res = await runner.query(
      `INSERT INTO promotions (
        code, title, description, promotion_type, discount_value, max_discount_inr, min_order_value_inr,
        min_quantity, max_quantity, buy_quantity, get_quantity, applicable_merchant_id,
        applicable_categories, applicable_product_ids, slab_rules, first_order_only,
        priority, conflict_group, is_stackable, stackable_with_coupons,
        funding_source, seller_share_percent, usage_limit, per_user_limit, valid_from, valid_to, is_active, created_by
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
        $13::jsonb, $14::jsonb, $15::jsonb, $16,
        $17, $18, $19, $20, $21, $22, $23, $24,
        COALESCE($25::timestamptz, NOW()), $26::timestamptz, TRUE, $27
      )
      RETURNING *`,
      [
        cleanCode,
        params.title,
        params.description || params.title,
        params.promotionType,
        params.discountValue ?? 0,
        params.maxDiscountInr ?? null,
        params.minOrderValueInr ?? 0,
        params.minQuantity ?? 1,
        params.maxQuantity ?? null,
        params.buyQuantity ?? null,
        params.getQuantity ?? null,
        params.applicableMerchantId ?? null,
        JSON.stringify(params.applicableCategories || []),
        JSON.stringify(params.applicableProductIds || []),
        JSON.stringify(params.slabRules || []),
        Boolean(params.firstOrderOnly),
        params.priority ?? 100,
        params.conflictGroup ?? null,
        Boolean(params.isStackable),
        params.stackableWithCoupons ?? true,
        fundingSource,
        sellerSharePct,
        params.usageLimit ?? null,
        params.perUserLimit ?? null,
        params.validFrom || null,
        params.validTo || null,
        params.actorId || null,
      ]
    );

    const created = res.rows[0];
    await recordAuditEvent({
      actorId: params.actorId,
      actorType: 'ADMIN',
      action: 'PROMOTION_CREATED',
      entityType: 'PROMOTION',
      entityId: created.id,
      newState: created,
      poolOverride: runner,
    });
    return created;
  }

  async getDiscountFundingReport(runnerOverride?: pg.Pool | pg.PoolClient) {
    const runner = runnerOverride || getPool();
    const couponStats = await runner.query(
      `SELECT COUNT(*) AS total_redemptions,
              COALESCE(SUM(discount_amount), 0) AS total_discount,
              COALESCE(SUM(seller_share_amount), 0) AS seller_share,
              COALESCE(SUM(platform_share_amount), 0) AS platform_share,
              COALESCE(SUM(reversed_amount), 0) AS reversed_amount
         FROM coupon_redemptions
        WHERE status IN ('RESERVED', 'REDEEMED', 'REVERSED')`
    );
    const promoStats = await runner.query(
      `SELECT COUNT(*) AS total_applications,
              COALESCE(SUM(discount_amount), 0) AS total_discount,
              COALESCE(SUM(seller_share_amount), 0) AS seller_share,
              COALESCE(SUM(platform_share_amount), 0) AS platform_share,
              COALESCE(SUM(reversed_amount), 0) AS reversed_amount
         FROM promotion_applications
        WHERE status IN ('RESERVED', 'APPLIED', 'REVERSED')`
    );
    return {
      coupons: couponStats.rows[0],
      promotions: promoStats.rows[0],
    };
  }
}

export const couponPromotionService = new CouponPromotionService();
