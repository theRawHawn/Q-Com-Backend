import { CartItem, HardwareProduct, SellerPartner, JobSiteLocation, DeliveryChargeBreakdown } from '../types';
import { HARDWARE_SELLERS, getSellerById } from '../data/sellers';
import { INITIAL_PRODUCTS } from '../data/products';
import { DeliveryEconomicsService } from './deliveryEconomicsService';

// =============================================================================
// 1. ADMIN COMMERCIAL CONFIGURATION INTERFACES
// =============================================================================

export interface DistanceSlabConfig {
  minMeters: number;
  maxMeters: number;
  fee: number; // Customer delivery fee in INR ₹
}

export interface LongDistanceRuleConfig {
  thresholdMeters: number; // e.g. 6000m
  baseFee: number; // e.g. ₹49
  additionalFeePerStep: number; // e.g. ₹10 per step
  stepMeters: number; // e.g. 1000m
}

export interface CommissionRuleConfig {
  global_commission_pct: number; // Default fallback (e.g. 10%)
  seller_commission_pct: Record<string, number>; // sellerId -> commission %
  category_commission_pct: Record<string, number>; // category -> commission %
  brand_commission_pct: Record<string, number>; // brand -> commission %
  product_commission_pct: Record<string, number>; // productId -> commission %
  promotional_commission_rules?: Record<string, number>; // promoCode -> commission %
}

export interface AdminCommercialConfig {
  commission: CommissionRuleConfig;
  free_delivery_threshold: number; // Configurable e.g. ₹499 (not hardcoded)
  free_delivery_max_distance_m: number; // Configurable e.g. 6000m (subject to geofence/area rules)
  handling_charge: number; // Configurable e.g. ₹12 (inclusive of GST)
  platform_fee: number; // Configurable e.g. ₹13 (inclusive of GST)
  distance_rounding_unit_m: number; // Configurable e.g. 100m
  distance_slabs: DistanceSlabConfig[];
  long_distance_rules: LongDistanceRuleConfig;
  pricing_rule_version: string;
  quote_validity_seconds: number;
  minimum_order_value: number; // Configurable e.g. ₹49
  qcom_delivery_markup: number; // Configurable QCOM delivery markup (₹) before GST
}

// Default Server-Side Initial Admin Configuration (Completely dynamic & updateable via Admin Panel)
export const DEFAULT_ADMIN_COMMERCIAL_CONFIG: AdminCommercialConfig = {
  commission: {
    global_commission_pct: 10.0,
    seller_commission_pct: {
      'seller-koramangala-01': 10.0,
      'seller-hsr-02': 11.5,
      'seller-indiranagar-03': 12.0,
      'seller-peenya-04': 8.5,
      'seller-domlur-05': 9.0,
      'seller-btm-06': 10.0,
      'seller-jayanagar-07': 10.5,
      'seller-ecity-08': 9.5
    },
    category_commission_pct: {
      'electrical': 12.0,
      'plumbing': 9.0,
      'tools': 8.0,
      'safety': 10.0,
      'fasteners': 14.0,
      'adhesives': 11.0,
      'carpentry': 10.0,
      'lighting': 12.5,
      'fans': 11.0,
      'switches': 13.0,
      'screws': 15.0,
      'cutters': 9.5,
      'cutting_discs': 10.0,
      'bathroom_fittings': 9.5,
      'kitchen_fittings': 9.5
    },
    brand_commission_pct: {
      'Schneider': 13.0,
      'Havells': 12.5,
      'Bosch': 8.0,
      'Stanley': 9.0,
      'Astral': 9.5,
      'Finolex': 9.0,
      'Pidilite': 11.0,
      'Fevicol': 11.0,
      'Hilti': 12.0,
      'Unbrako': 14.0,
      'Karam': 10.0,
      '3M': 10.5
    },
    product_commission_pct: {
      'elec-01': 14.0, // High-margin heavy MCB isolator
      'plumb-01': 9.0,
      'tool-01': 7.5
    },
    promotional_commission_rules: {
      'PROBUILD': 8.0,
      'SPEEDSITE': 9.0
    }
  },
  free_delivery_threshold: 499,
  free_delivery_max_distance_m: 6000,
  handling_charge: 12,
  platform_fee: 13,
  distance_rounding_unit_m: 100,
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
  pricing_rule_version: 'v1.1.0-qcom-admin-2026',
  quote_validity_seconds: 900, // 15 minutes
  minimum_order_value: 49,
  qcom_delivery_markup: 0
};

// =============================================================================
// 2. SELLER GEOFENCING & SERVICEABILITY CONFIGURATION INTERFACES
// =============================================================================

export interface SellerGeofenceConfig {
  sellerId: string;
  name: string;
  locality: string;
  address: string;
  coordinates: {
    lat: number;
    lng: number;
  };
  serviceRadiusMeters: number; // Straight-line service geofence radius (m)
  maxRoadDistanceMeters: number; // Maximum road distance allowable (m)
  maxDeliveryTimeMinutes: number; // Maximum allowable delivery time (mins)
  serviceStatus: 'active' | 'inactive' | 'open' | 'closed';
  basePrepMins: number; // Prep time in mins
  inventoryOverride?: Record<string, number>; // productId -> stock count
}

// Initial Seller Geofence Registry (Admin configurable)
export const DEFAULT_SELLER_GEOFENCES: SellerGeofenceConfig[] = HARDWARE_SELLERS.map(s => {
  let serviceRadiusMeters = 6500;
  let maxRoadDistanceMeters = 8500;
  let maxDeliveryTimeMinutes = 35;

  if (s.id === 'seller-peenya-04') {
    serviceRadiusMeters = 9000;
    maxRoadDistanceMeters = 12000;
    maxDeliveryTimeMinutes = 45;
  } else if (s.id === 'seller-ecity-08') {
    serviceRadiusMeters = 8000;
    maxRoadDistanceMeters = 10500;
    maxDeliveryTimeMinutes = 40;
  }

  return {
    sellerId: s.id,
    name: s.name,
    locality: s.locality,
    address: s.address,
    coordinates: { ...s.coordinates },
    serviceRadiusMeters,
    maxRoadDistanceMeters,
    maxDeliveryTimeMinutes,
    serviceStatus: 'open',
    basePrepMins: s.basePrepMins || 2.0
  };
});

// =============================================================================
// 3. SELLER ELIGIBILITY & CHECKOUT QUOTE DATA INTERFACES
// =============================================================================

export interface SellerEligibilityCheckResult {
  sellerId: string;
  sellerName: string;
  locality: string;
  isEligible: boolean;
  rejectionReason?: string;
  straightLineDistanceMeters: number;
  actualRouteDistanceMeters: number;
  roundedRouteDistanceMeters: number;
  estimatedEtaMinutes: number;
  serviceStatus: string;
  hasInventory: boolean;
  withinGeofence: boolean;
  withinMaxRoadDistance: boolean;
  withinMaxDeliveryTime: boolean;
}

export interface CommissionCalculationResult {
  totalCommissionAmount: number;
  weightedCommissionRate: number;
  itemCommissions: {
    productId: string;
    productName: string;
    unitPrice: number;
    quantity: number;
    lineTotal: number;
    applicableRatePct: number;
    rateSource: 'product' | 'brand' | 'category' | 'seller' | 'global' | 'promotional';
    commissionAmount: number;
  }[];
}

export interface CheckoutQuoteRequest {
  customerId?: string;
  deliveryAddressId?: string;
  deliveryCoordinates?: { lat: number; lng: number };
  cartItems: {
    productId: string;
    quantity: number;
    sellerId?: string;
  }[];
  couponCode?: string | null;
  riderTip?: number;
  isGstEnabled?: boolean;
  buyerGstin?: string | null;
  buyerStateCode?: string | null;
  buyerState?: string | null;
  buyerAddress?: string | null;
  sellerFundedDiscounts?: number;
  isBatched?: boolean;
}

export interface CheckoutQuoteResponse {
  success: boolean;
  quoteId: string;
  quoteExpiry: string; // ISO timestamp
  pricingRuleVersion: string;
  
  // Customer-facing pricing components (Product Price + Handling + Delivery + Taxes - Discounts = Payable)
  itemsSubtotal: number;
  itemsOriginalTotal: number;
  mrpDiscount: number;
  couponDiscount: number;
  appliedCouponCode: string | null;
  totalDiscounts: number;
  
  handlingCharge: number;
  deliveryCharge: number;
  
  taxes: {
    taxableValue: number;
    totalGst: number;
    cgst: number;
    sgst: number;
    utgst: number;
    igst: number;
    isInterState: boolean;
    isUnionTerritory: boolean;
    placeOfSupply: string;
    supplyType: string;
  };
  
  riderTip: number;
  finalPayableAmount: number;
  totalSavings: number;
  
  // Free delivery evaluation
  freeDeliveryEligible: boolean;
  freeDeliveryThreshold: number;
  amountRemainingForFreeDelivery: number;
  
  // Fulfilment & Seller Evaluation
  selectedSellerId: string;
  selectedSellerName: string;
  eligibleSellers: SellerEligibilityCheckResult[];
  
  // Route & ETA
  actualRouteDistanceM: number;
  roundedRouteDistanceM: number;
  deliveryEtaMinutes: number;
  
  // Price snapshot for order persistence (Audit & Financial Reconciliation)
  priceSnapshot: {
    seller_price: number;
    applicable_commission_rate: number;
    commission_amount: number;
    handling_charge: number;
    customer_delivery_charge: number;
    delivery_charge_breakdown?: DeliveryChargeBreakdown;
    calculated_delivery_charge?: number;
    qcom_delivery_markup?: number;
    taxable_delivery_charge?: number;
    delivery_gst_amount?: number;
    delivery_rounding_adjustment?: number;
    discounts: number;
    taxes: number;
    final_customer_payable: number;
    seller_id: string;
    actual_route_distance_m: number;
    rounded_route_distance_m: number;
    pricing_rule_version: string;
    // Part 2 Delivery Economics internal audit fields
    actual_delivery_cost?: number;
    delivery_subsidy?: number;
    qcom_revenue?: number;
    variable_costs?: number;
    order_contribution?: number;
    is_contribution_positive?: boolean;
    fulfilment_selection_reason?: string;
    is_batched?: boolean;
  };
  
  deliveryChargeBreakdown?: DeliveryChargeBreakdown;
  
  verifiedItems: {
    product: HardwareProduct;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
    gstRatePercent: number;
    taxableValue: number;
    lineGst: number;
    cgst: number;
    sgst: number;
    utgst: number;
    igst: number;
  }[];
  
  error?: string;
}

// =============================================================================
// 4. CENTRALIZED CUSTOMER PRICING & GEOFENCING SERVICE
// =============================================================================

class CentralizedCustomerPricingService {
  private config: AdminCommercialConfig = { ...DEFAULT_ADMIN_COMMERCIAL_CONFIG };
  private sellerGeofences: Map<string, SellerGeofenceConfig> = new Map();
  private productsCatalog: Map<string, HardwareProduct> = new Map();

  constructor() {
    // Initialize seller geofence configurations
    for (const seller of DEFAULT_SELLER_GEOFENCES) {
      this.sellerGeofences.set(seller.sellerId, { ...seller });
    }
    // Initialize product catalog lookup
    for (const prod of INITIAL_PRODUCTS) {
      this.productsCatalog.set(prod.id, { ...prod });
    }
  }

  // ---------------------------------------------------------------------------
  // ADMIN CONFIGURATION METHODS
  // ---------------------------------------------------------------------------

  public getAdminConfig(): AdminCommercialConfig {
    return {
      ...this.config,
      commission: {
        ...this.config.commission,
        seller_commission_pct: { ...this.config.commission.seller_commission_pct },
        category_commission_pct: { ...this.config.commission.category_commission_pct },
        brand_commission_pct: { ...this.config.commission.brand_commission_pct },
        product_commission_pct: { ...this.config.commission.product_commission_pct },
        promotional_commission_rules: { ...(this.config.commission.promotional_commission_rules || {}) }
      },
      distance_slabs: this.config.distance_slabs.map(s => ({ ...s })),
      long_distance_rules: { ...this.config.long_distance_rules }
    };
  }

  public updateAdminConfig(updates: Partial<AdminCommercialConfig>): AdminCommercialConfig {
    if (updates.commission) {
      this.config.commission = {
        ...this.config.commission,
        ...updates.commission,
        seller_commission_pct: {
          ...this.config.commission.seller_commission_pct,
          ...(updates.commission.seller_commission_pct || {})
        },
        category_commission_pct: {
          ...this.config.commission.category_commission_pct,
          ...(updates.commission.category_commission_pct || {})
        },
        brand_commission_pct: {
          ...this.config.commission.brand_commission_pct,
          ...(updates.commission.brand_commission_pct || {})
        },
        product_commission_pct: {
          ...this.config.commission.product_commission_pct,
          ...(updates.commission.product_commission_pct || {})
        },
        promotional_commission_rules: {
          ...this.config.commission.promotional_commission_rules,
          ...(updates.commission.promotional_commission_rules || {})
        }
      };
    }

    if (typeof updates.free_delivery_threshold === 'number') {
      this.config.free_delivery_threshold = updates.free_delivery_threshold;
    }
    if (typeof updates.free_delivery_max_distance_m === 'number') {
      this.config.free_delivery_max_distance_m = updates.free_delivery_max_distance_m;
    }
    if (typeof updates.handling_charge === 'number') {
      this.config.handling_charge = updates.handling_charge;
    }
    if (typeof updates.distance_rounding_unit_m === 'number') {
      this.config.distance_rounding_unit_m = updates.distance_rounding_unit_m;
    }
    if (Array.isArray(updates.distance_slabs)) {
      this.config.distance_slabs = updates.distance_slabs.map(s => ({ ...s }));
    }
    if (updates.long_distance_rules) {
      this.config.long_distance_rules = { ...updates.long_distance_rules };
    }
    if (updates.pricing_rule_version) {
      this.config.pricing_rule_version = updates.pricing_rule_version;
    }
    if (typeof updates.minimum_order_value === 'number') {
      this.config.minimum_order_value = updates.minimum_order_value;
    }
    if (typeof updates.quote_validity_seconds === 'number') {
      this.config.quote_validity_seconds = updates.quote_validity_seconds;
    }

    return this.getAdminConfig();
  }

  // ---------------------------------------------------------------------------
  // SELLER GEOFENCE CONFIGURATION METHODS
  // ---------------------------------------------------------------------------

  public getSellerGeofences(): SellerGeofenceConfig[] {
    return Array.from(this.sellerGeofences.values()).map(s => ({ ...s }));
  }

  public getSellerGeofence(sellerId: string): SellerGeofenceConfig | undefined {
    const s = this.sellerGeofences.get(sellerId);
    return s ? { ...s } : undefined;
  }

  public updateSellerGeofence(sellerId: string, updates: Partial<SellerGeofenceConfig>): SellerGeofenceConfig | undefined {
    const existing = this.sellerGeofences.get(sellerId);
    if (!existing) return undefined;

    const updated: SellerGeofenceConfig = {
      ...existing,
      ...updates,
      coordinates: updates.coordinates ? { ...updates.coordinates } : existing.coordinates,
      inventoryOverride: updates.inventoryOverride 
        ? { ...existing.inventoryOverride, ...updates.inventoryOverride }
        : existing.inventoryOverride
    };

    this.sellerGeofences.set(sellerId, updated);
    return { ...updated };
  }

  public getProductFromCatalog(productId: string): HardwareProduct | undefined {
    return this.productsCatalog.get(productId);
  }

  public getAllProducts(): HardwareProduct[] {
    return Array.from(this.productsCatalog.values());
  }

  public updateProductCatalog(product: HardwareProduct): void {
    this.productsCatalog.set(product.id, { ...product });
  }

  // ---------------------------------------------------------------------------
  // CORE GEOMETRY & DISTANCE METHODS (Step 3, 5, 6)
  // ---------------------------------------------------------------------------

  /**
   * Calculates straight-line distance in metres using Haversine formula.
   */
  public calculateStraightLineDistance(
    coords1: { lat: number; lng: number },
    coords2: { lat: number; lng: number }
  ): number {
    const R = 6371000; // Earth's mean radius in metres
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

  /**
   * Step 4: Checks whether customer coordinates fall within seller's service geofence.
   */
  public checkSellerGeofence(
    sellerCoords: { lat: number; lng: number },
    customerCoords: { lat: number; lng: number },
    serviceRadiusMeters: number
  ): { withinGeofence: boolean; straightLineDistanceMeters: number } {
    const straightLineDistanceMeters = this.calculateStraightLineDistance(sellerCoords, customerCoords);
    return {
      withinGeofence: straightLineDistanceMeters <= serviceRadiusMeters,
      straightLineDistanceMeters
    };
  }

  /**
   * Step 5: Calculates actual road network distance between SELLER -> CUSTOMER.
   * Employs realistic road network routing curvature factor (1.28x to 1.35x urban street grid factor).
   */
  public calculateRouteDistance(
    sellerCoords: { lat: number; lng: number },
    customerCoords: { lat: number; lng: number }
  ): { actualRouteDistanceMeters: number; durationSeconds: number } {
    const straightLine = this.calculateStraightLineDistance(sellerCoords, customerCoords);
    
    // Urban road tortuosity / street network expansion factor (avg 1.30 for Bangalore urban layout)
    const urbanRoadFactor = straightLine < 1500 ? 1.22 : (straightLine < 4000 ? 1.28 : 1.34);
    const actualRouteDistanceMeters = Math.max(
      straightLine,
      Math.round(straightLine * urbanRoadFactor)
    );

    // Urban two-wheeler speed estimation (approx 24 km/h with signals & traffic)
    const speedMps = 24 * (1000 / 3600); // 6.67 m/s
    const durationSeconds = Math.round(actualRouteDistanceMeters / speedMps) + 120; // +2 mins signal delays

    return {
      actualRouteDistanceMeters,
      durationSeconds
    };
  }

  /**
   * Step 6: Rounds route distance in metres to the nearest configured unit (default 100m).
   * Standard mathematical rounding:
   * 2,110 m -> 2,100 m
   * 2,149 m -> 2,100 m
   * 2,150 m -> 2,200 m
   * 2,151 m -> 2,200 m
   * 2,199 m -> 2,200 m
   */
  public roundDistance(
    actualDistanceMeters: number,
    roundingUnitMeters?: number
  ): number {
    const unit = Math.max(1, roundingUnitMeters || this.config.distance_rounding_unit_m || 100);
    const distanceM = Math.max(0, Number(actualDistanceMeters) || 0);
    // Mathematical rounding: floor((dist + unit / 2) / unit) * unit
    return Math.floor((distanceM + (unit / 2)) / unit) * unit;
  }

  // ---------------------------------------------------------------------------
  // SELLER ELIGIBILITY FILTER (Step 7 & 8)
  // ---------------------------------------------------------------------------

  /**
   * Step 7: Evaluates 7-step eligibility for all configured sellers:
   * 1. Check seller is active/open.
   * 2. Check customer is within seller geofence (straight-line radius).
   * 3. Check seller can potentially serve the customer.
   * 4. Check inventory availability for cart items.
   * 5. Calculate actual road distance.
   * 6. Check configured maximum road distance.
   * 7. Check configured maximum delivery time.
   */
  public determineEligibleSellers(
    customerCoords: { lat: number; lng: number },
    cartItems: { productId: string; quantity: number }[]
  ): SellerEligibilityCheckResult[] {
    const results: SellerEligibilityCheckResult[] = [];

    for (const seller of this.sellerGeofences.values()) {
      // 1. Check seller is active/open
      const isActive = seller.serviceStatus === 'active' || seller.serviceStatus === 'open';
      if (!isActive) {
        results.push({
          sellerId: seller.sellerId,
          sellerName: seller.name,
          locality: seller.locality,
          isEligible: false,
          rejectionReason: `Seller is currently ${seller.serviceStatus}`,
          straightLineDistanceMeters: 0,
          actualRouteDistanceMeters: 0,
          roundedRouteDistanceMeters: 0,
          estimatedEtaMinutes: 0,
          serviceStatus: seller.serviceStatus,
          hasInventory: false,
          withinGeofence: false,
          withinMaxRoadDistance: false,
          withinMaxDeliveryTime: false
        });
        continue;
      }

      // 2. Check customer is within seller geofence (straight line radius)
      const geofenceCheck = this.checkSellerGeofence(
        seller.coordinates,
        customerCoords,
        seller.serviceRadiusMeters
      );

      if (!geofenceCheck.withinGeofence) {
        results.push({
          sellerId: seller.sellerId,
          sellerName: seller.name,
          locality: seller.locality,
          isEligible: false,
          rejectionReason: `Customer outside seller service radius (${geofenceCheck.straightLineDistanceMeters}m > ${seller.serviceRadiusMeters}m)`,
          straightLineDistanceMeters: geofenceCheck.straightLineDistanceMeters,
          actualRouteDistanceMeters: 0,
          roundedRouteDistanceMeters: 0,
          estimatedEtaMinutes: 0,
          serviceStatus: seller.serviceStatus,
          hasInventory: false,
          withinGeofence: false,
          withinMaxRoadDistance: false,
          withinMaxDeliveryTime: false
        });
        continue;
      }

      // 4. Check inventory availability
      let hasInventory = true;
      let missingItemReason = '';

      for (const item of cartItems) {
        const prod = this.productsCatalog.get(item.productId);
        if (!prod) {
          hasInventory = false;
          missingItemReason = `Product ${item.productId} not found in catalog`;
          break;
        }

        // Check if seller has custom inventory override or standard catalog stock
        const sellerStock = seller.inventoryOverride?.[item.productId] ?? prod.stockCount;
        if (sellerStock < item.quantity) {
          hasInventory = false;
          missingItemReason = `Insufficient stock for '${prod.name}' (requested ${item.quantity}, available ${sellerStock})`;
          break;
        }
      }

      if (!hasInventory) {
        results.push({
          sellerId: seller.sellerId,
          sellerName: seller.name,
          locality: seller.locality,
          isEligible: false,
          rejectionReason: missingItemReason,
          straightLineDistanceMeters: geofenceCheck.straightLineDistanceMeters,
          actualRouteDistanceMeters: 0,
          roundedRouteDistanceMeters: 0,
          estimatedEtaMinutes: 0,
          serviceStatus: seller.serviceStatus,
          hasInventory: false,
          withinGeofence: true,
          withinMaxRoadDistance: false,
          withinMaxDeliveryTime: false
        });
        continue;
      }

      // 5. Calculate actual road distance
      const route = this.calculateRouteDistance(seller.coordinates, customerCoords);
      const roundedDistM = this.roundDistance(route.actualRouteDistanceMeters);

      // 6. Check configured maximum road distance
      const withinMaxRoad = route.actualRouteDistanceMeters <= seller.maxRoadDistanceMeters;
      if (!withinMaxRoad) {
        results.push({
          sellerId: seller.sellerId,
          sellerName: seller.name,
          locality: seller.locality,
          isEligible: false,
          rejectionReason: `Road distance exceeds maximum limit (${route.actualRouteDistanceMeters}m > ${seller.maxRoadDistanceMeters}m)`,
          straightLineDistanceMeters: geofenceCheck.straightLineDistanceMeters,
          actualRouteDistanceMeters: route.actualRouteDistanceMeters,
          roundedRouteDistanceMeters: roundedDistM,
          estimatedEtaMinutes: 0,
          serviceStatus: seller.serviceStatus,
          hasInventory: true,
          withinGeofence: true,
          withinMaxRoadDistance: false,
          withinMaxDeliveryTime: false
        });
        continue;
      }

      // 7. Check configured maximum delivery time
      const transitMinutes = Math.round(route.durationSeconds / 60);
      const estimatedEtaMinutes = Math.round(seller.basePrepMins + transitMinutes);
      const withinMaxTime = estimatedEtaMinutes <= seller.maxDeliveryTimeMinutes;

      if (!withinMaxTime) {
        results.push({
          sellerId: seller.sellerId,
          sellerName: seller.name,
          locality: seller.locality,
          isEligible: false,
          rejectionReason: `Delivery ETA exceeds maximum limit (${estimatedEtaMinutes} mins > ${seller.maxDeliveryTimeMinutes} mins)`,
          straightLineDistanceMeters: geofenceCheck.straightLineDistanceMeters,
          actualRouteDistanceMeters: route.actualRouteDistanceMeters,
          roundedRouteDistanceMeters: roundedDistM,
          estimatedEtaMinutes,
          serviceStatus: seller.serviceStatus,
          hasInventory: true,
          withinGeofence: true,
          withinMaxRoadDistance: true,
          withinMaxDeliveryTime: false
        });
        continue;
      }

      // Fully eligible seller
      results.push({
        sellerId: seller.sellerId,
        sellerName: seller.name,
        locality: seller.locality,
        isEligible: true,
        straightLineDistanceMeters: geofenceCheck.straightLineDistanceMeters,
        actualRouteDistanceMeters: route.actualRouteDistanceMeters,
        roundedRouteDistanceMeters: roundedDistM,
        estimatedEtaMinutes,
        serviceStatus: seller.serviceStatus,
        hasInventory: true,
        withinGeofence: true,
        withinMaxRoadDistance: true,
        withinMaxDeliveryTime: true
      });
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // COMMISSION CALCULATION (Step 2)
  // Hierarchy: Product > Brand > Category > Seller > Global
  // ---------------------------------------------------------------------------

  public calculateCommission(
    items: { product: HardwareProduct; quantity: number; sellerId?: string }[],
    couponCode?: string | null
  ): CommissionCalculationResult {
    const commConfig = this.config.commission;
    let totalCommissionAmount = 0;
    let totalItemsValue = 0;

    const itemCommissions = items.map(item => {
      const prod = item.product;
      const qty = item.quantity;
      const unitPrice = prod.price;
      const lineTotal = unitPrice * qty;
      totalItemsValue += lineTotal;

      let applicableRatePct = commConfig.global_commission_pct;
      let rateSource: CommissionCalculationResult['itemCommissions'][0]['rateSource'] = 'global';

      // 1. Product-specific commission
      if (typeof commConfig.product_commission_pct[prod.id] === 'number') {
        applicableRatePct = commConfig.product_commission_pct[prod.id];
        rateSource = 'product';
      }
      // 2. Brand-specific commission
      else if (prod.specs?.brand && typeof commConfig.brand_commission_pct[prod.specs.brand] === 'number') {
        applicableRatePct = commConfig.brand_commission_pct[prod.specs.brand];
        rateSource = 'brand';
      }
      // 3. Category-specific commission
      else if (typeof commConfig.category_commission_pct[prod.category] === 'number') {
        applicableRatePct = commConfig.category_commission_pct[prod.category];
        rateSource = 'category';
      }
      // 4. Seller-specific commission
      else if (item.sellerId && typeof commConfig.seller_commission_pct[item.sellerId] === 'number') {
        applicableRatePct = commConfig.seller_commission_pct[item.sellerId];
        rateSource = 'seller';
      }
      // 5. Promotional commission
      else if (couponCode && commConfig.promotional_commission_rules?.[couponCode.toUpperCase()]) {
        applicableRatePct = commConfig.promotional_commission_rules[couponCode.toUpperCase()];
        rateSource = 'promotional';
      }

      const commissionAmount = Math.round(lineTotal * (applicableRatePct / 100) * 100) / 100;
      totalCommissionAmount += commissionAmount;

      return {
        productId: prod.id,
        productName: prod.name,
        unitPrice,
        quantity: qty,
        lineTotal,
        applicableRatePct,
        rateSource,
        commissionAmount
      };
    });

    const weightedCommissionRate = totalItemsValue > 0
      ? Math.round((totalCommissionAmount / totalItemsValue) * 10000) / 100
      : commConfig.global_commission_pct;

    return {
      totalCommissionAmount: Math.round(totalCommissionAmount * 100) / 100,
      weightedCommissionRate,
      itemCommissions
    };
  }

  // ---------------------------------------------------------------------------
  // HANDLING & FREE DELIVERY PRICING METHODS (Step 10, 11, 12)
  // ---------------------------------------------------------------------------

  public getHandlingChargeBreakdown(cartSubtotal: number) {
    if (cartSubtotal <= 0) {
      return {
        handlingCharge: 0,
        platformFee: 0,
        totalCharge: 0,
        baseHandlingCharge: 0,
        gstRate: 18,
        taxableValue: 0,
        gstAmount: 0,
        cgstAmount: 0,
        sgstAmount: 0,
        igstAmount: 0,
        preRoundingTotal: 0,
        roundingAdjustment: 0,
        finalHandlingCharge: 0,
      };
    }

    const handlingCharge = Math.max(0, Number(this.config.handling_charge) || 12);
    const platformFee = Math.max(0, Number(this.config.platform_fee) || 13);
    const totalCharge = handlingCharge + platformFee;

    // Both ₹12 handling and ₹13 platform charges are inclusive of 18% GST
    const gstRate = 18;
    const taxableValue = Math.round((totalCharge / (1 + gstRate / 100)) * 100) / 100;
    const gstAmount = Math.round((totalCharge - taxableValue) * 100) / 100;

    return {
      handlingCharge,
      platformFee,
      totalCharge,
      baseHandlingCharge: handlingCharge,
      gstRate,
      taxableValue,
      gstAmount,
      cgstAmount: Math.round((gstAmount / 2) * 100) / 100,
      sgstAmount: Math.round((gstAmount / 2) * 100) / 100,
      igstAmount: gstAmount,
      preRoundingTotal: totalCharge,
      roundingAdjustment: 0,
      finalHandlingCharge: totalCharge,
    };
  }

  public calculateHandlingCharge(cartSubtotal: number): number {
    if (cartSubtotal <= 0) return 0;
    return this.getHandlingChargeBreakdown(cartSubtotal).finalHandlingCharge;
  }

  public updateHandlingCharge(baseCharge: number): void {
    if (typeof baseCharge === 'number' && baseCharge >= 0) {
      this.config.handling_charge = baseCharge;
    }
  }

  public determineFreeDeliveryEligibility(
    eligibleCartValue: number,
    actualRouteDistanceMeters?: number
  ): { isEligible: boolean; amountRemaining: number; threshold: number } {
    const threshold = this.config.free_delivery_threshold;
    const isEligible = eligibleCartValue >= threshold;
    const amountRemaining = isEligible ? 0 : Math.max(0, threshold - eligibleCartValue);

    return {
      isEligible,
      amountRemaining,
      threshold
    };
  }

  public calculateCustomerDeliveryCharge(
    eligibleCartValue: number,
    actualRouteDistanceMeters: number,
    buyerStateCode?: string
  ): { 
    deliveryCharge: number; 
    deliveryBreakdown: DeliveryChargeBreakdown;
    isFreeDelivery: boolean; 
    appliedSlab: string; 
    roundedDistanceM: number;
    free_delivery_threshold: number;
    amount_remaining_for_free_delivery: number;
    freeDeliveryThreshold: number;
    amountRemainingForFreeDelivery: number;
    calculatedDeliveryCharge: number;
    qcomDeliveryMarkup: number;
    taxableDeliveryCharge: number;
    gstRate: number;
    cgstAmount: number;
    sgstAmount: number;
    utgstAmount?: number;
    igstAmount: number;
    totalGstAmount: number;
    preRoundingDeliveryTotal: number;
    roundingAdjustment: number;
    finalDeliveryCharge: number;
  } {
    const roundedDistM = this.roundDistance(actualRouteDistanceMeters);
    const freeDelivery = this.determineFreeDeliveryEligibility(eligibleCartValue, actualRouteDistanceMeters);
    const maxCustomerCap = DeliveryEconomicsService.getConfig().contribution_targets.maximum_customer_delivery_charge;

    const stateCode = buyerStateCode || '29';
    const isInterState = stateCode !== '29';
    const isUnionTerritory = !isInterState && ['04', '26', '31', '35', '38', '97'].includes(stateCode);

    if (freeDelivery.isEligible) {
      const freeBreakdown: DeliveryChargeBreakdown = {
        calculatedDeliveryCharge: 0,
        qcomDeliveryMarkup: 0,
        taxableDeliveryCharge: 0,
        gstRate: 18,
        cgstAmount: 0,
        sgstAmount: 0,
        utgstAmount: 0,
        igstAmount: 0,
        totalGstAmount: 0,
        preRoundingDeliveryTotal: 0,
        roundingAdjustment: 0,
        finalDeliveryCharge: 0,
        isFreeDelivery: true
      };

      return {
        deliveryCharge: 0,
        deliveryBreakdown: freeBreakdown,
        appliedSlab: `Free Delivery (Order >= ₹${this.config.free_delivery_threshold})`,
        roundedDistanceM: roundedDistM,
        free_delivery_threshold: this.config.free_delivery_threshold,
        amount_remaining_for_free_delivery: 0,
        freeDeliveryThreshold: this.config.free_delivery_threshold,
        amountRemainingForFreeDelivery: 0,
        ...freeBreakdown
      };
    }

    // Step 1: Base delivery charge calculation using routing/distance slabs
    let baseCalculatedFee = 29;
    let appliedSlab = 'Default Standard Slab (₹29)';

    // Evaluate distance slabs
    const matchedSlab = this.config.distance_slabs.find(
      s => roundedDistM >= s.minMeters && roundedDistM <= s.maxMeters
    );

    if (matchedSlab) {
      baseCalculatedFee = matchedSlab.fee;
      appliedSlab = `${matchedSlab.minMeters}m - ${matchedSlab.maxMeters}m (₹${matchedSlab.fee})`;
    } else if (roundedDistM > this.config.long_distance_rules.thresholdMeters) {
      // Long distance rules (> 6000m)
      const longDist = this.config.long_distance_rules;
      const excessMeters = roundedDistM - longDist.thresholdMeters;
      const additionalSteps = Math.ceil(excessMeters / longDist.stepMeters);
      baseCalculatedFee = longDist.baseFee + (additionalSteps * longDist.additionalFeePerStep);
      appliedSlab = `Long Distance >${longDist.thresholdMeters}m (Base ₹${longDist.baseFee} + ${additionalSteps}x₹${longDist.additionalFeePerStep})`;
    }

    // Step 1 result: calculatedDeliveryCharge (enforce protection cap)
    const calculatedDeliveryCharge = Math.min(maxCustomerCap, baseCalculatedFee);
    if (calculatedDeliveryCharge < baseCalculatedFee) {
      appliedSlab += ` (Capped at Max ₹${maxCustomerCap})`;
    }

    // Step 2: Add QCOM delivery markup
    const qcomDeliveryMarkup = Math.max(0, Number(this.config.qcom_delivery_markup) || 0);

    // Step 3: Taxable delivery charge = calculatedDeliveryCharge + qcomDeliveryMarkup
    const taxableDeliveryCharge = Math.round((calculatedDeliveryCharge + qcomDeliveryMarkup) * 100) / 100;

    // Step 4: GST Calculation (18% SAC 996813 Goods Transport / Courier)
    const gstRate = 18;
    let cgstAmount = 0;
    let sgstAmount = 0;
    let utgstAmount = 0;
    let igstAmount = 0;

    if (isInterState) {
      igstAmount = Math.round(taxableDeliveryCharge * 0.18 * 100) / 100;
    } else if (isUnionTerritory) {
      cgstAmount = Math.round(taxableDeliveryCharge * 0.09 * 100) / 100;
      utgstAmount = Math.round((taxableDeliveryCharge * 0.18 - cgstAmount) * 100) / 100;
    } else {
      cgstAmount = Math.round(taxableDeliveryCharge * 0.09 * 100) / 100;
      sgstAmount = Math.round((taxableDeliveryCharge * 0.18 - cgstAmount) * 100) / 100;
    }

    const totalGstAmount = Math.round((cgstAmount + sgstAmount + utgstAmount + igstAmount) * 100) / 100;

    // Step 5: GST-inclusive delivery total (pre-rounding)
    const preRoundingDeliveryTotal = Math.round((taxableDeliveryCharge + totalGstAmount) * 100) / 100;

    // Step 6: Existing Rounding Rule (Math.round) & Final Customer Delivery Charge
    const finalDeliveryCharge = Math.round(preRoundingDeliveryTotal);
    const roundingAdjustment = Math.round((finalDeliveryCharge - preRoundingDeliveryTotal) * 100) / 100;

    const deliveryBreakdown: DeliveryChargeBreakdown = {
      calculatedDeliveryCharge,
      qcomDeliveryMarkup,
      taxableDeliveryCharge,
      gstRate,
      cgstAmount,
      sgstAmount,
      utgstAmount: isUnionTerritory ? utgstAmount : undefined,
      igstAmount,
      totalGstAmount,
      preRoundingDeliveryTotal,
      roundingAdjustment,
      finalDeliveryCharge,
      isFreeDelivery: false
    };

    return {
      deliveryCharge: finalDeliveryCharge,
      deliveryBreakdown,
      appliedSlab,
      roundedDistanceM: roundedDistM,
      free_delivery_threshold: this.config.free_delivery_threshold,
      amount_remaining_for_free_delivery: freeDelivery.amountRemaining,
      freeDeliveryThreshold: this.config.free_delivery_threshold,
      amountRemainingForFreeDelivery: freeDelivery.amountRemaining,
      ...deliveryBreakdown
    };
  }

  // ---------------------------------------------------------------------------
  // CHECKOUT QUOTE GENERATION (Step 9, 13, 14, 15 & Part 2 Economics)
  // ---------------------------------------------------------------------------

  public generateCheckoutQuote(req: CheckoutQuoteRequest): CheckoutQuoteResponse {
    const quoteId = `QUOTE-${Date.now().toString().slice(-6)}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
    const quoteExpiry = new Date(Date.now() + this.config.quote_validity_seconds * 1000).toISOString();

    if (!req.cartItems || !Array.isArray(req.cartItems) || req.cartItems.length === 0) {
      return this.createErrorQuote(quoteId, quoteExpiry, 'Cart is empty. Please add items to checkout.');
    }

    const customerCoords = req.deliveryCoordinates || { lat: 12.9352, lng: 77.6245 }; // Default Bangalore site if GPS not pinned

    // 1. Evaluate Seller Eligibility across all sellers
    const eligibilityResults = this.determineEligibleSellers(customerCoords, req.cartItems);
    const eligibleSellers = eligibilityResults.filter(s => s.isEligible);

    if (eligibleSellers.length === 0) {
      const topRejection = eligibilityResults[0]?.rejectionReason || 'No service partner available for your address';
      return this.createErrorQuote(quoteId, quoteExpiry, `Serviceability error: ${topRejection}`);
    }

    // 2. Validate Items & Basic Pricing
    const verifiedItems: CheckoutQuoteResponse['verifiedItems'] = [];
    let itemsSubtotal = 0;
    let itemsOriginalTotal = 0;
    let totalTaxableValue = 0;
    let totalGst = 0;
    let totalCgst = 0;
    let totalSgst = 0;
    let totalUtgst = 0;
    let totalIgst = 0;

    const buyerStateCode = req.buyerStateCode || '29';
    const isInterState = buyerStateCode !== '29';
    const isUnionTerritory = !isInterState && ['04', '26', '31', '35', '38', '97'].includes(buyerStateCode);
    const placeOfSupply = `${buyerStateCode} - ${req.buyerState || 'KARNATAKA'}`;
    const supplyType = isInterState 
      ? 'INTER-STATE (IGST)' 
      : (isUnionTerritory ? 'INTRA-STATE (CGST + UTGST)' : 'INTRA-STATE (CGST + SGST)');

    for (const item of req.cartItems) {
      const prod = this.productsCatalog.get(item.productId);
      if (!prod) {
        return this.createErrorQuote(quoteId, quoteExpiry, `Product '${item.productId}' not found in catalog.`);
      }

      const qty = Math.max(1, Math.min(50, Number(item.quantity) || 1));
      const unitPrice = prod.price;
      const originalPrice = prod.originalPrice || unitPrice;
      const lineTotal = unitPrice * qty;
      const lineOriginal = originalPrice * qty;
      const gstRate = typeof prod.gstRatePercent === 'number' ? prod.gstRatePercent : 18;

      const itemTaxable = Math.round((lineTotal / (1 + (gstRate / 100))) * 100) / 100;
      const lineGst = Math.round((lineTotal - itemTaxable) * 100) / 100;

      let itemCgst = 0;
      let itemSgst = 0;
      let itemUtgst = 0;
      let itemIgst = 0;

      if (req.isGstEnabled) {
        if (isInterState) {
          itemIgst = lineGst;
        } else if (isUnionTerritory) {
          itemCgst = Math.round((lineGst / 2) * 100) / 100;
          itemUtgst = Math.round((lineGst - itemCgst) * 100) / 100;
        } else {
          itemCgst = Math.round((lineGst / 2) * 100) / 100;
          itemSgst = Math.round((lineGst - itemCgst) * 100) / 100;
        }
      }

      itemsSubtotal += lineTotal;
      itemsOriginalTotal += lineOriginal;
      totalTaxableValue += itemTaxable;
      totalGst += lineGst;
      totalCgst += itemCgst;
      totalSgst += itemSgst;
      totalUtgst += itemUtgst;
      totalIgst += itemIgst;

      verifiedItems.push({
        product: prod,
        quantity: qty,
        unitPrice,
        lineTotal,
        gstRatePercent: gstRate,
        taxableValue: itemTaxable,
        lineGst,
        cgst: itemCgst,
        sgst: itemSgst,
        utgst: itemUtgst,
        igst: itemIgst
      });
    }

    const mrpDiscount = Math.max(0, itemsOriginalTotal - itemsSubtotal);

    // 3. Calculate Eligible Cart Value for Free Delivery & Handling
    const sellerFundedDiscounts = Math.max(0, Number(req.sellerFundedDiscounts) || 0);
    const eligibleCartValue = Math.max(0, itemsSubtotal - sellerFundedDiscounts);
    const handlingCharge = this.calculateHandlingCharge(itemsSubtotal);

    // 4. Calculate Coupon Discounts
    let couponDiscount = 0;
    let appliedCouponCode: string | null = null;
    if (req.couponCode && typeof req.couponCode === 'string') {
      const code = req.couponCode.trim().toUpperCase();
      if (code === 'PROBUILD' && itemsSubtotal >= 499) {
        couponDiscount = Math.min(Math.round(itemsSubtotal * 0.15), 250);
        appliedCouponCode = code;
      } else if (code === 'SPEEDSITE' && itemsSubtotal >= 299) {
        couponDiscount = 50;
        appliedCouponCode = code;
      } else if (code === 'ELECTRO100' && itemsSubtotal >= 999) {
        couponDiscount = 100;
        appliedCouponCode = code;
      }
    }

    const totalDiscounts = mrpDiscount + couponDiscount;
    const riderTip = Math.min(500, Math.max(0, Math.round(Number(req.riderTip) || 0)));
    const econConfig = DeliveryEconomicsService.getConfig();

    // 5. Part 2 Multi-Attribute Fulfilment Selection & Delivery Economics Scoring
    const scoredCandidates = eligibleSellers.map(seller => {
      // Calculate commission specific to this candidate seller
      const commResult = this.calculateCommission(
        verifiedItems.map(vi => ({ product: vi.product, quantity: vi.quantity, sellerId: seller.sellerId })),
        appliedCouponCode
      );

      // Customer delivery charge for this seller's distance with 6-step pricing
      const delivCalc = this.calculateCustomerDeliveryCharge(eligibleCartValue, seller.actualRouteDistanceMeters, buyerStateCode);
      const custDelivCharge = delivCalc.deliveryCharge;

      // Internal Actual Delivery Cost (Rider Payout)
      const delivCostBreakdown = DeliveryEconomicsService.calculateActualDeliveryCost({
        actualRouteDistanceMeters: seller.actualRouteDistanceMeters,
        estimatedTransitMinutes: seller.estimatedEtaMinutes,
        isBatched: req.isBatched
      });
      const actualDelivCost = delivCostBreakdown.actualDeliveryCost;

      const finalPayable = Math.max(
        0,
        itemsSubtotal + handlingCharge + custDelivCharge + riderTip - couponDiscount
      );

      const contributionResult = DeliveryEconomicsService.evaluateOrderContribution({
        sellerPrice: itemsSubtotal,
        commissionAmount: commResult.totalCommissionAmount,
        handlingRevenue: handlingCharge,
        customerDeliveryRevenue: custDelivCharge,
        actualDeliveryCost: actualDelivCost,
        finalCustomerPayable: finalPayable,
        platformFundedCouponDiscount: couponDiscount
      });

      // Composite Multi-Attribute Utility Score: 50% Economics + 35% SLA/ETA + 15% Reliability
      const econScore = Math.max(0, Math.min(100, 50 + contributionResult.orderContribution * 1.5));
      const slaScore = Math.max(0, Math.min(100, 100 - seller.estimatedEtaMinutes * 1.8));
      const compositeScore = Math.round((econScore * 0.50 + slaScore * 0.35 + 95 * 0.15) * 100) / 100;

      return {
        seller,
        commResult,
        delivCalc,
        actualDelivCost,
        delivCostBreakdown,
        contributionResult,
        compositeScore,
        finalPayable
      };
    });

    // Filter candidates that meet viability rules (positive contribution or approved promotional subsidy)
    const viableCandidates = scoredCandidates.filter(c => c.contributionResult.isViable);

    if (viableCandidates.length === 0) {
      // If all candidates exceed subsidy limits, reject with clear reason
      const worst = scoredCandidates[0];
      return this.createErrorQuote(
        quoteId, 
        quoteExpiry, 
        `Delivery unavailable: ${worst.contributionResult.rejectionReason || 'Order cannot be economically fulfilled within configured limits.'}`
      );
    }

    // Rank viable candidates by composite fulfilment score
    viableCandidates.sort((a, b) => b.compositeScore - a.compositeScore);

    const winningCandidate = viableCandidates[0];
    const selectedSellerId = winningCandidate.seller.sellerId;
    const selectedSellerName = winningCandidate.seller.sellerName;
    const actualRouteDistanceM = winningCandidate.seller.actualRouteDistanceMeters;
    const roundedRouteDistanceM = winningCandidate.seller.roundedRouteDistanceMeters;
    const deliveryEtaMinutes = winningCandidate.seller.estimatedEtaMinutes;
    const deliveryCharge = winningCandidate.delivCalc.deliveryCharge;
    const deliveryChargeBreakdown = winningCandidate.delivCalc.deliveryBreakdown;
    const finalPayableAmount = winningCandidate.finalPayable;
    const commissionResult = winningCandidate.commResult;
    const contributionResult = winningCandidate.contributionResult;
    const actualDeliveryCost = winningCandidate.actualDelivCost;
    const deliverySubsidy = contributionResult.deliverySubsidy;

    const totalSavings = mrpDiscount + couponDiscount + (winningCandidate.delivCalc.isFreeDelivery ? 39 : 0);
    const freeDeliveryInfo = this.determineFreeDeliveryEligibility(eligibleCartValue, actualRouteDistanceM);

    const selectionReason = `Selected ${selectedSellerName} (Score: ${winningCandidate.compositeScore}). Contribution: ₹${contributionResult.orderContribution}, Delivery Cost: ₹${actualDeliveryCost}, Cust Delivery: ₹${deliveryCharge}, Subsidy: ₹${deliverySubsidy}, ETA: ${deliveryEtaMinutes}m.`;

    // 8. Construct Authoritative Persistent Price Snapshot with Part 1 & Part 2 fields
    const priceSnapshot = {
      seller_price: itemsSubtotal,
      applicable_commission_rate: commissionResult.weightedCommissionRate,
      commission_amount: commissionResult.totalCommissionAmount,
      handling_charge: handlingCharge,
      customer_delivery_charge: deliveryCharge,
      delivery_charge_breakdown: deliveryChargeBreakdown,
      calculated_delivery_charge: deliveryChargeBreakdown.calculatedDeliveryCharge,
      qcom_delivery_markup: deliveryChargeBreakdown.qcomDeliveryMarkup,
      taxable_delivery_charge: deliveryChargeBreakdown.taxableDeliveryCharge,
      delivery_gst_amount: deliveryChargeBreakdown.totalGstAmount,
      delivery_rounding_adjustment: deliveryChargeBreakdown.roundingAdjustment,
      discounts: totalDiscounts,
      taxes: Math.round(totalGst * 100) / 100,
      final_customer_payable: finalPayableAmount,
      seller_id: selectedSellerId,
      actual_route_distance_m: actualRouteDistanceM,
      rounded_route_distance_m: roundedRouteDistanceM,
      pricing_rule_version: this.config.pricing_rule_version,
      // Part 2 internal audit
      actual_delivery_cost: actualDeliveryCost,
      delivery_subsidy: deliverySubsidy,
      qcom_revenue: contributionResult.qcomRevenue.totalQcomRevenue,
      variable_costs: contributionResult.variableCosts.totalVariableCosts,
      order_contribution: contributionResult.orderContribution,
      is_contribution_positive: contributionResult.isContributionPositive,
      fulfilment_selection_reason: selectionReason,
      is_batched: Boolean(req.isBatched)
    };

    return {
      success: true,
      quoteId,
      quoteExpiry,
      pricingRuleVersion: this.config.pricing_rule_version,
      itemsSubtotal,
      itemsOriginalTotal,
      mrpDiscount,
      couponDiscount,
      appliedCouponCode,
      totalDiscounts,
      handlingCharge,
      deliveryCharge,
      deliveryChargeBreakdown,
      taxes: {
        taxableValue: Math.round(totalTaxableValue * 100) / 100,
        totalGst: Math.round(totalGst * 100) / 100,
        cgst: Math.round(totalCgst * 100) / 100,
        sgst: Math.round(totalSgst * 100) / 100,
        utgst: Math.round(totalUtgst * 100) / 100,
        igst: Math.round(totalIgst * 100) / 100,
        isInterState,
        isUnionTerritory,
        placeOfSupply,
        supplyType
      },
      riderTip,
      finalPayableAmount,
      totalSavings,
      freeDeliveryEligible: winningCandidate.delivCalc.isFreeDelivery,
      freeDeliveryThreshold: freeDeliveryInfo.threshold,
      amountRemainingForFreeDelivery: freeDeliveryInfo.amountRemaining,
      selectedSellerId,
      selectedSellerName,
      eligibleSellers: eligibilityResults,
      actualRouteDistanceM,
      roundedRouteDistanceM,
      deliveryEtaMinutes,
      priceSnapshot,
      verifiedItems
    };
  }

  private createErrorQuote(quoteId: string, quoteExpiry: string, error: string): CheckoutQuoteResponse {
    const emptyBreakdown: DeliveryChargeBreakdown = {
      calculatedDeliveryCharge: 0,
      qcomDeliveryMarkup: 0,
      taxableDeliveryCharge: 0,
      gstRate: 18,
      cgstAmount: 0,
      sgstAmount: 0,
      utgstAmount: 0,
      igstAmount: 0,
      totalGstAmount: 0,
      preRoundingDeliveryTotal: 0,
      roundingAdjustment: 0,
      finalDeliveryCharge: 0,
      isFreeDelivery: false
    };

    return {
      success: false,
      quoteId,
      quoteExpiry,
      pricingRuleVersion: this.config.pricing_rule_version,
      itemsSubtotal: 0,
      itemsOriginalTotal: 0,
      mrpDiscount: 0,
      couponDiscount: 0,
      appliedCouponCode: null,
      totalDiscounts: 0,
      handlingCharge: 0,
      deliveryCharge: 0,
      deliveryChargeBreakdown: emptyBreakdown,
      taxes: {
        taxableValue: 0,
        totalGst: 0,
        cgst: 0,
        sgst: 0,
        utgst: 0,
        igst: 0,
        isInterState: false,
        isUnionTerritory: false,
        placeOfSupply: '',
        supplyType: ''
      },
      riderTip: 0,
      finalPayableAmount: 0,
      totalSavings: 0,
      freeDeliveryEligible: false,
      freeDeliveryThreshold: this.config.free_delivery_threshold,
      amountRemainingForFreeDelivery: this.config.free_delivery_threshold,
      selectedSellerId: '',
      selectedSellerName: '',
      eligibleSellers: [],
      actualRouteDistanceM: 0,
      roundedRouteDistanceM: 0,
      deliveryEtaMinutes: 0,
      priceSnapshot: {
        seller_price: 0,
        applicable_commission_rate: 0,
        commission_amount: 0,
        handling_charge: 0,
        customer_delivery_charge: 0,
        delivery_charge_breakdown: emptyBreakdown,
        calculated_delivery_charge: 0,
        qcom_delivery_markup: 0,
        taxable_delivery_charge: 0,
        delivery_gst_amount: 0,
        delivery_rounding_adjustment: 0,
        discounts: 0,
        taxes: 0,
        final_customer_payable: 0,
        seller_id: '',
        actual_route_distance_m: 0,
        rounded_route_distance_m: 0,
        pricing_rule_version: this.config.pricing_rule_version
      },
      verifiedItems: [],
      error
    };
  }
}

export const CustomerPricingService = new CentralizedCustomerPricingService();
