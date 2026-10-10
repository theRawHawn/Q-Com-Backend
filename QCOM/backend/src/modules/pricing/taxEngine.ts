import pg from 'pg';
import BigNumber from 'bignumber.js';
import { getPool } from '../../database/connection.js';
import {
  StatutoryTaxRuleRecord,
  SellerProductTaxRecord,
  GstTcsBreakdown,
  WithholdingBreakdown,
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

export class TaxEngine {
  /**
   * Formats Date to YYYY-MM-DD for SQL comparison
   */
  private formatDate(date: Date): string {
    return date.toISOString().split('T')[0];
  }

  // =========================================================================
  // BUCKET A: SELLER'S GOODS TAX (Seller declared on product catalogue)
  // =========================================================================

  /**
   * Resolves the authoritative Seller-Declared Product GST Configuration.
   * Priority:
   *  1. Active record in `seller_product_tax` for the specific merchant and product on transaction date.
   *  2. Fallback to `products` table (`hsn_code` and `gst_rate_percent`).
   *  3. Fallback to `statutory_tax_rules` as fail-safe.
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
    taxRateSource: 'SELLER_DECLARED' | 'FALLBACK_CATALOG';
    status: string;
    adminReviewFlag: boolean;
  }> {
    const runner = poolOverride || getPool();
    const dateStr = this.formatDate(transactionDate);

    // 1. Look up in seller_product_tax table
    const sellerTaxRes = await runner.query(
      `SELECT id, product_id, merchant_id, hsn_code, gst_rate_percent, 
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
      return {
        ruleId: row.id,
        ruleCode: `SELLER_TAX_${row.hsn_code}`,
        hsnCode: row.hsn_code,
        gstRatePercent: toDecimal(row.gst_rate_percent).toFixed(2),
        taxRateSource: 'SELLER_DECLARED',
        status: row.status,
        adminReviewFlag: Boolean(row.admin_review_flag),
      };
    }

    // 2. Fallback to catalog product specification
    const prodRes = await runner.query(
      `SELECT id, sku, hsn_code, gst_rate_percent FROM products WHERE id = $1`,
      [productId]
    );

    if (prodRes.rows.length > 0) {
      const p = prodRes.rows[0];
      return {
        ruleId: p.id,
        ruleCode: `CATALOG_TAX_${p.hsn_code}`,
        hsnCode: p.hsn_code,
        gstRatePercent: toDecimal(p.gst_rate_percent).toFixed(2),
        taxRateSource: 'FALLBACK_CATALOG',
        status: 'ACTIVE',
        adminReviewFlag: false,
      };
    }

    throw new TaxEngineError(
      'SELLER_PRODUCT_TAX_NOT_CONFIGURED',
      `No seller product tax or catalogue configuration found for product '${productId}'.`,
      422
    );
  }

  /**
   * Declares or updates a seller's product GST rate and HSN code.
   * Controls & Validation:
   * - Validates standard Indian GST slabs (0%, 5%, 12%, 18%, 28%).
   * - If a seller enters a non-standard rate, it is saved but automatically flagged with `admin_review_flag = TRUE`.
   */
  async declareSellerProductTax(
    params: {
      productId: string;
      merchantId: string;
      hsnCode: string;
      gstRatePercent: number | string;
      effectiveFrom?: string;
      actorId?: string;
    },
    poolOverride?: pg.Pool | pg.PoolClient
  ): Promise<SellerProductTaxRecord> {
    const runner = poolOverride || getPool();
    const rateBn = toDecimal(params.gstRatePercent);

    if (rateBn.isLessThan(0) || rateBn.isGreaterThan(100)) {
      throw new TaxEngineError('INVALID_GST_RATE', 'GST rate percent must be between 0% and 100%.', 400);
    }

    const cleanHsn = params.hsnCode.trim();
    if (!cleanHsn || cleanHsn.length < 2) {
      throw new TaxEngineError('INVALID_HSN_CODE', 'A valid HSN code is required.', 400);
    }

    // Dynamic database-driven standard slabs check: queries active statutory tax rules in PostgreSQL
    const ratesRes = await runner.query(
      `SELECT DISTINCT gst_rate_percent FROM statutory_tax_rules WHERE is_active = TRUE`
    );
    const validDbSlabs = ratesRes.rows.map(r => toDecimal(r.gst_rate_percent).toNumber());
    // In India statutory goods slabs include 0, 5, 12, 18, 28
    const standardSlabs = validDbSlabs.length > 0 ? validDbSlabs : [0, 5, 12, 18, 28];
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
         tax_rate_source, status, admin_review_flag, admin_review_notes, effective_from, seller_declared_at, created_at, updated_at)
       VALUES
        ($1, $2, $3, $4, $5, $6, $7, 'SELLER_DECLARED', 'ACTIVE', $8, $9, $10::date, NOW(), NOW(), NOW())
       ON CONFLICT (product_id, merchant_id, effective_from)
       DO UPDATE SET
        hsn_code = EXCLUDED.hsn_code,
        gst_rate_percent = EXCLUDED.gst_rate_percent,
        cgst_rate_percent = EXCLUDED.cgst_rate_percent,
        sgst_rate_percent = EXCLUDED.sgst_rate_percent,
        igst_rate_percent = EXCLUDED.igst_rate_percent,
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
   * Enforces zero matching -> TAX_RULE_NOT_FOUND, multiple conflicting -> TAX_RULE_CONFLICT.
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
   * (e.g. DELIVERY_GST, HANDLING_GST, COMMISSION_GST) from statutory_tax_rules table
   * without hardcoding SAC codes in application code.
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
   * Calculates GST breakdown for a line item or charge based on place of supply (intra-state vs inter-state).
   */
  calculateGst(params: {
    taxableAmount: string | BigNumber;
    taxRule: { gst_rate_percent: string; rule_code?: string; id?: string };
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
    totalGstAmount: string;
  } {
    const { taxableAmount, taxRule, merchantStateCode, placeOfSupplyStateCode } = params;
    const taxableBn = toDecimal(taxableAmount);
    const gstRateBn = toDecimal(taxRule.gst_rate_percent);

    const isInterState = merchantStateCode.trim() !== placeOfSupplyStateCode.trim();

    if (!isInterState) {
      // Intra-state supply: CGST (50%) + SGST (50%)
      const halfRate = divide(gstRateBn, 2);
      const cgstAmt = roundCurrency(multiply(taxableBn, divide(halfRate, 100)));
      const sgstAmt = roundCurrency(multiply(taxableBn, divide(halfRate, 100)));
      const totalGst = roundCurrency(add(cgstAmt, sgstAmt));

      return {
        isInterState: false,
        gstRatePercent: gstRateBn.toFixed(2),
        cgstRatePercent: halfRate.toFixed(2),
        cgstAmount: cgstAmt,
        sgstRatePercent: halfRate.toFixed(2),
        sgstAmount: sgstAmt,
        igstRatePercent: '0.00',
        igstAmount: '0.00',
        totalGstAmount: totalGst,
      };
    } else {
      // Inter-state supply: IGST (100%)
      const igstAmt = roundCurrency(multiply(taxableBn, divide(gstRateBn, 100)));

      return {
        isInterState: true,
        gstRatePercent: gstRateBn.toFixed(2),
        cgstRatePercent: '0.00',
        cgstAmount: '0.00',
        sgstRatePercent: '0.00',
        sgstAmount: '0.00',
        igstRatePercent: gstRateBn.toFixed(2),
        igstAmount: igstAmt,
        totalGstAmount: igstAmt,
      };
    }
  }

  // =========================================================================
  // BUCKET C: STATUTORY COLLECTIONS (Section 52 GST-TCS & Section 393 TDS)
  // =========================================================================

  /**
   * Resolves Section 52 GST-TCS rule and calculates TCS amount on Net Taxable Supplies.
   * Net Taxable Supplies = Sum of product taxable amounts (excluding customer GST).
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

    // Determine target statutory regime
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

  /**
   * Calculates a contractual settlement preview separating:
   * 1. Seller's Gross Proceeds = Seller's taxable goods value + Seller's GST
   * 2. QCOM's Commission & Service Fee = Commission taxable + GST on commission (SAC 9983)
   * 3. Net Seller Settlement = Gross proceeds - QCOM Commission - Commission GST
   * (Statutory TCS/TDS deducted if required by law)
   */
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

    // QCOM Commission
    let commTaxableBn = new BigNumber(0);
    if (params.commissionFlatInr !== undefined) {
      commTaxableBn = toDecimal(params.commissionFlatInr);
    } else if (params.commissionRatePercent !== undefined) {
      commTaxableBn = toDecimal(roundCurrency(multiply(goodsTaxableBn, divide(toDecimal(params.commissionRatePercent), 100))));
    }

    // Dynamic QCOM Commission GST: Read from database statutory_tax_rules table
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

    // Dynamic Statutory deductions: Read from database rules
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

  /**
   * Calculates actual real-life merchant settlement directly from PostgreSQL database records.
   * - Picks merchant's actual contract commission rate from `merchants.commission_rate_percent`.
   * - Picks active statutory commission GST rule from `statutory_tax_rules`.
   * - Picks active Section 52 GST-TCS rule from `gst_tcs_rules`.
   * - Picks active Section 393 Withholding rule from `statutory_withholding_rules` based on merchant's constitution and PAN.
   */
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

    // 1. Fetch real-life merchant contract and tax attributes from PostgreSQL
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

    // Real contract commission rate
    const commissionRatePercent = merchant.commission_rate_percent;

    // 2. Fetch real statutory commission GST rule
    const commTaxRule = await this.resolveServiceTaxRule('COMMISSION_GST', txnDate, runner);

    // 3. Fetch real Section 52 TCS breakdown
    const isInterState = params.isInterState ?? false;
    const gstTcs = await this.resolveGstTcs({
      netTaxableSupplies: params.sellerGoodsTaxable,
      isInterState,
      transactionDate: txnDate,
      poolOverride: runner,
    });

    // 4. Fetch real Section 393 Withholding breakdown
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
