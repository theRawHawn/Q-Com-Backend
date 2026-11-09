import assert from 'node:assert/strict';
import { createTestDatabase } from './helpers/testDb.js';
import { runMigrations } from '../src/database/migrator.js';
import { runSeeds } from '../seeds/seedData.js';
import { AuthService } from '../src/modules/auth/authService.js';
import { createApp } from '../src/app.js';
import { setPool } from '../src/database/connection.js';
import {
  roundCurrency,
  add,
  subtract,
  multiply,
  divide,
} from '../src/modules/pricing/money.js';
import { taxEngine, TaxEngineError } from '../src/modules/pricing/taxEngine.js';
import { pricingEngine, PRICING_ENGINE_VERSION } from '../src/modules/pricing/pricingEngine.js';

export async function testPricingAndTaxEngine() {
  console.log('\n--- Running Centralized Pricing, GST & Tax Engine Test Suite (Sprint 3) ---');
  const { pool } = createTestDatabase();
  setPool(pool);

  try {
    await runMigrations({ poolOverride: pool });
    await runSeeds(pool);

    const authService = new AuthService();

    // Fetch Seed Entities
    const merchRes = await pool.query(`SELECT id, merchant_code, state_code FROM merchants WHERE merchant_code = 'MERCH-BLR-01'`);
    const merchBRes = await pool.query(`SELECT id, merchant_code, state_code FROM merchants WHERE merchant_code = 'MERCH-BLR-02'`);
    const merchantId = merchRes.rows[0].id;
    const merchantBId = merchBRes.rows[0].id;

    const prodValve = await pool.query(`SELECT id, sku, hsn_code FROM products WHERE sku = 'VALVE-BRASS-05'`);
    const prodSwitch = await pool.query(`SELECT id, sku, hsn_code FROM products WHERE sku = 'SWITCH-ROMA-06A'`);
    const valveId = prodValve.rows[0].id;
    const switchId = prodSwitch.rows[0].id;

    // Authenticate Actors
    const custOtp = await authService.requestOtp('+91-9876543210', 'LOGIN', '127.0.0.1', pool);
    const custSession = await authService.verifyOtp('+91-9876543210', custOtp.debugOtp!, 'LOGIN', '127.0.0.1', 'CustomerApp', undefined, pool);
    const customerToken = custSession.accessToken;

    const custBOtp = await authService.requestOtp('+91-9876543211', 'LOGIN', '127.0.0.1', pool);
    const custBSession = await authService.verifyOtp('+91-9876543211', custBOtp.debugOtp!, 'LOGIN', '127.0.0.1', 'CustomerApp', undefined, pool);
    const customerBToken = custBSession.accessToken;

    const adminSession = await authService.adminLogin('EMP-001', undefined, '127.0.0.1', 'AdminPortal', pool);
    const adminToken = adminSession.accessToken;

    const app = createApp();

    // Helper to invoke Express app safely
    async function makeRequest(options: {
      method: 'GET' | 'POST' | 'PUT' | 'DELETE';
      path: string;
      token?: string;
      body?: any;
      headers?: Record<string, string>;
    }) {
      return new Promise<{ status: number; body: any }>((resolve) => {
        const req: any = {
          method: options.method,
          url: options.path,
          originalUrl: options.path,
          path: options.path.split('?')[0],
          headers: {
            ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
            'user-agent': 'Sprint3TestRunner',
            'content-type': 'application/json',
            ...(options.headers || {}),
          },
          params: {},
          query: {},
          body: options.body || {},
          ip: '127.0.0.1',
          socket: { remoteAddress: '127.0.0.1' },
          baseUrl: '',
        };

        if (options.path.includes('?')) {
          const queryString = options.path.split('?')[1];
          const searchParams = new URLSearchParams(queryString);
          searchParams.forEach((v, k) => {
            req.query[k] = v;
          });
        }

        const res: any = {
          statusCode: 200,
          _headers: {},
          setHeader(name: string, val: string) {
            this._headers[name] = val;
          },
          status(code: number) {
            this.statusCode = code;
            return this;
          },
          json(data: any) {
            resolve({ status: this.statusCode, body: data });
          },
        };

        (app as any).handle(req, res, () => {
          resolve({ status: 404, body: { error: 'ROUTE_NOT_FOUND' } });
        });
      });
    }

    // =========================================================================
    // PART 1 & 13: FINANCIAL MONEY SAFETY & STATUTORY ROUND_HALF_UP PRECISION
    // =========================================================================
    console.log('[Test 1] Testing Financial Decimal Arithmetic & Centralized Rounding Precision...');
    assert.equal(roundCurrency('0.005'), '0.01', '0.005 must round up to 0.01');
    assert.equal(roundCurrency('99.995'), '100.00', '99.995 must round up to 100.00');
    assert.equal(roundCurrency('33.333333'), '33.33', '33.333333 must round to 33.33');
    assert.equal(roundCurrency('66.666667'), '66.67', '66.666667 must round to 66.67');
    assert.equal(roundCurrency('999.999'), '1000.00', '999.999 must round to 1000.00');

    // Precision addition and subtraction tests
    const sum = add('0.10', '0.20');
    assert.equal(sum.toString(), '0.3', 'Money arithmetic must avoid JS IEEE-754 0.1+0.2=0.30000000000000004 bug');
    assert.equal(roundCurrency(sum), '0.30');

    console.log('✓ Financial precision and statutory Half-Up rounding edge cases verified');

    // =========================================================================
    // PART 3: ZERO-TRUST CLIENT PRICE & TAX TAMPERING DEFENSE
    // =========================================================================
    console.log('[Test 2] Testing Client Price, GST, and Total Tampering Defenses...');

    // Client attempts to pass fraudulent prices: unitPrice = 1.00, GST = 0, grandTotal = 1.00
    const tamperedPayload = {
      merchantId,
      items: [
        {
          productId: valveId,
          quantity: 2,
          unitPrice: 1.00,       // TAMPERING ATTEMPT: True DB price is 289.00
          sellingPrice: 1.00,    // TAMPERING ATTEMPT
          tax: 0.00,             // TAMPERING ATTEMPT
          gstRate: 0,            // TAMPERING ATTEMPT
          lineTotal: 2.00,       // TAMPERING ATTEMPT
        },
      ],
      totalAmount: 2.00,         // TAMPERING ATTEMPT
      grandTotal: 2.00,          // TAMPERING ATTEMPT
      distanceKm: 2.0,
      placeOfSupplyStateCode: '29',
    };

    const tamperRes = await makeRequest({
      method: 'POST',
      path: '/api/v1/pricing/quote',
      token: customerToken,
      body: tamperedPayload,
    });

    assert.equal(tamperRes.status, 200);
    const quote = tamperRes.body.quote;

    // Verify backend used authoritative DB price of ₹289.00, NOT the client's ₹1.00
    assert.equal(quote.items[0].unitPrice, '289.00', 'Backend MUST use database price, not client price');
    assert.equal(quote.items[0].grossAmount, '578.00', 'Gross amount must be 289.00 * 2 = 578.00');
    assert.equal(quote.items[0].gstRatePercent, '18.00', 'GST rate must be 18.00% from HSN rule, not client 0%');
    assert.equal(quote.items[0].cgstAmount, '52.02', 'CGST must be 578 * 9% = 52.02');
    assert.equal(quote.items[0].sgstAmount, '52.02', 'SGST must be 578 * 9% = 52.02');
    assert.equal(quote.items[0].totalGstAmount, '104.04', 'Total GST on valve items must be 104.04');
    assert.equal(quote.items[0].lineTotal, '682.04', 'Line total must be 578.00 + 104.04 = 682.04');

    // Total must not be client's ₹2.00
    assert.notEqual(quote.grandTotal, '2.00');
    console.log('✓ Client price, tax, and grand total tampering successfully blocked and overridden by DB authority');

    // =========================================================================
    // PART 6: INTRA-STATE VS INTER-STATE GST PLACE-OF-SUPPLY SPLIT
    // =========================================================================
    console.log('[Test 3] Testing Place-of-Supply GST Split (Intra-State vs Inter-State)...');

    // 3.1 Intra-state: Merchant '29' (Karnataka) -> Customer '29' (Karnataka)
    const intraRes = await makeRequest({
      method: 'POST',
      path: '/api/v1/pricing/quote',
      token: customerToken,
      body: {
        merchantId,
        items: [{ productId: valveId, quantity: 1 }],
        placeOfSupplyStateCode: '29',
        distanceKm: 2.0,
      },
    });
    assert.equal(intraRes.status, 200);
    const intraQuote = intraRes.body.quote;
    assert.equal(intraQuote.isInterState, false);
    assert.equal(intraQuote.items[0].cgstRatePercent, '9.00');
    assert.equal(intraQuote.items[0].sgstRatePercent, '9.00');
    assert.equal(intraQuote.items[0].igstRatePercent, '0.00');
    assert.equal(intraQuote.items[0].igstAmount, '0.00');
    assert.ok(parseFloat(intraQuote.totalCgst) > 0);
    assert.ok(parseFloat(intraQuote.totalSgst) > 0);
    assert.equal(intraQuote.totalIgst, '0.00');

    // 3.2 Inter-state: Merchant '29' (Karnataka) -> Customer '27' (Maharashtra)
    const interRes = await makeRequest({
      method: 'POST',
      path: '/api/v1/pricing/quote',
      token: customerToken,
      body: {
        merchantId,
        items: [{ productId: valveId, quantity: 1 }],
        placeOfSupplyStateCode: '27',
        distanceKm: 2.0,
      },
    });
    assert.equal(interRes.status, 200);
    const interQuote = interRes.body.quote;
    assert.equal(interQuote.isInterState, true);
    assert.equal(interQuote.items[0].cgstRatePercent, '0.00');
    assert.equal(interQuote.items[0].sgstRatePercent, '0.00');
    assert.equal(interQuote.items[0].igstRatePercent, '18.00');
    assert.equal(interQuote.items[0].cgstAmount, '0.00');
    assert.equal(interQuote.items[0].sgstAmount, '0.00');
    assert.ok(parseFloat(interQuote.items[0].igstAmount) > 0);
    assert.equal(interQuote.totalCgst, '0.00');
    assert.equal(interQuote.totalSgst, '0.00');
    assert.ok(parseFloat(interQuote.totalIgst) > 0);

    console.log('✓ Dynamic Intra-state (CGST+SGST) and Inter-state (IGST) split verified');

    // =========================================================================
    // PART 5 & 7: EFFECTIVE-DATED TAX RULES & CONFLICT / NOT FOUND CHECKS
    // =========================================================================
    console.log('[Test 4] Testing Effective-Dated Tax Rule Resolution...');

    // 4.1 Test valid date resolution
    const rule2024 = await taxEngine.resolveTaxRule('8481', 'PRODUCT_GST', new Date('2025-06-15'), pool);
    assert.equal(rule2024.hsn_or_sac_code, '8481');
    assert.equal(rule2024.gst_rate_percent, '18.00');

    // 4.2 Test TAX_RULE_NOT_FOUND (non-existent HSN code)
    await assert.rejects(
      async () => {
        await taxEngine.resolveTaxRule('999999', 'PRODUCT_GST', new Date(), pool);
      },
      (err: any) => err instanceof TaxEngineError && err.code === 'TAX_RULE_NOT_FOUND',
      'Non-existent HSN code must fail with TAX_RULE_NOT_FOUND'
    );

    // 4.3 Test TAX_RULE_CONFLICT (insert conflicting rule with same effective date)
    await pool.query(
      `INSERT INTO statutory_tax_rules
        (rule_code, tax_type, hsn_or_sac_code, description, effective_from, gst_rate_percent, cgst_rate_percent, sgst_rate_percent, igst_rate_percent, statutory_reference)
       VALUES
        ('HSN_8481_CONFLICTING', 'PRODUCT_GST', '8481', 'Conflicting Rule', '2024-01-01', 12.00, 6.00, 6.00, 12.00, 'TEST')`
    );

    await assert.rejects(
      async () => {
        await taxEngine.resolveTaxRule('8481', 'PRODUCT_GST', new Date('2024-06-01'), pool);
      },
      (err: any) => err instanceof TaxEngineError && err.code === 'TAX_RULE_CONFLICT',
      'Conflicting overlapping rules must fail with TAX_RULE_CONFLICT'
    );

    // Cleanup conflicting test rule
    await pool.query(`DELETE FROM statutory_tax_rules WHERE rule_code = 'HSN_8481_CONFLICTING'`);

    console.log('✓ Effective-dated rule resolution, TAX_RULE_NOT_FOUND, and TAX_RULE_CONFLICT verified');

    // =========================================================================
    // PART 10 & 11: DETERMINISTIC DELIVERY & HANDLING CHARGES WITH SAC 9968/9985
    // =========================================================================
    console.log('[Test 5] Testing Delivery & Handling Charges Calculation...');

    // Distance = 5.2 km (Base 3.0 km @ ₹35 + Excess 2.2 km @ ₹10/km = ₹35 + ₹22 = ₹57.00 taxable)
    // Delivery GST @ 18% = ₹10.26 -> Delivery Total = ₹67.26
    // Handling fee = ₹5.00 taxable + 18% GST (₹0.90) = ₹5.90
    const chargesQuoteRes = await makeRequest({
      method: 'POST',
      path: '/api/v1/pricing/quote',
      token: customerToken,
      body: {
        merchantId,
        items: [{ productId: valveId, quantity: 1 }],
        distanceKm: 5.2,
      },
    });

    assert.equal(chargesQuoteRes.status, 200);
    const chargesQuote = chargesQuoteRes.body.quote;

    const deliveryChg = chargesQuote.charges.find((c: any) => c.chargeType === 'DELIVERY');
    const handlingChg = chargesQuote.charges.find((c: any) => c.chargeType === 'HANDLING');

    assert.ok(deliveryChg);
    assert.equal(deliveryChg.taxableAmount, '57.00', 'Base 35 + 2.2km * 10 = 57.00');
    assert.equal(deliveryChg.sacCode, '9968');
    assert.equal(deliveryChg.taxAmount, '10.26', '18% GST on 57.00 = 10.26');
    assert.equal(deliveryChg.totalAmount, '67.26', '57.00 + 10.26 = 67.26');

    assert.ok(handlingChg);
    assert.equal(handlingChg.taxableAmount, '5.00');
    assert.equal(handlingChg.sacCode, '9985');
    assert.equal(handlingChg.taxAmount, '0.90');
    assert.equal(handlingChg.totalAmount, '5.90');

    console.log('✓ Deterministic delivery and handling calculations with SAC codes verified');

    // =========================================================================
    // PART 8 & 9: SECTION 52 GST-TCS & DIRECT-TAX WITHHOLDING FOUNDATIONS
    // =========================================================================
    console.log('[Test 6] Testing Section 52 GST-TCS & Income-tax Act 2025 Withholding...');

    assert.ok(chargesQuote.gstTcs);
    assert.equal(chargesQuote.gstTcs.statutoryProvision, 'CGST_ACT_SECTION_52');
    assert.equal(chargesQuote.gstTcs.reportingForm, 'GSTR-8');
    assert.ok(parseFloat(chargesQuote.gstTcs.totalTcsAmount) >= 0);

    // Test Income-tax Act 2025 resolution on a 2026 transaction date
    const withholdingPost2026 = await taxEngine.resolveWithholding({
      grossTaxableAmount: '5000.00',
      merchantConstitution: 'FIRM_LLP',
      merchantPanStatus: 'VALID_PAN',
      transactionDate: new Date('2026-09-01'),
      poolOverride: pool,
    });
    assert.equal(withholdingPost2026.governingLaw, 'INCOME_TAX_ACT_2025');
    assert.equal(withholdingPost2026.statutoryProvision, 'SECTION_393');
    assert.equal(withholdingPost2026.tableItem, 'TABLE_8_V');
    assert.equal(withholdingPost2026.status, 'APPLICABLE');

    // Test Income-tax Act 1961 resolution on a pre-2026 transaction date
    const withholdingPre2026 = await taxEngine.resolveWithholding({
      grossTaxableAmount: '5000.00',
      merchantConstitution: 'FIRM_LLP',
      merchantPanStatus: 'VALID_PAN',
      transactionDate: new Date('2025-12-01'),
      poolOverride: pool,
    });
    assert.equal(withholdingPre2026.governingLaw, 'INCOME_TAX_ACT_1961');

    console.log('✓ Section 52 GST-TCS and Income-tax Act 2025/1961 dynamic withholding verified');

    // =========================================================================
    // PART 14 & 15: PRICING SNAPSHOT PERSISTENCE & REPRODUCIBILITY
    // =========================================================================
    console.log('[Test 7] Testing Pricing Calculation Snapshot Persistence & Reproducibility...');

    const quoteId = chargesQuote.quoteId;
    assert.ok(quoteId);
    assert.equal(chargesQuote.pricingEngineVersion, PRICING_ENGINE_VERSION);

    // Retrieve quote snapshot from PostgreSQL directly
    const snapshotDb = await pool.query(
      `SELECT id, pricing_engine_version, grand_total, snapshot_data FROM pricing_calculation_snapshots WHERE id = $1`,
      [quoteId]
    );
    assert.equal(snapshotDb.rows.length, 1);
    assert.equal(snapshotDb.rows[0].pricing_engine_version, '3.0.0');
    assert.equal(roundCurrency(snapshotDb.rows[0].grand_total), chargesQuote.grandTotal);

    // Retrieve via API GET /api/v1/pricing/quote/:quoteId
    const getQuoteRes = await makeRequest({
      method: 'GET',
      path: `/api/v1/pricing/quote/${quoteId}`,
      token: customerToken,
    });
    assert.equal(getQuoteRes.status, 200);
    assert.equal(getQuoteRes.body.quote.quoteId, quoteId);
    assert.equal(getQuoteRes.body.quote.grandTotal, chargesQuote.grandTotal);

    console.log('✓ Calculation snapshot persisted in PostgreSQL and reproducibly retrieved');

    // =========================================================================
    // PART 23: IDEMPOTENCY KEY REPLAY PROTECTION
    // =========================================================================
    console.log('[Test 8] Testing Idempotency-Key Lifecycle & Replay...');

    const testIdempotencyKey = 'idemp-quote-test-999';
    const payload8 = {
      merchantId,
      items: [{ productId: valveId, quantity: 1 }],
      distanceKm: 2.0,
    };

    // Request 1: creates snapshot and completes idempotency key
    const idempRes1 = await makeRequest({
      method: 'POST',
      path: '/api/v1/pricing/quote',
      token: customerToken,
      headers: { 'idempotency-key': testIdempotencyKey },
      body: payload8,
    });
    assert.equal(idempRes1.status, 200);
    const initialQuoteId = idempRes1.body.quote.quoteId;

    // Request 2 (Replay with same Idempotency-Key): must return identical cached quote
    const idempRes2 = await makeRequest({
      method: 'POST',
      path: '/api/v1/pricing/quote',
      token: customerToken,
      headers: { 'idempotency-key': testIdempotencyKey },
      body: payload8,
    });
    assert.equal(idempRes2.status, 200);
    assert.equal(idempRes2.body.quote.quoteId, initialQuoteId, 'Replay with same key must return identical quote');

    console.log('✓ Idempotency-Key replay protection verified');

    // =========================================================================
    // PART 18 & 22: AUTHENTICATION, REVOKED SESSION & CROSS-TENANT DEFENSES
    // =========================================================================
    console.log('[Test 9] Testing Authentication, Revoked Sessions, and Tenant Isolation...');

    // 9.1 Unauthenticated request must fail (401)
    const unauthRes = await makeRequest({
      method: 'POST',
      path: '/api/v1/pricing/quote',
      body: payload8,
    });
    assert.equal(unauthRes.status, 401);
    assert.equal(unauthRes.body.error, 'UNAUTHENTICATED');

    // 9.2 Valid JWT + Revoked Session must fail (401 SESSION_REVOKED)
    // Create new login session and revoke it
    const tempOtp = await authService.requestOtp('+91-9999911111', 'LOGIN', '127.0.0.1', pool);
    const tempSession = await authService.verifyOtp('+91-9999911111', tempOtp.debugOtp!, 'LOGIN', '127.0.0.1', 'TempApp', undefined, pool);
    await pool.query(`UPDATE auth_sessions SET status = 'REVOKED' WHERE id = $1`, [tempSession.session.id]);

    const revokedRes = await makeRequest({
      method: 'POST',
      path: '/api/v1/pricing/quote',
      token: tempSession.accessToken,
      body: payload8,
    });
    assert.equal(revokedRes.status, 401);
    assert.equal(revokedRes.body.error, 'SESSION_REVOKED');

    // 9.3 Cross-Customer Quote Snapshot Isolation: Customer B cannot inspect Customer A's quote
    const crossCustRes = await makeRequest({
      method: 'GET',
      path: `/api/v1/pricing/quote/${quoteId}`,
      token: customerBToken,
    });
    assert.equal(crossCustRes.status, 403);
    assert.equal(crossCustRes.body.error, 'ACCESS_DENIED');

    console.log('✓ Unauthenticated (401), Revoked session (401), and Cross-Customer quote isolation (403) verified');

    // =========================================================================
    // PART 24 & 25: ADMINISTRATIVE TAX RULES LISTING WITH PAGINATION & FILTERING
    // =========================================================================
    console.log('[Test 10] Testing Administrative Rules Listing, Pagination, and Filtering...');

    // 10.1 Customer lacks 'pricing.view' permission -> 403 Forbidden
    const custTaxRulesRes = await makeRequest({
      method: 'GET',
      path: '/api/v1/pricing/tax-rules',
      token: customerToken,
    });
    assert.equal(custTaxRulesRes.status, 403);

    // 10.2 Admin with permission -> 200 OK with pagination
    const adminTaxRulesRes = await makeRequest({
      method: 'GET',
      path: '/api/v1/pricing/tax-rules?page=1&limit=5&tax_type=PRODUCT_GST',
      token: adminToken,
    });
    assert.equal(adminTaxRulesRes.status, 200);
    assert.ok(adminTaxRulesRes.body.taxRules.length <= 5);
    assert.ok(adminTaxRulesRes.body.pagination);
    assert.equal(adminTaxRulesRes.body.pagination.page, 1);
    assert.equal(adminTaxRulesRes.body.pagination.limit, 5);
    assert.ok(adminTaxRulesRes.body.pagination.total >= 6);

    // 10.3 Delivery rules endpoint
    const deliveryRulesRes = await makeRequest({
      method: 'GET',
      path: '/api/v1/pricing/delivery-rules',
      token: adminToken,
    });
    assert.equal(deliveryRulesRes.status, 200);
    assert.ok(deliveryRulesRes.body.deliveryRules.length >= 1);

    console.log('✓ Administrative rules pagination, filtering, and RBAC permission checks verified');

    // =========================================================================
    // SPRINT 3.1: SELLER'S RESPONSIBILITY FOR PRODUCT GST CLASSIFICATION
    // =========================================================================
    console.log('\n[Test 11] Testing Sprint 3.1: Seller Responsibility for Product GST Classification & HSN...');

    // Authenticate Seller A (Merchant A) and Seller B (Merchant B)
    const sellerAOtp = await authService.requestOtp('+91-9845012345', 'LOGIN', '127.0.0.1', pool);
    const sellerASession = await authService.verifyOtp('+91-9845012345', sellerAOtp.debugOtp!, 'LOGIN', '127.0.0.1', 'SellerApp', undefined, pool);
    const sellerAToken = sellerASession.accessToken;

    const sellerBOtp = await authService.requestOtp('+91-9845099999', 'LOGIN', '127.0.0.1', pool);
    const sellerBSession = await authService.verifyOtp('+91-9845099999', sellerBOtp.debugOtp!, 'LOGIN', '127.0.0.1', 'SellerApp', undefined, pool);
    const sellerBToken = sellerBSession.accessToken;

    // 11.1 Seller A declares Drill Machine GST: ₹1,000 — GST 18% — HSN 8467
    const drillDeclRes = await makeRequest({
      method: 'PUT',
      path: `/api/v1/pricing/merchants/${merchantId}/products/${valveId}/tax-declaration`,
      token: sellerAToken,
      body: {
        hsnCode: '8467',
        gstRatePercent: 18.00,
      },
    });
    assert.equal(drillDeclRes.status, 200);
    assert.equal(drillDeclRes.body.sellerProductTax.hsnCode, '8467');
    assert.equal(drillDeclRes.body.sellerProductTax.gstRatePercent, '18.00');
    assert.equal(drillDeclRes.body.sellerProductTax.taxRateSource, 'SELLER_DECLARED');
    assert.equal(drillDeclRes.body.sellerProductTax.adminReviewFlag, false, 'Standard 18% rate must not flag admin review');

    // 11.2 QCOM does not invent or override: Quote uses seller's declared HSN 8467 and 18% rate
    const sellerQuoteRes = await makeRequest({
      method: 'POST',
      path: '/api/v1/pricing/quote',
      token: customerToken,
      body: {
        merchantId,
        items: [{ productId: valveId, quantity: 1 }],
      },
    });
    assert.equal(sellerQuoteRes.status, 200);
    const sellerQuote = sellerQuoteRes.body.quote;
    assert.equal(sellerQuote.items[0].hsnCode, '8467');
    assert.equal(sellerQuote.items[0].gstRatePercent, '18.00');
    assert.equal(sellerQuote.items[0].taxRateSource, 'SELLER_DECLARED');

    // 11.3 Seller enters non-standard rate (e.g. 14.50%): System records it but flags for Admin Review
    const flagDeclRes = await makeRequest({
      method: 'PUT',
      path: `/api/v1/pricing/merchants/${merchantId}/products/${switchId}/tax-declaration`,
      token: sellerAToken,
      body: {
        hsnCode: '8536',
        gstRatePercent: 14.50, // Non-standard Indian GST slab
      },
    });
    assert.equal(flagDeclRes.status, 200);
    assert.equal(flagDeclRes.body.sellerProductTax.adminReviewFlag, true, 'Non-standard slab must trigger adminReviewFlag');
    assert.ok(flagDeclRes.body.sellerProductTax.adminReviewNotes.includes('Pending administrative review'));

    // 11.4 Admin Review Queue lists flagged declaration
    const adminReviewRes = await makeRequest({
      method: 'GET',
      path: '/api/v1/pricing/admin/tax/seller-reviews',
      token: adminToken,
    });
    assert.equal(adminReviewRes.status, 200);
    assert.ok(adminReviewRes.body.flaggedDeclarations.length >= 1);
    const flagged = adminReviewRes.body.flaggedDeclarations.find((d: any) => d.product_id === switchId);
    assert.ok(flagged);
    assert.equal(flagged.admin_review_flag, true);

    // 11.5 Cross-Tenant Isolation: Seller B cannot declare tax on Seller A's product
    const crossDeclRes = await makeRequest({
      method: 'PUT',
      path: `/api/v1/pricing/merchants/${merchantId}/products/${valveId}/tax-declaration`,
      token: sellerBToken,
      body: {
        hsnCode: '8467',
        gstRatePercent: 18.00,
      },
    });
    assert.equal(crossDeclRes.status, 403);
    assert.equal(crossDeclRes.body.error, 'TENANT_ACCESS_DENIED');
    console.log('✓ Seller product GST classification, non-standard slab admin flagging, and tenant defense verified');

    // =========================================================================
    // SPRINT 3.1: STRICT 3-BUCKET ARCHITECTURAL SEPARATION
    // =========================================================================
    console.log('\n[Test 12] Testing Sprint 3.1: Strict 3-Bucket Separation Architecture...');
    // BUCKET A: SELLER'S GOODS GST
    // BUCKET B: QCOM'S OWN FEES (Commission, Delivery, Handling)
    // BUCKET C: STATUTORY COLLECTIONS (Section 52 GST-TCS, Income-tax withholding)

    assert.ok(sellerQuote.sellerGoodsBreakdown, 'Quote must expose explicit sellerGoodsBreakdown');
    assert.equal(sellerQuote.sellerGoodsBreakdown.taxBucket, 'SELLER_GOODS');
    assert.ok(parseFloat(sellerQuote.sellerGoodsBreakdown.taxableAmount) > 0);
    assert.ok(parseFloat(sellerQuote.sellerGoodsBreakdown.totalGst) > 0);

    assert.ok(sellerQuote.qcomFeesBreakdown, 'Quote must expose explicit qcomFeesBreakdown');
    assert.equal(sellerQuote.qcomFeesBreakdown.taxBucket, 'QCOM_SERVICE_FEES');
    assert.ok(parseFloat(sellerQuote.qcomFeesBreakdown.totalCharges) > 0);
    assert.ok(parseFloat(sellerQuote.qcomFeesBreakdown.totalGst) > 0);

    assert.ok(sellerQuote.statutoryCollections, 'Quote must expose explicit statutoryCollections');
    assert.equal(sellerQuote.statutoryCollections.taxBucket, 'STATUTORY_COLLECTIONS');
    assert.ok(sellerQuote.statutoryCollections.gstTcs);
    assert.ok(sellerQuote.statutoryCollections.withholding);

    // INVARIANT: Seller Goods GST != QCOM Service Fees GST (Must never be commingled)
    assert.notEqual(
      sellerQuote.sellerGoodsBreakdown.totalGst,
      sellerQuote.qcomFeesBreakdown.totalGst,
      'Seller product GST and QCOM fees GST must never be commingled or treated as same entity'
    );
    console.log('✓ Strict 3-Bucket architectural separation verified in pricing output');

    // =========================================================================
    // SPRINT 3.1: CONTRACTUAL SETTLEMENT FORMULA PREVIEW
    // =========================================================================
    console.log('\n[Test 13] Testing Sprint 3.1: Contractual Settlement Formula & Ledger Preview...');
    // User Specification Example:
    // Seller product price:       ₹1,000
    // Seller GST @18%:              ₹180
    // Customer pays:              ₹1,180
    // QCOM commission:              ₹100
    // GST on QCOM commission @18%:   ₹18
    // Seller gross proceeds:      ₹1,180
    // Less QCOM commission:         ₹100
    // Less GST on commission:        ₹18
    // ──────────────────────────────────
    // Seller settlement:          ₹1,062

    const settlementRes = await makeRequest({
      method: 'POST',
      path: '/api/v1/pricing/settlement/preview',
      token: sellerAToken,
      body: {
        sellerGoodsTaxable: '1000.00',
        sellerGstRatePercent: '18.00',
        commissionFlatInr: '100.00',
        commissionGstRatePercent: '18.00',
        applyGstTcs: false,
        applyWithholding: false,
      },
    });

    assert.equal(settlementRes.status, 200);
    const s = settlementRes.body.settlement;
    assert.equal(s.sellerGoodsTaxable, '1000.00');
    assert.equal(s.sellerGstAmount, '180.00');
    assert.equal(s.sellerGrossProceeds, '1180.00');
    assert.equal(s.commissionTaxable, '100.00');
    assert.equal(s.commissionGstAmount, '18.00');
    assert.equal(s.totalQcomDeductions, '118.00');
    assert.equal(s.netSellerSettlement, '1062.00', 'Contractual formula: 1180.00 - 100.00 - 18.00 = 1062.00');

    // With Section 52 GST-TCS (0.5% on ₹1,000 = ₹5.00) and TDS Section 393 (0.1% on ₹1,000 = ₹1.00)
    const statutorySettlement = await taxEngine.calculateSettlementPreview({
      sellerGoodsTaxable: '1000.00',
      sellerGstRatePercent: '18.00',
      commissionFlatInr: '100.00',
      commissionGstRatePercent: '18.00',
      applyGstTcs: true,
      tcsRatePercent: '0.50',
      applyWithholding: true,
      withholdingRatePercent: '0.10',
    });
    assert.equal(statutorySettlement.tcsAmount, '5.00');
    assert.equal(statutorySettlement.withholdingAmount, '1.00');
    assert.equal(statutorySettlement.netSellerSettlement, '1056.00', '1062.00 - 5.00 (TCS) - 1.00 (TDS) = 1056.00');

    console.log('✓ Contractual settlement formula (₹1,000 + ₹180 - ₹100 - ₹18 = ₹1,062) verified');

    // =========================================================================
    // SPRINT 3.1: FROZEN TAX SNAPSHOT IMMUTABILITY
    // =========================================================================
    console.log('\n[Test 14] Testing Sprint 3.1: Frozen Tax Snapshot Immutability...');
    // Create an immutable quote snapshot
    const initialQuoteRes = await makeRequest({
      method: 'POST',
      path: '/api/v1/pricing/quote',
      token: customerToken,
      body: {
        merchantId,
        items: [{ productId: valveId, quantity: 1 }],
      },
    });
    const frozenQuoteId = initialQuoteRes.body.quote.quoteId;
    const frozenRate = initialQuoteRes.body.quote.items[0].gstRatePercent;

    // Seller updates catalog tax rate from 18% to 12% in seller_product_tax
    await taxEngine.declareSellerProductTax({
      productId: valveId,
      merchantId,
      hsnCode: '8467',
      gstRatePercent: 12.00,
    }, pool);

    // Retrieve historical quote snapshot: MUST REMAIN FROZEN at 18.00%
    const fetchedFrozenQuoteRes = await makeRequest({
      method: 'GET',
      path: `/api/v1/pricing/quote/${frozenQuoteId}`,
      token: customerToken,
    });
    assert.equal(fetchedFrozenQuoteRes.status, 200);
    assert.equal(
      fetchedFrozenQuoteRes.body.quote.items[0].gstRatePercent,
      frozenRate,
      'Historical quote snapshot MUST retain frozen tax rate regardless of subsequent catalogue alterations'
    );
    console.log('✓ Historical order tax snapshot remains completely frozen and immutable');

    // =========================================================================
    // DYNAMIC REAL-LIFE DATABASE-DRIVEN CALCULATIONS (ZERO HARDCODED AMOUNTS)
    // =========================================================================
    console.log('\n[Test 15] Testing Zero Hardcoding: Real-Life Dynamic Database-Driven Calculations...');

    // 15.1 Dynamic database-driven coupon validation
    // Applying WELCOME50 on cart >= 200 (2 valves @ 289 = 578.00)
    const validCouponRes = await makeRequest({
      method: 'POST',
      path: '/api/v1/pricing/quote',
      token: customerToken,
      body: {
        merchantId,
        items: [{ productId: valveId, quantity: 2 }],
        couponCode: 'WELCOME50',
      },
    });
    assert.equal(validCouponRes.status, 200);
    assert.equal(validCouponRes.body.quote.discountAmount, '50.00');
    assert.equal(validCouponRes.body.quote.appliedCoupon.code, 'WELCOME50');

    // Attempting WELCOME50 on cart below minimum threshold (1 valve @ 289.00 is fine, but let's test a fake cart)
    const invalidCouponRes = await makeRequest({
      method: 'POST',
      path: '/api/v1/pricing/quote',
      token: customerToken,
      body: {
        merchantId,
        items: [{ productId: valveId, quantity: 1 }],
        couponCode: 'NON_EXISTENT_COUPON_XYZ',
      },
    });
    assert.equal(invalidCouponRes.status, 422);
    assert.equal(invalidCouponRes.body.error, 'INVALID_COUPON');

    // Dynamically insert a brand new promotional coupon into PostgreSQL: FESTIVE25 (25% off up to ₹150)
    await pool.query(
      `INSERT INTO coupons (code, description, discount_type, discount_value, min_order_value_inr, max_discount_inr, valid_from)
       VALUES ('FESTIVE25', 'Diwali special 25% off', 'PERCENTAGE', 25.00, 100.00, 150.00, NOW() - interval '1 day')`
    );

    const festiveCouponRes = await makeRequest({
      method: 'POST',
      path: '/api/v1/pricing/quote',
      token: customerToken,
      body: {
        merchantId,
        items: [{ productId: valveId, quantity: 2 }], // 578.00 gross -> 25% is 144.50
        couponCode: 'FESTIVE25',
      },
    });
    assert.equal(festiveCouponRes.status, 200);
    assert.equal(festiveCouponRes.body.quote.discountAmount, '144.50', '25% of 578.00 is 144.50, read dynamically from coupons table');
    assert.equal(festiveCouponRes.body.quote.appliedCoupon.code, 'FESTIVE25');

    // 15.2 Real-Life Merchant Settlement from Database Contract Profile
    // Merchant A has commission_rate_percent = 15.00% in merchants table
    const merchSettlementRes = await makeRequest({
      method: 'POST',
      path: '/api/v1/pricing/settlement/preview',
      token: sellerAToken,
      body: {
        merchantId,
        sellerGoodsTaxable: '2000.00',
        sellerGstRatePercent: '18.00',
      },
    });
    assert.equal(merchSettlementRes.status, 200);
    const ms = merchSettlementRes.body.settlement;
    // Gross: 2000 + 18% (360) = 2360.00
    assert.equal(ms.sellerGrossProceeds, '2360.00');
    // Commission: 15% of 2000 = 300.00 (from merchants.commission_rate_percent)
    assert.equal(ms.commissionTaxable, '300.00');
    // Commission GST: 18% of 300 = 54.00 (from statutory_tax_rules SAC 9983)
    assert.equal(ms.commissionGstAmount, '54.00');
    assert.equal(ms.totalQcomDeductions, '354.00');
    // TCS: 0.5% of 2000 = 10.00 (from gst_tcs_rules)
    assert.equal(ms.tcsAmount, '10.00');
    // TDS: 0.1% of 2000 = 2.00 (from statutory_withholding_rules Section 393)
    assert.equal(ms.withholdingAmount, '2.00');
    // Net: 2360 - 354 - 10 - 2 = 1994.00
    assert.equal(ms.netSellerSettlement, '1994.00');
    console.log('✓ Real-life merchant settlement dynamically derived from live database records without hardcoding');

    // 15.3 Dynamic Distance Resolution from Customer Saved Address GPS Coordinates
    const autoDistanceRes = await makeRequest({
      method: 'POST',
      path: '/api/v1/pricing/quote',
      token: customerToken,
      body: {
        merchantId,
        items: [{ productId: valveId, quantity: 1 }],
        // Notice: distanceKm and customerLocation are NOT passed
        // The engine must dynamically resolve distance from customer's saved address in saved_addresses table!
      },
    });
    assert.equal(autoDistanceRes.status, 200);
    const autoQuote = autoDistanceRes.body.quote;
    const autoDelivery = autoQuote.charges.find((c: any) => c.chargeType === 'DELIVERY');
    assert.ok(autoDelivery);
    assert.ok(parseFloat(autoDelivery.taxableAmount) >= 35.00);
    console.log(`✓ Real-life Haversine distance dynamically calculated from customer saved address: ${autoDelivery.description}`);
  } finally {
    setPool(null);
    await pool.end();
  }
}

