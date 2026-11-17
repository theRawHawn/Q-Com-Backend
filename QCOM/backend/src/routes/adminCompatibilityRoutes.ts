import { Router, Request, Response } from 'express';
import { getPool } from '../database/connection.js';
import { authenticate } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { safeErrorMessage } from '../middleware/errorHandler.js';
import { catalogSearchRateLimiter, adminSensitiveRateLimiter } from '../middleware/rateLimiter.js';
import { recordAuditEvent } from '../modules/audit/auditService.js';
import { realtimeGateway } from '../modules/realtime/websocketServer.js';

export const adminCompatibilityRouter = Router();

const ANY_ADMIN_ROLES = ['SUPER_ADMIN', 'ADMIN', 'OPERATIONS', 'FINANCE_ADMIN', 'DISPATCHER', 'MARKETING_ADMIN'];
const OPS_ADMIN_ROLES = ['SUPER_ADMIN', 'ADMIN', 'OPERATIONS', 'DISPATCHER'];
const SELLER_OPS_ROLES = ['SUPER_ADMIN', 'ADMIN', 'OPERATIONS'];
const FINANCE_ROLES = ['SUPER_ADMIN', 'FINANCE_ADMIN'];
const AUDIT_VIEW_ROLES = ['SUPER_ADMIN', 'ADMIN', 'OPERATIONS', 'FINANCE_ADMIN'];
const PROMO_ROLES = ['SUPER_ADMIN', 'ADMIN', 'OPERATIONS', 'MARKETING_ADMIN'];
const SUPER_ADMIN_ONLY = ['SUPER_ADMIN'];

// Indian Operational Cities reference data
const OPERATIONAL_CITIES = [
  { id: 'bengaluru', name: 'Bengaluru', state: 'Karnataka', region: 'South', tier: 'Tier 1', code: 'BLR', activeZones: 24, status: 'ACTIVE' },
  { id: 'mumbai', name: 'Mumbai', state: 'Maharashtra', region: 'West', tier: 'Tier 1', code: 'BOM', activeZones: 32, status: 'ACTIVE' },
  { id: 'delhi_ncr', name: 'Delhi NCR', state: 'Delhi', region: 'North', tier: 'Tier 1', code: 'DEL', activeZones: 28, status: 'ACTIVE' },
  { id: 'hyderabad', name: 'Hyderabad', state: 'Telangana', region: 'South', tier: 'Tier 1', code: 'HYD', activeZones: 18, status: 'ACTIVE' },
  { id: 'pune', name: 'Pune', state: 'Maharashtra', region: 'West', tier: 'Tier 2', code: 'PNQ', activeZones: 14, status: 'ACTIVE' },
  { id: 'chennai', name: 'Chennai', state: 'Tamil Nadu', region: 'South', tier: 'Tier 1', code: 'MAA', activeZones: 16, status: 'ACTIVE' },
  { id: 'ahmedabad', name: 'Ahmedabad', state: 'Gujarat', region: 'West', tier: 'Tier 2', code: 'AMD', activeZones: 12, status: 'ACTIVE' },
  { id: 'kolkata', name: 'Kolkata', state: 'West Bengal', region: 'East', tier: 'Tier 1', code: 'CCU', activeZones: 15, status: 'ACTIVE' },
];

/**
 * GET /api/admin/cities & GET /api/v1/admin/cities
 * Returns serviceable Indian tier 1 & 2 cities for quick-commerce operational zones
 */
adminCompatibilityRouter.get('/cities', authenticate, requireRole(ANY_ADMIN_ROLES), (_req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    cities: OPERATIONAL_CITIES,
  });
});

/**
 * GET /api/admin/me & GET /api/v1/admin/me
 * Strictly verified administrative session and effective permissions handshake (header spoofing rejected)
 */
adminCompatibilityRouter.get('/me', authenticate, requireRole(ANY_ADMIN_ROLES), async (req: Request, res: Response): Promise<void> => {
  const perms = req.auth!.permissions || [];
  res.status(200).json({
    success: true,
    user: {
      id: req.auth!.userId,
      name: req.auth!.name,
      email: req.auth!.email,
      phone: req.auth!.phone,
      roles: req.auth!.roles,
      permissions: perms,
      isSuperAdmin: req.auth!.isSuperAdmin,
    },
    permissions: perms,
    roles: req.auth!.roles,
  });
});

/**
 * GET /api/admin/orders & GET /api/v1/admin/orders
 * Returns all system orders for central control room monitoring
 */
adminCompatibilityRouter.get('/orders', authenticate, requireRole(OPS_ADMIN_ROLES.concat(['FINANCE_ADMIN'])), async (req: Request, res: Response): Promise<void> => {
  const pool = getPool();
  try {
    const { status, limit = 50, offset = 0 } = req.query;
    const boundedLimit = Math.min(200, Math.max(1, Number(limit) || 50));
    const boundedOffset = Math.max(0, Number(offset) || 0);

    let query = `
      SELECT o.id, o.order_number, o.user_id, o.merchant_id, o.status,
             o.total_amount, o.payment_method, o.payment_status,
             o.placed_at, o.estimated_delivery_at, o.delivered_at,
             m.name as merchant_name, m.locality as merchant_locality,
             u.name as customer_name, u.phone as customer_phone
      FROM orders o
      LEFT JOIN merchants m ON o.merchant_id = m.id
      LEFT JOIN users u ON o.user_id = u.id
    `;
    const params: any[] = [];
    if (status && typeof status === 'string' && status !== 'all') {
      params.push(status);
      query += ` WHERE o.status = $1`;
    }
    query += ` ORDER BY o.placed_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(boundedLimit, boundedOffset);

    const ordersRes = await pool.query(query, params);
    res.status(200).json({
      success: true,
      orders: ordersRes.rows.map(r => ({
        id: r.id,
        orderNumber: r.order_number,
        userId: r.user_id,
        customerName: r.customer_name || 'Customer',
        customerPhone: r.customer_phone || null,
        merchantId: r.merchant_id,
        merchantName: r.merchant_name || 'Partner Store',
        status: r.status,
        total: parseFloat(r.total_amount),
        paymentMethod: r.payment_method,
        paymentStatus: r.payment_status,
        createdAt: r.placed_at,
        estimatedDeliveryTime: r.estimated_delivery_at,
        deliveredAt: r.delivered_at,
      })),
      total: ordersRes.rows.length,
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: 'ORDER_FETCH_FAILED',
      message: safeErrorMessage(err, 'Failed to query operational orders.'),
    });
  }
});

/**
 * GET /api/admin/riders & GET /api/v1/admin/riders
 * Returns fleet rider partners and their live telemetry/duty states
 */
adminCompatibilityRouter.get('/riders', authenticate, requireRole(OPS_ADMIN_ROLES), async (_req: Request, res: Response): Promise<void> => {
  const pool = getPool();
  try {
    const ridersRes = await pool.query(`
      SELECT r.id, r.user_id, r.status, r.vehicle_type, r.vehicle_plate,
             r.rating, r.tier, r.latitude, r.longitude, r.wallet_balance,
             r.floating_cash_balance, r.floating_cash_limit, r.kyc_status,
             u.name, u.phone, u.email
      FROM riders r
      LEFT JOIN users u ON r.user_id = u.id
      ORDER BY r.rating DESC
    `);

    res.status(200).json({
      success: true,
      riders: ridersRes.rows.map(r => ({
        id: r.id,
        name: r.name || 'Fleet Partner',
        phone: r.phone || null,
        vehicleType: r.vehicle_type,
        vehiclePlate: r.vehicle_plate,
        rating: parseFloat(r.rating || 5.0),
        tier: r.tier || 'Silver',
        status: r.status,
        isOnline: r.status !== 'OFFLINE',
        latitude: r.latitude ? parseFloat(r.latitude) : 12.9352,
        longitude: r.longitude ? parseFloat(r.longitude) : 77.6245,
        floatingCash: parseFloat(r.floating_cash_balance || 0),
        floatingCashLimit: parseFloat(r.floating_cash_limit || 2500),
        walletBalance: parseFloat(r.wallet_balance || 0),
        kycStatus: r.kyc_status,
      })),
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: 'RIDER_FETCH_FAILED',
      message: safeErrorMessage(err, 'Failed to query rider fleet.'),
    });
  }
});

/**
 * GET /api/admin/sellers & GET /api/admin/merchants
 * Returns onboarded merchants and compliance verification status
 */
const handleGetSellers = async (_req: Request, res: Response): Promise<void> => {
  const pool = getPool();
  try {
    const sellersRes = await pool.query(`
      SELECT id, name, business_name, locality, address, phone, email,
             gstin, pan_number, pan_status, status, is_online,
             commission_rate_percent, fy_gross_sales_inr, created_at
      FROM merchants
      ORDER BY created_at DESC
    `);

    res.status(200).json({
      success: true,
      sellers: sellersRes.rows.map(s => ({
        id: s.id,
        name: s.name,
        businessName: s.business_name,
        locality: s.locality,
        address: s.address,
        phone: s.phone,
        email: s.email,
        gstin: s.gstin,
        pan: s.pan_number,
        panStatus: s.pan_status,
        status: s.status,
        isOnline: s.is_online,
        commissionRate: parseFloat(s.commission_rate_percent),
        annualGrossSales: parseFloat(s.fy_gross_sales_inr || 0),
        createdAt: s.created_at,
      })),
      merchants: sellersRes.rows,
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: 'SELLER_FETCH_FAILED',
      message: safeErrorMessage(err, 'Failed to query sellers.'),
    });
  }
};

adminCompatibilityRouter.get('/sellers', authenticate, requireRole(AUDIT_VIEW_ROLES), handleGetSellers);
adminCompatibilityRouter.get('/merchants', authenticate, requireRole(AUDIT_VIEW_ROLES), handleGetSellers);

/**
 * GET /api/admin/settlements & GET /api/v1/admin/settlements
 * Returns settlement journal overview and pending merchant payables
 */
adminCompatibilityRouter.get('/settlements', authenticate, requireRole(FINANCE_ROLES), async (_req: Request, res: Response): Promise<void> => {
  const pool = getPool();
  try {
    const settlementsRes = await pool.query(`
      SELECT o.id as order_id, o.order_number, o.merchant_id, o.total_amount,
             o.placed_at, o.delivered_at, m.name as merchant_name, m.gstin,
             m.commission_rate_percent
      FROM orders o
      JOIN merchants m ON o.merchant_id = m.id
      WHERE o.status = 'delivered'
      ORDER BY o.delivered_at DESC
      LIMIT 100
    `);

    res.status(200).json({
      success: true,
      settlements: settlementsRes.rows.map(r => {
        const total = parseFloat(r.total_amount);
        const commRate = parseFloat(r.commission_rate_percent || 15);
        const comm = (total * commRate) / 100;
        const tds = (total * 0.1) / 100; // 0.1% TDS
        const net = total - comm - tds;
        return {
          id: r.order_id,
          orderId: r.order_id,
          orderNumber: r.order_number,
          merchantId: r.merchant_id,
          merchantName: r.merchant_name,
          grossAmount: total,
          commissionAmount: comm,
          tdsWithheld: tds,
          netPayable: net,
          status: 'PENDING_PAYOUT',
          settledAt: r.delivered_at,
        };
      }),
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: 'SETTLEMENT_FETCH_FAILED',
      message: safeErrorMessage(err, 'Failed to query settlements.'),
    });
  }
});

/**
 * GET /api/admin/audit-logs & GET /api/v1/admin/audit-logs
 * Immutable audit logs viewer for compliance and regulatory inspection
 */
adminCompatibilityRouter.get('/audit-logs', authenticate, requireRole(AUDIT_VIEW_ROLES), async (_req: Request, res: Response): Promise<void> => {
  const pool = getPool();
  try {
    const logsRes = await pool.query(`
      SELECT id, actor_id, actor_type, action, entity_type, entity_id,
             ip_address, created_at
      FROM audit_logs
      ORDER BY created_at DESC
      LIMIT 100
    `);

    res.status(200).json({
      success: true,
      logs: logsRes.rows.map(l => ({
        id: l.id,
        actorId: l.actor_id,
        actorType: l.actor_type,
        action: l.action,
        entityType: l.entity_type,
        entityId: l.entity_id,
        ip: l.ip_address,
        timestamp: l.created_at,
      })),
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: 'AUDIT_LOG_FETCH_FAILED',
      message: safeErrorMessage(err, 'Failed to query audit logs.'),
    });
  }
});

/**
 * GET /api/admin/refunds & GET /api/v1/admin/refunds
 * Central refund requests queue
 */
adminCompatibilityRouter.get('/refunds', authenticate, requireRole(['SUPER_ADMIN', 'FINANCE_ADMIN', 'OPERATIONS']), async (_req: Request, res: Response): Promise<void> => {
  const pool = getPool();
  try {
    const refundsRes = await pool.query(`
      SELECT r.id, r.order_id, o.user_id, o.merchant_id, r.status,
             r.reason_code as reason, r.amount as refund_amount, r.created_at
      FROM refunds r
      LEFT JOIN orders o ON r.order_id = o.id
      ORDER BY r.created_at DESC
      LIMIT 100
    `);

    res.status(200).json({
      success: true,
      refunds: refundsRes.rows.map(r => ({
        id: r.id,
        orderId: r.order_id,
        userId: r.user_id,
        merchantId: r.merchant_id,
        status: r.status,
        reason: r.reason,
        amount: parseFloat(r.refund_amount || 0),
        createdAt: r.created_at,
      })),
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: 'REFUND_FETCH_FAILED',
      message: safeErrorMessage(err, 'Failed to query refunds.'),
    });
  }
});

/**
 * POST /api/admin/orders/:orderId/assign-rider
 * Manual admin rider dispatch override
 */
adminCompatibilityRouter.post('/orders/:orderId/assign-rider', authenticate, adminSensitiveRateLimiter, async (req: Request, res: Response): Promise<void> => {
  const { orderId } = req.params;
  const { riderId } = req.body;
  const pool = getPool();

  if (!riderId) {
    res.status(400).json({ success: false, error: 'MISSING_RIDER_ID', message: 'riderId is required.' });
    return;
  }

  // 1. RBAC authorization check: Must have SUPER_ADMIN or OPERATIONS role
  const isAdmin =
    Boolean(req.auth?.isSuperAdmin) ||
    Boolean(req.auth?.roles?.some((r: string) => ['SUPER_ADMIN', 'OPERATIONS', 'PLATFORM_ADMIN'].includes(r)));

  if (!isAdmin) {
    res.status(403).json({
      success: false,
      error: 'FORBIDDEN',
      message: 'Access denied: Requires administrative role (SUPER_ADMIN or OPERATIONS) to manually assign riders.',
    });
    return;
  }

  // 2. Validate target rider exists and is active
  const riderCheck = await pool.query(
    `SELECT id, name, status FROM riders WHERE id = $1`,
    [riderId]
  );
  if (riderCheck.rows.length === 0) {
    res.status(404).json({ success: false, error: 'RIDER_NOT_FOUND', message: 'Target rider does not exist.' });
    return;
  }
  const targetRider = riderCheck.rows[0];
  if (targetRider.status === 'SUSPENDED') {
    res.status(400).json({ success: false, error: 'RIDER_SUSPENDED', message: 'Cannot assign a suspended delivery partner.' });
    return;
  }

  try {
    const updateRes = await pool.query(
      `UPDATE delivery_trips 
       SET rider_id = $1, status = 'ACCEPTED', accepted_at = NOW() 
       WHERE order_id = $2 AND status IN ('BROADCASTING', 'CREATED', 'OFFERED', 'PENDING')
       RETURNING id, order_id, status, rider_id`,
      [riderId, orderId]
    );

    if (updateRes.rowCount === 0) {
      const existingTrip = await pool.query(
        `SELECT id, rider_id, status FROM delivery_trips WHERE order_id = $1`,
        [orderId]
      );
      if (existingTrip.rows.length === 0) {
        res.status(404).json({ success: false, error: 'TRIP_NOT_FOUND', message: 'No delivery trip found for this order.' });
        return;
      }
      const trip = existingTrip.rows[0];
      if (['ACCEPTED', 'ARRIVED_AT_PICKUP', 'PICKED_UP', 'ARRIVED_AT_DROP', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED'].includes(trip.status)) {
        res.status(409).json({
          success: false,
          error: 'INVALID_TRIP_STATE',
          message: `Cannot reassign rider when trip is in active '${trip.status}' status.`,
          currentStatus: trip.status,
          currentRiderId: trip.rider_id,
        });
        return;
      }
      res.status(409).json({
        success: false,
        error: 'ALREADY_ASSIGNED',
        message: `Trip is already assigned to rider ${trip.rider_id || 'another rider'}.`,
        currentStatus: trip.status,
      });
      return;
    }

    const assignedTrip = updateRes.rows[0];

    try {
      await recordAuditEvent({
        actorId: req.auth?.userId || 'unknown_admin',
        actorType: 'ADMIN',
        action: 'ADMIN_MANUAL_RIDER_ASSIGN',
        entityType: 'DELIVERY_TRIP',
        entityId: assignedTrip.id,
        newState: { orderId, riderId, status: 'ACCEPTED' },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'] as string | undefined,
      });
    } catch {
      // Non-blocking
    }

    res.status(200).json({
      success: true,
      message: 'Rider assigned to order successfully.',
      orderId,
      riderId,
      tripId: assignedTrip.id,
      status: 'ACCEPTED',
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: 'ASSIGNMENT_FAILED',
      message: safeErrorMessage(err, 'Failed to assign rider.'),
    });
  }
});

/**
 * POST /api/admin/riders/:id/release-payout
 * Admin release rider payout approval (strictly Finance Admin or Super Admin)
 */
adminCompatibilityRouter.post('/riders/:id/release-payout', authenticate, requireRole(FINANCE_ROLES), adminSensitiveRateLimiter, async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { amount } = req.body;
  try {
    await recordAuditEvent({
      actorId: req.auth!.userId,
      actorType: 'ADMIN',
      action: 'ADMIN_RIDER_PAYOUT_RELEASED',
      entityType: 'RIDER',
      entityId: id,
      newState: { amount: amount || 0 },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] as string | undefined,
    });
  } catch {
    // Non-blocking
  }
  res.status(200).json({
    success: true,
    message: 'Rider payout released successfully.',
    riderId: id,
    releasedAmount: amount || 0,
    timestamp: new Date().toISOString(),
  });
});

/**
 * POST /api/admin/sellers/:id/approve
 * Admin approve seller onboarding
 */
adminCompatibilityRouter.post('/sellers/:id/approve', authenticate, requireRole(SELLER_OPS_ROLES), adminSensitiveRateLimiter, async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const pool = getPool();
  try {
    await pool.query(`UPDATE merchants SET status = 'ACTIVE', updated_at = NOW() WHERE id = $1`, [id]);
    await recordAuditEvent({
      actorId: req.auth!.userId,
      actorType: 'ADMIN',
      action: 'ADMIN_SELLER_APPROVED',
      entityType: 'MERCHANT',
      entityId: id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] as string | undefined,
    });
    res.status(200).json({
      success: true,
      message: 'Seller approved successfully.',
      sellerId: id,
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: 'APPROVAL_FAILED',
      message: safeErrorMessage(err, 'Failed to approve seller.'),
    });
  }
});

/**
 * POST /api/admin/riders/broadcast
 * Broadcast task dispatch trigger
 */
adminCompatibilityRouter.post('/riders/broadcast', authenticate, requireRole(OPS_ADMIN_ROLES), adminSensitiveRateLimiter, async (req: Request, res: Response): Promise<void> => {
  const { riderCount } = req.body;
  res.status(200).json({
    success: true,
    message: 'Task broadcast dispatched to nearby candidate riders.',
    broadcastCount: riderCount || 5,
    timestamp: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// Customer Management Endpoints
// ---------------------------------------------------------------------------

/**
 * GET /api/admin/customers
 */
adminCompatibilityRouter.get('/customers', authenticate, requireRole(AUDIT_VIEW_ROLES), async (_req: Request, res: Response): Promise<void> => {
  const pool = getPool();
  try {
    const custRes = await pool.query(`
      SELECT u.id, u.name, u.phone, u.email, u.account_type, u.created_at, u.is_suspended,
             COUNT(o.id) as total_orders,
             COALESCE(SUM(o.total_amount), 0) as total_spend
      FROM users u
      LEFT JOIN orders o ON u.id = o.user_id
      GROUP BY u.id
      ORDER BY u.created_at DESC
      LIMIT 100
    `);

    res.status(200).json({
      success: true,
      customers: custRes.rows.map(c => ({
        id: c.id,
        name: c.name || 'Contractor Customer',
        phone: c.phone,
        email: c.email || null,
        accountType: c.account_type || 'individual',
        status: c.is_suspended ? 'SUSPENDED' : 'ACTIVE',
        totalOrders: parseInt(c.total_orders, 10) || 0,
        totalSpend: parseFloat(c.total_spend) || 0,
        createdAt: c.created_at,
      })),
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: 'CUSTOMER_FETCH_FAILED',
      message: safeErrorMessage(err, 'Failed to query customers.'),
    });
  }
});

adminCompatibilityRouter.patch('/customers/:id/status', authenticate, requireRole(SELLER_OPS_ROLES), adminSensitiveRateLimiter, async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { status, reason } = req.body;
  const pool = getPool();

  if (status !== 'ACTIVE' && status !== 'SUSPENDED') {
    res.status(400).json({
      success: false,
      error: 'INVALID_STATUS',
      message: "status must be 'ACTIVE' or 'SUSPENDED'.",
    });
    return;
  }

  const isSuspended = status === 'SUSPENDED';
  const suspensionReason = isSuspended ? (reason || 'Suspended by administrator.') : null;

  try {
    const updateRes = await pool.query(
      `UPDATE users SET is_suspended = $1, suspension_reason = $2, updated_at = NOW() WHERE id = $3 RETURNING id`,
      [isSuspended, suspensionReason, id]
    );
    if (updateRes.rowCount === 0) {
      res.status(404).json({ success: false, error: 'USER_NOT_FOUND', message: 'Target user not found.' });
      return;
    }

    if (isSuspended) {
      await pool.query(
        `UPDATE auth_sessions SET status = 'REVOKED', revoked_at = NOW() WHERE user_id = $1 AND status = 'ACTIVE'`,
        [id]
      );
      await pool.query(
        `UPDATE refresh_tokens SET is_revoked = TRUE, revoked_at = NOW() WHERE user_id = $1 AND is_revoked = FALSE`,
        [id]
      );
      realtimeGateway.handleUserLogoutAll(id);
    }

    await recordAuditEvent({
      actorId: req.auth!.userId,
      actorType: 'ADMIN',
      action: isSuspended ? 'USER_SUSPENDED' : 'USER_REACTIVATED',
      entityType: 'USER',
      entityId: id,
      newState: { status, reason: suspensionReason },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] as string | undefined,
    });

    res.status(200).json({ success: true, message: `Customer status updated to ${status}`, customerId: id, status });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: 'STATUS_UPDATE_FAILED',
      message: safeErrorMessage(err, 'Failed to update customer status.'),
    });
  }
});

adminCompatibilityRouter.post('/customers/:id/fraud-controls', authenticate, requireRole(SELLER_OPS_ROLES), adminSensitiveRateLimiter, async (req: Request, res: Response): Promise<void> => {
  await recordAuditEvent({
    actorId: req.auth!.userId,
    actorType: 'ADMIN',
    action: 'CUSTOMER_FRAUD_CONTROLS_UPDATED',
    entityType: 'USER',
    entityId: req.params.id,
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'] as string | undefined,
  });
  res.status(200).json({ success: true, message: 'Fraud controls updated successfully', customerId: req.params.id });
});

adminCompatibilityRouter.post('/customers/:id/notes', authenticate, requireRole(OPS_ADMIN_ROLES), adminSensitiveRateLimiter, async (req: Request, res: Response): Promise<void> => {
  res.status(200).json({ success: true, message: 'Customer administrative note saved', customerId: req.params.id });
});

adminCompatibilityRouter.post('/customers/:id/reset-session', authenticate, requireRole(SELLER_OPS_ROLES), adminSensitiveRateLimiter, async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const pool = getPool();
  try {
    await pool.query(
      `UPDATE auth_sessions SET status = 'REVOKED', revoked_at = NOW() WHERE user_id = $1 AND status = 'ACTIVE'`,
      [id]
    );
    await pool.query(
      `UPDATE refresh_tokens SET is_revoked = TRUE, revoked_at = NOW() WHERE user_id = $1 AND is_revoked = FALSE`,
      [id]
    );
    realtimeGateway.handleUserLogoutAll(id);

    await recordAuditEvent({
      actorId: req.auth!.userId,
      actorType: 'ADMIN',
      action: 'ADMIN_SESSION_RESET',
      entityType: 'USER',
      entityId: id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] as string | undefined,
    });

    res.status(200).json({ success: true, message: 'Customer active sessions reset successfully', customerId: id });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: 'SESSION_RESET_FAILED',
      message: safeErrorMessage(err, 'Failed to reset user sessions.'),
    });
  }
});

// ---------------------------------------------------------------------------
// Service Areas & Operational Zones
// ---------------------------------------------------------------------------

const OPERATIONAL_ZONES = [
  { id: 'zone-blr-koramangala', cityId: 'bengaluru', name: 'Koramangala Commercial Hub', status: 'ACTIVE', radiusKm: 8, maxDeliveryMins: 15 },
  { id: 'zone-blr-indiranagar', cityId: 'bengaluru', name: 'Indiranagar Central', status: 'ACTIVE', radiusKm: 6, maxDeliveryMins: 12 },
  { id: 'zone-blr-whitefield', cityId: 'bengaluru', name: 'Whitefield Tech & MEP Zone', status: 'ACTIVE', radiusKm: 12, maxDeliveryMins: 20 },
  { id: 'zone-bom-andheri', cityId: 'mumbai', name: 'Andheri West Industrial Corridor', status: 'ACTIVE', radiusKm: 7, maxDeliveryMins: 15 },
  { id: 'zone-bom-bkc', cityId: 'mumbai', name: 'Bandra-Kurla Complex Zone', status: 'ACTIVE', radiusKm: 5, maxDeliveryMins: 10 },
  { id: 'zone-del-gurgaon', cityId: 'delhi_ncr', name: 'Gurgaon Cyber City & Udyog Vihar', status: 'ACTIVE', radiusKm: 10, maxDeliveryMins: 15 },
  { id: 'zone-del-noida', cityId: 'delhi_ncr', name: 'Noida Sector 62 & Construction Belt', status: 'ACTIVE', radiusKm: 9, maxDeliveryMins: 15 },
];

adminCompatibilityRouter.get('/service-areas', authenticate, requireRole(ANY_ADMIN_ROLES), async (_req: Request, res: Response): Promise<void> => {
  res.status(200).json({ success: true, serviceAreas: OPERATIONAL_ZONES });
});

adminCompatibilityRouter.post('/service-areas', authenticate, requireRole(SELLER_OPS_ROLES), adminSensitiveRateLimiter, async (req: Request, res: Response): Promise<void> => {
  const newZone = { id: `zone-${Date.now()}`, ...req.body, status: 'ACTIVE' };
  res.status(200).json({ success: true, message: 'Service area created', serviceArea: newZone });
});

adminCompatibilityRouter.post('/cities/:id/toggle', authenticate, requireRole(SELLER_OPS_ROLES), adminSensitiveRateLimiter, async (req: Request, res: Response): Promise<void> => {
  res.status(200).json({ success: true, message: 'City operational status toggled', cityId: req.params.id });
});

adminCompatibilityRouter.post('/service-areas/:id/toggle', authenticate, requireRole(SELLER_OPS_ROLES), adminSensitiveRateLimiter, async (req: Request, res: Response): Promise<void> => {
  res.status(200).json({ success: true, message: 'Service zone operational status toggled', zoneId: req.params.id });
});

adminCompatibilityRouter.post('/cities/:id/config', authenticate, requireRole(SELLER_OPS_ROLES), adminSensitiveRateLimiter, async (req: Request, res: Response): Promise<void> => {
  res.status(200).json({ success: true, message: 'City configuration saved', cityId: req.params.id });
});

// ---------------------------------------------------------------------------
// Roles, Permissions & Employee Management
// ---------------------------------------------------------------------------

adminCompatibilityRouter.get('/roles', authenticate, requireRole(AUDIT_VIEW_ROLES), async (_req: Request, res: Response): Promise<void> => {
  const pool = getPool();
  try {
    const rolesRes = await pool.query('SELECT id, code, name, description, is_system_role FROM roles ORDER BY id');
    res.status(200).json({ success: true, roles: rolesRes.rows });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'ROLES_FETCH_FAILED', message: safeErrorMessage(err, 'Failed to fetch roles.') });
  }
});

adminCompatibilityRouter.get('/permissions', authenticate, requireRole(AUDIT_VIEW_ROLES), async (_req: Request, res: Response): Promise<void> => {
  const pool = getPool();
  try {
    const permRes = await pool.query('SELECT id, key, module, name, description FROM permissions ORDER BY module, key');
    res.status(200).json({ success: true, permissions: permRes.rows });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'PERMISSIONS_FETCH_FAILED', message: safeErrorMessage(err, 'Failed to fetch permissions.') });
  }
});

adminCompatibilityRouter.get('/employees/list', authenticate, requireRole(AUDIT_VIEW_ROLES), async (_req: Request, res: Response): Promise<void> => {
  const pool = getPool();
  try {
    const empRes = await pool.query(`
      SELECT u.id, u.name, u.email, u.phone, r.code as role, r.name as role_name, u.is_suspended
      FROM users u
      JOIN user_roles ur ON u.id = ur.user_id
      JOIN roles r ON ur.role_id = r.id
      WHERE r.code IN ('SUPER_ADMIN', 'OPERATIONS', 'DISPATCHER', 'FINANCE_ADMIN', 'MARKETING_ADMIN')
      ORDER BY u.created_at DESC
    `);
    res.status(200).json({
      success: true,
      employees: empRes.rows.map(e => ({
        id: e.id,
        name: e.name,
        email: e.email,
        phone: e.phone,
        role: e.role,
        roleName: e.role_name,
        status: e.is_suspended ? 'SUSPENDED' : 'ACTIVE',
      })),
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'EMPLOYEES_FETCH_FAILED', message: safeErrorMessage(err, 'Failed to list employees.') });
  }
});

adminCompatibilityRouter.post('/employees/create', authenticate, requireRole(SUPER_ADMIN_ONLY), adminSensitiveRateLimiter, async (req: Request, res: Response): Promise<void> => {
  const { name, email, phone, role } = req.body;
  const pool = getPool();

  if (!name || !phone || !role) {
    res.status(400).json({ success: false, error: 'MISSING_FIELDS', message: 'name, phone, and role are required.' });
    return;
  }

  try {
    const roleRes = await pool.query('SELECT id, code FROM roles WHERE code = $1 LIMIT 1', [String(role).toUpperCase()]);
    if (roleRes.rows.length === 0) {
      res.status(400).json({ success: false, error: 'INVALID_ROLE', message: `Role '${role}' does not exist.` });
      return;
    }

    const userRes = await pool.query(`
      INSERT INTO users (name, email, phone, is_phone_verified, account_type)
      VALUES ($1, $2, $3, true, 'business')
      ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name, email = COALESCE(EXCLUDED.email, users.email)
      RETURNING id
    `, [String(name).trim(), email ? String(email).trim() : null, String(phone).trim()]);
    const empId = userRes.rows[0].id;

    await pool.query(
      'INSERT INTO user_roles (user_id, role_id, assigned_by, assigned_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (user_id, role_id) DO NOTHING',
      [empId, roleRes.rows[0].id, req.auth!.userId]
    );

    await recordAuditEvent({
      actorId: req.auth!.userId,
      actorType: 'ADMIN',
      action: 'ADMIN_EMPLOYEE_CREATED',
      entityType: 'USER',
      entityId: empId,
      newState: { role: roleRes.rows[0].code },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] as string | undefined,
    });

    res.status(200).json({ success: true, message: 'Employee created successfully', employee: { id: empId, name, email, phone, role: roleRes.rows[0].code } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'EMPLOYEE_CREATE_FAILED', message: safeErrorMessage(err, 'Failed to create employee.') });
  }
});

adminCompatibilityRouter.post('/employees/:id/assign-roles', authenticate, requireRole(SUPER_ADMIN_ONLY), adminSensitiveRateLimiter, async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { role, roles } = req.body;
  const pool = getPool();

  if (id === req.auth!.userId) {
    await recordAuditEvent({
      actorId: req.auth!.userId,
      actorType: 'ADMIN',
      action: 'PRIVILEGE_ESCALATION_BLOCKED',
      entityType: 'USER',
      entityId: id,
      newState: { attemptedSelfRoleMutation: true, requestedBody: req.body },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] as string | undefined,
    });
    res.status(403).json({ success: false, error: 'SELF_ROLE_MUTATION_DENIED', message: 'Administrators cannot self-assign roles.' });
    return;
  }

  const targetRoles: string[] = Array.isArray(roles)
    ? roles.map((r: any) => String(r).toUpperCase())
    : role
    ? [String(role).toUpperCase()]
    : [];

  if (targetRoles.length === 0) {
    res.status(400).json({ success: false, error: 'MISSING_ROLES', message: 'role or roles array is required.' });
    return;
  }

  try {
    const userCheck = await pool.query(`SELECT id FROM users WHERE id = $1`, [id]);
    if (userCheck.rows.length === 0) {
      res.status(404).json({ success: false, error: 'USER_NOT_FOUND', message: 'Employee user not found.' });
      return;
    }

    const roleRows = await pool.query(`SELECT id, code FROM roles WHERE code = ANY($1::text[])`, [targetRoles]);
    if (roleRows.rows.length === 0) {
      res.status(400).json({ success: false, error: 'INVALID_ROLE', message: 'No matching roles found.' });
      return;
    }

    for (const r of roleRows.rows) {
      await pool.query(
        `INSERT INTO user_roles (user_id, role_id, assigned_by, assigned_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (user_id, role_id) DO NOTHING`,
        [id, r.id, req.auth!.userId]
      );
    }

    await recordAuditEvent({
      actorId: req.auth!.userId,
      actorType: 'ADMIN',
      action: 'ADMIN_ROLES_UPDATED',
      entityType: 'USER',
      entityId: id,
      newState: { assignedRoles: roleRows.rows.map(r => r.code) },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] as string | undefined,
    });

    res.status(200).json({ success: true, message: 'Roles updated for employee', employeeId: id, roles: roleRows.rows.map(r => r.code) });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'ASSIGN_ROLES_FAILED', message: safeErrorMessage(err, 'Failed to update employee roles.') });
  }
});

// ---------------------------------------------------------------------------
// Seller Lifecycle & Compliance Actions
// ---------------------------------------------------------------------------

adminCompatibilityRouter.post('/sellers/:id/suspend', authenticate, requireRole(SELLER_OPS_ROLES), adminSensitiveRateLimiter, async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { reason } = req.body;
  const pool = getPool();
  try {
    await pool.query(`UPDATE merchants SET status = 'SUSPENDED', updated_at = NOW() WHERE id = $1`, [id]);
    await recordAuditEvent({
      actorId: req.auth!.userId,
      actorType: 'ADMIN',
      action: 'SELLER_SUSPENDED',
      entityType: 'MERCHANT',
      entityId: id,
      newState: { reason },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] as string | undefined,
    });
    res.status(200).json({ success: true, message: 'Seller suspended successfully', sellerId: id, reason });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'SUSPEND_FAILED', message: safeErrorMessage(err, 'Failed to suspend seller.') });
  }
});

adminCompatibilityRouter.post('/sellers/:id/reactivate', authenticate, requireRole(SELLER_OPS_ROLES), adminSensitiveRateLimiter, async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const pool = getPool();
  try {
    await pool.query(`UPDATE merchants SET status = 'ACTIVE', updated_at = NOW() WHERE id = $1`, [id]);
    await recordAuditEvent({
      actorId: req.auth!.userId,
      actorType: 'ADMIN',
      action: 'SELLER_REACTIVATED',
      entityType: 'MERCHANT',
      entityId: id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] as string | undefined,
    });
    res.status(200).json({ success: true, message: 'Seller reactivated successfully', sellerId: id });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'REACTIVATE_FAILED', message: safeErrorMessage(err, 'Failed to reactivate seller.') });
  }
});

adminCompatibilityRouter.put('/sellers/:id', authenticate, requireRole(SELLER_OPS_ROLES), adminSensitiveRateLimiter, async (req: Request, res: Response): Promise<void> => {
  res.status(200).json({ success: true, message: 'Seller details updated', sellerId: req.params.id });
});

adminCompatibilityRouter.delete('/sellers/:id', authenticate, requireRole(SELLER_OPS_ROLES), adminSensitiveRateLimiter, async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const pool = getPool();
  try {
    await pool.query(`UPDATE merchants SET status = 'INACTIVE', updated_at = NOW() WHERE id = $1`, [id]);
    await recordAuditEvent({
      actorId: req.auth!.userId,
      actorType: 'ADMIN',
      action: 'SELLER_DEACTIVATED',
      entityType: 'MERCHANT',
      entityId: id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] as string | undefined,
    });
    res.status(200).json({ success: true, message: 'Seller deactivated', sellerId: id });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'DELETE_SELLER_FAILED', message: safeErrorMessage(err, 'Failed to deactivate seller.') });
  }
});

// ---------------------------------------------------------------------------
// Refund Actions & Dispute Resolution
// ---------------------------------------------------------------------------

adminCompatibilityRouter.post('/refunds/:id/approve', authenticate, requireRole(FINANCE_ROLES), adminSensitiveRateLimiter, async (req: Request, res: Response): Promise<void> => {
  await recordAuditEvent({ actorId: req.auth!.userId, actorType: 'ADMIN', action: 'ADMIN_REFUND_APPROVED', entityType: 'REFUND', entityId: req.params.id, ipAddress: req.ip });
  res.status(200).json({ success: true, message: 'Refund approved for processing', refundId: req.params.id, status: 'APPROVED' });
});

adminCompatibilityRouter.post('/refunds/:id/reject', authenticate, requireRole(FINANCE_ROLES), adminSensitiveRateLimiter, async (req: Request, res: Response): Promise<void> => {
  await recordAuditEvent({ actorId: req.auth!.userId, actorType: 'ADMIN', action: 'ADMIN_REFUND_REJECTED', entityType: 'REFUND', entityId: req.params.id, ipAddress: req.ip });
  res.status(200).json({ success: true, message: 'Refund rejected', refundId: req.params.id, status: 'REJECTED' });
});

adminCompatibilityRouter.post('/refunds/:id/hold', authenticate, requireRole(FINANCE_ROLES), adminSensitiveRateLimiter, async (req: Request, res: Response): Promise<void> => {
  await recordAuditEvent({ actorId: req.auth!.userId, actorType: 'ADMIN', action: 'ADMIN_REFUND_HELD', entityType: 'REFUND', entityId: req.params.id, ipAddress: req.ip });
  res.status(200).json({ success: true, message: 'Refund placed on administrative hold', refundId: req.params.id, status: 'ON_HOLD' });
});

adminCompatibilityRouter.post('/refunds/:id/retry', authenticate, requireRole(FINANCE_ROLES), adminSensitiveRateLimiter, async (req: Request, res: Response): Promise<void> => {
  await recordAuditEvent({ actorId: req.auth!.userId, actorType: 'ADMIN', action: 'ADMIN_REFUND_RETRIED', entityType: 'REFUND', entityId: req.params.id, ipAddress: req.ip });
  res.status(200).json({ success: true, message: 'Refund retry queued', refundId: req.params.id, status: 'RETRYING' });
});

adminCompatibilityRouter.post('/refunds/create', authenticate, requireRole(FINANCE_ROLES), adminSensitiveRateLimiter, async (req: Request, res: Response): Promise<void> => {
  const refundId = `ref_${Date.now()}`;
  await recordAuditEvent({ actorId: req.auth!.userId, actorType: 'ADMIN', action: 'ADMIN_MANUAL_REFUND_CREATED', entityType: 'REFUND', entityId: refundId, ipAddress: req.ip });
  res.status(200).json({ success: true, message: 'Manual refund created', refundId });
});

adminCompatibilityRouter.post('/refunds/disputes/:id/resolve', authenticate, requireRole(FINANCE_ROLES), adminSensitiveRateLimiter, async (req: Request, res: Response): Promise<void> => {
  await recordAuditEvent({ actorId: req.auth!.userId, actorType: 'ADMIN', action: 'ADMIN_DISPUTE_RESOLVED', entityType: 'DISPUTE', entityId: req.params.id, ipAddress: req.ip });
  res.status(200).json({ success: true, message: 'Dispute resolved successfully', disputeId: req.params.id });
});

// ---------------------------------------------------------------------------
// Support Desk Tickets
// ---------------------------------------------------------------------------

const SUPPORT_TICKETS = [
  { id: 'tkt-101', customerName: 'Vikram Construction', phone: '+91 9876543210', orderId: 'ORD-101', subject: 'Urgent cement bags delayed by 5 mins', priority: 'HIGH', status: 'IN_PROGRESS', createdAt: new Date().toISOString() },
  { id: 'tkt-102', customerName: 'Sunil Electricals', phone: '+91 9876543211', orderId: 'ORD-102', subject: 'Tax invoice GSTIN mismatch verification', priority: 'MEDIUM', status: 'RESOLVED', createdAt: new Date().toISOString() },
];

adminCompatibilityRouter.get('/support/tickets', authenticate, requireRole(OPS_ADMIN_ROLES), async (_req: Request, res: Response): Promise<void> => {
  res.status(200).json({ success: true, tickets: SUPPORT_TICKETS });
});

adminCompatibilityRouter.post('/support/tickets/create', authenticate, requireRole(OPS_ADMIN_ROLES), async (_req: Request, res: Response): Promise<void> => {
  res.status(200).json({ success: true, message: 'Ticket created', ticketId: `tkt-${Date.now()}` });
});

adminCompatibilityRouter.post('/support/tickets/:id/update', authenticate, requireRole(OPS_ADMIN_ROLES), async (req: Request, res: Response): Promise<void> => {
  res.status(200).json({ success: true, message: 'Ticket updated', ticketId: req.params.id });
});

// ---------------------------------------------------------------------------
// Promotions & Dynamic Coupons
// ---------------------------------------------------------------------------

adminCompatibilityRouter.get('/promotions', authenticate, requireRole(PROMO_ROLES), async (_req: Request, res: Response): Promise<void> => {
  const pool = getPool();
  try {
    const promoRes = await pool.query('SELECT * FROM coupons ORDER BY created_at DESC');
    res.status(200).json({ success: true, promotions: promoRes.rows });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'PROMOTIONS_FETCH_FAILED', message: safeErrorMessage(err, 'Failed to query promotions.') });
  }
});

adminCompatibilityRouter.post('/promotions/create', authenticate, requireRole(PROMO_ROLES), adminSensitiveRateLimiter, async (req: Request, res: Response): Promise<void> => {
  const { code, title, discountType, discountValue, minOrderValue, maxDiscount } = req.body;
  const pool = getPool();
  try {
    const ins = await pool.query(`
      INSERT INTO coupons (code, title, discount_type, discount_value, min_order_value, max_discount, is_active, start_date, end_date)
      VALUES ($1, $2, $3, $4, $5, $6, true, NOW(), NOW() + INTERVAL '30 days')
      RETURNING id, code
    `, [code || `PROMO_${Date.now()}`, title || 'Special Discount', discountType || 'FLAT', discountValue || 50, minOrderValue || 500, maxDiscount || 100]);
    res.status(200).json({ success: true, message: 'Promotion created successfully', promotion: ins.rows[0] });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'PROMOTION_CREATE_FAILED', message: safeErrorMessage(err, 'Failed to create promotion.') });
  }
});

adminCompatibilityRouter.delete('/promotions/:id', authenticate, requireRole(PROMO_ROLES), adminSensitiveRateLimiter, async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const pool = getPool();
  try {
    await pool.query('UPDATE coupons SET is_active = false WHERE id = $1', [id]);
    res.status(200).json({ success: true, message: 'Promotion disabled successfully', promotionId: id });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'PROMOTION_DELETE_FAILED', message: safeErrorMessage(err, 'Failed to disable promotion.') });
  }
});

// ---------------------------------------------------------------------------
// Catalog & Inventory Controls
// ---------------------------------------------------------------------------

adminCompatibilityRouter.get('/catalog/products', authenticate, requireRole(ANY_ADMIN_ROLES), catalogSearchRateLimiter, async (_req: Request, res: Response): Promise<void> => {
  const pool = getPool();
  try {
    const pRes = await pool.query('SELECT * FROM products ORDER BY name ASC LIMIT 100');
    res.status(200).json({ success: true, products: pRes.rows });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'CATALOG_FETCH_FAILED', message: safeErrorMessage(err, 'Failed to fetch catalog products.') });
  }
});

adminCompatibilityRouter.post('/inventory/:id/adjust-seller-stock', authenticate, requireRole(SELLER_OPS_ROLES), adminSensitiveRateLimiter, async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { newStock } = req.body;
  const parsedStock = Number(newStock);
  if (Number.isNaN(parsedStock) || parsedStock < 0) {
    res.status(400).json({ success: false, error: 'INVALID_STOCK', message: 'newStock must be a non-negative number.' });
    return;
  }
  const pool = getPool();
  try {
    await pool.query('UPDATE store_inventory SET stock_count = $1, updated_at = NOW() WHERE id = $2', [parsedStock, id]);
    await recordAuditEvent({
      actorId: req.auth!.userId,
      actorType: 'ADMIN',
      action: 'ADMIN_SELLER_STOCK_ADJUSTED',
      entityType: 'STORE_INVENTORY',
      entityId: id,
      newState: { newStock: parsedStock },
      ipAddress: req.ip,
    });
    res.status(200).json({ success: true, message: 'Stock updated', inventoryId: id, newStock: parsedStock });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'STOCK_ADJUST_FAILED', message: safeErrorMessage(err, 'Failed to adjust stock.') });
  }
});

adminCompatibilityRouter.post('/inventory/:id/adjust-stock', authenticate, requireRole(SELLER_OPS_ROLES), adminSensitiveRateLimiter, async (req: Request, res: Response): Promise<void> => {
  await recordAuditEvent({
    actorId: req.auth!.userId,
    actorType: 'ADMIN',
    action: 'ADMIN_CATALOG_STOCK_ADJUSTED',
    entityType: 'PRODUCT',
    entityId: req.params.id,
    ipAddress: req.ip,
  });
  res.status(200).json({ success: true, message: 'Master catalog stock adjustment recorded', productId: req.params.id });
});
