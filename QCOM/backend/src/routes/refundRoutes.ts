import { handleWebhookRequest } from "./paymentRoutes.js";
import { financialRecoveryWorker } from "../modules/recovery/financialRecoveryWorker.js";
import { paymentReconciliationService } from "../modules/reconciliation/paymentReconciliationService.js";
import { paymentLogger } from "../modules/payments/paymentLogger.js";
import { idempotencyService, computeCanonicalFingerprint } from "../modules/payments/idempotencyService.js";
import { Router, Request, Response } from 'express';
import { refundService } from '../modules/payments/refundService.js';
import { authenticate } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { requireOrderOwnership } from '../middleware/resourceOwnership.js';
import { paymentWebhookRateLimiter, adminSensitiveRateLimiter } from '../middleware/rateLimiter.js';
import { bloomFilterService } from '../modules/resilience/bloomFilterService.js';
import { getPool } from '../database/connection.js';

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

export const refundRouter = Router();

/**
 * POST /api/v1/admin/refunds/issue
 * Admin manual dispute / resolution refund issuance
 * Restricted to Super Admin and Finance Admin roles with durable idempotency & rate limiting
 */
refundRouter.post(
  '/admin/refunds/issue',
  authenticate,
  requireRole(['SUPER_ADMIN', 'FINANCE_ADMIN']),
  adminSensitiveRateLimiter,
  async (req: Request, res: Response): Promise<void> => {
    const pool = getPool();
    const rawKey = req.headers['idempotency-key'] as string | undefined;
    const cleanKey = rawKey && typeof rawKey === 'string' ? rawKey.trim().slice(0, 120) : undefined;
    const { orderId, amount, reasonCode, reasonDescription } = req.body;

    if (!orderId) {
      res.status(400).json({ success: false, error: 'MISSING_ORDER_ID', message: 'orderId is required.' });
      return;
    }

    if (cleanKey) {
      try {
        const fingerprint = computeCanonicalFingerprint({
          actorId: req.auth!.userId,
          orderId,
          amount: amount !== undefined ? Number(amount) : null,
          reasonCode: reasonCode || 'ADMIN_DISPUTE_RESOLUTION',
        });
        const claim = await idempotencyService.claimKey({
          pool,
          idempotencyKey: cleanKey,
          actorId: req.auth!.userId,
          operationType: 'ADMIN_REFUND_ISSUE',
          endpoint: req.originalUrl,
          requestFingerprint: fingerprint,
        });

        if (!claim.claimed) {
          if (claim.status === 'UNAUTHORIZED') {
            res.status(403).json({ success: false, error: 'UNAUTHORIZED_IDEMPOTENCY_KEY_ACCESS', message: claim.authError });
            return;
          }
          if (claim.status === 'SCOPE_MISMATCH') {
            res.status(422).json({ success: false, error: 'IDEMPOTENCY_SCOPE_MISMATCH', message: claim.scopeError });
            return;
          }
          if (claim.status === 'MISMATCH') {
            res.status(422).json({ success: false, error: 'IDEMPOTENCY_PAYLOAD_MISMATCH', message: claim.mismatchError });
            return;
          }
          if (claim.status === 'COMPLETED') {
            res.status(claim.statusCode).json(claim.responseBody);
            return;
          }
          res.status(409).json({ success: false, error: 'REFUND_IN_PROGRESS', message: claim.conflictError });
          return;
        }
      } catch (err: any) {
        if (isDatabaseUnavailable(err)) {
          res.status(503).json({ success: false, error: 'DATABASE_UNAVAILABLE', message: 'Database temporarily unavailable.' });
          return;
        }
        throw err;
      }
    }

    try {
      const result = await refundService.createRefund({
        orderId,
        amount: amount !== undefined ? parseFloat(amount) : undefined,
        reasonCode: reasonCode || 'ADMIN_DISPUTE_RESOLUTION',
        reasonDescription,
        idempotencyKey: cleanKey,
        createdBy: req.auth!.userId,
      });

      const statusCode = result.isDuplicate ? 200 : 201;
      const body = {
        success: true,
        message: 'Refund issued successfully.',
        refund: result.refund,
        isDuplicate: result.isDuplicate,
      };

      if (cleanKey) {
        await idempotencyService.markCompleted(pool, cleanKey, statusCode, body).catch(() => {});
      }

      res.status(statusCode).json(body);
    } catch (err: any) {
      if (cleanKey) {
        await idempotencyService.markFailed(pool, cleanKey).catch(() => {});
      }
      if (isDatabaseUnavailable(err)) {
        res.status(503).json({ success: false, error: 'DATABASE_UNAVAILABLE', message: 'Database temporarily unavailable.' });
        return;
      }
      const msg = err.message || '';
      const status = msg.includes('NOT_FOUND') ? 404 : msg.includes('PAYMENT_GATEWAY_NOT_CONFIGURED') ? 503 : 400;
      res.status(status).json({ success: false, error: 'REFUND_FAILED', message: err.message });
    }
  }
);

/**
 * GET /api/v1/admin/refunds/:refundId
 */
refundRouter.get(
  '/admin/refunds/:refundId',
  authenticate,
  requireRole(['SUPER_ADMIN', 'FINANCE_ADMIN']),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { refundId } = req.params;
      const ref = await refundService.getRefundById(refundId);
      if (!ref) {
        res.status(404).json({ success: false, error: 'REFUND_NOT_FOUND', message: 'Refund not found.' });
        return;
      }
      res.status(200).json({ success: true, refund: ref });
    } catch (err: any) {
      if (isDatabaseUnavailable(err)) {
        res.status(503).json({ success: false, error: 'DATABASE_UNAVAILABLE', message: 'Database temporarily unavailable.' });
        return;
      }
      res.status(500).json({ success: false, error: 'FETCH_FAILED', message: err.message });
    }
  }
);

/**
 * GET /api/v1/orders/:orderId/refunds
 */
refundRouter.get(
  '/orders/:orderId/refunds',
  authenticate,
  requireOrderOwnership('orderId'),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { orderId } = req.params;
      if (!(await bloomFilterService.mightContainSafe('orders', orderId))) {
        res.status(200).json({ success: true, refunds: [] });
        return;
      }
      const refunds = await refundService.getRefundsForOrder(orderId);
      res.status(200).json({ success: true, refunds });
    } catch (err: any) {
      if (isDatabaseUnavailable(err)) {
        res.status(503).json({ success: false, error: 'DATABASE_UNAVAILABLE', message: 'Database temporarily unavailable.' });
        return;
      }
      res.status(500).json({ success: false, error: 'FETCH_FAILED', message: err.message });
    }
  }
);

/**
 * POST /api/v1/admin/refunds/:refundId/reconcile
 */
refundRouter.post(
  '/admin/refunds/:refundId/reconcile',
  authenticate,
  requireRole(['SUPER_ADMIN', 'FINANCE_ADMIN']),
  adminSensitiveRateLimiter,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { refundId } = req.params;
      const reconciled = await refundService.reconcileRefund(refundId);
      res.status(200).json({
        success: true,
        message: 'Refund status reconciled with provider.',
        refund: reconciled,
      });
    } catch (err: any) {
      if (isDatabaseUnavailable(err)) {
        res.status(503).json({ success: false, error: 'DATABASE_UNAVAILABLE', message: 'Database temporarily unavailable.' });
        return;
      }
      const status = err.message.includes('NOT_FOUND') ? 404 : 400;
      res.status(status).json({ success: false, error: 'RECONCILIATION_FAILED', message: err.message });
    }
  }
);

/**
 * GET /api/v1/resilience/bloom-metrics
 */
refundRouter.get(
  '/resilience/bloom-metrics',
  authenticate,
  requireRole(['SUPER_ADMIN', 'OPERATIONS', 'FINANCE_ADMIN']),
  async (_req: Request, res: Response): Promise<void> => {
    res.status(200).json({
      success: true,
      metrics: bloomFilterService.getMetrics(),
    });
  }
);

/**
 * POST /api/v1/refunds/webhooks/refunds
 */
refundRouter.post("/webhooks/refunds", paymentWebhookRateLimiter, handleWebhookRequest);

/**
 * POST /api/v1/admin/recovery/trigger
 */
refundRouter.post(
  "/admin/recovery/trigger",
  authenticate,
  requireRole(["SUPER_ADMIN", "FINANCE_ADMIN"]),
  adminSensitiveRateLimiter,
  async (_req: Request, res: Response): Promise<void> => {
    try {
      const summary = await financialRecoveryWorker.runRecoveryCycle();
      res.status(200).json({
        success: true,
        message: "Financial recovery cycle executed.",
        summary,
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: "RECOVERY_CYCLE_FAILED", message: err.message });
    }
  }
);

/**
 * GET /api/v1/admin/recovery/stats
 */
refundRouter.get(
  "/admin/recovery/stats",
  authenticate,
  requireRole(["SUPER_ADMIN", "FINANCE_ADMIN", "OPERATIONS"]),
  async (_req: Request, res: Response): Promise<void> => {
    res.status(200).json({
      success: true,
      stats: financialRecoveryWorker.getStats(),
    });
  }
);

/**
 * POST /api/v1/admin/reconciliation/payments/run
 * Triggers an internal payment reconciliation run across QCOM PostgreSQL financial tables.
 */
refundRouter.post(
  '/admin/reconciliation/payments/run',
  authenticate,
  requireRole(['SUPER_ADMIN', 'FINANCE_ADMIN']),
  adminSensitiveRateLimiter,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { orderId, autoRepair, staleThresholdMinutes, batchLimit } = req.body || {};
      const report = await paymentReconciliationService.runReconciliation({
        runType: orderId ? 'ORDER_SCOPED' : 'MANUAL',
        triggeredBy: req.auth!.userId,
        orderId,
        autoRepair,
        staleThresholdMinutes,
        batchLimit,
      });
      res.status(200).json({
        success: true,
        report,
      });
    } catch (err: any) {
      if (isDatabaseUnavailable(err)) {
        res.status(503).json({ success: false, error: 'DATABASE_UNAVAILABLE', message: 'Database temporarily unavailable.' });
        return;
      }
      res.status(500).json({ success: false, error: 'RECONCILIATION_RUN_FAILED', message: err.message });
    }
  }
);

/**
 * GET /api/v1/admin/reconciliation/discrepancies
 * Lists persisted internal payment reconciliation discrepancies.
 */
refundRouter.get(
  '/admin/reconciliation/discrepancies',
  authenticate,
  requireRole(['SUPER_ADMIN', 'FINANCE_ADMIN', 'OPERATIONS']),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const discrepancies = await paymentReconciliationService.listDiscrepancies({
        status: typeof req.query.status === 'string' ? req.query.status : undefined,
        severity: typeof req.query.severity === 'string' ? req.query.severity : undefined,
        orderId: typeof req.query.orderId === 'string' ? req.query.orderId : undefined,
        limit: req.query.limit ? parseInt(String(req.query.limit), 10) : 100,
      });
      res.status(200).json({ success: true, discrepancies });
    } catch (err: any) {
      res.status(500).json({ success: false, error: 'FETCH_DISCREPANCIES_FAILED', message: err.message });
    }
  }
);

/**
 * POST /api/v1/admin/reconciliation/discrepancies/:discrepancyId/resolve
 * Marks a reconciliation discrepancy manually resolved by a Finance/Super Admin.
 */
refundRouter.post(
  '/admin/reconciliation/discrepancies/:discrepancyId/resolve',
  authenticate,
  requireRole(['SUPER_ADMIN', 'FINANCE_ADMIN']),
  adminSensitiveRateLimiter,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { discrepancyId } = req.params;
      const { resolutionNote } = req.body || {};
      const discrepancy = await paymentReconciliationService.resolveDiscrepancy({
        discrepancyId,
        resolvedBy: req.auth!.userId,
        resolutionNote,
      });
      res.status(200).json({ success: true, discrepancy });
    } catch (err: any) {
      const status = err.message.includes('NOT_FOUND') ? 404 : 400;
      res.status(status).json({ success: false, error: 'RESOLVE_DISCREPANCY_FAILED', message: err.message });
    }
  }
);

/**
 * GET /api/v1/admin/payments/observability
 * Structured redacted observability summary + DB operational health counters.
 */
refundRouter.get(
  '/admin/payments/observability',
  authenticate,
  requireRole(['SUPER_ADMIN', 'FINANCE_ADMIN', 'OPERATIONS']),
  async (_req: Request, res: Response): Promise<void> => {
    try {
      const health = await paymentLogger.getOperationalPaymentHealth();
      res.status(200).json({
        success: true,
        observability: health,
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: 'OBSERVABILITY_FAILED', message: err.message });
    }
  }
);
