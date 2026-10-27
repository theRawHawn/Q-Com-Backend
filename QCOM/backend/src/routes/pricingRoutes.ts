import { Router, Request, Response, NextFunction } from 'express';
import { getPool } from '../database/connection.js';
import { authenticate, optionalAuthenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { pricingEngine, PricingEngineError } from '../modules/pricing/pricingEngine.js';
import { taxEngine, TaxEngineError } from '../modules/pricing/taxEngine.js';
import { recordAuditEvent } from '../modules/audit/auditService.js';

export const pricingRouter = Router();

// Helper to detect database connection/availability failures
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
 * POST /api/v1/pricing/quote (Aliased: /quote, /calculate, /checkout-calculation)
 * Authoritative, Zero-Trust Checkout Pricing Calculation Engine Endpoint.
 *
 * NOTE: "Quote" is an internal implementation calculation snapshot object, NOT a customer quotation workflow.
 * Customer Journey: Cart -> Checkout -> Backend Checkout Calculation -> Customer Pays -> Place Order.
 */
const handleCheckoutCalculation = async (req: Request, res: Response): Promise<void> => {
  const pool = getPool();
  const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
  const requestId = (req as any).requestId || req.headers['x-request-id'] || 'req-pricing';

  try {
    // 1. Idempotency Check
    if (idempotencyKey && typeof idempotencyKey === 'string') {
      const cleanKey = idempotencyKey.trim().slice(0, 120);
      const existingKeyRes = await pool.query(
        `SELECT status, status_code, response_body FROM idempotency_keys WHERE idempotency_key = $1`,
        [cleanKey]
      );

      if (existingKeyRes.rows.length > 0) {
        const existing = existingKeyRes.rows[0];
        if (existing.status === 'COMPLETED') {
          res.status(existing.status_code || 200).json(existing.response_body);
          return;
        }
        if (existing.status === 'PROCESSING') {
          res.status(409).json({
            success: false,
            error: 'IDEMPOTENCY_CONFLICT',
            message: 'A checkout pricing calculation with this Idempotency-Key is currently in progress.',
            requestId,
          });
          return;
        }
      }

      // Insert PROCESSING state
      const actorId = req.auth?.userId || 'guest';
      await pool.query(
        `INSERT INTO idempotency_keys (idempotency_key, actor_id, endpoint, status, created_at, expires_at)
         VALUES ($1, $2, $3, 'PROCESSING', NOW(), NOW() + interval '24 hours')
         ON CONFLICT (idempotency_key) DO UPDATE SET status = 'PROCESSING'`,
        [cleanKey, actorId, req.originalUrl]
      );
    }
  } catch (err: any) {
    if (isDatabaseUnavailable(err)) {
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

  // 2. Extract and Sanitize Parameters (Disregarding any client-submitted monetary totals or prices)
  const {
    merchantId,
    storeId,
    items,
    placeOfSupplyStateCode,
    customerGstin,
    customerLocation,
    deliveryCoordinates,
    delivery_coordinates,
    distanceKm,
    couponCode,
    transactionDate,
  } = req.body;

  try {
    // Resolve merchantId automatically if not passed in guest or single-cart checkout
    let effectiveMerchantId = merchantId;
    if (!effectiveMerchantId && Array.isArray(items) && items.length > 0) {
      const firstPid = items[0]?.productId || items[0]?.id;
      if (firstPid) {
        const itemMerchantRes = await pool.query(
          `SELECT merchant_id FROM store_inventory WHERE product_id = $1 LIMIT 1`,
          [firstPid]
        );
        if (itemMerchantRes.rows.length > 0) {
          effectiveMerchantId = itemMerchantRes.rows[0].merchant_id;
        }
      }
      if (!effectiveMerchantId) {
        const defaultMerchantRes = await pool.query(
          `SELECT id FROM merchants WHERE status = 'ACTIVE' LIMIT 1`
        );
        if (defaultMerchantRes.rows.length > 0) {
          effectiveMerchantId = defaultMerchantRes.rows[0].id;
        }
      }
    }

    const rawCoords = customerLocation || deliveryCoordinates || delivery_coordinates;
    const effectiveLoc = rawCoords ? {
      latitude: rawCoords.latitude ?? rawCoords.lat ?? 12.9352,
      longitude: rawCoords.longitude ?? rawCoords.lng ?? 77.6245,
    } : undefined;

    const quote = await pricingEngine.calculate({
      merchantId: effectiveMerchantId,
      storeId,
      items: Array.isArray(items)
        ? items.map((i: any) => ({
            productId: String(i.productId || i.id || ''),
            quantity: Number(i.quantity || 1),
          }))
        : [],
      placeOfSupplyStateCode: placeOfSupplyStateCode || '29',
      customerGstin,
      customerLocation: effectiveLoc,
      distanceKm,
      couponCode,
      transactionDate,
      userId: req.auth?.userId,
      idempotencyKey,
    });

    const responseBody = {
      success: true,
      quote,
      checkoutCalculation: quote,
      pricingSnapshot: quote,
      requestId,
    };

    // Complete Idempotency record if key was provided
    if (idempotencyKey && typeof idempotencyKey === 'string') {
      const cleanKey = idempotencyKey.trim().slice(0, 120);
      try {
        await pool.query(
          `UPDATE idempotency_keys
              SET status = 'COMPLETED', status_code = 200, response_body = $1
            WHERE idempotency_key = $2`,
          [JSON.stringify(responseBody), cleanKey]
        );
      } catch (err: any) {
        if (isDatabaseUnavailable(err)) {
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
    if (idempotencyKey && typeof idempotencyKey === 'string') {
      const cleanKey = idempotencyKey.trim().slice(0, 120);
      try {
        await pool.query(
          `UPDATE idempotency_keys SET status = 'FAILED' WHERE idempotency_key = $1`,
          [cleanKey]
        );
      } catch {
        // Suppress if DB unavailable
      }
    }

    // Database Failure Rule: HTTP 503 + Retry-After: 3
    if (isDatabaseUnavailable(err)) {
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

    if (err instanceof PricingEngineError || err instanceof TaxEngineError) {
      res.status(err.statusCode).json({
        success: false,
        error: err.code,
        message: err.message,
        requestId,
      });
      return;
    }

    res.status(500).json({
      success: false,
      error: 'PRICING_CALCULATION_FAILED',
      message: err.message || 'An unexpected error occurred during pricing calculation.',
      requestId,
    });
  }
};

const quoteAuthMiddleware = (req: Request, res: Response, next: NextFunction) => {
  // Frontend customer app checkout calculation allows guest quote computation
  if (req.baseUrl.includes('checkout')) {
    return optionalAuthenticate(req, res, next);
  }
  // Authoritative server-side pricing engine route strictly requires authentication
  return authenticate(req, res, next);
};

pricingRouter.post('/quote', quoteAuthMiddleware, handleCheckoutCalculation);
pricingRouter.post('/calculate', optionalAuthenticate, handleCheckoutCalculation);
pricingRouter.post('/checkout-calculation', optionalAuthenticate, handleCheckoutCalculation);

/**
 * GET /api/v1/pricing/quote/:quoteId
 * Retrieves an immutable frozen pricing calculation snapshot.
 * Enforces ownership: Customer can only view their own quotes; Sellers only view quotes for their merchant.
 */
pricingRouter.get('/quote/:quoteId', authenticate, async (req: Request, res: Response): Promise<void> => {
  const { quoteId } = req.params;
  const pool = getPool();
  const requestId = (req as any).requestId || req.headers['x-request-id'] || 'req-pricing';

  try {
    const quote = await pricingEngine.getQuoteById(quoteId, pool);

    if (!quote) {
      res.status(404).json({
        success: false,
        error: 'QUOTE_NOT_FOUND',
        message: `Pricing quote '${quoteId}' was not found.`,
        requestId,
      });
      return;
    }

    // Ownership / Tenant Isolation Check
    const isGlobalAdmin =
      req.auth!.isSuperAdmin ||
      req.auth!.roles.includes('SUPER_ADMIN') ||
      req.auth!.roles.includes('OPERATIONS');

    if (!isGlobalAdmin) {
      const isOwnerCustomer = (quote as any).userId === req.auth!.userId;
      const isAuthorizedMerchant =
        req.auth!.merchantIds && req.auth!.merchantIds.includes(quote.merchantId);

      if (!isOwnerCustomer && !isAuthorizedMerchant) {
        await recordAuditEvent({
          actorId: req.auth!.userId,
          actorType: 'USER',
          action: 'CROSS_TENANT_QUOTE_INSPECTION_BLOCKED',
          entityType: 'PRICING_QUOTE',
          entityId: quoteId,
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'],
        });

        res.status(403).json({
          success: false,
          error: 'ACCESS_DENIED',
          message: 'Access forbidden: You do not have ownership or tenant authorization for this quote.',
          requestId,
        });
        return;
      }
    }

    res.status(200).json({
      success: true,
      quote,
      requestId,
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: 'SERVER_ERROR',
      message: err.message || 'Failed to fetch quote snapshot.',
      requestId,
    });
  }
});

/**
 * GET /api/v1/pricing/tax-rules
 * Administrative endpoint to list statutory tax rules with pagination, filtering, and sorting.
 * Protected by 'pricing.view' permission.
 */
pricingRouter.get(
  '/tax-rules',
  authenticate,
  requirePermission('pricing.view'),
  async (req: Request, res: Response): Promise<void> => {
    const pool = getPool();
    const requestId = (req as any).requestId || req.headers['x-request-id'] || 'req-pricing';

    // 1. Pagination & Sorting Allowlist
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '20'), 10) || 20));
    const offset = (page - 1) * limit;

    const allowedSortFields: Record<string, string> = {
      rule_code: 'rule_code',
      effective_from: 'effective_from',
      gst_rate_percent: 'gst_rate_percent',
      hsn_or_sac_code: 'hsn_or_sac_code',
      tax_type: 'tax_type',
    };

    const sortBy = allowedSortFields[String(req.query.sort_by || 'rule_code')] || 'rule_code';
    const sortOrder = String(req.query.sort_order || 'ASC').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

    // 2. Filtering
    const whereClauses: string[] = ['is_active = TRUE'];
    const queryParams: any[] = [];

    if (req.query.tax_type && typeof req.query.tax_type === 'string') {
      queryParams.push(req.query.tax_type);
      whereClauses.push(`tax_type = $${queryParams.length}`);
    }

    if (req.query.hsn_or_sac_code && typeof req.query.hsn_or_sac_code === 'string') {
      queryParams.push(req.query.hsn_or_sac_code);
      whereClauses.push(`hsn_or_sac_code = $${queryParams.length}`);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    try {
      const countRes = await pool.query(`SELECT COUNT(*) as count FROM statutory_tax_rules ${whereSql}`, queryParams);
      const total = parseInt(countRes.rows[0].count, 10);

      queryParams.push(limit);
      const limitParam = `$${queryParams.length}`;
      queryParams.push(offset);
      const offsetParam = `$${queryParams.length}`;

      const listRes = await pool.query(
        `SELECT id, rule_code, tax_type, hsn_or_sac_code, description, 
                effective_from, effective_to, gst_rate_percent, cgst_rate_percent, 
                sgst_rate_percent, igst_rate_percent, calculation_base, rounding_rule, statutory_reference
           FROM statutory_tax_rules
          ${whereSql}
          ORDER BY ${sortBy} ${sortOrder}
          LIMIT ${limitParam} OFFSET ${offsetParam}`,
        queryParams
      );

      res.status(200).json({
        success: true,
        taxRules: listRes.rows,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
        requestId,
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        error: 'FETCH_FAILED',
        message: err.message || 'Failed to list tax rules.',
        requestId,
      });
    }
  }
);

/**
 * GET /api/v1/pricing/delivery-rules
 * Lists active logistics fee slabs and handling charges.
 * Protected by 'pricing.view' permission.
 */
pricingRouter.get(
  '/delivery-rules',
  authenticate,
  requirePermission('pricing.view'),
  async (req: Request, res: Response): Promise<void> => {
    const pool = getPool();
    const requestId = (req as any).requestId || req.headers['x-request-id'] || 'req-pricing';

    try {
      const resRules = await pool.query(
        `SELECT id, rule_code, name, base_distance_km, base_fee_inr, per_km_fee_inr,
                free_delivery_threshold_inr, handling_fee_inr, platform_fee_inr,
                effective_from, effective_to, is_active
           FROM pricing_delivery_rules
          ORDER BY effective_from DESC`
      );

      res.status(200).json({
        success: true,
        deliveryRules: resRules.rows,
        requestId,
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        error: 'FETCH_FAILED',
        message: err.message || 'Failed to list delivery rules.',
        requestId,
      });
    }
  }
);

/**
 * PUT /api/v1/pricing/merchants/:merchantId/products/:productId/tax-declaration
 * Allows a seller to declare the HSN code and GST rate for their product catalogue.
 * Strictly enforces tenant ownership: Seller A cannot declare tax for Seller B's inventory.
 * Automatically flags non-standard rates for administrative compliance review.
 */
pricingRouter.put(
  '/merchants/:merchantId/products/:productId/tax-declaration',
  authenticate,
  async (req: Request, res: Response): Promise<void> => {
    const { merchantId, productId } = req.params;
    const { hsnCode, gstRatePercent, effectiveFrom } = req.body;
    const requestId = (req as any).requestId || req.headers['x-request-id'] || 'req-pricing';

    // 1. Tenant Ownership Enforcement
    const isGlobalAdmin =
      req.auth!.isSuperAdmin ||
      req.auth!.roles.includes('SUPER_ADMIN') ||
      req.auth!.roles.includes('OPERATIONS');

    const isAuthorizedSeller =
      req.auth!.merchantIds && req.auth!.merchantIds.includes(merchantId);

    if (!isGlobalAdmin && !isAuthorizedSeller) {
      await recordAuditEvent({
        actorId: req.auth!.userId,
        actorType: 'SELLER',
        action: 'CROSS_MERCHANT_TAX_DECLARATION_BLOCKED',
        entityType: 'MERCHANT',
        entityId: merchantId,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.status(403).json({
        success: false,
        error: 'TENANT_ACCESS_DENIED',
        message: 'Access forbidden: You cannot declare or modify product tax configuration for another merchant.',
        requestId,
      });
      return;
    }

    if (!hsnCode || gstRatePercent === undefined) {
      res.status(400).json({
        success: false,
        error: 'MISSING_FIELDS',
        message: 'hsnCode and gstRatePercent are required.',
        requestId,
      });
      return;
    }

    try {
      const declaredTax = await taxEngine.declareSellerProductTax({
        productId,
        merchantId,
        hsnCode: String(hsnCode),
        gstRatePercent,
        effectiveFrom: effectiveFrom ? String(effectiveFrom) : undefined,
        actorId: req.auth!.userId,
      });

      await recordAuditEvent({
        actorId: req.auth!.userId,
        actorType: 'SELLER',
        action: 'SELLER_PRODUCT_TAX_DECLARED',
        entityType: 'SELLER_PRODUCT_TAX',
        entityId: declaredTax.id,
        newState: declaredTax,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.status(200).json({
        success: true,
        message: declaredTax.adminReviewFlag
          ? 'Seller product tax declared with non-standard rate and flagged for administrative compliance review.'
          : 'Seller product tax declared and activated successfully.',
        sellerProductTax: declaredTax,
        requestId,
      });
    } catch (err: any) {
      if (err instanceof TaxEngineError) {
        res.status(err.statusCode).json({
          success: false,
          error: err.code,
          message: err.message,
          requestId,
        });
        return;
      }

      res.status(500).json({
        success: false,
        error: 'DECLARATION_FAILED',
        message: err.message || 'Failed to declare seller product tax.',
        requestId,
      });
    }
  }
);

/**
 * GET /api/v1/pricing/merchants/:merchantId/products/:productId/tax-declaration
 * Retrieves the seller's active product tax configuration.
 */
pricingRouter.get(
  '/merchants/:merchantId/products/:productId/tax-declaration',
  authenticate,
  async (req: Request, res: Response): Promise<void> => {
    const { merchantId, productId } = req.params;
    const requestId = (req as any).requestId || req.headers['x-request-id'] || 'req-pricing';
    const pool = getPool();

    const isGlobalAdmin =
      req.auth!.isSuperAdmin ||
      req.auth!.roles.includes('SUPER_ADMIN') ||
      req.auth!.roles.includes('OPERATIONS');

    const isAuthorizedSeller =
      req.auth!.merchantIds && req.auth!.merchantIds.includes(merchantId);

    if (!isGlobalAdmin && !isAuthorizedSeller) {
      res.status(403).json({
        success: false,
        error: 'TENANT_ACCESS_DENIED',
        message: 'Access forbidden: You cannot view product tax configuration for another merchant.',
        requestId,
      });
      return;
    }

    try {
      const resRecords = await pool.query(
        `SELECT * FROM seller_product_tax 
          WHERE product_id = $1 AND merchant_id = $2 
          ORDER BY effective_from DESC`,
        [productId, merchantId]
      );

      res.status(200).json({
        success: true,
        merchantId,
        productId,
        declarations: resRecords.rows,
        requestId,
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        error: 'FETCH_FAILED',
        message: err.message || 'Failed to fetch seller tax declarations.',
        requestId,
      });
    }
  }
);

/**
 * GET /api/v1/pricing/admin/tax/seller-reviews
 * Administrative review queue for non-standard or flagged seller tax declarations.
 * Protected by 'pricing.view' permission.
 */
pricingRouter.get(
  '/admin/tax/seller-reviews',
  authenticate,
  requirePermission('pricing.view'),
  async (req: Request, res: Response): Promise<void> => {
    const pool = getPool();
    const requestId = (req as any).requestId || req.headers['x-request-id'] || 'req-pricing';

    try {
      const reviewRes = await pool.query(
        `SELECT spt.*, p.name as product_name, p.sku, m.name as merchant_name, m.merchant_code
           FROM seller_product_tax spt
           JOIN products p ON p.id = spt.product_id
           JOIN merchants m ON m.id = spt.merchant_id
          WHERE spt.admin_review_flag = TRUE
          ORDER BY spt.created_at DESC`
      );

      res.status(200).json({
        success: true,
        flaggedDeclarations: reviewRes.rows,
        totalFlagged: reviewRes.rows.length,
        requestId,
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        error: 'FETCH_FAILED',
        message: err.message || 'Failed to fetch seller tax review queue.',
        requestId,
      });
    }
  }
);

import { sellerService } from '../modules/sellers/sellerService.js';

/**
 * GET /pricing-config & GET /checkout/pricing-config
 */
pricingRouter.get('/pricing-config', async (req: Request, res: Response): Promise<void> => {
  const pool = getPool();
  try {
    const configRes = await pool.query(`
      SELECT key, free_delivery_threshold, handling_fee, base_commission_percent, version
      FROM commercial_configs
      WHERE is_active = TRUE
      LIMIT 1
    `);
    const row = configRes.rows[0] || {
      free_delivery_threshold: 499.00,
      handling_fee: 10.00,
      base_commission_percent: 10.00,
      version: 'v1.1.0-qcom-admin-2026',
    };
    res.status(200).json({
      success: true,
      config: {
        freeDeliveryThreshold: parseFloat(row.free_delivery_threshold),
        handlingFee: parseFloat(row.handling_fee),
        baseCommissionPercent: parseFloat(row.base_commission_percent),
        version: row.version,
      },
    });
  } catch (err: any) {
    res.status(200).json({
      success: true,
      config: {
        freeDeliveryThreshold: 499.00,
        handlingFee: 10.00,
        baseCommissionPercent: 10.00,
        version: 'v1.1.0-qcom-admin-2026',
      },
    });
  }
});

/**
 * POST /pricing-config & POST /checkout/pricing-config
 */
pricingRouter.post('/pricing-config', async (req: Request, res: Response): Promise<void> => {
  const { freeDeliveryThreshold, handlingFee, baseCommissionPercent, version } = req.body;
  const pool = getPool();
  try {
    await pool.query(`
      INSERT INTO commercial_configs (key, free_delivery_threshold, handling_fee, base_commission_percent, version)
      VALUES ('default', $1, $2, $3, $4)
      ON CONFLICT (key) DO UPDATE
      SET free_delivery_threshold = EXCLUDED.free_delivery_threshold,
          handling_fee = EXCLUDED.handling_fee,
          base_commission_percent = EXCLUDED.base_commission_percent,
          version = EXCLUDED.version,
          updated_at = NOW()
    `, [
      freeDeliveryThreshold !== undefined ? freeDeliveryThreshold : 499.00,
      handlingFee !== undefined ? handlingFee : 10.00,
      baseCommissionPercent !== undefined ? baseCommissionPercent : 10.00,
      version || 'v1.1.0-qcom-admin-2026',
    ]);

    res.status(200).json({
      success: true,
      message: 'Commercial pricing configuration updated successfully.',
      config: {
        freeDeliveryThreshold: freeDeliveryThreshold ?? 499.00,
        handlingFee: handlingFee ?? 10.00,
        baseCommissionPercent: baseCommissionPercent ?? 10.00,
        version: version || 'v1.1.0-qcom-admin-2026',
      },
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: 'CONFIG_UPDATE_FAILED',
      message: err.message || 'Failed to update commercial configuration.',
    });
  }
});

/**
 * GET /sellers-geofence & GET /checkout/sellers-geofence
 */
pricingRouter.get('/sellers-geofence', async (req: Request, res: Response): Promise<void> => {
  try {
    const sellers = await sellerService.getSellerGeofences();
    res.status(200).json({
      success: true,
      sellers,
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: 'FETCH_FAILED',
      message: err.message || 'Failed to retrieve seller geofences.',
    });
  }
});

/**
 * POST /sellers-geofence/:sellerId & POST /checkout/sellers-geofence/:sellerId
 */
pricingRouter.post('/sellers-geofence/:sellerId', async (req: Request, res: Response): Promise<void> => {
  try {
    const { sellerId } = req.params;
    const updated = await sellerService.updateSellerGeofence(sellerId, req.body);
    res.status(200).json({
      success: true,
      message: 'Seller geofence updated successfully.',
      seller: updated,
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: 'UPDATE_FAILED',
      message: err.message || 'Failed to update seller geofence.',
    });
  }
});

/**
 * POST /api/v1/pricing/settlement/preview
 * Calculates contractual settlement preview separating Seller's Goods GST from QCOM's Commission & Service Fee GST.
 */
pricingRouter.post(
  '/settlement/preview',
  authenticate,
  async (req: Request, res: Response): Promise<void> => {
    const {
      merchantId,
      sellerGoodsTaxable,
      sellerGstRatePercent,
      commissionFlatInr,
      commissionRatePercent,
      commissionGstRatePercent,
      applyGstTcs,
      tcsRatePercent,
      applyWithholding,
      withholdingRatePercent,
      isInterState,
    } = req.body;
    const requestId = (req as any).requestId || req.headers['x-request-id'] || 'req-settlement';

    if (sellerGoodsTaxable === undefined || sellerGstRatePercent === undefined) {
      res.status(400).json({
        success: false,
        error: 'MISSING_FIELDS',
        message: 'sellerGoodsTaxable and sellerGstRatePercent are required.',
        requestId,
      });
      return;
    }

    try {
      let settlement;
      if (merchantId) {
        // Real-life merchant settlement: picks actual live commission rate, PAN status, constitution from database
        settlement = await taxEngine.calculateMerchantSettlement({
          merchantId: String(merchantId),
          sellerGoodsTaxable,
          sellerGstRatePercent,
          isInterState: Boolean(isInterState),
        });
      } else {
        settlement = await taxEngine.calculateSettlementPreview({
          sellerGoodsTaxable,
          sellerGstRatePercent,
          commissionFlatInr,
          commissionRatePercent,
          commissionGstRatePercent,
          applyGstTcs: Boolean(applyGstTcs),
          tcsRatePercent,
          applyWithholding: Boolean(applyWithholding),
          withholdingRatePercent,
        });
      }

      res.status(200).json({
        success: true,
        settlement,
        requestId,
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        error: 'SETTLEMENT_PREVIEW_FAILED',
        message: err.message || 'Failed to calculate settlement preview.',
        requestId,
      });
    }
  }
);



