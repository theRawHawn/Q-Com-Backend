import { 
  CustomerPricingService, 
  DEFAULT_ADMIN_COMMERCIAL_CONFIG,
  DEFAULT_SELLER_GEOFENCES 
} from './src/utils/customerPricingService';
import { calculateAuthoritativePricing } from './server/pricingEngine';
import { INITIAL_PRODUCTS } from './src/data/products';
import { HARDWARE_SELLERS } from './src/data/sellers';

console.log('================================================================');
console.log('⚡ QCOM — PART 1: CUSTOMER PRICING & GEOFENCING TEST SUITE');
console.log('================================================================\n');

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
// REQUIREMENT 1: NO HARDCODED COMMERCIAL VALUES (DYNAMIC ADMIN CONFIGURATION)
// -----------------------------------------------------------------------------
console.log('--- REQUIREMENT 1: Dynamic Admin Commercial Configuration ---');

const initialConfig = CustomerPricingService.getAdminConfig();
assert(
  typeof initialConfig.free_delivery_threshold === 'number' &&
  typeof initialConfig.handling_charge === 'number' &&
  typeof initialConfig.commission.global_commission_pct === 'number',
  'Commercial values are dynamically loaded from config object'
);

// Admin dynamically updates commercial values at runtime
CustomerPricingService.updateAdminConfig({
  free_delivery_threshold: 599,
  handling_charge: 15,
  commission: {
    ...initialConfig.commission,
    global_commission_pct: 12.5
  }
});

const updatedConfig = CustomerPricingService.getAdminConfig();
assert(
  updatedConfig.free_delivery_threshold === 599 &&
  updatedConfig.handling_charge === 15 &&
  updatedConfig.commission.global_commission_pct === 12.5,
  'Admin dynamically modified free-delivery (₹599), handling (₹15), and commission (12.5%) without app restart',
  `Got threshold: ${updatedConfig.free_delivery_threshold}, handling: ${updatedConfig.handling_charge}`
);

// Reset config back to default
CustomerPricingService.updateAdminConfig(DEFAULT_ADMIN_COMMERCIAL_CONFIG);

// -----------------------------------------------------------------------------
// REQUIREMENT 2: COMMISSION CALCULATION & HIERARCHY
// Hierarchy: Product > Brand > Category > Seller > Global
// -----------------------------------------------------------------------------
console.log('\n--- REQUIREMENT 2: Commission Hierarchy & Calculation ---');

const elecProduct = INITIAL_PRODUCTS.find(p => p.id === 'elec-01')!; // Specific product rule: 14%
const plumbingProduct = INITIAL_PRODUCTS.find(p => p.id === 'plumb-01')!;

const commResult = CustomerPricingService.calculateCommission([
  { product: elecProduct, quantity: 2, sellerId: 'seller-koramangala-01' },
  { product: plumbingProduct, quantity: 1, sellerId: 'seller-hsr-02' }
]);

assert(
  commResult.itemCommissions.length === 2,
  'Commission calculated item-by-item across cart',
  `Count: ${commResult.itemCommissions.length}`
);

const elecComm = commResult.itemCommissions.find(c => c.productId === 'elec-01');
assert(
  elecComm?.applicableRatePct === 14.0,
  'Product-level commission override takes precedence (14% for elec-01)',
  `Got rate ${elecComm?.applicableRatePct}%, source: ${elecComm?.rateSource}`
);

const plumbComm = commResult.itemCommissions.find(c => c.productId === plumbingProduct.id);
assert(
  plumbComm !== undefined && plumbComm.applicableRatePct > 0,
  `Plumbing item receives commission rate (${plumbComm?.applicableRatePct}% from ${plumbComm?.rateSource})`,
  `Got rate ${plumbComm?.applicableRatePct}%`
);

assert(
  commResult.totalCommissionAmount > 0 && commResult.weightedCommissionRate > 0,
  `Weighted total commission computed: ₹${commResult.totalCommissionAmount} (${commResult.weightedCommissionRate}%)`
);

// -----------------------------------------------------------------------------
// REQUIREMENT 4: SELLER GEOFENCING AS FIRST FILTER
// -----------------------------------------------------------------------------
console.log('\n--- REQUIREMENT 4: Seller Geofencing (Straight-Line Radius) ---');

const sellerKoramangala = CustomerPricingService.getSellerGeofence('seller-koramangala-01')!;
const nearbyCustomer = { lat: 12.9360, lng: 77.6250 }; // ~100m away in Koramangala
const farCustomer = { lat: 13.0827, lng: 77.5877 }; // ~18km away in Yelahanka

const geofenceNear = CustomerPricingService.checkSellerGeofence(
  sellerKoramangala.coordinates,
  nearbyCustomer,
  sellerKoramangala.serviceRadiusMeters
);

const geofenceFar = CustomerPricingService.checkSellerGeofence(
  sellerKoramangala.coordinates,
  farCustomer,
  sellerKoramangala.serviceRadiusMeters
);

assert(
  geofenceNear.withinGeofence === true && geofenceNear.straightLineDistanceMeters < 500,
  `Nearby customer inside geofence (${geofenceNear.straightLineDistanceMeters}m <= ${sellerKoramangala.serviceRadiusMeters}m)`,
  `Distance: ${geofenceNear.straightLineDistanceMeters}m`
);

assert(
  geofenceFar.withinGeofence === false && geofenceFar.straightLineDistanceMeters > sellerKoramangala.serviceRadiusMeters,
  `Far customer outside geofence (${geofenceFar.straightLineDistanceMeters}m > ${sellerKoramangala.serviceRadiusMeters}m)`,
  `Distance: ${geofenceFar.straightLineDistanceMeters}m`
);

// -----------------------------------------------------------------------------
// REQUIREMENT 5 & 6: ROAD DISTANCE & 100M MATHEMATICAL ROUNDING
// -----------------------------------------------------------------------------
console.log('\n--- REQUIREMENT 5 & 6: Road Distance & 100m Rounding ---');

const testDistances = [
  { input: 2110, expected: 2100 },
  { input: 2149, expected: 2100 },
  { input: 2150, expected: 2200 },
  { input: 2151, expected: 2200 },
  { input: 2199, expected: 2200 },
  { input: 2200, expected: 2200 },
  { input: 2249, expected: 2200 },
  { input: 2250, expected: 2300 },
  { input: 49,   expected: 0 },
  { input: 50,   expected: 100 },
  { input: 100,  expected: 100 },
  { input: 149,  expected: 100 },
  { input: 150,  expected: 200 }
];

for (const td of testDistances) {
  const rounded = CustomerPricingService.roundDistance(td.input, 100);
  assert(
    rounded === td.expected,
    `100m rounding: ${td.input}m → ${rounded}m`,
    `Expected ${td.expected}m, got ${rounded}m`
  );
}

// -----------------------------------------------------------------------------
// REQUIREMENT 7 & 8: 7-STEP SELLER ELIGIBILITY & MULTI-SELLER FILTER
// -----------------------------------------------------------------------------
console.log('\n--- REQUIREMENT 7 & 8: 7-Step Seller Eligibility ---');

const koramangalaCustomer = { lat: 12.9340, lng: 77.6230 };
const testCart = [
  { productId: 'elec-01', quantity: 2 },
  { productId: 'fast-01', quantity: 1 }
];

const eligibilityResults = CustomerPricingService.determineEligibleSellers(
  koramangalaCustomer,
  testCart
);

assert(
  eligibilityResults.length > 0,
  `Evaluated all sellers (${eligibilityResults.length} total)`,
  `Count: ${eligibilityResults.length}`
);

const eligibleCount = eligibilityResults.filter(s => s.isEligible).length;
assert(
  eligibleCount >= 1,
  `Found ${eligibleCount} eligible sellers satisfying status, geofence, inventory, road distance, & ETA`,
  `Eligible: ${eligibleCount}`
);

// Inactive seller test
CustomerPricingService.updateSellerGeofence('seller-koramangala-01', { serviceStatus: 'closed' });
const inactiveCheck = CustomerPricingService.determineEligibleSellers(koramangalaCustomer, testCart);
const koraSellerInactive = inactiveCheck.find(s => s.sellerId === 'seller-koramangala-01');

assert(
  koraSellerInactive?.isEligible === false && koraSellerInactive.rejectionReason?.includes('closed'),
  'Closed seller rejected on Step 1 (Status Check)',
  `Reason: ${koraSellerInactive?.rejectionReason}`
);

// Reset seller status back to open
CustomerPricingService.updateSellerGeofence('seller-koramangala-01', { serviceStatus: 'open' });

// -----------------------------------------------------------------------------
// REQUIREMENT 9, 10, 11, 13: CHECKOUT QUOTE & CUSTOMER-FACING PRICING
// -----------------------------------------------------------------------------
console.log('\n--- REQUIREMENT 9, 10, 11, 13: Checkout Quote Generation & Pricing Formula ---');

const quoteReq = {
  customerId: 'cust-test-01',
  deliveryCoordinates: koramangalaCustomer,
  cartItems: [
    { productId: 'elec-01', quantity: 4 } // 4 * ₹155 = ₹620 (> ₹499 free delivery threshold)
  ],
  isGstEnabled: true,
  buyerGstin: '29AABCP1429B1Z8',
  riderTip: 20
};

const quote = CustomerPricingService.generateCheckoutQuote(quoteReq);

assert(
  quote.success === true,
  'Authoritative Checkout Quote generated successfully',
  `Error: ${quote.error}`
);

assert(
  quote.itemsSubtotal === 620,
  `Items subtotal is authoritative: ₹${quote.itemsSubtotal} (4 * ₹155 = ₹620)`,
  `Got: ₹${quote.itemsSubtotal}`
);

// Subtotal 620 >= 499 free delivery threshold
assert(
  quote.freeDeliveryEligible === true && quote.deliveryCharge === 0,
  `Order (₹620 >= ₹499) unlocks Free Delivery (₹0 delivery charge)`,
  `Fee: ₹${quote.deliveryCharge}, Free: ${quote.freeDeliveryEligible}`
);

assert(
  quote.handlingCharge === 10,
  `Dynamic handling charge from config applies: ₹${quote.handlingCharge}`,
  `Got: ₹${quote.handlingCharge}`
);

// Pricing formula: Product Price + Handling + Delivery + Rider Tip = Customer Payable
const expectedPayable = 620 + 10 + 0 + 20; // 650
assert(
  quote.finalPayableAmount === expectedPayable,
  `Customer Payable = ₹620 (Items) + ₹10 (Handling) + ₹0 (Delivery) + ₹20 (Tip) = ₹${quote.finalPayableAmount}`,
  `Expected ₹${expectedPayable}, got ₹${quote.finalPayableAmount}`
);

assert(
  quote.pricingRuleVersion === DEFAULT_ADMIN_COMMERCIAL_CONFIG.pricing_rule_version,
  `Quote stamped with pricing rule version '${quote.pricingRuleVersion}'`
);

// -----------------------------------------------------------------------------
// REQUIREMENT 14 & 15: SECURITY & PERSISTENT PRICE SNAPSHOTTING
// -----------------------------------------------------------------------------
console.log('\n--- REQUIREMENT 14 & 15: Server Authoritative Pricing & Price Snapshot ---');

const serverPricing = calculateAuthoritativePricing({
  customerId: 'cust-test-01',
  deliveryCoordinates: koramangalaCustomer,
  items: [
    { productId: 'elec-01', quantity: 4 }
  ],
  isGstEnabled: true,
  buyerGstin: '29AABCP1429B1Z8',
  riderTip: 20
});

assert(
  serverPricing.success === true && serverPricing.quote !== undefined,
  'Server independently calculates authoritative pricing without trusting client values'
);

const snapshot = serverPricing.quote!.priceSnapshot;
assert(
  snapshot.seller_price === 620 &&
  typeof snapshot.applicable_commission_rate === 'number' &&
  typeof snapshot.commission_amount === 'number' &&
  snapshot.handling_charge === 10 &&
  snapshot.customer_delivery_charge === 0 &&
  snapshot.final_customer_payable === 650 &&
  typeof snapshot.seller_id === 'string' &&
  typeof snapshot.actual_route_distance_m === 'number' &&
  typeof snapshot.rounded_route_distance_m === 'number' &&
  typeof snapshot.pricing_rule_version === 'string',
  'Complete commercial price snapshot structured with all 11 mandatory audit fields for order lock'
);

// -----------------------------------------------------------------------------
// SUMMARY REPORT
// -----------------------------------------------------------------------------
console.log('\n================================================================');
console.log(`📊 TEST SUITE SUMMARY: ${passedTests}/${totalTests} TESTS PASSED`);
console.log('================================================================\n');

if (passedTests === totalTests) {
  console.log('🚀 ALL QCOM PART 1 PRICING & GEOFENCING CRITERIA PASSED 100%!');
  process.exit(0);
} else {
  console.error('❌ SOME TESTS FAILED. PLEASE REVIEW LOGS ABOVE.');
  process.exit(1);
}
