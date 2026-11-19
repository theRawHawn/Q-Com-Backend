# SPRINT 15.6 — PRODUCTION LAUNCH READINESS REPORT

**Project:** QCOM (Quick Commerce Hardware & Trade Marketplace)
**Repository:** `https://github.com/theRawHawn/Q-Com-Backend.git` (`main`)
**Baseline Commit SHA:** `c384268da1d0f24a93aaf86215b18ead5a56b1fa`
**Target:** `QCOM/backend`

---

## 1. Executive Summary

> **FINAL LAUNCH CLASSIFICATION: `NOT READY FOR REAL TRANSACTIONS`**

QCOM's backend has made substantial engineering progress on its **internal transactional foundations**—most notably scrypt/HMAC-OTP auth hardening with cross-instance Redis revocation (Sprint 15.4), PostgreSQL `SELECT ... FOR UPDATE` inventory reservation locks (`chk_reserved_le_stock`), a balanced double-entry General Ledger (`general_ledger_entries`, `ledger_journal_batches`), outbox/recovery worker leases, and clean TypeScript compilation (`tsc --noEmit` exits `0`, GitHub Actions run `44340735466` passed all 56 suites + `real-services.test.ts` on PG 16 & Redis 7.0.15).

**However, QCOM cannot safely execute a single real-money order, onboard external merchants/riders, or boot in production today.** Direct code inspection proves why green CI results must not be mistaken for production readiness:
1. **Boot-Time Production Crashes:** Three core providers (`otpProvider.ts`, `payoutProvider.ts`, `pushProvider.ts`) throw exceptions at startup or fail when `NODE_ENV=production` because **no live SMS/OTP, Razorpay/Cashfree payment, RazorpayX/Cashfree payout, or live FCM HTTP push adapter exists**—CI only passes under `NODE_ENV=test` with `PAYMENT_MODE=mock` and `TELEPHONY_MODE=mock`.
2. **Broken Delivery-to-Ledger Pipeline:** `partnerCompatibilityRoutes.ts` (`POST /tasks/:taskId/verify-otp`) marks orders delivered without calling `settlementAllocationService`, without recording COD cash in `riders.floating_cash_balance` or `rider_ledgers`, without updating COD `orders.payment_status`, and without resetting riders to idle.
3. **Financial & Database Concurrency Traps:** Order cancellation executes gateway HTTP refund calls + retry sleeps **inside** an open `orders FOR UPDATE` DB transaction (`cancellationService.ts:255-267`); sellers can withdraw funds immediately with **zero return-window hold** or merchant payout-hold column; coupons lack `usage_limit` enforcement/increment; admin refund & settlement compatibility routes (`/admin/refunds/*`, `/admin/settlements`) are stubs or naive estimates.
4. **Zero DR & Observability:** There are zero automated PostgreSQL backups/PITR scripts, zero error/metrics monitoring, missing persistent carts, missing merchant/rider KYC & self-onboarding APIs, and `ioredis` is omitted from `QCOM/backend/package.json`.

---

## 2. Current Backend Baseline Verification

| Metric | Verified Finding | Evidence Source |
|---|---|---|
| **Git Repository & Branch** | `https://github.com/theRawHawn/Q-Com-Backend.git`, branch `main` | GitHub API / Git remote check |
| **Baseline Commit SHA** | `c384268da1d0f24a93aaf86215b18ead5a56b1fa` (matches expected baseline) | GitHub Actions run `44340735466` |
| **Workspace State** | `/app/applet/QCOM` holds `admin-portal/`, `backend/`, `customer-app/`, `delivery-app/` (no `seller-app/`, no local `.git/`) | Direct workspace inspection |
| **TypeScript Build** | `npm --prefix QCOM/backend run build` (`tsc --noEmit`) **passed (exit 0)** | Direct CLI execution in workspace |
| **PostgreSQL Version (CI)** | PostgreSQL 16 (`postgres:16-alpine` / `16.x` compose image) | `.github/workflows/ci.yml` + `44340735466` |
| **Redis Version (CI)** | Redis `7.0.15` (`redis:7.0.15-alpine`, enforced by `verify-redis-version.ts`) | `.github/workflows/ci.yml` + `scripts/verify-redis-version.ts` |
| **Backend Test Count** | **56** top-level `tests/*.test.ts` suites + `tests/integration/real-services.test.ts` | `QCOM/backend/tests/` (`49/56` use `pg-mem`; `15/56` reference `pg.Pool`) |
| **Latest CI Execution** | Workflow run `44340735466`: **Success** on both jobs (`All 56 Test Suites` & `Real-Services Integration Harness`) | GitHub Actions API (`44340735466`) |

> **Workspace Note:** Container lacks local `psql`, `redis-server`, and `gh` binaries, so live database execution is verified via CI logs rather than local container execution.

---

## 3. Application Readiness Assessments

### 3.1 Customer App Readiness (`NOT READY`)
- **Works (`pg-mem` / PG):** Profile & multi-address CRUD (`customerRoutes.ts`, `saved_addresses`, `saved_gstins`), atomic order placement & inventory reservation (`orderService.ts`), HMAC/JWT session lifecycle (`authService.ts`), WebSocket tracking subscription.
- **Incomplete / Missing:** Persistent server-side cart (`carts`/`cart_items` tables & routes missing completely); product variants/barcodes/full-text search; customer support tickets; ratings & reviews; OAuth social login; DPDP consent/export/deletion endpoints.
- **Broken / Unsafe / Blocked:** Registration/login OTP fails on production boot (`otpProvider.ts` throws); online payments fail or run in-memory stubs (`RazorpayPaymentProvider`); coupon `usage_limit` never enforced or incremented; checkout doesn't enforce merchant `service_radius_meters` or `operating_hours`; `placeOfSupplyStateCode` hardcoded to `'29'`; `deliveryOtp` uses `Math.random()`; return refund math skips GST/discount proration & doesn't update `orders.payment_status`; B2C/B2B invoices output plain-text strings with fake SHA-256 IRNs.

### 3.2 Merchant / Seller Panel Readiness (`NOT READY`)
- **Works:** `store_inventory` concurrent stock locks (`chk_reserved_le_stock`), selective low-stock/out-of-stock alert episodes (`seller_stock_alerts`, `resourceDemoRoutes.ts`), seller threshold updates, merchant settlement allocation math & immutable `seller_ledgers` (`ledgerService.ts`, `settlementAllocationService.ts`).
- **Incomplete / Missing:** No self-serve merchant registration routes, no KYC document upload/verification (`merchant_kyc_documents` missing), no seller-facing catalog/price/product CRUD routes, no merchant `is_payout_held` freeze flag, no settlement dispute workflow, no financial/GST CSV downloads.
- **Broken / Unsafe / Blocked:** Bank payouts throw in prod (`payoutProvider.ts`); any seller can self-initiate payout immediately without a return-window cooling-off hold or bank verification check (`settlementRoutes.ts:252-278`); `sellerService.ts:37` hardcodes `tradeCategories`; `settlementAllocationService.ts:161` charges delay penalties based on static `merchant.base_prep_mins > 5` instead of actual order prep timing; `partnerCompatibilityRoutes` seller order accept/reject lacks full `picking`/`packed` transitions.

### 3.3 Delivery Partner App Readiness (`NOT READY`)
- **Works:** `dispatchService.ts` concurrency locks + partial unique PostgreSQL indexes (`idx_active_dispatch_assignment`, `idx_active_rider_offer`) preventing double-assignment/conflicting offers; expired-offer reaper (`server.ts`); live GPS velocity anti-spoofing (45 m/s) in `liveLocationService.ts`; `rider_ledgers` double-entry payout structures.
- **Incomplete / Missing:** No self-serve rider registration or KYC document tables (DL/RC/Aadhaar); no rider zone assignment enforcement; no SOS/safety escalation workflow; no cash-deposit reconciliation API; no incentive/bonus rules engine; no push wake-up for incoming dispatch offers.
- **Broken / Unsafe / Blocked:** `POST /tasks/:taskId/verify-otp` (`partnerCompatibilityRoutes.ts:586-703`) bypasses settlement allocation, skips COD cash tracking (`riders.floating_cash_balance` & `rider_ledgers`), skips `orders.payment_status = 'PAID'`, leaves riders non-idle (`IDLE_AT_HUB` never restored), skips pickup preconditions, and returns fake earnings; `candidateGenerator.ts:35-36` substitutes store location if rider GPS is `NULL`; `POST /rider/status` allows going `OFFLINE` mid-delivery; `createReversePickupTrip` (`dispatchService.ts:738-747`) overwrites the forward `delivery_trips` row because of `UNIQUE(order_id)`.

### 3.4 Admin Portal Readiness (`NOT READY`)
- **Works:** Hardened admin email/password login (`scrypt`), token rotation & cross-instance Redis revocation, RBAC privilege-escalation prevention (`rbacRoutes.ts`, `rbacService.ts`), sanitized audit logs (`auditService.ts`), merchant/rider approve/suspend endpoints (`adminCompatibilityRoutes.ts`).
- **Broken / Unsafe / Stubs:**
  - `POST /employees/create` (`adminCompatibilityRoutes.ts:965-977`) creates admins with `password_hash = NULL` (cannot log in).
  - `POST /promotions/create` (`lines 1030-1038`) references nonexistent `coupons` columns (`title`, `min_order_value`, `max_discount`, `start_date`, `end_date`).
  - `POST /refunds/:id/{approve,reject,hold,retry}`, `POST /refunds/create`, `POST /disputes/:id/resolve` (`lines 749-838`), `PUT /sellers/:id` (`368-378`), `POST /inventory/:id/adjust-stock` (`1096-1106`), `POST /customers/:id/{fraud-controls,notes}` (`586-608`), `POST /riders/:id/release-payout`, `GET/POST /support/tickets*`, `GET /cities` are all **non-functional stubs or audit-log-only handlers**!
  - `GET /admin/settlements` (`lines 222-266`) fabricates naive `total * 0.85` estimates ignoring actual allocations, taxes, penalties, and payouts.
  - Missing: Dual-control refund/payout approval limits, feature flags, runtime emergency kill-switches, CSV/tax report exports, DPDP retention tools.

---

## 4. Core Commerce Engine & Reconstructed Order State Machine

### 4.1 Commerce Architecture Evaluation
- **Catalog:** Separates master `products` (SKU, HSN, GST, specifications JSONB) from `store_inventory` (merchant price, stock, reserved, bin) and `seller_product_tax` (`migrations/010`). Supports multiple local stores selling the same SKU at independent prices/stock (`uq_merchant_product`). **Gap for future categories (e.g., automobile spare parts):** lacks normalized `brands`, `manufacturers`, `vehicle_compatibility`/fitment taxonomy tables, `product_variants` (size/color/voltage), and `barcode` indexing—though `specifications JSONB` offers partial interim flexibility.
- **Pricing:** `pricingEngine.ts` enforces server-authoritative pricing (`BigNumber` in `money.ts`) and saves immutable `pricing_calculation_snapshots` (`migrations/009`). Client cannot dictate item prices—`orderService.ts` recomputes/reads authoritative DB values. **Critical flaws:** `totalSgstBn` adds `qcomCgstBn` instead of `qcomSgstBn`; coupon `usage_limit` is unvalidated/unincremented; `service_radius_meters` isn't enforced.
- **Cart & Inventory Timing:** No persistent cart exists. Cart turns into an `orders` row (`status = 'placed'`) + `inventory_reservations` row (`status = 'RESERVED'`, 5-minute TTL) **atomically at `POST /api/orders`** inside one PostgreSQL transaction (`orderService.ts:104`).
  - *Concurrency Proof:* `inventoryService.reserveStock()` sorts items by `product_id`, acquires `SELECT ... FOR UPDATE` on `store_inventory` rows, checks `stock_count - reserved_count >= qty`, backed by PostgreSQL constraint `chk_reserved_le_stock CHECK (reserved_count <= stock_count)`. Two customers buying the last unit concurrently serialize at PostgreSQL row lock—the second fails safely with `INSUFFICIENT_STOCK`. For online payments (`Instant UPI`/`Corporate Card`), `commitStock()` happens atomically on payment capture (`paymentService.ts:643,1069`); for COD (`Pay on Delivery`), `commitStock()` happens immediately on order creation (`orderService.ts:116`).

### 4.2 Reconstructed Order & Fulfillment State Machine

PostgreSQL `orders.status` allows (`migrations/017`): `placed`, `picking`, `packed`, `out_for_delivery`, `arriving`, `delivered`, `cancelled`, `return_requested`, `return_approved`, `return_rejected`, `return_picked_up`, `returned`.

| Current State | Trigger / Route | Target State | Service Validation? | DB Protection? | Concurrency / Defect Assessment |
|---|---|---|---|---|---|
| *(None)* | `POST /api/orders` (`orderService.createOrder`) | `placed` | Yes | `CHECK`, `orders` FK, `chk_reserved_le_stock` | Safe under lock; **Defect:** auto-merchant checks only `items[0]` & allows `PENDING` merchants |
| `placed` | Seller accept (`partnerCompatibilityRoutes`) | `placed` / `picking` | Weak | `CHECK` | Overlapping semantics between `/accept`, `/updateOrderStatus`, and partner routes |
| `placed`/`picking` | Seller pack / mark ready | `packed` | Partial | `CHECK` | Missing granular seller `picking` vs `packed` compatibility endpoints |
| `packed` / `placed` | Rider accept + pickup (`dispatchService` / `partnerCompatibilityRoutes`) | `out_for_delivery` | **No (bypass risk)** | `delivery_trips.status CHECK`, partial unique dispatch idx | **Defect:** `partnerCompatibilityRoutes` `/arrived-pickup` & `/pickup-confirm` don't enforce prior state |
| `out_for_delivery` / **ANY non-delivered** | `POST /tasks/:id/verify-otp` (`partnerCompatibilityRoutes:586`) | `delivered` | **No (P0 Defect)** | Only checks `NOT IN ('DELIVERED','COMPLETED')` | **P0 Defect:** Allows skipping pickup straight to `delivered`; doesn't call `settlementAllocationService`, COD ledger, or reset rider idle! |
| `placed`/`picking`/`packed` | `POST /orders/:id/cancel` (`cancellationService`) | `cancelled` | Yes (`FOR UPDATE`) | Row lock on `orders` | **P0 Defect:** Calls external refund API inside `FOR UPDATE` DB txn (`255-267`); missing `actor_id` check on idempotency `SELECT` |
| `delivered` | `POST /returns` (`returnService`) | `return_requested` -> `return_approved` / `return_rejected` -> `return_picked_up` -> `returned` | Yes (`FOR UPDATE`) | `order_returns` + `order_return_items` CHECKs | **P1 Defect:** `createReversePickupTrip` mutates forward trip row (`UNIQUE(order_id)`); refund skips tax/discount proration & `orders.payment_status` |
| *(Any)* | Payment webhook (`paymentService.processWebhook`) | No invalid forward shift | Yes (`paymentStateMachine` + `FOR UPDATE`) | `webhook_events` PK/unique + `FOR UPDATE` | **Strong:** Late `payment.captured` on expired/cancelled order sets `payment_status='REFUND_PENDING'` & keeps `status='cancelled'` |

> **Critical Architectural Finding:** There is **no unified order state-machine validator** analogous to `paymentStateMachine.ts`. Mutations are split across `orderService.ts`, `deliveryRoutes.ts`, `partnerCompatibilityRoutes.ts`, `cancellationService.ts`, and `returnService.ts`, creating direct transition bypasses (`verify-otp`) and race windows.

---

## 5. Payment & Financial System Assessment

| Financial Capability | 1. Actual Impl | 2. DB Source of Truth | 3. Transaction Boundaries | 4. Idempotency Controls | 5. Concurrency Controls | 6. Failure / Recovery Behavior | 7. Tests | 8. Remaining Risks |
|---|---|---|---|---|---|---|---|---|
| **Payment Intent & Capture** | `paymentService.ts` + stub `RazorpayPaymentProvider` | `orders`, `payment_intents`, `payment_attempts`, `payment_receipts` | Single PG txn on `verifyPayment` | `Idempotency-Key` table + `transaction_id UNIQUE` | `orders` & `payment_intents` `FOR UPDATE` | Late capture -> `REFUND_PENDING` escrow + compensation refund; ambiguous -> `RECONCILIATION_REQUIRED` worker | Mocked unit + PG race tests | **P0:** Live Razorpay HTTP SDK missing |
| **Webhooks (Pay / Refund / Payout)** | `paymentRoutes.ts` (`rawBody`), `paymentService.ts`, `financialWebhookService.ts` | `webhook_events` (`event_id UNIQUE`) | Atomic insert + `FOR UPDATE` tx | `webhook_events.status='PROCESSED'` short-circuit | `FOR UPDATE` on `webhook_events` + `orders` | Failed webhook marked `'FAILED'` for manual/worker inspection | HMAC + replay race tests (mocked payloads) | **P1:** Live gateway payload schema unverified |
| **Refunds (Cancel & Return)** | `refundService.ts`, `cancellationService.ts`, `returnService.ts` | `refunds`, `general_ledger_entries`, `seller_ledgers` | `refundService` posts DB + `outbox_events`; **Defect:** `cancellationService` holds `FOR UPDATE` during provider HTTP | `refunds.idempotency_key UNIQUE` + deterministic ledger refs | Row locks on `orders`/`refunds` | `financialRecoveryWorker` reaps stale `PROCESSING` refunds with leases | Mocked provider tests (`pg-mem` + PG) | **P0:** Cancellation external I/O inside DB txn; **P0:** Admin compatibility stubs |
| **COD Collection & Cash Liability** | `ledgerService.recordCodCollection` (exists, uncalled by `partnerCompatibilityRoutes`) | `delivery_trips`, `rider_ledgers`, `riders.floating_cash_balance`, GL `1030` | Intended single tx on delivery | Deterministic GL `transaction_reference` | Row lock on `riders` | No rider cash-deposit / CMS settlement route | Isolated ledger unit test only | **P0:** `verify-otp` never posts COD cash or marks `orders.payment_status='PAID'` |
| **Double-Entry GL & Trial Balance** | `ledgerService.ts` + `migrations/027` trigger/batch | `general_ledger_accounts`, `ledger_journal_batches`, `general_ledger_entries` | Atomic PG txn per financial event | Unique `transaction_reference` per batch | Ledger batch lock & append-only rows | `assertOrderLedgerBalanced` + `verifyTrialBalance` | `sprint15-5` + CI `real-services.test.ts` | Strongest subsystem; relies on callers invoking it & DB backups |
| **Seller Commissions & Settlement** | `settlementAllocationService.ts` | `order_settlement_allocations`, `seller_ledgers`, GL | Single PG txn (`allocateFulfilledOrder`) | `order_id UNIQUE` on allocations | Row lock on `orders`/`merchants` | Idempotent skip if allocated | Allocation + clawback tests | **P0:** Uncalled in `partnerCompatibilityRoutes`; **P1:** hardcoded `isInterState=false`, static `base_prep_mins` penalty |
| **Seller & Rider Payouts** | `sellerSettlementService.ts`, `riderPayoutService.ts`, stub `payoutProvider.ts` | `seller_payouts`, `seller_payout_batches`, `rider_payouts` | Tx 1: `PROCESSING` + debit; Tx 2: UTR/confirm or restore on conclusive fail | `idempotency_key` partial unique (`migrations/019`) | `merchants`/`riders` `FOR UPDATE` before payout | Ambiguous fails stay `PROCESSING` -> `financialRecoveryWorker` reconciles | Double-payout race tests (Mock provider) | **P0:** Prod startup crash; **P0:** Instant seller payout with zero cooling-off hold or approval cap |
| **Chargebacks & Manual Adjustments** | `ADJUSTMENT` entry enum exists; no dispute/chargeback workflow | `seller_ledgers`, `general_ledger_entries` | N/A | N/A | N/A | No automated chargeback webhook handler | None | **P1:** Must build chargeback/dispute reserve & adjustment flow |

---

## 6. GST, TDS, and Indian Business Compliance Readiness

*(Strict separation: engineering capability vs business/legal compliance. No formal legal advice implied.)*

| Dimension | Technical Capability Today | Confirmed Gaps / Defects | Business Process & Statutory Validation Needed (With Qualified CA/Legal Counsel) |
|---|---|---|---|
| **GST Classification & Tax Calculation** | `taxEngine.ts` + `migrations/007` + `010`: HSN/SAC rule resolution with `effective_from`/`effective_to` dates (changes don't corrupt past transactions thanks to `pricing_calculation_snapshots` & `order_items` snapshots). | `pricingEngine.ts` SGST calculation typo (`qcomCgstBn` added into `totalSgstBn`). Platform invoice hardcodes `18%` & `igst = '0.00'`. | Confirm HSN/SAC mappings for hardware items, delivery fees (`9968`), and commission (`9983`), and verify tax-inclusive vs tax-exclusive UI display rules. |
| **Place of Supply (CGST/SGST vs IGST)** | `taxEngine.calculateGst()` compares `merchantStateCode !== placeOfSupplyStateCode` to split CGST+SGST vs IGST. | `orderService.ts:89,168` hardcodes `placeOfSupplyStateCode = '29'` (Karnataka); `settlementAllocationService.ts:176` hardcodes `isInterState: false`. | Confirm intra/inter-state rules for local merchant-to-customer deliveries & platform-to-merchant commission invoicing outside Karnataka. |
| **Tax Invoices, Credit/Debit Notes & E-Invoicing** | `invoices` & `invoice_line_items` tables exist (`migrations/012`); `invoiceService.ts` assigns sequential-style invoice numbers & seller/platform invoices. | `pdfGenerator.ts` outputs **plain text** (not real PDF), hardcodes `'Karnataka (29)'`; `invoiceService.ts` generates fake SHA-256 IRNs, hardcodes FY `'2026-27'` and fallback GSTINs (`29AAAAA0000A1Z5`); **zero GST Credit Notes** on returns/refunds. | Confirm mandatory NIC e-Invoice IRP registration applicability by aggregate turnover threshold and statutory mandatory invoice/credit-note fields (Rule 46/53 CGST Rules). |
| **GST-TCS (Sec 52 CGST) & Direct-Tax TDS (Sec 194O / Sec 393)** | Schema & dynamic rule resolution exist (`gst_tcs_rules`, `statutory_withholding_rules` supporting IT Act 1961 vs IT Act 2025 post-01-Apr-2026 date cutoff). | Settlement hardcodes `isInterState: false` on TCS; annual cumulative gross threshold checks (`merchants.fy_gross_sales_inr`, `riders.fy_gross_payout_inr`) are not atomically updated/evaluated on every transaction; **zero GSTR-8, GSTR-1, or Form 26Q/16A export files**. | CA must verify exact Sec 52 TCS rate (post-2024 0.5% rule), IT Act 2025 Section 393 threshold/rate effective dates, rider withholding applicability, and monthly GST/TDS remittance & challan workflows. |

---

## 7. Logistics, Notifications, Support, Fraud, Security & DPDP Readiness

### 7.1 Logistics & Quick-Commerce Operational Model (`PARTIALLY IMPLEMENTED`)
- **Marketplace Compatibility:** QCOM's schema cleanly supports independent local merchants (no dark stores assumed): multi-merchant `merchants`/`merchant_stores`, per-store stock (`store_inventory`), bin locations (`bin_location`), and proximity scoring (`candidateGenerator`).
- **Operational Blockers:** (1) `merchant_stores.operating_hours_start/end` is never checked—customers can order from closed hardware stores. (2) `service_radius_meters` is never enforced in `pricingEngine`/`orderService`. (3) Auto-merchant assignment checks only `items[0]`, failing on multi-item hardware baskets. (4) `routingService.ts` uses `Haversine * 1.25` with zero real Maps traffic ETA. (5) `candidateGenerator` substitutes `storeLocation` for `NULL` rider GPS. (6) Reverse pickups (`dispatchService.createReversePickupTrip`) overwrite forward `delivery_trips` row.

### 7.2 Notifications & Communications (`EXTERNALLY BLOCKED`)
- `notificationService.ts`, `campaignService.ts`, `preferenceService.ts`, `deviceTokenService.ts` provide strong consent filtering, `dedupe_key` idempotency, deep-link allowlisting, and WebSocket real-time alerts.
- **Zero external transport exists:** Push (`pushProvider.ts` `FcmPushProvider`) is a non-HTTP stub; OTP SMS (`otpProvider.ts`) throws in prod; **WhatsApp, Email, and transactional SMS (order updates, rider dispatch offers, refund alerts) do not exist in code.**

### 7.3 Customer Support, Returns & Disputes (`PARTIALLY IMPLEMENTED` / `MISSING`)
- Returns (`returnRoutes.ts`, `returnService.ts`, `migrations/017`) handle item-level request, QC (`PASSED`/`FAILED`), restocking (`restockItem`), and seller debit clawback (`RETURN_DEBIT`).
- Support & Disputes (`GET/POST /admin/support/tickets`, `/disputes/:id/resolve`) are **100% static stubs** with zero DB tables (`support_tickets` missing), zero SLA/escalation tracking, zero image evidence storage, and zero support-staff safe adjustment workflow decoupled from direct SQL/ledger edits.

### 7.4 Fraud & Abuse Readiness (`PARTIALLY IMPLEMENTED`)
- **Existing Controls:** Strict auth rate limits, OTP 5-attempt lockout, timing-safe HMAC verification, JWT/refresh replay detection + cross-instance invalidation, GPS 45 m/s velocity anti-spoofing, duplicate gateway `transaction_id` replay blocking, immutable GL audit.
- **Missing Controls:** Zero coupon `usage_limit` or per-user coupon enforcement; zero per-order delivery-OTP lockout (`Math.random()` OTP); non-functional admin fraud-control toggles (`audit_logs` only); zero COD velocity/repeat-RTO blocking; zero return-frequency abuse scoring; zero merchant-rider self-dealing detection (partially mitigated once T+N settlement holds + KYC are enforced).

### 7.5 Security & DPDP Technical Readiness (`IMPLEMENTED CORE SECURITY` / `MISSING DPDP WORKFLOWS`)
- **Security Strengths (Sprint 15.4 verified):** Scrypt password hashes (`N=16384`), OTP HMAC hashing + salt, refresh-token rotation + reuse family revocation, Redis cross-instance session blacklist & `auth:revoked_after`, RBAC escalation guard, production CORS + trusted-proxy enforcement, audit log secret redaction (`[REDACTED_SECRET]`).
- **Security Gaps:** `POST /admin/employees/create` inserts `password_hash = NULL`; `cancellationService` idempotency lookup omits `actor_id`; `auditService` swallows DB insertion errors silently; `orderService` uses `Math.random()`.
- **DPDP Technical Gaps (`MISSING`):** No personal data inventory/retention schedule in code; no versioned consent ledger (aside from push prefs); no `/me/export` data portability; **no account deletion/anonymization workflow** capable of scrubbing PII (`users.name/phone/email`, `saved_addresses`, `saved_gstins`) while preserving immutable financial/tax records (`orders`, `invoices`, `general_ledger_entries`) as legally required.

---

## 8. Infrastructure, Observability, Backup/DR & Testing Maturity

### 8.1 Infrastructure & Observability
- **Connection Pool & Resilience (`src/database/connection.ts`, `redis.ts`, `resilience/`):** Clean PG pool (`max: 20`, `idleTimeoutMillis: 30000`, `statement_timeout: 15000`), Redis circuit breaker + Lua sliding-window rate limits, outbox worker (`2s` polling + DB leases + backoff), recovery worker (`60s` polling + `maxAttempts`), Bloom filter + singleflight cache protection, graceful `SIGTERM` drain.
- **Gaps:** (1) `ioredis` missing from `QCOM/backend/package.json` (`zod` version drift `3.24.2` vs `4.6.5`). (2) Auth/checkout/payment/admin routes use `failureMode: 'closed'` returning `503` when Redis fails while `inMemoryStore` is banned in prod (`redis.ts:127`) -> Redis outage causes full commerce outage unless HA Sentinel/Cluster deployed. (3) Zero load/benchmark tests executed—latency & throughput limits unknown. (4) Observability blind spots: `console.log`/`error` instead of structured JSON logging, no Sentry, no Prometheus/OTel metrics, no automated dead-letter (`outbox_events`/`webhook_events`) or financial reconciliation alerts.

### 8.2 Backup & Disaster Recovery (`MISSING` / `P0`)
- **Backup configured?** No (`0` scripts, `0` IaC/CI jobs).
- **Backup executed?** No.
- **Backup integrity verified?** No.
- **Restore tested?** No (only in-memory `pg-mem.backup()/restore()` in test helper).
- **Disaster recovery tested?** No. RPO/RTO undefined; Redis persistence/recovery unconfigured.

### 8.3 Testing Quality Assessment (`IMPLEMENTED, INSUFFICIENTLY VERIFIED`)
- **What IS well-tested:** Happy paths, duplicate/idempotent retries, payment webhook replay/ordering mocks, inventory race concurrency (`real-services.test.ts`), RBAC/auth escalation (`sprint15-4`), and double-entry GL ledger balancing (`sprint15-5`).
- **Critical Test Quality Weaknesses:**
  1. **`pg-mem` Divergence (`49/56` files):** In-memory JS emulation differs from PostgreSQL 16 (transaction isolation, constraints, column behavior) and cannot execute real concurrent cross-connection locks reliably.
  2. **11 `setTimeout` Sleeps:** Introduces timing assumptions in concurrency/expiry tests (`outbox`, `recovery`, `ttl`).
  3. **Stubs Masking Broken Behavior:** Admin compatibility tests checked `200`/`403` without verifying whether DB rows changed, missing 8+ stub routes (`PUT /sellers/:id`, `/refunds/*`, `/inventory/:id/adjust-stock`).
  4. **Missing Negative/End-to-End Scenarios:** `POST /promotions/create` column error, coupon `usage_limit` exhaustion, pricing SGST typo, partner delivery -> settlement -> COD ledger gap, and gateway network timeouts inside `cancellationService` all went undetected.

---

## 9. Six System-Design Controls Matrix

| Domain | 1. Rate Limiting | 2. Latency Controls | 3. Throughput & Pool Sizing | 4. Timeouts | 5. Concurrency Controls | 6. Backpressure |
|---|---|---|---|---|---|---|
| **Auth & Sessions** | Strict Redis sliding-window IP+user limit (`503` closed if Redis down) | Scrypt async hashing; Redis fast-path token revocation | PG pool `max: 20`; `auth_sessions` indexed | PG `statement_timeout: 15s`, Redis `commandTimeout` | Atomic token rotation (`FOR UPDATE`) + OTP attempt increment | `503 Retry-After` when Redis/PG unavailable |
| **Checkout & Inventory** | Customer order rate limiter (`rateLimiter.ts`) | **Gap:** Unbenchmarked multi-query checkout; missing cart pre-validation | **Gap:** Shared `max: 20` PG pool unmeasured under burst load | `statement_timeout: 15s`; 5-min reservation TTL | Ordered `SELECT ... FOR UPDATE` on `store_inventory` + `chk_reserved_le_stock` | `503` on DB unavailable; Bloom filter on read catalog paths |
| **Payments & Cancellation** | Payment initiation & webhook rate limiters | **P0 Gap:** `cancellationService` runs gateway HTTP + retry sleep **inside** `orders FOR UPDATE` txn! | Payment/refund queues rely on `outbox_events` & recovery worker leases | Payment recovery timeout + exponential backoff (`5s`–`60s`) | `orders` & `payment_intents` `FOR UPDATE`; `webhook_events` lock; `transaction_id UNIQUE` | Outbox backlog threshold metrics (`outboxService.ts:335`), recovery `LIMIT 25` batching |
| **Dispatch & Logistics** | Dispatch action & rider telemetry limiters (120/min) | **Gap:** Geo scoring runs inside TX without road API latency budget (currently Haversine) | Redis GEO fast spatial lookup (when populated) | 30s/configurable dispatch offer expiry + background reaper | Partial unique PG indexes (`idx_active_dispatch_assignment`, `idx_active_rider_offer`) + row locks | Dispatch candidate limit (`LIMIT` top candidates) |
| **Settlements & Payouts** | Settlement action limiter | Dual-tx payout pattern avoids holding lock during mock call | Single `max: 20` pool shared with OLTP orders (**risk under batch runs**) | Payout HTTP client timeout (**missing** — provider is stub) | `merchants`/`riders` `FOR UPDATE` + `idempotency_key` unique indexes | Recovery worker processes `LIMIT 25` stuck `PROCESSING` payouts |
| **Notifications & Realtime** | General API limiters | WebSocket in-memory/Redis pub/sub fast broadcast | Campaign `executeCampaign` uses hardcoded `LIMIT 500` cursorless slice (**gap**) | N/A (FCM HTTP client missing) | `dedupe_key UNIQUE` on `notification_deliveries` | **Gap:** Synchronous loop over 500 users inside HTTP `POST /execute` request instead of async worker queue! |

---

## 10. External Integrations Readiness Inventory

| Integration | Code Exists | Credentials Configured | Sandbox Tested | Live Tested | Failure Handling |
|---|---|---|---|---|---|
| **Payment Gateway (Razorpay / Cashfree)** | Partial (`RazorpayPaymentProvider` is an in-memory Map stub; interface & webhook flow ready) | Absent (`PAYMENT_MODE=mock` in CI, `none` in prod) | **No** (stub only) | **No** | Good design (`RECONCILIATION_REQUIRED` + worker), unverified with real API timeouts/codes |
| **Payout Gateway (RazorpayX / Cashfree Payouts)** | Partial (`payoutProvider.ts` interface + dual-tx recovery exists; prod constructor **throws**) | Absent | **No** | **No** | Dual-tx ambiguous `PROCESSING` protection good; zero real HTTP adapter |
| **SMS / OTP Telephony (Twilio / Exotel / MSG91)** | Partial (`otpProvider.ts` interface exists; `ProductionSmsProvider` **throws**) | Absent (`TELEPHONY_MODE=mock`) | **No** | **No** | No fallback/secondary SMS vendor failover |
| **Push Notifications (FCM / APNs)** | Partial (`pushProvider.ts` `FcmPushProvider` **is a synthetic stub** returning fake IDs) | Optional (`FCM_SERVICE_ACCOUNT` absent) | **No** | **No** | Deactivates invalid tokens on error flags; zero real FCM HTTP v1 dispatch |
| **WhatsApp Business API** | **No** | Absent | **No** | **No** | Missing entirely |
| **Email Provider (SES / SendGrid / Postmark)** | **No** | Absent | **No** | **No** | Missing entirely (no GST invoice email delivery) |
| **Maps / Routing / Geocoding** | Partial (`routingService.ts` pure Haversine × 1.25 math; no external API client) | Absent | **No** | **No** | Redis route caching implemented; zero external Maps API fallback |
| **KYC / PAN / GSTIN / Bank Verification** | **No** (DB columns only; `bank_verified` never auto-verified) | Absent | **No** | **No** | Missing entirely |
| **GST e-Invoicing (NIC IRP / GSP)** | **No** (`invoiceService.ts` generates fake SHA-256 IRN hashes) | Absent | **No** | **No** | Missing entirely |
| **Customer OAuth** | **No** | Absent | **No** | **No** | Missing (optional if Phone OTP suffices) |
| **Cloud Storage & CDN (Invoices/POD/KYC)** | **No** (`pdfGenerator` returns raw string; `contactless_photo_url` has no S3 pre-sign route) | Absent | **No** | **No** | Missing entirely |
| **Observability / Monitoring (Sentry / Metrics)** | **No** (`/health` & `/ready` only) | Absent | **No** | **No** | Console-only error logs |

---

## 11. Summary of Prioritized Findings & Final Classification

- **P0 Findings (8 Confirmed):** `F-15.6-P0-01` (Prod boot crash on OTP/Payout/Push providers), `F-15.6-P0-02` (Stub Razorpay payment provider), `F-15.6-P0-03` (Partner delivery `verify-otp` skips settlement, rider ledger, COD cash, state checks & rider reset), `F-15.6-P0-04` (Cancellation external refund HTTP+sleep inside `FOR UPDATE` txn), `F-15.6-P0-05` (Immediate self-serve payout without return hold, `is_payout_held`, bank verification, or caps), `F-15.6-P0-06` (Fake admin refund stubs & naive 85% settlement display), `F-15.6-P0-07` (Coupon `usage_limit` unvalidated/unincremented + `/promotions/create` column error + SGST typo), `F-15.6-P0-08` (Zero automated PG backups / WAL PITR / restore tests).
- **P1 Findings (11 Confirmed):** Missing persistent carts (`P1-01`); missing merchant/rider self-onboarding & KYC (`P1-02`); unenforced store radius & operating hours + `items[0]` auto-merchant & `fulfilmentSelectionService` precedence bug (`P1-03`); missing seller catalog/price CRUD & admin stock/seller no-op stubs (`P1-04`); `Math.random()` delivery OTP (`P1-05`); return refund tax/discount & `payment_status` gaps + reverse pickup overwriting forward `delivery_trips` (`P1-06`); GST/invoice plain-text PDF, fake IRN, `'29'` place-of-supply, static `base_prep_mins` delay penalty, missing credit notes (`P1-07`); `/employees/create` null password + missing fraud enforcement, support tickets, DPDP consent/deletion (`P1-08`); Haversine routing, `NULL` rider GPS fallback to store, mid-trip offline guard (`P1-09`); missing `ioredis` in backend `package.json`, fail-closed Redis SPOF, zero structured logging/Sentry/Prometheus (`P1-10`); `pg-mem` test false confidence (`P1-11`).
- **P2 / P3 Findings:** Missing product variants/brand taxonomy/barcodes (`P2`), synchronous 500-user campaign loop (`P2`), silent `auditService` failure swallow (`P2`), `zod` version drift (`P2`), missing financial/GSTR CSV export (`P2`), ratings & reviews (`P3`), OAuth login (`P3`), `save()`/wishlist features (`P3`).

### Final Verdict
**Classification: `NOT READY FOR REAL TRANSACTIONS`**
QCOM cannot go live with real payments, real merchants, or real riders until Stage A (External Providers, Delivery-to-Ledger/COD Closure, Financial Controls, Transaction Isolation, Pricing/Coupon Fixes, and Managed DB Backups/DR) is implemented and verified against live sandboxes and real PostgreSQL 16 + Redis 7.
