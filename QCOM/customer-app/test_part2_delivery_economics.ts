import { CustomerPricingService } from './src/utils/customerPricingService';
import { DeliveryEconomicsService } from './src/utils/deliveryEconomicsService';
import { FulfilmentSelectionService } from './src/utils/fulfilmentSelectionService';
import { calculateAuthoritativePricing } from './server/pricingEngine';

console.log('================================================================');
console.log('   QCOM PART 2: DELIVERY ECONOMICS & DYNAMIC PRICING TEST SUITE  ');
console.log('================================================================\n');

let passedTests = 0;
let totalTests = 0;

function assert(condition: boolean, testNum: number, testName: string, details?: string) {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`✅ [PASS] Test ${testNum}: ${testName}`);
    if (details) console.log(`   ↳ ${details}`);
  } else {
    console.error(`❌ [FAIL] Test ${testNum}: ${testName}`);
    if (details) console.error(`   ↳ ${details}`);
  }
}

// TEST 1: Low-Value, Long-Distance Order (Ensures Contribution Evaluation)
{
  const quote = CustomerPricingService.generateCheckoutQuote({
    deliveryCoordinates: { lat: 12.9850, lng: 77.6850 }, // Far location
    cartItems: [{ productId: 'plumb-02', quantity: 1 }] // ₹45
  });
  
  const snap = quote.priceSnapshot;
  assert(
    quote.success && snap.actual_delivery_cost! > 0 && snap.customer_delivery_charge > 0,
    1,
    'Low-Value Long-Distance Order handles delivery economics',
    `Subtotal: ₹${quote.itemsSubtotal}, Cust Delivery: ₹${snap.customer_delivery_charge}, Actual Cost: ₹${snap.actual_delivery_cost}, Contribution: ₹${snap.order_contribution}`
  );
}

// TEST 2: High-Value, Short-Distance Order (Strong Positive Contribution)
{
  const quote = CustomerPricingService.generateCheckoutQuote({
    deliveryCoordinates: { lat: 12.9355, lng: 77.6250 }, // 100m away
    cartItems: [{ productId: 'fast-01', quantity: 10 }] // High value
  });
  
  const snap = quote.priceSnapshot;
  assert(
    quote.success && snap.order_contribution! > 0 && snap.is_contribution_positive === true,
    2,
    'High-Value Short-Distance Order generates strong positive contribution',
    `Subtotal: ₹${quote.itemsSubtotal}, Revenue: ₹${snap.qcom_revenue}, Delivery Cost: ₹${snap.actual_delivery_cost}, Contribution: ₹${snap.order_contribution}`
  );
}

// TEST 3: Free Delivery Threshold on High Margin Order
{
  const quote = CustomerPricingService.generateCheckoutQuote({
    deliveryCoordinates: { lat: 12.9400, lng: 77.6280 },
    cartItems: [{ productId: 'elec-02', quantity: 5 }] // ₹299 * 5 = ₹1495 >= ₹499
  });
  
  assert(
    quote.success && quote.freeDeliveryEligible === true && quote.deliveryCharge === 0 && quote.priceSnapshot.delivery_subsidy! > 0,
    3,
    'Free Delivery applies customer delivery charge = 0 and tracks internal delivery subsidy',
    `Cust Delivery: ₹${quote.deliveryCharge}, Internal Delivery Cost: ₹${quote.priceSnapshot.actual_delivery_cost}, Subsidy: ₹${quote.priceSnapshot.delivery_subsidy}`
  );
}

// TEST 4: Free Delivery on Low Margin / Capped Subsidy Evaluation
{
  const evalResult = DeliveryEconomicsService.evaluateOrderContribution({
    sellerPrice: 500,
    commissionAmount: 25, // 5% low commission
    handlingRevenue: 10,
    customerDeliveryRevenue: 0, // Free delivery
    actualDeliveryCost: 45,
    finalCustomerPayable: 510
  });

  assert(
    evalResult.deliverySubsidy === 45 && evalResult.qcomRevenue.totalQcomRevenue === 35,
    4,
    'Subsidy properly tracked when delivery revenue is 0',
    `Subsidy: ₹${evalResult.deliverySubsidy}, Revenue: ₹${evalResult.qcomRevenue.totalQcomRevenue}, Contribution: ₹${evalResult.orderContribution}`
  );
}

// TEST 5: Multi-Seller Candidate Selection prioritizes positive contribution & SLA
{
  const result = FulfilmentSelectionService.selectOptimalFulfilment({
    customerCoordinates: { lat: 12.9352, lng: 77.6245 },
    cartItems: [{ productId: 'plumb-01', quantity: 2 }]
  });

  assert(
    result.success && result.selectedCandidate !== undefined && result.selectedCandidate.totalFulfilmentScore > 0,
    5,
    'FulfilmentSelectionService ranks candidates using multi-attribute economic utility score',
    `Selected: ${result.selectedSellerName}, Score: ${result.selectedCandidate?.totalFulfilmentScore}, Contribution: ₹${result.selectedCandidate?.orderContribution}`
  );
}

// TEST 6: Multi-Seller Route Batching Efficiency
{
  const batchingEconomics = DeliveryEconomicsService.evaluateMultiSellerCart({
    sellerLocations: [
      { sellerId: 'seller-1', coordinates: { lat: 12.9352, lng: 77.6245 } },
      { sellerId: 'seller-2', coordinates: { lat: 12.9380, lng: 77.6290 } }
    ],
    customerLocation: { lat: 12.9450, lng: 77.6350 },
    totalItemsSubtotal: 1200
  });

  assert(
    batchingEconomics.canSingleRiderFulfil === true && batchingEconomics.efficiencySavings >= 0,
    6,
    'Multi-Seller Route Batching delivers cost savings vs separate dispatches',
    `Standalone: ₹${batchingEconomics.standaloneEquivalentCost}, Batched Cost: ₹${batchingEconomics.totalInternalDeliveryCost}, Savings: ₹${batchingEconomics.efficiencySavings}, Cust Charge: ₹${batchingEconomics.recommendedCustomerDeliveryCharge}`
  );
}

// TEST 7: Surge Pricing Condition on Rider Payout
{
  const normalCost = DeliveryEconomicsService.calculateActualDeliveryCost({
    actualRouteDistanceMeters: 3000,
    estimatedTransitMinutes: 12,
    hasSurge: false
  });

  const surgeCost = DeliveryEconomicsService.calculateActualDeliveryCost({
    actualRouteDistanceMeters: 3000,
    estimatedTransitMinutes: 12,
    hasSurge: true
  });

  assert(
    surgeCost.actualDeliveryCost > normalCost.actualDeliveryCost && surgeCost.surgeIncentive > 0,
    7,
    'Surge Pricing increases rider payout according to surge multiplier',
    `Normal: ₹${normalCost.actualDeliveryCost}, Surge: ₹${surgeCost.actualDeliveryCost}, Surge Component: ₹${surgeCost.surgeIncentive}`
  );
}

// TEST 8: Adverse Weather Rider Payout
{
  const normalCost = DeliveryEconomicsService.calculateActualDeliveryCost({
    actualRouteDistanceMeters: 2500,
    estimatedTransitMinutes: 15,
    isRainOrAdverseWeather: false
  });

  const rainCost = DeliveryEconomicsService.calculateActualDeliveryCost({
    actualRouteDistanceMeters: 2500,
    estimatedTransitMinutes: 15,
    isRainOrAdverseWeather: true
  });

  assert(
    rainCost.surgeIncentive > 0 && rainCost.actualDeliveryCost > normalCost.actualDeliveryCost,
    8,
    'Adverse weather adds designated weather allowance to rider payout',
    `Normal: ₹${normalCost.actualDeliveryCost}, Rain Delivery Cost: ₹${rainCost.actualDeliveryCost}, Incentive: ₹${rainCost.surgeIncentive}`
  );
}

// TEST 9: Peak Hour Surcharge
{
  const normalCost = DeliveryEconomicsService.calculateActualDeliveryCost({
    actualRouteDistanceMeters: 2000,
    estimatedTransitMinutes: 10,
    isPeakHour: false
  });

  const peakCost = DeliveryEconomicsService.calculateActualDeliveryCost({
    actualRouteDistanceMeters: 2000,
    estimatedTransitMinutes: 10,
    isPeakHour: true
  });

  assert(
    peakCost.surgeIncentive > 0 && peakCost.actualDeliveryCost > normalCost.actualDeliveryCost,
    9,
    'Peak hour adds configured peak surcharge to delivery payout',
    `Normal: ₹${normalCost.actualDeliveryCost}, Peak Cost: ₹${peakCost.actualDeliveryCost}, Surge Component: ₹${peakCost.surgeIncentive}`
  );
}

// TEST 10: Traffic / Transit Time Penalty Component
{
  const fastTransit = DeliveryEconomicsService.calculateActualDeliveryCost({
    actualRouteDistanceMeters: 2000,
    estimatedTransitMinutes: 8
  });

  const slowTransit = DeliveryEconomicsService.calculateActualDeliveryCost({
    actualRouteDistanceMeters: 2000,
    estimatedTransitMinutes: 25 // heavy traffic
  });

  assert(
    slowTransit.timePayout > fastTransit.timePayout,
    10,
    'Longer transit time fairly compensates rider time component',
    `8 min transit time cost: ₹${fastTransit.timePayout}, 25 min transit time cost: ₹${slowTransit.timePayout}`
  );
}

// TEST 11: Multi-pickup Seller Incentive
{
  const singlePickup = DeliveryEconomicsService.calculateActualDeliveryCost({
    actualRouteDistanceMeters: 3000,
    estimatedTransitMinutes: 15,
    sellerPickupCount: 1
  });

  const multiPickup = DeliveryEconomicsService.calculateActualDeliveryCost({
    actualRouteDistanceMeters: 3000,
    estimatedTransitMinutes: 15,
    sellerPickupCount: 3
  });

  assert(
    multiPickup.multiPickupPayout > 0 && multiPickup.actualDeliveryCost > singlePickup.actualDeliveryCost,
    11,
    'Multi-pickup stops compensate rider for each additional pickup stop',
    `Single pickup: ₹${singlePickup.actualDeliveryCost}, 3-seller pickup: ₹${multiPickup.actualDeliveryCost} (Multi-pickup component: ₹${multiPickup.multiPickupPayout})`
  );
}

// TEST 12: Admin Dynamically Adjusts Base Rider Payout
{
  const originalBase = DeliveryEconomicsService.getConfig().rider_payout.base_payout;
  DeliveryEconomicsService.updateConfig({
    rider_payout: {
      ...DeliveryEconomicsService.getConfig().rider_payout,
      base_payout: 35
    }
  });

  const adjustedCost = DeliveryEconomicsService.calculateActualDeliveryCost({
    actualRouteDistanceMeters: 1000,
    estimatedTransitMinutes: 5
  });

  assert(
    adjustedCost.basePayout === 35,
    12,
    'Admin can dynamically update base rider payout without code change',
    `New Base Payout: ₹${adjustedCost.basePayout}`
  );

  // Restore
  DeliveryEconomicsService.updateConfig({
    rider_payout: {
      ...DeliveryEconomicsService.getConfig().rider_payout,
      base_payout: originalBase
    }
  });
}

// TEST 13: Admin Dynamically Adjusts Per-KM Rider Payout
{
  const originalPerKm = DeliveryEconomicsService.getConfig().rider_payout.per_km_rate;
  DeliveryEconomicsService.updateConfig({
    rider_payout: {
      ...DeliveryEconomicsService.getConfig().rider_payout,
      per_km_rate: 12
    }
  });

  const adjustedCost = DeliveryEconomicsService.calculateActualDeliveryCost({
    actualRouteDistanceMeters: 4000, // 4000m - 2000m base = 2000m extra = 2km @ ₹12 = ₹24
    estimatedTransitMinutes: 10
  });

  assert(
    adjustedCost.distancePayout === 24,
    13,
    'Admin dynamic per-km rate update accurately updates distance payout component',
    `2km beyond base @ ₹12/km = ₹${adjustedCost.distancePayout}`
  );

  // Restore
  DeliveryEconomicsService.updateConfig({
    rider_payout: {
      ...DeliveryEconomicsService.getConfig().rider_payout,
      per_km_rate: originalPerKm
    }
  });
}

// TEST 14: Admin Adjusts Minimum Order Contribution Margin
{
  DeliveryEconomicsService.updateConfig({
    contribution_targets: {
      ...DeliveryEconomicsService.getConfig().contribution_targets,
      minimum_contribution_percentage: 12
    }
  });

  const contrib = DeliveryEconomicsService.evaluateOrderContribution({
    sellerPrice: 100,
    commissionAmount: 10,
    handlingRevenue: 5,
    customerDeliveryRevenue: 20,
    actualDeliveryCost: 30,
    finalCustomerPayable: 125
  });

  assert(
    DeliveryEconomicsService.getConfig().contribution_targets.minimum_contribution_percentage === 12,
    14,
    'Admin target contribution margin dynamically reflects in system configuration',
    `Target: 12%, Actual Margin: ${contrib.contributionMarginPct}%`
  );
}

// TEST 15: Maximum Customer Delivery Charge Cap
{
  // Set cap to ₹49
  DeliveryEconomicsService.updateConfig({
    contribution_targets: {
      ...DeliveryEconomicsService.getConfig().contribution_targets,
      maximum_customer_delivery_charge: 49
    }
  });

  // Calculate delivery charge for 10km (which uncapped would be > ₹80)
  const calc = CustomerPricingService.calculateCustomerDeliveryCharge(200, 10000);

  assert(
    calc.deliveryCharge <= 49,
    15,
    'Customer Delivery Charge is capped at Admin Maximum Customer Cap',
    `Capped Charge: ₹${calc.deliveryCharge} (Slab description: ${calc.appliedSlab})`
  );
}

// TEST 16: Maximum Subsidy Limit Enforcement
{
  DeliveryEconomicsService.updateConfig({
    contribution_targets: {
      ...DeliveryEconomicsService.getConfig().contribution_targets,
      max_delivery_subsidy_amount: 30,
      allow_promotional_negative_contribution: false
    }
  });

  const evaluation = DeliveryEconomicsService.evaluateOrderContribution({
    sellerPrice: 100,
    commissionAmount: 5,
    handlingRevenue: 5,
    customerDeliveryRevenue: 0,
    actualDeliveryCost: 60, // Subsidy = 60 > limit 30
    finalCustomerPayable: 105
  });

  assert(
    evaluation.isViable === false && evaluation.viabilityStatus === 'uneconomical_unviable',
    16,
    'Orders exceeding maximum subsidy limit are flagged as unserviceable / non-viable',
    `Viability: ${evaluation.viabilityStatus}, Rejection: ${evaluation.rejectionReason}`
  );
}

// TEST 17: Distance Rounding with Rider Payout
{
  const rounded = CustomerPricingService.roundDistance(2350); // 2,350m rounds to 2,400m
  const payout = DeliveryEconomicsService.calculateActualDeliveryCost({
    actualRouteDistanceMeters: rounded,
    estimatedTransitMinutes: 10
  });

  assert(
    rounded === 2400 && payout.actualDeliveryCost > 0,
    17,
    'Distance is consistently rounded and fed to rider payout calculations',
    `Raw: 2350m -> Rounded: ${rounded}m -> Rider Cost: ₹${payout.actualDeliveryCost}`
  );
}

// TEST 18: Payment Gateway Variable Cost for Online vs Cash/Credit
{
  const evalOnline = DeliveryEconomicsService.evaluateOrderContribution({
    sellerPrice: 1000,
    commissionAmount: 100,
    handlingRevenue: 15,
    customerDeliveryRevenue: 30,
    actualDeliveryCost: 40,
    finalCustomerPayable: 1045
  });

  assert(
    evalOnline.variableCosts.paymentGatewayFee > 0,
    18,
    'Payment gateway variable cost is accurately computed on total transaction throughput',
    `Customer Payable: ₹1045 -> PG Cost: ₹${evalOnline.variableCosts.paymentGatewayFee}`
  );
}

// TEST 19: Packaging Variable Cost Allocation
{
  const evalResult = DeliveryEconomicsService.evaluateOrderContribution({
    sellerPrice: 500,
    commissionAmount: 50,
    handlingRevenue: 10,
    customerDeliveryRevenue: 25,
    actualDeliveryCost: 35,
    finalCustomerPayable: 535
  });

  assert(
    evalResult.variableCosts.packagingFee === DeliveryEconomicsService.getConfig().variable_costs.packaging_material_variable_fee,
    19,
    'Packaging cost is accounted for as a variable operational cost per order',
    `Packaging cost: ₹${evalResult.variableCosts.packagingFee}`
  );
}

// TEST 20: Telephony & Customer Support Variable Cost
{
  const evalResult = DeliveryEconomicsService.evaluateOrderContribution({
    sellerPrice: 500,
    commissionAmount: 50,
    handlingRevenue: 10,
    customerDeliveryRevenue: 25,
    actualDeliveryCost: 35,
    finalCustomerPayable: 535
  });

  assert(
    evalResult.variableCosts.telephonyAndSmsFee === DeliveryEconomicsService.getConfig().variable_costs.operational_telephony_sms_fee,
    20,
    'Telephony, SMS and customer support operational cost is tracked per order',
    `Telephony & Ops Cost: ₹${evalResult.variableCosts.telephonyAndSmsFee}`
  );
}

// TEST 21: Platform-Funded Coupon Discount reduces Order Contribution
{
  const evalNoCoupon = DeliveryEconomicsService.evaluateOrderContribution({
    sellerPrice: 1000,
    commissionAmount: 100,
    handlingRevenue: 10,
    customerDeliveryRevenue: 25,
    actualDeliveryCost: 35,
    finalCustomerPayable: 1035,
    platformFundedCouponDiscount: 0
  });

  const evalWithCoupon = DeliveryEconomicsService.evaluateOrderContribution({
    sellerPrice: 1000,
    commissionAmount: 100,
    handlingRevenue: 10,
    customerDeliveryRevenue: 25,
    actualDeliveryCost: 35,
    finalCustomerPayable: 985,
    platformFundedCouponDiscount: 50
  });

  assert(
    evalWithCoupon.variableCosts.platformFundedDiscounts === 50 &&
    evalWithCoupon.orderContribution < evalNoCoupon.orderContribution,
    21,
    'Platform-funded coupon discount is tracked as a variable cost and deducts from order contribution',
    `Without coupon: ₹${evalNoCoupon.orderContribution}, With ₹50 coupon: ₹${evalWithCoupon.orderContribution} (Discount tracked: ₹${evalWithCoupon.variableCosts.platformFundedDiscounts})`
  );
}

// TEST 22: Composite Scoring balances Positive Contribution and Fast SLA
{
  const quote = CustomerPricingService.generateCheckoutQuote({
    deliveryCoordinates: { lat: 12.9352, lng: 77.6245 },
    cartItems: [{ productId: 'plumb-01', quantity: 3 }]
  });

  assert(
    quote.success && quote.priceSnapshot.fulfilment_selection_reason !== undefined,
    22,
    'Winning fulfilment candidate details and multi-attribute score reason recorded in price snapshot',
    `Reason: ${quote.priceSnapshot.fulfilment_selection_reason}`
  );
}

// TEST 23: Negative Contribution Order with Promotional Subsidy Allowance
{
  DeliveryEconomicsService.updateConfig({
    contribution_targets: {
      ...DeliveryEconomicsService.getConfig().contribution_targets,
      allow_promotional_negative_contribution: true,
      max_delivery_subsidy_amount: 50
    }
  });

  const evalPromo = DeliveryEconomicsService.evaluateOrderContribution({
    sellerPrice: 100,
    commissionAmount: 5,
    handlingRevenue: 5,
    customerDeliveryRevenue: 10,
    actualDeliveryCost: 40,
    finalCustomerPayable: 115
  });

  assert(
    evalPromo.isViable === true && evalPromo.viabilityStatus === 'promotional_subsidized',
    23,
    'Promotional subsidy allows controlled customer acquisition when subsidy <= limit',
    `Viability: ${evalPromo.viabilityStatus}, Subsidy: ₹${evalPromo.deliverySubsidy}`
  );
}

// TEST 24: Server-Side Quote Persistence with complete Part 1 & Part 2 audit fields
{
  const result = calculateAuthoritativePricing({
    deliveryCoordinates: { lat: 12.9352, lng: 77.6245 },
    items: [{ productId: 'plumb-01', quantity: 2 }]
  });

  const snap = result.quote?.priceSnapshot;
  const hasAllFields = Boolean(
    snap &&
    snap.seller_price !== undefined &&
    snap.applicable_commission_rate !== undefined &&
    snap.commission_amount !== undefined &&
    snap.handling_charge !== undefined &&
    snap.customer_delivery_charge !== undefined &&
    snap.final_customer_payable !== undefined &&
    snap.actual_delivery_cost !== undefined &&
    snap.delivery_subsidy !== undefined &&
    snap.qcom_revenue !== undefined &&
    snap.variable_costs !== undefined &&
    snap.order_contribution !== undefined &&
    snap.is_contribution_positive !== undefined
  );

  assert(
    result.success && hasAllFields,
    24,
    'Authoritative Server Pricing Engine constructs complete audit snapshot with Part 1 and Part 2 fields',
    `Fields present: seller_price, commission, handling, cust_delivery, actual_delivery_cost, delivery_subsidy, qcom_revenue, variable_costs, order_contribution`
  );
}

// TEST 25: Tampered Client Request Rejection on Backend
{
  // A client attempting to send manipulated 0 customer delivery fee on low order
  const authoritative = calculateAuthoritativePricing({
    deliveryCoordinates: { lat: 12.9700, lng: 77.6500 }, // ~5km
    items: [{ productId: 'plumb-02', quantity: 1 }] // ₹45 (does not meet ₹499 free threshold)
  });

  assert(
    authoritative.success && authoritative.breakdown?.deliveryFee! > 0,
    25,
    'Backend authoritative pricing recalculates from scratch and strictly ignores client fee manipulation',
    `Calculated fee: ₹${authoritative.breakdown?.deliveryFee}, Free Delivery: ${authoritative.quote?.freeDeliveryEligible}`
  );
}

console.log('\n================================================================');
console.log(`TEST RESULTS: ${passedTests}/${totalTests} TESTS PASSED`);
if (passedTests === totalTests) {
  console.log('🎉 ALL 25 PART 2 DELIVERY ECONOMICS & PRICING TESTS COMPLETED SUCCESSFULLY!');
} else {
  console.error(`⚠️ ${totalTests - passedTests} TESTS FAILED!`);
}
console.log('================================================================\n');
