import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { orderService } from '../modules/orders/orderService.js';
import { cancellationService } from '../modules/orders/cancellationService.js';
import { authenticate } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { requireOrderOwnership } from '../middleware/resourceOwnership.js';
import { getPool } from '../database/connection.js';
import { checkoutRateLimiter } from '../middleware/rateLimiter.js';

import { inventoryService } from '../modules/inventory/inventoryService.js';

export const orderRouter = Router();

/**
 * POST /api/orders/check-availability & POST /api/v1/orders/check-availability
 * Authoritatively verifies current available quantity (stock_count - reserved_count)
 */
orderRouter.post('/check-availability', async (req: Request, res: Response): Promise<void> => {
  const { merchantId, items } = req.body;
  if (!merchantId || !items || !Array.isArray(items)) {
    res.status(400).json({
      success: false,
      error: 'INVALID_INPUT',
      message: 'merchantId and items array are required.',
    });
    return;
  }
  try {
    const formattedItems = items.map((i: any) => ({
      productId: i.id || i.productId,
      quantity: Number(i.quantity || 1),
    }));
    const availability = await inventoryService.checkAvailability(merchantId, formattedItems);
    res.status(200).json({
      success: true,
      ...availability,
    });
  } catch (err: any) {
    if (isDatabaseUnavailable(err)) {
      res.setHeader('Retry-After', '3');
      res.status(503).json({
        success: false,
        error: 'DATABASE_UNAVAILABLE',
        message: 'PostgreSQL database is currently unavailable.',
        retryAfterSeconds: 3,
      });
      return;
    }
    res.status(500).json({
      success: false,
      error: 'AVAILABILITY_CHECK_FAILED',
      message: err.message || 'Failed to check inventory availability.',
    });
  }
});

function isDatabaseUnavailable(err: any): boolean {
  if (!err) return false;
  const msg = (err.message || '').toLowerCase();
  const code = (err.code || '').toLowerCase();
  return (
    err.isDatabaseUnavailable === true ||
    code === '57p01' ||
    code === '57p02' ||
    code === '57p03' ||
    code === '08006' ||
    code === '08001' ||
    code === '08004' ||
    code === 'econnrefused' ||
    code === 'etimedout' ||
    code === 'econnreset' ||
    msg.includes('connection terminated') ||
    msg.includes('database is closed') ||
    msg.includes('connection refused') ||
    msg.includes('cannot connect') ||
    msg.includes('timeout')
  );
}

/**
 * POST /api/orders/create & POST /api/v1/orders/create
 */
orderRouter.post('/create', authenticate, checkoutRateLimiter, async (req: Request, res: Response): Promise<void> => {
  const pool = getPool();
  const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
  const cleanKey = idempotencyKey && typeof idempotencyKey === 'string' ? idempotencyKey.trim().slice(0, 120) : undefined;
  const requestId = (req as any).requestId || req.headers['x-request-id'] || 'req-order';

  const { 
    items, 
    deliveryLocation, 
    deliveryAddress, 
    jobSite: rawJobSite, 
    paymentMethod, 
    couponCode, 
    isGstEnabled, 
    gstin, 
    businessName, 
    riderTip, 
    merchantId 
  } = req.body;

  const destinationLocation = deliveryLocation || deliveryAddress || rawJobSite;

  if (!items || !Array.isArray(items) || items.length === 0) {
    res.status(400).json({ success: false, error: 'EMPTY_CART', message: 'Cart items are required.' });
    return;
  }
  if (!destinationLocation || typeof destinationLocation !== 'object') {
    res.status(400).json({ success: false, error: 'INVALID_LOCATION', message: 'Valid deliveryLocation or deliveryAddress is required.' });
    return;
  }

  // Resilient coordinate normalization: accepts deliveryLocation.coordinates.lat/lng, lat/lng, or latitude/longitude
  const rawLat = destinationLocation.latitude ?? destinationLocation.lat ?? destinationLocation.coordinates?.lat ?? destinationLocation.coordinates?.latitude ?? 12.9352;
  const rawLng = destinationLocation.longitude ?? destinationLocation.lng ?? destinationLocation.coordinates?.lng ?? destinationLocation.coordinates?.longitude ?? 77.6245;
  const parsedLat = typeof rawLat === 'number' ? rawLat : parseFloat(rawLat);
  const parsedLng = typeof rawLng === 'number' ? rawLng : parseFloat(rawLng);

  if (isNaN(parsedLat) || isNaN(parsedLng)) {
    res.status(400).json({ success: false, error: 'INVALID_LOCATION', message: 'Valid delivery latitude and longitude are required.' });
    return;
  }

  // Standardized normalized delivery location object (retaining jobSite property internally for DB & backward compatibility)
  const normalizedDeliveryLocation = {
    ...destinationLocation,
    latitude: parsedLat,
    longitude: parsedLng,
  };

  // 1. Deterministic Request Fingerprint
  const normalizedPayload = {
    userId: req.auth!.userId,
    items: items.map((i: any) => ({ productId: i.id || i.productId, quantity: Number(i.quantity || 1) })).sort((a, b) => a.productId.localeCompare(b.productId)),
    deliveryLocation: {
      latitude: normalizedDeliveryLocation.latitude,
      longitude: normalizedDeliveryLocation.longitude,
      address: normalizedDeliveryLocation.address || '',
    },
    paymentMethod: paymentMethod || 'Instant UPI',
    couponCode: couponCode || null,
    isGstEnabled: !!isGstEnabled,
    gstin: gstin || null,
  };
  const requestFingerprint = crypto.createHash('sha256').update(JSON.stringify(normalizedPayload)).digest('hex');

  // 2. Idempotency Check
  if (cleanKey) {
    try {
      const existingKeyRes = await pool.query(
        `SELECT status, status_code, response_body, request_fingerprint FROM idempotency_keys WHERE idempotency_key = $1`,
        [cleanKey]
      );

      if (existingKeyRes.rows.length > 0) {
        const existing = existingKeyRes.rows[0];

        // Reject if same key is used with a different request payload
        if (existing.request_fingerprint && existing.request_fingerprint !== requestFingerprint) {
          res.status(422).json({
            success: false,
            error: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
            message: 'This Idempotency-Key was already used for an order creation with a different request payload.',
            requestId,
          });
          return;
        }

        // Return original result if COMPLETED
        if (existing.status === 'COMPLETED') {
          res.status(existing.status_code || 200).json(existing.response_body);
          return;
        }

        // Return 409 if currently PROCESSING
        if (existing.status === 'PROCESSING') {
          res.status(409).json({
            success: false,
            error: 'ORDER_CREATION_IN_PROGRESS',
            message: 'An order placement request with this Idempotency-Key is currently in progress.',
            requestId,
          });
          return;
        }
      }

      // Record PROCESSING state
      await pool.query(
        `INSERT INTO idempotency_keys (idempotency_key, actor_id, endpoint, status, request_fingerprint, created_at, expires_at)
         VALUES ($1, $2, $3, 'PROCESSING', $4, NOW(), NOW() + interval '24 hours')
         ON CONFLICT (idempotency_key) DO UPDATE
         SET status = 'PROCESSING', request_fingerprint = EXCLUDED.request_fingerprint`,
        [cleanKey, req.auth!.userId, req.originalUrl, requestFingerprint]
      );
    } catch (err: any) {
      if (isDatabaseUnavailable(err)) {
        res.setHeader('Retry-After', '3');
        res.status(503).json({
          success: false,
          error: 'DATABASE_UNAVAILABLE',
          message: 'PostgreSQL database is currently unavailable. Please retry using the same Idempotency-Key.',
          retryAfterSeconds: 3,
          requestId,
        });
        return;
      }
      throw err;
    }
  }

  // 3. Execute Order Creation in PostgreSQL Transaction
  try {
    const result = await orderService.createOrder({
      userId: req.auth!.userId,
      merchantId,
      items: items.map((i: any) => ({ productId: i.id || i.productId, quantity: Number(i.quantity || 1) })),
      jobSite: normalizedDeliveryLocation,
      deliveryLocation: normalizedDeliveryLocation,
      paymentMethod: paymentMethod || 'Instant UPI',
      couponCode,
      isGstEnabled,
      gstin,
      businessName,
      riderTip,
      idempotencyKey: cleanKey,
    });

    const responseBody = {
      success: true,
      message: 'Order placed successfully and locked with authoritative pricing snapshot.',
      order: result.order,
      priceSnapshot: result.pricingSnapshot,
    };

    // 4. Mark Idempotency Record COMPLETED
    if (cleanKey) {
      try {
        await pool.query(
          `UPDATE idempotency_keys
           SET status = 'COMPLETED', status_code = 200, response_body = $1
           WHERE idempotency_key = $2`,
          [JSON.stringify(responseBody), cleanKey]
        );
      } catch (err: any) {
        if (isDatabaseUnavailable(err)) {
          res.setHeader('Retry-After', '3');
          res.status(503).json({
            success: false,
            error: 'DATABASE_UNAVAILABLE',
            message: 'PostgreSQL database is currently unavailable. Please retry using the same Idempotency-Key.',
            retryAfterSeconds: 3,
            requestId,
          });
          return;
        }
      }
    }

    res.status(200).json(responseBody);
  } catch (err: any) {
    if (cleanKey) {
      try {
        await pool.query(
          `UPDATE idempotency_keys SET status = 'FAILED' WHERE idempotency_key = $1`,
          [cleanKey]
        );
      } catch {
        // Suppress update error if DB connection broke
      }
    }

    if (isDatabaseUnavailable(err)) {
      res.setHeader('Retry-After', '3');
      res.status(503).json({
        success: false,
        error: 'DATABASE_UNAVAILABLE',
        message: 'PostgreSQL database is currently unavailable. Please retry using the same Idempotency-Key.',
        retryAfterSeconds: 3,
        requestId,
      });
      return;
    }

    if (err.message && (err.message.includes('INSUFFICIENT_STOCK') || err.message.toLowerCase().includes('insufficient stock'))) {
      res.status(400).json({
        success: false,
        error: 'INSUFFICIENT_STOCK',
        message: err.message,
        requestId,
      });
      return;
    }

    res.status(400).json({
      success: false,
      error: 'ORDER_CREATION_FAILED',
      message: err.message || 'Failed to create order.',
    });
  }
});

/**
 * GET /api/orders & GET /api/v1/orders
 */
orderRouter.get('/', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const orders = await orderService.getOrders(req.auth!.userId);
    res.status(200).json({
      success: true,
      orders,
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: 'ORDERS_FETCH_FAILED',
      message: err.message || 'Failed to retrieve order history.',
    });
  }
});

/**
 * GET /api/orders/:orderId & GET /api/v1/orders/:orderId
 */
orderRouter.get('/:orderId', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { orderId } = req.params;
    const isStaff = req.auth!.roles?.some((r: string) => ['SUPER_ADMIN', 'OPERATIONS', 'SELLER'].includes(r));
    const order = await orderService.getOrderById(orderId, req.auth!.userId, isStaff);

    if (!order) {
      res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND', message: 'Order not found or unauthorized.' });
      return;
    }

    res.status(200).json({
      success: true,
      order,
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: 'ORDER_FETCH_FAILED',
      message: err.message || 'Failed to retrieve order.',
    });
  }
});

/**
 * POST /api/orders/:orderId/cancel & POST /api/v1/orders/:orderId/cancel
 */
orderRouter.post('/:orderId/cancel', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { orderId } = req.params;
    const { reason } = req.body;
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
    const result = await orderService.cancelOrder(orderId, req.auth!.userId, reason, idempotencyKey);

    res.status(200).json({
      success: true,
      message: 'Order cancelled successfully and reserved inventory released.',
      order: result.order,
      refund: result.refund,
    });
  } catch (err: any) {
    if (isDatabaseUnavailable(err)) {
      res.status(503).json({ success: false, error: 'DATABASE_UNAVAILABLE', message: 'Database temporarily unavailable.' });
      return;
    }
    const status = err.message.includes('NOT_FOUND') ? 404 : 400;
    res.status(status).json({
      success: false,
      error: 'CANCELLATION_FAILED',
      message: err.message || 'Failed to cancel order.',
    });
  }
});

/**
 * POST /api/orders/:orderId/cancel-merchant & POST /api/v1/orders/:orderId/cancel-merchant
 * Merchant cancellation: Validates caller merchant ownership for this specific order
 */
orderRouter.post(
  '/:orderId/cancel-merchant',
  authenticate,
  requireOrderOwnership('orderId'),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { orderId } = req.params;
      const { reason, merchantId } = req.body;
      const idempotencyKey = req.headers['idempotency-key'] as string | undefined;

      const pool = getPool();
      const orderRes = await pool.query(`SELECT merchant_id FROM orders WHERE id = $1`, [orderId]);
      if (orderRes.rows.length === 0) {
        res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND', message: 'Order not found.' });
        return;
      }
      const orderMerchantId = orderRes.rows[0].merchant_id;
      const isGlobalAdmin =
        req.auth!.isSuperAdmin ||
        req.auth!.roles.includes('SUPER_ADMIN') ||
        req.auth!.roles.includes('OPERATIONS');
      const isMerchantAuthorized = req.auth!.merchantIds && req.auth!.merchantIds.includes(orderMerchantId);

      if (!isGlobalAdmin && !isMerchantAuthorized) {
        res.status(403).json({
          success: false,
          error: 'FORBIDDEN',
          message: 'You are not authorized to cancel orders for this merchant.',
        });
        return;
      }

      const effectiveMerchantId = orderMerchantId;

      const result = await cancellationService.cancelBySeller({
        orderId,
        merchantId: effectiveMerchantId,
        reason: reason || 'Merchant cancelled order.',
        idempotencyKey,
      });

      res.status(200).json({
        success: true,
        message: 'Order cancelled by merchant.',
        order: result.order,
        refund: result.refund,
      });
    } catch (err: any) {
      if (isDatabaseUnavailable(err)) {
        res.status(503).json({ success: false, error: 'DATABASE_UNAVAILABLE', message: 'Database temporarily unavailable.' });
        return;
      }
      const status = err.message.includes('NOT_FOUND') ? 404 : 400;
      res.status(status).json({
        success: false,
        error: 'CANCELLATION_FAILED',
        message: err.message || 'Failed to cancel order.',
      });
    }
  }
);

/**
 * POST /api/admin/orders/:orderId/cancel & POST /api/v1/admin/orders/:orderId/cancel
 * Admin cancellation: Strictly restricted to Super Admin and Operations roles
 */
orderRouter.post(
  '/admin/:orderId/cancel',
  authenticate,
  requireRole(['SUPER_ADMIN', 'OPERATIONS']),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { orderId } = req.params;
      const { reason } = req.body;
      const idempotencyKey = req.headers['idempotency-key'] as string | undefined;

      const result = await cancellationService.cancelByAdmin({
        orderId,
        adminUserId: req.auth!.userId,
        reason: reason || 'Admin cancelled order.',
        idempotencyKey,
      });

      res.status(200).json({
        success: true,
        message: 'Order cancelled by administrator.',
        order: result.order,
        refund: result.refund,
      });
    } catch (err: any) {
      if (isDatabaseUnavailable(err)) {
        res.status(503).json({ success: false, error: 'DATABASE_UNAVAILABLE', message: 'Database temporarily unavailable.' });
        return;
      }
      const status = err.message.includes('NOT_FOUND') ? 404 : 400;
      res.status(status).json({
        success: false,
        error: 'CANCELLATION_FAILED',
        message: err.message || 'Failed to cancel order.',
      });
    }
  }
);

/**
 * GET /api/orders/delivery-economics/config
 */
orderRouter.get('/delivery-economics/config', async (req: Request, res: Response): Promise<void> => {
  const pool = getPool();
  try {
    const resConfig = await pool.query(`
      SELECT rider_base_payout, rider_per_km_rate, max_delivery_subsidy, pg_cost_percent, packaging_cost_inr, ops_cost_inr
      FROM delivery_economics_configs
      WHERE is_active = TRUE
      LIMIT 1
    `);
    const row = resConfig.rows[0] || {
      rider_base_payout: 45.00,
      rider_per_km_rate: 8.00,
      max_delivery_subsidy: 35.00,
      pg_cost_percent: 1.80,
      packaging_cost_inr: 8.00,
      ops_cost_inr: 5.00,
    };
    res.status(200).json({
      success: true,
      config: {
        riderBasePayout: parseFloat(row.rider_base_payout),
        riderPerKmRate: parseFloat(row.rider_per_km_rate),
        maxDeliverySubsidy: parseFloat(row.max_delivery_subsidy),
        pgCostPercent: parseFloat(row.pg_cost_percent),
        packagingCostInr: parseFloat(row.packaging_cost_inr),
        opsCostInr: parseFloat(row.ops_cost_inr),
      },
    });
  } catch {
    res.status(200).json({
      success: true,
      config: {
        riderBasePayout: 45.00,
        riderPerKmRate: 8.00,
        maxDeliverySubsidy: 35.00,
        pgCostPercent: 1.80,
        packagingCostInr: 8.00,
        opsCostInr: 5.00,
      },
    });
  }
});

/**
 * POST /api/orders/delivery-economics/config
 */
orderRouter.post('/delivery-economics/config', async (req: Request, res: Response): Promise<void> => {
  const { riderBasePayout, riderPerKmRate, maxDeliverySubsidy, pgCostPercent, packagingCostInr, opsCostInr } = req.body;
  const pool = getPool();
  try {
    await pool.query(`
      INSERT INTO delivery_economics_configs (key, rider_base_payout, rider_per_km_rate, max_delivery_subsidy, pg_cost_percent, packaging_cost_inr, ops_cost_inr)
      VALUES ('default', $1, $2, $3, $4, $5, $6)
      ON CONFLICT (key) DO UPDATE
      SET rider_base_payout = EXCLUDED.rider_base_payout,
          rider_per_km_rate = EXCLUDED.rider_per_km_rate,
          max_delivery_subsidy = EXCLUDED.max_delivery_subsidy,
          pg_cost_percent = EXCLUDED.pg_cost_percent,
          packaging_cost_inr = EXCLUDED.packaging_cost_inr,
          ops_cost_inr = EXCLUDED.ops_cost_inr,
          updated_at = NOW()
    `, [
      riderBasePayout ?? 45.00,
      riderPerKmRate ?? 8.00,
      maxDeliverySubsidy ?? 35.00,
      pgCostPercent ?? 1.80,
      packagingCostInr ?? 8.00,
      opsCostInr ?? 5.00,
    ]);

    res.status(200).json({
      success: true,
      message: 'Delivery economics configuration updated successfully.',
      config: {
        riderBasePayout: riderBasePayout ?? 45.00,
        riderPerKmRate: riderPerKmRate ?? 8.00,
        maxDeliverySubsidy: maxDeliverySubsidy ?? 35.00,
        pgCostPercent: pgCostPercent ?? 1.80,
        packagingCostInr: packagingCostInr ?? 8.00,
        opsCostInr: opsCostInr ?? 5.00,
      },
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: 'UPDATE_FAILED',
      message: err.message || 'Failed to update delivery economics config.',
    });
  }
});
