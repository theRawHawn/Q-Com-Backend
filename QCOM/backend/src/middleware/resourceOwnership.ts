import { Request, Response, NextFunction } from 'express';
import { getPool } from '../database/connection.js';
import { recordAuditEvent } from '../modules/audit/auditService.js';

/**
 * Enforces Tenant and Resource-Level Authorization for Orders.
 * 
 * CORE INVARIANT: Authentication ≠ Authorization ≠ Resource Ownership.
 * - Customer can ONLY access orders where orders.user_id = req.auth.userId
 * - Seller staff/owner can ONLY access orders where orders.merchant_id IN (req.auth.merchantIds)
 * - Rider can ONLY access orders where delivery_trips.rider_id = req.auth.riderId
 * - Admin with 'orders.view' permission can access across all merchants/customers
 */
export function requireOrderOwnership(orderIdParam: string = 'id') {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.auth) {
      res.status(401).json({ success: false, error: 'UNAUTHENTICATED', message: 'Authentication required.' });
      return;
    }

    const orderId = req.params[orderIdParam] || req.body?.orderId || req.query?.orderId;
    if (!orderId) {
      res.status(400).json({ success: false, error: 'MISSING_ORDER_ID', message: 'Order ID parameter is required.' });
      return;
    }

    // 1. Super Admin and Global Operations Admins bypass tenant restriction
    const isGlobalAdmin = req.auth.isSuperAdmin || 
      req.auth.roles.includes('SUPER_ADMIN') || 
      req.auth.roles.includes('OPERATIONS') || 
      req.auth.roles.includes('FINANCE_ADMIN');

    if (isGlobalAdmin) {
      return next();
    }

    const pool = getPool();
    const orderRes = await pool.query(
      `SELECT o.id, o.order_number, o.user_id, o.merchant_id, dt.rider_id 
       FROM orders o
       LEFT JOIN delivery_trips dt ON dt.order_id = o.id
       WHERE o.id::text = $1 OR o.order_number = $1`,
      [orderId]
    );

    if (orderRes.rows.length === 0) {
      res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND', message: 'Requested order was not found.' });
      return;
    }

    const order = orderRes.rows[0];

    // 2. Customer ownership check
    const isCustomerOwner = order.user_id === req.auth.userId;

    // 3. Seller merchant tenant check (Merchant staff cannot access another merchant's order)
    const isMerchantAuthorized = req.auth.merchantIds && req.auth.merchantIds.includes(order.merchant_id);

    // 4. Delivery rider assignment check (Rider cannot inspect trips of other riders)
    const isAssignedRider = req.auth.riderId && order.rider_id === req.auth.riderId;

    if (!isCustomerOwner && !isMerchantAuthorized && !isAssignedRider) {
      await recordAuditEvent({
        actorId: req.auth.userId,
        actorType: 'USER',
        action: 'IDOR_ATTEMPT_BLOCKED',
        entityType: 'ORDER',
        entityId: order.id,
        newState: {
          requestPath: req.originalUrl,
          orderOwnerUserId: order.user_id,
          orderMerchantId: order.merchant_id,
          callerMerchantIds: req.auth.merchantIds,
          callerRiderId: req.auth.riderId,
        },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.status(403).json({
        success: false,
        error: 'RESOURCE_ACCESS_DENIED',
        message: 'Access forbidden: You do not have ownership or tenant authorization for this order.',
      });
      return;
    }

    next();
  };
}

/**
 * Enforces Tenant Isolation for Merchant & Store Resources (Catalog, Inventory, Settlements).
 * 
 * CORE INVARIANT: A seller login does NOT grant access to other sellers' inventories or stores.
 */
export function requireMerchantOwnership(merchantIdParam: string = 'merchantId') {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.auth) {
      res.status(401).json({ success: false, error: 'UNAUTHENTICATED', message: 'Authentication required.' });
      return;
    }

    const merchantId = req.params[merchantIdParam] || req.body?.merchantId || req.query?.merchantId;
    if (!merchantId) {
      res.status(400).json({ success: false, error: 'MISSING_MERCHANT_ID', message: 'Merchant ID parameter is required.' });
      return;
    }

    // Global platform administrators can inspect across stores
    const isGlobalAdmin = req.auth.isSuperAdmin || 
      req.auth.roles.includes('SUPER_ADMIN') || 
      req.auth.roles.includes('OPERATIONS');

    if (isGlobalAdmin) {
      return next();
    }

    // Verify merchant tenant boundary
    const isAuthorizedMerchant = req.auth.merchantIds && req.auth.merchantIds.includes(merchantId);

    if (!isAuthorizedMerchant) {
      await recordAuditEvent({
        actorId: req.auth.userId,
        actorType: 'SELLER',
        action: 'CROSS_MERCHANT_IDOR_BLOCKED',
        entityType: 'MERCHANT',
        entityId: merchantId,
        newState: {
          attemptedMerchantId: merchantId,
          callerAuthorizedMerchants: req.auth.merchantIds,
        },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.status(403).json({
        success: false,
        error: 'TENANT_ACCESS_DENIED',
        message: 'Access forbidden: You are not authorized to access or modify resources belonging to another merchant store.',
      });
      return;
    }

    next();
  };
}

/**
 * Enforces Delivery Partner Resource Ownership (Rider profile, earnings, trips, telemetry).
 */
export function requireRiderOwnership(riderIdParam: string = 'riderId') {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.auth) {
      res.status(401).json({ success: false, error: 'UNAUTHENTICATED', message: 'Authentication required.' });
      return;
    }

    const riderId = req.params[riderIdParam] || req.body?.riderId || req.query?.riderId;
    if (!riderId) {
      res.status(400).json({ success: false, error: 'MISSING_RIDER_ID', message: 'Rider ID parameter is required.' });
      return;
    }

    const isGlobalAdmin = req.auth.isSuperAdmin || 
      req.auth.roles.includes('SUPER_ADMIN') || 
      req.auth.roles.includes('OPERATIONS');

    if (isGlobalAdmin) {
      return next();
    }

    const isOwnRider = req.auth.riderId === riderId;
    if (!isOwnRider) {
      await recordAuditEvent({
        actorId: req.auth.userId,
        actorType: 'RIDER',
        action: 'CROSS_RIDER_IDOR_BLOCKED',
        entityType: 'RIDER',
        entityId: riderId,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.status(403).json({
        success: false,
        error: 'RIDER_ACCESS_DENIED',
        message: 'Access forbidden: You cannot access telemetry, earnings, or profile of another delivery partner.',
      });
      return;
    }

    next();
  };
}
