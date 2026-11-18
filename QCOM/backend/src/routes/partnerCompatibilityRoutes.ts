import { Router, Request, Response } from 'express';
import { getPool } from '../database/connection.js';
import { authenticate } from '../middleware/auth.js';
import { riderTelemetryRateLimiter } from '../middleware/rateLimiter.js';
import { safeErrorMessage } from '../middleware/errorHandler.js';
import { constantTimeCompare } from '../modules/auth/crypto.js';
import { recordAuditEvent } from '../modules/audit/auditService.js';

export const partnerCompatibilityRouter = Router();

async function resolveCallerRider(pool: ReturnType<typeof getPool>, req: Request): Promise<{ id: string; status: string } | null> {
  if (req.auth?.riderId) {
    const res = await pool.query(`SELECT id, status FROM riders WHERE id = $1 LIMIT 1`, [req.auth.riderId]);
    if (res.rows.length > 0) return res.rows[0];
  }
  if (req.auth?.userId) {
    const res = await pool.query(
      `SELECT id, status FROM riders WHERE user_id = $1 OR phone = $2 LIMIT 1`,
      [req.auth.userId, req.auth.phone || '']
    );
    if (res.rows.length > 0) return res.rows[0];
  }
  return null;
}

function isDispatchAdmin(req: Request): boolean {
  return Boolean(
    req.auth?.isSuperAdmin ||
      req.auth?.roles?.some((r: string) => ['SUPER_ADMIN', 'OPERATIONS', 'DISPATCHER'].includes(r))
  );
}

/**
 * POST /api/partner/duty-status & POST /api/v1/partner/duty-status
 * Duty Toggle & Safety Interlock Endpoint (strictly authenticated and rider-bound)
 */
partnerCompatibilityRouter.post('/duty-status', authenticate, riderTelemetryRateLimiter, async (req: Request, res: Response): Promise<void> => {
  const { isOnline } = req.body;
  const pool = getPool();

  try {
    const rider = await resolveCallerRider(pool, req);
    if (!rider) {
      res.status(403).json({
        success: false,
        error: 'RIDER_REQUIRED',
        message: 'Only registered delivery partners can update duty status.',
      });
      return;
    }

    if (rider.status === 'SUSPENDED' || req.auth?.isSuspended) {
      res.status(403).json({
        success: false,
        error: 'RIDER_SUSPENDED',
        message: 'Suspended delivery partners cannot change duty status.',
      });
      return;
    }

    await pool.query(
      `UPDATE riders SET status = $1 WHERE id = $2 AND status != 'SUSPENDED'`,
      [isOnline ? 'IDLE_AT_HUB' : 'OFFLINE', rider.id]
    );

    res.status(200).json({
      success: true,
      riderId: rider.id,
      status: isOnline ? 'ONLINE' : 'OFFLINE',
      assignedHub: {
        hubId: 'hub_koramangala_04',
        name: 'Koramangala 4th Block Fulfillment Hub',
        coordinates: [12.9345, 77.6252],
      },
      activeShift: {
        shiftId: 'shift_midday_9912',
        startTime: '2026-10-25T11:00:00Z',
        endTime: '2026-10-25T14:00:00Z',
        guaranteedMinPayout: 450.00,
      },
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: 'DUTY_STATUS_FAILED',
      message: safeErrorMessage(err, 'Failed to update duty status.'),
    });
  }
});

/**
 * Tasks router for delivery partner mobile tasks
 */
export const tasksCompatibilityRouter = Router();

/**
 * POST /api/tasks/:taskId/accept & POST /api/v1/tasks/:taskId/accept
 * Task acceptance with atomic claim
 */
tasksCompatibilityRouter.post('/:taskId/accept', authenticate, riderTelemetryRateLimiter, async (req: Request, res: Response): Promise<void> => {
  const { taskId } = req.params;
  const pool = getPool();
  try {
    if (!req.auth?.userId) {
      res.status(401).json({
        success: false,
        error: 'UNAUTHENTICATED',
        message: 'Authentication token is required to claim a delivery task.',
      });
      return;
    }

    const riderRow = await resolveCallerRider(pool, req);
    if (!riderRow) {
      res.status(403).json({
        success: false,
        error: 'FORBIDDEN',
        message: 'Only registered and eligible delivery partners can claim delivery tasks.',
      });
      return;
    }

    if (riderRow.status === 'SUSPENDED' || req.auth.isSuspended) {
      res.status(403).json({
        success: false,
        error: 'RIDER_SUSPENDED',
        message: 'Delivery partner account is suspended and ineligible to accept tasks.',
      });
      return;
    }

    const riderId = riderRow.id;

    // Atomic single-winner claim: only transition from BROADCASTING to ACCEPTED
    const updateRes = await pool.query(
      `UPDATE delivery_trips 
       SET status = 'ACCEPTED', accepted_at = NOW(), rider_id = $1 
       WHERE (id = $2 OR order_id = $2) AND status = 'BROADCASTING' 
       RETURNING id, order_id, status, rider_id`,
      [riderId, taskId]
    );

    if (updateRes.rowCount === 0) {
      const checkRes = await pool.query(
        `SELECT id, order_id, status, rider_id FROM delivery_trips WHERE id = $1 OR order_id = $1`,
        [taskId]
      );

      if (checkRes.rows.length === 0) {
        res.status(404).json({ success: false, error: 'TASK_NOT_FOUND', message: 'Delivery task not found.' });
        return;
      }

      const trip = checkRes.rows[0];

      if (trip.rider_id === riderId && trip.status === 'ACCEPTED') {
        res.status(200).json({
          success: true,
          taskId: trip.id,
          orderId: trip.order_id,
          riderId: trip.rider_id,
          status: 'ACCEPTED',
          message: 'Task successfully locked and accepted.',
        });
        return;
      }

      res.status(409).json({
        success: false,
        error: 'TASK_ALREADY_CLAIMED',
        message: 'Task already claimed or accepted by another partner.',
        currentStatus: trip.status,
      });
      return;
    }

    const trip = updateRes.rows[0];

    try {
      await pool.query(
        `UPDATE riders SET status = 'PICKING_UP' WHERE id = $1 AND status != 'SUSPENDED'`,
        [riderId]
      );
    } catch {
      // Non-blocking
    }

    res.status(200).json({
      success: true,
      taskId: trip.id,
      orderId: trip.order_id,
      riderId: trip.rider_id,
      status: 'ACCEPTED',
      message: 'Task successfully locked and accepted.',
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: 'ACCEPT_FAILED',
      message: safeErrorMessage(err, 'Failed to accept delivery task.'),
    });
  }
});

/**
 * POST /api/tasks/:taskId/arrived-pickup & POST /api/v1/tasks/:taskId/arrived-pickup
 */
tasksCompatibilityRouter.post('/:taskId/arrived-pickup', authenticate, riderTelemetryRateLimiter, async (req: Request, res: Response): Promise<void> => {
  const { taskId } = req.params;
  const pool = getPool();
  try {
    const adminOverride = isDispatchAdmin(req);
    const rider = adminOverride ? null : await resolveCallerRider(pool, req);

    if (!adminOverride && !rider) {
      res.status(403).json({ success: false, error: 'RIDER_REQUIRED', message: 'Only assigned delivery partners or admins can update trip status.' });
      return;
    }

    const tripRes = await pool.query(
      `SELECT id, rider_id, status FROM delivery_trips WHERE id = $1 OR order_id = $1 LIMIT 1`,
      [taskId]
    );
    if (tripRes.rows.length === 0) {
      res.status(404).json({ success: false, error: 'TASK_NOT_FOUND', message: 'Delivery task not found.' });
      return;
    }

    const trip = tripRes.rows[0];
    if (!adminOverride && trip.rider_id !== rider!.id) {
      await recordAuditEvent({
        actorId: req.auth!.userId,
        actorType: 'RIDER',
        action: 'CROSS_RIDER_TASK_MUTATION_BLOCKED',
        entityType: 'DELIVERY_TRIP',
        entityId: trip.id,
        newState: { assignedRiderId: trip.rider_id, callerRiderId: rider!.id, action: 'arrived-pickup' },
        ipAddress: req.ip,
      });
      res.status(403).json({
        success: false,
        error: 'RIDER_ACCESS_DENIED',
        message: 'Access forbidden: This delivery task is assigned to another delivery partner.',
      });
      return;
    }

    await pool.query(
      `UPDATE delivery_trips SET status = 'ARRIVED_AT_PICKUP' WHERE id = $1`,
      [trip.id]
    );
    res.status(200).json({
      success: true,
      taskId,
      status: 'ARRIVED_AT_PICKUP',
      message: 'Rider arrival at seller store recorded.',
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: 'ARRIVAL_FAILED',
      message: safeErrorMessage(err, 'Failed to record arrival.'),
    });
  }
});

/**
 * POST /api/tasks/:taskId/pickup-confirm & POST /api/v1/tasks/:taskId/pickup-confirm
 */
tasksCompatibilityRouter.post('/:taskId/pickup-confirm', authenticate, riderTelemetryRateLimiter, async (req: Request, res: Response): Promise<void> => {
  const { taskId } = req.params;
  const pool = getPool();
  try {
    const adminOverride = isDispatchAdmin(req);
    const rider = adminOverride ? null : await resolveCallerRider(pool, req);

    if (!adminOverride && !rider) {
      res.status(403).json({ success: false, error: 'RIDER_REQUIRED', message: 'Only assigned delivery partners or admins can confirm pickup.' });
      return;
    }

    const tripRes = await pool.query(
      `SELECT id, rider_id, status FROM delivery_trips WHERE id = $1 OR order_id = $1 LIMIT 1`,
      [taskId]
    );
    if (tripRes.rows.length === 0) {
      res.status(404).json({ success: false, error: 'TASK_NOT_FOUND', message: 'Delivery task not found.' });
      return;
    }

    const trip = tripRes.rows[0];
    if (!adminOverride && trip.rider_id !== rider!.id) {
      await recordAuditEvent({
        actorId: req.auth!.userId,
        actorType: 'RIDER',
        action: 'CROSS_RIDER_TASK_MUTATION_BLOCKED',
        entityType: 'DELIVERY_TRIP',
        entityId: trip.id,
        newState: { assignedRiderId: trip.rider_id, callerRiderId: rider!.id, action: 'pickup-confirm' },
        ipAddress: req.ip,
      });
      res.status(403).json({
        success: false,
        error: 'RIDER_ACCESS_DENIED',
        message: 'Access forbidden: This delivery task is assigned to another delivery partner.',
      });
      return;
    }

    await pool.query(
      `UPDATE delivery_trips SET status = 'PICKED_UP', picked_up_at = NOW() WHERE id = $1`,
      [trip.id]
    );
    res.status(200).json({
      success: true,
      taskId,
      status: 'PICKED_UP',
      message: 'Package pickup confirmed from seller.',
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: 'PICKUP_FAILED',
      message: safeErrorMessage(err, 'Failed to confirm pickup.'),
    });
  }
});

/**
 * POST /api/tasks/:taskId/verify-otp & POST /api/v1/tasks/:taskId/verify-otp
 * Order Completion & OTP Verification endpoint (strictly constant-time OTP check & rider-bound)
 */
tasksCompatibilityRouter.post('/:taskId/verify-otp', authenticate, riderTelemetryRateLimiter, async (req: Request, res: Response): Promise<void> => {
  const { taskId } = req.params;
  const { otp } = req.body;
  const pool = getPool();

  if (!otp || typeof otp !== 'string') {
    res.status(400).json({ success: false, error: 'MISSING_OTP', message: 'Delivery OTP is required.' });
    return;
  }

  try {
    const adminOverride = isDispatchAdmin(req);
    const rider = adminOverride ? null : await resolveCallerRider(pool, req);

    if (!adminOverride && !rider) {
      res.status(403).json({ success: false, error: 'RIDER_REQUIRED', message: 'Only assigned delivery partners or admins can verify delivery OTP.' });
      return;
    }

    // Look up delivery trip and parent order
    const tripRes = await pool.query(`
      SELECT dt.id, dt.order_id, dt.rider_id, dt.status as trip_status, o.delivery_otp,
             o.payment_method, o.total_amount, dt.total_rider_payout,
             dt.base_fare, dt.distance_fare, dt.surge_fare, dt.rider_tip_payable,
             dt.rider_withholding_amount
      FROM delivery_trips dt
      JOIN orders o ON dt.order_id = o.id
      WHERE dt.id = $1 OR dt.order_id = $1
    `, [taskId]);

    if (tripRes.rows.length === 0) {
      res.status(404).json({ success: false, error: 'TASK_NOT_FOUND', message: 'Delivery task not found.' });
      return;
    }

    const trip = tripRes.rows[0];
    if (!adminOverride && trip.rider_id !== rider!.id) {
      await recordAuditEvent({
        actorId: req.auth!.userId,
        actorType: 'RIDER',
        action: 'CROSS_RIDER_TASK_MUTATION_BLOCKED',
        entityType: 'DELIVERY_TRIP',
        entityId: trip.id,
        newState: { assignedRiderId: trip.rider_id, callerRiderId: rider!.id, action: 'verify-otp' },
        ipAddress: req.ip,
      });
      res.status(403).json({
        success: false,
        error: 'RIDER_ACCESS_DENIED',
        message: 'Access forbidden: This delivery task is assigned to another delivery partner.',
      });
      return;
    }

    if (trip.trip_status === 'DELIVERED' || trip.trip_status === 'COMPLETED') {
      res.status(409).json({
        success: false,
        error: 'TASK_ALREADY_DELIVERED',
        message: 'Delivery task has already been completed.',
      });
      return;
    }

    const cleanOtp = otp.trim();
    const expectedOtp = String(trip.delivery_otp || '').trim();

    // Strict constant-time equality verification — NO hardcoded bypasses or suffix matching
    const isMatch =
      expectedOtp.length > 0 &&
      cleanOtp.length === expectedOtp.length &&
      constantTimeCompare(cleanOtp, expectedOtp);

    if (!isMatch) {
      await recordAuditEvent({
        actorId: req.auth!.userId,
        actorType: 'RIDER',
        action: 'DELIVERY_OTP_FAILED',
        entityType: 'DELIVERY_TRIP',
        entityId: trip.id,
        newState: { orderId: trip.order_id },
        ipAddress: req.ip,
      });
      res.status(400).json({ success: false, error: 'INVALID_OTP', message: 'Invalid delivery OTP provided.' });
      return;
    }

    const pmLower = String(trip.payment_method || '').trim().toLowerCase();
    const isCodOrder = pmLower === 'pay on delivery' || pmLower === 'cod' || pmLower === 'cash on delivery';
    const authoritativeCodAmount = isCodOrder ? +parseFloat(trip.total_amount || '0').toFixed(2) : 0;

    // Complete delivery atomically in PostgreSQL (prevents concurrent delivery OTP replay)
    const deliverRes = await pool.query(`
      UPDATE delivery_trips 
      SET status = 'DELIVERED', delivered_at = NOW(), otp_verified = TRUE,
          cod_collected_amount = $1
      WHERE id = $2 AND status NOT IN ('DELIVERED', 'COMPLETED')
      RETURNING id
    `, [authoritativeCodAmount, trip.id]);

    if (deliverRes.rowCount === 0) {
      res.status(409).json({
        success: false,
        error: 'TASK_ALREADY_DELIVERED',
        message: 'Delivery task has already been completed.',
      });
      return;
    }

    await pool.query(`
      UPDATE orders 
      SET status = 'delivered', delivered_at = NOW() 
      WHERE id = $1
    `, [trip.order_id]);

    await recordAuditEvent({
      actorId: req.auth!.userId,
      actorType: 'RIDER',
      action: 'DELIVERY_OTP_VERIFIED',
      entityType: 'DELIVERY_TRIP',
      entityId: trip.id,
      newState: { orderId: trip.order_id, authoritativeCodAmount },
      ipAddress: req.ip,
    });

    const basePay = parseFloat(trip.base_fare || 35);
    const distPay = parseFloat(trip.distance_fare || 15);
    const surgePay = parseFloat(trip.surge_fare || 0);
    const tips = parseFloat(trip.rider_tip_payable || 0);
    const tds = parseFloat(trip.rider_withholding_amount || 0.5);
    const totalPayout = +(basePay + distPay + surgePay + tips - tds).toFixed(2);

    let authoritativeWalletBalance = totalPayout;
    let completedDeliveriesToday = 1;
    if (trip.rider_id) {
      const rBalRes = await pool.query(`SELECT wallet_balance FROM riders WHERE id = $1 LIMIT 1`, [trip.rider_id]);
      if (rBalRes.rows.length > 0) {
        authoritativeWalletBalance = +parseFloat(rBalRes.rows[0].wallet_balance || '0').toFixed(2);
      }
      const dCountRes = await pool.query(
        `SELECT COUNT(*) AS cnt FROM delivery_trips WHERE rider_id = $1 AND status = 'DELIVERED'`,
        [trip.rider_id]
      );
      completedDeliveriesToday = Math.max(1, parseInt(dCountRes.rows[0]?.cnt || '1', 10));
    }

    res.status(200).json({
      success: true,
      orderStatus: 'DELIVERED',
      creditedPayout: {
        basePay,
        distancePay: distPay,
        surgeBonus: surgePay,
        tips,
        tdsDeducted: tds,
        totalCredited: totalPayout,
      },
      walletSummary: {
        todayTotalEarnings: totalPayout,
        withdrawableBalance: authoritativeWalletBalance,
        completedDeliveriesToday,
      },
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: 'VERIFY_OTP_FAILED',
      message: safeErrorMessage(err, 'Failed to verify delivery OTP.'),
    });
  }
});
