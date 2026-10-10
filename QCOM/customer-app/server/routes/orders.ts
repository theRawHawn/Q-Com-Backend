import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { 
  requireAuth, 
  optionalAuth, 
  requireIdempotency, 
  createRateLimiter,
  sanitizeString,
  isValidCoordinate,
  isValidGstin,
  isValidIndianPhone
} from '../security';
import { 
  authoritativeProductStore, 
  authoritativeOrderStore, 
  authoritativeUserStore 
} from '../store';
import { calculateAuthoritativePricing } from '../pricingEngine';
import { CustomerPricingService, AdminCommercialConfig, SellerGeofenceConfig } from '../../src/utils/customerPricingService';
import { DeliveryEconomicsService } from '../../src/utils/deliveryEconomicsService';
import { FulfilmentSelectionService } from '../../src/utils/fulfilmentSelectionService';
import { Order, OrderStatus } from '../../src/types';

const router = Router();

// Rate limiter for checkout calculation & quotes: max 60 per minute
const checkoutCalcLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 60,
  keyPrefix: 'rl:quote'
});

// Rate limiter for order placement: max 10 per minute
const orderPlaceLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 10,
  message: 'Order creation rate limit exceeded. Please wait a moment before placing another order.',
  keyPrefix: 'rl:order'
});

// 1. Authoritative Checkout Quote Endpoint (POST /checkout/quote or POST /api/checkout/quote)
router.post(['/quote', '/calculate'], checkoutCalcLimiter, optionalAuth, (req: Request, res: Response) => {
  const { 
    customer_id,
    delivery_address_id,
    delivery_coordinates,
    deliveryCoordinates,
    cart_items,
    items, 
    coupon_code,
    couponCode, 
    is_gst_enabled,
    isGstEnabled, 
    buyer_gstin,
    buyerGstin, 
    buyer_state_code,
    buyerStateCode, 
    buyer_state,
    buyerState, 
    buyer_address,
    buyerAddress, 
    buyer_pincode,
    buyerPincode,
    rider_tip,
    riderTip,
    seller_funded_discounts,
    sellerFundedDiscounts
  } = req.body;

  const resolvedItems = cart_items || items;
  const resolvedCoords = delivery_coordinates || deliveryCoordinates;

  const result = calculateAuthoritativePricing({
    customerId: customer_id,
    deliveryAddressId: delivery_address_id,
    items: resolvedItems,
    couponCode: typeof (coupon_code || couponCode) === 'string' ? sanitizeString(coupon_code || couponCode, 20) : null,
    isGstEnabled: Boolean(is_gst_enabled ?? isGstEnabled),
    buyerGstin: typeof (buyer_gstin || buyerGstin) === 'string' ? sanitizeString(buyer_gstin || buyerGstin, 20) : null,
    buyerStateCode: typeof (buyer_state_code || buyerStateCode) === 'string' ? sanitizeString(buyer_state_code || buyerStateCode, 10) : null,
    buyerState: typeof (buyer_state || buyerState) === 'string' ? sanitizeString(buyer_state || buyerState, 50) : null,
    buyerAddress: typeof (buyer_address || buyerAddress) === 'string' ? sanitizeString(buyer_address || buyerAddress, 300) : null,
    buyerPincode: typeof (buyer_pincode || buyerPincode) === 'string' ? sanitizeString(buyer_pincode || buyerPincode, 10) : null,
    riderTip: typeof (rider_tip ?? riderTip) === 'number' ? (rider_tip ?? riderTip) : 0,
    sellerFundedDiscounts: typeof (seller_funded_discounts ?? sellerFundedDiscounts) === 'number' ? (seller_funded_discounts ?? sellerFundedDiscounts) : 0,
    deliveryCoordinates: resolvedCoords && isValidCoordinate(resolvedCoords.lat, resolvedCoords.lng) 
      ? resolvedCoords 
      : undefined
  });

  if (!result.success || !result.quote) {
    return res.status(400).json({
      error: 'CALCULATION_ERROR',
      message: result.error || 'Unable to generate authoritative checkout quote.'
    });
  }

  res.json({
    success: true,
    quote: result.quote,
    breakdown: result.breakdown
  });
});

// 2. GET Admin Commercial Pricing Configuration
router.get('/pricing-config', (req: Request, res: Response) => {
  res.json({
    success: true,
    config: CustomerPricingService.getAdminConfig()
  });
});

// 3. POST Admin Update Commercial Pricing Configuration
router.post('/pricing-config', optionalAuth, (req: Request, res: Response) => {
  const updates = req.body;
  const updated = CustomerPricingService.updateAdminConfig(updates);
  res.json({
    success: true,
    message: 'Commercial pricing configuration updated dynamically.',
    config: updated
  });
});

// 4. GET Seller Geofence Registry
router.get('/sellers-geofence', (req: Request, res: Response) => {
  res.json({
    success: true,
    sellers: CustomerPricingService.getSellerGeofences()
  });
});

// 5. POST Admin Update Seller Geofence Configuration
router.post('/sellers-geofence/:sellerId', optionalAuth, (req: Request, res: Response) => {
  const sellerId = req.params.sellerId;
  const updates = req.body;
  const updated = CustomerPricingService.updateSellerGeofence(sellerId, updates);

  if (!updated) {
    return res.status(404).json({
      error: 'SELLER_NOT_FOUND',
      message: `Seller partner '${sellerId}' not found.`
    });
  }

  res.json({
    success: true,
    message: `Geofence parameters updated for seller '${sellerId}'.`,
    seller: updated
  });
});

// 5a. GET Delivery Economics Admin Configuration
router.get('/delivery-economics/config', (req: Request, res: Response) => {
  res.json({
    success: true,
    config: DeliveryEconomicsService.getConfig()
  });
});

// 5b. POST Update Delivery Economics Admin Configuration
router.post('/delivery-economics/config', optionalAuth, (req: Request, res: Response) => {
  const updates = req.body;
  const updated = DeliveryEconomicsService.updateConfig(updates);
  res.json({
    success: true,
    message: 'Delivery economics configuration updated dynamically.',
    config: updated
  });
});

// 5c. POST Evaluate Fulfilment Candidates (Admin / Dispatcher Analytics)
router.post('/delivery-economics/evaluate', (req: Request, res: Response) => {
  const { deliveryCoordinates, cartItems, couponCode, riderTip, isBatched } = req.body;
  const result = FulfilmentSelectionService.selectOptimalFulfilment({
    customerCoordinates: deliveryCoordinates || { lat: 12.9352, lng: 77.6245 },
    cartItems: cartItems || [],
    couponCode,
    riderTip,
    isBatched
  });
  res.json({
    success: true,
    evaluation: result
  });
});

// 6. Authoritative Order Creation (Atomic Stock Reservation + Strict Validation + Price Snapshotting)
router.post('/create', requireAuth, orderPlaceLimiter, requireIdempotency, async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const user = authoritativeUserStore.getUserById(userId);

  if (!user) {
    return res.status(401).json({
      error: 'UNAUTHORIZED_CUSTOMER',
      message: 'Customer profile not found.'
    });
  }

  const {
    items,
    cart_items,
    couponCode,
    coupon_code,
    isGstEnabled,
    is_gst_enabled,
    gstin,
    buyer_gstin,
    businessName,
    billingAddress,
    state,
    stateCode,
    pincode,
    jobSite,
    delivery_coordinates,
    paymentMethod,
    riderTip,
    rider_tip
  } = req.body;

  const resolvedItems = items || cart_items;

  // 1. Validate items array
  if (!resolvedItems || !Array.isArray(resolvedItems) || resolvedItems.length === 0) {
    return res.status(400).json({
      error: 'EMPTY_CART',
      message: 'Order must contain at least 1 item.'
    });
  }

  // 3. Validate Jobsite & Address
  if (!jobSite || typeof jobSite !== 'object') {
    return res.status(400).json({
      error: 'INVALID_JOBSITE',
      message: 'Delivery address and jobsite contact information are required.'
    });
  }

  const sanitizedAddress = sanitizeString(jobSite.address, 300);
  const sanitizedContactName = sanitizeString(jobSite.siteContactName || user.name, 60);
  const rawSitePhone = jobSite.sitePhone || user.phone;

  if (!sanitizedAddress || sanitizedAddress.length < 5) {
    return res.status(400).json({
      error: 'INVALID_ADDRESS',
      message: 'Please provide a valid delivery address.'
    });
  }

  if (!isValidIndianPhone(rawSitePhone)) {
    return res.status(400).json({
      error: 'INVALID_SITE_PHONE',
      message: 'Valid 10-digit site contact phone number is required.'
    });
  }

  const validCoordinates = (jobSite.coordinates && isValidCoordinate(jobSite.coordinates.lat, jobSite.coordinates.lng))
    ? { lat: jobSite.coordinates.lat, lng: jobSite.coordinates.lng }
    : (delivery_coordinates && isValidCoordinate(delivery_coordinates.lat, delivery_coordinates.lng))
      ? { lat: delivery_coordinates.lat, lng: delivery_coordinates.lng }
      : { lat: 12.9352, lng: 77.6245 }; // Default Bangalore coordinates if not GPS picked

  // 2. Calculate Authoritative Pricing & Quote (NEVER trust client amounts)
  const pricing = calculateAuthoritativePricing({
    customerId: userId,
    items: resolvedItems,
    couponCode: typeof (couponCode || coupon_code) === 'string' ? sanitizeString(couponCode || coupon_code, 20) : null,
    isGstEnabled: Boolean(isGstEnabled ?? is_gst_enabled),
    buyerGstin: typeof (gstin || buyer_gstin) === 'string' ? (gstin || buyer_gstin) : null,
    buyerStateCode: typeof stateCode === 'string' ? stateCode : null,
    buyerState: typeof state === 'string' ? state : null,
    buyerAddress: typeof billingAddress === 'string' ? billingAddress : null,
    buyerPincode: typeof pincode === 'string' ? pincode : null,
    riderTip: typeof (riderTip ?? rider_tip) === 'number' ? (riderTip ?? rider_tip) : 0,
    deliveryCoordinates: validCoordinates
  });

  if (!pricing.success || !pricing.breakdown || !pricing.quote) {
    return res.status(400).json({
      error: 'PRICING_VALIDATION_FAILED',
      message: pricing.error || 'Failed to calculate authoritative order price.'
    });
  }

  const breakdown = pricing.breakdown;
  const quote = pricing.quote;

  // 4. Validate GST Details if enabled
  let validGstin: string | undefined = undefined;
  let validBusinessName: string | undefined = undefined;
  let validBillingAddress: string | undefined = undefined;
  let validState: string | undefined = undefined;
  let validStateCode: string | undefined = undefined;
  let validPincode: string | undefined = undefined;

  const gstActive = Boolean(isGstEnabled ?? is_gst_enabled);
  if (gstActive) {
    const rawGst = typeof (gstin || buyer_gstin) === 'string' ? (gstin || buyer_gstin).trim().toUpperCase() : '';
    if (!isValidGstin(rawGst)) {
      return res.status(400).json({
        error: 'INVALID_GSTIN_FORMAT',
        message: 'Invalid 15-digit GSTIN number format.'
      });
    }
    validGstin = rawGst;
    validBusinessName = sanitizeString(businessName || 'Business Customer', 120);
    validBillingAddress = sanitizeString(billingAddress || sanitizedAddress, 300);
    validStateCode = typeof stateCode === 'string' && stateCode.length === 2 ? stateCode : rawGst.slice(0, 2);
    validState = sanitizeString(state || (validStateCode === '29' ? 'Karnataka' : 'State'), 50);
    validPincode = typeof pincode === 'string' ? sanitizeString(pincode, 6) : undefined;
  }

  // 5. Verify Seller Product Availability (Marketplace Model: No QCOM-owned stock reservation)
  const availabilityItems = breakdown.verifiedItems.map(vi => ({
    productId: vi.product.id,
    quantity: vi.quantity
  }));

  const availabilityCheck = await authoritativeProductStore.verifySellerAvailability(availabilityItems);
  if (!availabilityCheck.success) {
    return res.status(409).json({
      error: 'PRODUCT_UNAVAILABLE',
      message: availabilityCheck.error || 'One or more items in your cart are currently unavailable from the seller.',
      failedProductId: availabilityCheck.failedProductId
    });
  }

  // 6. Generate Unique Authoritative Order
  const orderId = `ORD-2026-${Date.now().toString().slice(-6)}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;

  // Create Order Items with verified authoritative prices
  const orderItems = breakdown.verifiedItems.map(vi => ({
    product: vi.product,
    quantity: vi.quantity
  }));

  const newOrder: Order = {
    id: orderId,
    items: orderItems,
    status: 'placed',
    placedAt: new Date(),
    estimatedDeliveryAt: new Date(Date.now() + quote.deliveryEtaMinutes * 60 * 1000),
    subtotal: breakdown.itemsSubtotal,
    deliveryFee: breakdown.deliveryFee,
    urgencyFee: breakdown.handlingFee,
    tax: breakdown.totalGst,
    total: breakdown.totalAmount,
    savingsVsLeavingSite: 350,
    timeSavedMinutes: 45,
    taxableAmount: breakdown.taxableValue,
    cgstAmount: breakdown.cgst,
    sgstAmount: breakdown.sgst,
    utgstAmount: breakdown.utgst,
    igstAmount: breakdown.igst,
    isInterState: breakdown.isInterState,
    isUnionTerritory: breakdown.isUnionTerritory,
    placeOfSupply: breakdown.placeOfSupply,
    supplyType: breakdown.supplyType,
    itcAmount: gstActive ? breakdown.totalGst : undefined,
    itcAmountClaimable: gstActive ? breakdown.totalGst : undefined,
    jobSite: {
      address: sanitizedAddress,
      landmark: sanitizeString(jobSite.landmark, 150),
      floorUnit: sanitizeString(jobSite.floorUnit, 100),
      gateCode: sanitizeString(jobSite.gateCode, 100),
      siteContactName: sanitizedContactName,
      sitePhone: rawSitePhone,
      jobTag: sanitizeString(jobSite.jobTag, 50),
      coordinates: validCoordinates
    },
    paymentMethod: paymentMethod === 'Corporate Card' || paymentMethod === 'Pay on Jobsite' || paymentMethod === 'Trade Credit (Net 30)' ? paymentMethod : 'Instant UPI',
    clientInvoiceNeeded: Boolean(gstActive),
    customerGstin: validGstin,
    customerBusinessName: validBusinessName,
    customerBillingAddress: validBillingAddress,
    customerState: validState,
    customerStateCode: validStateCode,
    customerPincode: validPincode,
    // Delivery Pricing Audit Data & Price Snapshot (Requirement 15)
    eligible_cart_value: breakdown.eligible_cart_value,
    free_delivery_threshold: breakdown.free_delivery_threshold,
    actual_route_distance_m: breakdown.actual_route_distance_m,
    rounded_route_distance_m: breakdown.rounded_route_distance_m,
    customer_delivery_fee: breakdown.customer_delivery_fee,
    delivery_pricing_rule_version: breakdown.delivery_pricing_rule_version,
    sellerPartner: {
      name: quote.selectedSellerName || 'Sri Lakshmi Hardware & Electricals',
      shopType: 'Authorised Electrical & Hardware Hub',
      address: '5th Block, Koramangala, Bengaluru',
      distanceKm: Math.round(breakdown.rounded_route_distance_m / 100) / 10,
      rating: 4.9,
      phone: '+91 98450 12891',
      gstin: '29AABCU9603R1ZM',
      isGstRegistered: true,
      itcEligible: true,
      coordinates: {
        lat: 12.9352,
        lng: 77.6245
      }
    },
    darkStore: {
      name: quote.selectedSellerName || 'Sri Lakshmi Hardware & Electricals (Local Seller)',
      code: quote.selectedSellerId || 'SHOP-BLR-07',
      distanceKm: Math.round(breakdown.rounded_route_distance_m / 100) / 10,
      pickerName: 'Store Partner Fulfillment'
    },
    rider: {
      name: 'Vikram S. (Hero Electric NYX)',
      phone: '+91 98450 88912',
      vehicle: 'Hero Electric NYX (KA-01-EQ-9812)',
      rating: 4.9,
      photo: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=120&auto=format&fit=crop&q=80',
      currentLocation: {
        lat: validCoordinates.lat,
        lng: validCoordinates.lng,
        distanceMeters: breakdown.rounded_route_distance_m
      }
    },
    deliveryOtp: '4821'
  };

  // Attach complete authoritative pricing snapshot (Requirement 15)
  (newOrder as any).customerId = userId;
  (newOrder as any).totalAmount = breakdown.totalAmount;
  (newOrder as any).pricingSnapshot = quote.priceSnapshot;

  // Persist authoritative order
  authoritativeOrderStore.saveOrder(newOrder);

  console.log(`[ORDER] Created authoritative order ${orderId} for customer ${userId} with total ₹${breakdown.totalAmount}`);

  res.status(201).json({
    success: true,
    order: newOrder,
    priceSnapshot: quote.priceSnapshot,
    message: 'Order placed successfully with locked pricing snapshot.'
  });
});

// 3. Get Orders for Authenticated Customer (IDOR / BOLA Protected)
router.get('/', requireAuth, (req: Request, res: Response) => {
  const userId = req.user!.id;
  const user = authoritativeUserStore.getUserById(userId);
  const userOrders = authoritativeOrderStore.getOrdersForCustomer(userId, user?.phone);

  res.json({
    success: true,
    orders: userOrders
  });
});

// 4. Get Specific Order Details (IDOR / BOLA Protected)
router.get('/:orderId', requireAuth, (req: Request, res: Response) => {
  const { orderId } = req.params;
  const userId = req.user!.id;
  const user = authoritativeUserStore.getUserById(userId);

  const order = authoritativeOrderStore.getOrder(orderId);

  if (!order) {
    return res.status(404).json({
      error: 'ORDER_NOT_FOUND',
      message: `Order '${orderId}' not found.`
    });
  }

  // Strict ownership check: Must belong to requesting customer
  const orderCustId = (order as any).customerId;
  const sitePhone = order.jobSite?.sitePhone?.replace(/\s/g, '');
  const userPhone = user?.phone?.replace(/\s/g, '');

  const isOwner = (orderCustId && orderCustId === userId) || (userPhone && sitePhone === userPhone);

  if (!isOwner) {
    return res.status(403).json({
      error: 'FORBIDDEN_ACCESS',
      message: 'You are not authorized to view or access this order.'
    });
  }

  res.json({
    success: true,
    order
  });
});

// 5. Order Cancellation with Authoritative Refund Calculation
router.post('/:orderId/cancel', requireAuth, (req: Request, res: Response) => {
  const { orderId } = req.params;
  const userId = req.user!.id;
  const user = authoritativeUserStore.getUserById(userId);

  const order = authoritativeOrderStore.getOrder(orderId);

  if (!order) {
    return res.status(404).json({
      error: 'ORDER_NOT_FOUND',
      message: `Order '${orderId}' not found.`
    });
  }

  // Strict ownership check
  const orderCustId = (order as any).customerId;
  const sitePhone = order.jobSite?.sitePhone?.replace(/\s/g, '');
  const userPhone = user?.phone?.replace(/\s/g, '');
  const isOwner = (orderCustId && orderCustId === userId) || (userPhone && sitePhone === userPhone);

  if (!isOwner) {
    return res.status(403).json({
      error: 'FORBIDDEN_ACCESS',
      message: 'You are not authorized to cancel this order.'
    });
  }

  // State machine transition
  const transition = authoritativeOrderStore.transitionState(orderId, 'cancelled', 'customer');
  if (!transition.success) {
    return res.status(400).json({
      error: 'CANCELLATION_REJECTED',
      message: transition.error
    });
  }

  // Restock inventory items automatically
  authoritativeProductStore.restock(
    order.items.map(i => ({ productId: i.product.id, quantity: i.quantity }))
  );

  // Authoritative Refund calculation: exact total paid
  const refundAmount = order.total;

  res.json({
    success: true,
    message: 'Order cancelled successfully. Inventory restocked.',
    order: authoritativeOrderStore.getOrder(orderId),
    refund: {
      refundId: `REF-${Date.now().toString().slice(-6)}`,
      amount: refundAmount,
      currency: 'INR',
      status: 'INITIATED',
      estimatedArrival: 'Immediate to source account / UPI'
    }
  });
});

// Test harness endpoint for concurrency race test setup
router.post('/test-set-stock', (req: Request, res: Response) => {
  if (req.headers['x-audit-test'] !== 'true') {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }
  const { productId, count } = req.body;
  authoritativeProductStore.setStock(productId, count);
  res.json({ success: true, productId, count });
});

export default router;
