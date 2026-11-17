import { Router, Request, Response } from 'express';
import { returnService } from '../modules/orders/returnService.js';
import { authenticate } from '../middleware/auth.js';
import { requireOrderOwnership } from '../middleware/resourceOwnership.js';
import { bloomFilterService } from '../modules/resilience/bloomFilterService.js';
import { recordAuditEvent } from '../modules/audit/auditService.js';

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

function isReturnAdmin(req: Request): boolean {
  return Boolean(
    req.auth?.isSuperAdmin ||
      req.auth?.roles?.some((r: string) => ['SUPER_ADMIN', 'OPERATIONS', 'FINANCE_ADMIN'].includes(r))
  );
}

async function authorizeReturnMerchantAction(
  req: Request,
  res: Response,
  returnId: string
): Promise<{ authorized: true; merchantId: string } | { authorized: false }> {
  const ret = await returnService.getReturnById(returnId);
  if (!ret) {
    res.status(404).json({ success: false, error: 'RETURN_NOT_FOUND', message: 'Return not found.' });
    return { authorized: false };
  }

  const globalAdmin = isReturnAdmin(req);
  const authorizedMerchant = Boolean(req.auth?.merchantIds?.includes(ret.merchantId));
  const bodyMerchantId = req.body?.merchantId ? String(req.body.merchantId) : undefined;
  const forgedBodyMerchant = Boolean(bodyMerchantId && !globalAdmin && bodyMerchantId !== ret.merchantId);

  if ((!globalAdmin && !authorizedMerchant) || forgedBodyMerchant) {
    await recordAuditEvent({
      actorId: req.auth!.userId,
      actorType: 'USER',
      action: 'CROSS_MERCHANT_RETURN_MUTATION_BLOCKED',
      entityType: 'ORDER_RETURN',
      entityId: returnId,
      newState: {
        returnMerchantId: ret.merchantId,
        attemptedBodyMerchantId: bodyMerchantId || null,
        callerMerchants: req.auth?.merchantIds || [],
      },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.status(403).json({
      success: false,
      error: 'TENANT_ACCESS_DENIED',
      message: 'Access forbidden: You are not authorized to process returns for this merchant.',
    });
    return { authorized: false };
  }

  return { authorized: true, merchantId: ret.merchantId };
}

export const returnRouter = Router();

/**
 * POST /api/v1/orders/:orderId/returns
 * Customer requests return for delivered order
 */
returnRouter.post('/orders/:orderId/returns', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { orderId } = req.params;
    const { items, reasonCode, customerNotes } = req.body;
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;

    if (!items || !Array.isArray(items) || items.length === 0) {
      res.status(400).json({
        success: false,
        error: 'EMPTY_RETURN_ITEMS',
        message: 'At least one return item must be provided.',
      });
      return;
    }

    if (!reasonCode) {
      res.status(400).json({
        success: false,
        error: 'MISSING_REASON_CODE',
        message: 'reasonCode is required.',
      });
      return;
    }

    const result = await returnService.requestReturn({
      orderId,
      userId: req.auth!.userId,
      items,
      reasonCode,
      customerNotes,
      idempotencyKey,
    });

    res.status(result.isDuplicate ? 200 : 201).json({
      success: true,
      message: 'Return request submitted successfully.',
      returnRequest: result.returnRequest,
      isDuplicate: result.isDuplicate,
    });
  } catch (err: any) {
    if (isDatabaseUnavailable(err)) {
      res.status(503).json({ success: false, error: 'DATABASE_UNAVAILABLE', message: 'Database temporarily unavailable.' });
      return;
    }
    const status = err.message.includes('UNAUTHORIZED') ? 403 : err.message.includes('NOT_FOUND') ? 404 : 400;
    res.status(status).json({
      success: false,
      error: 'RETURN_REQUEST_FAILED',
      message: err.message,
    });
  }
});

/**
 * GET /api/v1/orders/:orderId/returns
 * List all returns for an order (strictly order-owner, merchant-owner, assigned rider, or admin)
 */
returnRouter.get('/orders/:orderId/returns', authenticate, requireOrderOwnership('orderId'), async (req: Request, res: Response): Promise<void> => {
  try {
    const { orderId } = req.params;
    if (!(await bloomFilterService.mightContainSafe('orders', orderId))) {
      res.status(200).json({ success: true, returns: [] });
      return;
    }
    const returns = await returnService.getReturnsForOrder(orderId);
    res.status(200).json({
      success: true,
      returns,
    });
  } catch (err: any) {
    if (isDatabaseUnavailable(err)) {
      res.status(503).json({ success: false, error: 'DATABASE_UNAVAILABLE', message: 'Database temporarily unavailable.' });
      return;
    }
    res.status(500).json({ success: false, error: 'FETCH_FAILED', message: err.message });
  }
});

/**
 * GET /api/v1/returns/:returnId
 * Get details of a specific return request with strict ownership check
 */
returnRouter.get('/returns/:returnId', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { returnId } = req.params;
    const ret = await returnService.getReturnById(returnId);
    if (!ret) {
      res.status(404).json({ success: false, error: 'RETURN_NOT_FOUND', message: 'Return not found.' });
      return;
    }

    const globalAdmin = isReturnAdmin(req);
    const isCustomerOwner = ret.userId === req.auth!.userId;
    const isMerchantOwner = Boolean(req.auth!.merchantIds?.includes(ret.merchantId));

    if (!globalAdmin && !isCustomerOwner && !isMerchantOwner) {
      await recordAuditEvent({
        actorId: req.auth!.userId,
        actorType: 'USER',
        action: 'CROSS_TENANT_RETURN_INSPECTION_BLOCKED',
        entityType: 'ORDER_RETURN',
        entityId: returnId,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.status(403).json({
        success: false,
        error: 'RESOURCE_ACCESS_DENIED',
        message: 'Access forbidden: You are not authorized to inspect this return request.',
      });
      return;
    }

    res.status(200).json({ success: true, returnRequest: ret });
  } catch (err: any) {
    if (isDatabaseUnavailable(err)) {
      res.status(503).json({ success: false, error: 'DATABASE_UNAVAILABLE', message: 'Database temporarily unavailable.' });
      return;
    }
    res.status(500).json({ success: false, error: 'FETCH_FAILED', message: err.message });
  }
});

/**
 * POST /api/v1/returns/:returnId/review
 * Merchant or Admin reviews return request: APPROVE or REJECT
 */
returnRouter.post('/returns/:returnId/review', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { returnId } = req.params;
    const { action, reasonNotes } = req.body;

    const authz = await authorizeReturnMerchantAction(req, res, returnId);
    if (!authz.authorized) return;

    if (!action || !['APPROVE', 'REJECT'].includes(action)) {
      res.status(400).json({ success: false, error: 'INVALID_ACTION', message: 'action must be APPROVE or REJECT.' });
      return;
    }

    const updated = await returnService.reviewReturn({
      returnId,
      merchantId: authz.merchantId,
      adminId: req.auth!.userId,
      action,
      reasonNotes,
    });

    res.status(200).json({
      success: true,
      message: `Return request ${action}D successfully.`,
      returnRequest: updated,
    });
  } catch (err: any) {
    if (isDatabaseUnavailable(err)) {
      res.status(503).json({ success: false, error: 'DATABASE_UNAVAILABLE', message: 'Database temporarily unavailable.' });
      return;
    }
    const status = err.message.includes('UNAUTHORIZED') ? 403 : err.message.includes('NOT_FOUND') ? 404 : 400;
    res.status(status).json({ success: false, error: 'REVIEW_FAILED', message: err.message });
  }
});

/**
 * POST /api/v1/returns/:returnId/receive
 * Merchant confirms receipt of return items at store
 */
returnRouter.post('/returns/:returnId/receive', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { returnId } = req.params;
    const authz = await authorizeReturnMerchantAction(req, res, returnId);
    if (!authz.authorized) return;

    const updated = await returnService.receiveAtStore({
      returnId,
      merchantId: authz.merchantId,
    });

    res.status(200).json({
      success: true,
      message: 'Return received at merchant store.',
      returnRequest: updated,
    });
  } catch (err: any) {
    if (isDatabaseUnavailable(err)) {
      res.status(503).json({ success: false, error: 'DATABASE_UNAVAILABLE', message: 'Database temporarily unavailable.' });
      return;
    }
    res.status(400).json({ success: false, error: 'RECEIPT_FAILED', message: err.message });
  }
});

/**
 * POST /api/v1/returns/:returnId/qc-inspect
 * Merchant inspects return items, triggers selective restock and refund
 */
returnRouter.post('/returns/:returnId/qc-inspect', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { returnId } = req.params;
    const { itemDecisions, qcNotes } = req.body;

    const authz = await authorizeReturnMerchantAction(req, res, returnId);
    if (!authz.authorized) return;

    if (!itemDecisions || !Array.isArray(itemDecisions) || itemDecisions.length === 0) {
      res.status(400).json({ success: false, error: 'MISSING_DECISIONS', message: 'itemDecisions array is required.' });
      return;
    }

    const result = await returnService.qcInspectAndResolve({
      returnId,
      merchantId: authz.merchantId,
      itemDecisions,
      qcNotes,
    });

    res.status(200).json({
      success: true,
      message: 'QC inspection processed and resolved.',
      returnRequest: result.returnRecord,
      refund: result.refund,
      clawback: result.clawback,
    });
  } catch (err: any) {
    if (isDatabaseUnavailable(err)) {
      res.status(503).json({ success: false, error: 'DATABASE_UNAVAILABLE', message: 'Database temporarily unavailable.' });
      return;
    }
    res.status(400).json({ success: false, error: 'QC_FAILED', message: err.message });
  }
});
