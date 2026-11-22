import { Router, Request, Response } from 'express';
import { paymentService } from '../modules/payments/paymentService.js';
import { paymentProviderRegistry } from '../modules/payments/paymentProvider.js';
import { idempotencyService, computeCanonicalFingerprint } from '../modules/payments/idempotencyService.js';
import { paymentLogger } from '../modules/payments/paymentLogger.js';
import { authenticate } from '../middleware/auth.js';
import { requireOrderOwnership } from '../middleware/resourceOwnership.js';
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

  const rawBody = (req as any).rawBody || Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));

  try {
    const gateway = (
      req.params.providerId ||
      req.query.provider ||
      (req.path.includes('razorpay') || req.headers['x-razorpay-signature'] ? 'razorpay' : undefined)
    ) as string | undefined;

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
    if (msg.includes('payment_gateway_not_configured')) {
      res.status(503).json({
        success: false,
        error: 'PAYMENT_GATEWAY_NOT_CONFIGURED',
        message: err.message || 'No payment gateway is configured.',
      });
      return;
    }

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

    if (msg.includes('payment_amount_mismatch') || msg.includes('currency_mismatch')) {
      res.status(400).json({
        success: false,
        error: msg.includes('currency_mismatch') ? 'CURRENCY_MISMATCH' : 'PAYMENT_AMOUNT_MISMATCH',
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

function handleIdempotencyClaimRejection(
  claim: Exclude<Awaited<ReturnType<typeof idempotencyService.claimKey>>, { claimed: true }>,
  res: Response,
  requestId: string | string[],
  inProgressCode: string
): void {
  if (claim.status === 'UNAUTHORIZED') {
    res.status(403).json({
      success: false,
      error: 'UNAUTHORIZED_IDEMPOTENCY_KEY_ACCESS',
      message: claim.authError,
      requestId,
    });
    return;
  }
  if (claim.status === 'SCOPE_MISMATCH') {
    res.status(422).json({
      success: false,
      error: 'IDEMPOTENCY_SCOPE_MISMATCH',
      message: claim.scopeError,
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
  res.status(409).json({
    success: false,
    error: inProgressCode,
    message: claim.conflictError,
    requestId,
  });
}

/**
 * POST /api/payment/create-order & POST /api/v1/payments/create-order
 * Protected by customer authentication, rate limiting, and durable PostgreSQL Idempotency-Key
 */
paymentRouter.post('/create-order', authenticate, paymentInitiationRateLimiter, async (req: Request, res: Response): Promise<void> => {
  const pool = getPool();
  const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
  const cleanKey = idempotencyKey && typeof idempotencyKey === 'string' ? idempotencyKey.trim().slice(0, 120) : undefined;
  const requestId = (req as any).requestId || req.headers['x-request-id'] || 'req-payment-order';

  const { orderId, amount, currency } = req.body;
  if (!orderId) {
    res.status(400).json({ success: false, error: 'MISSING_ORDER_ID', message: 'orderId is required.' });
    return;
  }

  const requestFingerprint = computeCanonicalFingerprint({
    userId: req.auth!.userId,
    orderId,
    ...(amount !== undefined ? { amount: Number(amount) } : {}),
    ...(currency !== undefined ? { currency: String(currency).toUpperCase() } : {}),
  });

  if (cleanKey) {
    try {
      const claim = await idempotencyService.claimKey({
        pool,
        idempotencyKey: cleanKey,
        actorId: req.auth!.userId,
        operationType: 'PAYMENT_CREATE_ORDER',
        endpoint: req.originalUrl,
        requestFingerprint,
      });

      if (!claim.claimed) {
        handleIdempotencyClaimRejection(claim, res, requestId, 'PAYMENT_ORDER_IN_PROGRESS');
        return;
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
    const paymentOrder = await paymentService.createPaymentOrder(orderId, req.auth!.userId, undefined, {
      clientAmount: amount,
      clientCurrency: currency,
    });

    const responseBody = {
      success: true,
      paymentOrder,
    };

    if (cleanKey) {
      try {
        await idempotencyService.markCompleted(pool, cleanKey, 200, responseBody);
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
        await idempotencyService.markFailed(pool, cleanKey);
      } catch {}
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
    const isNotFound = msg.includes('order_not_found') || msg.includes('order not found') || (msg.includes('not found') && !msg.includes('column') && !msg.includes('relation'));
    const isCod = msg.includes('cod_order');
    const isAmountTampered = msg.includes('payment_amount_tampered');
    const isUnsupportedCurrency = msg.includes('unsupported_currency');
    const isGatewayNotConfigured = msg.includes('payment_gateway_not_configured');
    const isConflict = msg.includes('payment_reconciliation_pending') || msg.includes('attempt_already_in_progress');

    const statusCode = isUnauthorized ? 403 : isNotFound ? 404 : isGatewayNotConfigured ? 503 : isConflict ? 409 : isCod ? 400 : 400;

    res.status(statusCode).json({
      success: false,
      error: isUnauthorized
        ? 'UNAUTHORIZED_ORDER_ACCESS'
        : isNotFound
        ? 'ORDER_NOT_FOUND'
        : isGatewayNotConfigured
        ? 'PAYMENT_GATEWAY_NOT_CONFIGURED'
        : isConflict
        ? 'PAYMENT_RECONCILIATION_PENDING'
        : isCod
        ? 'COD_ORDER_CANNOT_INITIATE_ONLINE_PAYMENT'
        : isAmountTampered
        ? 'PAYMENT_AMOUNT_TAMPERED'
        : isUnsupportedCurrency
        ? 'UNSUPPORTED_CURRENCY'
        : 'PAYMENT_INTENT_FAILED',
      message: err.message || 'Failed to generate payment intent.',
      requestId,
    });
  }
});

/**
 * POST /api/payment/verify & POST /api/v1/payments/verify
 * Protected by customer authentication, rate limiting, and durable PostgreSQL Idempotency-Key
 */
paymentRouter.post('/verify', authenticate, paymentInitiationRateLimiter, async (req: Request, res: Response): Promise<void> => {
  const pool = getPool();
  const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
  const cleanKey = idempotencyKey && typeof idempotencyKey === 'string' ? idempotencyKey.trim().slice(0, 120) : undefined;
  const requestId = (req as any).requestId || req.headers['x-request-id'] || 'req-payment-verify';

  const { orderId, transactionId, timestamp, signature, amount, currency, razorpayOrderId } = req.body;

  if (!orderId || !transactionId || !timestamp || !signature) {
    res.status(400).json({
      success: false,
      error: 'MISSING_FIELDS',
      message: 'orderId, transactionId, timestamp, and signature are required.',
      requestId,
    });
    return;
  }

  const requestFingerprint = computeCanonicalFingerprint({
    userId: req.auth!.userId,
    orderId,
    transactionId,
    amount: amount !== undefined ? Number(amount) : null,
    currency: currency || 'INR',
  });

  if (cleanKey) {
    try {
      const claim = await idempotencyService.claimKey({
        pool,
        idempotencyKey: cleanKey,
        actorId: req.auth!.userId,
        operationType: 'PAYMENT_VERIFY',
        endpoint: req.originalUrl,
        requestFingerprint,
      });

      if (!claim.claimed) {
        handleIdempotencyClaimRejection(claim, res, requestId, 'PAYMENT_VERIFICATION_IN_PROGRESS');
        return;
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
      currency,
      userId: req.auth!.userId,
      razorpayOrderId,
    });

    const isRec = !!result.isReconciliationRequired;
    const responseBody = {
      success: !result.isDuplicate && !isRec,
      message: result.isDuplicate
        ? 'Payment has already been captured and verified (duplicate/replay detected).'
        : isRec
        ? 'Payment outcome is ambiguous or gateway connection was interrupted. Marked for reconciliation.'
        : 'Payment verified and captured successfully. Ledger journal posted.',
      order: result.order,
      paymentReceipt: result.receipt,
      isDuplicate: !!result.isDuplicate,
      isReconciliationRequired: isRec,
      status: result.status || (isRec ? 'RECONCILIATION_REQUIRED' : 'CAPTURED'),
    };

    const statusCode = result.isDuplicate ? 409 : isRec ? 202 : 200;

    if (cleanKey) {
      try {
        await idempotencyService.markCompleted(pool, cleanKey, statusCode, responseBody);
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

    if (isRec) {
      res.status(202).json(responseBody);
      return;
    }

    res.status(200).json(responseBody);
  } catch (err: any) {
    paymentLogger.log('error', 'PAYMENT_VERIFY_FAILED', { orderId, userId: req.auth!.userId }, { error: err?.message });
    if (cleanKey) {
      try {
        await idempotencyService.markFailed(pool, cleanKey);
      } catch {}
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
    const isCurrencyMismatch = msg.includes('currency_mismatch');
    const isDuplicateKey = msg.includes('duplicate key') || msg.includes('unique constraint') || msg.includes('duplicate_payment_capture');
    const isReplay = msg.includes('replay') || isDuplicateKey;
    const isSignature = msg.includes('signature') && !isDuplicateKey;
    const isStateTransition = msg.includes('invalid_payment_state_transition');
    const isUnauthorized = msg.includes('unauthorized');
    const isGatewayNotConfigured = msg.includes('payment_gateway_not_configured');
    const isNotFound = msg.includes('order_not_found') || msg.includes('order not found') || (msg.includes('not found') && !msg.includes('column') && !msg.includes('relation'));

    const statusCode = isAmountMismatch || isCurrencyMismatch
      ? 400
      : isReplay || isStateTransition
      ? 409
      : isSignature
      ? 400
      : isUnauthorized
      ? 403
      : isGatewayNotConfigured
      ? 503
      : isNotFound
      ? 404
      : 500;

    const errorCode = isAmountMismatch
      ? 'PAYMENT_AMOUNT_MISMATCH'
      : isCurrencyMismatch
      ? 'CURRENCY_MISMATCH'
      : isReplay
      ? 'REPLAY_ATTACK_DETECTED'
      : isSignature
      ? 'INVALID_SIGNATURE'
      : isStateTransition
      ? 'INVALID_PAYMENT_STATE_TRANSITION'
      : isUnauthorized
      ? 'UNAUTHORIZED_PAYMENT_ACCESS'
      : isGatewayNotConfigured
      ? 'PAYMENT_GATEWAY_NOT_CONFIGURED'
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
 * GET /api/payment/status/:orderId & GET /api/v1/payments/status/:orderId
 */
paymentRouter.get('/status/:orderId', authenticate, async (req: Request, res: Response): Promise<void> => {
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
 * GET /api/payment/:orderId & GET /api/v1/payments/:orderId
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
 */
paymentRouter.post('/webhook/:providerId', paymentWebhookRateLimiter, handleWebhookRequest);

/**
 * POST /api/payment/attempt
 * Provider-agnostic payment attempt creation with durable PostgreSQL idempotency & rate limiting
 */
paymentRouter.post('/attempt', authenticate, paymentInitiationRateLimiter, async (req: Request, res: Response): Promise<void> => {
  const pool = getPool();
  const { orderId, providerId, amount, currency } = req.body;
  const rawKey = req.headers['idempotency-key'] as string | undefined;
  const cleanKey = rawKey && typeof rawKey === 'string' ? rawKey.trim().slice(0, 120) : undefined;
  const requestId = (req as any).requestId || req.headers['x-request-id'] || 'req-payment-attempt';

  if (!orderId) {
    res.status(400).json({ success: false, error: 'MISSING_ORDER_ID', message: 'orderId is required.', requestId });
    return;
  }

  const requestFingerprint = computeCanonicalFingerprint({
    userId: req.auth!.userId,
    orderId,
    providerId: providerId || null,
    ...(amount !== undefined ? { amount: Number(amount) } : {}),
    ...(currency !== undefined ? { currency: String(currency).toUpperCase() } : {}),
  });

  if (cleanKey) {
    try {
      const claim = await idempotencyService.claimKey({
        pool,
        idempotencyKey: cleanKey,
        actorId: req.auth!.userId,
        operationType: 'PAYMENT_ATTEMPT',
        endpoint: req.originalUrl,
        requestFingerprint,
      });

      if (!claim.claimed) {
        handleIdempotencyClaimRejection(claim, res, requestId, 'PAYMENT_ATTEMPT_IN_PROGRESS');
        return;
      }
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
      throw err;
    }
  }

  try {
    const result = await paymentService.createPaymentAttempt({
      orderId,
      userId: req.auth!.userId,
      providerId,
      idempotencyKey: cleanKey,
      clientAmount: amount,
      clientCurrency: currency,
    });
    const responseBody = { success: true, ...result };

    if (cleanKey) {
      await idempotencyService.markCompleted(pool, cleanKey, 200, responseBody).catch(() => {});
    }

    res.status(200).json(responseBody);
  } catch (err: any) {
    if (cleanKey) {
      await idempotencyService.markFailed(pool, cleanKey).catch(() => {});
    }

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
    const isNotFound = msg.includes('order_not_found') || msg.includes('not found');
    const isAmountTampered = msg.includes('payment_amount_tampered');
    const isUnsupportedCurrency = msg.includes('unsupported_currency');
    const isGatewayNotConfigured = msg.includes('payment_gateway_not_configured');
    const isConflict = msg.includes('payment_attempt_already_in_progress') || msg.includes('payment_reconciliation_pending');

    res.status(isUnauthorized ? 403 : isNotFound ? 404 : isGatewayNotConfigured ? 503 : isConflict ? 409 : 400).json({
      success: false,
      error: isUnauthorized
        ? 'UNAUTHORIZED_ORDER_ACCESS'
        : isNotFound
        ? 'ORDER_NOT_FOUND'
        : isGatewayNotConfigured
        ? 'PAYMENT_GATEWAY_NOT_CONFIGURED'
        : isConflict
        ? 'PAYMENT_ATTEMPT_ALREADY_IN_PROGRESS'
        : isAmountTampered
        ? 'PAYMENT_AMOUNT_TAMPERED'
        : isUnsupportedCurrency
        ? 'UNSUPPORTED_CURRENCY'
        : 'PAYMENT_ATTEMPT_FAILED',
      message: err.message || 'Failed to create payment attempt.',
      requestId,
    });
  }
});

/**
 * POST /api/payment/reconcile/:orderId
 * Authoritative reconciliation of ambiguous payment status
 */
paymentRouter.post('/reconcile/:orderId', authenticate, requireOrderOwnership('orderId'), async (req: Request, res: Response): Promise<void> => {
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
