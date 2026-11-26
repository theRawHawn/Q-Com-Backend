import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth.js';
import { cartService } from '../modules/pricing/cartService.js';
import { PricingEngineError } from '../modules/pricing/pricingEngine.js';
import { TaxEngineError } from '../modules/pricing/taxEngine.js';
import { CouponPromotionError } from '../modules/pricing/couponPromotionService.js';

export const cartRouter = Router();

function handleCartError(res: Response, err: any, fallbackCode: string) {
  if (err instanceof PricingEngineError || err instanceof TaxEngineError || err instanceof CouponPromotionError) {
    res.status(err.statusCode).json({
      success: false,
      error: err.code,
      message: err.message,
    });
    return;
  }
  res.status(500).json({
    success: false,
    error: fallbackCode,
    message: err?.message || 'Cart operation failed.',
  });
}

/**
 * GET /api/v1/cart?merchantId=...
 */
cartRouter.get('/', authenticate, async (req: Request, res: Response): Promise<void> => {
  const merchantId = String(req.query.merchantId || req.body?.merchantId || '').trim();
  if (!merchantId) {
    res.status(400).json({ success: false, error: 'MISSING_MERCHANT_ID', message: 'merchantId is required.' });
    return;
  }

  try {
    const cart = await cartService.getCart({
      userId: req.auth!.userId,
      merchantId,
      deliveryAddressId: req.query.deliveryAddressId ? String(req.query.deliveryAddressId) : undefined,
      customerGstin: req.query.customerGstin ? String(req.query.customerGstin) : undefined,
      distanceKm: req.query.distanceKm !== undefined ? Number(req.query.distanceKm) : undefined,
    });
    res.status(200).json({ success: true, cart });
  } catch (err: any) {
    handleCartError(res, err, 'CART_FETCH_FAILED');
  }
});

/**
 * POST /api/v1/cart/items
 */
cartRouter.post('/items', authenticate, async (req: Request, res: Response): Promise<void> => {
  const { merchantId, productId, quantity, placeOfSupplyStateCode, distanceKm } = req.body;
  if (!merchantId || !productId || quantity === undefined) {
    res.status(400).json({
      success: false,
      error: 'MISSING_CART_ITEM_FIELDS',
      message: 'merchantId, productId, and quantity are required.',
    });
    return;
  }

  try {
    const cart = await cartService.upsertItem({
      userId: req.auth!.userId,
      merchantId: String(merchantId),
      productId: String(productId),
      quantity: Number(quantity),
      placeOfSupplyStateCode: placeOfSupplyStateCode ? String(placeOfSupplyStateCode) : undefined,
      distanceKm: distanceKm !== undefined ? Number(distanceKm) : undefined,
    });
    res.status(200).json({ success: true, cart });
  } catch (err: any) {
    handleCartError(res, err, 'CART_ITEM_UPDATE_FAILED');
  }
});

/**
 * DELETE /api/v1/cart/items/:productId?merchantId=...
 */
cartRouter.delete('/items/:productId', authenticate, async (req: Request, res: Response): Promise<void> => {
  const { productId } = req.params;
  const merchantId = String(req.query.merchantId || req.body?.merchantId || '').trim();
  if (!merchantId) {
    res.status(400).json({ success: false, error: 'MISSING_MERCHANT_ID', message: 'merchantId is required.' });
    return;
  }

  try {
    const cart = await cartService.removeItem({
      userId: req.auth!.userId,
      merchantId,
      productId,
    });
    res.status(200).json({ success: true, cart });
  } catch (err: any) {
    handleCartError(res, err, 'CART_ITEM_REMOVE_FAILED');
  }
});

/**
 * POST /api/v1/cart/coupon
 */
cartRouter.post('/coupon', authenticate, async (req: Request, res: Response): Promise<void> => {
  const { merchantId, couponCode, distanceKm } = req.body;
  if (!merchantId) {
    res.status(400).json({ success: false, error: 'MISSING_MERCHANT_ID', message: 'merchantId is required.' });
    return;
  }

  try {
    const cart = await cartService.applyCoupon({
      userId: req.auth!.userId,
      merchantId: String(merchantId),
      couponCode: couponCode ?? null,
      distanceKm: distanceKm !== undefined ? Number(distanceKm) : undefined,
    });
    res.status(200).json({ success: true, cart });
  } catch (err: any) {
    handleCartError(res, err, 'CART_COUPON_FAILED');
  }
});

/**
 * DELETE /api/v1/cart?merchantId=...
 */
cartRouter.delete('/', authenticate, async (req: Request, res: Response): Promise<void> => {
  const merchantId = String(req.query.merchantId || req.body?.merchantId || '').trim();
  if (!merchantId) {
    res.status(400).json({ success: false, error: 'MISSING_MERCHANT_ID', message: 'merchantId is required.' });
    return;
  }

  try {
    await cartService.clearCart(req.auth!.userId, merchantId);
    res.status(200).json({ success: true, message: 'Cart cleared.' });
  } catch (err: any) {
    handleCartError(res, err, 'CART_CLEAR_FAILED');
  }
});
