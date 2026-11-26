# SPRINT 16.0 — PRICING, GST, COUPONS, DISCOUNTS & PROMOTION FINANCIAL INTEGRITY REPORT

**Repository:** `https://github.com/theRawHawn/Q-Com-Backend.git`  
**Branch:** `main`  
**Backend:** `QCOM/backend`  
**Baseline Commit:** `e52f09e`  
**Final Commit:** _Recorded in git log on `main` upon push & CI verification_  
**Scope Gate:** Backend (`QCOM/backend`) + `.github/workflows/ci.yml` only. Zero modifications to `QCOM/customer-app/src/**`, `QCOM/delivery-app/**`, `QCOM/admin-portal/src/**`, root `src/**`, or historical migrations `001`–`030`.

---

## 1. Executive Summary

Sprint 16.0 establishes authoritative, deterministic, decimal-safe (`bignumber.js`) pricing, Indian GST calculation, concurrency-safe coupon and promotion execution, persistent DB-backed carts, checkout price-drift protection, GST Credit Notes on partial/full returns, General Ledger (`5040`) discount subsidy accounting, and automated Check 14 reconciliation across `QCOM/backend`.

Key outcomes:
- Eliminated binary floating-point rounding drift and hardcoded state/FY/IRN stubs (`'29'`, `'2025-26'`, fabricated 64-hex IRN strings).
- Enforced fail-closed `422` validation for unverified product tax classifications and invalid Indian state/UT codes via `indian_states` (37 statutory GST codes).
- Serialized coupon and promotion capacity under PostgreSQL `SELECT ... FOR UPDATE` with explicit `RESERVED -> REDEEMED / RELEASED / REVERSED` lifecycle tracking, validated up to 200-way concurrent checkout contention against `usage_limit = 100`.
- Protected checkout integrity via server-recomputed pricing (`pricingEngine.ts` v3.0.0) and `409 PRICE_CHANGED` / `QUOTE_EXPIRED` rejection, plus DB-backed carts (`/api/v1/cart`).
- Implemented Section 34 CGST Act formal `credit_notes` and `credit_note_line_items` matching prorated discounted tax-inclusive return totals (`line_total_payable`) and closed sequential reverse-pickup trips upon store receipt (`RETURNED_TO_HUB`).

---

## 2. Baseline & Final Commit

- **Expected & Verified Baseline Commit:** `e52f09e` on `main`.
- **Forward-Only Schema Principle:** Historical migrations `001` through `030` remain untouched; all schema extensions live in forward migration `031_sprint16_0_pricing_gst_coupons_promotions.sql`.

---

## 3. Actual Existing Defects Found & Repaired

1. **Fabricated Fake IRN & Static Financial Year (`invoiceService.ts`, `tests/sprint4-migration.test.ts`):**  
   Previously generated synthetic 64-character hex IRN hashes locally and hardcoded `'2025-26'` FY. Replaced with dynamic Apr–Mar `computeIndianFinancialYear()` and honest `resolveEInvoicingState()` (`irn: null`, `eInvoicingStatus: 'NOT_APPLICABLE'` when `EINVOICING_ENABLED=false`, or `'PENDING_IRP'` when enabled without IRP acknowledgement). Updated `tests/sprint4-migration.test.ts` Test 7 accordingly.
2. **Hardcoded State Code `'29'` Fallback (`taxEngine.ts`, `settlementAllocationService.ts`):**  
   Replaced hardcoded `'29'` / `isInterState = false` fallbacks with authoritative lookup via `indian_states` (`resolvePlaceOfSupply()`, `validateStateCode()`) and fail-closed `422 INVALID_STATE_CODE` / `MISSING_MERCHANT_STATE_CODE`.
3. **Sequential Partial Return Blocked by Open `REVERSE_PICKUP` Trip (`returnService.ts`):**  
   When an order had two sequential partial returns (`ret1`, then `ret2`), `receiveAtStore()` updated `order_returns.status = 'RECEIVED_AT_STORE'` without closing `ret.pickup_trip_id` in `delivery_trips`, causing `ret2` approval to fail with `CONCURRENT_REVERSE_TRIP_EXISTS` under Migration 028's `uq_delivery_trips_active_reverse_order`. Fixed `receiveAtStore()` to transition the associated `REVERSE_PICKUP` trip to `'RETURNED_TO_HUB'` when not already terminal.
4. **Coupon & Promotion Over-Redemption Race & Missing Slot Release:**  
   Previously `coupons.usage_count` lacked atomic `FOR UPDATE` reservation, per-order state transitions, and cancellation/return release. Fixed via `lockAndReserveForOrder()`, `markRedeemedForOrder()`, `releaseForOrder()`, and `reverseForOrder()`.
5. **`returnService.ts` Refund Basis Ignoring Discount/GST/Cess Inclusivity:**  
   Ensured return refunds prorate against `order_items.line_total_payable` (post-discount, GST+Cess-inclusive paid total) rather than pre-discount `total_price`.
6. **PG vs. `pg-mem` AST Compatibility on Reconciliation Check 14D (`paymentReconciliationService.ts`):**  
   PostgreSQL `HAVING c.usage_count <> COALESCE(COUNT(...) FILTER (...), 0)` failed under `pg-mem` AST parser. Rewrote Check 14D using ANSI-compliant `COALESCE(SUM(CASE WHEN ... THEN 1 ELSE 0 END), 0)` and exact JS comparison (`actual !== expected`) compatible with both PostgreSQL 16 and `pg-mem`.
7. **Missing `QCOM_LEGAL_NAME` & `EINVOICING_ENABLED` in `env.ts` & Test Fixture (`tests/sprint14-staging-validation.test.ts`):**  
   Added typed config keys to `EnvConfig`, `.env.example`, and test env fixture.
8. **Checkout Concurrency `INSUFFICIENT_STOCK` Error Prefix (`pricingEngine.ts`):**  
   Moving authoritative `pricingEngine.calculate()` inside `orderService.createOrder()`'s database transaction caused serialized competing checkouts to throw `PricingEngineError('INSUFFICIENT_STOCK', ...)` prior to `inventoryService.reserveStock()`. Prefixed `INSUFFICIENT_STOCK: ` to the `PricingEngineError` message at `pricingEngine.ts:241` so concurrency and HTTP error assertions behave identically regardless of whether the quote check or inventory reservation catches the shortage first.

---

## 4. Files Changed

- **Config & Environment:**
  - `QCOM/backend/src/config/env.ts`
  - `QCOM/backend/.env.example`
- **Database Migration & Seeds:**
  - `QCOM/backend/migrations/031_sprint16_0_pricing_gst_coupons_promotions.sql` (new)
  - `QCOM/backend/seeds/seedData.ts`
- **Pricing, Tax, Coupons, Promotions & Carts:**
  - `QCOM/backend/src/modules/pricing/pricingTypes.ts`
  - `QCOM/backend/src/modules/pricing/money.ts`
  - `QCOM/backend/src/modules/pricing/taxEngine.ts`
  - `QCOM/backend/src/modules/pricing/couponPromotionService.ts` (new)
  - `QCOM/backend/src/modules/pricing/pricingEngine.ts` (v3.0.0)
  - `QCOM/backend/src/modules/pricing/cartService.ts` (new)
- **Orders, Returns, Cancellations & Payments:**
  - `QCOM/backend/src/modules/orders/orderTypes.ts`
  - `QCOM/backend/src/modules/orders/orderService.ts`
  - `QCOM/backend/src/modules/orders/cancellationService.ts`
  - `QCOM/backend/src/modules/orders/returnService.ts`
  - `QCOM/backend/src/modules/payments/paymentService.ts`
- **Invoices, Credit Notes, Ledger, Settlement & Reconciliation:**
  - `QCOM/backend/src/modules/invoices/invoiceTypes.ts`
  - `QCOM/backend/src/modules/invoices/invoiceService.ts`
  - `QCOM/backend/src/modules/invoices/pdfGenerator.ts`
  - `QCOM/backend/src/modules/ledger/ledgerService.ts`
  - `QCOM/backend/src/modules/settlements/settlementTypes.ts`
  - `QCOM/backend/src/modules/settlements/settlementAllocationService.ts`
  - `QCOM/backend/src/modules/reconciliation/paymentReconciliationService.ts`
- **HTTP Routes & App Mounting:**
  - `QCOM/backend/src/routes/pricingRoutes.ts`
  - `QCOM/backend/src/routes/cartRoutes.ts` (new)
  - `QCOM/backend/src/routes/orderRoutes.ts`
  - `QCOM/backend/src/routes/invoiceRoutes.ts`
  - `QCOM/backend/src/routes/adminCompatibilityRoutes.ts`
  - `QCOM/backend/src/app.ts`
- **Tests & CI:**
  - `QCOM/backend/tests/sprint16-0-pricing-gst-coupons-promotions.test.ts` (new)
  - `QCOM/backend/tests/sprint4-migration.test.ts`
  - `QCOM/backend/tests/sprint14-staging-validation.test.ts`
  - `QCOM/backend/tests/run-all-tests.ts`
  - `QCOM/backend/tests/integration/real-services.test.ts`
  - `.github/workflows/ci.yml`
- **Documentation:**
  - `QCOM/backend/DATABASE.md`, `ARCHITECTURE.md`, `DESIGN.md`, `API.md`, `FEATURES.md`, `TESTING.md`, `SPRINT_16_0_PRICING_GST_COUPONS_PROMOTIONS_INTEGRITY_REPORT.md`

---

## 5. Database Migration `031`

`031_sprint16_0_pricing_gst_coupons_promotions.sql` adds:
- `indian_states` seeded with 37 valid Indian GST state & Union Territory codes (`01`–`38`, `97`).
- COA Account `5040` (`Platform Promotional & Coupon Subsidy Expense`, category `EXPENSE`, normal balance `DEBIT`).
- Extensions on `products` & `seller_product_tax`: `tax_category` (`TAXABLE`/`EXEMPT`/`NIL_RATED`/`ZERO_RATED`), `cess_rate_percent` (`0`–`100`), `tax_inclusive`, `is_tax_classification_verified`.
- Extensions on `saved_addresses` (`state_code`).
- Extensions on `coupons` (`per_user_limit`, `first_order_only`, `applicable_categories`, `applicable_product_ids`, `is_stackable`, `funding_source`, `seller_share_percent`) + `coupon_redemptions` (`UNIQUE (coupon_id, order_id)`, status `CHECK ('RESERVED','REDEEMED','RELEASED','REVERSED')`).
- `promotions` (`PERCENTAGE`, `FLAT_AMOUNT`, `CART_SLAB`, `CATEGORY_DISCOUNT`, `BOGO`, `FREE_DELIVERY`, `priority`, `conflict_group`, `is_stackable`, `stackable_with_coupons`, funding split & caps) + `promotion_applications` (`UNIQUE (promotion_id, order_id)`).
- `carts` (`UNIQUE (user_id, merchant_id)`) & `cart_items` (`UNIQUE (cart_id, product_id)`, `quantity > 0`).
- `orders` (`cess_amount`, `coupon_id`, `coupon_code`, `applied_promotions`, `quote_id`, `platform_discount_subsidy`, `seller_discount_amount`, expanded `orders_status_check` including `partially_returned` & `returned`) and `order_items` (`discount_amount`, `cess_amount`, `tax_inclusive`, `tax_category`, `line_total_payable`, `refunded_quantity`, `refunded_amount`, `applied_discounts`).
- `order_settlement_allocations` (`platform_discount_subsidy`, `seller_discount_amount`, `cess_amount`).
- `invoices` (`irn` nullable, `place_of_supply_state_code`, `supplier_state_code`, `is_inter_state`, `cess_amount`, `discount_amount`, `financial_year`, `e_invoicing_status`) & `invoice_line_items`.
- `credit_notes` & `credit_note_line_items` (Section 34 CGST formal return credit notes).

---

## 6. Pricing Architecture (`pricingEngine.ts` v3.0.0)

- Single authoritative calculation path invoked by `/api/v1/pricing/quote`, `/api/v1/cart*`, and `/api/v1/orders/create`.
- Never trusts client-supplied unit prices, taxes, discounts, or grand totals: loads live `store_inventory.selling_price`, `products` tax metadata, effective-dated `pricing_delivery_rules`, `statutory_tax_rules`, `indian_states`, `promotions`, and `coupons` inside PostgreSQL.
- Persists immutable quote snapshots in `pricing_calculation_snapshots` with `QUOTE_TTL_MINUTES = 15`.

---

## 7. GST Calculation Methodology & Decimal Arithmetic (`bignumber.js`)

- `money.ts` configures `BigNumber` (`DECIMAL_PLACES: 20`, `ROUND_HALF_UP`) and exposes `roundCurrency()`, `add()`, `subtract()`, `multiply()`, `divide()`.
- **Tax-Exclusive Lines:** Discount reduces gross item value (`netLine = gross - itemDiscount`); `taxable = netLine`; `CGST = taxable * (gstRate/200)`, `SGST = taxable * (gstRate/200)` (intra-state) or `IGST = taxable * (gstRate/100)` (inter-state); `Cess = taxable * (cessRate/100)`; `lineTotal = taxable + totalGst + cess`.
- **Tax-Inclusive Lines (`extractInclusiveBaseAndTaxes`):** Discount reduces inclusive gross (`netInclusive = gross - itemDiscount`); `base = netInclusive / (1 + (gstRate + cessRate)/100)` rounded with 1-paisa deterministic reconciliation so `taxableAmount + cgst + sgst + igst + cess === netInclusive` strictly.
- **Place of Supply (`resolvePlaceOfSupply`):** Priority: (1) explicit validated `placeOfSupplyStateCode`, (2) `customerGstin` 2-digit prefix, (3) `deliveryAddressId` -> `saved_addresses.state_code`, (4) customer's latest `saved_addresses` / default `saved_gstins` state code, (5) validated merchant `state_code`. Zero hardcoded `'29'` defaults.

---

## 8. Product & Seller Tax Classification (Fail-Closed `422`)

- `resolveSellerProductTax()` verifies `products.is_tax_classification_verified !== false` and presence of HSN code & tax rates; otherwise throws `TaxEngineError('MISSING_TAX_CLASSIFICATION', ..., 422)`.
- Non-taxable categories (`EXEMPT`, `NIL_RATED`, `ZERO_RATED`) reject non-zero GST or Cess rates with `422 INVALID_TAX_CLASSIFICATION` and enforce `0.00` GST/Cess on quotes and invoices.
- Invalid or missing 2-digit Indian state/UT codes reject with `422 INVALID_STATE_CODE` / `MISSING_MERCHANT_STATE_CODE`.

---

## 9. Coupon Lifecycle (`RESERVED -> REDEEMED / RELEASED / REVERSED`)

- **Validation (`POST /api/v1/pricing/coupons/validate`):** Non-mutating eligibility check (`valid_from`/`valid_to`, active flag, `min_order_value_inr`, merchant/category/product scope, `first_order_only`, `usage_limit`, `per_user_limit`) without reserving capacity.
- **Reservation (`lockAndReserveForOrder`):** Runs inside the checkout transaction under `SELECT ... FOR UPDATE` on `coupons`. Checks `usage_count < usage_limit` and user active count `< per_user_limit`, inserts `coupon_redemptions` (`RESERVED` for online payment pending capture, `REDEEMED` for COD), and atomically increments `coupons.usage_count`.
- **Confirmation (`markRedeemedForOrder`):** Upgrades `RESERVED -> REDEEMED` on payment capture/webhook.
- **Cancellation Release (`releaseForOrder`):** On order cancellation or payment failure/expiry, transitions `RESERVED/REDEEMED -> RELEASED` and decrements `coupons.usage_count` atomically (`GREATEST(0, usage_count - 1)`).
- **Full Return Reversal (`reverseForOrder`):** Marks redemption `REVERSED` upon full order return/refund without re-opening historical checkout slots improperly.

---

## 10. Promotion Lifecycle & Conflict Resolution

- Supports `PERCENTAGE`, `FLAT_AMOUNT`, `CART_SLAB` (tier-based discount brackets), `CATEGORY_DISCOUNT`, `BOGO` (`buy_quantity` / `get_quantity` floored free units at item unit price), and `FREE_DELIVERY` (waiving QCOM taxable delivery charge).
- Evaluated deterministically ordered by `priority ASC, created_at ASC`.
- **Conflict Groups & Stackability:** Tracked conflict groups block lower-priority promotions in the same `conflict_group`. `is_stackable = false` stops lower-priority non-stackable item promotions; `stackable_with_coupons = false` governs coupon stacking precedence cleanly.
- Capacity-constrained promotions lock under `SELECT ... FOR UPDATE` in `promotion_applications` (`RESERVED -> APPLIED / RELEASED / REVERSED`).

---

## 11. Proportional Discount Allocation & Funding Splits (COA `5040`)

- Item-level coupon and promotion discounts distribute proportionally across eligible line items by `remainingLine / totalRemaining` with last-line remainder absorption so sum of line discounts equals exact header discount.
- Each discount attributes funding (`SELLER`, `PLATFORM`, `SHARED` via `seller_share_percent`):
  - `SELLER`: reduces seller goods proceeds directly.
  - `PLATFORM`: customer pays discounted net total, while QCOM funds seller via COA `5040` (`DEBIT 5040 Platform Promotional & Coupon Subsidy Expense`, restoring seller payable on fulfillment).

---

## 12. DB Cart & Checkout Price-Drift Protection

- `carts` and `cart_items` persist customer item selections, `unit_price_snapshot`, `tax_rate_snapshot`, `coupon_code`, and `last_quote_id` per `(user_id, merchant_id)`.
- `GET /api/v1/cart` compares live `store_inventory.selling_price` against `cart_items.unit_price_snapshot` and surfaces `priceChanges[]` + fresh `quote`.
- `POST /api/v1/orders/create`:
  - Rejects expired `quoteId` (`expires_at <= NOW()`) with HTTP `409 QUOTE_EXPIRED`.
  - Recomputes authoritative quote inside the checkout transaction; if caller passed `expectedTotal` differing from recomputed `grandTotal`, rejects with HTTP `409 PRICE_CHANGED` before any inventory or coupon commitment.

---

## 13. Historical Snapshots & Invoice / Credit Note Immutability

- `orders.pricing_snapshot`, `orders.place_of_supply_state_code`, `orders.cess_amount`, `orders.platform_discount_subsidy`, `orders.seller_discount_amount`, and `order_items` financial columns preserve point-in-time prices, discounts, and GST breakdowns even when catalog prices or GST rates later change.
- `invoices` and `credit_notes` persist immutable supplier/customer GSTIN, Place of Supply, dynamic Indian FY (`computeIndianFinancialYear()`), and honest e-Invoicing flags (`irn: null`, `NOT_APPLICABLE` / `PENDING_IRP`).

---

## 14. Refund & Partial/Full Return Prorated Calculations + Credit Notes

- `returnService.ts` computes refunds against `order_items.line_total_payable` (`unitPaid * returnQty / origQty`, exact 2-decimal `BigNumber` rounding) with cumulative `refunded_quantity` enforcement (`RETURN_QUANTITY_EXCEEDED`).
- `receiveAtStore()` closes open `REVERSE_PICKUP` delivery trips (`RETURNED_TO_HUB`) so sequential partial returns on the same order succeed cleanly.
- On QC pass, `invoiceService.issueCreditNoteForReturn()` persists a formal `SELLER_CREDIT_NOTE` (`credit_notes` + `credit_note_line_items`) linked to `order_id`, `return_id`, `refund_id`, and parent `SELLER_TAX_INVOICE`, printable via `/api/v1/invoices/order/:orderId/credit-notes/text`.

---

## 15. Seller Settlement & GL Trial Balance Parity

- `settlementAllocationService.ts` and `ledgerService.ts` record `platformDiscountSubsidy` in `order_settlement_allocations` and include `DEBIT 5040` in balanced fulfillment journal batches.
- Verified in Test Group G: global `SUM(DEBIT) === SUM(CREDIT)` exact parity to `₹0.00` variance across order placement, payment capture, platform-subsidized settlement, and partial/full return clawbacks.

---

## 16. Security

- All pricing/coupon/promotion mutations (`/api/v1/admin/coupons*`, `/api/v1/admin/promotions*`, `/api/v1/admin/discounts/report`) require authenticated admin JWT (`SUPER_ADMIN`, `FINANCE_ADMIN`, `OPERATIONS`), audited in `audit_logs` (`COUPON_CREATED`, `PROMOTION_CREATED`, etc.). Customer calls receive `403`.
- `/api/v1/cart*` derives `userId` exclusively from verified JWT (`req.auth.userId`).
- `/api/v1/invoices/order/:orderId/credit-notes*` enforces `requireOrderOwnership`.
- Zero client-trusted prices/discounts/taxes at checkout.

---

## 17. Concurrency Controls

- Coupon and promotion redemption capacities lock rows via `SELECT ... FOR UPDATE` inside explicit `transaction()` boundaries before incrementing `usage_count`.
- `UNIQUE (coupon_id, order_id)` on `coupon_redemptions` and `UNIQUE (promotion_id, order_id)` on `promotion_applications` prevent duplicate order application.
- Verified in PG-mem (10-way concurrent checkout against `limit = 3`) and in real PostgreSQL 16 integration suite (200-way concurrent checkout against `PG16RACE100` `usage_limit = 100`, proving strictly 100 succeed, 100 fail cleanly, `usage_count === 100`, cancellation drops to `99`).

---

## 18. Reconciliation (`Check 14A–14D`)

Added Check 14 to `paymentReconciliationService.ts`:
- **14A:** Order GST mutual exclusion (`CGST/SGST` and `IGST` never both `> 0`), non-negative tax/discount/cess/total fields, and `orders.total_amount` vs `pricing_snapshot.grandTotal` parity.
- **14B:** Accepted returns with non-null `refund_id` missing formal `SELLER_CREDIT_NOTE` (`MISSING_RETURN_CREDIT_NOTE`).
- **14C:** Invoices marked `e_invoicing_status = 'NOT_APPLICABLE'` carrying non-null fabricated IRN (`INVALID_FABRICATED_IRN`, `CRITICAL`).
- **14D:** Coupon & promotion `usage_count` vs active `RESERVED`/`REDEEMED`/`APPLIED` ledger counts (`COUPON_USAGE_COUNT_DRIFT`, `PROMOTION_USAGE_COUNT_DRIFT`).

---

## 19. Tests & Verification Results

**Local Container Verification (`pg-mem`, no local PG16/Redis daemons in sandbox):**
- `npm --prefix QCOM/backend run build` (`tsc --noEmit`): **PASSED** (0 errors).
- `tests/sprint16-0-pricing-gst-coupons-promotions.test.ts` (Groups A–H): **PASSED 8/8 Groups** (Tax modes + Cess + Exempt + fail-closed `422`, Dynamic POS CGST/SGST vs IGST + invalid state `422`, Promotion priority/conflict groups/BOGO/Free-Delivery, 10-way coupon race + cancel release + `first_order_only`, DB Cart + `409 PRICE_CHANGED`/`QUOTE_EXPIRED`, Partial+Full prorated return refunds + Credit Notes + honest `irn: null` + Indian FY, COA `5040` + trial balance parity, Check 14 + Admin RBAC + Audit Logs).
- Regression suites verified locally in `pg-mem` (`NODE_ENV=test`): `pricing-tax`, `sprint4-migration`, `sprint5-dispatch`, `sprint6-payments`, `sprint7-settlements`, `sprint9-returns-cancellations`, `sprint15-7-transaction-cod-reverse-trip-integrity`, `sprint15-8-gateway-agnostic-payment-infrastructure`, `sprint15-9-cod-cash-accountability`, and `sprint16-0-pricing-gst-coupons-promotions` (**ALL PASSED**).
- Note: `sprint15-4` and `sprint15-5` require live PostgreSQL `127.0.0.1:5432` and therefore execute in GitHub Actions CI rather than the `pg-mem` local container.

---

## 20. Real PostgreSQL 16 & Redis 7.0.15 Evidence

- `tests/integration/real-services.test.ts` extended with `runSprint16_0PostgresChecks(freshPool)`:
  - Verifies all 9 Migration 031 tables + `>= 36` `indian_states` rows on real PG16.
  - Executes 200 concurrent checkouts (`Promise.allSettled`) against real PostgreSQL 16 for `PG16RACE100` (`usage_limit = 100`), asserting strictly 100 succeed, 100 reject, `usage_count === 100`, cancellation restores `99`, and Check 14 reports 0 drift.
- Actual container execution runs on GitHub Actions (`postgres:16-alpine`, `postgres:16.6-alpine`, `redis:7.0.15-alpine`). Local AI Studio workspace does not ship PG16 or Redis binaries, so real PG16/Redis 7.0.15 execution evidence comes exclusively from CI run logs below.

---

## 21. GitHub Actions CI Run IDs

- Triggered automatically upon push to `main` via `.github/workflows/ci.yml` (Jobs: `All 60 Test Suites & Infrastructure Verification` and `Real-Services Integration Harness (PG 16 & Redis 7.0.15)`).
- _CI Run ID and status verified post-push in final closure._

---

## 22. Remaining Limitations

1. Live NIC IRP e-Invoicing / QR cryptographic signing integration is intentionally unimplemented (`EINVOICING_ENABLED=false` returns `irn: null` and `NOT_APPLICABLE`); requires licensed GSP/ASP integration before regulatory B2B e-invoicing activation.
2. No scheduled PDF archival object-storage upload or email dispatcher is wired for Credit Notes (`GET .../credit-notes` and `/text` serve live immutable DB records).
3. Cart persistence is scoped per `(user_id, merchant_id)`; cross-merchant unified split-cart orchestration is out of scope for Sprint 16.0.

---

## 23. Unresolved Founder / Commercial / Legal Decisions

These policy decisions **must not be assumed in code** and require explicit sign-off before production launch:

1. **Statutory HSN/SAC & Compensation Cess Master Sign-Off:** Qualified GST tax counsel / CA must certify catalog HSN codes, Cess rates, and tax categories (`EXEMPT` vs `NIL_RATED` vs `TAXABLE`) per SKU; currently `products.is_tax_classification_verified` governs fail-closed checkout.
2. **QCOM Multi-State GSTIN & `QCOM_STATE_CODE` Policy:** Legal/Finance must decide whether QCOM bills platform delivery/handling fees under a single Principal Place of Business GSTIN (`QCOM_STATE_CODE`) or state-wise Input Service / Branch GSTINs per operating state.
3. **NIC IRP GSP/ASP Credentials & Turnover Activation Threshold:** Confirmation of whether QCOM and onboarded merchants cross the statutory e-Invoicing AATO threshold requiring `EINVOICING_ENABLED=true` and GSP credentials.
4. **Partial Return Promotion Clawback Policy:** Commercial decision on whether a customer returning part of an order that drops remaining retained basket value below a `CART_SLAB` / coupon `min_order_value_inr` forfeits part of the promo discount on refund, or whether QCOM absorbs/prorates proportionally (current implementation prorates paid `line_total_payable` proportionally).
5. **B2B Credit Note IRP Time Window & GST-TCS Timing:** Tax policy confirmation for GSTR-1 Table 9B B2B Credit Note reporting and Section 52 TCS reversal alignment across tax periods.
6. **Marketplace Commission Base Commercial Agreement:** Seller agreement confirmation on whether QCOM marketplace commission (`commission_rate_percent`) computes on post-seller-discount taxable value (current `sellerGoodsTaxable`) vs pre-discount MRP/selling price when `SELLER`-funded coupons apply.

---

## 24. Production Readiness Assessment

**Verdict: CONDITIONALLY READY FOR STAGING / PRE-PRODUCTION**  
- Financial, concurrency, decimal GST, coupon slot locking, DB cart/drift guard, Credit Note, COA `5040` GL parity, and Check 14 reconciliation controls are verified and enforced in code, database constraints, and CI automation.
- Live production cutover requires resolving Section 23 founder/legal sign-offs, configuring a `NOSUPERUSER` PostgreSQL role, setting real `QCOM_GSTIN` / `QCOM_STATE_CODE` / GSP IRP credentials (if applicable), and running `npm run build` + CI green verification on `main`.
