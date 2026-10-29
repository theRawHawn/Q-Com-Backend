import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { paymentService } from '../modules/payments/paymentService.js';
import { paymentProviderRegistry } from '../modules/payments/paymentProvider.js';
import { authenticate } from '../middleware/auth.js';
import { getPool } from '../database/connection.js';
import { paymentInitiationRateLimiter, paymentWebhookRateLimiter } from '../middleware/rateLimiter.js';

export const paymentRouter = Router();

/**
 * Common webhook request handler
 */
export async function handleWebhookRequest(req: Request, res: Response): Promise<void> {
  const signature = (
    req.headers['x-razorpay-signature'] ||
    req.headers['x-webhook-signature'] ||
    req.headers['x-signature'] ||
    req.headers['x-provider-signature'] ||
    req.headers['signature']
  ) as string | undefined;

  if (!signature) {
    res.status(400).json({
      success: false,
      error: 'MISSING_WEBHOOK_SIGNATURE',
      message: 'Webhook signature header (x-webhook-signature, x-signature, or provider header) is required.',
    });
    return;
  }

  // Raw body preserved by express.json verify hook
  const rawBody = (req as any).rawBody || Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));

  try {
    const gateway = (req.params.providerId || req.query.provider || (req.path.includes('razorpay') || req.headers['x-razorpay-signature'] ? 'razorpay' : 'mock')) as string;
    const result = await paymentService.processWebhook({
      rawBody,
      signature,
      gateway,
      headers: req.headers,
    });

    res.status(200).json({
      ...result,
      message: result.duplicate ? 'Webhook event already processed (idempotent duplicate).' : 'Webhook event processed successfully.',
    });
  } catch (err: any) {
    if (paymentService.isDatabaseUnavailable(err)) {
      res.setHeader('Retry-After', '3');
      res.status(503).json({
        success: false,
        error: 'DATABASE_UNAVAILABLE',
        message: 'Database is temporarily unavailable during webhook processing. Please retry.',
        retryAfterSeconds: 3,
      });
      return;
    }

    const msg = (err.message || '').toLowerCase();
    if (msg.includes('invalid_webhook_signature') || msg.includes('signature verification failed')) {
      res.status(400).json({
        success: false,
        error: 'INVALID_WEBHOOK_SIGNATURE',
        message: 'Webhook cryptographic signature verification failed.',
      });
      return;
    }

    if (msg.includes('invalid_webhook_payload') || msg.includes('failed to parse raw body json')) {
      res.status(400).json({
        success: false,
        error: 'INVALID_WEBHOOK_PAYLOAD',
        message: err.message || 'Invalid webhook JSON payload.',
      });
      return;
    }

    if (msg.includes('missing_event_metadata')) {
      res.status(400).json({
        success: false,
        error: 'MISSING_EVENT_METADATA',
        message: err.message || 'Missing eventId or eventType in webhook payload.',
      });
      return;
    }

    if (msg.includes('payment_amount_mismatch')) {
      res.status(400).json({
        success: false,
        error: 'PAYMENT_AMOUNT_MISMATCH',
        message: err.message,
      });
      return;
    }

    res.status(500).json({
      success: false,
      error: 'WEBHOOK_INTERNAL_ERROR',
      message: err.message || 'Webhook processing failed due to internal server error.',
    });
  }
}

/**
 * Atomic Idempotency Claim and Completion Helpers
 * Prevents concurrency race conditions, payload tampering, and cross-account key hijacking.
 */
async function claimIdempotencyKey(params: {
  pool: any;
  idempotencyKey: string;
  actorId: string;
  endpoint: string;
  requestFingerprint: string;
}): Promise<
  | { claimed: true }
  | { claimed: false; status: 'COMPLETED'; statusCode: number; responseBody: any }
  | { claimed: false; status: 'PROCESSING'; conflictError: string }
  | { claimed: false; status: 'MISMATCH'; mismatchError: string }
  | { claimed: false; status: 'UNAUTHORIZED'; authError: string }
> {
  const { pool, idempotencyKey, actorId, endpoint, requestFingerprint } = params;

  // 1. Authoritative check on existing record
  const existingKeyRes = await pool.query(
    `SELECT status, status_code, response_body, request_fingerprint, actor_id, created_at
     FROM idempotency_keys
     WHERE idempotency_key = $1`,
    [idempotencyKey]
  );

  if (existingKeyRes.rows.length > 0) {
    const existing = existingKeyRes.rows[0];

    // Actor ownership verification: Prevent cross-user key hijacking
    if (existing.actor_id && existing.actor_id !== actorId) {
      return {
        claimed: false,
        status: 'UNAUTHORIZED',
        authError: 'This Idempotency-Key belongs to a different user account.',
      };
    }

    // Payload mismatch check: Reused key with incompatible payload rejected
    if (existing.request_fingerprint && existing.request_fingerprint !== requestFingerprint) {
      return {
        claimed: false,
        status: 'MISMATCH',
        mismatchError: 'This Idempotency-Key was already used with a different request payload.',
      };
    }

    // Completed check: Return cached response directly
    if (existing.status === 'COMPLETED') {
      return {
        claimed: false,
        status: 'COMPLETED',
        statusCode: existing.status_code || 200,
        responseBody: existing.response_body,
      };
    }

    // Processing check: If actively in progress (< 2 minutes old), block concurrent attempt
    if (existing.status === 'PROCESSING') {
      const ageMs = Date.now() - new Date(existing.created_at || Date.now()).getTime();
      if (ageMs <= 120000) {
        return {
          claimed: false,
          status: 'PROCESSING',
          conflictError: 'An operation with this Idempotency-Key is currently in progress.',
        };
      }
    }

    // Stale PROCESSING (> 2 minutes) or FAILED state: Reclamation
    await pool.query(
      `UPDATE idempotency_keys
       SET status = 'PROCESSING', request_fingerprint = $1, created_at = NOW()
       WHERE idempotency_key = $2`,
      [requestFingerprint, idempotencyKey]
    );
    return { claimed: true };
  }

  // 2. Insert initial PROCESSING state
  try {
    await pool.query(
      `INSERT INTO idempotency_keys (idempotency_key, actor_id, endpoint, status, request_fingerprint, created_at, expires_at)
       VALUES ($1, $2, $3, 'PROCESSING', $4, NOW(), NOW() + interval '24 hours')`,
      [idempotencyKey, actorId, endpoint, requestFingerprint]
    );
    return { claimed: true };
  } catch (err: any) {
    if (err.code === '23505' || err.message?.includes('unique') || err.message?.includes('duplicate')) {
      const reCheck = await pool.query(
        `SELECT status, status_code, response_body, request_fingerprint, actor_id, created_at
         FROM idempotency_keys WHERE idempotency_key = $1`,
        [idempotencyKey]
      );
      if (reCheck.rows.length > 0) {
        const existing = reCheck.rows[0];
        if (existing.status === 'COMPLETED') {
          return {
            claimed: false,
            status: 'COMPLETED',
            statusCode: existing.status_code || 200,
            responseBody: existing.response_body,
          };
        }
        return {
          claimed: false,
          status: 'PROCESSING',
          conflictError: 'An operation with this Idempotency-Key is currently in progress.',
        };
      }
    }
    throw err;
  }
}

async function markIdempotencyCompleted(pool: any, key: string, statusCode: number, responseBody: any): Promise<void> {
  await pool.query(
    `UPDATE idempotency_keys
     SET status = 'COMPLETED', status_code = $1, response_body = $2
     WHERE idempotency_key = $3`,
    [statusCode, JSON.stringify(responseBody), key]
  );
}

async function markIdempotencyFailed(pool: any, key: string): Promise<void> {
  await pool.query(
    `UPDATE idempotency_keys SET status = 'FAILED' WHERE idempotency_key = $1 AND status = 'PROCESSING'`,
    [key]
  );
}

/**
 * POST /api/payment/create-order & POST /api/v1/payments/create-order
 * Protected by customer authentication and Idempotency-Key
 */
paymentRouter.post('/create-order', authenticate, paymentInitiationRateLimiter, async (req: Request, res: Response): Promise<void> => {
  const pool = getPool();
  const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
  const cleanKey = idempotencyKey && typeof idempotencyKey === 'string' ? idempotencyKey.trim().slice(0, 120) : undefined;
  const requestId = (req as any).requestId || req.headers['x-request-id'] || 'req-payment-order';

  const { orderId } = req.body;
  if (!orderId) {
    res.status(400).json({ success: false, error: 'MISSING_ORDER_ID', message: 'orderId is required.' });
    return;
  }

  // 1. Deterministic Request Fingerprint
  const normalizedPayload = {
    userId: req.auth!.userId,
    orderId,
  };
  const requestFingerprint = crypto.createHash('sha256').update(JSON.stringify(normalizedPayload)).digest('hex');

  // 2. Atomic Idempotency Claim
  if (cleanKey) {
    try {
      const claim = await claimIdempotencyKey({
        pool,
        idempotencyKey: cleanKey,
        actorId: req.auth!.userId,
        endpoint: req.originalUrl,
        requestFingerprint,
      });

      if (!claim.claimed) {
        if (claim.status === 'UNAUTHORIZED') {
          res.status(403).json({
            success: false,
            error: 'UNAUTHORIZED_IDEMPOTENCY_KEY_ACCESS',
            message: claim.authError,
            requestId,
          });
          return;
        }
        if (claim.status === 'MISMATCH') {
          res.status(422).json({
            success: false,
            error: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
            message: claim.mismatchError,
            requestId,
          });
          return;
        }
        if (claim.status === 'COMPLETED') {
          res.status(claim.statusCode).json(claim.responseBody);
          return;
        }
        if (claim.status === 'PROCESSING') {
          res.status(409).json({
            success: false,
            error: 'PAYMENT_ORDER_IN_PROGRESS',
            message: claim.conflictError,
            requestId,
          });
          return;
        }
      }
    } catch (err: any) {
      if (paymentService.isDatabaseUnavailable(err)) {
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

  try {
    const paymentOrder = await paymentService.createPaymentOrder(orderId, req.auth!.userId);

    const responseBody = {
      success: true,
      paymentOrder,
    };

    if (cleanKey) {
      try {
        await markIdempotencyCompleted(pool, cleanKey, 200, responseBody);
      } catch (err: any) {
        if (paymentService.isDatabaseUnavailable(err)) {
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
        await markIdempotencyFailed(pool, cleanKey);
      } catch {
        // Suppress secondary error
      }
    }

    if (paymentService.isDatabaseUnavailable(err)) {
      res.setHeader('Retry-After', '3');
      res.status(503).json({
        success: false,
        error: 'DATABASE_UNAVAILABLE',
        message: 'PostgreSQL database is currently unavailable. Please retry.',
        retryAfterSeconds: 3,
        requestId,
      });
      return;
    }

    const msg = (err.message || '').toLowerCase();
    const isUnauthorized = msg.includes('unauthorized');
    const isNotFound = msg.includes('order not found') || (msg.includes('not found') && !msg.includes('column') && !msg.includes('relation'));
    const isCod = msg.includes('cod_order');
    const isAlreadyPaid = msg.includes('already_paid');
    const isGatewayNotConfigured = msg.includes('payment_gateway_not_configured');

    const statusCode = isUnauthorized ? 403 : isNotFound ? 404 : isGatewayNotConfigured ? 503 : isCod || isAlreadyPaid ? 400 : 400;

    res.status(statusCode).json({
      success: false,
      error: isUnauthorized
        ? 'UNAUTHORIZED_ORDER_ACCESS'
        : isNotFound
        ? 'ORDER_NOT_FOUND'
        : isGatewayNotConfigured
        ? 'PAYMENT_GATEWAY_NOT_CONFIGURED'
        : isCod
        ? 'COD_ORDER_CANNOT_INITIATE_ONLINE_PAYMENT'
        : 'PAYMENT_INTENT_FAILED',
      message: err.message || 'Failed to generate payment intent.',
      requestId,
    });
  }
});

/**
 * POST /api/payment/verify & POST /api/v1/payments/verify
 * Protected by customer authentication and Idempotency-Key
 */
paymentRouter.post('/verify', authenticate, async (req: Request, res: Response): Promise<void> => {
  const pool = getPool();
  const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
  const cleanKey = idempotencyKey && typeof idempotencyKey === 'string' ? idempotencyKey.trim().slice(0, 120) : undefined;
  const requestId = (req as any).requestId || req.headers['x-request-id'] || 'req-payment-verify';

  const { orderId, transactionId, timestamp, signature, amount, razorpayOrderId } = req.body;

  if (!orderId || !transactionId || !timestamp || !signature) {
    res.status(400).json({
      success: false,
      error: 'MISSING_FIELDS',
      message: 'orderId, transactionId, timestamp, and signature are required.',
      requestId,
    });
    return;
  }

  // 1. Deterministic Request Fingerprint
  const normalizedPayload = {
    userId: req.auth!.userId,
    orderId,
    transactionId,
    amount: amount !== undefined ? Number(amount) : null,
  };
  const requestFingerprint = crypto.createHash('sha256').update(JSON.stringify(normalizedPayload)).digest('hex');

  // 2. Atomic Idempotency Claim
  if (cleanKey) {
    try {
      const claim = await claimIdempotencyKey({
        pool,
        idempotencyKey: cleanKey,
        actorId: req.auth!.userId,
        endpoint: req.originalUrl,
        requestFingerprint,
      });

      if (!claim.claimed) {
        if (claim.status === 'UNAUTHORIZED') {
          res.status(403).json({
            success: false,
            error: 'UNAUTHORIZED_IDEMPOTENCY_KEY_ACCESS',
            message: claim.authError,
            requestId,
          });
          return;
        }
        if (claim.status === 'MISMATCH') {
          res.status(422).json({
            success: false,
            error: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
            message: claim.mismatchError,
            requestId,
          });
          return;
        }
        if (claim.status === 'COMPLETED') {
          res.status(claim.statusCode).json(claim.responseBody);
          return;
        }
        if (claim.status === 'PROCESSING') {
          res.status(409).json({
            success: false,
            error: 'PAYMENT_VERIFICATION_IN_PROGRESS',
            message: claim.conflictError,
            requestId,
          });
          return;
        }
      }
    } catch (err: any) {
      if (paymentService.isDatabaseUnavailable(err)) {
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

  try {
    const result = await paymentService.verifyPayment({
      orderId,
      transactionId,
      timestamp: Number(timestamp),
      signature,
      amount: amount !== undefined ? Number(amount) : undefined,
      userId: req.auth!.userId,
      razorpayOrderId,
    });

    const responseBody = {
      success: !result.isDuplicate,
      message: result.isDuplicate
        ? 'Payment has already been captured and verified (duplicate/replay detected).'
        : 'Payment verified and captured successfully. Ledger journal posted.',
      order: result.order,
      paymentReceipt: result.receipt,
      isDuplicate: !!result.isDuplicate,
    };

    if (cleanKey) {
      try {
        await markIdempotencyCompleted(pool, cleanKey, result.isDuplicate ? 409 : 200, responseBody);
      } catch (err: any) {
        if (paymentService.isDatabaseUnavailable(err)) {
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

    if (result.isDuplicate) {
      res.status(409).json(responseBody);
      return;
    }

    res.status(200).json(responseBody);
  } catch (err: any) {
    console.error('PAYMENT_VERIFY_ERROR_CAUGHT:', err?.message || err);
    if (cleanKey) {
      try {
        await markIdempotencyFailed(pool, cleanKey);
      } catch {
        // Suppress secondary error
      }
    }

    if (paymentService.isDatabaseUnavailable(err)) {
      res.setHeader('Retry-After', '3');
      res.status(503).json({
        success: false,
        error: 'DATABASE_UNAVAILABLE',
        message: 'PostgreSQL database is currently unavailable. Please retry.',
        retryAfterSeconds: 3,
        requestId,
      });
      return;
    }

    const msg = (err.message || '').toLowerCase();
    const isAmountMismatch = msg.includes('payment_amount_mismatch');
    const isDuplicateKey = msg.includes('duplicate key') || msg.includes('unique constraint');
    const isReplay = msg.includes('replay') || isDuplicateKey;
    const isSignature = msg.includes('signature') && !isDuplicateKey;
    const isStateTransition = msg.includes('invalid_payment_state_transition');
    const isUnauthorized = msg.includes('unauthorized');
    const isNotFound = msg.includes('order not found') || (msg.includes('not found') && !msg.includes('column') && !msg.includes('relation'));

    const statusCode = isAmountMismatch
      ? 400
      : isReplay || isStateTransition
      ? 409
      : isSignature
      ? 400
      : isUnauthorized
      ? 403
      : isNotFound
      ? 404
      : 500;

    const errorCode = isAmountMismatch
      ? 'PAYMENT_AMOUNT_MISMATCH'
      : isReplay
      ? 'REPLAY_ATTACK_DETECTED'
      : isSignature
      ? 'INVALID_SIGNATURE'
      : isStateTransition
      ? 'INVALID_PAYMENT_STATE_TRANSITION'
      : isUnauthorized
      ? 'UNAUTHORIZED_PAYMENT_ACCESS'
      : isNotFound
      ? 'ORDER_NOT_FOUND'
      : 'VERIFICATION_FAILED';

    res.status(statusCode).json({
      success: false,
      error: errorCode,
      message: err.message || 'Payment verification failed.',
      requestId,
    });
  }
});

/**
 * POST /api/payment/webhook & POST /api/v1/payments/webhook
 */
paymentRouter.post('/webhook', paymentWebhookRateLimiter, handleWebhookRequest);
paymentRouter.post('/razorpay-webhook', paymentWebhookRateLimiter, handleWebhookRequest);

/**
 * GET /api/payment/providers & GET /api/v1/payments/providers
 * Returns registered payment providers and their capabilities
 */
paymentRouter.get('/providers/list', (_req: Request, res: Response): void => {
  const providers = paymentProviderRegistry.listProviders().map(p => {
    const providerInstance = paymentProviderRegistry.getProvider(p.providerId);
    return {
      ...p,
      capabilities: typeof providerInstance.getCapabilities === 'function' ? providerInstance.getCapabilities() : null,
    };
  });
  res.status(200).json({ success: true, providers });
});
paymentRouter.get('/providers', (_req: Request, res: Response): void => {
  const providers = paymentProviderRegistry.listProviders().map(p => {
    const providerInstance = paymentProviderRegistry.getProvider(p.providerId);
    return {
      ...p,
      capabilities: typeof providerInstance.getCapabilities === 'function' ? providerInstance.getCapabilities() : null,
    };
  });
  res.status(200).json({ success: true, providers });
});

/**
 * GET /api/payment/:orderId & GET /api/v1/payments/:orderId
 * Safe payment status query for authenticated order owner
 */
paymentRouter.get('/:orderId', authenticate, async (req: Request, res: Response): Promise<void> => {
  const { orderId } = req.params;
  const requestId = (req as any).requestId || req.headers['x-request-id'] || 'req-payment-status';

  if (!orderId) {
    res.status(400).json({ success: false, error: 'MISSING_ORDER_ID', message: 'orderId is required.', requestId });
    return;
  }

  try {
    const payment = await paymentService.getPaymentStatus(orderId, req.auth!.userId);
    res.status(200).json({
      success: true,
      payment,
    });
  } catch (err: any) {
    if (paymentService.isDatabaseUnavailable(err)) {
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

    const msg = (err.message || '').toLowerCase();
    const isUnauthorized = msg.includes('unauthorized');
    const isNotFound = msg.includes('not found');

    res.status(isUnauthorized ? 403 : isNotFound ? 404 : 500).json({
      success: false,
      error: isUnauthorized ? 'UNAUTHORIZED_PAYMENT_ACCESS' : isNotFound ? 'ORDER_NOT_FOUND' : 'PAYMENT_STATUS_FAILED',
      message: err.message || 'Failed to fetch payment status.',
      requestId,
    });
  }
});

/**
 * POST /api/payment/webhook/:providerId
 * Provider-specific webhook ingestion route
 */
paymentRouter.post('/webhook/:providerId', handleWebhookRequest);

/**
 * POST /api/payment/attempt
 * Provider-agnostic payment attempt creation
 */
paymentRouter.post('/attempt', authenticate, async (req: Request, res: Response): Promise<void> => {
  const { orderId, providerId } = req.body;
  const idempotencyKey = req.headers['idempotency-key'] as string | undefined;

  if (!orderId) {
    res.status(400).json({ success: false, error: 'MISSING_ORDER_ID', message: 'orderId is required.' });
    return;
  }

  try {
    const result = await paymentService.createPaymentAttempt({
      orderId,
      userId: req.auth!.userId,
      providerId,
      idempotencyKey,
    });
    res.status(200).json({ success: true, ...result });
  } catch (err: any) {
    const msg = (err.message || '').toLowerCase();
    const isUnauthorized = msg.includes('unauthorized');
    const isNotFound = msg.includes('not found');
    const isGatewayNotConfigured = msg.includes('payment_gateway_not_configured');
    res.status(isUnauthorized ? 403 : isNotFound ? 404 : isGatewayNotConfigured ? 503 : 400).json({
      success: false,
      error: isUnauthorized
        ? 'UNAUTHORIZED_ORDER_ACCESS'
        : isNotFound
        ? 'ORDER_NOT_FOUND'
        : isGatewayNotConfigured
        ? 'PAYMENT_GATEWAY_NOT_CONFIGURED'
        : 'PAYMENT_ATTEMPT_FAILED',
      message: err.message || 'Failed to create payment attempt.',
    });
  }
});

/**
 * POST /api/payment/reconcile/:orderId
 * Authoritative reconciliation of ambiguous payment status
 */
paymentRouter.post('/reconcile/:orderId', authenticate, async (req: Request, res: Response): Promise<void> => {
  const { orderId } = req.params;
  if (!orderId) {
    res.status(400).json({ success: false, error: 'MISSING_ORDER_ID', message: 'orderId is required.' });
    return;
  }

  try {
    const reconciliation = await paymentService.reconcilePayment(orderId);
    res.status(200).json({ success: true, reconciliation });
  } catch (err: any) {
    const msg = (err.message || '').toLowerCase();
    const isNotFound = msg.includes('not found');
    res.status(isNotFound ? 404 : 500).json({
      success: false,
      error: isNotFound ? 'ORDER_NOT_FOUND' : 'RECONCILIATION_FAILED',
      message: err.message || 'Payment reconciliation failed.',
    });
  }
});
