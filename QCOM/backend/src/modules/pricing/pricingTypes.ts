export type ChargeType = 'DELIVERY' | 'HANDLING' | 'PLATFORM' | 'OTHER';
export type TaxBucket = 'SELLER_GOODS' | 'QCOM_SERVICE_FEES' | 'STATUTORY_COLLECTIONS';
export type TaxCategory = 'TAXABLE' | 'EXEMPT' | 'NIL_RATED' | 'ZERO_RATED';
export type DiscountFundingSource = 'SELLER' | 'PLATFORM' | 'SHARED';

export interface PricingEngineItemInput {
  productId: string;
  quantity: number;
  // NOTE: client-supplied price, tax rate, or discount will be strictly IGNORED
}

export interface PricingEngineInput {
  merchantId: string;
  storeId?: string;
  items: PricingEngineItemInput[];
  placeOfSupplyStateCode?: string;
  customerGstin?: string;
  deliveryAddressId?: string;
  customerLocation?: {
    latitude: number;
    longitude: number;
  };
  distanceKm?: number | string;
  couponCode?: string;
  transactionDate?: string | Date;
  userId?: string;
  idempotencyKey?: string;
  isFirstOrderOverride?: boolean;
}

export interface AppliedDiscountDetail {
  sourceType: 'PROMOTION' | 'COUPON';
  sourceId: string;
  code: string;
  title?: string;
  discountAmount: string;
  sellerShareAmount: string;
  platformShareAmount: string;
  fundingSource: DiscountFundingSource;
  discountTarget: 'ITEMS' | 'DELIVERY';
}

export interface LineItemDiscountShare {
  sourceType: 'PROMOTION' | 'COUPON';
  sourceId: string;
  code: string;
  discountAmount: string;
  sellerShareAmount: string;
  platformShareAmount: string;
  fundingSource: DiscountFundingSource;
}

export interface PricingLineItem {
  productId: string;
  productName: string;
  sku: string;
  category?: string;
  hsnCode: string;
  quantity: number;
  unitPrice: string;
  grossAmount: string;
  inclusiveGrossAmount: string;
  discountAmount: string;
  inclusiveDiscountAmount: string;
  taxableAmount: string;
  taxCategory: TaxCategory;
  taxInclusive: boolean;
  taxBucket: 'SELLER_GOODS';
  taxRateSource: 'SELLER_DECLARED' | 'FALLBACK_CATALOG';
  gstRatePercent: string;
  cgstRatePercent: string;
  cgstAmount: string;
  sgstRatePercent: string;
  sgstAmount: string;
  igstRatePercent: string;
  igstAmount: string;
  cessRatePercent: string;
  cessAmount: string;
  totalGstAmount: string;
  totalTaxAmount: string;
  lineTotal: string;
  taxRuleId: string;
  taxRuleCode: string;
  appliedDiscounts: LineItemDiscountShare[];
}

export interface PricingCharge {
  chargeType: ChargeType;
  description: string;
  grossTaxableAmount?: string;
  discountAmount?: string;
  taxableAmount: string;
  taxBucket: 'QCOM_SERVICE_FEES';
  taxRateSource: 'QCOM_STATUTORY_RULE';
  sacCode: string;
  gstRatePercent: string;
  cgstAmount: string;
  sgstAmount: string;
  igstAmount: string;
  taxAmount: string;
  totalAmount: string;
  taxRuleId: string;
}

export interface GstTcsBreakdown {
  ruleId: string;
  ruleCode: string;
  statutoryProvision: string;
  calculationBasis: string;
  netTaxableSupplies: string;
  centralRatePercent: string;
  centralAmount: string;
  stateRatePercent: string;
  stateAmount: string;
  integratedRatePercent: string;
  integratedAmount: string;
  totalTcsAmount: string;
  reportingForm: string;
}

export interface WithholdingBreakdown {
  ruleId?: string;
  ruleCode?: string;
  governingLaw?: string;
  statutoryProvision?: string;
  tableItem?: string;
  payeeType?: string;
  panStatus?: string;
  applicableRatePercent?: string;
  withholdingAmount: string;
  reportingForm?: string;
  status: 'APPLICABLE' | 'NOT_APPLICABLE' | 'THRESHOLD_NOT_MET' | 'UNSUPPORTED';
  reason?: string;
}

export interface SellerGoodsBreakdown {
  taxBucket: 'SELLER_GOODS';
  itemsSubtotal: string;
  discountAmount: string;
  taxableAmount: string;
  cgstAmount: string;
  sgstAmount: string;
  igstAmount: string;
  cessAmount: string;
  totalGst: string;
  totalTaxWithCess: string;
  totalSellerPayable: string;
}

export interface QcomFeesBreakdown {
  taxBucket: 'QCOM_SERVICE_FEES';
  deliveryTaxable: string;
  handlingTaxable: string;
  platformTaxable: string;
  cgstAmount: string;
  sgstAmount: string;
  igstAmount: string;
  totalGst: string;
  totalCharges: string;
}

export interface StatutoryCollectionsBreakdown {
  taxBucket: 'STATUTORY_COLLECTIONS';
  gstTcs: GstTcsBreakdown;
  withholding: WithholdingBreakdown;
}

export interface PricingQuote {
  quoteId: string;
  userId?: string;
  pricingEngineVersion: string;
  calculationTimestamp: string;
  currency: 'INR';
  merchantId: string;
  storeId?: string;
  placeOfSupplyStateCode: string;
  placeOfSupplyStateName?: string;
  placeOfSupplySource?: string;
  merchantStateCode: string;
  merchantStateName?: string;
  isInterState: boolean;
  items: PricingLineItem[];
  charges: PricingCharge[];
  itemsSubtotal: string;
  discountAmount: string;
  deliveryDiscountAmount: string;
  platformDiscountSubsidy: string;
  sellerDiscountAmount: string;
  taxableAmount: string;
  totalCgst: string;
  totalSgst: string;
  totalIgst: string;
  totalCess: string;
  totalTax: string;
  totalCharges: string;
  grandTotal: string;

  // Explicit 3-Bucket Architectural Separation
  sellerGoodsBreakdown: SellerGoodsBreakdown;
  qcomFeesBreakdown: QcomFeesBreakdown;
  statutoryCollections: StatutoryCollectionsBreakdown;

  gstTcs: GstTcsBreakdown;
  withholding: WithholdingBreakdown;
  roundingPolicy: string;
  expiresAt: string;
  appliedPromotions: AppliedDiscountDetail[];
  appliedCoupon?: {
    couponId?: string;
    code: string;
    discountAmount: string;
    fundingSource?: DiscountFundingSource;
    sellerShareAmount?: string;
    platformShareAmount?: string;
  };
}

export interface SellerProductTaxRecord {
  id: string;
  productId: string;
  merchantId: string;
  hsnCode: string;
  gstRatePercent: string;
  cgstRatePercent: string;
  sgstRatePercent: string;
  igstRatePercent: string;
  cessRatePercent: string;
  taxCategory: TaxCategory;
  taxInclusive: boolean;
  taxRateSource: string;
  status: 'ACTIVE' | 'UNDER_REVIEW' | 'SUPERSEDED';
  adminReviewFlag: boolean;
  adminReviewNotes?: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  sellerDeclaredAt: string;
  verifiedAt?: string;
}

export interface StatutoryTaxRuleRecord {
  id: string;
  rule_code: string;
  tax_type: string;
  hsn_or_sac_code: string;
  description: string;
  effective_from: string;
  effective_to: string | null;
  gst_rate_percent: string;
  cgst_rate_percent: string;
  sgst_rate_percent: string;
  igst_rate_percent: string;
  calculation_base: string;
  rounding_rule: string;
  statutory_reference: string;
}

export interface DeliveryPricingRuleRecord {
  id: string;
  rule_code: string;
  name: string;
  base_distance_km: string;
  base_fee_inr: string;
  per_km_fee_inr: string;
  free_delivery_threshold_inr: string | null;
  handling_fee_inr: string;
  platform_fee_inr: string;
  effective_from: string;
  effective_to: string | null;
}
