import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { paymentService } from '../modules/payments/paymentService.js';
import { authenticate } from '../middleware/auth.js';
import { getPool } from '../database/connection.js';

export const paymentRouter = Router();

/**
 * Common webhook request handler
 */
export async function handleWebhookRequest(req: Request, res: Response): Promise<void> {
  const signature = (req.headers['x-razorpay-signature'] || req.headers['x-signature']) as string | undefined;

  if (!signature) {
    res.status(400).json({
      success: false,
      error: 'MISSING_WEBHOOK_SIGNATURE',
      message: 'x-razorpay-signature header is required for webhook authentication.',
    });
    return;
  }

  // Raw body preserved by express.json verify hook
  const rawBody = (req as any).rawBody || Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));

  try {
    const result = await paymentService.processWebhook({
      rawBody,
      signature,
      gateway: 'RAZORPAY',
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

    if (msg.includes('payment_amount_mismatch')) {
      res.status(400).json({
        success: false,
        error: 'PAYMENT_AMOUNT_MISMATCH',
        message: err.message,
      });
      return;
    }

    res.status(400).json({
      success: false,
      error: 'WEBHOOK_PROCESSING_FAILED',
      message: err.message || 'Webhook processing failed.',
    });
  }
}

/**
 * POST /api/payment/create-order & POST /api/v1/payments/create-order
 * Protected by customer authentication and Idempotency-Key
 */
paymentRouter.post('/create-order', authenticate, async (req: Request, res: Response): Promise<void> => {
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
            message: 'This Idempotency-Key was already used for payment order creation with a different request payload.',
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
            error: 'PAYMENT_ORDER_IN_PROGRESS',
            message: 'A payment order creation request with this Idempotency-Key is currently in progress.',
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
        await pool.query(
          `UPDATE idempotency_keys
           SET status = 'COMPLETED', status_code = 200, response_body = $1
           WHERE idempotency_key = $2`,
          [JSON.stringify(responseBody), cleanKey]
        );
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
        await pool.query(`UPDATE idempotency_keys SET status = 'FAILED' WHERE idempotency_key = $1`, [cleanKey]);
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

    const statusCode = isUnauthorized ? 403 : isNotFound ? 404 : isCod || isAlreadyPaid ? 400 : 400;

    res.status(statusCode).json({
      success: false,
      error: isUnauthorized ? 'UNAUTHORIZED_ORDER_ACCESS' : isNotFound ? 'ORDER_NOT_FOUND' : isCod ? 'COD_ORDER_CANNOT_INITIATE_ONLINE_PAYMENT' : 'PAYMENT_INTENT_FAILED',
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
            message: 'This Idempotency-Key was already used for payment verification with a different request payload.',
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
            error: 'PAYMENT_VERIFICATION_IN_PROGRESS',
            message: 'A payment verification request with this Idempotency-Key is currently in progress.',
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

    if (result.isDuplicate) {
      res.status(409).json(responseBody);
      return;
    }

    if (cleanKey) {
      try {
        await pool.query(
          `UPDATE idempotency_keys
           SET status = 'COMPLETED', status_code = 200, response_body = $1
           WHERE idempotency_key = $2`,
          [JSON.stringify(responseBody), cleanKey]
        );
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
    console.error('PAYMENT_VERIFY_ERROR_CAUGHT:', err?.message || err);
    if (cleanKey) {
      try {
        await pool.query(`UPDATE idempotency_keys SET status = 'FAILED' WHERE idempotency_key = $1`, [cleanKey]);
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
paymentRouter.post('/webhook', handleWebhookRequest);
paymentRouter.post('/razorpay-webhook', handleWebhookRequest);

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
