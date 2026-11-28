# SPRINT 16.1 — INDEPENDENT PRICING, GST, COUPON, REFUND & FINANCIAL LEDGER INTEGRITY VERIFICATION REPORT

**Repository:** `https://github.com/theRawHawn/Q-Com-Backend.git`  
**Branch:** `main`  
**Target Directory:** `QCOM/backend`  
**Baseline Code Commit Inspected:** `007a3653ce8d515637ef08d8efa3755ca3034121` (docs commit `640e2ee`, prior CI Run `45834260969`)  
**Sprint 16.1 Remediated Code Commit:** `75b81b72481ff8135e814e9baf3e9e26555de399`  
**Sprint 16.1 CI Verification Run ID:** `46155756761` (`test` Job `141011929294` + `real-services-integration` Job `141011929122` — both `success`)  
**Scope Compliance:** Verified strictly scoped to `QCOM/backend/**` and `.github/workflows/ci.yml`. Zero modifications to `QCOM/customer-app/src/**`, `QCOM/delivery-app/**`, `QCOM/admin-portal/src/**`, root `src/**`, or historical migrations `001`–`031`.  
**Payment Gateway Neutrality:** Strictly maintained — zero payment gateway selected (`mock` / provider-neutral adapter architecture preserved).

---

## A. Executive Summary

An independent, code-first financial integrity verification of Sprint 16.0 (`007a3653ce8d515637ef08d8efa3755ca3034121`) was performed across QCOM's pricing engine, Indian GST engine, coupon/promotion reservation lifecycle, cart service, checkout idempotency, partial/full return refund & GST credit-note pipelines, double-entry General Ledger (including COA `5040`), Check 14 reconciliation, Migration `031`, security/IDOR boundaries, and sliding-window rate limiting.

Rather than treating Sprint 16.0's implementation report as sufficient proof, actual SQL constraints, transaction locks, BigNumber rounding paths, route fingerprints, and GL journal postings were audited and stress-tested. The audit uncovered **3 Critical**, **5 High**, and **3 Medium** concrete defects across quote single-use/ownership enforcement, checkout idempotency fingerprinting, concurrent cross-coupon `first_order_only` serialization, promotion status enforcement under DB lock, discount rounding/share allocation, `FREE_DELIVERY` return preservation, invoice service-tax lookup (`totalGstAmount` vs `taxAmount` header-vs-line drift), invoice fail-closed GST enforcement, 3-phase QC return crash recovery, cumulative partial-return credit-note rounding drift, COA `5040` subsidy unwinding on return clawbacks, missing DB constraints (`032` forward migration), missing route rate limiters, and Check 14 (`14E`–`14J`) blind spots.

All 11 confirmed defects were surgically repaired in code and forward-only **Migration `032`**, covered by **6 comprehensive regression groups (`tests/sprint16-1-independent-financial-integrity.test.ts`)** plus **PostgreSQL 16 + Redis 7.0.15 integration checks (`tests/integration/real-services.test.ts`)**, and all 10 architecture/API/database documents were reconciled.

---

## B. Repository Baseline and Final Commit Hashes

| Stage | Commit SHA / Reference | Notes |
| --- | --- | --- |
| **Expected Baseline (Sprint 16.0 Code)** | `007a3653ce8d515637ef08d8efa3755ca3034121` | Baseline source inspected (`CI Run 45834260969`). |
| **Sprint 16.0 Docs Baseline** | `640e2ee` (`origin/main` pre-16.1) | Matched `origin/main` HEAD at start of push cycle. |
| **Sprint 16.1 Remediated Code + Migration 032 + Docs Commit** | `75b81b72481ff8135e814e9baf3e9e26555de399` | Contains Migration `032`, service/route remediations, PG16 extended-protocol explicit casts + transaction error logging, Suite 61 (`sprint16-1`), `real-services.test.ts`, `.github/workflows/ci.yml`, and reconciled `.md` documentation (verified by CI Run `46155756761`). |
| **Sprint 16.1 Finalized Report Commit** | Subsequent docs-only commit on `main` (parent `75b81b72481ff8135e814e9baf3e9e26555de399`) | Populates Sections B, J & S with verified CI Run `46155756761` (`141011929294` & `141011929122`) evidence from GitHub Actions. |

**Historical Immobility Verified:** Migrations `001` through `031` remain byte-for-byte unmodified. Schema remediations live exclusively in forward migration `032_sprint16_1_financial_integrity_remediation.sql`.

---

## C. Exact Files Inspected

- **Pricing, Tax, Coupons, Promotions & Cart:**
  - `QCOM/backend/src/modules/pricing/money.ts`
  - `QCOM/backend/src/modules/pricing/pricingTypes.ts`
  - `QCOM/backend/src/modules/pricing/pricingEngine.ts`
  - `QCOM/backend/src/modules/pricing/taxEngine.ts`
  - `QCOM/backend/src/modules/pricing/couponPromotionService.ts`
  - `QCOM/backend/src/modules/pricing/cartService.ts`
- **Orders, Cancellations, Returns, Refunds & Recovery:**
  - `QCOM/backend/src/modules/orders/orderService.ts`
  - `QCOM/backend/src/modules/orders/returnService.ts`
  - `QCOM/backend/src/modules/orders/cancellationService.ts`
  - `QCOM/backend/src/modules/payments/paymentService.ts`
  - `QCOM/backend/src/modules/payments/refundService.ts`
  - `QCOM/backend/src/modules/recovery/financialRecoveryWorker.ts`
- **Invoices, Ledger, Settlements & Reconciliation:**
  - `QCOM/backend/src/modules/invoices/invoiceService.ts`
  - `QCOM/backend/src/modules/invoices/invoiceTypes.ts`
  - `QCOM/backend/src/modules/invoices/pdfGenerator.ts`
  - `QCOM/backend/src/modules/ledger/ledgerService.ts`
  - `QCOM/backend/src/modules/settlements/sellerSettlementService.ts`
  - `QCOM/backend/src/modules/settlements/settlementAllocationService.ts`
  - `QCOM/backend/src/modules/reconciliation/paymentReconciliationService.ts`
- **HTTP Routes & Security Middleware:**
  - `QCOM/backend/src/routes/orderRoutes.ts`
  - `QCOM/backend/src/routes/pricingRoutes.ts`
  - `QCOM/backend/src/routes/cartRoutes.ts`
  - `QCOM/backend/src/routes/returnRoutes.ts`
  - `QCOM/backend/src/routes/invoiceRoutes.ts`
  - `QCOM/backend/src/routes/adminCompatibilityRoutes.ts`
  - `QCOM/backend/src/middleware/rateLimiter.ts`
  - `QCOM/backend/src/middleware/rbac.ts`
  - `QCOM/backend/src/middleware/resourceOwnership.ts`
- **Migrations, Tests, CI & Docs:**
  - `QCOM/backend/migrations/031_sprint16_0_pricing_gst_coupons_promotions.sql` (plus `001`–`030` left untouched)
  - `QCOM/backend/tests/run-all-tests.ts`, `tests/integration/real-services.test.ts`, `tests/sprint16-0-pricing-gst-coupons-promotions.test.ts`, `tests/sprint9-returns-cancellations.test.ts`, `tests/sprint7-settlements.test.ts`, `tests/sprint4-migration.test.ts`
  - `.github/workflows/ci.yml`
  - `DATABASE.md`, `ARCHITECTURE.md`, `API.md`, `FEATURES.md`, `TESTING.md`, `DEBUGGING.md`, `README.md`, `DESIGN.md`, `PLAN.md`, `PRD.md`, `SPRINT_16_0_PRICING_GST_COUPONS_PROMOTIONS_INTEGRITY_REPORT.md`

---

## D. Exact Files Modified

### Forward Migration, Core Source & Routes (`QCOM/backend/**` + `.github/workflows/ci.yml`)
1. `QCOM/backend/migrations/032_sprint16_1_financial_integrity_remediation.sql` *(new forward migration)*
2. `QCOM/backend/src/modules/pricing/pricingEngine.ts`
3. `QCOM/backend/src/modules/pricing/couponPromotionService.ts`
4. `QCOM/backend/src/modules/orders/orderService.ts`
5. `QCOM/backend/src/routes/orderRoutes.ts`
6. `QCOM/backend/src/modules/orders/returnService.ts`
7. `QCOM/backend/src/modules/invoices/invoiceService.ts`
8. `QCOM/backend/src/modules/settlements/sellerSettlementService.ts`
9. `QCOM/backend/src/modules/ledger/ledgerService.ts`
10. `QCOM/backend/src/modules/reconciliation/paymentReconciliationService.ts`
11. `QCOM/backend/src/middleware/rateLimiter.ts`
12. `QCOM/backend/src/routes/pricingRoutes.ts`
13. `QCOM/backend/src/routes/cartRoutes.ts`
14. `QCOM/backend/src/routes/returnRoutes.ts`
15. `QCOM/backend/src/database/connection.ts` *(safe transaction error code/message logging without credential exposure)*

### Tests & CI Workflow
15. `QCOM/backend/tests/sprint16-1-independent-financial-integrity.test.ts` *(new Suite 61)*
16. `QCOM/backend/tests/sprint16-0-pricing-gst-coupons-promotions.test.ts` *(synthetic Check 14D drift probe adjusted to `usage_count - 1` so Migration 032 `chk_coupons_usage_within_limit` holds)*
17. `QCOM/backend/tests/run-all-tests.ts`
18. `QCOM/backend/tests/integration/real-services.test.ts`
19. `.github/workflows/ci.yml`

### Reconciled Documentation (`QCOM/backend/*.md`)
20. `QCOM/backend/DATABASE.md`
21. `QCOM/backend/ARCHITECTURE.md`
22. `QCOM/backend/API.md`
23. `QCOM/backend/FEATURES.md`
24. `QCOM/backend/TESTING.md`
25. `QCOM/backend/DEBUGGING.md`
26. `QCOM/backend/README.md`
27. `QCOM/backend/DESIGN.md`
28. `QCOM/backend/PLAN.md`
29. `QCOM/backend/PRD.md`
30. `QCOM/backend/SPRINT_16_1_INDEPENDENT_FINANCIAL_INTEGRITY_VERIFICATION_REPORT.md` *(new report)*

---

## E. Findings Classified by Severity

### Critical Defects (3)
- **CRIT-01 (`invoiceService.ts:188-255`):** `QCOM_PLATFORM_INVOICE` line items read `snapDelivery?.totalGstAmount` instead of `PricingCharge.taxAmount`, causing header (`₹47.20`) vs. line-item (`₹40.00`) GST drift (`INVOICE_LINE_ITEMS_DRIFT` caught empirically by Check `14F`); missing `statutory_tax_rules` could fail open/silently if snapshot delivery lines were absent.
- **CRIT-02 (`couponPromotionService.ts`, `orderService.ts`):** Dual-coupon `first_order_only` concurrency race across *different* coupon codes allowed a new customer to satisfy `existingOrders === 0` simultaneously across two connections, plus an under-lock deactivated promotion (`is_active = FALSE` after quote) could be silently skipped instead of throwing `409 PROMOTION_INACTIVE`.
- **CRIT-03 (`returnService.ts`, `032` migration):** Non-atomic 3-phase crash boundary during `qcInspectAndResolve()` lacked deterministic refund key (`ret_qc_${ret.id}`), pre-gateway `RETURN_QC_IN_PROGRESS` lock check, and `uq_credit_notes_return_type` unique partial index — risking duplicate gateway refunds or duplicate credit notes if Phase 2/3 retried or raced.

### High Defects (5)
- **HIGH-01 (`orderService.ts:100-170`, `032` migration):** Quote lookup lacked strict user ownership (`QUOTE_ACCESS_DENIED` 403), merchant binding (`QUOTE_MERCHANT_MISMATCH` 409), single-use lock (`converted_at IS NOT NULL` -> `QUOTE_ALREADY_USED` 409), and mandatory post-quote drift detection (`409 PRICE_CHANGED`) even when callers omitted `expectedTotal`.
- **HIGH-02 (`sellerSettlementService.ts`, `ledgerService.ts`, `032` migration):** Return clawbacks did not proportionally reverse `platform_discount_subsidy` (`Cr 5040`), leaving COA `5040` overstated after full returns of platform-subsidized orders and risking unbalanced journal entries if unaccounted.
- **HIGH-03 (`pricingEngine.ts`, `returnService.ts`, `orderRoutes.ts`):** Duplicate `productId` lines in quote/checkout or duplicate `orderItemId` lines in `requestReturn()` bypassed clean aggregation or distorted `Idempotency-Key` SHA-256 fingerprints (`orderRoutes.ts`), and negative/NaN `distanceKm` inputs were not rejected (`400 INVALID_DISTANCE`).
- **HIGH-04 (`couponPromotionService.ts:970-980` & allocation):** `FREE_DELIVERY` promotions (`discountTarget === 'DELIVERY'`) were erroneously eligible for reversal on item returns, and fractional currency splits across multiple items/funding sources needed deterministic residual-paisa sweep to guarantee exact line sum == coupon total == `sellerShareAmount + platformShareAmount`.
- **HIGH-05 (`paymentReconciliationService.ts:1292-1590`):** Check `14A–14D` missed order-item-vs-snapshot totals drift (`14E`), invoice header-vs-line drift (`14F`), credit-note completeness/ceiling drift (`14G`), cancelled/paid coupon status & cap drift (`14H`), COA `5040` subsidy/reversal parity (`14I`), and GL batch `DR != CR` parity (`14J`).

### Medium Defects (3)
- **MED-01 (`invoiceService.ts`):** Sequential 3-step uneven partial returns (e.g. `10.03 * 3` on `₹35.51` paid total) accumulated 1–2 paisa rounding drift across standalone credit notes without closing remainder reconciliation against `order_items.line_total_payable`, and credit note generation failed to auto-create/link a missing `SELLER_TAX_INVOICE`.
- **MED-02 (`032_sprint16_1_financial_integrity_remediation.sql`):** Database lacked hard CHECK constraints enforcing `coupons.usage_count <= usage_limit`, `promotions.usage_count <= usage_limit`, and `order_items.refunded_quantity BETWEEN 0 AND quantity`.
- **MED-03 (`rateLimiter.ts`, `pricingRoutes.ts`, `cartRoutes.ts`, `returnRoutes.ts`):** High-frequency quote/coupon validation/return/cart endpoints lacked dedicated sliding-window Redis 7 limiters (`couponValidationRateLimiter` / `returnActionRateLimiter` fail-closed `503` on Redis outage; `pricingQuoteRateLimiter` / `cartRateLimiter` fail-open with audit headers).

### Verified No-Defect Areas
- `money.ts`: Consistent `BigNumber` (`ROUND_HALF_UP`, `DECIMAL_PLACES: 20`) decimal arithmetic throughout pricing, tax, prorating, and settlement math — zero JS `Number` rounding bugs in money calculations.
- `taxEngine.ts`: `indian_states` validation rejects invalid state codes (`422 INVALID_STATE_CODE`), unverified tax classifications (`422`), computes CGST+SGST intra-state and IGST inter-state + cess accurately for tax-inclusive and tax-exclusive items.
- `cancellationService.ts` + `couponPromotionService.releaseForOrder`: Cancelling releases reserved coupon/promotion slots (`usage_count` decremented safely >= 0); delayed `markRedeemedForOrder` cannot resurrect `'RELEASED'` records.
- `invoiceService.ts`: Dynamic Apr–Mar Indian FY calculation (`computeIndianFinancialYear()`) and honest `irn: null` when `EINVOICING_ENABLED=false`.

---

## F. Defect Evidence and Reproduction Steps

1. **`CRIT-01` (Reproduced Empirically via Check 14F):** Generating quotes with delivery fee ₹40.00 + 18% GST (`₹7.20`) stored `taxAmount: "7.20"` on `snapshot.charges[0]`. Calling `invoiceService.getOrCreateOrderInvoices(orderId)` created `QCOM_PLATFORM_INVOICE` with header `total_amount = 47.20` (`total_tax_amount = 7.20`), while `invoice_line_items` inserted `total_line_amount = 40.00` (`cgst_amount = 0.00`, `sgst_amount = 0.00`). Running Check `14F` immediately surfaced `INVOICE_LINE_ITEMS_DRIFT` (`expectedAmount: 47.2, actualAmount: 40`).
2. **`CRIT-02` (Concurrency Race):** Customer `U` with 0 prior orders concurrently submits Checkout A with `FIRST50A` and Checkout B with `FIRST50B`. Without row-level serialization on `users WHERE id = $1 FOR UPDATE`, both transactions count `existingOrders === 0` concurrently and both redeem a `first_order_only` coupon.
3. **`CRIT-03` (Crash / Duplicate QC Race):** Process crashes right after gateway refund succeeds (Phase 2) before return status flips to `REFUNDED` (Phase 3), or two QC workers invoke `qcInspectAndResolve()` concurrently. Without a deterministic refund idempotency key `ret_qc_${ret.id}` and DB unique index `uq_credit_notes_return_type`, retry/concurrency could issue a second refund or duplicate `SELLER_CREDIT_NOTE`.
4. **`HIGH-01`:** Submitting Customer A's `quoteId` by Customer B, re-submitting an already converted `quoteId`, or omitting `expectedTotal` after admin updated `store_inventory.selling_price` bypassed quote isolation or failed to surface `409 PRICE_CHANGED`.
5. **`HIGH-02`:** Creating a `₹100` platform-coupon subsidized order, allocating seller settlement (`Dr 5040 ₹100`), and returning the full order clawed back seller payable while leaving `gl_entries(5040)` net Debit `₹100` instead of `₹0.00`.

---

## G. Root Cause for Each Confirmed Defect

- **CRIT-01:** Schema property mismatch: `pricingEngine.ts` emits `PricingCharge.taxAmount`, whereas `invoiceService.ts` read non-existent `snapDelivery?.totalGstAmount`, silently coalescing to `'0.00'`.
- **CRIT-02:** `lockAndReserveForOrder` previously locked only the target `coupons` row (`FOR UPDATE`). Two *distinct* coupon rows did not serialize against each other, leaving `first_order_only` check vulnerable to Read Committed snapshots; promotion availability check also skipped inactive promotions with `continue` rather than failing fast (`409 PROMOTION_INACTIVE`).
- **CRIT-03:** `returnService.qcInspectAndResolve` used an ad-hoc idempotency pattern without persisting `refund_id` immediately under lock or holding a partial unique constraint on `credit_notes(return_id, credit_note_type)`.
- **HIGH-01:** `pricing_calculation_snapshots` lacked `converted_at` tracking and `orderService.ts` only checked `expectedTotal` when explicitly passed by the client.
- **HIGH-02:** `order_settlement_allocations` tracked `platform_discount_subsidy` without a cumulative `reversed_platform_subsidy` column, and `recordSellerReturnClawback` lacked a `Cr 5040` leg.
- **HIGH-03/04:** Line aggregation was performed post-validation; `allocateDiscountProportionally` lacked largest-remainder paisa sweep across funding shares; `reverseForOrder` reversed every `APPLIED` promotion row including `discountTarget = 'DELIVERY'`.
- **HIGH-05 / MED-01..03:** Sprint 16.0 Check `14A–14D` covered only IRN, GST mutual exclusion, and usage count parity; missing DB CHECKs and route rate limiters left boundary paths relying solely on app logic.

---

## H. Exact Repair Implemented

1. **Migration `032` (`migrations/032_sprint16_1_financial_integrity_remediation.sql`):**
   - Added `pricing_calculation_snapshots.converted_at TIMESTAMPTZ` + `idx_snapshots_order_converted`.
   - Added `order_settlement_allocations.reversed_platform_subsidy NUMERIC(10,2) NOT NULL DEFAULT 0.00 CHECK (>= 0)`.
   - Added partial unique index `uq_credit_notes_return_type ON credit_notes(return_id, credit_note_type) WHERE return_id IS NOT NULL`.
   - Added CHECK constraints `chk_coupons_usage_within_limit`, `chk_promotions_usage_within_limit`, and `chk_order_items_refund_qty_bound`.
2. **Pricing Engine (`pricingEngine.ts`):** Validates finite `distanceKm >= 0` (`400 INVALID_DISTANCE`); merges duplicate `productId` lines upfront before inventory/GST/discount passes.
3. **Order Service & Route Fingerprint (`orderService.ts`, `orderRoutes.ts`):** Enforces quote ownership (`403 QUOTE_ACCESS_DENIED`), merchant match (`409 QUOTE_MERCHANT_MISMATCH`), single-use lock (`converted_at IS NOT NULL` -> `409 QUOTE_ALREADY_USED`), and price-drift detection (`409 PRICE_CHANGED` even when `expectedTotal` omitted); canonicalizes duplicate items and hashes optional `merchantId`/`deliveryAddressId`/`placeOfSupplyStateCode`/`quoteId`/`expectedTotal` conditionally into the `Idempotency-Key` SHA-256 fingerprint (preserving exact legacy fingerprint compatibility when omitted).
4. **Coupon & Promotion Service (`couponPromotionService.ts`):** Locks `users`, `coupons`, and `promotions` using `FOR NO KEY UPDATE` inside `lockAndReserveForOrder` (preventing concurrent dual-coupon `first_order_only` races without triggering `FOR KEY SHARE <-> FOR UPDATE` foreign-key upgrade deadlocks against `pricing_calculation_snapshots`/`orders` on real PostgreSQL 16); adds explicit `$2::varchar` casts in `reverseForReturn` for PG16 extended-protocol typing safety; throws `409 PROMOTION_INACTIVE` for inactive/expired promotions under lock; adds largest-remainder paisa sweep + funding-share reconciliation in `allocateDiscountProportionally`; skips `discountTarget === 'DELIVERY'` during `reverseForReturn` (`FREE_DELIVERY` stays `'APPLIED'`).
5. **Return Service (`returnService.ts`):** Aggregates duplicate `orderItemId` lines in `requestReturn()`; hardens `qcInspectAndResolve()` into crash-safe 3-phase execution with deterministic key `ret_qc_${ret.id}`, `RETURN_QC_IN_PROGRESS` guard on `PENDING`/`PROCESSING` refunds, `COMPLETED` refund reuse + amount check (`RETURN_REFUND_MISMATCH`), and immediate `order_returns.refund_id` linkage.
6. **Invoice & Credit Note Service (`invoiceService.ts`):** Fixes `snapDelivery.taxAmount ?? snapDelivery.totalGstAmount ?? add(cgst, sgst, igst)` on lines `197–218`; eliminates duplicate `$3` parameter reuse in `invoice_line_items` fee inserts; fails closed if `statutory_tax_rules` is missing; auto-creates missing parent `SELLER_TAX_INVOICE` when issuing credit notes; reconciles final cumulative return to exact `line_total_payable` (`₹0.00` cumulative drift across uneven 3-step partial returns).
7. **COA `5040` Unwind & GL (`sellerSettlementService.ts`, `ledgerService.ts`):** Proportionally reverses `platform_discount_subsidy` (`Cr 5040`) during return clawbacks (`reversed_platform_subsidy`) with explicit `$3::boolean` PG16 cast, balancing `DR == CR` and restoring seller & `5040` balances cleanly to `0.00` on full return.
8. **Check `14E–14J` (`paymentReconciliationService.ts`):** Added read-only audit checks for order-item vs. snapshot totals (`14E`), invoice header vs. line items & seller invoice parity (`14F`), credit note line-sum/ceiling/missing-parent/`refunded_quantity` bounds (`14G`), coupon/promo limit & cancelled/paid state drift (`14H`), COA `5040` subsidy/reversal parity (`14I`), and journal batch `DR != CR` imbalance (`14J`).
9. **Rate Limiters (`rateLimiter.ts`, `pricingRoutes.ts`, `cartRoutes.ts`, `returnRoutes.ts`):** Mounted `pricingQuoteRateLimiter` (60/min open), `couponValidationRateLimiter` (20/min closed `503`), `returnActionRateLimiter` (30/min closed `503`), and `cartRateLimiter` (60/min open).

---

## I. Regression Test Added for Each Repair

All 6 targeted groups live in **`QCOM/backend/tests/sprint16-1-independent-financial-integrity.test.ts`** (Suite 61 in `run-all-tests.ts`), complemented by real-database checks in **`QCOM/backend/tests/integration/real-services.test.ts`**:
- **Group A:** Duplicate quote/checkout `productId` merge, negative/NaN `distanceKm` `400`, quote IDOR `403`, wrong merchant `409`, single-use `409 QUOTE_ALREADY_USED`, price drift `409 PRICE_CHANGED` even with omitted `expectedTotal`, canonical POS idempotency SHA-256 sensitivity (`placeOfSupplyStateCode` mismatch).
- **Group B:** Fractional 3-item `SHARED` coupon `33.33%` split exact paisa & `sellerShare + platformShare == discountAmount` reconciliation, `409 PROMOTION_INACTIVE` under lock, `FREE_DELIVERY` preserved `'APPLIED'` after item return.
- **Group C:** Duplicate return item line rejection/aggregation, auto-creation/linking of missing parent `SELLER_TAX_INVOICE`, 3-step uneven sequential partial return (`₹10.03 * 3 = ₹35.51` total paid) yielding exact `₹0.00` cumulative credit note & refund drift, fail-closed `TAX_RULE_NOT_FOUND` on inactive `DELIVERY_GST` rule.
- **Group D:** `RETURN_QC_IN_PROGRESS` concurrency block when refund row stuck `PENDING`, Phase 2 -> Phase 3 simulated crash recovery reusing `COMPLETED` `ret_qc_${ret.id}` refund cleanly, full return COA `5040` unwind (`SUM(DR 5040) == SUM(CR 5040)`).
- **Group E:** Synthetic corruption & live detection of Checks `14E`, `14F`, `14G`, `14H`, `14I`, and `14J`; Redis failure behavior proving `couponValidationRateLimiter` / `returnActionRateLimiter` fail closed (`503`) vs. `pricingQuoteRateLimiter` / `cartRateLimiter` failing open with `X-RateLimit-Status: degraded-fail-open`.
- **Group F:** Expired quotes (`409`), invalid Indian state code (`422`), unverified seller product HSN (`422`), IGST inter-state split, promotion `conflict_group` winner selection, cart IDOR `403`, customer `403` RBAC on `/api/v1/admin/reconciliation/payments/run`, `/api/v1/admin/coupons`, and cross-customer invoice IDOR (`403`).

---

## J. Real PostgreSQL and Redis Verification Evidence

> **Evidence Distinction Rule:** Local `pg-mem` execution is explicitly separated below from GitHub Actions real PostgreSQL 16 + Redis 7.0.15 integration execution.

| Environment | What Actually Executed | Result |
| --- | --- | --- |
| **Local Workspace (`pg-mem` / No local PG16/Redis daemons)** | `npm --prefix QCOM/backend run build`, `npx tsc --noEmit`, `npm run lint`, plus `pg-mem` execution of `testMigrations`, `runSprint4MigrationTests`, `runSprint7SettlementsTests`, `runSprint9ReturnsCancellationsTests` (25 tests), `testPricingAndTaxEngine`, `runSprint15_9CodCashAccountabilityTests`, `runSprint16_0PricingGstCouponsPromotionsTests`, `runSprint16_1IndependentFinancialIntegrityTests` (Groups A–F) | **PASSED LOCALLY** (`0` TS errors, all listed `pg-mem` suites green). Local PG16/Redis suites (`sprint15-5`, `real-services.test.ts`) could not connect locally (`ECONNREFUSED`) because PG16/Redis binaries do not run in the sandbox. |
| **GitHub Actions Job 1 (`All 61 Test Suites & Infrastructure Verification`, Run `46155756761`, Job `141011929294`)** | Fresh PostgreSQL `16.16` (`qcom_test`/`qcom_staging`/`qcom_db`) + Redis `7.0.15`, Migrations `001`–`032`, Seeds, all 61 suites in `run-all-tests.ts`, `tsc`, `lint`, root & backend builds | **PASSED (`success`)** — All 61 suites passed in `43.32s` (including Sprint 16.0 `8/8` groups & Sprint 16.1 `6/6` groups); `tsc`, `npm run lint`, `npm --prefix QCOM/backend run build`, and `npm run build` exited `0`. |
| **GitHub Actions Job 2 (`Real-Services Integration Harness — PG 16 & Redis 7.0.15`, Run `46155756761`, Job `141011929122`)** | Isolated Docker Compose PG `16.6` & Redis `7.0.15`, fresh + upgrade migrations (`001`–`032`), SQLSTATE `23514`/`23505`, `runSprint16_0PostgresChecks`, `runSprint16_1PostgresChecks`, `couponValidationRateLimiter` real Redis 20-request admission + 3×`429` + `503` fault mode | **PASSED (`success`)** — Real PostgreSQL `16.6` and Redis `7.0.15` checks passed, including 200-way coupon race, dual `first_order_only` race, delayed webhook guard, concurrent QC single refund/CN, COA `5040` full unwind, and Check `14E–14J`. |
| **Live Production Infrastructure** | **NOT EXECUTED** | **UNVERIFIED IN PRODUCTION** |

---

## K. Concurrency Test Results

- **200-Way Same-Coupon Race (`runSprint16_0PostgresChecks` in PG 16):** 200 concurrent `Promise.allSettled` checkouts against `usage_limit = 100` — expects strictly 100 `fulfilled` (`usage_count === 100`), 100 rejected, clean release to `99` on cancellation.
- **Multi-Connection `first_order_only` Dual-Coupon Race (`runSprint16_1PostgresChecks` in PG 16):** 2 independent pooled connections race simultaneously on `first_order_only = TRUE` coupons `PG16FO1` vs. `PG16FO2` for one new customer (`foUserId`); serialized via `SELECT ... FROM users WHERE id = $1 FOR NO KEY UPDATE` — strictly 1 wins, 1 rejects cleanly, zero deadlocks (`40P01`).
- **Delayed Webhook Redemption After Release (`PG 16`):** Cancelling order flips `coupon_redemptions.status = 'RELEASED'`; subsequent delayed `markRedeemedForOrder()` leaves status `'RELEASED'`.
- **Concurrent `qcInspectAndResolve()` (`PG 16`):** Two concurrent QC resolution calls produce strictly `1` row in `refunds` and `1` row in `credit_notes`, guarded by deterministic idempotency key + `uq_credit_notes_return_type` (`23505`).
- **Redis 7.0.15 Sliding-Window Concurrency (`real-services.test.ts`):** Lua atomic script under multi-worker load (`20` allowed on `couponValidationRateLimiter`, requests `21–23` return `429`, Redis error triggers fail-closed `503`).

---

## L. Migration Verification

- **Forward-Only File:** `QCOM/backend/migrations/032_sprint16_1_financial_integrity_remediation.sql` (Migrations `001`–`031` verified untouched).
- **Verified Invariants & SQLSTATE Checks (`runSprint16_1PostgresChecks` + `migrations.test.ts`):**
  - Fresh installation (`001` -> `032`): verified in `pg-mem` (`testMigrations`) and scheduled for fresh PG 16 Docker DB in CI.
  - Upgrade installation (existing `001`–`031` upgraded cleanly to `032`): verified in `real-services.test.ts` (`upgradePool`).
  - Constraint enforcement: `SQLSTATE 23514` (`chk_coupons_usage_within_limit`) on `usage_count > usage_limit`; `SQLSTATE 23505` (`uq_credit_notes_return_type`) on duplicate `(return_id, credit_note_type)`.

---

## M. Accounting and Reconciliation Results

- **COA `5040` Subsidy Parity:** Verified end-to-end across platform coupons, shared coupons, seller returns, and full returns: initial allocation records `Dr 5040` (platform subsidy); return clawbacks credit `Cr 5040` proportionally via `reversed_platform_subsidy`, bringing `SUM(Dr 5040) === SUM(Cr 5040)` (`net = ₹0.00`) on full return (`Group D` & `PG 16`).
- **Expanded Check `14` (`14E`–`14J`):** All 6 new read-only discrepancy detectors are verified in `Group E` on synthetic broken records (`ORDER_ITEM_TOTALS_DRIFT`, `INVOICE_LINE_ITEMS_DRIFT`, `CREDIT_NOTE_INTEGRITY_DRIFT`, `COUPON_CANCELLED_ORDER_UNRELEASED`, `COA_5040_SUBSIDY_DRIFT`, `UNBALANCED_JOURNAL_BATCH`) and verified to emit `0` discrepancies across clean order/invoice/return flows (`PG 16` & `Group E`). Auto-repair remains strictly disabled for monetary/GST ledger anomalies (`manualReviewCount`, `status = 'OPEN'`).

---

## N. Security Verification

Verified via `tests/sprint16-1-independent-financial-integrity.test.ts` (Groups A & F) and middleware inspection:
- Customer cart isolation (`GET /api/v1/cart` scoped by `req.user.userId` + cross-customer cart/quote `403`).
- Quote ownership (`QUOTE_ACCESS_DENIED` `403`) and merchant pinning (`QUOTE_MERCHANT_MISMATCH` `409`).
- Cross-customer invoice/credit-note IDOR blocked (`403` in `invoiceRoutes.ts`).
- Admin financial endpoints (`POST /api/v1/admin/reconciliation/payments/run`, `GET /api/v1/admin/coupons`) reject customer JWTs with `403`.
- Client-supplied prices, discounts, and GST totals are ignored; checkout computes strictly from server snapshot & DB prices.

---

## O. System-Design Resilience Findings

- **Rate Limiting:** Financial-mutation/abuse-sensitive paths (`couponValidationRateLimiter`, `returnActionRateLimiter`, `checkout`, `payment`) fail closed (`503`) on Redis failures; read-heavy browse/quote paths (`pricingQuoteRateLimiter`, `cartRateLimiter`) fail open with explicit `X-RateLimit-Status: degraded-fail-open` headers so browse availability survives Redis glitches.
- **Lock Ordering & External I/O:** Gateway refund calls occur strictly outside DB row locks in Phase 2 of `returnService.qcInspectAndResolve`; lock hierarchy (`users -> coupons -> promotions -> store_inventory`) prevents cyclic deadlocks across concurrent promo/coupon/checkout flows.

---

## P. Remaining Limitations & Open Founder / Tax / Accounting Decisions

> **DO NOT IMPLEMENT ASSUMED POLICIES:** The following decisions require formal written sign-off from QCOM Founders, Chartered Accountant (CA), or Tax Counsel before production activation:

1. **Payment Gateway Selection:** Intentionally **UNSELECTED**. All checkout/refund/webhook flows remain provider-neutral (`mock` adapter only in non-prod). Selecting a gateway requires credential provisioning, webhook HMAC verification setup, and provider-specific settlement recon mapping.
2. **Product Catalog HSN/SAC & GST Classification Audit:** QCOM cannot invent HSN/SAC codes or tax rates. Prior to onboarding live SKUs, the seller catalog must undergo CA/tax verification (`is_tax_classification_verified = TRUE` required for every live SKU; unverified items intentionally fail closed with `422`).
3. **Section 34 Credit-Note Filing & IRP Thresholds:** Whether QCOM/sellers cross the statutory e-invoicing (NIC IRP) AATO turnover threshold, NIC sandbox/production GSP credentials, QR/IRN retry SLA, and Section 34(2) September-30 / annual-return statutory cutoff validation require CA sign-off before enabling `EINVOICING_ENABLED=true`.
4. **Partial-Return Commercial Rules (`FREE_DELIVERY` / Cart Slabs / BOGO):** Current behavior preserves `FREE_DELIVERY` (`discountTarget='DELIVERY'`) as non-reversed on item returns and allocates item discounts proportionally. Founders must formally confirm whether crossing below a minimum-spend threshold on a partial return triggers clawback of flat coupons / cart slabs / BOGO freebies or stays non-clawed-back.
5. **Runtime PostgreSQL Role Hardening (`NOSUPERUSER`):** Application runtime connections in staging/production must use a non-superuser role (`NOSUPERUSER`, no `BYPASSRLS`) rather than `qcom_it_admin`/superuser used in containerized setup scripts.

---

## Q. Explicit Statement of What Was Not Tested

- **Live Production Environment:** Zero tests were run against production servers, production PostgreSQL databases, production Redis clusters, live customer traffic, or real UPI/card money movement.
- **Live NIC IRP E-Invoicing API:** External IRP calls (`irn` generation / GSP timeouts) are not implemented and not tested (`EINVOICING_ENABLED=false`).
- **Live Payment Gateway SDKs & Webhooks:** Excluded per strict Sprint 16.1 rule §2.1.
- **Sustained High-Volume Production Load / Chaos Testing:** Not tested beyond the CI 200-way coupon race, 2-connection multi-pool races, and Phase 2->3 crash simulation.
- **Actual Hard DB Process `SIGKILL` During `qcInspectAndResolve`:** Crash recovery was validated by deterministic state simulation (Phase 2 committed refund row + Phase 3 replay) rather than `kill -9` on PostgreSQL mid-commit.

---

## R. Production-Readiness Assessment

QCOM's pricing, GST, coupon/promotion concurrency, return refund/credit-note, COA `5040` subsidy unwind, and Check 14 reconciliation subsystems are **architecturally sound, CI-verified on real PostgreSQL 16 & Redis 7.0.15 (`Run 46155756761`), and ready for STAGING validation**, **NOT approved for immediate production launch** due to the undecided founder/CA/tax policies in Section P and untested live gateway/IRP/production infrastructure in Section Q.

---

## S. Final Git Commit and GitHub Actions CI Run IDs

- **Code + Migration 032 + Docs Commit (`main`):** `75b81b72481ff8135e814e9baf3e9e26555de399`
- **CI Workflow Run (`QCOM Backend CI`):** `46155756761` (`https://github.com/theRawHawn/Q-Com-Backend/actions/runs/46155756761`, `completed` — `success`)
- **Job 1 (`All 61 Test Suites & Infrastructure Verification`):** `141011929294` (`completed` — `success`, PostgreSQL `16.16` + Redis `7.0.15`, 61/61 suites passed in `43.32s`)
- **Job 2 (`Real-Services Integration Harness (PG 16 & Redis 7.0.15)`):** `141011929122` (`completed` — `success`, PostgreSQL `16.6` + Redis `7.0.15`)
- **Final Report Update Commit (`main`):** Docs-only report finalization commit directly succeeding `75b81b72481ff8135e814e9baf3e9e26555de399` on `main`

---

## 17. FINAL GATE DECISION

**`APPROVED WITH CONDITIONS — STAGING ONLY`**

**Mandatory Conditions Before Production:**
1. *(Satisfied)* Green GitHub Actions CI completion (`test` Job `141011929294` + `real-services-integration` Job `141011929122` in Run `46155756761` on PostgreSQL 16 & Redis 7.0.15) recorded in Sections B, J & S.
2. Founder/CA written sign-off on all Section P policy decisions (Section 34 cutoffs, IRP threshold & credentials, partial-return coupon/BOGO clawback policy, catalog HSN/SAC audit).
3. Dedicated payment gateway selection sprint and non-superuser runtime PostgreSQL role configuration prior to live money movement.
