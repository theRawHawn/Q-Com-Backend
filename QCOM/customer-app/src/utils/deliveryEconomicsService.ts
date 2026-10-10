import { HardwareProduct } from '../types';

// =============================================================================
// DELIVERY ECONOMICS CONFIGURATION INTERFACES (Admin-Controlled)
// =============================================================================

export interface RiderPayoutConfig {
  base_payout: number; // Base fee for rider (e.g. ₹35)
  base_distance_m: number; // Distance covered under base fee (e.g. 2000m)
  per_km_rate: number; // Rate per km beyond base distance (e.g. ₹8/km)
  time_rate_per_min: number; // Time payout per minute of transit (e.g. ₹0.5/min)
  multi_pickup_incentive: number; // Incentive for extra seller pickup stops (e.g. ₹20)
  rain_or_surge_incentive: number; // Dynamic operational weather/surge incentive (e.g. ₹0)
  batching_cost_reduction_pct: number; // Payout reduction % when batched (e.g. 35%)
}

export interface VariableCostsConfig {
  payment_gateway_fee_pct: number; // e.g. 1.8% for card/UPI/PG
  payment_gateway_fixed_fee: number; // e.g. ₹2.0
  operational_telephony_sms_fee: number; // OTP/SMS/telephony variable cost e.g. ₹1.5
  packaging_material_variable_fee: number; // e.g. ₹2.0
  platform_funded_discount_absorption_pct: number; // % of promo code absorbed by platform (e.g. 100%)
}

export interface ContributionTargetsConfig {
  minimum_contribution_amount: number; // Configurable e.g. ₹0, ₹5, ₹10
  minimum_contribution_percentage: number; // Configurable e.g. 0%, 2%
  allow_promotional_negative_contribution: boolean; // Configurable e.g. true for growth/promo campaigns
  max_delivery_subsidy_amount: number; // Configurable maximum allowable subsidy (e.g. ₹60)
  maximum_customer_delivery_charge: number; // Customer protection cap (e.g. ₹69)
}

export interface BatchingConfig {
  enabled: boolean;
  max_seller_separation_distance_m: number; // Max distance between 2 sellers for multi-pickup (e.g. 2500m)
  max_customer_separation_distance_m: number; // Max distance between 2 customers for batched drop (e.g. 1500m)
  max_route_extension_mins: number; // Max allowable detour delay in mins (e.g. 6 mins)
}

export interface DeliveryEconomicsAdminConfig {
  rider_payout: RiderPayoutConfig;
  variable_costs: VariableCostsConfig;
  contribution_targets: ContributionTargetsConfig;
  batching: BatchingConfig;
  rule_priority: ('promotion' | 'product' | 'seller' | 'brand' | 'category' | 'global')[];
  economics_rule_version: string;
}

// Default Server-Side Delivery Economics Configuration
export const DEFAULT_DELIVERY_ECONOMICS_CONFIG: DeliveryEconomicsAdminConfig = {
  rider_payout: {
    base_payout: 35,
    base_distance_m: 2000,
    per_km_rate: 8.0,
    time_rate_per_min: 0.5,
    multi_pickup_incentive: 20,
    rain_or_surge_incentive: 15.0,
    batching_cost_reduction_pct: 35.0
  },
  variable_costs: {
    payment_gateway_fee_pct: 1.8,
    payment_gateway_fixed_fee: 2.0,
    operational_telephony_sms_fee: 1.5,
    packaging_material_variable_fee: 2.0,
    platform_funded_discount_absorption_pct: 100.0
  },
  contribution_targets: {
    minimum_contribution_amount: 5.0, // Target minimum ₹5 positive contribution per order
    minimum_contribution_percentage: 1.0, // Target 1.0% margin
    allow_promotional_negative_contribution: true, // Allow controlled promotional subsidies up to max limit
    max_delivery_subsidy_amount: 55.0, // Cap delivery subsidy at ₹55
    maximum_customer_delivery_charge: 69.0 // Customer experience ceiling
  },
  batching: {
    enabled: true,
    max_seller_separation_distance_m: 2500,
    max_customer_separation_distance_m: 1500,
    max_route_extension_mins: 6
  },
  rule_priority: ['promotion', 'product', 'seller', 'brand', 'category', 'global'],
  economics_rule_version: 'v2.0.0-qcom-econ-2026'
};

// =============================================================================
// CALCULATION RESULT INTERFACES
// =============================================================================

export interface DeliveryCostBreakdown {
  actualDeliveryCost: number;
  basePayout: number;
  distancePayout: number;
  timePayout: number;
  multiPickupPayout: number;
  surgeIncentive: number;
  batchingSavings: number;
  isBatched: boolean;
}

export interface VariableCostsBreakdown {
  riderDeliveryCost: number;
  paymentGatewayFee: number;
  telephonyAndSmsFee: number;
  packagingFee: number;
  platformFundedDiscounts: number;
  otherVariableCosts: number;
  totalVariableCosts: number;
}

export interface QcomRevenueBreakdown {
  commissionAmount: number;
  handlingRevenue: number;
  customerDeliveryRevenue: number;
  otherQcomRevenue: number;
  totalQcomRevenue: number;
}

export interface OrderContributionResult {
  qcomRevenue: QcomRevenueBreakdown;
  variableCosts: VariableCostsBreakdown;
  deliveryCost: DeliveryCostBreakdown;
  deliverySubsidy: number; // actual_delivery_cost - customer_delivery_revenue
  orderContribution: number; // totalQcomRevenue - totalVariableCosts
  contributionMarginPct: number; // (orderContribution / sellerPrice) * 100
  isContributionPositive: boolean;
  meetsContributionTarget: boolean;
  isViable: boolean;
  viabilityStatus: 'positive_contribution' | 'promotional_subsidized' | 'uneconomical_unviable';
  rejectionReason?: string;
}

export interface MultiSellerRouteEconomics {
  sellerCount: number;
  canSingleRiderFulfil: boolean;
  totalRouteDistanceMeters: number;
  totalDurationMinutes: number;
  totalInternalDeliveryCost: number;
  standaloneEquivalentCost: number;
  efficiencySavings: number;
  recommendedCustomerDeliveryCharge: number;
}

// =============================================================================
// CENTRALIZED DELIVERY ECONOMICS SERVICE
// =============================================================================

class CentralizedDeliveryEconomicsService {
  private config: DeliveryEconomicsAdminConfig = { ...DEFAULT_DELIVERY_ECONOMICS_CONFIG };

  // ---------------------------------------------------------------------------
  // CONFIGURATION MANAGEMENT
  // ---------------------------------------------------------------------------

  public getConfig(): DeliveryEconomicsAdminConfig {
    return {
      ...this.config,
      rider_payout: { ...this.config.rider_payout },
      variable_costs: { ...this.config.variable_costs },
      contribution_targets: { ...this.config.contribution_targets },
      batching: { ...this.config.batching },
      rule_priority: [...this.config.rule_priority]
    };
  }

  public updateConfig(updates: Partial<DeliveryEconomicsAdminConfig>): DeliveryEconomicsAdminConfig {
    if (updates.rider_payout) {
      this.config.rider_payout = { ...this.config.rider_payout, ...updates.rider_payout };
    }
    if (updates.variable_costs) {
      this.config.variable_costs = { ...this.config.variable_costs, ...updates.variable_costs };
    }
    if (updates.contribution_targets) {
      this.config.contribution_targets = { ...this.config.contribution_targets, ...updates.contribution_targets };
    }
    if (updates.batching) {
      this.config.batching = { ...this.config.batching, ...updates.batching };
    }
    if (Array.isArray(updates.rule_priority)) {
      this.config.rule_priority = [...updates.rule_priority];
    }
    if (updates.economics_rule_version) {
      this.config.economics_rule_version = updates.economics_rule_version;
    }
    return this.getConfig();
  }

  // ---------------------------------------------------------------------------
  // 1. ACTUAL INTERNAL DELIVERY COST (Rider Payout) CALCULATION
  // Note: Internal operational cost, NOT exposed to customer.
  // ---------------------------------------------------------------------------

  public calculateActualDeliveryCost(params: {
    actualRouteDistanceMeters: number;
    estimatedTransitMinutes?: number;
    sellerPickupCount?: number;
    isBatched?: boolean;
    hasSurge?: boolean;
    isRainOrAdverseWeather?: boolean;
    isPeakHour?: boolean;
    isNightDelivery?: boolean;
  }): DeliveryCostBreakdown {
    const rp = this.config.rider_payout;
    const distanceM = Math.max(0, params.actualRouteDistanceMeters);
    const sellerCount = Math.max(1, params.sellerPickupCount || 1);
    
    // Estimate transit minutes if not provided (assume 22 km/h + 2 min buffer)
    const transitMins = params.estimatedTransitMinutes ?? Math.max(4, Math.round((distanceM / 1000) * 2.72 + 2));

    const basePayout = rp.base_payout;
    
    // Incremental distance beyond base distance
    const extraDistanceM = Math.max(0, distanceM - rp.base_distance_m);
    const distancePayout = Math.round((extraDistanceM / 1000) * rp.per_km_rate * 100) / 100;

    // Time payout
    const timePayout = Math.round(transitMins * rp.time_rate_per_min * 100) / 100;

    // Multi-pickup incentive (for additional seller stops)
    const multiPickupPayout = Math.max(0, sellerCount - 1) * rp.multi_pickup_incentive;

    // Surge/weather incentive
    const hasAnySurge = Boolean(
      params.hasSurge || 
      params.isRainOrAdverseWeather || 
      params.isPeakHour || 
      params.isNightDelivery
    );
    const surgeIncentive = hasAnySurge ? (rp.rain_or_surge_incentive || 15) : 0;

    const standaloneTotal = basePayout + distancePayout + timePayout + multiPickupPayout + surgeIncentive;

    // Batching optimization
    let batchingSavings = 0;
    let finalDeliveryCost = standaloneTotal;

    if (params.isBatched && this.config.batching.enabled) {
      batchingSavings = Math.round(standaloneTotal * (rp.batching_cost_reduction_pct / 100) * 100) / 100;
      finalDeliveryCost = Math.max(basePayout * 0.65, standaloneTotal - batchingSavings);
    }

    return {
      actualDeliveryCost: Math.round(finalDeliveryCost * 100) / 100,
      basePayout,
      distancePayout,
      timePayout,
      multiPickupPayout,
      surgeIncentive,
      batchingSavings,
      isBatched: Boolean(params.isBatched)
    };
  }

  // ---------------------------------------------------------------------------
  // 2. DELIVERY SUBSIDY CALCULATION
  // delivery_subsidy = actual_delivery_cost - customer_delivery_revenue
  // ---------------------------------------------------------------------------

  public calculateDeliverySubsidy(actualDeliveryCost: number, customerDeliveryRevenue: number): number {
    return Math.max(0, Math.round((actualDeliveryCost - customerDeliveryRevenue) * 100) / 100);
  }

  // ---------------------------------------------------------------------------
  // 3. QCOM REVENUE CALCULATION
  // QCOM Revenue = Commission + Handling Revenue + Customer Delivery Revenue + Other Revenue
  // ---------------------------------------------------------------------------

  public calculateQcomRevenue(params: {
    commissionAmount: number;
    handlingRevenue: number;
    customerDeliveryRevenue: number;
    otherRevenue?: number;
  }): QcomRevenueBreakdown {
    const comm = Math.max(0, params.commissionAmount);
    const handling = Math.max(0, params.handlingRevenue);
    const deliv = Math.max(0, params.customerDeliveryRevenue);
    const other = Math.max(0, params.otherRevenue || 0);

    return {
      commissionAmount: Math.round(comm * 100) / 100,
      handlingRevenue: Math.round(handling * 100) / 100,
      customerDeliveryRevenue: Math.round(deliv * 100) / 100,
      otherQcomRevenue: Math.round(other * 100) / 100,
      totalQcomRevenue: Math.round((comm + handling + deliv + other) * 100) / 100
    };
  }

  // ---------------------------------------------------------------------------
  // 4. VARIABLE COSTS CALCULATION
  // Variable Costs = Rider Payout + Payment Gateway + Discounts + Operational Fees
  // ---------------------------------------------------------------------------

  public calculateVariableCosts(params: {
    actualDeliveryCost: number;
    finalCustomerPayable: number;
    platformFundedCouponDiscount?: number;
  }): VariableCostsBreakdown {
    const vc = this.config.variable_costs;
    const payable = Math.max(0, params.finalCustomerPayable);
    
    // Payment Gateway processing cost
    const pgFee = Math.round((payable * (vc.payment_gateway_fee_pct / 100) + vc.payment_gateway_fixed_fee) * 100) / 100;
    
    // Telephony / SMS / Notification variable cost
    const telFee = vc.operational_telephony_sms_fee;
    
    // Packaging material variable fee
    const packFee = vc.packaging_material_variable_fee;

    // Platform-funded coupon discount (absorbed directly from order margin)
    const platformDiscounts = Math.round(
      (params.platformFundedCouponDiscount || 0) * (vc.platform_funded_discount_absorption_pct / 100) * 100
    ) / 100;

    const otherVariableCosts = Math.round((telFee + packFee) * 100) / 100;
    const totalVariableCosts = Math.round((params.actualDeliveryCost + pgFee + otherVariableCosts + platformDiscounts) * 100) / 100;

    return {
      riderDeliveryCost: params.actualDeliveryCost,
      paymentGatewayFee: pgFee,
      telephonyAndSmsFee: telFee,
      packagingFee: packFee,
      platformFundedDiscounts: platformDiscounts,
      otherVariableCosts,
      totalVariableCosts
    };
  }

  // ---------------------------------------------------------------------------
  // 5. ORDER CONTRIBUTION CALCULATION & VIABILITY EVALUATION
  // Order Contribution = QCOM Revenue - Variable Costs
  // ---------------------------------------------------------------------------

  public evaluateOrderContribution(params: {
    sellerPrice: number;
    commissionAmount: number;
    handlingRevenue: number;
    customerDeliveryRevenue: number;
    actualDeliveryCost: number;
    finalCustomerPayable: number;
    platformFundedCouponDiscount?: number;
    otherQcomRevenue?: number;
  }): OrderContributionResult {
    const qcomRevenue = this.calculateQcomRevenue({
      commissionAmount: params.commissionAmount,
      handlingRevenue: params.handlingRevenue,
      customerDeliveryRevenue: params.customerDeliveryRevenue,
      otherRevenue: params.otherQcomRevenue
    });

    const variableCosts = this.calculateVariableCosts({
      actualDeliveryCost: params.actualDeliveryCost,
      finalCustomerPayable: params.finalCustomerPayable,
      platformFundedCouponDiscount: params.platformFundedCouponDiscount
    });

    const deliveryCostBreakdown: DeliveryCostBreakdown = {
      actualDeliveryCost: params.actualDeliveryCost,
      basePayout: this.config.rider_payout.base_payout,
      distancePayout: Math.max(0, params.actualDeliveryCost - this.config.rider_payout.base_payout),
      timePayout: 0,
      multiPickupPayout: 0,
      surgeIncentive: 0,
      batchingSavings: 0,
      isBatched: false
    };

    const deliverySubsidy = this.calculateDeliverySubsidy(params.actualDeliveryCost, params.customerDeliveryRevenue);
    
    // Core formula: QCOM Revenue - Total Variable Costs
    const orderContribution = Math.round((qcomRevenue.totalQcomRevenue - variableCosts.totalVariableCosts) * 100) / 100;
    
    const sellerPrice = Math.max(1, params.sellerPrice);
    const contributionMarginPct = Math.round((orderContribution / sellerPrice) * 10000) / 100;

    const targets = this.config.contribution_targets;
    const isContributionPositive = orderContribution >= 0;
    
    const meetsContributionTarget = 
      orderContribution >= targets.minimum_contribution_amount &&
      contributionMarginPct >= targets.minimum_contribution_percentage;

    // Viability decision
    let isViable = false;
    let viabilityStatus: OrderContributionResult['viabilityStatus'] = 'uneconomical_unviable';
    let rejectionReason: string | undefined = undefined;

    if (meetsContributionTarget || isContributionPositive) {
      isViable = true;
      viabilityStatus = 'positive_contribution';
    } else if (
      targets.allow_promotional_negative_contribution &&
      deliverySubsidy <= targets.max_delivery_subsidy_amount &&
      orderContribution >= -targets.max_delivery_subsidy_amount
    ) {
      // Approved promotional subsidy
      isViable = true;
      viabilityStatus = 'promotional_subsidized';
    } else {
      isViable = false;
      viabilityStatus = 'uneconomical_unviable';
      rejectionReason = `Order contribution (₹${orderContribution}) falls below minimum threshold (₹${targets.minimum_contribution_amount}) and exceeds allowable subsidy (₹${targets.max_delivery_subsidy_amount})`;
    }

    return {
      qcomRevenue,
      variableCosts,
      deliveryCost: deliveryCostBreakdown,
      deliverySubsidy,
      orderContribution,
      contributionMarginPct,
      isContributionPositive,
      meetsContributionTarget,
      isViable,
      viabilityStatus,
      rejectionReason
    };
  }

  // ---------------------------------------------------------------------------
  // 6. MULTI-SELLER CART ROUTE & DELIVERY ECONOMICS
  // Evaluates single rider multi-pickup vs multi-rider dispatch
  // ---------------------------------------------------------------------------

  public evaluateMultiSellerCart(params: {
    sellerLocations: { sellerId: string; coordinates: { lat: number; lng: number } }[];
    customerLocation: { lat: number; lng: number };
    totalItemsSubtotal: number;
  }): MultiSellerRouteEconomics {
    const sellerCount = params.sellerLocations.length;
    if (sellerCount <= 1) {
      const dist = 2000;
      const cost = this.calculateActualDeliveryCost({ actualRouteDistanceMeters: dist });
      return {
        sellerCount: 1,
        canSingleRiderFulfil: true,
        totalRouteDistanceMeters: dist,
        totalDurationMinutes: 15,
        totalInternalDeliveryCost: cost.actualDeliveryCost,
        standaloneEquivalentCost: cost.actualDeliveryCost,
        efficiencySavings: 0,
        recommendedCustomerDeliveryCharge: 29
      };
    }

    // Check proximity among sellers
    let maxInterSellerDistanceMeters = 0;
    for (let i = 0; i < sellerCount; i++) {
      for (let j = i + 1; j < sellerCount; j++) {
        const d = this.calculateStraightLineDistance(
          params.sellerLocations[i].coordinates,
          params.sellerLocations[j].coordinates
        );
        if (d > maxInterSellerDistanceMeters) {
          maxInterSellerDistanceMeters = d;
        }
      }
    }

    const canSingleRiderFulfil = maxInterSellerDistanceMeters <= this.config.batching.max_seller_separation_distance_m;

    let totalInternalDeliveryCost = 0;
    let standaloneEquivalentCost = 0;
    let totalRouteDistanceMeters = 0;
    let totalDurationMinutes = 0;

    if (canSingleRiderFulfil) {
      // Single rider does sequential pickups then delivers to customer
      totalRouteDistanceMeters = Math.round(maxInterSellerDistanceMeters * 1.3 + 3000);
      totalDurationMinutes = Math.round((totalRouteDistanceMeters / 1000) * 2.8 + sellerCount * 3);
      
      const cost = this.calculateActualDeliveryCost({
        actualRouteDistanceMeters: totalRouteDistanceMeters,
        estimatedTransitMinutes: totalDurationMinutes,
        sellerPickupCount: sellerCount
      });
      totalInternalDeliveryCost = cost.actualDeliveryCost;
      standaloneEquivalentCost = sellerCount * 45; // If dispatched separately
    } else {
      // Separate riders required
      totalInternalDeliveryCost = sellerCount * 42;
      standaloneEquivalentCost = totalInternalDeliveryCost;
      totalRouteDistanceMeters = sellerCount * 2800;
      totalDurationMinutes = 20;
    }

    const efficiencySavings = Math.max(0, standaloneEquivalentCost - totalInternalDeliveryCost);
    
    // Customer delivery charge is kept reasonable (NOT multiplied by seller count!)
    const recommendedCustomerDeliveryCharge = Math.min(
      this.config.contribution_targets.maximum_customer_delivery_charge,
      Math.round(29 + (sellerCount - 1) * 10)
    );

    return {
      sellerCount,
      canSingleRiderFulfil,
      totalRouteDistanceMeters,
      totalDurationMinutes,
      totalInternalDeliveryCost,
      standaloneEquivalentCost,
      efficiencySavings,
      recommendedCustomerDeliveryCharge
    };
  }

  /**
   * Helper Haversine distance
   */
  private calculateStraightLineDistance(
    coords1: { lat: number; lng: number },
    coords2: { lat: number; lng: number }
  ): number {
    const R = 6371000;
    const dLat = ((coords2.lat - coords1.lat) * Math.PI) / 180;
    const dLon = ((coords2.lng - coords1.lng) * Math.PI) / 180;
    const lat1 = (coords1.lat * Math.PI) / 180;
    const lat2 = (coords2.lat * Math.PI) / 180;

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.sin(dLon / 2) * Math.sin(dLon / 2) * Math.cos(lat1) * Math.cos(lat2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return Math.round(R * c);
  }
}

export const DeliveryEconomicsService = new CentralizedDeliveryEconomicsService();
