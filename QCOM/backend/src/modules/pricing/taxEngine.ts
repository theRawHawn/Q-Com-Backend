import pg from 'pg';
import BigNumber from 'bignumber.js';
import { getPool } from '../../database/connection.js';
import {
  StatutoryTaxRuleRecord,
  SellerProductTaxRecord,
  GstTcsBreakdown,
  WithholdingBreakdown,
  TaxCategory,
} from './pricingTypes.js';
import {
  toDecimal,
  roundCurrency,
  multiply,
  divide,
  add,
  subtract,
} from './money.js';

export class TaxEngineError extends Error {
  code: string;
  statusCode: number;

  constructor(code: string, message: string, statusCode: number = 422) {
    super(message);
    this.name = 'TaxEngineError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const VALID_TAX_CATEGORIES: ReadonlySet<string> = new Set([
  'TAXABLE',
  'EXEMPT',
  'NIL_RATED',
  'ZERO_RATED',
]);

export class TaxEngine {
  /**
   * Formats Date to YYYY-MM-DD for SQL comparison
   */
  private formatDate(date: Date): string {
    return date.toISOString().split('T')[0];
  }

  // =========================================================================
  // STATUTORY PLACE OF SUPPLY & INDIAN STATE MASTER VALIDATION
  // =========================================================================

  /**
   * Validates a 2-digit Indian GST state/UT code against the `indian_states` master table.
   * Rejects fabricated or inactive codes with 422 INVALID_STATE_CODE.
   */
  async validateStateCode(
    stateCode: string,
    poolOverride?: pg.Pool | pg.PoolClient
  ): Promise<{ code: string; name: string; isUnionTerritory: boolean }> {
    const clean = (stateCode || '').trim();
    if (!/^[0-9]{2}$/.test(clean)) {
      throw new TaxEngineError(
        'INVALID_STATE_CODE',
        `State code '${stateCode}' must be a valid 2-digit Indian GST state/UT code.`,
        422
      );
    }

    const runner = poolOverride || getPool();
    const res = await runner.query(
      `SELECT code, name, is_union_territory, is_active FROM indian_states WHERE code = $1`,
      [clean]
    );

    if (res.rows.length === 0 || res.rows[0].is_active === false) {
      throw new TaxEngineError(
        'INVALID_STATE_CODE',
        `State code '${clean}' is not an active Indian GST state/UT code.`,
        422
      );
    }

    return {
      code: res.rows[0].code,
      name: res.rows[0].name,
      isUnionTerritory: Boolean(res.rows[0].is_union_territory),
    };
  }

  /**
   * Returns human-readable state name from `indian_states` or null if unknown.
   */
  async getStateName(
    stateCode: string | null | undefined,
    poolOverride?: pg.Pool | pg.PoolClient
  ): Promise<string | null> {
    if (!stateCode) return null;
    const runner = poolOverride || getPool();
    const res = await runner.query(
      `SELECT name FROM indian_states WHERE code = $1 LIMIT 1`,
      [stateCode.trim()]
    );
    return res.rows.length > 0 ? res.rows[0].name : null;
  }

  /**
   * Authoritatively resolves Place of Supply without hardcoded fallbacks.
   * Priority order:
   *  1. Explicit `placeOfSupplyStateCode` (validated against `indian_states`)
   *  2. Valid `customerGstin` prefix (first 2 digits validated)
   *  3. Explicit `deliveryAddressId` -> `saved_addresses.state_code`
   *  4. Customer's `saved_addresses.state_code` / `saved_gstins.state_code`
   *  5. Seller's `merchantStateCode` (validated)
   */
  async resolvePlaceOfSupply(
    params: {
      explicitStateCode?: string | null;
      customerGstin?: string | null;
      deliveryAddressId?: string | null;
      userId?: string | null;
      merchantStateCode: string;
    },
    poolOverride?: pg.Pool | pg.PoolClient
  ): Promise<{
    stateCode: string;
    stateName: string;
    source: 'EXPLICIT' | 'CUSTOMER_GSTIN' | 'DELIVERY_ADDRESS' | 'SAVED_ADDRESS' | 'SAVED_GSTIN' | 'MERCHANT_STATE';
  }> {
    const runner = poolOverride || getPool();

    if (params.explicitStateCode && params.explicitStateCode.trim() !== '') {
      const state = await this.validateStateCode(params.explicitStateCode, runner);
      return { stateCode: state.code, stateName: state.name, source: 'EXPLICIT' };
    }

    if (params.customerGstin && params.customerGstin.trim().length >= 2) {
      const prefix = params.customerGstin.trim().slice(0, 2);
      if (/^[0-9]{2}$/.test(prefix)) {
        const state = await this.validateStateCode(prefix, runner);
        return { stateCode: state.code, stateName: state.name, source: 'CUSTOMER_GSTIN' };
      }
    }

    if (params.deliveryAddressId && params.userId) {
      const addrRes = await runner.query(
        `SELECT state_code FROM saved_addresses WHERE id = $1 AND user_id = $2 LIMIT 1`,
        [params.deliveryAddressId, params.userId]
      );
      if (addrRes.rows.length > 0 && addrRes.rows[0].state_code) {
        const state = await this.validateStateCode(addrRes.rows[0].state_code, runner);
        return { stateCode: state.code, stateName: state.name, source: 'DELIVERY_ADDRESS' };
      }
    }

    if (params.userId) {
      const defaultAddrRes = await runner.query(
        `SELECT state_code FROM saved_addresses
          WHERE user_id = $1 AND state_code IS NOT NULL
          ORDER BY created_at DESC LIMIT 1`,
        [params.userId]
      );
      if (defaultAddrRes.rows.length > 0 && defaultAddrRes.rows[0].state_code) {
        const state = await this.validateStateCode(defaultAddrRes.rows[0].state_code, runner);
        return { stateCode: state.code, stateName: state.name, source: 'SAVED_ADDRESS' };
      }

      const gstinRes = await runner.query(
        `SELECT state_code FROM saved_gstins
          WHERE user_id = $1 AND state_code IS NOT NULL
          ORDER BY is_default DESC, created_at DESC LIMIT 1`,
        [params.userId]
      );
      if (gstinRes.rows.length > 0 && gstinRes.rows[0].state_code) {
        const state = await this.validateStateCode(gstinRes.rows[0].state_code, runner);
        return { stateCode: state.code, stateName: state.name, source: 'SAVED_GSTIN' };
      }
    }

    const merchState = await this.validateStateCode(params.merchantStateCode, runner);
    return { stateCode: merchState.code, stateName: merchState.name, source: 'MERCHANT_STATE' };
  }

  // =========================================================================
  // BUCKET A: SELLER'S GOODS TAX (Seller declared on product catalogue)
  // =========================================================================

  /**
   * Resolves the authoritative Seller-Declared Product GST & Cess Configuration.
   * Fail-closed: rejects unverified or incomplete tax classifications with 422 MISSING_TAX_CLASSIFICATION,
   * and enforces zero GST/Cess for EXEMPT / NIL_RATED / ZERO_RATED items.
   */
  async resolveSellerProductTax(
    productId: string,
    merchantId: string,
    transactionDate: Date = new Date(),
    poolOverride?: pg.Pool | pg.PoolClient
  ): Promise<{
    ruleId: string;
    ruleCode: string;
    hsnCode: string;
    gstRatePercent: string;
    cessRatePercent: string;
    taxCategory: TaxCategory;
    taxInclusive: boolean;
    taxRateSource: 'SELLER_DECLARED' | 'FALLBACK_CATALOG';
    status: string;
    adminReviewFlag: boolean;
  }> {
    const runner = poolOverride || getPool();
    const dateStr = this.formatDate(transactionDate);

    // Fetch catalog metadata first so verification flag & defaults are authoritative
    const prodRes = await runner.query(
      `SELECT id, sku, hsn_code, gst_rate_percent, cess_rate_percent, tax_category, tax_inclusive, is_tax_classification_verified
         FROM products
        WHERE id = $1`,
      [productId]
    );

    if (prodRes.rows.length > 0 && prodRes.rows[0].is_tax_classification_verified === false) {
      throw new TaxEngineError(
        'MISSING_TAX_CLASSIFICATION',
        `Product '${prodRes.rows[0].sku || productId}' does not have verified GST/HSN classification and cannot be transacted.`,
        422
      );
    }

    // 1. Look up in seller_product_tax table
    const sellerTaxRes = await runner.query(
      `SELECT id, product_id, merchant_id, hsn_code, gst_rate_percent,
              cess_rate_percent, tax_category, tax_inclusive,
              tax_rate_source, status, admin_review_flag, effective_from, effective_to
         FROM seller_product_tax
        WHERE product_id = $1
          AND merchant_id = $2
          AND status = 'ACTIVE'
          AND effective_from <= $3::date
          AND (effective_to IS NULL OR effective_to >= $3::date)
        ORDER BY effective_from DESC
        LIMIT 1`,
      [productId, merchantId, dateStr]
    );

    if (sellerTaxRes.rows.length > 0) {
      const row = sellerTaxRes.rows[0];
      const taxCategory = (row.tax_category || prodRes.rows[0]?.tax_category || 'TAXABLE') as TaxCategory;
      const gstRateBn = toDecimal(row.gst_rate_percent);
      const cessRateBn = toDecimal(row.cess_rate_percent ?? prodRes.rows[0]?.cess_rate_percent ?? 0);
      const taxInclusive = Boolean(row.tax_inclusive ?? prodRes.rows[0]?.tax_inclusive ?? false);

      this.validateCategoryRates(taxCategory, gstRateBn, cessRateBn, row.hsn_code);

      return {
        ruleId: row.id,
        ruleCode: `SELLER_TAX_${row.hsn_code}`,
        hsnCode: row.hsn_code,
        gstRatePercent: gstRateBn.toFixed(2),
        cessRatePercent: cessRateBn.toFixed(2),
        taxCategory,
        taxInclusive,
        taxRateSource: 'SELLER_DECLARED',
        status: row.status,
        adminReviewFlag: Boolean(row.admin_review_flag),
      };
    }

    // 2. Fallback to catalog product specification
    if (prodRes.rows.length > 0) {
      const p = prodRes.rows[0];
      if (!p.hsn_code || String(p.hsn_code).trim() === '' || p.gst_rate_percent === null || p.gst_rate_percent === undefined) {
        throw new TaxEngineError(
          'MISSING_TAX_CLASSIFICATION',
          `Product '${p.sku || productId}' is missing statutory HSN code or GST rate.`,
          422
        );
      }
      const taxCategory = (p.tax_category || 'TAXABLE') as TaxCategory;
      const gstRateBn = toDecimal(p.gst_rate_percent);
      const cessRateBn = toDecimal(p.cess_rate_percent ?? 0);
      const taxInclusive = Boolean(p.tax_inclusive ?? false);

      this.validateCategoryRates(taxCategory, gstRateBn, cessRateBn, p.hsn_code);

      return {
        ruleId: p.id,
        ruleCode: `CATALOG_TAX_${p.hsn_code}`,
        hsnCode: p.hsn_code,
        gstRatePercent: gstRateBn.toFixed(2),
        cessRatePercent: cessRateBn.toFixed(2),
        taxCategory,
        taxInclusive,
        taxRateSource: 'FALLBACK_CATALOG',
        status: 'ACTIVE',
        adminReviewFlag: false,
      };
    }

    throw new TaxEngineError(
      'MISSING_TAX_CLASSIFICATION',
      `No seller product tax or catalogue configuration found for product '${productId}'.`,
      422
    );
  }

  private validateCategoryRates(
    taxCategory: string,
    gstRateBn: BigNumber,
    cessRateBn: BigNumber,
    hsnCode: string
  ): void {
    if (!VALID_TAX_CATEGORIES.has(taxCategory)) {
      throw new TaxEngineError(
        'INVALID_TAX_CLASSIFICATION',
        `Unsupported tax category '${taxCategory}' for HSN '${hsnCode}'.`,
        422
      );
    }
    if (!hsnCode || hsnCode.trim().length < 2) {
      throw new TaxEngineError(
        'MISSING_TAX_CLASSIFICATION',
        'Valid HSN code is mandatory for GST calculation.',
        422
      );
    }
    if (taxCategory !== 'TAXABLE' && (gstRateBn.isGreaterThan(0) || cessRateBn.isGreaterThan(0))) {
      throw new TaxEngineError(
        'INVALID_TAX_CLASSIFICATION',
        `Tax category '${taxCategory}' must have 0% GST and 0% Cess (received ${gstRateBn.toFixed(2)}% GST, ${cessRateBn.toFixed(2)}% Cess).`,
        422
      );
    }
  }

  /**
   * Declares or updates a seller's product GST rate, HSN code, tax category, Cess rate, and inclusivity mode.
   */
  async declareSellerProductTax(
    params: {
      productId: string;
      merchantId: string;
      hsnCode: string;
      gstRatePercent: number | string;
      cessRatePercent?: number | string;
      taxCategory?: TaxCategory;
      taxInclusive?: boolean;
      effectiveFrom?: string;
      actorId?: string;
    },
    poolOverride?: pg.Pool | pg.PoolClient
  ): Promise<SellerProductTaxRecord> {
    const runner = poolOverride || getPool();
    const rateBn = toDecimal(params.gstRatePercent);
    const cessBn = toDecimal(params.cessRatePercent ?? 0);
    const taxCategory: TaxCategory = params.taxCategory || 'TAXABLE';
    const taxInclusive = Boolean(params.taxInclusive ?? false);

    if (rateBn.isLessThan(0) || rateBn.isGreaterThan(100)) {
      throw new TaxEngineError('INVALID_GST_RATE', 'GST rate percent must be between 0% and 100%.', 400);
    }
    if (cessBn.isLessThan(0) || cessBn.isGreaterThan(100)) {
      throw new TaxEngineError('INVALID_GST_RATE', 'Cess rate percent must be between 0% and 100%.', 400);
    }

    const cleanHsn = params.hsnCode.trim();
    if (!cleanHsn || cleanHsn.length < 2) {
      throw new TaxEngineError('INVALID_HSN_CODE', 'A valid HSN code is required.', 400);
    }

    this.validateCategoryRates(taxCategory, rateBn, cessBn, cleanHsn);

    // Dynamic database-driven standard slabs check: queries active statutory tax rules in PostgreSQL
    const ratesRes = await runner.query(
      `SELECT DISTINCT gst_rate_percent FROM statutory_tax_rules WHERE is_active = TRUE`
    );
    const validDbSlabs = ratesRes.rows.map(r => toDecimal(r.gst_rate_percent).toNumber());
    const standardSlabs = Array.from(new Set([...validDbSlabs, 0, 5, 12, 18, 28]));
    const isStandard = standardSlabs.includes(rateBn.toNumber());
    const adminReviewFlag = !isStandard;
    const adminReviewNotes = !isStandard
      ? `Non-standard GST rate (${rateBn.toFixed(2)}%) declared by seller. Pending administrative review.`
      : null;

    const halfRate = divide(rateBn, 2);
    const effectiveFrom = params.effectiveFrom || this.formatDate(new Date());

    const res = await runner.query(
      `INSERT INTO seller_product_tax
        (product_id, merchant_id, hsn_code, gst_rate_percent, cgst_rate_percent, sgst_rate_percent, igst_rate_percent,
         cess_rate_percent, tax_category, tax_inclusive,
         tax_rate_source, status, admin_review_flag, admin_review_notes, effective_from, seller_declared_at, created_at, updated_at)
       VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'SELLER_DECLARED', 'ACTIVE', $11, $12, $13::date, NOW(), NOW(), NOW())
       ON CONFLICT (product_id, merchant_id, effective_from)
       DO UPDATE SET
        hsn_code = EXCLUDED.hsn_code,
        gst_rate_percent = EXCLUDED.gst_rate_percent,
        cgst_rate_percent = EXCLUDED.cgst_rate_percent,
        sgst_rate_percent = EXCLUDED.sgst_rate_percent,
        igst_rate_percent = EXCLUDED.igst_rate_percent,
        cess_rate_percent = EXCLUDED.cess_rate_percent,
        tax_category = EXCLUDED.tax_category,
        tax_inclusive = EXCLUDED.tax_inclusive,
        admin_review_flag = EXCLUDED.admin_review_flag,
        admin_review_notes = EXCLUDED.admin_review_notes,
        updated_at = NOW()
       RETURNING *`,
      [
        params.productId,
        params.merchantId,
        cleanHsn,
        rateBn.toFixed(2),
        halfRate.toFixed(2),
        halfRate.toFixed(2),
        rateBn.toFixed(2),
        cessBn.toFixed(2),
        taxCategory,
        taxInclusive,
        adminReviewFlag,
        adminReviewNotes,
        effectiveFrom,
      ]
    );

    const row = res.rows[0];
    return {
      id: row.id,
      productId: row.product_id,
      merchantId: row.merchant_id,
      hsnCode: row.hsn_code,
      gstRatePercent: toDecimal(row.gst_rate_percent).toFixed(2),
      cgstRatePercent: toDecimal(row.cgst_rate_percent).toFixed(2),
      sgstRatePercent: toDecimal(row.sgst_rate_percent).toFixed(2),
      igstRatePercent: toDecimal(row.igst_rate_percent).toFixed(2),
      cessRatePercent: toDecimal(row.cess_rate_percent ?? 0).toFixed(2),
      taxCategory: (row.tax_category || 'TAXABLE') as TaxCategory,
      taxInclusive: Boolean(row.tax_inclusive),
      taxRateSource: row.tax_rate_source,
      status: row.status,
      adminReviewFlag: Boolean(row.admin_review_flag),
      adminReviewNotes: row.admin_review_notes,
      effectiveFrom: this.formatDate(new Date(row.effective_from)),
      effectiveTo: row.effective_to ? this.formatDate(new Date(row.effective_to)) : null,
      sellerDeclaredAt: row.seller_declared_at,
      verifiedAt: row.verified_at,
    };
  }

  // =========================================================================
  // BUCKET B: QCOM SERVICE & CHARGES TAX (SAC 9968 Delivery, 9985 Handling, 9983 Commission)
  // =========================================================================

  /**
   * Resolves the authoritative effective-dated statutory tax rule for QCOM services.
   */
  async resolveTaxRule(
    hsnOrSac: string,
    taxType: 'PRODUCT_GST' | 'DELIVERY_GST' | 'HANDLING_GST' | 'COMMISSION_GST',
    transactionDate: Date = new Date(),
    poolOverride?: pg.Pool | pg.PoolClient
  ): Promise<StatutoryTaxRuleRecord> {
    const runner = poolOverride || getPool();
    const dateStr = this.formatDate(transactionDate);

    const res = await runner.query(
      `SELECT id, rule_code, tax_type, hsn_or_sac_code, description,
              effective_from, effective_to,
              gst_rate_percent, cgst_rate_percent, sgst_rate_percent, igst_rate_percent,
              calculation_base, rounding_rule, statutory_reference
         FROM statutory_tax_rules
        WHERE hsn_or_sac_code = $1
          AND tax_type = $2
          AND is_active = TRUE
          AND effective_from <= $3::date
          AND (effective_to IS NULL OR effective_to >= $3::date)
        ORDER BY effective_from DESC`,
      [hsnOrSac, taxType, dateStr]
    );

    if (res.rows.length === 0) {
      throw new TaxEngineError(
        'TAX_RULE_NOT_FOUND',
        `No applicable statutory tax rule found for code '${hsnOrSac}' (type: ${taxType}) on date ${dateStr}.`,
        422
      );
    }

    if (res.rows.length > 1) {
      throw new TaxEngineError(
        'TAX_RULE_CONFLICT',
        `Multiple conflicting statutory tax rules (${res.rows.length}) matched for code '${hsnOrSac}' on date ${dateStr}.`,
        409
      );
    }

    const row = res.rows[0];
    return {
      id: row.id,
      rule_code: row.rule_code,
      tax_type: row.tax_type,
      hsn_or_sac_code: row.hsn_or_sac_code,
      description: row.description,
      effective_from: this.formatDate(new Date(row.effective_from)),
      effective_to: row.effective_to ? this.formatDate(new Date(row.effective_to)) : null,
      gst_rate_percent: toDecimal(row.gst_rate_percent).toFixed(2),
      cgst_rate_percent: toDecimal(row.cgst_rate_percent).toFixed(2),
      sgst_rate_percent: toDecimal(row.sgst_rate_percent).toFixed(2),
      igst_rate_percent: toDecimal(row.igst_rate_percent).toFixed(2),
      calculation_base: row.calculation_base,
      rounding_rule: row.rounding_rule,
      statutory_reference: row.statutory_reference,
    };
  }

  /**
   * Dynamically resolves active statutory service tax rule directly by tax_type
   */
  async resolveServiceTaxRule(
    taxType: 'DELIVERY_GST' | 'HANDLING_GST' | 'COMMISSION_GST',
    transactionDate: Date = new Date(),
    poolOverride?: pg.Pool | pg.PoolClient
  ): Promise<StatutoryTaxRuleRecord> {
    const runner = poolOverride || getPool();
    const dateStr = this.formatDate(transactionDate);

    const res = await runner.query(
      `SELECT id, rule_code, tax_type, hsn_or_sac_code, description,
              effective_from, effective_to,
              gst_rate_percent, cgst_rate_percent, sgst_rate_percent, igst_rate_percent,
              calculation_base, rounding_rule, statutory_reference
         FROM statutory_tax_rules
        WHERE tax_type = $1
          AND is_active = TRUE
          AND effective_from <= $2::date
          AND (effective_to IS NULL OR effective_to >= $2::date)
        ORDER BY effective_from DESC`,
      [taxType, dateStr]
    );

    if (res.rows.length === 0) {
      throw new TaxEngineError(
        'TAX_RULE_NOT_FOUND',
        `No applicable statutory service tax rule found in database for tax_type '${taxType}' on date ${dateStr}.`,
        422
      );
    }

    if (res.rows.length > 1 && res.rows[0].effective_from === res.rows[1].effective_from) {
      throw new TaxEngineError(
        'TAX_RULE_CONFLICT',
        `Multiple conflicting statutory tax rules matched for tax_type '${taxType}' on date ${dateStr}.`,
        409
      );
    }

    const row = res.rows[0];
    return {
      id: row.id,
      rule_code: row.rule_code,
      tax_type: row.tax_type,
      hsn_or_sac_code: row.hsn_or_sac_code,
      description: row.description,
      effective_from: this.formatDate(new Date(row.effective_from)),
      effective_to: row.effective_to ? this.formatDate(new Date(row.effective_to)) : null,
      gst_rate_percent: toDecimal(row.gst_rate_percent).toFixed(2),
      cgst_rate_percent: toDecimal(row.cgst_rate_percent).toFixed(2),
      sgst_rate_percent: toDecimal(row.sgst_rate_percent).toFixed(2),
      igst_rate_percent: toDecimal(row.igst_rate_percent).toFixed(2),
      calculation_base: row.calculation_base,
      rounding_rule: row.rounding_rule,
      statutory_reference: row.statutory_reference,
    };
  }

  /**
   * Extracts taxable base, CGST/SGST/IGST, and Cess from a tax-inclusive gross amount
   * using exact BigNumber arithmetic and deterministic 1-paisa base rounding reconciliation
   * so base + cgst + sgst + igst + cess === roundCurrency(inclusiveGross) strictly.
   */
  extractInclusiveBaseAndTaxes(params: {
    inclusiveGross: string | BigNumber;
    gstRatePercent: string | BigNumber;
    cessRatePercent?: string | BigNumber;
    taxCategory?: TaxCategory;
    merchantStateCode: string;
    placeOfSupplyStateCode: string;
  }): {
    isInterState: boolean;
    taxableAmount: string;
    gstRatePercent: string;
    cgstRatePercent: string;
    cgstAmount: string;
    sgstRatePercent: string;
    sgstAmount: string;
    igstRatePercent: string;
    igstAmount: string;
    cessRatePercent: string;
    cessAmount: string;
    totalGstAmount: string;
    totalTaxWithCessAmount: string;
    inclusiveTotal: string;
  } {
    const grossRounded = roundCurrency(params.inclusiveGross);
    const grossBn = toDecimal(grossRounded);
    const isExemptCategory = params.taxCategory && params.taxCategory !== 'TAXABLE';
    const gstRateBn = isExemptCategory ? new BigNumber(0) : toDecimal(params.gstRatePercent);
    const cessRateBn = isExemptCategory ? new BigNumber(0) : toDecimal(params.cessRatePercent ?? 0);
    const isInterState = params.merchantStateCode.trim() !== params.placeOfSupplyStateCode.trim();

    const combinedRatePct = add(gstRateBn, cessRateBn);
    if (combinedRatePct.isZero() || grossBn.isZero()) {
      return {
        isInterState,
        taxableAmount: grossRounded,
        gstRatePercent: gstRateBn.toFixed(2),
        cgstRatePercent: isInterState ? '0.00' : divide(gstRateBn, 2).toFixed(2),
        cgstAmount: '0.00',
        sgstRatePercent: isInterState ? '0.00' : divide(gstRateBn, 2).toFixed(2),
        sgstAmount: '0.00',
        igstRatePercent: isInterState ? gstRateBn.toFixed(2) : '0.00',
        igstAmount: '0.00',
        cessRatePercent: cessRateBn.toFixed(2),
        cessAmount: '0.00',
        totalGstAmount: '0.00',
        totalTaxWithCessAmount: '0.00',
        inclusiveTotal: grossRounded,
      };
    }

    const divisor = add(1, divide(combinedRatePct, 100));
    const rawBaseBn = divide(grossBn, divisor);
    let baseRounded = roundCurrency(rawBaseBn);

    const calc = this.calculateGst({
      taxableAmount: baseRounded,
      taxRule: { gst_rate_percent: gstRateBn.toFixed(2) },
      cessRatePercent: cessRateBn.toFixed(2),
      taxCategory: params.taxCategory,
      merchantStateCode: params.merchantStateCode,
      placeOfSupplyStateCode: params.placeOfSupplyStateCode,
    });

    const computedSum = add(baseRounded, calc.totalTaxWithCessAmount);
    const diff = subtract(grossBn, computedSum);
    if (!diff.isZero()) {
      baseRounded = roundCurrency(add(baseRounded, diff));
    }

    return {
      isInterState: calc.isInterState,
      taxableAmount: baseRounded,
      gstRatePercent: calc.gstRatePercent,
      cgstRatePercent: calc.cgstRatePercent,
      cgstAmount: calc.cgstAmount,
      sgstRatePercent: calc.sgstRatePercent,
      sgstAmount: calc.sgstAmount,
      igstRatePercent: calc.igstRatePercent,
      igstAmount: calc.igstAmount,
      cessRatePercent: calc.cessRatePercent,
      cessAmount: calc.cessAmount,
      totalGstAmount: calc.totalGstAmount,
      totalTaxWithCessAmount: calc.totalTaxWithCessAmount,
      inclusiveTotal: grossRounded,
    };
  }

  /**
   * Calculates GST & Cess breakdown for a line item or charge based on place of supply (intra-state vs inter-state).
   */
  calculateGst(params: {
    taxableAmount: string | BigNumber;
    taxRule: { gst_rate_percent: string; rule_code?: string; id?: string };
    cessRatePercent?: string | BigNumber;
    taxCategory?: TaxCategory;
    merchantStateCode: string;
    placeOfSupplyStateCode: string;
  }): {
    isInterState: boolean;
    gstRatePercent: string;
    cgstRatePercent: string;
    cgstAmount: string;
    sgstRatePercent: string;
    sgstAmount: string;
    igstRatePercent: string;
    igstAmount: string;
    cessRatePercent: string;
    cessAmount: string;
    totalGstAmount: string;
    totalTaxWithCessAmount: string;
  } {
    const { taxableAmount, taxRule, merchantStateCode, placeOfSupplyStateCode, taxCategory } = params;
    const taxableBn = toDecimal(taxableAmount);
    const isExemptCategory = taxCategory && taxCategory !== 'TAXABLE';
    const gstRateBn = isExemptCategory ? new BigNumber(0) : toDecimal(taxRule.gst_rate_percent);
    const cessRateBn = isExemptCategory ? new BigNumber(0) : toDecimal(params.cessRatePercent ?? 0);

    const isInterState = merchantStateCode.trim() !== placeOfSupplyStateCode.trim();
    const cessAmt = roundCurrency(multiply(taxableBn, divide(cessRateBn, 100)));

    if (!isInterState) {
      // Intra-state supply: CGST (50%) + SGST (50%)
      const halfRate = divide(gstRateBn, 2);
      const cgstAmt = roundCurrency(multiply(taxableBn, divide(halfRate, 100)));
      const sgstAmt = roundCurrency(multiply(taxableBn, divide(halfRate, 100)));
      const totalGst = roundCurrency(add(cgstAmt, sgstAmt));
      const totalWithCess = roundCurrency(add(totalGst, cessAmt));

      return {
        isInterState: false,
        gstRatePercent: gstRateBn.toFixed(2),
        cgstRatePercent: halfRate.toFixed(2),
        cgstAmount: cgstAmt,
        sgstRatePercent: halfRate.toFixed(2),
        sgstAmount: sgstAmt,
        igstRatePercent: '0.00',
        igstAmount: '0.00',
        cessRatePercent: cessRateBn.toFixed(2),
        cessAmount: cessAmt,
        totalGstAmount: totalGst,
        totalTaxWithCessAmount: totalWithCess,
      };
    } else {
      // Inter-state supply: IGST (100%)
      const igstAmt = roundCurrency(multiply(taxableBn, divide(gstRateBn, 100)));
      const totalWithCess = roundCurrency(add(igstAmt, cessAmt));

      return {
        isInterState: true,
        gstRatePercent: gstRateBn.toFixed(2),
        cgstRatePercent: '0.00',
        cgstAmount: '0.00',
        sgstRatePercent: '0.00',
        sgstAmount: '0.00',
        igstRatePercent: gstRateBn.toFixed(2),
        igstAmount: igstAmt,
        cessRatePercent: cessRateBn.toFixed(2),
        cessAmount: cessAmt,
        totalGstAmount: igstAmt,
        totalTaxWithCessAmount: totalWithCess,
      };
    }
  }

  // =========================================================================
  // BUCKET C: STATUTORY COLLECTIONS (Section 52 GST-TCS & Section 393 TDS)
  // =========================================================================

  /**
   * Resolves Section 52 GST-TCS rule and calculates TCS amount on Net Taxable Supplies.
   */
  async resolveGstTcs(params: {
    netTaxableSupplies: string | BigNumber;
    isInterState: boolean;
    transactionDate?: Date;
    poolOverride?: pg.Pool | pg.PoolClient;
  }): Promise<GstTcsBreakdown> {
    const runner = params.poolOverride || getPool();
    const txnDate = params.transactionDate || new Date();
    const dateStr = this.formatDate(txnDate);
    const netTaxableBn = toDecimal(params.netTaxableSupplies);

    const res = await runner.query(
      `SELECT id, rule_code, statutory_provision, effective_from, effective_to,
              central_rate_percent, state_rate_percent, integrated_rate_percent,
              calculation_basis, reporting_form
         FROM gst_tcs_rules
        WHERE is_active = TRUE
          AND effective_from <= $1::date
          AND (effective_to IS NULL OR effective_to >= $1::date)
        ORDER BY effective_from DESC`,
      [dateStr]
    );

    if (res.rows.length === 0) {
      throw new TaxEngineError(
        'GST_TCS_RULE_NOT_FOUND',
        `No effective Section 52 GST-TCS rule found for transaction date ${dateStr}.`,
        422
      );
    }

    if (res.rows.length > 1 && res.rows[0].effective_from === res.rows[1].effective_from) {
      throw new TaxEngineError(
        'TAX_RULE_CONFLICT',
        `Conflicting Section 52 GST-TCS rules found for transaction date ${dateStr}.`,
        409
      );
    }

    const rule = res.rows[0];
    const centralRate = toDecimal(rule.central_rate_percent);
    const stateRate = toDecimal(rule.state_rate_percent);
    const integratedRate = toDecimal(rule.integrated_rate_percent);

    let centralAmt = '0.00';
    let stateAmt = '0.00';
    let integratedAmt = '0.00';
    let totalTcs = '0.00';

    if (!params.isInterState) {
      centralAmt = roundCurrency(multiply(netTaxableBn, divide(centralRate, 100)));
      stateAmt = roundCurrency(multiply(netTaxableBn, divide(stateRate, 100)));
      totalTcs = roundCurrency(add(centralAmt, stateAmt));
    } else {
      integratedAmt = roundCurrency(multiply(netTaxableBn, divide(integratedRate, 100)));
      totalTcs = integratedAmt;
    }

    return {
      ruleId: rule.id,
      ruleCode: rule.rule_code,
      statutoryProvision: rule.statutory_provision,
      calculationBasis: rule.calculation_basis,
      netTaxableSupplies: roundCurrency(netTaxableBn),
      centralRatePercent: centralRate.toFixed(3),
      centralAmount: centralAmt,
      stateRatePercent: stateRate.toFixed(3),
      stateAmount: stateAmt,
      integratedRatePercent: integratedRate.toFixed(3),
      integratedAmount: integratedAmt,
      totalTcsAmount: totalTcs,
      reportingForm: rule.reporting_form,
    };
  }

  /**
   * Resolves Direct Tax Withholding (TDS) rule under Income-tax Act 2025 (post-01-Apr-2026)
   * or legacy Income-tax Act 1961 (pre-01-Apr-2026).
   */
  async resolveWithholding(params: {
    grossTaxableAmount: string | BigNumber;
    merchantConstitution: string;
    merchantPanStatus: string;
    transactionDate?: Date;
    poolOverride?: pg.Pool | pg.PoolClient;
  }): Promise<WithholdingBreakdown> {
    const runner = params.poolOverride || getPool();
    const txnDate = params.transactionDate || new Date();
    const dateStr = this.formatDate(txnDate);
    const grossBn = toDecimal(params.grossTaxableAmount);

    const isNewAct2025 = txnDate.getTime() >= new Date('2026-04-01T00:00:00Z').getTime();
    const governingLaw = isNewAct2025 ? 'INCOME_TAX_ACT_2025' : 'INCOME_TAX_ACT_1961';

    const res = await runner.query(
      `SELECT id, rule_code, governing_law, statutory_provision, table_item,
              payee_type, pan_status, applicable_rate_percent, calculation_base,
              threshold_single_txn_inr, threshold_annual_aggregate_inr, statutory_reporting_form
         FROM statutory_withholding_rules
        WHERE governing_law = $1
          AND withholding_type = 'ECO_SALE_OF_GOODS'
          AND is_active = TRUE
          AND effective_from <= $2::date
          AND (effective_to IS NULL OR effective_to >= $2::date)
          AND (payee_type = $3 OR payee_type = 'ALL')
          AND (pan_status = $4 OR pan_status = 'ALL')
        ORDER BY (CASE WHEN payee_type != 'ALL' THEN 1 ELSE 2 END),
                 (CASE WHEN pan_status != 'ALL' THEN 1 ELSE 2 END)
        LIMIT 1`,
      [governingLaw, dateStr, params.merchantConstitution, params.merchantPanStatus]
    );

    if (res.rows.length === 0) {
      return {
        status: 'NOT_APPLICABLE',
        withholdingAmount: '0.00',
        reason: `No matching withholding rule for ${governingLaw} on ${dateStr}.`,
      };
    }

    const rule = res.rows[0];
    const rateBn = toDecimal(rule.applicable_rate_percent);
    const wthAmt = roundCurrency(multiply(grossBn, divide(rateBn, 100)));

    return {
      ruleId: rule.id,
      ruleCode: rule.rule_code,
      governingLaw: rule.governing_law,
      statutoryProvision: rule.statutory_provision,
      tableItem: rule.table_item,
      payeeType: rule.payee_type,
      panStatus: rule.pan_status,
      applicableRatePercent: rateBn.toFixed(3),
      withholdingAmount: wthAmt,
      reportingForm: rule.statutory_reporting_form,
      status: 'APPLICABLE',
    };
  }

  // =========================================================================
  // BUCKET SEPARATION & CONTRACTUAL SETTLEMENT PREVIEW (Sprint 3.1)
  // =========================================================================

  async calculateSettlementPreview(params: {
    sellerGoodsTaxable: string | BigNumber;
    sellerGstRatePercent: string | BigNumber;
    commissionRatePercent?: string | BigNumber;
    commissionFlatInr?: string | BigNumber;
    commissionGstRatePercent?: string | BigNumber;
    applyGstTcs?: boolean;
    tcsRatePercent?: string | BigNumber;
    applyWithholding?: boolean;
    withholdingRatePercent?: string | BigNumber;
    transactionDate?: Date;
    poolOverride?: pg.Pool | pg.PoolClient;
  }): Promise<{
    sellerGoodsTaxable: string;
    sellerGstRatePercent: string;
    sellerGstAmount: string;
    sellerGrossProceeds: string;
    commissionTaxable: string;
    commissionGstRatePercent: string;
    commissionGstAmount: string;
    totalQcomDeductions: string;
    tcsAmount: string;
    withholdingAmount: string;
    netSellerSettlement: string;
    accountingExplanation: string;
  }> {
    const runner = params.poolOverride || getPool();
    const txnDate = params.transactionDate || new Date();
    const goodsTaxableBn = toDecimal(params.sellerGoodsTaxable);
    const sellerGstRateBn = toDecimal(params.sellerGstRatePercent);
    const sellerGstAmtBn = roundCurrency(multiply(goodsTaxableBn, divide(sellerGstRateBn, 100)));
    const sellerGrossProceedsBn = add(goodsTaxableBn, sellerGstAmtBn);

    let commTaxableBn = new BigNumber(0);
    if (params.commissionFlatInr !== undefined) {
      commTaxableBn = toDecimal(params.commissionFlatInr);
    } else if (params.commissionRatePercent !== undefined) {
      commTaxableBn = toDecimal(roundCurrency(multiply(goodsTaxableBn, divide(toDecimal(params.commissionRatePercent), 100))));
    }

    let commGstRateBn: BigNumber;
    if (params.commissionGstRatePercent !== undefined) {
      commGstRateBn = toDecimal(params.commissionGstRatePercent);
    } else {
      try {
        const commRule = await this.resolveServiceTaxRule('COMMISSION_GST', txnDate, runner);
        commGstRateBn = toDecimal(commRule.gst_rate_percent);
      } catch {
        commGstRateBn = new BigNumber(18.00);
      }
    }
    const commGstAmtBn = roundCurrency(multiply(commTaxableBn, divide(commGstRateBn, 100)));
    const totalQcomFeeBn = add(commTaxableBn, commGstAmtBn);

    let tcsAmtBn = new BigNumber(0);
    if (params.applyGstTcs) {
      let tcsRateBn: BigNumber;
      if (params.tcsRatePercent !== undefined) {
        tcsRateBn = toDecimal(params.tcsRatePercent);
      } else {
        const tcs = await this.resolveGstTcs({ netTaxableSupplies: goodsTaxableBn, isInterState: false, transactionDate: txnDate, poolOverride: runner });
        tcsRateBn = toDecimal(tcs.totalTcsAmount).isGreaterThan(0)
          ? divide(multiply(toDecimal(tcs.totalTcsAmount), 100), goodsTaxableBn)
          : new BigNumber(0.50);
      }
      tcsAmtBn = toDecimal(roundCurrency(multiply(goodsTaxableBn, divide(tcsRateBn, 100))));
    }

    let tdsAmtBn = new BigNumber(0);
    if (params.applyWithholding) {
      let tdsRateBn: BigNumber;
      if (params.withholdingRatePercent !== undefined) {
        tdsRateBn = toDecimal(params.withholdingRatePercent);
      } else {
        const wth = await this.resolveWithholding({ grossTaxableAmount: goodsTaxableBn, merchantConstitution: 'INDIVIDUAL', merchantPanStatus: 'VALID_PAN', transactionDate: txnDate, poolOverride: runner });
        tdsRateBn = toDecimal(wth.applicableRatePercent || 0.10);
      }
      tdsAmtBn = toDecimal(roundCurrency(multiply(goodsTaxableBn, divide(tdsRateBn, 100))));
    }

    const netSettlementBn = subtract(
      sellerGrossProceedsBn,
      totalQcomFeeBn,
      tcsAmtBn,
      tdsAmtBn
    );

    return {
      sellerGoodsTaxable: roundCurrency(goodsTaxableBn),
      sellerGstRatePercent: sellerGstRateBn.toFixed(2),
      sellerGstAmount: sellerGstAmtBn,
      sellerGrossProceeds: roundCurrency(sellerGrossProceedsBn),
      commissionTaxable: roundCurrency(commTaxableBn),
      commissionGstRatePercent: commGstRateBn.toFixed(2),
      commissionGstAmount: commGstAmtBn,
      totalQcomDeductions: roundCurrency(totalQcomFeeBn),
      tcsAmount: roundCurrency(tcsAmtBn),
      withholdingAmount: roundCurrency(tdsAmtBn),
      netSellerSettlement: roundCurrency(netSettlementBn),
      accountingExplanation: `Seller Gross (₹${roundCurrency(sellerGrossProceedsBn)}) - QCOM Fee & GST (₹${roundCurrency(totalQcomFeeBn)}) = Net Settlement ₹${roundCurrency(netSettlementBn)}`,
    };
  }

  async calculateMerchantSettlement(params: {
    merchantId: string;
    sellerGoodsTaxable: string | BigNumber;
    sellerGstRatePercent: string | BigNumber;
    transactionDate?: Date;
    isInterState?: boolean;
    poolOverride?: pg.Pool | pg.PoolClient;
  }) {
    const runner = params.poolOverride || getPool();
    const txnDate = params.transactionDate || new Date();

    const merchRes = await runner.query(
      `SELECT id, merchant_code, name, commission_rate_percent, pan_status, constitution_type, state_code
         FROM merchants
        WHERE id = $1`,
      [params.merchantId]
    );

    if (merchRes.rows.length === 0) {
      throw new TaxEngineError('MERCHANT_NOT_FOUND', `Merchant '${params.merchantId}' not found.`, 404);
    }
    const merchant = merchRes.rows[0];

    const commissionRatePercent = merchant.commission_rate_percent;
    const commTaxRule = await this.resolveServiceTaxRule('COMMISSION_GST', txnDate, runner);

    const isInterState = params.isInterState ?? false;
    const gstTcs = await this.resolveGstTcs({
      netTaxableSupplies: params.sellerGoodsTaxable,
      isInterState,
      transactionDate: txnDate,
      poolOverride: runner,
    });

    const withholding = await this.resolveWithholding({
      grossTaxableAmount: params.sellerGoodsTaxable,
      merchantConstitution: merchant.constitution_type || 'INDIVIDUAL',
      merchantPanStatus: merchant.pan_status || 'VALID_PAN',
      transactionDate: txnDate,
      poolOverride: runner,
    });

    return this.calculateSettlementPreview({
      sellerGoodsTaxable: params.sellerGoodsTaxable,
      sellerGstRatePercent: params.sellerGstRatePercent,
      commissionRatePercent,
      commissionGstRatePercent: commTaxRule.gst_rate_percent,
      applyGstTcs: true,
      tcsRatePercent: gstTcs.totalTcsAmount ? divide(multiply(toDecimal(gstTcs.totalTcsAmount), 100), toDecimal(params.sellerGoodsTaxable)) : '0.50',
      applyWithholding: withholding.status === 'APPLICABLE',
      withholdingRatePercent: withholding.applicableRatePercent || '0.10',
      transactionDate: txnDate,
      poolOverride: runner,
    });
  }
}

export const taxEngine = new TaxEngine();
