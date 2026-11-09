import {
  DeliveryPricingService,
  roundDistanceToNearest100m,
  calculateEligibleCartValue,
  calculateTotalRouteDistance,
  calculateCustomerDeliveryFee,
  DEFAULT_DELIVERY_PRICING_CONFIG,
} from './src/utils/deliveryPricingService';

console.log('====================================================');
console.log('⚡ QCOM DELIVERY PRICING ENGINE - SUITE TEST RUNNER');
console.log('====================================================\n');

let passedTests = 0;
let totalTests = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  ✅ [PASS] ${testName}`);
  } else {
    console.error(`  ❌ [FAIL] ${testName}`);
    if (detail) console.error(`     Details: ${detail}`);
  }
}

// -----------------------------------------------------------------------------
// TEST SUITE 1: DISTANCE ROUNDING FORMULA TO NEAREST 100 METRES
// Formula: floor((actual_distance_m + 50) / 100) * 100
// -----------------------------------------------------------------------------
console.log('--- TEST SUITE 1: 100m Mathematical Distance Rounding ---');

const roundingCases = [
  { input: 2110, expected: 2100 },
  { input: 2149, expected: 2100 },
  { input: 2150, expected: 2200 },
  { input: 2151, expected: 2200 },
  { input: 2199, expected: 2200 },
  { input: 2200, expected: 2200 },
  { input: 2249, expected: 2200 },
  { input: 2250, expected: 2300 },
  { input: 0,    expected: 0 },
  { input: 49,   expected: 0 },
  { input: 50,   expected: 100 },
  { input: 99,   expected: 100 },
  { input: 100,  expected: 100 },
  { input: 149,  expected: 100 },
  { input: 150,  expected: 200 },
];

for (const c of roundingCases) {
  const result = roundDistanceToNearest100m(c.input);
  assert(
    result === c.expected,
    `Rounding ${c.input}m → ${result}m`,
    `Expected ${c.expected}m but got ${result}m`
  );
}

// -----------------------------------------------------------------------------
// TEST SUITE 2: ELIGIBLE CART VALUE & DISCOUNT SEGREGATION
// -----------------------------------------------------------------------------
console.log('\n--- TEST SUITE 2: Eligible Cart Value & Discounts ---');

// Case A: Product price 510, Seller discount 20 -> Eligible 490 -> Fee applies
const itemsA = [{ product: { price: 510 }, quantity: 1 }];
const eligibleA = calculateEligibleCartValue(itemsA, 20);
assert(
  eligibleA === 490,
  'Seller-funded discount reduces eligible value: ₹510 - ₹20 = ₹490',
  `Got ${eligibleA}`
);

const feeA = calculateCustomerDeliveryFee({ eligibleCartValue: eligibleA, actualRouteDistanceMeters: 1800 });
assert(
  !feeA.is_free_delivery && feeA.customer_delivery_fee === 29,
  '₹490 eligible value (< ₹499) receives ₹29 delivery charge for 1800m',
  `Got fee ${feeA.customer_delivery_fee}, is_free_delivery: ${feeA.is_free_delivery}`
);
assert(
  feeA.amount_remaining_for_free_delivery === 9,
  'Amount remaining for free delivery is ₹9 (₹499 - ₹490)',
  `Got ${feeA.amount_remaining_for_free_delivery}`
);

// Case B: Products 520, Platform coupon 50 -> Eligible value remains 520 -> FREE Delivery!
const itemsB = [{ product: { price: 520 }, quantity: 1 }];
// Platform coupon of ₹50 is NOT passed as sellerFundedDiscounts
const eligibleB = calculateEligibleCartValue(itemsB, 0);
assert(
  eligibleB === 520,
  'Platform-funded coupon does NOT reduce eligible cart value: remains ₹520',
  `Got ${eligibleB}`
);

const feeB = calculateCustomerDeliveryFee({ eligibleCartValue: eligibleB, actualRouteDistanceMeters: 1800 });
assert(
  feeB.is_free_delivery && feeB.customer_delivery_fee === 0,
  '₹520 eligible value (>= ₹499) unlocks FREE Delivery (₹0 fee)',
  `Got fee ${feeB.customer_delivery_fee}`
);
assert(
  feeB.amount_remaining_for_free_delivery === 0,
  'Amount remaining for free delivery is ₹0 when free delivery is unlocked',
  `Got ${feeB.amount_remaining_for_free_delivery}`
);

// -----------------------------------------------------------------------------
// TEST SUITE 3: FREE DELIVERY THRESHOLD BOUNDARIES (₹498 vs ₹499 vs ₹500)
// -----------------------------------------------------------------------------
console.log('\n--- TEST SUITE 3: Free Delivery Threshold Boundaries ---');

const boundaryCases = [
  { value: 498, isFree: false, fee: 29 },
  { value: 499, isFree: true,  fee: 0 },
  { value: 500, isFree: true,  fee: 0 },
];

for (const b of boundaryCases) {
  const res = calculateCustomerDeliveryFee({ eligibleCartValue: b.value, actualRouteDistanceMeters: 1500 });
  assert(
    res.is_free_delivery === b.isFree && res.customer_delivery_fee === b.fee,
    `Cart ₹${b.value} → isFree: ${b.isFree}, fee: ₹${b.fee}`,
    `Got fee ₹${res.customer_delivery_fee}, isFree: ${res.is_free_delivery}`
  );
}

// -----------------------------------------------------------------------------
// TEST SUITE 4: DISTANCE SLABS & LONG-DISTANCE RULES
// -----------------------------------------------------------------------------
console.log('\n--- TEST SUITE 4: Distance Slabs & Long-Distance Rules ---');

// Slab 1: 0-2000m -> ₹29 (1,540m actual -> rounded 1,500m)
const slab1 = calculateCustomerDeliveryFee({ eligibleCartValue: 300, actualRouteDistanceMeters: 1540 });
assert(
  slab1.rounded_route_distance_m === 1500 && slab1.customer_delivery_fee === 29,
  '1540m actual → rounded 1500m → Slab 0-2000m = ₹29',
  `Got rounded ${slab1.rounded_route_distance_m}m, fee ₹${slab1.customer_delivery_fee}`
);

// Slab 2: 2001-4000m -> ₹39 (2,150m actual -> rounded 2,200m)
const slab2 = calculateCustomerDeliveryFee({ eligibleCartValue: 300, actualRouteDistanceMeters: 2150 });
assert(
  slab2.rounded_route_distance_m === 2200 && slab2.customer_delivery_fee === 39,
  '2150m actual → rounded 2200m → Slab 2001-4000m = ₹39',
  `Got rounded ${slab2.rounded_route_distance_m}m, fee ₹${slab2.customer_delivery_fee}`
);

// Slab 3: 4001-6000m -> ₹49 (4,210m actual -> rounded 4,200m)
const slab3 = calculateCustomerDeliveryFee({ eligibleCartValue: 300, actualRouteDistanceMeters: 4210 });
assert(
  slab3.rounded_route_distance_m === 4200 && slab3.customer_delivery_fee === 49,
  '4210m actual → rounded 4200m → Slab 4001-6000m = ₹49',
  `Got rounded ${slab3.rounded_route_distance_m}m, fee ₹${slab3.customer_delivery_fee}`
);

// Long Distance: >6000m (6,800m actual -> rounded 6,800m -> 49 + 1*10 = ₹59)
const longDist = calculateCustomerDeliveryFee({ eligibleCartValue: 300, actualRouteDistanceMeters: 6800 });
assert(
  longDist.rounded_route_distance_m === 6800 && longDist.customer_delivery_fee === 59,
  '6800m actual → rounded 6800m → Long Distance (>6000m) = ₹49 + ₹10 = ₹59',
  `Got rounded ${longDist.rounded_route_distance_m}m, fee ₹${longDist.customer_delivery_fee}`
);

// -----------------------------------------------------------------------------
// TEST SUITE 5: MULTI-SEGMENT / BATCHED ROUTE DISTANCE ROUNDING
// Rule: Sum actual segment distances FIRST, then round total. Do NOT round segments individually.
// -----------------------------------------------------------------------------
console.log('\n--- TEST SUITE 5: Multi-Segment Batched Route Rounding ---');

const segments = [1240, 910]; // Sum = 2150m actual
const totalDist = calculateTotalRouteDistance(segments);
assert(
  totalDist.actualTotalMeters === 2150,
  'Actual sum of segments: 1240m + 910m = 2150m',
  `Got ${totalDist.actualTotalMeters}`
);
assert(
  totalDist.roundedTotalMeters === 2200,
  'Rounded total distance: floor((2150 + 50) / 100) * 100 = 2200m',
  `Got ${totalDist.roundedTotalMeters}`
);

const segmentFee = calculateCustomerDeliveryFee({
  eligibleCartValue: 300,
  segmentDistancesMeters: segments
});
assert(
  segmentFee.customer_delivery_fee === 39,
  'Delivery fee for 2200m rounded total distance is ₹39',
  `Got ₹${segmentFee.customer_delivery_fee}`
);

// -----------------------------------------------------------------------------
// TEST SUITE 6: ADMIN CONFIGURATION UPDATES & DYNAMIC RULE ENGINE
// -----------------------------------------------------------------------------
console.log('\n--- TEST SUITE 6: Admin Configuration Updates ---');

// Default initial config check
const initialConfig = DeliveryPricingService.getConfig();
assert(
  initialConfig.free_delivery_threshold === 499,
  'Initial default free delivery threshold is ₹499',
  `Got ${initialConfig.free_delivery_threshold}`
);

// Admin updates threshold to ₹599
DeliveryPricingService.updateConfig({ free_delivery_threshold: 599 });
const updatedConfig = DeliveryPricingService.getConfig();
assert(
  updatedConfig.free_delivery_threshold === 599,
  'Admin updated free delivery threshold to ₹599',
  `Got ${updatedConfig.free_delivery_threshold}`
);

// Check cart value ₹550 with new threshold ₹599 -> Fee applies now!
const checkUpdated = DeliveryPricingService.calculateCustomerDeliveryFee({
  eligibleCartValue: 550,
  actualRouteDistanceMeters: 1800
});
assert(
  !checkUpdated.is_free_delivery && checkUpdated.customer_delivery_fee === 29,
  '₹550 cart with ₹599 threshold receives delivery fee ₹29',
  `Got fee ${checkUpdated.customer_delivery_fee}`
);

// Reset threshold back to 499 for standard runtime
DeliveryPricingService.updateConfig({ free_delivery_threshold: 499 });

// -----------------------------------------------------------------------------
// SUMMARY REPORT
// -----------------------------------------------------------------------------
console.log('\n====================================================');
console.log(`📊 TEST SUITE SUMMARY: ${passedTests}/${totalTests} TESTS PASSED`);
console.log('====================================================\n');

if (passedTests === totalTests) {
  console.log('🚀 ALL DELIVERY PRICING ENGINE TESTS PASSED PERFECTLY!');
  process.exit(0);
} else {
  console.error('❌ SOME TESTS FAILED. PLEASE REVIEW LOGS ABOVE.');
  process.exit(1);
}
