import { authoritativeProductStore } from './store';
import { CartItem, HardwareProduct, DeliveryChargeBreakdown } from '../src/types';
import { 
  CustomerPricingService, 
  AdminCommercialConfig, 
  SellerGeofenceConfig,
  CheckoutQuoteRequest,
  CheckoutQuoteResponse,
  SellerEligibilityCheckResult
} from '../src/utils/customerPricingService';

export interface CouponRule {
  code: string;
  discountType: 'percentage' | 'flat';
  value: number; // e.g. 15 for 15% or 100 for ₹100 flat
  minOrderValue: number;
  maxDiscountCap: number;
  allowedCategories?: string[];
  expiresAt: string;
  description: string;
}

// Server-side authoritative promo codes rulebook
export const AUTHORITATIVE_COUPONS: Record<string, CouponRule> = {
  'PROBUILD': {
    code: 'PROBUILD',
    discountType: 'percentage',
    value: 15, // 15% off
    minOrderValue: 499,
    maxDiscountCap: 250,
    expiresAt: '2026-12-31T23:59:59.000Z',
    description: '15% Off on orders above ₹499 (Max ₹250)'
  },
  'SPEEDSITE': {
    code: 'SPEEDSITE',
    discountType: 'flat',
    value: 50,
    minOrderValue: 299,
    maxDiscountCap: 50,
    expiresAt: '2026-12-31T23:59:59.000Z',
    description: 'Flat ₹50 Off on orders above ₹299'
  },
  'ELECTRO100': {
    code: 'ELECTRO100',
    discountType: 'flat',
    value: 100,
    minOrderValue: 999,
    maxDiscountCap: 100,
    allowedCategories: ['electrical', 'switches', 'lighting', 'fans'],
    expiresAt: '2026-12-31T23:59:59.000Z',
    description: 'Flat ₹100 Off on Electrical Supplies above ₹999'
  }
};

export interface AuthoritativePriceBreakdown {
  itemsSubtotal: number;
  itemsOriginalTotal: number;
  mrpDiscount: number;
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
  deliveryFee: number;
  deliveryChargeBreakdown?: DeliveryChargeBreakdown;
  handlingFee: number;
  riderTip: number;
  couponDiscount: number;
  appliedCouponCode: string | null;
  totalAmount: number;
  totalSavings: number;
  // Delivery Pricing Audit Data
  eligible_cart_value: number;
  free_delivery_threshold: number;
  actual_route_distance_m: number;
  rounded_route_distance_m: number;
  customer_delivery_fee: number;
  delivery_pricing_rule_version: string;
  selected_seller_id?: string;
  selected_seller_name?: string;
  eligible_sellers?: SellerEligibilityCheckResult[];
  price_snapshot?: {
    seller_price: number;
    applicable_commission_rate: number;
    commission_amount: number;
    handling_charge: number;
    customer_delivery_charge: number;
    discounts: number;
    taxes: number;
    final_customer_payable: number;
    seller_id: string;
    actual_route_distance_m: number;
    rounded_route_distance_m: number;
    pricing_rule_version: string;
  };
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
}

export interface PricingCalculationRequest {
  customerId?: string;
  deliveryAddressId?: string;
  items: { productId: string; quantity: number; sellerId?: string }[];
  couponCode?: string | null;
  isGstEnabled?: boolean;
  buyerGstin?: string | null;
  buyerStateCode?: string | null;
  buyerState?: string | null;
  buyerAddress?: string | null;
  buyerPincode?: string | null;
  riderTip?: number;
  deliveryCoordinates?: { lat: number; lng: number };
  actualRouteDistanceMeters?: number;
  sellerFundedDiscounts?: number;
}

export function calculateAuthoritativePricing(req: PricingCalculationRequest): {
  success: boolean;
  breakdown?: AuthoritativePriceBreakdown;
  quote?: CheckoutQuoteResponse;
  error?: string;
} {
  if (!req.items || !Array.isArray(req.items) || req.items.length === 0) {
    return { success: false, error: 'Cart must contain at least 1 item.' };
  }

  // Generate Authoritative Quote via centralized CustomerPricingService
  const quote = CustomerPricingService.generateCheckoutQuote({
    customerId: req.customerId,
    deliveryAddressId: req.deliveryAddressId,
    deliveryCoordinates: req.deliveryCoordinates,
    cartItems: req.items,
    couponCode: req.couponCode,
    riderTip: req.riderTip,
    isGstEnabled: req.isGstEnabled,
    buyerGstin: req.buyerGstin,
    buyerStateCode: req.buyerStateCode,
    buyerState: req.buyerState,
    buyerAddress: req.buyerAddress,
    sellerFundedDiscounts: req.sellerFundedDiscounts
  });

  if (!quote.success) {
    return {
      success: false,
      error: quote.error || 'Failed to calculate checkout quote.'
    };
  }

  const breakdown: AuthoritativePriceBreakdown = {
    itemsSubtotal: quote.itemsSubtotal,
    itemsOriginalTotal: quote.itemsOriginalTotal,
    mrpDiscount: quote.mrpDiscount,
    taxableValue: quote.taxes.taxableValue,
    totalGst: quote.taxes.totalGst,
    cgst: quote.taxes.cgst,
    sgst: quote.taxes.sgst,
    utgst: quote.taxes.utgst,
    igst: quote.taxes.igst,
    isInterState: quote.taxes.isInterState,
    isUnionTerritory: quote.taxes.isUnionTerritory,
    placeOfSupply: quote.taxes.placeOfSupply,
    supplyType: quote.taxes.supplyType,
    deliveryFee: quote.deliveryCharge,
    deliveryChargeBreakdown: quote.deliveryChargeBreakdown,
    handlingFee: quote.handlingCharge,
    riderTip: quote.riderTip,
    couponDiscount: quote.couponDiscount,
    appliedCouponCode: quote.appliedCouponCode,
    totalAmount: quote.finalPayableAmount,
    totalSavings: quote.totalSavings,
    // Audit & Pricing Snapshot Metadata
    eligible_cart_value: Math.max(0, quote.itemsSubtotal - (req.sellerFundedDiscounts || 0)),
    free_delivery_threshold: quote.freeDeliveryThreshold,
    actual_route_distance_m: quote.actualRouteDistanceM,
    rounded_route_distance_m: quote.roundedRouteDistanceM,
    customer_delivery_fee: quote.deliveryCharge,
    delivery_pricing_rule_version: quote.pricingRuleVersion,
    selected_seller_id: quote.selectedSellerId,
    selected_seller_name: quote.selectedSellerName,
    eligible_sellers: quote.eligibleSellers,
    price_snapshot: quote.priceSnapshot,
    verifiedItems: quote.verifiedItems
  };

  return {
    success: true,
    breakdown,
    quote
  };
}

