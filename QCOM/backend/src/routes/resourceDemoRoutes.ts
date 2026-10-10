import { Router, Request, Response } from 'express';
import { getPool } from '../database/connection.js';
import { authenticate } from '../middleware/auth.js';
import {
  requireOrderOwnership,
  requireMerchantOwnership,
  requireRiderOwnership,
} from '../middleware/resourceOwnership.js';

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
 */
resourceRouter.get('/merchants/:merchantId/inventory', authenticate, requireMerchantOwnership('merchantId'), async (req: Request, res: Response): Promise<void> => {
  const pool = getPool();
  const { merchantId } = req.params;

  try {
    const invRes = await pool.query(
      `SELECT si.*, p.name as product_name, p.sku, p.category, p.hsn_code 
       FROM store_inventory si
       JOIN products p ON p.id = si.product_id
       WHERE si.merchant_id = $1`,
      [merchantId]
    );

    res.status(200).json({
      success: true,
      merchantId,
      inventory: invRes.rows,
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
