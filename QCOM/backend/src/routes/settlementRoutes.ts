import { handleWebhookRequest } from "./paymentRoutes.js";
import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { env } from '../config/env.js';
import { authenticate } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { requireRiderOwnership } from '../middleware/resourceOwnership.js';
import { settlementAllocationService } from '../modules/settlements/settlementAllocationService.js';
import { sellerSettlementService } from '../modules/settlements/sellerSettlementService.js';
import { riderPayoutService } from '../modules/settlements/riderPayoutService.js';
import { ledgerService } from '../modules/ledger/ledgerService.js';
import { getPool } from '../database/connection.js';

export const settlementRouter = Router();

function isDatabaseUnavailable(err: any): boolean {
  if (!err) return false;
  const code = err.code;
  const msg = String(err.message || '');
  return (
    code === 'ECONNREFUSED' ||
    code === '57P01' ||
    code === '57P02' ||
    code === '57P03' ||
    code === '08006' ||
    code === '08001' ||
    code === '08004' ||
    err.isDatabaseUnavailable === true ||
    msg.includes('Connection terminated') ||
    msg.includes('Database unavailable') ||
    msg.includes('connection error') ||
    msg.includes('client has already been released') ||
    msg.includes('Connection closed')
  );
}

/**
 * POST /api/v1/settlements/allocate
 * Trigger post-fulfillment financial allocation for a delivered order
 */
settlementRouter.post('/allocate', authenticate, async (req: Request, res: Response): Promise<void> => {
  const { orderId } = req.body;

  if (!orderId) {
    res.status(400).json({
      success: false,
      error: 'MISSING_ORDER_ID',
      message: 'orderId is required in request body.',
    });
    return;
  }

  try {
    const allocation = await settlementAllocationService.allocateFulfilledOrder(orderId);
    res.status(200).json({
      success: true,
      allocation,
    });
  } catch (err: any) {
    if (isDatabaseUnavailable(err)) {
      res.setHeader('Retry-After', '3');
      res.status(503).json({
        success: false,
        error: 'DATABASE_UNAVAILABLE',
        message: 'Database is temporarily unavailable during allocation. Please retry.',
        retryAfterSeconds: 3,
      });
      return;
    }

    const msg = (err.message || '').toLowerCase();
    if (msg.includes('order_not_found') || msg.includes('does not exist')) {
      res.status(404).json({
        success: false,
        error: 'ORDER_NOT_FOUND',
        message: err.message,
      });
      return;
    }

    if (msg.includes('merchant_not_found')) {
      res.status(404).json({
        success: false,
        error: 'MERCHANT_NOT_FOUND',
        message: err.message,
      });
      return;
    }

    res.status(400).json({
      success: false,
      error: 'ALLOCATION_FAILED',
      message: err.message || 'Failed to allocate order settlement.',
    });
  }
});

/**
 * GET /api/v1/settlements/order/:orderId/allocation
 * Fetch settlement allocation details for a specific order
 */
settlementRouter.get('/order/:orderId/allocation', authenticate, async (req: Request, res: Response): Promise<void> => {
  const { orderId } = req.params;

  try {
    const pool = getPool();
    const result = await pool.query(
      `SELECT * FROM order_settlement_allocations WHERE order_id = $1 LIMIT 1`,
      [orderId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({
        success: false,
        error: 'ALLOCATION_NOT_FOUND',
        message: `No settlement allocation found for order '${orderId}'.`,
      });
      return;
    }

    const row = result.rows[0];
    res.status(200).json({
      success: true,
      allocation: {
        id: row.id,
        orderId: row.order_id,
        merchantId: row.merchant_id,
        riderId: row.rider_id,
        tripId: row.trip_id,
        journalBatchId: row.journal_batch_id,
        orderTotal: parseFloat(row.order_total),
        grossGmv: parseFloat(row.gross_gmv),
        sellerGoodsTaxable: parseFloat(row.seller_goods_taxable),
        sellerGoodsGst: parseFloat(row.seller_goods_gst),
        platformCommission: parseFloat(row.platform_commission),
        commissionGst: parseFloat(row.commission_gst),
        gstTcsAmount: parseFloat(row.gst_tcs_amount),
        sellerTdsAmount: parseFloat(row.seller_tds_amount),
        storeDelayPenalty: parseFloat(row.store_delay_penalty),
        netSellerPayable: parseFloat(row.net_seller_payable),
        customerDeliveryFee: parseFloat(row.customer_delivery_fee),
        customerHandlingFee: parseFloat(row.customer_handling_fee),
        grossRiderFare: parseFloat(row.gross_rider_fare),
        customerTip: parseFloat(row.customer_tip),
        riderTdsAmount: parseFloat(row.rider_tds_amount),
        netRiderPayable: parseFloat(row.net_rider_payable),
        platformSubsidy: parseFloat(row.platform_subsidy),
        status: row.status,
        allocatedAt: row.allocated_at,
      },
    });
  } catch (err: any) {
    if (isDatabaseUnavailable(err)) {
      res.setHeader('Retry-After', '3');
      res.status(503).json({
        success: false,
        error: 'DATABASE_UNAVAILABLE',
        message: 'Database is temporarily unavailable. Please retry.',
        retryAfterSeconds: 3,
      });
      return;
    }

    res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: err.message,
    });
  }
});

/**
 * GET /api/v1/settlements/seller/:merchantId/statement
 * Retrieve seller settlement statement and balance breakdown
 */
settlementRouter.get('/seller/:merchantId/statement', authenticate, async (req: Request, res: Response): Promise<void> => {
  const { merchantId } = req.params;

  // Authorization check: User must be ADMIN or associated with this merchant
  if (req.auth) {
    const isPlatformAdmin =
      req.auth.isSuperAdmin ||
      req.auth.roles?.some((r) => ['ADMIN', 'SUPER_ADMIN', 'OPERATIONS'].includes(r));
    const isStoreOwner = req.auth.merchantIds?.includes(merchantId);
    if (!isPlatformAdmin && !isStoreOwner) {
      res.status(403).json({
        success: false,
        error: 'FORBIDDEN',
        message: 'You are not authorized to view settlement statements for this merchant.',
      });
      return;
    }
  }

  try {
    const statement = await sellerSettlementService.getSellerSettlementStatement(merchantId);
    res.status(200).json({
      success: true,
      statement,
    });
  } catch (err: any) {
    if (isDatabaseUnavailable(err)) {
      res.setHeader('Retry-After', '3');
      res.status(503).json({
        success: false,
        error: 'DATABASE_UNAVAILABLE',
        message: 'Database is temporarily unavailable. Please retry.',
        retryAfterSeconds: 3,
      });
      return;
    }

    const msg = (err.message || '').toLowerCase();
    if (msg.includes('merchant_not_found') || msg.includes('does not exist')) {
      res.status(404).json({
        success: false,
        error: 'MERCHANT_NOT_FOUND',
        message: err.message,
      });
      return;
    }

    res.status(500).json({
      success: false,
      error: 'STATEMENT_ERROR',
      message: err.message,
    });
  }
});

/**
 * POST /api/v1/settlements/seller/payout
 * Execute payout disbursement to merchant bank account
 * Authorization: Restricted to SUPER_ADMIN, FINANCE_ADMIN, or authorized store merchant owners
 */
settlementRouter.post('/seller/payout', authenticate, async (req: Request, res: Response): Promise<void> => {
  const { merchantId, amount } = req.body;
  if (!merchantId) {
    res.status(400).json({
      success: false,
      error: 'MISSING_MERCHANT_ID',
      message: 'merchantId is required in request body.',
    });
    return;
  }
  const rawIdemp = req.headers['idempotency-key'] || req.headers['x-idempotency-key'] || req.body.idempotencyKey;
  const idempotencyKey = (rawIdemp ? String(rawIdemp).trim() : `idemp_seller_${merchantId}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`);

  // Authorization Guard: Super Admin, Finance Admin, or caller must own the merchant store
  const isPlatformAdmin =
    req.auth?.isSuperAdmin ||
    req.auth?.roles?.some((r) => ['ADMIN', 'SUPER_ADMIN', 'FINANCE_ADMIN', 'OPERATIONS'].includes(r));
  const isStoreOwner = req.auth?.merchantIds?.includes(merchantId);

  if (!isPlatformAdmin && !isStoreOwner) {
    res.status(403).json({
      success: false,
      error: 'FORBIDDEN',
      message: 'You are not authorized to disburse payouts for this merchant.',
    });
    return;
  }

  try {
    const payout = await sellerSettlementService.executeSellerPayout({
      merchantId,
      amount: amount !== undefined ? parseFloat(amount) : undefined,
      idempotencyKey: idempotencyKey.trim(),
    });

    res.status(200).json({
      success: true,
      payout,
    });
  } catch (err: any) {
    if (isDatabaseUnavailable(err)) {
      res.setHeader('Retry-After', '3');
      res.status(503).json({
        success: false,
        error: 'DATABASE_UNAVAILABLE',
        message: 'Database is temporarily unavailable during payout. Please retry.',
        retryAfterSeconds: 3,
      });
      return;
    }

    const msg = (err.message || '').toLowerCase();
    if (msg.includes('merchant_not_found') || msg.includes('does not exist')) {
      res.status(404).json({
        success: false,
        error: 'MERCHANT_NOT_FOUND',
        message: err.message,
      });
      return;
    }

    if (
      msg.includes('insufficient_balance') ||
      msg.includes('invalid_bank_account') ||
      msg.includes('invalid_payout_amount') ||
      msg.includes('zero_payable_balance') ||
      msg.includes('exceeds')
    ) {
      res.status(400).json({
        success: false,
        error: 'INVALID_PAYOUT_REQUEST',
        message: err.message,
      });
      return;
    }

    res.status(400).json({
      success: false,
      error: 'PAYOUT_FAILED',
      message: err.message || 'Failed to process seller payout.',
    });
  }
});

/**
 * GET /api/v1/settlements/rider/:riderId/earnings
 * Retrieve rider earnings statement and floating cash position
 * Protected: Rider can only access their own statement, or Super Admin/Operations
 */
settlementRouter.get(
  '/rider/:riderId/earnings',
  authenticate,
  requireRiderOwnership('riderId'),
  async (req: Request, res: Response): Promise<void> => {
    const { riderId } = req.params;

    try {
      const statement = await riderPayoutService.getRiderEarningsStatement(riderId);
      res.status(200).json({
        success: true,
        statement,
      });
    } catch (err: any) {
      if (isDatabaseUnavailable(err)) {
        res.setHeader('Retry-After', '3');
        res.status(503).json({
          success: false,
          error: 'DATABASE_UNAVAILABLE',
          message: 'Database is temporarily unavailable. Please retry.',
          retryAfterSeconds: 3,
        });
        return;
      }

      const msg = (err.message || '').toLowerCase();
      if (msg.includes('rider_not_found') || msg.includes('does not exist')) {
        res.status(404).json({
          success: false,
          error: 'RIDER_NOT_FOUND',
          message: err.message,
        });
        return;
      }

      res.status(500).json({
        success: false,
        error: 'EARNINGS_STATEMENT_ERROR',
        message: err.message,
      });
    }
  }
);

/**
 * POST /api/v1/settlements/rider/payout
 * Execute instant or scheduled rider wallet withdrawal
 * Authorization: Restricted to SUPER_ADMIN, FINANCE_ADMIN, or the rider himself
 */
settlementRouter.post('/rider/payout', authenticate, async (req: Request, res: Response): Promise<void> => {
  const { riderId, amount, method } = req.body;
  if (!riderId) {
    res.status(400).json({
      success: false,
      error: 'MISSING_RIDER_ID',
      message: 'riderId is required in request body.',
    });
    return;
  }
  const rawIdemp = req.headers['idempotency-key'] || req.headers['x-idempotency-key'] || req.body.idempotencyKey;
  const idempotencyKey = (rawIdemp ? String(rawIdemp).trim() : `idemp_rider_${riderId}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`);

  // Authorization Guard: Super Admin, Finance Admin, or the rider himself
  const isPlatformAdmin =
    req.auth?.isSuperAdmin ||
    req.auth?.roles?.some((r) => ['ADMIN', 'SUPER_ADMIN', 'FINANCE_ADMIN', 'OPERATIONS'].includes(r));
  const isOwnRider = req.auth?.riderId === riderId;

  if (!isPlatformAdmin && !isOwnRider) {
    res.status(403).json({
      success: false,
      error: 'FORBIDDEN',
      message: 'You are not authorized to disburse payouts for this delivery partner.',
    });
    return;
  }

  try {
    const payout = await riderPayoutService.executeRiderPayout({
      riderId,
      amount: amount !== undefined ? parseFloat(amount) : undefined,
      method: method || 'UPI',
      idempotencyKey: idempotencyKey.trim(),
    });

    res.status(200).json({
      success: true,
      payout,
    });
  } catch (err: any) {
    if (isDatabaseUnavailable(err)) {
      res.setHeader('Retry-After', '3');
      res.status(503).json({
        success: false,
        error: 'DATABASE_UNAVAILABLE',
        message: 'Database is temporarily unavailable during rider payout. Please retry.',
        retryAfterSeconds: 3,
      });
      return;
    }

    const msg = (err.message || '').toLowerCase();
    if (msg.includes('rider_not_found') || msg.includes('does not exist')) {
      res.status(404).json({
        success: false,
        error: 'RIDER_NOT_FOUND',
        message: err.message,
      });
      return;
    }

    if (
      msg.includes('insufficient_balance') ||
      msg.includes('invalid_destination') ||
      msg.includes('payout_held') ||
      msg.includes('invalid_payout_amount') ||
      msg.includes('exceeds')
    ) {
      res.status(400).json({
        success: false,
        error: 'INVALID_PAYOUT_REQUEST',
        message: err.message,
      });
      return;
    }

    res.status(400).json({
      success: false,
      error: 'RIDER_PAYOUT_FAILED',
      message: err.message || 'Failed to process rider payout.',
    });
  }
});

/**
 * POST /api/v1/settlements/cod/remit
 * Rider remits collected Cash on Delivery funds via UPI or hub deposit
 */
settlementRouter.post('/cod/remit', authenticate, async (req: Request, res: Response): Promise<void> => {
  const { riderId, amount, method, reference } = req.body;

  if (!riderId || amount === undefined) {
    res.status(400).json({
      success: false,
      error: 'MISSING_FIELDS',
      message: 'riderId and amount are required.',
    });
    return;
  }

  try {
    const result = await riderPayoutService.remitCodCash({
      riderId,
      amount: parseFloat(amount),
      method: method || 'UPI',
      reference,
    });

    res.status(200).json({
      message: 'COD cash remitted successfully.',
      ...result,
    });
  } catch (err: any) {
    if (isDatabaseUnavailable(err)) {
      res.setHeader('Retry-After', '3');
      res.status(503).json({
        success: false,
        error: 'DATABASE_UNAVAILABLE',
        message: 'Database is temporarily unavailable during COD remittance. Please retry.',
        retryAfterSeconds: 3,
      });
      return;
    }

    const msg = (err.message || '').toLowerCase();
    if (msg.includes('rider_not_found') || msg.includes('does not exist')) {
      res.status(404).json({
        success: false,
        error: 'RIDER_NOT_FOUND',
        message: err.message,
      });
      return;
    }

    if (msg.includes('invalid_remittance_amount') || msg.includes('exceeds')) {
      res.status(400).json({
        success: false,
        error: 'INVALID_REMITTANCE_AMOUNT',
        message: err.message,
      });
      return;
    }

    res.status(400).json({
      success: false,
      error: 'COD_REMITTANCE_FAILED',
      message: err.message || 'Failed to process COD remittance.',
    });
  }
});

/**
 * GET /api/v1/settlements/reconciliation/trial-balance
 * Authoritative General Ledger Trial Balance check
 * Strictly restricted to Super Admin and Finance Admin roles
 */
settlementRouter.get(
  '/reconciliation/trial-balance',
  authenticate,
  requireRole(['SUPER_ADMIN', 'FINANCE_ADMIN']),
  async (_req: Request, res: Response): Promise<void> => {
    try {
      const trialBalance = await ledgerService.getTrialBalance();
      res.status(200).json({
        success: true,
        ...trialBalance,
      });
    } catch (err: any) {
      if (isDatabaseUnavailable(err)) {
        res.setHeader('Retry-After', '3');
        res.status(503).json({
          success: false,
          error: 'DATABASE_UNAVAILABLE',
          message: 'Database is temporarily unavailable. Please retry.',
          retryAfterSeconds: 3,
        });
        return;
      }

      res.status(500).json({
        success: false,
        error: 'TRIAL_BALANCE_ERROR',
        message: err.message,
      });
    }
  }
);

/**
 * POST /api/v1/settlements/seller/payout/:payoutId/reconcile
 * Safe reconciliation of unresolved seller payout with banking rail
 */
settlementRouter.post(
  "/seller/payout/:payoutId/reconcile",
  authenticate,
  requireRole(["SUPER_ADMIN", "FINANCE_ADMIN"]),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { payoutId } = req.params;
      const result = await sellerSettlementService.reconcileSellerPayout(payoutId);
      res.status(200).json({
        success: true,
        message: "Seller payout reconciled with provider.",
        payout: result,
      });
    } catch (err: any) {
      if (isDatabaseUnavailable(err)) {
        res.setHeader("Retry-After", "3");
        res.status(503).json({ success: false, error: "DATABASE_UNAVAILABLE", message: "Database temporarily unavailable.", retryAfterSeconds: 3 });
        return;
      }
      res.status(400).json({ success: false, error: "RECONCILIATION_FAILED", message: err.message });
    }
  }
);

/**
 * POST /api/v1/settlements/rider/payout/:payoutId/reconcile
 * Safe reconciliation of unresolved rider payout with banking rail
 */
settlementRouter.post(
  "/rider/payout/:payoutId/reconcile",
  authenticate,
  requireRole(["SUPER_ADMIN", "FINANCE_ADMIN"]),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { payoutId } = req.params;
      const result = await riderPayoutService.reconcileRiderPayout(payoutId);
      res.status(200).json({
        success: true,
        message: "Rider payout reconciled with provider.",
        payout: result,
      });
    } catch (err: any) {
      if (isDatabaseUnavailable(err)) {
        res.setHeader("Retry-After", "3");
        res.status(503).json({ success: false, error: "DATABASE_UNAVAILABLE", message: "Database temporarily unavailable.", retryAfterSeconds: 3 });
        return;
      }
      res.status(400).json({ success: false, error: "RECONCILIATION_FAILED", message: err.message });
    }
  }
);

/**
 * POST /api/v1/settlements/webhooks/payouts
 * Dedicated endpoint for banking payout webhook ingestion
 */
settlementRouter.post("/webhooks/payouts", handleWebhookRequest);
