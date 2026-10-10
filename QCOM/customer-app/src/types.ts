export type TradeCategory = 
  | 'all' 
  | 'lighting'
  | 'fans'
  | 'switches'
  | 'bathroom_fittings'
  | 'kitchen_fittings'
  | 'plumbing' 
  | 'electrical' 
  | 'carpentry'
  | 'screws' 
  | 'cutting_discs' 
  | 'cutters' 
  | 'fasteners' 
  | 'tools' 
  | 'adhesives' 
  | 'safety';

export interface SavedGstinRecord {
  id: string;
  gstin: string; // 15 chars e.g. 29AABCP1429B1Z8
  legalBusinessName: string; // e.g. "Apex Infra & Renovations LLP"
  tradeName?: string; // e.g. "Indiranagar Site B"
  billingAddress: string;
  state?: string; // e.g. "Karnataka"
  stateCode?: string; // e.g. "29"
  pincode?: string; // 6 digits e.g. "560034"
  isDefault?: boolean;
  createdAt?: string;
}

export interface CustomerGstProfile {
  isB2BEnabled?: boolean;
  gstin: string; // 15 chars e.g. 29AABCS1429B1Z8 (Active/Default GSTIN)
  legalBusinessName: string; // e.g. "Apex Infra & Renovations LLP"
  tradeName?: string;
  billingAddress: string;
  state: string;
  stateCode: string; // e.g. "29 - Karnataka"
  pincode?: string;
  contactPerson?: string;
  contactEmail?: string;
  savedGstins?: SavedGstinRecord[];
}

export interface CustomerProfile {
  id?: string;
  name: string;
  phone: string;
  email: string;
  isPhoneVerified?: boolean;
  accountType?: 'individual' | 'business';
  defaultAddress?: string;
  floorUnit?: string;
  landmark?: string;
  defaultAddressId?: string;
  gstProfile: CustomerGstProfile;
  savedAddresses?: JobSiteLocation[];
  createdAt?: string;
}

export interface SellerPartner {
  id: string;
  name: string;
  locality: string;
  address: string;
  coordinates: {
    lat: number;
    lng: number;
  };
  accessibleEntranceCoords?: {
    lat: number;
    lng: number;
  };
  pickupNotes?: string;
  rating: number;
  reviewsCount: number;
  phone: string;
  gstin: string;
  isGstRegistered: boolean;
  specialty: string;
  badge?: string;
  basePrepMins: number;
  serviceRadiusMeters?: number;
  maxRoadDistanceMeters?: number;
  maxDeliveryTimeMinutes?: number;
  serviceStatus?: 'active' | 'inactive' | 'open' | 'closed';
}

export interface HardwareProduct {
  id: string;
  name: string;
  category: TradeCategory;
  subcategory: string;
  subCategory?: string;
  brand?: string;
  mrp?: number;
  specifications?: string | Record<string, any>;
  price: number; // in INR ₹
  originalPrice?: number;
  rating: number;
  reviewsCount: number;
  specs: {
    size?: string;
    material?: string;
    standard?: string;
    brand: string;
    thread?: string;
    ratingVoltage?: string;
    color?: string;
  };
  description: string;
  stockCount: number;
  binLocation: string; // e.g. "Aisle 3 - Bin 14B"
  sellerId?: string; // Links to SellerPartner
  sellerName?: string; // e.g. "Sri Lakshmi Electricals & Hardware"
  sellerAddress?: string; // e.g. "5th Block, Koramangala"
  sellerLocality?: string; // e.g. "Koramangala"
  sellerCoordinates?: { lat: number; lng: number };
  sellerRating?: number; // e.g. 4.9
  sellerDistanceKm?: number; // Calculated dynamic distance
  sellerGstin?: string; // e.g. "29AABCU9603R1ZM"
  isGstRegistered?: boolean; // true = 100% ITC Eligible Tax Invoice
  gstRatePercent?: number; // e.g. 5, 12, 18, 28 (for 18% GST)
  hsnCode?: string; // e.g. "8481", "8536", "7318"
  itcEligible?: boolean; // true = Input Tax Credit claimable
  deliveryTimeMins: number; // Calculated dynamic ETA
  imageUrl?: string;
  badge?: 'High Demand' | 'Delivery Essential' | 'Jobsite Essential' | 'Pro Choice' | 'Bulk Pack';
  frequentlyBoughtWith?: string[]; // IDs of companion items
  tags: string[];
}

export interface CartItem {
  product: HardwareProduct;
  quantity: number;
}

export interface AddressLocation {
  address: string;
  landmark?: string;
  floorUnit?: string;
  gateCode?: string;
  siteContactName: string; // Contact Name (e.g. Rahul Sharma)
  sitePhone: string; // Contact Number (e.g. +91 98450 12891)
  tradeType?: string; // Optional default
  jobTag?: string; // Optional notes
  coordinates: {
    lat: number;
    lng: number;
  };
  accessibleEntranceCoords?: {
    lat: number;
    lng: number;
  };
  dropoffInstructions?: string;
}

export type JobSiteLocation = AddressLocation;

export type OrderStatus = 'placed' | 'picking' | 'packed' | 'out_for_delivery' | 'arriving' | 'delivered' | 'cancelled';

export interface OrderTimelineStep {
  status: OrderStatus;
  title: string;
  description: string;
  time: string;
  done: boolean;
}

export interface DeliveryChargeBreakdown {
  calculatedDeliveryCharge: number; // Base calculated delivery charge
  qcomDeliveryMarkup: number; // QCOM delivery markup added
  taxableDeliveryCharge: number; // Base + Markup (taxable delivery value)
  gstRate: number; // 18% GST
  cgstAmount: number; // 9% for intra-state regular
  sgstAmount: number; // 9% for intra-state regular
  utgstAmount?: number; // 9% for intra-state union territory
  igstAmount: number; // 18% for inter-state
  totalGstAmount: number; // Total GST on delivery
  preRoundingDeliveryTotal: number; // Taxable + Total GST (pre-rounding)
  roundingAdjustment: number; // Final - Pre-Rounding
  finalDeliveryCharge: number; // Authoritative customer delivery charge
  isFreeDelivery: boolean;
}

export interface EInvoiceData {
  invoiceReference?: string;
  legalInvoiceNumber?: string;
  isEInvoice?: boolean;
  irn?: string;
  acknowledgementNumber?: string;
  acknowledgementDate?: string;
  ackNo?: string;
  ackDate?: string;
  signedQRCode?: string;
}

export interface Order {
  id: string;
  items: CartItem[];
  subtotal: number;
  totalAmount?: number;
  deliveryFee: number;
  handlingFee?: number;
  deliveryChargeBreakdown?: DeliveryChargeBreakdown;
  calculatedDeliveryCharge?: number;
  qcomDeliveryMarkup?: number;
  taxableDeliveryCharge?: number;
  deliveryGstAmount?: number;
  deliveryRoundingAdjustment?: number;
  finalDeliveryCharge?: number;
  urgencyFee: number;
  tax: number;
  total: number;
  savingsVsLeavingSite: number; // calculated billable hours saved
  timeSavedMinutes: number;
  status: OrderStatus;
  placedAt: Date;
  estimatedDeliveryAt: Date;
  jobSite: JobSiteLocation;
  customerGstin?: string;
  customerBusinessName?: string;
  customerBillingAddress?: string;
  customerState?: string;
  customerStateCode?: string;
  customerPincode?: string;
  placeOfSupply?: string;
  isInterState?: boolean;
  isUnionTerritory?: boolean;
  taxableAmount?: number;
  cgstAmount?: number;
  sgstAmount?: number;
  utgstAmount?: number;
  igstAmount?: number;
  supplyType?: string;
  itcAmount?: number;
  customerGstProfile?: CustomerGstProfile;
  itcAmountClaimable?: number; // Total GST ITC buyer can claim back in GSTR-3B
  // E-Invoice Ready Optional Fields
  isEInvoice?: boolean;
  irn?: string;
  acknowledgementNumber?: string;
  acknowledgementDate?: string;
  signedQRCode?: string;
  legalInvoiceNumber?: string;
  invoiceReference?: string;
  eInvoiceData?: EInvoiceData;
  sellerEInvoices?: Record<string, EInvoiceData>; // mapped by invoice reference (e.g. '#ORD-123-1') or seller index ('1') or seller id
  eInvoices?: EInvoiceData[];
  sellerPartner?: {
    name: string;
    shopType: string;
    address: string;
    distanceKm: number;
    rating: number;
    phone?: string;
    website?: string;
    gstin?: string;
    isGstRegistered?: boolean;
    itcEligible?: boolean;
    coordinates?: {
      lat: number;
      lng: number;
    };
  };
  darkStore: {
    name: string;
    code: string;
    distanceKm: number;
    pickerName: string;
  };
  rider: {
    name: string;
    phone: string;
    vehicle: string;
    rating: number;
    photo: string;
    currentLocation: {
      lat: number;
      lng: number;
      distanceMeters: number;
    };
  };
  deliveryOtp: string;
  paymentMethod: 'Instant UPI' | 'Corporate Card' | 'Pay on Delivery' | 'Pay on Address' | 'Pay on Jobsite' | 'Trade Credit (Net 30)';
  clientInvoiceNeeded: boolean;
  clientName?: string;
  // Delivery Pricing Audit Data & Locked Commercial Price Snapshot (Part 1 & 2)
  eligible_cart_value?: number;
  free_delivery_threshold?: number;
  actual_route_distance_m?: number;
  rounded_route_distance_m?: number;
  customer_delivery_fee?: number;
  delivery_pricing_rule_version?: string;
  pricingSnapshot?: {
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
}

export interface PartAnalysisResult {
  partName: string;
  confidenceScore: number;
  estimatedSize: string;
  material: string;
  threadType: string;
  commonIssues: string;
  matchedProductIds: string[];
  recommendedAccessories: {
    name: string;
    reason: string;
    productId?: string;
  }[];
  expertTip: string;
}

export type AppMode = 'customer' | 'seller';

export type SellerTab = 'orders' | 'inventory' | 'fleet' | 'analytics' | 'settings';

export interface EVRider {
  id: string;
  name: string;
  phone: string;
  vehicle: string; // e.g. "Bajaj Chetak EV #EV-42"
  batteryPercent: number;
  status: 'idle_at_hub' | 'picking_up' | 'in_transit' | 'returning';
  activeOrderId?: string;
  completedToday: number;
  rating: number;
  photo: string;
}

export interface DarkStoreStats {
  todayGmv: number;
  totalOrders: number;
  avgPickSeconds: number;
  avgDeliveryMinutes: number;
  onTimePercent: number;
}

// Q-Commerce Routing Architecture Interfaces
export interface TurnInstruction {
  text: string;
  distanceMeters: number;
  durationSeconds: number;
  modifier?: string;
  type?: string;
  location: [number, number]; // [lat, lng]
}

export interface RouteCandidate {
  id: string;
  engineProfile: 'osrm_driving' | 'osrm_bike' | 'osrm_foot' | 'urban_shortcut';
  distanceMeters: number;
  durationSeconds: number;
  etaMinutes: number;
  polyline: [number, number][]; // Array of [lat, lng]
  instructions: TurnInstruction[];
  score: number;
  isLegalDrivable: boolean;
  snappedOrigin: [number, number];
  snappedDestination: [number, number];
}

export interface RoutingResponse {
  success: boolean;
  selectedRoute: RouteCandidate;
  alternativeRoutes: RouteCandidate[];
  sellerPickupEntrance: {
    buildingPin: [number, number];
    accessibleEntrancePin: [number, number];
    pickupNotes?: string;
  };
  customerDropoffEntrance: {
    buildingPin: [number, number];
    accessibleEntrancePin: [number, number];
    dropoffInstructions?: string;
  };
  summary: {
    distanceKm: number;
    baseEtaMinutes: number;
    trafficAdjustedEtaMinutes: number;
    totalDeliveryEtaMinutes: number;
    formattedDistance: string;
    formattedEta: string;
    confidenceScore: number;
    routeQuality: 'OPTIMAL_FASTEST' | 'TRAFFIC_BALANCED' | 'SHORTCUT_FALLBACK';
  };
  cached: boolean;
  calculatedAt: string;
}

export interface RerouteRequest {
  orderId: string;
  riderId?: string;
  currentRiderLocation: { lat: number; lng: number };
  destinationLocation: { lat: number; lng: number };
  lastWaypointsVisitedIndex?: number;
}

export interface RouteTelemetryRecord {
  id: string;
  orderId: string;
  sellerId: string;
  originCoords: [number, number];
  destinationCoords: [number, number];
  plannedDistanceMeters: number;
  plannedEtaMinutes: number;
  actualDurationSeconds?: number;
  actualDistanceMeters?: number;
  rerouteCount: number;
  offRouteDeviations: number;
  riderGpsTrace: { lat: number; lng: number; timestamp: number }[];
  createdAt: string;
  completedAt?: string;
}


