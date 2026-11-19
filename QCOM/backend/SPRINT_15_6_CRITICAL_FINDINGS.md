# SPRINT 15.6 — CRITICAL FINDINGS (P0 & P1)

**Repository:** `https://github.com/theRawHawn/Q-Com-Backend.git` (`main`)
**Baseline Commit SHA:** `c384268da1d0f24a93aaf86215b18ead5a56b1fa`
**Scope:** Read-Only Evidence-Based Audit of `QCOM/backend`

> Every **Confirmed Finding** below was verified directly in source files, SQL migrations, routes, or runtime scripts. Unverified concerns are strictly separated at the end of this document.

---

## PART 1: CONFIRMED P0 (CRITICAL) FINDINGS — MUST RESOLVE BEFORE REAL TRANSACTIONS

### `F-15.6-P0-01` — Production Startup Crash: OTP Telephony, Payouts, and Push Providers Throw Unconditionally in `NODE_ENV=production`
- **Domain:** Auth / Payouts / Notifications / Infrastructure
- **Severity:** **P0 — Critical**
- **Exact File Paths & Symbols:**
  - `QCOM/backend/src/modules/auth/otpProvider.ts` (`ProductionSmsProvider` constructor, top-level `createOtpProvider()`)
  - `QCOM/backend/src/modules/settlements/payoutProvider.ts` (`getPayoutProvider()`, instantiated at module load in `sellerSettlementService.ts:120` & `riderPayoutService.ts:40`)
  - `QCOM/backend/src/modules/notifications/pushProvider.ts` (`createPushProvider()`, `FcmPushProvider.sendPush()`)
- **Actual Evidence:**
  - `otpProvider.ts` calls `createOtpProvider()` at module load; when `env.NODE_ENV === 'production'`, `ProductionSmsProvider` constructor throws `[Provider Security Exception] Genuine live telephony SMS provider (Twilio / Exotel / AWS SNS) is not integrated.`
  - `payoutProvider.ts` throws `PAYOUT_PROVIDER_NOT_CONFIGURED` in `getPayoutProvider()` when `env.NODE_ENV === 'production'` (unless mock explicitly forced, which violates real money safety), crashing module import in `sellerSettlementService.ts` and `riderPayoutService.ts`.
  - `pushProvider.ts` throws on boot in `NODE_ENV === 'production'` if `FCM_SERVICE_ACCOUNT` is absent; even when `FCM_SERVICE_ACCOUNT` is present, `FcmPushProvider.sendPush()` contains zero HTTP/Firebase Admin calls and returns a synthetic message ID (`fcm_msg_${Date.now()}`).
- **Why It Matters:** The backend binary **cannot start cleanly in production mode**, and even if bypassed, cannot send a single real login OTP, bank payout, or mobile push notification.
- **Reproduction Scenario:** Set `NODE_ENV=production` with valid `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `PAYMENT_SECRET`, `COOKIE_SECRET`, `CORS_ALLOWED_ORIGINS` and run `npm --prefix QCOM/backend start`. Process crashes during static module imports.
- **Existing Test Coverage:** **Not detected.** CI (`.github/workflows/ci.yml`) runs exclusively with `NODE_ENV=test`, `PAYMENT_MODE=mock`, `TELEPHONY_MODE=mock`.
- **Recommended Fix:** Implement real HTTP/SDK adapters (Exotel/Twilio/MSG91 for OTP SMS, RazorpayX/Cashfree Payouts for IMPS/UPI payouts, Firebase Admin SDK HTTP v1 for FCM) gated by validated environment variables, with sandbox integration tests before cutover.
- **Dependencies:** Registered DLT Templates + SMS provider account; RazorpayX/Cashfree Payouts KYC; Firebase Project Service Account.
- **Suggested Sprint:** External Provider Integration Sprint (Stage A).

---

### `F-15.6-P0-02` — Payment Gateway Adapter Is a Non-Functional In-Memory Stub (`RazorpayPaymentProvider`)
- **Domain:** Payments & Checkout
- **Severity:** **P0 — Critical**
- **Exact File Paths & Symbols:**
  - `QCOM/backend/src/modules/payments/provider/paymentProviderRegistry.ts` (`RazorpayPaymentProvider`, `MockPaymentProvider`)
  - `QCOM/backend/src/modules/payments/paymentProvider.ts` (`getPaymentProvider()`, `DisabledPaymentProvider`)
  - `QCOM/backend/package.json` (no `razorpay` or HTTP gateway SDK dependency)
- **Actual Evidence:**
  - `RazorpayPaymentProvider` uses in-memory JavaScript `Map` structures (`sessions`, `refunds`) with zero calls to Razorpay APIs (`/v1/orders`, `/v1/payments`, `/v1/refunds`), generates synthetic `order_rzp_*` / `rfnd_rzp_*` IDs, and hardcodes `status: 'SUCCEEDED'` inside `getPaymentStatus()`.
  - `getPaymentProvider()` in `paymentProvider.ts` defaults to `'none'` (`DisabledPaymentProvider`) in `NODE_ENV === 'production'`, returning `PAYMENT_GATEWAY_NOT_CONFIGURED` (`503`) on checkout payment attempt.
- **Why It Matters:** QCOM cannot process real UPI, card, netbanking, or online payment gateway refunds.
- **Reproduction Scenario:** Attempt `POST /api/v1/payments/create-order` or `/verify` in production config: either blocked by `DisabledPaymentProvider` or silently fakes captures in memory if `PAYMENT_MODE=razorpay`.
- **Existing Test Coverage:** **Not detected.** `tests/` exercise `MockPaymentProvider` exclusively.
- **Recommended Fix:** Replace in-memory `RazorpayPaymentProvider` methods with real Razorpay REST/SDK calls (create order, fetch payment status, capture/verify signature via `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET`, trigger `/payments/:id/refund`, verify webhook signature using `RAZORPAY_WEBHOOK_SECRET`), tested end-to-end against Razorpay Sandbox/Test keys.
- **Dependencies:** Activated Razorpay (or Cashfree) Merchant Account, Webhook secret, sandbox credentials.
- **Suggested Sprint:** External Provider Integration Sprint (Stage A).

---

### `F-15.6-P0-03` — Delivery Completion Pipeline Bypasses Settlement Allocation, Rider Ledger, COD Cash Liability, and Rider State Reset
- **Domain:** Delivery Fulfillment / Financial Settlements / COD Accounting
- **Severity:** **P0 — Critical**
- **Exact File Paths & Symbols:**
  - `QCOM/backend/src/routes/partnerCompatibilityRoutes.ts` (`POST /tasks/:taskId/verify-otp`, lines `586-703`; `POST /tasks/:taskId/arrived-pickup`; `POST /tasks/:taskId/pickup-confirm`)
  - `QCOM/backend/src/routes/deliveryRoutes.ts` (`completeDelivery`) vs `partnerCompatibilityRoutes.ts`
  - `QCOM/backend/src/modules/settlements/settlementAllocationService.ts` (`allocateFulfilledOrder`)
  - `QCOM/backend/src/modules/ledger/ledgerService.ts` (`recordCodCollection`, `recordRiderEarning`)
- **Actual Evidence:**
  - In `partnerCompatibilityRoutes.ts` (`POST /tasks/:taskId/verify-otp`), after verifying `delivery_otp`, the handler updates `delivery_trips.status = 'DELIVERED'` and `orders.status = 'delivered'`, and returns `{ todayTotalEarnings: totalPayout }`.
  - It **never** calls `settlementAllocationService.allocateFulfilledOrder()` (leaving `order_settlement_allocations`, `seller_ledgers`, and general ledger revenue/payable recognition unposted).
  - For COD orders (`payment_method = 'Pay on Delivery'`), it **never** updates `orders.payment_status` to `'PAID'`, **never** increments `riders.floating_cash_balance`, and **never** calls `ledgerService.recordCodCollection()`.
  - It **never** resets `riders.status` from `IN_TRANSIT`/`ARRIVED_AT_DROP` back to `IDLE_AT_HUB`/`AVAILABLE`, stranding the rider from future dispatches.
  - It **never** validates state preconditions properly: `verify-otp` checks only `NOT IN ('DELIVERED', 'COMPLETED')`, allowing a trip in `ACCEPTED` or `ARRIVED_AT_PICKUP` to jump directly to `DELIVERED` without picking up items; uses hardcoded fallback payouts (`35`/`15`/`0.5`).
- **Why It Matters:** Every real order delivered through the partner compatibility API leaves sellers unpaid, riders permanently busy, COD cash untracked (direct financial theft/loss vector), and general ledger balances inconsistent with physical order state.
- **Reproduction Scenario:** Driver accepts order -> calls `POST /api/v1/partner/tasks/:id/verify-otp` immediately with valid OTP -> DB marks order delivered; `order_settlement_allocations` has 0 rows, `seller_ledgers` balance = `0`, `riders.floating_cash_balance` = `0`, `orders.payment_status` stays `'PENDING'`, `riders.status` stays non-idle.
- **Existing Test Coverage:** **Not detected.** Settlement unit tests call `settlementAllocationService.allocateFulfilledOrder()` directly in isolation, never through `partnerCompatibilityRoutes`.
- **Recommended Fix:** Consolidate delivery completion into a single authoritative transactional service method guarded by strict state-machine validation (`PICKED_UP` or `ARRIVED_AT_DROP` required under `FOR UPDATE`), atomically invoking `settlementAllocationService.allocateFulfilledOrder()`, COD ledger + floating cash balance updates, `orders.payment_status = 'PAID'` (for COD), and rider state reset to `IDLE_AT_HUB`.
- **Dependencies:** Centralized Order & Trip State Machine cleanup.
- **Suggested Sprint:** Delivery-to-Settlement Pipeline & COD Integrity Sprint (Stage A).

---

### `F-15.6-P0-04` — External Payment Gateway Refund HTTP I/O & Retry Sleeps Executed Inside Active `FOR UPDATE` Database Transaction
- **Domain:** Payments / Order Cancellation / Database Concurrency
- **Severity:** **P0 — Critical**
- **Exact File Paths & Symbols:**
  - `QCOM/backend/src/modules/orders/cancellationService.ts` (`cancelOrder()`, lines `255-267`)
  - `QCOM/backend/src/modules/payments/refundService.ts` (`createRefund()`, `clientOverride`, lines `326-344`)
- **Actual Evidence:**
  - `cancellationService.ts` acquires an exclusive row lock (`SELECT ... FROM orders WHERE id = $1 FOR UPDATE`) inside `transaction(async (client) => { ... })`.
  - Inside that open transaction (lines `255-267`), it invokes `refundService.createRefund({ ..., clientOverride: client })`.
  - Inside `refundService.ts`, if `clientOverride` is active, it still performs provider network calls (`provider.initiateRefund(...)`) plus retry delay sleeps while holding PostgreSQL locks and an active connection from the `max: 20` pool!
  - Additionally, `cancellationService.ts:34-37` selects `idempotency_keys WHERE idempotency_key = $1` without matching `actor_id` (unlike `paymentRoutes.ts` / `dispatchRoutes.ts`).
- **Why It Matters:** Under live gateway latency, timeouts, or gateway degradation, concurrent cancellations will pin PostgreSQL connections and row locks for seconds per request, triggering cascading `503` connection-pool exhaustion (`max: 20`) and deadlocks across checkout and payment verification.
- **Reproduction Scenario:** 20+ concurrent customer cancellations while Razorpay refund API takes 2–5 seconds to respond -> entire PG pool saturates, blocking all checkout, login, and payment queries platform-wide.
- **Existing Test Coverage:** **Not detected.** Mock `refundProvider` resolves in `<1ms` in tests.
- **Recommended Fix:** Follow the exact pattern used in `paymentService.ts` late-payment compensation: persist `refunds` row (`status = 'REQUESTED'`) and `outbox_events` inside the DB transaction, commit immediately, and dispatch external gateway refund API calls asynchronously post-commit (via `outboxService` / `financialRecoveryWorker` or post-commit async call). Add `actor_id` validation to `cancellationService` idempotency lookups.
- **Dependencies:** Outbox / Recovery worker reliability.
- **Suggested Sprint:** Transactional & Financial Safeguards Sprint (Stage A).

---

### `F-15.6-P0-05` — Unprotected Self-Service Seller & Rider Payout Initiation (Zero Cooling-Off Hold, No Merchant Payout Hold, No Approval Limits)
- **Domain:** Financial Controls / Settlements & Payouts / Fraud
- **Severity:** **P0 — Critical**
- **Exact File Paths & Symbols:**
  - `QCOM/backend/src/routes/settlementRoutes.ts` (`POST /seller/payout` lines `252-278`, `POST /rider/payout` lines `390-416`, `POST /batch` lines `140-175`)
  - `QCOM/backend/src/modules/settlements/sellerSettlementService.ts` (`initiateSellerPayout`)
  - `QCOM/backend/migrations/003_create_merchants_and_catalog.sql` (`merchants` table lacks `is_payout_held`)
- **Actual Evidence:**
  - Any authenticated seller (`requireMerchantOwnership`) can call `POST /api/v1/settlements/seller/payout` and immediately trigger bank disbursement as soon as an order is allocated (`sellerSettlementService.ts`).
  - There is **zero return-window cooling-off delay** (T+N hold) on order credits before payout eligibility, **no `merchants.is_payout_held`** freeze column (unlike `riders.is_payout_held`), **no bank-verification enforcement check (`merchants.bank_verified = TRUE`)** verified across every initiation path, and **no dual-control/amount-cap guard** on admin-triggered payouts or batches.
- **Why It Matters:** A fraudulent merchant or compromised seller token can fulfill fake/collusive orders, withdraw 100% of funds immediately via payout API before a customer files a return/chargeback/dispute, leaving QCOM absorbing the full loss when clawbacks hit a zero balance.
- **Reproduction Scenario:** New or compromised seller marks fake order delivered -> triggers allocation -> immediately calls `POST /api/v1/settlements/seller/payout` -> cash leaves platform -> customer requests refund/chargeback -> seller ledger goes negative with unrecoverable cash loss.
- **Existing Test Coverage:** **Not detected.** Payout tests verify idempotency and balance checks, not cooling-off windows, KYC/bank verification enforcement, or approval caps.
- **Recommended Fix:** Add `withdrawable_after` maturity timestamp on `seller_ledgers` / `order_settlement_allocations` (T+N return window), add `merchants.is_payout_held` + `hold_reason`, require `bank_verified = TRUE` before payout, move `POST /seller/payout` to admin/scheduled-batch or strict verified-instant eligibility with daily caps, and add dual-control approval for high-value payouts.
- **Dependencies:** Settlement & Payout Provider Sprint (Stage A).
- **Suggested Sprint:** Transactional & Financial Safeguards Sprint (Stage A).

---

### `F-15.6-P0-06` — Disconnected & Non-Functional Admin Compatibility Financial Endpoints (`/admin/refunds/*`, `/admin/settlements`)
- **Domain:** Admin Portal / Financial Operations
- **Severity:** **P0 — Critical**
- **Exact File Paths & Symbols:**
  - `QCOM/backend/src/routes/adminCompatibilityRoutes.ts`:
    - `GET /settlements` (lines `222-266`)
    - `POST /refunds/:id/approve`, `/reject`, `/hold`, `/retry`, `POST /refunds/create`, `POST /disputes/:id/resolve` (lines `749-838`)
- **Actual Evidence:**
  - `GET /settlements` queries raw `orders` (`SUM(total_amount)`) and computes naive JS multiplication (`total * 0.85`), completely ignoring `order_settlement_allocations`, `seller_ledgers`, `commission_rate_percent`, GST-on-commission, TDS, TCS, penalties, refunds, and `seller_payouts`.
  - All 6 refund & dispute mutation routes (`lines 749-838`) are mock/audit-log stubs that return `200 OK` without updating the `refunds` table, calling `refundService.createRefund()`, reversing ledgers, or releasing holds—despite real refund endpoints existing separately at `/api/v1/refunds`.
- **Why It Matters:** Admin operators using `/api/v1/admin/*` compatibility endpoints see fabricated settlement balances (exposing platform to severe overpayments) and believe they approved/retried/rejected refunds when zero financial state changed.
- **Reproduction Scenario:** Finance admin opens portal -> views `GET /api/v1/admin/settlements` -> sees hardcoded 85% estimate ignoring 18% GST on commission, TCS, TDS, and prior payouts -> pays seller manually or thinks `POST /admin/refunds/:id/approve` refunded customer when customer never got money back.
- **Existing Test Coverage:** **Not detected.** Tests on `adminCompatibilityRoutes` validate RBAC status codes (`200`/`403`) rather than ledger/DB state side effects.
- **Recommended Fix:** Remove fake math and stub handlers; wire `GET /admin/settlements` directly to `order_settlement_allocations`, `seller_ledgers`, and `seller_payouts`, and wire `/admin/refunds/*` to `refundService.ts` (or deprecate/remove duplicate routes cleanly with `admin-portal` alignment).
- **Dependencies:** Alignment with `admin-portal` API contract.
- **Suggested Sprint:** Admin Compatibility Unification & Financial Controls Sprint (Stage A/D).

---

### `F-15.6-P0-07` — Pricing Engine SGST Tax Calculation Typo & Missing Coupon Usage Limit Enforcement / Schema Mismatch
- **Domain:** Core Commerce / Pricing / GST Compliance / Promotions
- **Severity:** **P0 — Critical** (Unlimited Coupon Abuse + Wrong Tax Totals)
- **Exact File Paths & Symbols:**
  - `QCOM/backend/src/modules/pricing/pricingEngine.ts` (`calculateOrderPricing`, `totalSgstBn` assignment around line `367`; coupon query/validation)
  - `QCOM/backend/src/routes/adminCompatibilityRoutes.ts` (`POST /promotions/create`, lines `1030-1038`)
  - `QCOM/backend/migrations/011_create_coupons_and_promotions.sql` (`coupons` columns)
- **Actual Evidence:**
  - In `pricingEngine.ts`, `totalSgstBn` is calculated by adding `sellerSgstBn` and `qcomCgstBn` (instead of `qcomSgstBn`). While CGST and SGST rates happen to be symmetric (`50%/50%`), this creates structural tax calculation corruption whenever item/service rounding or asymmetric adjustments apply.
  - `pricingEngine.ts` selects `usage_limit, usage_count` from `coupons`, **never checks `usage_count < usage_limit`**, has **no per-user usage tracking table**, and **neither `pricingEngine` nor `orderService` increments `coupons.usage_count`** inside the order placement transaction.
  - Furthermore, `adminCompatibilityRoutes.ts:1030-1038` executes `INSERT INTO coupons (code, title, discount_type, discount_value, min_order_value, max_discount, start_date, end_date, is_active)` whereas `migrations/011` defines `description`, `min_order_value_inr`, `max_discount_inr`, `valid_from`, `valid_to`—guaranteed SQL failure (`42703` undefined column) against real PostgreSQL!
- **Why It Matters:** Any published coupon (`usage_limit = 1` or `100`) can be redeemed an unlimited number of times concurrently by all users, causing direct uncapped promotional cash bleed; admins cannot create promotions via compatibility endpoint.
- **Reproduction Scenario:** Seed coupon `SAVE50` with `usage_limit = 1`; place 500 orders using `SAVE50` — all 500 succeed and `usage_count` stays `0`. Call `POST /api/v1/admin/promotions/create` — throws SQL column error.
- **Existing Test Coverage:** **Not detected.** `coupons` tests checked happy discount math without testing `usage_limit` exhaustion, concurrent redemption, or `POST /promotions/create`.
- **Recommended Fix:** Fix `qcomSgstBn` typo; add `coupon_redemptions (coupon_id, user_id, order_id)` table + atomic `UPDATE coupons SET usage_count = usage_count + 1 WHERE code = $1 AND (usage_limit IS NULL OR usage_count < usage_limit)` inside checkout `transaction`; fix `adminCompatibilityRoutes.ts` SQL column names.
- **Dependencies:** `migrations/011` extension migration for `coupon_redemptions`.
- **Suggested Sprint:** Pricing, Tax & Checkout Integrity Sprint (Stage A).

---

### `F-15.6-P0-08` — Zero Automated Database Backup, WAL Archiving, PITR, or Verified Disaster Recovery in Repository
- **Domain:** Infrastructure / Backup & Disaster Recovery / Financial Durability
- **Severity:** **P0 — Critical** (Before Production Data & Real Money)
- **Exact File Paths & Symbols:**
  - Repo-wide grep across `QCOM/backend/src`, `QCOM/backend/scripts`, `.github/workflows`
  - `QCOM/backend/src/database/connection.ts:89,100` (only `pg-mem` in-memory `memDb.backup()/restore()`)
- **Actual Evidence:**
  - Zero backup scripts, zero cron/CI backup jobs, zero PITR configuration, zero encrypted off-site snapshot documentation/automation, and zero restore verification scripts exist in `QCOM/backend`.
- **Why It Matters:** A single accidental `DROP`, bad migration, ransomware incident, or primary DB corruption permanently destroys the authoritative PostgreSQL financial ledger with zero RPO/RTO recovery path.
- **Reproduction Scenario:** Production DB disk corruption or operator error executes bad `UPDATE` -> no PITR or verified snapshot exists to recover financial ledger state.
- **Existing Test Coverage:** **Not detected.**
- **Recommended Fix:** Provision Managed PostgreSQL with automated daily snapshots + continuous WAL PITR, encrypted cross-region off-site backup replication, Redis RDB/AOF HA persistence, and an automated staging restore drill runbook tested before real money goes live.
- **Dependencies:** Cloud Infrastructure Provisioning (AWS RDS / GCP Cloud SQL).
- **Suggested Sprint:** Production Infrastructure, Backup/DR & Observability Sprint (Stage A/D).

---

## PART 2: CONFIRMED P1 (HIGH) FINDINGS — MUST RESOLVE BEFORE MERCHANT/RIDER ONBOARDING & PUBLIC LAUNCH

### `F-15.6-P1-01` — Customer Persistent Cart Domain Missing Completely
- **Domain:** Customer App / Core Commerce Engine
- **Severity:** **P1 — High**
- **Exact File Paths:** `QCOM/backend/migrations/` (001–027), `QCOM/backend/src/routes/`, `QCOM/backend/src/app.ts`
- **Actual Evidence:** No `carts` or `cart_items` table exists in any migration; no `/api/cart` or `/api/v1/cart` routes exist. Checkout relies solely on ephemeral client-supplied `items[]` passed to `/pricing/quote` and `/orders`.
- **Why It Matters:** Customers lose baskets across app restarts/devices, cannot validate cart staleness/single-merchant constraint server-side before checkout, and cannot support abandoned-cart recovery.
- **Recommended Fix:** Add `carts` + `cart_items` migration and `/api/v1/cart` CRUD + single-merchant enforcement + live price/stock validation endpoints.
- **Suggested Sprint:** Core Customer & Catalog Completion Sprint (Stage D).

---

### `F-15.6-P1-02` — Self-Serve Merchant & Rider Onboarding, KYC Document Storage & Verification Missing
- **Domain:** Merchant Panel / Delivery Partner App / Compliance
- **Severity:** **P1 — High**
- **Exact File Paths:** `QCOM/backend/migrations/003_create_merchants_and_catalog.sql`, `migrations/004_create_orders_and_trips.sql`, `QCOM/backend/src/routes/`
- **Actual Evidence:** `merchants` & `riders` tables have status/PAN/GSTIN/bank fields, yet zero HTTP endpoints exist for merchant/rider registration or document submission, no document metadata tables (`merchant_kyc_documents`, `rider_documents`) exist, and `bank_verified` / `kyc_status` have no verification API integration.
- **Why It Matters:** Platform cannot legally or safely onboard external local hardware merchants or independent delivery partners without manual database inserts and unverified bank accounts.
- **Recommended Fix:** Build `merchant_kyc_documents` & `rider_documents` tables, secure pre-signed upload URLs, onboarding APIs, PAN/GSTIN/Bank penny-drop verification service, and enforce `bank_verified = TRUE` + `kyc_status = 'GREEN'` before going `ACTIVE` or receiving payouts.
- **Suggested Sprint:** Merchant & Rider Onboarding + KYC Sprint (Stage B/C).

---

### `F-15.6-P1-03` — Serviceability Radius & Store Operating Hours Stored in DB but Never Enforced at Discovery or Checkout
- **Domain:** Commerce / Logistics / Store Availability
- **Severity:** **P1 — High**
- **Exact File Paths & Symbols:**
  - `QCOM/backend/src/modules/pricing/pricingEngine.ts:154` (selects `service_radius_meters`, unused)
  - `QCOM/backend/src/modules/orders/orderService.ts` (never checks `service_radius_meters`, never checks `merchant_stores.operating_hours_start/end`, auto-merchant lookup checks only `items[0]` and skips `status = 'ACTIVE'` if `is_online = TRUE`)
  - `QCOM/backend/src/modules/sellers/sellerService.ts:37` (hardcodes `tradeCategories: ['Electrical', 'Plumbing', 'Fasteners', 'Hardware Tools']`)
- **Actual Evidence:** Verified directly in `pricingEngine.ts` and `orderService.ts` queries; `operating_hours_start/end` is queried nowhere during order placement; `fulfilmentSelectionService.ts:127` also has an operator-precedence bug (`recommended?.customerDeliveryFee || 0 + ...` binds `+` before `||`).
- **Why It Matters:** Customers can place orders at closed shops, outside delivery zones (causing unfulfillable long-distance trips), or trigger auto-merchant assignment to a `PENDING` merchant or a merchant missing items 2..N of their cart.
- **Recommended Fix:** Enforce `status = 'ACTIVE'`, `is_online = TRUE`, `is_paused = FALSE`, store operating hours window (in IST), distance `<= service_radius_meters`, and full-cart availability inside checkout transaction; fix `fulfilmentSelectionService.ts:127` parentheses; replace hardcoded `tradeCategories` with DB-backed categories.
- **Suggested Sprint:** Commerce Storefront, Radius & Fulfillment Guards Sprint (Stage B).

---

### `F-15.6-P1-04` — Merchant Catalog Mutation & Admin Stock/Seller Mutation Stubs
- **Domain:** Merchant Panel / Admin Portal / Inventory
- **Severity:** **P1 — High**
- **Exact File Paths & Symbols:**
  - `QCOM/backend/src/routes/adminCompatibilityRoutes.ts`: `PUT /sellers/:id` (`368-378`), `POST /inventory/:id/adjust-stock` (`1096-1106`), `GET /cities` (`1018-1025`), `POST /service-areas`
  - `QCOM/backend/src/routes/resourceDemoRoutes.ts` (only exposes `restock` and threshold updates—no price/MRP/product creation/archive routes for sellers)
- **Actual Evidence:** `adminCompatibilityRoutes.ts` returns static `200 OK` JSON or audit-only logs without updating `merchants`, `products`, or `store_inventory`. Authenticated sellers have no API routes to add/edit catalog prices or products.
- **Why It Matters:** Sellers cannot maintain real product prices/catalogs; admins attempting emergency stock or merchant edits silently fail.
- **Recommended Fix:** Implement authenticated seller catalog & price management endpoints (`POST/PATCH /merchants/:merchantId/catalog`, price bounds validation) and fix/wire `adminCompatibilityRoutes` handlers to real DB mutations in `inventoryService` and `sellerService`.
- **Suggested Sprint:** Merchant Catalog & Admin Mutation Closure Sprint (Stage B).

---

### `F-15.6-P1-05` — Non-Cryptographic `Math.random()` Used for Delivery OTP Generation
- **Domain:** Security / Delivery Fraud Prevention
- **Severity:** **P1 — High**
- **Exact File Paths & Symbols:** `QCOM/backend/src/modules/orders/orderService.ts:28-30` (`generateDeliveryOtp`)
- **Actual Evidence:** `Math.floor(1000 + Math.random() * 9000).toString()` uses V8 PRNG (`xorshift128+`) rather than `crypto.randomInt(1000, 10000)`. Also `verify-otp` (`partnerCompatibilityRoutes.ts`) lacks attempt-rate limiting/lockout per task beyond general API rate limiter.
- **Why It Matters:** Predictable/weak delivery OTPs + lack of per-order attempt lockout expose doorstep handover & high-value COD confirmation to brute-force/guessing fraud.
- **Recommended Fix:** Switch to `crypto.randomInt(100000, 1000000)` (or `1000, 10000` if 4-digit required by UI) and add per-order OTP verification attempt counter/lockout in `delivery_trips`.
- **Suggested Sprint:** Security & Fraud Hardening Closure Sprint (Stage C).

---

### `F-15.6-P1-06` — Return Refund Math Omits Tax/Discount Proration, Doesn't Update `orders.payment_status`, & Reverse Pickup Reuses Forward Trip Row
- **Domain:** Returns / Refunds / Reverse Logistics
- **Severity:** **P1 — High**
- **Exact File Paths & Symbols:**
  - `QCOM/backend/src/modules/orders/returnService.ts` (refund calculation `unit_price * qty`, updates `orders.status = 'returned'` without updating `payment_status`)
  - `QCOM/backend/src/modules/dispatch/dispatchService.ts:738-747` (`createReversePickupTrip`: `SELECT ... FROM delivery_trips WHERE order_id = $1`)
  - `QCOM/backend/migrations/004_create_orders_and_trips.sql:111` (`order_id UUID UNIQUE NOT NULL`)
- **Actual Evidence:**
  - Return refund calculates `unit_price * qty`, failing to prorate coupon discounts or item GST reliably against paid order total, and skips updating `orders.payment_status` to `REFUND_PENDING` / `PARTIALLY_REFUNDED` / `REFUNDED`.
  - `delivery_trips` enforces `UNIQUE(order_id)`, forcing `createReversePickupTrip` (`dispatchService.ts:738-747`) to mutate and overwrite the completed forward delivery trip record (`status`, `rider_id`, `delivered_at`, OTP state) instead of creating an independent reverse-pickup trip!
- **Why It Matters:** Partial/discounted returns over-refund or under-refund customers; reverse pickups destroy forward trip proof-of-delivery and rider payout audit history.
- **Recommended Fix:** Add `trip_type` (`FORWARD` | `REVERSE_PICKUP`) and replace `UNIQUE(order_id)` with `UNIQUE(order_id, trip_type)` in `delivery_trips`; fix proportional tax+discount return refund calculation and update `orders.payment_status` consistently.
- **Suggested Sprint:** Returns, Credit Notes & Reverse Logistics Sprint (Stage D).

---

### `F-15.6-P1-07` — Statutory GST/Invoicing & Settlement Penalty Defects (`isInterState=false`, Place-of-Supply `'29'`, Plain-Text PDF, Fake IRN, Static Delay Penalty, No Credit Notes)
- **Domain:** GST / TDS / Financial Compliance & Invoicing
- **Severity:** **P1 — High**
- **Exact File Paths & Symbols:**
  - `QCOM/backend/src/modules/orders/orderService.ts:89,168` (`placeOfSupplyStateCode = '29'` hardcoded)
  - `QCOM/backend/src/modules/settlements/settlementAllocationService.ts:161,176` (`isInterState: false` hardcoded for TCS; `storeDelayPenalty` triggers if static `merchant.base_prep_mins > 5`, ignoring real prep duration)
  - `QCOM/backend/src/modules/invoices/invoiceService.ts` (synthetic SHA-256 IRN, hardcoded FY `'2026-27'`, fallback GSTINs `'29AAAAA0000A1Z5'`/`'29AAACQ1928K1Z3'`, platform fee invoice hardcodes `igst='0.00'` & 18%)
  - `QCOM/backend/src/modules/invoices/pdfGenerator.ts` (outputs plain text string, not PDF binary despite `jspdf` dependency; hardcodes `'Karnataka (29)'`)
- **Actual Evidence:** Verified directly in each file listed above. No GST Credit Note / Debit Note generation exists when returns or post-order refunds settle; `fy_gross_sales_inr` is not updated atomically to gate annual TDS thresholds.
- **Why It Matters:** Customers and B2B hardware buyers receive non-PDF text files showing wrong state codes, fake IRNs, and no tax credit notes on returns; merchants get penalized ₹25 on every order simply for having `base_prep_mins = 8` (the migration default!).
- **Recommended Fix:** Compute actual place-of-supply from customer address/GSTIN state code; compute actual prep delay from order timestamps (`picking_started_at` -> `packed_at`); wire real `jspdf` binary rendering + GST state code lookup; implement GST Credit Notes on returns; separate IRP e-invoicing behind feature/turnover flag (`>₹5Cr` statutory threshold check with CA).
- **Suggested Sprint:** GST Compliance, Invoicing & Tax Reporting Sprint (Stage D/E).

---

### `F-15.6-P1-08` — Non-Operational Admin Employee Creation & Missing Customer Fraud/Support/DPDP Implementations
- **Domain:** Admin Portal / Fraud / Support / DPDP
- **Severity:** **P1 — High**
- **Exact File Paths & Symbols:**
  - `QCOM/backend/src/routes/adminCompatibilityRoutes.ts`: `POST /employees/create` (`965-977`, creates admin with `password_hash = NULL`), `POST /customers/:id/fraud-controls` & `/notes` (`586-608`, audit-log only), `GET/POST /support/tickets*` (`844-872`, static mocked data)
  - `QCOM/backend/migrations/` (zero tables for `support_tickets`, `customer_notes`, `user_consents`, `account_deletion_requests`)
- **Actual Evidence:** Admins created via `POST /employees/create` fail login at `/api/auth/admin/login` (scrypt requires non-null `password_hash`); fraud controls & support tickets have zero persistence or checkout enforcement. Zero DPDP consent, data export, or PII-anonymization workflows exist.
- **Why It Matters:** Operational teams cannot onboard staff admins, block abusive COD accounts, track support escalations, or satisfy Indian DPDP data-principal access/erasure requests while preserving immutable 7–8 year financial ledgers.
- **Recommended Fix:** Require password/invite token on `POST /employees/create` using `authService.hashPassword()`; build `support_tickets`, `customer_fraud_flags` (enforced at COD checkout), and DPDP `user_consents` + PII-anonymization workflow (scrubbing `users`/`saved_addresses` while retaining `orders`/`invoices`/`general_ledger_entries` tax keys).
- **Suggested Sprint:** Support, Fraud Controls & DPDP Compliance Sprint (Stage E).

---

### `F-15.6-P1-09` — Logistics & Dispatch Algorithmic Gaps (No Road-Network Maps/ETA, Null Rider Coords Fallback, Rider Offline Guard, Reverse Trip Conflict)
- **Domain:** Logistics & Dispatch
- **Severity:** **P1 — High**
- **Exact File Paths & Symbols:**
  - `QCOM/backend/src/modules/routing/routingService.ts:50-97` (pure Haversine × 1.25 curvature, no external Maps API)
  - `QCOM/backend/src/modules/dispatch/candidateGenerator.ts:35-36,54` (`COALESCE(r.latitude, storeLocation)` substitutes store coords when rider GPS is NULL; hardcodes `0.15` commission)
  - `QCOM/backend/src/routes/partnerCompatibilityRoutes.ts` (`POST /rider/status` allows going `OFFLINE` during active assigned delivery)
- **Actual Evidence:** Verified directly in routing & candidate SQL/TS code. Additionally, rider alerts/dispatch offers have zero live push wake-up delivery (`F-15.6-P0-01`).
- **Why It Matters:** Dispatch can offer orders to offline/unlocated riders whose GPS is `NULL` by pretending they are standing inside the merchant store (`distance = 0m`), distorting SLAs; riders can drop offline mid-trip without triggering reassignment.
- **Recommended Fix:** Exclude riders with `latitude IS NULL OR longitude IS NULL` or stale GPS heartbeat (`>3-5 mins`) from auto-dispatch candidates; guard `POST /rider/status` against active `delivery_trips`; integrate real Maps Distance Matrix / OSRM routing with Redis caching.
- **Suggested Sprint:** Delivery-to-Settlement Pipeline & Logistics Hardening Sprint (Stage A/C).

---

### `F-15.6-P1-10` — Standalone Deployment Packaging Break (`ioredis` Missing from `QCOM/backend/package.json`), Fail-Closed Redis Single Point of Failure, & Zero Observability/Alerting
- **Domain:** Infrastructure / Packaging / Observability
- **Severity:** **P1 — High**
- **Exact File Paths & Symbols:**
  - `QCOM/backend/package.json` vs `/package.json` (`ioredis` only in root; `zod` `^3.24.2` vs `^4.6.5`)
  - `QCOM/backend/src/database/redis.ts:127-134,458-460` + `src/middleware/rateLimiter.ts` (`failureMode: 'closed'` returning `503` across auth/checkout/payment/admin)
  - `QCOM/backend/src/modules/audit/auditService.ts:90-93` (swallows audit DB errors to console)
  - `QCOM/backend/src/app.ts` (zero Sentry/Prometheus/OpenTelemetry/structured JSON logs)
- **Actual Evidence:** Verified directly in manifests, `redis.ts`, and `app.ts`. CI works only because `.github/workflows/ci.yml` injects `NODE_PATH` pointing to root `node_modules`.
- **Why It Matters:** Deploying `QCOM/backend` standalone in a Docker image fails immediately on missing `ioredis`; any transient Redis blip freezes all logins, checkouts, and payments (`503`); engineering has zero automated alerting for webhook failures, stuck `RECONCILIATION_REQUIRED` orders, or outbox backlogs.
- **Recommended Fix:** Add `ioredis` + align `zod` in `QCOM/backend/package.json`; provision Redis Sentinel/Cluster HA; add structured JSON logging (`pino` + correlation IDs), Prometheus/OTel metrics, Sentry error capture, and webhook/reconciliation/outbox alert hooks.
- **Suggested Sprint:** Production Infrastructure, Backup/DR & Observability Sprint (Stage D).

---

### `F-15.6-P1-11` — Testing False-Confidence Gap (49/56 Suites Mocked on `pg-mem`, 11 Sleep Timers, Zero Real External Sandbox Coverage)
- **Domain:** Testing Quality & Verification
- **Severity:** **P1 — High**
- **Exact File Paths & Symbols:**
  - `QCOM/backend/tests/*.test.ts` (`49/56` files import/use `pg-mem`; `15/56` reference real PG; `11` `setTimeout` calls)
  - `QCOM/backend/tests/integration/real-services.test.ts` (real PG + Redis harness, mocks payment/payout/telephony providers)
- **Actual Evidence:** Static count of all 56 top-level test files + `real-services.test.ts`. Multiple real bugs (`POST /promotions/create` column mismatch, SGST typo, `adminCompatibilityRoutes` stub `200 OK`s, `partnerCompatibilityRoutes` bypassing ledger) passed 56/56 CI checks undetected.
- **Why It Matters:** Green CI test badges currently create severe false confidence that end-to-end money movement, promotions, and admin actions work on real PostgreSQL + live providers.
- **Recommended Fix:** Eliminate `pg-mem` from financial/SQL regression suites where possible, add strict DB state assertions for every admin/partner/promotion route, replace `setTimeout` sleeps with deterministic clocks/polling, and add sandbox provider integration tests.
- **Suggested Sprint:** Embedded continuously in Stages A–E (`Definition of Done` per sprint).

---

## PART 3: EXPLICITLY SEPARATED UNVERIFIED RISKS & CONCERNS

*(Issues that cannot be definitively confirmed as bugs from read-only static inspection without live traffic, stress testing, or statutory legal counsel review.)*

1. **Multi-Instance Connection Pool & Lock Contention Under Peak Concurrency (Unverified Load):** `connection.ts` sets `max: 20` per Node process; real throughput ceiling (req/s), p95 checkout latency, and lock wait behavior on hot SKUs (`store_inventory`) across multiple Node replicas have never been benchmarked against PostgreSQL 16.
2. **Payment Webhook Out-of-Order Edge Cases Across Live Gateways (Unverified Live Behavior):** `financialWebhookService.ts` and `paymentService.ts` enforce state transitions on mocked payloads, but exact Razorpay/Cashfree payload field variations (e.g., UPI autopay/partial capture/dispute webhook shapes `payment.dispute.created`) are unverified against live gateway events.
3. **Statutory GST E-Invoicing / E-Commerce Operator TCS Applicability & Rates (Requires Tax/Legal Counsel):** Technical tables support Section 52 GST-TCS (`0.5%` / `0.25%+0.25%`) and Section 194O / IT Act 2025 Section 393 TDS (`0.1%`). Whether QCOM's exact local-hardware-marketplace contract model triggers mandatory e-Invoice IRP immediately vs after turnover threshold, GST treatment on delivery charges (`9968`) as pure agent vs principal supply, and multi-state GSTIN registration obligations require qualified CA/legal sign-off.
4. **Redis Eviction / Memory Bounds Under Scale (Unverified Runtime Sizing):** Geo indexes, rate-limit sliding windows, Bloom filters (`resilience/bloomFilterService.ts`), and blacklisted tokens share one Redis instance without configured keyspace memory eviction alerts.
5. **Frontend-to-Backend Compatibility Across `customer-app/`, `delivery-app/`, `admin-portal/` (Out of Backend Code Scope):** Workspace lacks `seller-app/`; frontend apps were outside backend mutation scope and not executed end-to-end against a live running server during this read-only audit.

---

## PART 4: DOMAINS WITH ZERO CONFIRMED P0/P1 DEFECTS IN CORE ENGINE (NOT RISK-FREE)

- **Core Double-Entry General Ledger Math & Batch Balancing (`ledgerService.ts`, `migrations/005`, `018`, `027`):** No P0/P1 defects found inside `ledgerService.ts` itself (`SUM(DEBIT) == SUM(CREDIT)` invariant, unique `transaction_reference` idempotency, row locks, trial balance check). **However**, it is **not risk-free** because callers (`partnerCompatibilityRoutes.ts`) fail to invoke it on delivery completion and backup/DR does not yet protect the underlying ledger data.
- **Admin Authentication & Core RBAC Privilege-Escalation Guards (`authService.ts`, `rbacService.ts`, `middleware/rbac.ts`):** Scrypt password verification, refresh-token rotation/family revocation, Redis cross-instance session invalidation, and `SUPER_ADMIN` escalation checks passed inspection with zero P0/P1 defects in core token logic (aside from `adminCompatibilityRoutes.ts` `POST /employees/create` leaving `password_hash = NULL`). Still requires Redis HA resilience (`F-15.6-P1-10`) and security penetration testing prior to public launch.
