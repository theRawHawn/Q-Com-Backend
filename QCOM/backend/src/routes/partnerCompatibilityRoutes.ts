import { Router, Request, Response } from 'express';
import { getPool, transaction } from '../database/connection.js';
import { authenticate } from '../middleware/auth.js';
import { riderTelemetryRateLimiter } from '../middleware/rateLimiter.js';
import { safeErrorMessage } from '../middleware/errorHandler.js';
import {
  deliveryCompletionService,
  DeliveryTaskError,
} from '../modules/delivery/deliveryCompletionService.js';
import { liveLocationService } from '../modules/realtime/liveLocationService.js';

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
 * Duty Toggle & Safety Interlock Endpoint (transactional active-delivery offline guard + optional GPS update)
 */
partnerCompatibilityRouter.post('/duty-status', authenticate, riderTelemetryRateLimiter, async (req: Request, res: Response): Promise<void> => {
  const { isOnline, latitude, longitude } = req.body;
  const pool = getPool();

  if (typeof isOnline !== 'boolean') {
    res.status(400).json({
      success: false,
      error: 'INVALID_DUTY_STATUS',
      message: 'isOnline boolean field is required.',
    });
    return;
  }

  const hasLat = latitude !== undefined && latitude !== null;
  const hasLng = longitude !== undefined && longitude !== null;
  let validCoords: { lat: number; lng: number } | null = null;
  if (hasLat || hasLng) {
    const lat = Number(latitude);
    const lng = Number(longitude);
    const valid =
      hasLat &&
      hasLng &&
      Number.isFinite(lat) &&
      Number.isFinite(lng) &&
      lat >= -90 &&
      lat <= 90 &&
      lng >= -180 &&
      lng <= 180 &&
      !(lat === 0 && lng === 0);
    if (!valid) {
      res.status(400).json({
        success: false,
        error: 'INVALID_COORDINATES',
        message: 'Provided GPS latitude/longitude coordinates are invalid.',
      });
      return;
    }
    validCoords = { lat, lng };
  }

  try {
    const callerRider = await resolveCallerRider(pool, req);
    if (!callerRider) {
      res.status(403).json({
        success: false,
        error: 'RIDER_REQUIRED',
        message: 'Only registered delivery partners can update duty status.',
      });
      return;
    }

    const txResult = await transaction(async (client) => {
      const riderRes = await client.query(
        `SELECT id, status FROM riders WHERE id = $1 FOR UPDATE`,
        [callerRider.id]
      );
      if (riderRes.rows.length === 0) {
        throw new DeliveryTaskError(403, 'RIDER_REQUIRED', 'Only registered delivery partners can update duty status.');
      }

      const rider = riderRes.rows[0];
      if (rider.status === 'SUSPENDED' || req.auth?.isSuspended) {
        throw new DeliveryTaskError(403, 'RIDER_SUSPENDED', 'Suspended delivery partners cannot change duty status.');
      }

      if (!isOnline) {
        // Block going OFFLINE whenever rider holds an active trip or accepted assignment
        const activeTrips = await client.query(
          `SELECT id, status FROM delivery_trips
           WHERE rider_id = $1 AND status IN ('ACCEPTED', 'ARRIVED_AT_PICKUP', 'PICKED_UP', 'ARRIVED_AT_DROP')
           LIMIT 1
           FOR UPDATE`,
          [rider.id]
        );
        if (activeTrips.rows.length > 0) {
          throw new DeliveryTaskError(
            409,
            'ACTIVE_DELIVERY_CANNOT_GO_OFFLINE',
            'Cannot go offline while assigned to an active delivery trip.',
            { activeTripId: activeTrips.rows[0].id, tripStatus: activeTrips.rows[0].status }
          );
        }

        const activeAssignments = await client.query(
          `SELECT id, status FROM dispatch_assignments
           WHERE rider_id = $1 AND status IN ('ACCEPTED')
           LIMIT 1
           FOR UPDATE`,
          [rider.id]
        );
        if (activeAssignments.rows.length > 0) {
          throw new DeliveryTaskError(
            409,
            'ACTIVE_DELIVERY_CANNOT_GO_OFFLINE',
            'Cannot go offline while assigned to an active dispatch assignment.',
            { assignmentId: activeAssignments.rows[0].id }
          );
        }

        // Safely expire/cancel any unaccepted pending OFFERED assignments/offers held by this rider
        await client.query(
          `UPDATE dispatch_offers SET status = 'CANCELLED', updated_at = NOW() WHERE rider_id = $1 AND status = 'OFFERED'`,
          [rider.id]
        );
        await client.query(
          `UPDATE dispatch_assignments SET status = 'CANCELLED', updated_at = NOW() WHERE rider_id = $1 AND status = 'OFFERED'`,
          [rider.id]
        );
      }

      const targetStatus = isOnline ? 'IDLE_AT_HUB' : 'OFFLINE';
      if (validCoords) {
        await client.query(
          `UPDATE riders
           SET status = $1,
               latitude = $2,
               longitude = $3,
               location_updated_at = NOW(),
               updated_at = NOW()
           WHERE id = $4 AND status != 'SUSPENDED'`,
          [targetStatus, validCoords.lat, validCoords.lng, rider.id]
        );
      } else {
        await client.query(
          `UPDATE riders
           SET status = $1,
               updated_at = NOW()
           WHERE id = $2 AND status != 'SUSPENDED'`,
          [targetStatus, rider.id]
        );
      }

      return { riderId: rider.id, status: targetStatus };
    });

    if (!isOnline) {
      await liveLocationService.clearRiderLocation(txResult.riderId).catch(() => {});
    }

    res.status(200).json({
      success: true,
      riderId: txResult.riderId,
      status: isOnline ? 'ONLINE' : 'OFFLINE',
      persistedStatus: txResult.status,
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
    if (err instanceof DeliveryTaskError) {
      res.status(err.statusCode).json({
        success: false,
        error: err.errorCode,
        message: err.message.replace(`${err.errorCode}: `, ''),
        ...(err.details || {}),
      });
      return;
    }
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
 * Task acceptance with atomic claim + rider lock coordination
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

    const accepted = await deliveryCompletionService.acceptTask({
      taskId,
      riderId: riderRow.id,
    });

    res.status(200).json({
      success: true,
      taskId: accepted.taskId,
      orderId: accepted.orderId,
      riderId: accepted.riderId,
      status: 'ACCEPTED',
      message: 'Task successfully locked and accepted.',
    });
  } catch (err: any) {
    if (err instanceof DeliveryTaskError) {
      res.status(err.statusCode).json({
        success: false,
        error: err.errorCode,
        message: err.message.replace(`${err.errorCode}: `, ''),
        ...(err.details || {}),
      });
      return;
    }
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

    const out = await deliveryCompletionService.arrivedAtPickup({
      taskId,
      actor: {
        riderId: rider?.id,
        isDispatchAdmin: adminOverride,
        actorUserId: req.auth!.userId,
        ipAddress: req.ip,
      },
    });

    res.status(200).json({
      success: true,
      taskId: out.taskId,
      status: out.status,
      message: 'Rider arrival at seller store recorded.',
    });
  } catch (err: any) {
    if (err instanceof DeliveryTaskError) {
      res.status(err.statusCode).json({
        success: false,
        error: err.errorCode,
        message: err.message.replace(`${err.errorCode}: `, ''),
        ...(err.details || {}),
      });
      return;
    }
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

    const out = await deliveryCompletionService.confirmPickup({
      taskId,
      actor: {
        riderId: rider?.id,
        isDispatchAdmin: adminOverride,
        actorUserId: req.auth!.userId,
        ipAddress: req.ip,
      },
    });

    res.status(200).json({
      success: true,
      taskId: out.taskId,
      status: out.status,
      message: 'Package pickup confirmed from seller.',
    });
  } catch (err: any) {
    if (err instanceof DeliveryTaskError) {
      res.status(err.statusCode).json({
        success: false,
        error: err.errorCode,
        message: err.message.replace(`${err.errorCode}: `, ''),
        ...(err.details || {}),
      });
      return;
    }
    res.status(500).json({
      success: false,
      error: 'PICKUP_FAILED',
      message: safeErrorMessage(err, 'Failed to confirm pickup.'),
    });
  }
});

/**
 * POST /api/tasks/:taskId/verify-otp & POST /api/v1/tasks/:taskId/verify-otp
 * Authoritative Transactional Order Completion & OTP Verification
 */
tasksCompatibilityRouter.post('/:taskId/verify-otp', authenticate, riderTelemetryRateLimiter, async (req: Request, res: Response): Promise<void> => {
  const { taskId } = req.params;
  const { otp, cashCollected } = req.body;
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

    const completed = await deliveryCompletionService.completeDeliveryWithOtp({
      taskId,
      otp,
      cashCollected,
      actor: {
        riderId: rider?.id,
        isDispatchAdmin: adminOverride,
        actorUserId: req.auth!.userId,
        ipAddress: req.ip,
      },
    });

    res.status(200).json({
      success: true,
      orderStatus: completed.orderStatus,
      codCollectedAmount: completed.codCollectedAmount,
      riderStatus: completed.riderStatus,
      allocationId: completed.allocationId,
      journalBatchId: completed.journalBatchId,
      creditedPayout: completed.creditedPayout,
      walletSummary: completed.walletSummary,
    });
  } catch (err: any) {
    if (err instanceof DeliveryTaskError) {
      res.status(err.statusCode).json({
        success: false,
        error: err.errorCode,
        message: err.message.replace(`${err.errorCode}: `, ''),
        ...(err.details || {}),
      });
      return;
    }
    res.status(500).json({
      success: false,
      error: 'VERIFY_OTP_FAILED',
      message: safeErrorMessage(err, 'Failed to verify delivery OTP.'),
    });
  }
});
