import { Router, Request, Response } from 'express';
import { getPool } from '../database/connection.js';
import { authenticate } from '../middleware/auth.js';
import {
  requireOrderOwnership,
  requireMerchantOwnership,
  requireRiderOwnership,
} from '../middleware/resourceOwnership.js';
import { inventoryService } from '../modules/inventory/inventoryService.js';

export const resourceRouter = Router();

/**
 * GET /orders/:id
 * Fetches order details with strict tenant/resource-level ownership check.
 * - Customer can ONLY view their own orders
 * - Seller staff can ONLY view orders from their own merchant store
 * - Assigned rider can ONLY view their assigned order
 * - Admin with 'orders.view' can view any order
 */
resourceRouter.get('/orders/:id', authenticate, requireOrderOwnership('id'), async (req: Request, res: Response): Promise<void> => {
  const pool = getPool();
  const { id } = req.params;

  try {
    const orderRes = await pool.query(
      `SELECT o.*, m.name as merchant_name, u.name as customer_name 
       FROM orders o
       JOIN merchants m ON m.id = o.merchant_id
       JOIN users u ON u.id = o.user_id
       WHERE o.id::text = $1 OR o.order_number = $1`,
      [id]
    );

    if (orderRes.rows.length === 0) {
      res.status(404).json({ success: false, error: 'NOT_FOUND', message: 'Order not found.' });
      return;
    }

    const itemsRes = await pool.query(
      `SELECT * FROM order_items WHERE order_id = $1`,
      [orderRes.rows[0].id]
    );

    res.status(200).json({
      success: true,
      order: {
        ...orderRes.rows[0],
        items: itemsRes.rows,
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
});

/**
 * GET /merchants/:merchantId/inventory
 * Fetches store inventory with strict multi-tenant isolation.
 * A seller from Merchant A CANNOT view or modify Merchant B's inventory.
 * Exposes authoritative available_to_sell, thresholds, scarcity, and alert statuses.
 */
resourceRouter.get('/merchants/:merchantId/inventory', authenticate, requireMerchantOwnership('merchantId'), async (req: Request, res: Response): Promise<void> => {
  const { merchantId } = req.params;

  try {
    const inventory = await inventoryService.getStoreInventory(merchantId);

    res.status(200).json({
      success: true,
      merchantId,
      inventory,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
});

/**
 * PATCH /merchants/:merchantId/inventory/:productId/thresholds
 * Updates product-level low_stock_threshold and/or scarce_stock_threshold.
 * Server-side non-negative integer validation and seller ownership enforced.
 */
resourceRouter.patch('/merchants/:merchantId/inventory/:productId/thresholds', authenticate, requireMerchantOwnership('merchantId'), async (req: Request, res: Response): Promise<void> => {
  const { merchantId, productId } = req.params;
  const { lowStockThreshold, scarceStockThreshold } = req.body;

  if (lowStockThreshold !== undefined && (!Number.isInteger(lowStockThreshold) || lowStockThreshold < 0)) {
    res.status(400).json({
      success: false,
      error: 'VALIDATION_ERROR',
      message: 'lowStockThreshold must be a non-negative integer (>= 0).',
    });
    return;
  }

  if (scarceStockThreshold !== undefined && (!Number.isInteger(scarceStockThreshold) || scarceStockThreshold < 0)) {
    res.status(400).json({
      success: false,
      error: 'VALIDATION_ERROR',
      message: 'scarceStockThreshold must be a non-negative integer (>= 0).',
    });
    return;
  }

  try {
    const updatedItem = await inventoryService.updateProductThresholds(merchantId, productId, {
      lowStockThreshold,
      scarceStockThreshold,
    });

    res.status(200).json({
      success: true,
      merchantId,
      productId,
      item: updatedItem,
      message: 'Product thresholds updated successfully.',
    });
  } catch (err: any) {
    const statusCode = err.message.startsWith('NOT_FOUND') ? 404 : 500;
    res.status(statusCode).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
});

/**
 * PATCH /merchants/:merchantId/threshold-defaults
 * Updates merchant-level default_low_stock_threshold and/or default_scarce_stock_threshold.
 * Server-side non-negative integer validation and seller ownership enforced.
 */
resourceRouter.patch('/merchants/:merchantId/threshold-defaults', authenticate, requireMerchantOwnership('merchantId'), async (req: Request, res: Response): Promise<void> => {
  const { merchantId } = req.params;
  const { defaultLowStockThreshold, defaultScarceStockThreshold } = req.body;

  if (defaultLowStockThreshold !== undefined && (!Number.isInteger(defaultLowStockThreshold) || defaultLowStockThreshold < 0)) {
    res.status(400).json({
      success: false,
      error: 'VALIDATION_ERROR',
      message: 'defaultLowStockThreshold must be a non-negative integer (>= 0).',
    });
    return;
  }

  if (defaultScarceStockThreshold !== undefined && (!Number.isInteger(defaultScarceStockThreshold) || defaultScarceStockThreshold < 0)) {
    res.status(400).json({
      success: false,
      error: 'VALIDATION_ERROR',
      message: 'defaultScarceStockThreshold must be a non-negative integer (>= 0).',
    });
    return;
  }

  try {
    const defaults = await inventoryService.updateMerchantThresholdDefaults(merchantId, {
      defaultLowStockThreshold,
      defaultScarceStockThreshold,
    });

    res.status(200).json({
      success: true,
      merchantId,
      defaults,
      message: 'Merchant threshold defaults updated successfully.',
    });
  } catch (err: any) {
    const statusCode = err.message.startsWith('NOT_FOUND') ? 404 : 500;
    res.status(statusCode).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
});

/**
 * POST /merchants/:merchantId/inventory/:productId/restock
 * Adds stock to seller inventory and triggers episode reset evaluation.
 */
resourceRouter.post('/merchants/:merchantId/inventory/:productId/restock', authenticate, requireMerchantOwnership('merchantId'), async (req: Request, res: Response): Promise<void> => {
  const { merchantId, productId } = req.params;
  const { quantity } = req.body;

  if (!Number.isInteger(quantity) || quantity <= 0) {
    res.status(400).json({
      success: false,
      error: 'VALIDATION_ERROR',
      message: 'quantity must be a positive integer (> 0).',
    });
    return;
  }

  try {
    await inventoryService.restockInventory(merchantId, productId, quantity);
    const updatedInventory = await inventoryService.getStoreInventory(merchantId);
    const item = updatedInventory.find(i => i.productId === productId);

    res.status(200).json({
      success: true,
      merchantId,
      productId,
      restockedQuantity: quantity,
      item,
      message: 'Stock replenished successfully.',
    });
  } catch (err: any) {
    const statusCode = err.message.startsWith('NOT_FOUND') ? 404 : 500;
    res.status(statusCode).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
});

/**
 * GET /merchants/:merchantId/stock-alerts
 * Fetches seller stock alerts log/inbox.
 */
resourceRouter.get('/merchants/:merchantId/stock-alerts', authenticate, requireMerchantOwnership('merchantId'), async (req: Request, res: Response): Promise<void> => {
  const { merchantId } = req.params;
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
  const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;
  const isRead = req.query.isRead !== undefined ? req.query.isRead === 'true' : undefined;

  try {
    const alerts = await inventoryService.getSellerStockAlerts(merchantId, { limit, offset, isRead });

    res.status(200).json({
      success: true,
      merchantId,
      alerts,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
});

/**
 * PATCH /merchants/:merchantId/stock-alerts/:alertId/read
 * Marks a stock alert as read.
 */
resourceRouter.patch('/merchants/:merchantId/stock-alerts/:alertId/read', authenticate, requireMerchantOwnership('merchantId'), async (req: Request, res: Response): Promise<void> => {
  const { merchantId, alertId } = req.params;

  try {
    const updated = await inventoryService.markStockAlertRead(merchantId, alertId);
    if (!updated) {
      res.status(404).json({ success: false, error: 'NOT_FOUND', message: 'Alert not found.' });
      return;
    }

    res.status(200).json({
      success: true,
      merchantId,
      alertId,
      message: 'Alert marked as read.',
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
});

/**
 * GET /riders/:riderId/profile
 * Fetches delivery partner profile and earnings with strict rider ownership check.
 * Rider A CANNOT view Rider B's wallet or telemetry.
 */
resourceRouter.get('/riders/:riderId/profile', authenticate, requireRiderOwnership('riderId'), async (req: Request, res: Response): Promise<void> => {
  const pool = getPool();
  const { riderId } = req.params;

  try {
    const riderRes = await pool.query(
      `SELECT id, rider_code, name, phone, vehicle_type, vehicle_plate, rating, tier, status, wallet_balance, kyc_status 
       FROM riders WHERE id = $1`,
      [riderId]
    );

    if (riderRes.rows.length === 0) {
      res.status(404).json({ success: false, error: 'NOT_FOUND', message: 'Rider profile not found.' });
      return;
    }

    res.status(200).json({
      success: true,
      rider: riderRes.rows[0],
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
});
