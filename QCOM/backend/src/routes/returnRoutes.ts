import { Router, Request, Response } from 'express';
import { returnService } from '../modules/orders/returnService.js';
import { authenticate } from '../middleware/auth.js';
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
 * List all returns for an order
 */
returnRouter.get('/orders/:orderId/returns', authenticate, async (req: Request, res: Response): Promise<void> => {
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
 * Get details of a specific return request
 */
returnRouter.get('/returns/:returnId', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { returnId } = req.params;
    const ret = await returnService.getReturnById(returnId);
    if (!ret) {
      res.status(404).json({ success: false, error: 'RETURN_NOT_FOUND', message: 'Return not found.' });
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
    const { action, reasonNotes, merchantId } = req.body;

    if (!action || !['APPROVE', 'REJECT'].includes(action)) {
      res.status(400).json({ success: false, error: 'INVALID_ACTION', message: 'action must be APPROVE or REJECT.' });
      return;
    }

    const effectiveMerchantId = merchantId || (req.auth as any)?.merchantId;
    const updated = await returnService.reviewReturn({
      returnId,
      merchantId: effectiveMerchantId,
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
    const { merchantId } = req.body;
    const effectiveMerchantId = merchantId || (req.auth as any)?.merchantId;

    if (!effectiveMerchantId) {
      res.status(400).json({ success: false, error: 'MISSING_MERCHANT_ID', message: 'merchantId is required.' });
      return;
    }

    const updated = await returnService.receiveAtStore({
      returnId,
      merchantId: effectiveMerchantId,
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
    const { merchantId, itemDecisions, qcNotes } = req.body;
    const effectiveMerchantId = merchantId || (req.auth as any)?.merchantId;

    if (!effectiveMerchantId) {
      res.status(400).json({ success: false, error: 'MISSING_MERCHANT_ID', message: 'merchantId is required.' });
      return;
    }

    if (!itemDecisions || !Array.isArray(itemDecisions) || itemDecisions.length === 0) {
      res.status(400).json({ success: false, error: 'MISSING_DECISIONS', message: 'itemDecisions array is required.' });
      return;
    }

    const result = await returnService.qcInspectAndResolve({
      returnId,
      merchantId: effectiveMerchantId,
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
