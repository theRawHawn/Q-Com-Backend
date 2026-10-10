// System action permissions across all modules
export type AdminPermission =
  | 'dashboard.view'
  | 'orders.view'
  | 'orders.create'
  | 'orders.edit'
  | 'orders.update_status'
  | 'orders.edit_status'
  | 'orders.assign_rider'
  | 'orders.cancel'
  | 'orders.refund'
  | 'orders.export'
  | 'customers.view'
  | 'customers.edit'
  | 'customers.suspend'
  | 'customers.reactivate'
  | 'customers.export'
  | 'sellers.view'
  | 'sellers.create'
  | 'sellers.edit'
  | 'sellers.approve'
  | 'sellers.reject'
  | 'sellers.suspend'
  | 'sellers.reactivate'
  | 'sellers.edit_commission'
  | 'sellers.export'
  | 'products.view'
  | 'products.create'
  | 'products.edit'
  | 'products.delete'
  | 'products.approve'
  | 'products.disable'
  | 'products.export'
  | 'categories.view'
  | 'categories.create'
  | 'categories.edit'
  | 'categories.delete'
  | 'brands.view'
  | 'brands.create'
  | 'brands.edit'
  | 'brands.delete'
  | 'inventory.view'
  | 'inventory.edit_stock'
  | 'inventory.edit_price'
  | 'riders.view'
  | 'riders.create'
  | 'riders.edit'
  | 'riders.approve'
  | 'riders.suspend'
  | 'riders.reactivate'
  | 'riders.assign'
  | 'riders.view_location'
  | 'riders.broadcast'
  | 'riders.export'
  | 'riders.payout'
  | 'delivery.view'
  | 'delivery.assign_rider'
  | 'delivery.reassign_rider'
  | 'delivery.view_live_map'
  | 'delivery.view_eta'
  | 'delivery.manage_exception'
  | 'service_areas.view'
  | 'service_areas.manage'
  | 'payments.view'
  | 'payments.export'
  | 'payments.refund'
  | 'payments.approve_refund'
  | 'payments.reconcile'
  | 'refunds.view'
  | 'refunds.create'
  | 'refunds.approve'
  | 'settlements.view'
  | 'settlements.create'
  | 'settlements.process'
  | 'settlements.approve'
  | 'settlements.export'
  | 'pricing.view'
  | 'pricing.manage'
  | 'promotions.view'
  | 'promotions.create'
  | 'promotions.edit'
  | 'promotions.approve'
  | 'promotions.publish'
  | 'promotions.pause'
  | 'promotions.delete'
  | 'ads.view'
  | 'ads.create'
  | 'ads.edit'
  | 'ads.approve'
  | 'ads.publish'
  | 'ads.pause'
  | 'ads.delete'
  | 'ads.export'
  | 'ads.view_analytics'
  | 'cms.view'
  | 'cms.manage'
  | 'support.view'
  | 'support.create_ticket'
  | 'support.update_ticket'
  | 'support.resolve_ticket'
  | 'support.issue_refund'
  | 'support.manage'
  | 'reports.view'
  | 'reports.export'
  | 'reports.financial'
  | 'reports.operations'
  | 'reports.seller'
  | 'reports.rider'
  | 'reports.customer'
  | 'reports.marketing'
  | 'employees.view'
  | 'employees.create'
  | 'employees.edit'
  | 'employees.activate'
  | 'employees.deactivate'
  | 'employees.suspend'
  | 'users.view'
  | 'users.create'
  | 'users.edit'
  | 'roles.view'
  | 'roles.create'
  | 'roles.edit'
  | 'roles.deactivate'
  | 'roles.assign'
  | 'roles.manage'
  | 'permissions.view'
  | 'permissions.assign'
  | 'audit.view'
  | 'audit_logs.view'
  | 'audit_logs.export'
  | 'settings.view'
  | 'settings.edit'
  | 'settings.manage';

export type AdminRole =
  | 'SUPER_ADMIN'
  | 'OPERATIONS_MANAGER'
  | 'ORDER_OPS_EXEC'
  | 'FINANCE_MANAGER'
  | 'MERCHANT_GROWTH_MGR'
  | 'FLEET_DISPATCHER'
  | 'SUPPORT_LEAD'
  | 'CATALOG_MANAGER'
  | string;

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: AdminRole;
  roleTitle?: string;
  department?: string;
  avatar?: string;
  lastLogin?: string;
  status?: string;
  permissions?: AdminPermission[];
  cityId?: string;
}

export interface AdminRoleDefinition {
  id: string;
  code: string;
  name: string;
  department: string;
  description: string;
  status: 'ACTIVE' | 'INACTIVE';
  isSystemRole: boolean;
  permissions: AdminPermission[];
  createdAt: string;
  updatedAt: string;
}

export interface AdminEmployeeUser {
  id: string;
  employeeCode: string;
  name: string;
  email: string;
  phone: string;
  designation: string;
  department: string;
  roleId: string;
  roleCode: string;
  status: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
  assignedCityId?: string;
  avatar?: string;
  createdAt?: string;
  updatedAt?: string;
  lastLogin?: string;
}

export interface IndianCityConfig {
  id: string;
  name: string;
  state: string;
  region: 'North' | 'South' | 'West' | 'East' | 'Central';
  stateGstPrefix: string;
  status: 'ACTIVE' | 'LAUNCHING_SOON' | 'PAUSED';
  totalZones: number;
  activeZones: number;
  activePartnerStores: number;
  activeRiders: number;
  avgDeliverySlaMins: number;
  defaultSurgeMultiplier: number;
  baseDeliveryFee: number;
  freeDeliveryThreshold: number;
  minOrderValue: number;
  operatingHours?: string;
}

export interface ServiceAreaZone {
  id: string;
  cityId: string;
  name: string;
  city: string;
  state: string;
  region: string;
  pincode: string;
  coordinates: { lat: number; lng: number };
  radiusKm: number;
  isActive: boolean;
  minOrderValue: number;
  baseDeliveryFee: number;
  freeDeliveryThreshold: number;
  operatingHours: string;
  activeSellersCount: number;
  activeRidersCount: number;
  surgeMultiplier: number;
  slaMinutes?: number;
}

export interface AdminOrderItem {
  id: string;
  productId: string;
  title: string;
  hsnCode?: string;
  quantity: number;
  unitPrice: number;
  taxRate?: number;
  taxAmount?: number;
  totalPrice: number;
  image?: string;
  category?: string;
  brand?: string;
}

export interface AdminOrder {
  id: string;
  orderNumber: string;
  customerId: string;
  customerName: string;
  customerPhone: string;
  customerEmail?: string;
  sellerId: string;
  sellerName: string;
  sellerAddress?: string;
  riderId?: string;
  riderName?: string;
  riderPhone?: string;
  status: 'PLACED' | 'CONFIRMED' | 'PACKING' | 'READY_FOR_PICKUP' | 'OUT_FOR_DELIVERY' | 'DELIVERED' | 'CANCELLED' | 'REFUNDED';
  paymentStatus: 'PAID' | 'PENDING' | 'FAILED' | 'REFUNDED';
  paymentMethod: 'UPI' | 'CARD' | 'NET_BANKING' | 'COD';
  subtotal: number;
  taxAmount: number;
  deliveryFee: number;
  platformFee: number;
  totalAmount: number;
  itemsCount: number;
  items: AdminOrderItem[];
  deliveryAddress: {
    line1: string;
    line2?: string;
    city: string;
    pincode: string;
    landmark?: string;
    coordinates?: { lat: number; lng: number };
  };
  cityId: string;
  zoneId?: string;
  createdAt: string;
  placedAt?: string;
  dispatchedAt?: string;
  deliveredAt?: string;
  cancelledAt?: string;
  cancellationReason?: string;
  slaTargetMinutes?: number;
  etaMinutes?: number;
  notes?: string;
}

export interface UploadedDocument {
  id: string;
  documentType: string;
  documentName: string;
  documentUrl: string;
  status: 'VERIFIED' | 'PENDING' | 'REJECTED' | 'EXPIRED';
  uploadedAt: string;
  verifiedAt?: string;
  rejectionReason?: string;
}

export interface AdminSeller {
  id: string;
  storeCode: string;
  name: string;
  ownerName: string;
  phone: string;
  email: string;
  gstin: string;
  panNumber: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'PENDING_APPROVAL' | 'REJECTED';
  hubType: 'EXCLUSIVE_DARK_STORE' | 'AUTHORIZED_RETAILER' | 'OEM_WAREHOUSE';
  cityId: string;
  zoneId?: string;
  address: {
    line1: string;
    city: string;
    state: string;
    pincode: string;
  } | string;
  commissionRate: number;
  rating: number;
  totalOrders: number;
  totalGmv: number;
  activeInventoryCount: number;
  bankAccount: {
    accountNumber: string;
    ifsc: string;
    bankName: string;
    beneficiaryName: string;
  };
  documents: UploadedDocument[];
  createdAt: string;
  operatingHours?: string;
  categories?: string[];
  suspensionReason?: string;
}

export interface AdminSellerLedgerEntry {
  id: string;
  sellerId: string;
  type: 'ORDER_CREDIT' | 'COMMISSION_DEBIT' | 'TCS_GST_DEBIT' | 'TDS_DEBIT' | 'PAYOUT_DISBURSEMENT' | 'REFUND_CLAWBACK' | 'ADJUSTMENT';
  amount: number;
  balanceAfter: number;
  description: string;
  referenceId: string;
  referenceType: 'ORDER' | 'SETTLEMENT' | 'DISPUTE' | 'MANUAL';
  createdAt: string;
  status: 'SETTLED' | 'PENDING' | 'HOLD';
}

export interface AdminRider {
  id: string;
  riderCode: string;
  name: string;
  phone: string;
  email: string;
  vehicleType: 'EV_2W' | 'EV_3W' | 'PETROL_2W' | 'BICYCLE';
  vehiclePlate: string;
  drivingLicenseNumber: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'PENDING_APPROVAL' | 'REJECTED';
  dutyStatus: 'ON_DUTY' | 'OFF_DUTY' | 'BUSY_DELIVERY';
  cityId: string;
  zoneId?: string;
  currentLocation?: { lat: number; lng: number; lastUpdated?: string };
  activeOrdersCount: number;
  completedOrdersCount: number;
  rating: number;
  walletBalance: number;
  totalEarnings: number;
  bankAccount: {
    accountNumber: string;
    ifsc: string;
    bankName: string;
    beneficiaryName: string;
  };
  documents: UploadedDocument[];
  createdAt: string;
  onboardingStatus?: string;
  suspensionReason?: string;
}

export interface AdminRiderLedgerEntry {
  id: string;
  riderId: string;
  type: 'TRIP_EARNING' | 'DISTANCE_PAY' | 'SURGE_BONUS' | 'TIPS' | 'WITHDRAWAL' | 'DEDUCTION';
  amount: number;
  balanceAfter: number;
  description: string;
  tripId?: string;
  createdAt: string;
  status: 'COMPLETED' | 'PENDING' | 'FAILED';
}

export interface AdminCustomer {
  id: string;
  name: string;
  phone: string;
  email: string;
  tradeType: 'GENERAL_CUSTOMER' | 'ELECTRICAL_CONTRACTOR' | 'PLUMBING_CONTRACTOR' | 'BUILDING_CONTRACTOR' | 'INDUSTRIAL_BUYER';
  gstin?: string;
  companyName?: string;
  tier: 'RETAIL' | 'PRO_CONTRACTOR' | 'ENTERPRISE_VIP';
  status: 'ACTIVE' | 'SUSPENDED';
  totalOrders: number;
  totalSpend: number;
  savedAddressesCount: number;
  cityId: string;
  createdAt: string;
  lastOrderAt?: string;
}

export interface ProductSellerStock {
  sellerId: string;
  sellerName: string;
  stock: number;
  costPrice: number;
  sellingPrice: number;
  binLocation?: string;
}

export interface AdminProduct {
  id: string;
  sku: string;
  title: string;
  brand: string;
  category: string;
  subCategory: string;
  hsnCode: string;
  gstRate: number;
  mrp: number;
  sellingPrice: number;
  unit: string;
  stock: number;
  status: 'ACTIVE' | 'OUT_OF_STOCK' | 'DELISTED' | 'PENDING_APPROVAL';
  image: string;
  description?: string;
  sellerStocks?: ProductSellerStock[];
  createdAt: string;
}

export interface AdminRefund {
  id: string;
  refundNumber: string;
  orderId: string;
  orderNumber: string;
  customerId: string;
  customerName: string;
  customerPhone: string;
  amount: number;
  reason: string;
  status: 'REQUESTED' | 'APPROVED' | 'PROCESSED' | 'REJECTED';
  paymentMethod: 'ORIGINAL_SOURCE' | 'INSTANT_UPI' | 'WALLET_CREDIT';
  upiId?: string;
  bankAccount?: string;
  sellerClawbackAmount?: number;
  approvedBy?: string;
  rejectedBy?: string;
  rejectionReason?: string;
  createdAt: string;
  processedAt?: string;
  items?: { title: string; quantity: number; amount: number }[];
}

export interface AdminRefundDispute {
  id: string;
  refundId: string;
  orderId: string;
  disputedBy: string;
  partyType: 'MERCHANT' | 'CUSTOMER' | 'RIDER';
  reason: string;
  status: 'OPEN' | 'UNDER_INVESTIGATION' | 'RESOLVED' | 'REJECTED';
  claimAmount: number;
  evidenceUrls: string[];
  notes: string;
  createdAt: string;
  resolvedAt?: string;
  resolution?: string;
}

export interface RefundPolicyConfig {
  autoApprovalThreshold: number;
  claimWindowHours: number;
  requireManagerApprovalAbove: number;
  instantUpiEnabled: boolean;
  allowPartialItemRefunds: boolean;
  sellerClawbackDefaultPercent: number;
  maxDailyRefundQuota: number;
}

export interface AdminSettlement {
  id: string;
  settlementNumber: string;
  sellerId: string;
  sellerName: string;
  periodStart: string;
  periodEnd: string;
  grossSales: number;
  commissionDeduction: number;
  tcsGstDeduction: number;
  tdsDeduction: number;
  refundClawback: number;
  netPayout: number;
  status: 'GENERATED' | 'APPROVED' | 'PROCESSING' | 'PAID' | 'ON_HOLD';
  bankReference?: string;
  processedAt?: string;
  createdAt: string;
}

export interface PricingConfig {
  freeDeliveryThreshold: number;
  baseDeliveryFee: number;
  platformFee: number;
  urgencyHandlingFee: number;
  defaultSellerCommissionPercent: number;
  riderBasePay: number;
  riderPerKmPay: number;
  surgeActive: boolean;
  surgeMultiplier: number;
}

export interface AuditLogEntry {
  id: string;
  timestamp: string;
  adminId: string;
  adminRole: string;
  action: string;
  targetEntity: string;
  targetId?: string;
  details?: any;
  ipAddress?: string;
}

export type AdminAuditLog = AuditLogEntry;

export interface SupportTicket {
  id: string;
  ticketNumber: string;
  raisedByName: string;
  raisedByType: 'CUSTOMER' | 'CONTRACTOR' | 'SELLER' | 'RIDER';
  customerName?: string;
  customerPhone?: string;
  sellerName?: string;
  riderName?: string;
  orderNumber?: string;
  category: 'DELIVERY_DELAY' | 'DAMAGED_ITEM' | 'PAYMENT_ISSUE' | 'SELLER_DISPUTE' | 'RIDER_BEHAVIOR' | 'TECHNICAL_BUG';
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  status: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED';
  subject: string;
  description: string;
  assignedTo?: string;
  createdAt: string;
  updatedAt?: string;
  resolutionNotes?: string;
}

export interface AdminPromotion {
  id: string;
  code: string;
  title: string;
  description: string;
  discountType: 'PERCENTAGE' | 'FIXED_AMOUNT';
  discountValue: number;
  minOrderValue: number;
  maxDiscount: number;
  fundedBy: 'PLATFORM_100' | 'SELLER_50_50' | 'BRAND_SPONSORED';
  sellerSharePercent: number;
  startDate: string;
  endDate: string;
  status: 'ACTIVE' | 'PAUSED' | 'EXPIRED' | 'SCHEDULED';
  totalUsage: number;
  usageLimit?: number;
  cityId?: string;
}

export type AdPlacement = 'HOMEPAGE_HERO' | 'CATEGORY_TOP' | 'SEARCH_TOP' | 'CHECKOUT_PAGE';

export interface SponsoredAdCampaign {
  id: string;
  brandName: string;
  title: string;
  placement: AdPlacement;
  targetKeyword?: string;
  targetCategory?: string;
  bidCpm: number;
  dailyBudget: number;
  totalBudget: number;
  spent: number;
  impressions: number;
  clicks: number;
  status: 'ACTIVE' | 'PAUSED' | 'PENDING_APPROVAL' | 'COMPLETED' | 'REJECTED';
  startDate: string;
  endDate: string;
  bannerUrl?: string;
}

export interface CmsHeroBanner {
  id: string;
  title: string;
  subtitle: string;
  imageUrl: string;
  ctaText: string;
  ctaLink: string;
  placement: 'HERO_CAROUSEL' | 'PROMO_STRIP' | 'MID_FEED_BANNER';
  cityId?: string;
  status: 'ACTIVE' | 'INACTIVE';
  priority: number;
  startDate?: string;
  endDate?: string;
}

export interface CmsCuratedCollection {
  id: string;
  title: string;
  tagline: string;
  icon?: string;
  productIds: string[];
  status: 'ACTIVE' | 'INACTIVE';
  priority: number;
}

export const NON_FOOD_GROCERY_CATEGORIES = [
  'Electrical & Lighting',
  'Hardware & Fasteners',
  'Plumbing & Sanitary',
  'Paints & Wall Finishes',
  'Power Tools & Machinery',
  'Hand Tools & Safety Gear',
  'Building Materials & Cement',
  'Tiles, Flooring & Adhesives',
  'Doors, Windows & Fittings',
  'Safety, Security & Locks',
  'Automotive Spares & Tools',
  'Pipes & Water Fittings',
] as const;
