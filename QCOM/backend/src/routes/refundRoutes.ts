import { Router, Request, Response } from 'express';
import { refundService } from '../modules/payments/refundService.js';
import { authenticate } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { requireOrderOwnership } from '../middleware/resourceOwnership.js';
import { bloomFilterService } from '../modules/resilience/bloomFilterService.js';

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
 * Restricted to Super Admin and Finance Admin roles
 */
refundRouter.post(
  '/admin/refunds/issue',
  authenticate,
  requireRole(['SUPER_ADMIN', 'FINANCE_ADMIN']),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { orderId, amount, reasonCode, reasonDescription } = req.body;
      const idempotencyKey = req.headers['idempotency-key'] as string | undefined;

      if (!orderId) {
        res.status(400).json({ success: false, error: 'MISSING_ORDER_ID', message: 'orderId is required.' });
        return;
      }

      const result = await refundService.createRefund({
        orderId,
        amount: amount ? parseFloat(amount) : undefined,
        reasonCode: reasonCode || 'ADMIN_DISPUTE_RESOLUTION',
        reasonDescription,
        idempotencyKey,
        createdBy: req.auth!.userId,
      });

      res.status(result.isDuplicate ? 200 : 201).json({
        success: true,
        message: 'Refund issued successfully.',
        refund: result.refund,
        isDuplicate: result.isDuplicate,
      });
    } catch (err: any) {
      if (isDatabaseUnavailable(err)) {
        res.status(503).json({ success: false, error: 'DATABASE_UNAVAILABLE', message: 'Database temporarily unavailable.' });
        return;
      }
      const status = err.message.includes('NOT_FOUND') ? 404 : 400;
      res.status(status).json({ success: false, error: 'REFUND_FAILED', message: err.message });
    }
  }
);

/**
 * GET /api/v1/admin/refunds/:refundId
 * Get refund by ID - restricted to Super Admin and Finance Admin
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
 * List refunds for an order with strict order resource ownership verification
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
 * Safe reconciliation of unknown provider outcomes (network timeout recovery)
 * Restricted to Super Admin and Finance Admin roles
 */
refundRouter.post(
  '/admin/refunds/:refundId/reconcile',
  authenticate,
  requireRole(['SUPER_ADMIN', 'FINANCE_ADMIN']),
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
 * Observability endpoint for Bloom Filter database overload protection metrics.
 * RBAC Protected: Restricted to Super Admins, Operations, and Finance Admins.
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

