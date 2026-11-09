import { CartItem } from '../types';

export interface DistanceSlabConfig {
  minMeters: number;
  maxMeters: number;
  fee: number;
}

export interface LongDistanceRuleConfig {
  thresholdMeters: number;
  baseFee: number;
  additionalFeePerStep: number;
  stepMeters: number;
}

export interface DeliveryPricingConfig {
  free_delivery_threshold: number; // default 499
  distance_slabs: DistanceSlabConfig[];
  long_distance_rules: LongDistanceRuleConfig;
  delivery_pricing_rule_version: string;
}

export const DEFAULT_DELIVERY_PRICING_CONFIG: DeliveryPricingConfig = {
  free_delivery_threshold: 499,
  distance_slabs: [
    { minMeters: 0, maxMeters: 2000, fee: 29 },
    { minMeters: 2001, maxMeters: 4000, fee: 39 },
    { minMeters: 4001, maxMeters: 6000, fee: 49 },
  ],
  long_distance_rules: {
    thresholdMeters: 6000,
    baseFee: 49,
    additionalFeePerStep: 10,
    stepMeters: 1000,
  },
  delivery_pricing_rule_version: 'v1.0.0-qcom-2026',
};

export interface DeliveryFeeCalculationParams {
  eligibleCartValue: number;
  actualRouteDistanceMeters?: number;
  segmentDistancesMeters?: number[];
  config?: DeliveryPricingConfig;
}

export interface DeliveryFeeResult {
  eligible_cart_value: number;
  free_delivery_threshold: number;
  is_free_delivery: boolean;
  amount_remaining_for_free_delivery: number;
  actual_route_distance_m: number;
  rounded_route_distance_m: number;
  customer_delivery_fee: number;
  delivery_pricing_rule_version: string;
  applied_slab: string;
}

/**
 * Calculates eligible cart value for free-delivery determination.
 * eligible_cart_value = product selling price × quantity − seller-funded discounts
 * 
 * Note: Do NOT include delivery fee, payment gateway fee, GST/taxes, or platform-funded coupons.
 */
export function calculateEligibleCartValue(
  items: Array<{ product?: { price: number }; price?: number; quantity: number }>,
  sellerFundedDiscounts: number = 0
): number {
  if (!items || !Array.isArray(items) || items.length === 0) return 0;

  const rawSubtotal = items.reduce((sum, item) => {
    const unitPrice = item.product?.price ?? item.price ?? 0;
    const qty = Number(item.quantity) || 1;
    return sum + (unitPrice * qty);
  }, 0);

  const eligibleValue = Math.max(0, rawSubtotal - (Number(sellerFundedDiscounts) || 0));
  return eligibleValue;
}

/**
 * Rounds actual route distance in metres to the nearest 100 metres using standard mathematical rounding.
 * Formula: floor((actual_distance_m + 50) / 100) * 100
 * 
 * Examples:
 * 2,110 m → 2,100 m
 * 2,149 m → 2,100 m
 * 2,150 m → 2,200 m
 * 2,151 m → 2,200 m
 * 2,199 m → 2,200 m
 * 2,200 m → 2,200 m
 * 2,249 m → 2,200 m
 * 2,250 m → 2,300 m
 */
export function roundDistanceToNearest100m(actualDistanceMeters: number): number {
  const distanceM = Math.max(0, Number(actualDistanceMeters) || 0);
  return Math.floor((distanceM + 50) / 100) * 100;
}

/**
 * Sums actual segment distances first, then rounds the TOTAL distance to nearest 100m.
 */
export function calculateTotalRouteDistance(segmentDistancesMeters: number[]): {
  actualTotalMeters: number;
  roundedTotalMeters: number;
} {
  const actualTotalMeters = (segmentDistancesMeters || []).reduce(
    (sum, d) => sum + Math.max(0, Number(d) || 0),
    0
  );
  const roundedTotalMeters = roundDistanceToNearest100m(actualTotalMeters);
  return { actualTotalMeters, roundedTotalMeters };
}

/**
 * Core calculation method for customer delivery fee.
 */
export function calculateCustomerDeliveryFee(
  params: DeliveryFeeCalculationParams
): DeliveryFeeResult {
  const currentConfig = params.config || DEFAULT_DELIVERY_PRICING_CONFIG;
  const eligibleCartValue = Math.max(0, Number(params.eligibleCartValue) || 0);
  const threshold = currentConfig.free_delivery_threshold;

  // Compute total actual distance from segments or direct parameter
  let actualMeters = 0;
  if (params.segmentDistancesMeters && params.segmentDistancesMeters.length > 0) {
    actualMeters = params.segmentDistancesMeters.reduce(
      (sum, d) => sum + Math.max(0, Number(d) || 0),
      0
    );
  } else {
    actualMeters = Math.max(0, Number(params.actualRouteDistanceMeters) || 0);
  }

  const roundedMeters = roundDistanceToNearest100m(actualMeters);
  const isFreeDelivery = eligibleCartValue >= threshold;
  const amountRemaining = isFreeDelivery ? 0 : Math.max(0, threshold - eligibleCartValue);

  if (isFreeDelivery) {
    return {
      eligible_cart_value: eligibleCartValue,
      free_delivery_threshold: threshold,
      is_free_delivery: true,
      amount_remaining_for_free_delivery: 0,
      actual_route_distance_m: actualMeters,
      rounded_route_distance_m: roundedMeters,
      customer_delivery_fee: 0,
      delivery_pricing_rule_version: currentConfig.delivery_pricing_rule_version,
      applied_slab: 'FREE_DELIVERY_THRESHOLD_EXCEEDED'
    };
  }

  // Calculate distance fee based on roundedMeters
  let calculatedFee = 0;
  let appliedSlab = '';

  // Check matching slab
  const matchedSlab = currentConfig.distance_slabs.find(
    s => roundedMeters >= s.minMeters && roundedMeters <= s.maxMeters
  );

  if (matchedSlab) {
    calculatedFee = matchedSlab.fee;
    appliedSlab = `${matchedSlab.minMeters}m - ${matchedSlab.maxMeters}m (₹${matchedSlab.fee})`;
  } else if (roundedMeters > currentConfig.long_distance_rules.thresholdMeters) {
    const longDist = currentConfig.long_distance_rules;
    const excessMeters = roundedMeters - longDist.thresholdMeters;
    const additionalSteps = Math.ceil(excessMeters / longDist.stepMeters);
    calculatedFee = longDist.baseFee + (additionalSteps * longDist.additionalFeePerStep);
    appliedSlab = `Long Distance >${longDist.thresholdMeters}m (Base ₹${longDist.baseFee} + ${additionalSteps}x₹${longDist.additionalFeePerStep})`;
  } else {
    // Fallback default slab
    calculatedFee = 29;
    appliedSlab = 'Default 0-2000m (₹29)';
  }

  return {
    eligible_cart_value: eligibleCartValue,
    free_delivery_threshold: threshold,
    is_free_delivery: false,
    amount_remaining_for_free_delivery: amountRemaining,
    actual_route_distance_m: actualMeters,
    rounded_route_distance_m: roundedMeters,
    customer_delivery_fee: calculatedFee,
    delivery_pricing_rule_version: currentConfig.delivery_pricing_rule_version,
    applied_slab: appliedSlab
  };
}

/**
 * Centralized Delivery Pricing Service Class
 */
class DeliveryPricingEngineService {
  private config: DeliveryPricingConfig = { ...DEFAULT_DELIVERY_PRICING_CONFIG };

  public getConfig(): DeliveryPricingConfig {
    return { 
      ...this.config,
      distance_slabs: this.config.distance_slabs.map(s => ({ ...s })),
      long_distance_rules: { ...this.config.long_distance_rules }
    };
  }

  public updateConfig(newConfig: Partial<DeliveryPricingConfig>): DeliveryPricingConfig {
    this.config = {
      ...this.config,
      ...newConfig,
      free_delivery_threshold: typeof newConfig.free_delivery_threshold === 'number'
        ? newConfig.free_delivery_threshold
        : this.config.free_delivery_threshold,
      distance_slabs: newConfig.distance_slabs 
        ? newConfig.distance_slabs.map(s => ({ ...s }))
        : this.config.distance_slabs,
      long_distance_rules: newConfig.long_distance_rules 
        ? { ...this.config.long_distance_rules, ...newConfig.long_distance_rules }
        : this.config.long_distance_rules,
      delivery_pricing_rule_version: newConfig.delivery_pricing_rule_version || `v1.${Date.now()}`
    };
    return this.getConfig();
  }

  public calculateEligibleCartValue(
    items: Array<{ product?: { price: number }; price?: number; quantity: number }>,
    sellerFundedDiscounts: number = 0
  ): number {
    return calculateEligibleCartValue(items, sellerFundedDiscounts);
  }

  public roundDistanceToNearest100m(actualDistanceMeters: number): number {
    return roundDistanceToNearest100m(actualDistanceMeters);
  }

  public calculateTotalRouteDistance(segmentDistancesMeters: number[]): {
    actualTotalMeters: number;
    roundedTotalMeters: number;
  } {
    return calculateTotalRouteDistance(segmentDistancesMeters);
  }

  public calculateCustomerDeliveryFee(
    params: DeliveryFeeCalculationParams
  ): DeliveryFeeResult {
    return calculateCustomerDeliveryFee({
      ...params,
      config: params.config || this.config
    });
  }
}

export const DeliveryPricingService = new DeliveryPricingEngineService();
