export type OrderStatus =
  | 'placed'
  | 'picking'
  | 'packed'
  | 'out_for_delivery'
  | 'arriving'
  | 'delivered'
  | 'cancelled'
  | 'return_requested'
  | 'return_approved'
  | 'return_rejected'
  | 'return_picked_up'
  | 'returned';

export interface OrderItemInput {
  productId: string;
  quantity: number;
}

export interface DeliveryLocationAddress {
  address: string;
  landmark?: string;
  floorUnit?: string;
  gateCode?: string;
  contactName?: string;
  contactPhone?: string;
  siteContactName?: string;
  sitePhone?: string;
  tradeType?: string;
  jobTag?: string;
  latitude: number;
  longitude: number;
  coordinates?: {
    lat: number;
    lng: number;
  };
  accessibleEntranceLatitude?: number;
  accessibleEntranceLongitude?: number;
  dropoffInstructions?: string;
}

export type JobsiteAddress = DeliveryLocationAddress;

export interface CreateOrderInput {
  userId: string;
  merchantId?: string;
  storeId?: string;
  items: OrderItemInput[];
  deliveryLocation?: DeliveryLocationAddress;
  deliveryAddress?: DeliveryLocationAddress;
  jobSite?: DeliveryLocationAddress;
  paymentMethod: string;
  couponCode?: string;
  isGstEnabled?: boolean;
  gstin?: string;
  businessName?: string;
  riderTip?: number;
  idempotencyKey?: string;
}

export interface OrderRecord {
  id: string;
  orderNumber: string;
  userId: string;
  merchantId: string;
  status: OrderStatus;
  itemsSubtotal: number;
  deliveryFee: number;
  handlingFee: number;
  urgencyFee: number;
  discountAmount: number;
  taxableAmount: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  totalAmount: number;
  withholdingAmount: number;
  gstTcsAmount: number;
  paymentMethod: string;
  paymentStatus: 'PENDING' | 'PAID' | 'FAILED' | 'REFUNDED' | 'PARTIALLY_REFUNDED' | 'REFUND_PENDING';
  deliveryOtp: string;
  handoverToken: string;
  jobsiteAddress: JobsiteAddress;
  customerGstin?: string;
  customerBusinessName?: string;
  placeOfSupplyStateCode: string;
  pricingSnapshot: any;
  cancellationReason?: string;
  placedAt: string;
  estimatedDeliveryAt: string;
  deliveredAt?: string;
  createdAt: string;
  items?: {
    id: string;
    productId: string;
    productName: string;
    unitPrice: number;
    quantity: number;
    totalPrice: number;
    hsnCode: string;
    taxableAmount: number;
    gstRatePercent: number;
    cgstAmount: number;
    sgstAmount: number;
    igstAmount: number;
  }[];
}
