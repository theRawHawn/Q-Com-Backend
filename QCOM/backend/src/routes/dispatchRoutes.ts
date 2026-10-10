import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { dispatchService } from '../modules/dispatch/dispatchService.js';
import { getPool } from '../database/connection.js';
import { authenticate } from '../middleware/auth.js';

export const dispatchRouter = Router();

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
 * Authorizes operations managers, dispatchers, or super admins for dispatch fleet actions.
 */
function requireDispatchManagement(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth) {
    res.status(401).json({ success: false, error: 'UNAUTHENTICATED', message: 'Authentication required.' });
    return;
  }
  const isAuthorized =
    req.auth.isSuperAdmin ||
    req.auth.roles.includes('SUPER_ADMIN') ||
    req.auth.roles.includes('OPERATIONS') ||
    req.auth.roles.includes('DISPATCHER') ||
    req.auth.permissions.includes('orders.assign_rider');

  if (!isAuthorized) {
    res.status(403).json({
      success: false,
      error: 'FORBIDDEN_ROLE',
      message: 'Access forbidden: You do not have permission to manage dispatch operations.',
    });
    return;
  }
  next();
}

/**
 * Authorizes delivery partners for their own offer operations, or dispatch admins.
 */
function requireRiderOrDispatchAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth) {
    res.status(401).json({ success: false, error: 'UNAUTHENTICATED', message: 'Authentication required.' });
    return;
  }
  const riderId = req.body?.riderId || req.auth.riderId;
  const isDispatchAdmin =
    req.auth.isSuperAdmin ||
    req.auth.roles.includes('SUPER_ADMIN') ||
    req.auth.roles.includes('OPERATIONS') ||
    req.auth.roles.includes('DISPATCHER');

  if (isDispatchAdmin) {
    return next();
  }

  // Check if caller is an authorized delivery partner acting on their own profile
  if (req.auth.riderId && riderId && req.auth.riderId === riderId) {
    return next();
  }

  res.status(403).json({
    success: false,
    error: 'RIDER_ACCESS_DENIED',
    message: 'Access forbidden: You cannot accept or reject offers for another delivery partner.',
  });
}

/**
 * Authorizes expiration: dispatch management or active delivery partners.
 */
function requireExpireAuthorized(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth) {
    res.status(401).json({ success: false, error: 'UNAUTHENTICATED', message: 'Authentication required.' });
    return;
  }
  const isDispatchAdmin =
    req.auth.isSuperAdmin ||
    req.auth.roles.includes('SUPER_ADMIN') ||
    req.auth.roles.includes('OPERATIONS') ||
    req.auth.roles.includes('DISPATCHER') ||
    req.auth.permissions.includes('orders.assign_rider');

  if (isDispatchAdmin || req.auth.roles.includes('RIDER')) {
    return next();
  }

  res.status(403).json({
    success: false,
    error: 'FORBIDDEN_ROLE',
    message: 'Access forbidden: You do not have permission to expire dispatch offers.',
  });
}

/**
 * POST /api/v1/dispatch/assign & POST /api/dispatch/assign
 */
dispatchRouter.post('/assign', authenticate, requireDispatchManagement, async (req: Request, res: Response): Promise<void> => {
  const pool = getPool();
  const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
  const cleanKey = idempotencyKey && typeof idempotencyKey === 'string' ? idempotencyKey.trim().slice(0, 120) : undefined;
  const requestId = (req as any).requestId || req.headers['x-request-id'] || 'req-dispatch-assign';

  const { orderId, offerExpirySeconds } = req.body;

  if (!orderId) {
    res.status(400).json({ success: false, error: 'MISSING_ORDER_ID', message: 'orderId is required.' });
    return;
  }

  // Idempotency check if key supplied
  if (cleanKey) {
    try {
      const existingKeyRes = await pool.query(
        `SELECT status, status_code, response_body FROM idempotency_keys WHERE idempotency_key = $1`,
        [cleanKey]
      );

      if (existingKeyRes.rows.length > 0) {
        const existing = existingKeyRes.rows[0];
        if (existing.status === 'COMPLETED') {
          const body = typeof existing.response_body === 'string'
            ? JSON.parse(existing.response_body)
            : existing.response_body;
          res.status(existing.status_code || 200).json(body);
          return;
        }
        if (existing.status === 'PROCESSING') {
          res.status(409).json({
            success: false,
            error: 'DISPATCH_IN_PROGRESS',
            message: 'A dispatch assignment for this key is currently in progress.',
            requestId,
          });
          return;
        }
      }

      await pool.query(
        `INSERT INTO idempotency_keys (idempotency_key, actor_id, endpoint, status, created_at, expires_at)
         VALUES ($1, $2, $3, 'PROCESSING', NOW(), NOW() + interval '24 hours')
         ON CONFLICT (idempotency_key) DO UPDATE SET status = 'PROCESSING'`,
        [cleanKey, req.auth!.userId, req.originalUrl]
      );
    } catch (err: any) {
      if (isDatabaseUnavailable(err)) {
        res.setHeader('Retry-After', '3');
        res.status(503).json({
          success: false,
          error: 'DATABASE_UNAVAILABLE',
          message: 'PostgreSQL database is currently unavailable.',
          retryAfterSeconds: 3,
          requestId,
        });
        return;
      }
    }
  }

  try {
    const result = await dispatchService.assignOrder({
      orderId,
      offerExpirySeconds: offerExpirySeconds ? Number(offerExpirySeconds) : undefined,
    });

    const responseBody = {
      success: true,
      message: 'Dispatch candidate selected and offer generated successfully.',
      assignment: result.assignment,
      offer: result.offer,
      selectedRider: {
        riderId: result.selectedRider.riderId,
        riderCode: result.selectedRider.riderCode,
        name: result.selectedRider.name,
        vehicleType: result.selectedRider.vehicleType,
        rating: result.selectedRider.rating,
        etaToStoreMinutes: result.selectedRider.etaToStoreMinutes,
        distanceToStoreMeters: result.selectedRider.distanceToStoreMeters,
        payoutAmountInr: result.selectedRider.payoutAmountInr,
        score: result.selectedRider.score,
      },
      candidateCount: result.candidateCount,
    };

    if (cleanKey) {
      await pool.query(
        `UPDATE idempotency_keys SET status = 'COMPLETED', status_code = 200, response_body = $1 WHERE idempotency_key = $2`,
        [JSON.stringify(responseBody), cleanKey]
      );
    }

    res.status(200).json(responseBody);
  } catch (err: any) {
    if (cleanKey) {
      await pool.query(`UPDATE idempotency_keys SET status = 'FAILED' WHERE idempotency_key = $1`, [cleanKey]).catch(() => {});
    }

    if (isDatabaseUnavailable(err)) {
      res.setHeader('Retry-After', '3');
      res.status(503).json({
        success: false,
        error: 'DATABASE_UNAVAILABLE',
        message: 'PostgreSQL database is currently unavailable.',
        retryAfterSeconds: 3,
        requestId,
      });
      return;
    }

    const isConflict = err.message.includes('ORDER_ALREADY_ASSIGNED') || err.message.includes('RIDER_UNAVAILABLE');
    const isNotFound = err.message.includes('ORDER_NOT_FOUND') || err.message.includes('NO_ELIGIBLE_RIDERS');

    res.status(isConflict ? 409 : isNotFound ? 404 : 400).json({
      success: false,
      error: 'DISPATCH_ASSIGN_FAILED',
      message: err.message || 'Failed to dispatch order.',
    });
  }
});

/**
 * GET /api/v1/dispatch/orders/:orderId
 */
dispatchRouter.get('/orders/:orderId', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { orderId } = req.params;
    const assignment = await dispatchService.getAssignmentByOrderId(orderId);

    if (!assignment) {
      res.status(404).json({ success: false, error: 'ASSIGNMENT_NOT_FOUND', message: `No dispatch assignment found for order '${orderId}'.` });
      return;
    }

    res.status(200).json({ success: true, assignment });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'FETCH_FAILED', message: err.message });
  }
});

/**
 * GET /api/v1/dispatch/assignments/:assignmentId
 */
dispatchRouter.get('/assignments/:assignmentId', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { assignmentId } = req.params;
    const assignment = await dispatchService.getAssignmentById(assignmentId);

    if (!assignment) {
      res.status(404).json({ success: false, error: 'ASSIGNMENT_NOT_FOUND', message: `Assignment '${assignmentId}' not found.` });
      return;
    }

    res.status(200).json({ success: true, assignment });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'FETCH_FAILED', message: err.message });
  }
});

/**
 * POST /api/v1/dispatch/offers/:offerId/accept
 */
dispatchRouter.post('/offers/:offerId/accept', authenticate, requireRiderOrDispatchAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    const { offerId } = req.params;
    const riderId = req.body?.riderId || req.auth?.riderId;

    if (!riderId) {
      res.status(400).json({ success: false, error: 'MISSING_RIDER_ID', message: 'riderId is required.' });
      return;
    }

    const result = await dispatchService.acceptOffer(offerId, riderId);
    res.status(200).json({
      success: true,
      message: 'Rider offer accepted successfully.',
      assignment: result.assignment,
      offer: result.offer,
      tripId: result.tripId,
    });
  } catch (err: any) {
    if (isDatabaseUnavailable(err)) {
      res.setHeader('Retry-After', '3');
      res.status(503).json({ success: false, error: 'DATABASE_UNAVAILABLE', message: 'PostgreSQL database unavailable.' });
      return;
    }
    const isCancelled = err.message.includes('ASSIGNMENT_CANCELLED') || err.message.includes('OFFER_CANCELLED');
    const isExpired = err.message.includes('OFFER_EXPIRED');
    const isNotFound = err.message.includes('OFFER_NOT_FOUND') || err.message.includes('ASSIGNMENT_NOT_FOUND');
    const isUnauthorized = err.message.includes('UNAUTHORIZED_RIDER');
    const isConflict = isCancelled || err.message.includes('ASSIGNMENT_MISMATCH') || err.message.includes('OFFER_INVALID_STATE');

    res.status(isCancelled ? 409 : isExpired ? 410 : isNotFound ? 404 : isUnauthorized ? 403 : isConflict ? 409 : 400).json({
      success: false,
      error: isCancelled ? 'ASSIGNMENT_CANCELLED' : isExpired ? 'OFFER_EXPIRED' : isNotFound ? 'OFFER_NOT_FOUND' : isUnauthorized ? 'UNAUTHORIZED_RIDER' : 'ACCEPT_FAILED',
      message: err.message || 'Failed to accept offer.',
    });
  }
});

/**
 * POST /api/v1/dispatch/offers/:offerId/reject
 */
dispatchRouter.post('/offers/:offerId/reject', authenticate, requireRiderOrDispatchAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    const { offerId } = req.params;
    const { reason } = req.body;
    const riderId = req.body?.riderId || req.auth?.riderId;

    if (!riderId) {
      res.status(400).json({ success: false, error: 'MISSING_RIDER_ID', message: 'riderId is required.' });
      return;
    }

    const result = await dispatchService.rejectOffer(offerId, riderId, reason);
    res.status(200).json({
      success: true,
      message: 'Rider offer rejected.',
      offer: result.offer,
      assignment: result.assignment,
    });
  } catch (err: any) {
    if (isDatabaseUnavailable(err)) {
      res.setHeader('Retry-After', '3');
      res.status(503).json({ success: false, error: 'DATABASE_UNAVAILABLE', message: 'PostgreSQL database unavailable.' });
      return;
    }
    const isNotFound = err.message.includes('OFFER_NOT_FOUND');
    const isUnauthorized = err.message.includes('UNAUTHORIZED_RIDER');
    res.status(isNotFound ? 404 : isUnauthorized ? 403 : 400).json({
      success: false,
      error: isNotFound ? 'OFFER_NOT_FOUND' : isUnauthorized ? 'UNAUTHORIZED_RIDER' : 'REJECT_FAILED',
      message: err.message || 'Failed to reject offer.',
    });
  }
});

/**
 * POST /api/v1/dispatch/offers/:offerId/expire
 */
dispatchRouter.post('/offers/:offerId/expire', authenticate, requireExpireAuthorized, async (req: Request, res: Response): Promise<void> => {
  try {
    const { offerId } = req.params;
    await dispatchService.expireOffer(offerId);
    res.status(200).json({ success: true, message: 'Offer expired successfully.' });
  } catch (err: any) {
    res.status(400).json({ success: false, error: 'EXPIRE_FAILED', message: err.message });
  }
});

/**
 * POST /api/v1/dispatch/assignments/:assignmentId/rematch
 */
dispatchRouter.post('/assignments/:assignmentId/rematch', authenticate, requireDispatchManagement, async (req: Request, res: Response): Promise<void> => {
  try {
    const { assignmentId } = req.params;
    const result = await dispatchService.rematchOrder(assignmentId);
    res.status(200).json({
      success: true,
      message: 'Order rematching completed successfully.',
      oldAssignmentId: result.oldAssignmentId,
      newAssignment: result.newAssignment,
      newOffer: result.newOffer,
    });
  } catch (err: any) {
    if (isDatabaseUnavailable(err)) {
      res.setHeader('Retry-After', '3');
      res.status(503).json({ success: false, error: 'DATABASE_UNAVAILABLE', message: 'PostgreSQL database unavailable.' });
      return;
    }
    const isInvalidState = err.message.includes('INVALID_REMATCH_STATE');
    const isNotFound = err.message.includes('ASSIGNMENT_NOT_FOUND');
    res.status(isNotFound ? 404 : isInvalidState ? 409 : 400).json({
      success: false,
      error: isInvalidState ? 'INVALID_REMATCH_STATE' : isNotFound ? 'ASSIGNMENT_NOT_FOUND' : 'REMATCH_FAILED',
      message: err.message || 'Failed to rematch assignment.',
    });
  }
});
