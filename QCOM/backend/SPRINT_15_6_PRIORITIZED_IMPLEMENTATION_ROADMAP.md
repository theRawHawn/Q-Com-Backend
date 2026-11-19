# SPRINT 15.6 — PRIORITIZED IMPLEMENTATION ROADMAP

**Project:** QCOM (`QCOM/backend`)
**Baseline Commit SHA:** `c384268da1d0f24a93aaf86215b18ead5a56b1fa`
**Design Goal:** Shortest realistic, dependency-ordered path to a safe local-merchant quick-commerce pilot and public launch—without rebuilding working auth, inventory locking, or double-entry ledger foundations, and without assuming dark stores or microservices.

---

## Roadmap Overview by Launch Gate

| Stage | Target Gate | Proposed Sprints |
|---|---|---|
| **A. Mandatory before real-money transactions** | Zero real-money processing allowed before completion | **Roadmap Sprint 1** (Real Payment, Payout, OTP & Push Adapters + Env/Backup Readiness)<br>**Roadmap Sprint 2** (Delivery-to-Settlement, COD Ledger, Cancellation Isolation & Financial Controls)<br>**Roadmap Sprint 3** (Pricing Tax/Coupon Fixes, Order State Machine & Admin Financial Unification) |
| **B. Mandatory before merchant onboarding** | External local stores cannot self-onboard or manage live stores safely before completion | **Roadmap Sprint 4** (Merchant/Rider Self-Onboarding, KYC/Bank Verification, Store Hours/Radius & Seller Catalog CRUD) |
| **C. Mandatory before delivery partner onboarding** | Independent fleet cannot operate safely in live zones before completion | *(Bundled across **Roadmap Sprint 2** [COD/state reset/OTP CSPRNG/GPS guard] & **Roadmap Sprint 4** [Rider KYC/Documents/Maps Routing])* |
| **D. Mandatory before limited pilot** | Cannot run live controlled pilot with real customers & cloud infra before completion | **Roadmap Sprint 5** (Persistent Carts, Compliant PDF Invoices/Credit Notes, Reverse Trips, Standalone Packaging & Observability/DR) |
| **E. Mandatory before public launch** | Cannot scale publicly or pass compliance/support demands before completion | **Roadmap Sprint 6** (Support Ticketing, Fraud Rules Enforcement, DPDP Privacy/Deletion & Performance/Load Benchmarking) |
| **F. Post-launch improvements** | Growth & ecosystem expansion after stable public operations | **Roadmap Sprint 7** (Catalog Variants/Auto-Spare-Parts Fitment Taxonomy, GSTR/TDS Reports, Consumer OAuth, Ratings & Reviews) |

---

## STAGE A: MANDATORY BEFORE REAL-MONEY TRANSACTIONS

### Roadmap Sprint 1 — External Payment, Payout, OTP & Push Adapters (Stage A)
1. **Sprint title:** Real Payment Gateway, Payout Disbursement, OTP Telephony & FCM Push Adapters
2. **Business objective:** Enable `QCOM/backend` to boot cleanly in `NODE_ENV=production` and execute real customer payments, refunds, bank payouts, SMS OTP logins, and push notifications via sandbox-verified third-party APIs.
3. **Problem being solved:** `otpProvider.ts`, `payoutProvider.ts`, and `pushProvider.ts` crash or stub out in `NODE_ENV=production`; `RazorpayPaymentProvider` is an in-memory `Map` stub (`F-15.6-P0-01`, `F-15.6-P0-02`).
4. **Concrete defects or gaps:** `F-15.6-P0-01`, `F-15.6-P0-02`. Missing HTTP clients for Razorpay/Cashfree Payments, RazorpayX/Cashfree Payouts, Twilio/Exotel/MSG91 SMS, and Firebase Admin SDK HTTP v1 push.
5. **Proposed implementation:** Implement real provider adapters behind the existing clean interfaces (`PaymentProvider`, `IPayoutProvider`, `OtpProvider`, `IPushProvider`); wire strict HTTP timeouts (`5s–10s`), raw-body webhook signature verification against real gateway headers, and sandbox env validation without throwing at module import when properly configured.
6. **Files/modules likely involved:** `src/modules/payments/provider/paymentProviderRegistry.ts`, `src/modules/payments/paymentProvider.ts`, `src/modules/settlements/payoutProvider.ts`, `src/modules/auth/otpProvider.ts`, `src/modules/notifications/pushProvider.ts`, `src/config/env.ts`, `QCOM/backend/package.json`.
7. **Database changes likely required:** None (provider fields `provider_order_id`, `provider_payment_id`, `provider_payout_id`, `utr_number` already exist in migrations `012`, `015`, `022`).
8. **API changes likely required:** None to existing endpoints (`/api/v1/payments/*`, `/api/v1/auth/otp/*`); webhook handler verified against live Razorpay/Cashfree payload structure.
9. **Tests required:** Live Sandbox integration test suite (non-mocked test mode keys) covering order creation, test-card/UPI capture, signed webhook replay, refund initiation, payout status fetch, SMS delivery, and FCM token invalidation handling.
10. **Security impact:** Eliminates production mock-provider leakage and enforces real cryptographic webhook HMAC validation + secret isolation.
11. **Financial impact:** Prerequisite to move real INR safely through gateway escrow, refunds, and payouts without synthetic `'SUCCEEDED'` false positives.
12. **Dependencies:** External merchant/vendor account activation & sandbox keys (Deliverable 5: Razorpay, RazorpayX, Exotel/Twilio, Firebase).
13. **Definition of done:** Backend starts with `NODE_ENV=production` cleanly; real sandbox payment + webhook + refund + payout + SMS OTP + FCM push verified end-to-end against real PG 16 + Redis 7.
14. **Risk if deferred:** Zero transactions possible in production; process crashes on startup or silently fakes financial captures.

---

### Roadmap Sprint 2 — Delivery-to-Settlement, COD Ledger, Cancellation Isolation & Payout Controls (Stage A)
1. **Sprint title:** Delivery-to-Settlement Pipeline, COD Accounting, Cancellation Tx Isolation & Financial Safeguards
2. **Business objective:** Guarantee that every delivered order posts atomic seller/rider/COD ledgers, cancellations never stall DB pools behind external gateway HTTP calls, and sellers cannot drain platform funds via instant unverified withdrawals.
3. **Problem being solved:** `partnerCompatibilityRoutes` bypasses settlements/COD/rider idle reset (`F-15.6-P0-03`), `cancellationService` runs gateway HTTP+sleeps inside a `FOR UPDATE` DB txn (`F-15.6-P0-04`), and self-serve payouts lack cooling-off holds, merchant hold flags, or approval limits (`F-15.6-P0-05`), plus `F-15.6-P1-05` (`Math.random()` OTP) & `F-15.6-P1-09` (rider NULL GPS/mid-trip offline).
4. **Concrete defects or gaps:** `F-15.6-P0-03`, `F-15.6-P0-04`, `F-15.6-P0-05`, `F-15.6-P1-05`, `F-15.6-P1-09`.
5. **Proposed implementation:**
   - Unify delivery completion into a single service called by both `partnerCompatibilityRoutes.ts` and `deliveryRoutes.ts`: enforce trip state transition under `FOR UPDATE`, compute actual prep duration vs SLA (`storeDelayPenalty` fix), post `settlementAllocationService.allocateFulfilledOrder()`, credit `rider_ledgers`/`riders.wallet_balance`, post COD cash to `riders.floating_cash_balance` + `ledgerService.recordCodCollection` + `orders.payment_status = 'PAID'`, and reset `riders.status = 'IDLE_AT_HUB'`.
   - Refactor `cancellationService.ts` + `refundService.ts` so `FOR UPDATE` DB txn commits `refunds (status = 'REQUESTED')` + `outbox_events` and triggers external gateway refund HTTP strictly **post-commit**; add `actor_id` check to `cancellationService` idempotency SELECT.
   - Enforce T+N return-window `withdrawable_after` hold on `seller_ledgers`, add `merchants.is_payout_held` + `bank_verified = TRUE` check, and enforce per-payout limits/admin dual approval; replace `Math.random()` with `crypto.randomInt`; exclude `NULL`/stale rider GPS from `candidateGenerator` & add rider cash-reconciliation endpoint.
6. **Files/modules likely involved:** `src/routes/partnerCompatibilityRoutes.ts`, `src/routes/deliveryRoutes.ts`, `src/routes/settlementRoutes.ts`, `src/modules/orders/{orderService.ts,cancellationService.ts}`, `src/modules/payments/refundService.ts`, `src/modules/settlements/{settlementAllocationService.ts,sellerSettlementService.ts,riderPayoutService.ts}`, `src/modules/dispatch/candidateGenerator.ts`.
7. **Database changes likely required:** New migration `028`: `merchants.is_payout_held BOOLEAN DEFAULT FALSE`, `merchants.payout_hold_reason TEXT`, `seller_ledgers.withdrawable_after TIMESTAMPTZ`, `delivery_trips.otp_attempts INT DEFAULT 0`, index on active orders/holding rules.
8. **API changes likely required:** Add `POST /api/v1/admin/riders/:riderId/reconcile-cash`; restrict/harden `POST /api/v1/settlements/seller/payout` to mature verified balances only; add admin seller hold/unhold endpoint.
9. **Tests required:** Real PG 16 end-to-end tests: pickup->deliver->allocation->COD cash->ledger trial balance; concurrent cancellation under simulated 3s gateway delay verifying DB lock duration `<50ms`; immature/unverified/held seller payout rejection; rider NULL GPS exclusion.
10. **Security impact:** Eliminates brute-force `Math.random` delivery OTP, closes `cancellationService` cross-actor idempotency hole, blocks mid-trip rider status manipulation.
11. **Financial impact:** Closes unrecorded COD theft vector, guarantees sellers & riders get credited once per delivery, eliminates unrecoverable payout drain before return/refund disputes.
12. **Dependencies:** Builds cleanly on existing `ledgerService.ts` (Sprint 15.5) and external adapters (Roadmap Sprint 1).
13. **Definition of done:** Every delivery test path leaves `assertOrderLedgerBalanced() === true` and `verifyTrialBalance().balanced === true`; 0 external HTTP calls inside DB transactions; payout hold & COD reconciliation verified on real PG 16.
14. **Risk if deferred:** Immediate cash leakage (untracked COD, unrecoverable premature seller withdrawals), connection-pool outages under slow gateway refunds, stranded riders.

---

### Roadmap Sprint 3 — Pricing/Coupon Integrity, Order State Machine & Admin Financial Unification (Stage A)
1. **Sprint title:** Pricing/Coupon Safeguards, Unified Order State Machine & Real Admin Financial Wiring
2. **Business objective:** Stop uncapped coupon abuse and tax calculation errors, enforce strict order/trip transitions under lock, and replace misleading admin compatibility stubs with real DB-backed financial operations.
3. **Problem being solved:** Pricing SGST typo, unvalidated/unincremented `usage_limit`, broken `POST /promotions/create` SQL columns (`F-15.6-P0-07`), fake admin `/refunds/*` & naive 85% `/settlements` math (`F-15.6-P0-06`), missing unified order state machine guard, `POST /employees/create` null password (`F-15.6-P1-08`).
4. **Concrete defects or gaps:** `F-15.6-P0-06`, `F-15.6-P0-07`, `F-15.6-P1-08` (admin employees creation), missing `orderStateMachine.ts`.
5. **Proposed implementation:**
   - Fix `pricingEngine.ts` `totalSgstBn` typo (`qcomSgstBn`), add atomic `usage_count < usage_limit` check + increment + `coupon_redemptions` per-user limit inside checkout txn; fix `POST /promotions/create` column names (`description`, `min_order_value_inr`, `max_discount_inr`, `valid_from`, `valid_to`).
   - Create centralized `orderStateMachine.ts` (mirroring `paymentStateMachine.ts`) and enforce it inside `orderService`, `deliveryRoutes`, `partnerCompatibilityRoutes`, `cancellationService`, `returnService` under `FOR UPDATE`.
   - Replace `adminCompatibilityRoutes.ts` stub handlers (`GET /settlements`, `POST /refunds/*`, `POST /employees/create`) with real queries on `order_settlement_allocations`/`seller_ledgers`, `refundService.ts` delegation (with role/amount limits), and `authService.hashPassword()` (or invite flow).
6. **Files/modules likely involved:** `src/modules/pricing/pricingEngine.ts`, `src/modules/orders/orderService.ts`, new `src/modules/orders/orderStateMachine.ts`, `src/routes/adminCompatibilityRoutes.ts`, `src/routes/partnerCompatibilityRoutes.ts`, `src/routes/settlementRoutes.ts`.
7. **Database changes likely required:** New migration `029`: `coupon_redemptions (id, coupon_id, user_id, order_id, redeemed_at, UNIQUE(coupon_id, user_id, order_id))` + optional `per_user_limit INT DEFAULT 1` on `coupons`.
8. **API changes likely required:** `POST /admin/employees/create` requires password or generates one-time activation setup; `/admin/refunds/*` enforces real state and returns real `refunds` rows.
9. **Tests required:** Real PG concurrent coupon exhaustion test (50 parallel requests for `usage_limit = 5` -> exactly 5 succeed); illegal order state jump tests (`ACCEPTED -> DELIVERED` rejected with `409`); admin `/promotions/create`, `/employees/create`->login, `/settlements` accuracy, and `/refunds/*` persistence assertions.
10. **Security impact:** Eliminates unusable null-password admin accounts and invalid state bypasses.
11. **Financial impact:** Prevents infinite coupon cash drain, guarantees accurate SGST tax math, stops admins from acting on fabricated 85% settlement estimates or fake refund confirmations.
12. **Dependencies:** Parallelizable with Roadmap Sprint 2; zero external vendor blockers.
13. **Definition of done:** All compatibility stubs touching money/auth eliminated or wired to real services; coupon concurrency & order state-machine suite passes on real PG 16.
14. **Risk if deferred:** Unlimited promotional loss, admins silently failing to issue refunds, wrong merchant settlement figures.

---

## STAGE B & C: MANDATORY BEFORE MERCHANT & DELIVERY PARTNER ONBOARDING

### Roadmap Sprint 4 — Merchant & Rider Onboarding, KYC Verification, Store Rules, Catalog CRUD & Real Maps Routing (Stage B + C)
1. **Sprint title:** Self-Serve Merchant/Rider KYC Onboarding, Store Hours/Radius Enforcement, Seller Catalog CRUD & Real Maps Routing
2. **Business objective:** Safely onboard independent local hardware merchants and delivery partners with verified bank/KYC credentials, enforce real store hours & delivery zones, allow sellers to manage their products/prices via API, and replace straight-line ETA/mapping with real road routing.
3. **Problem being solved:** Zero registration/KYC/bank-verification workflows (`F-15.6-P1-02`), unenforced `service_radius_meters`/`operating_hours`/`items[0]` checkout bug/`tradeCategories` hardcode/`fulfilmentSelectionService` precedence bug (`F-15.6-P1-03`), missing seller catalog/price CRUD & admin stock/seller no-ops (`F-15.6-P1-04`), Haversine routing (`F-15.6-P1-09`), plus missing S3 pre-signed upload for KYC/POD photos.
4. **Concrete defects or gaps:** `F-15.6-P1-02`, `F-15.6-P1-03`, `F-15.6-P1-04`, `F-15.6-P1-09`.
5. **Proposed implementation:**
   - Add onboarding & KYC routes (`POST /merchants/register`, `POST /riders/register`, document upload pre-signed URLs via S3/GCS, KYC/PAN/GSTIN/bank penny-drop provider interface), enforcing `bank_verified = TRUE` & `kyc_status = 'GREEN'` before `ACTIVE` approval or payouts.
   - Enforce `merchants.status = 'ACTIVE'`, `is_online`, `is_paused`, `merchant_stores.operating_hours_start/end` (IST timezone), distance `<= service_radius_meters`, and **full-cart** inventory check in `orderService.ts`/`pricingEngine.ts`. Fix `fulfilmentSelectionService.ts:127` operator precedence and DB-back `tradeCategories`.
   - Add authenticated seller catalog CRUD (`/api/v1/merchants/:merchantId/catalog`, price/MRP validation, archive toggle); fix `PUT /admin/sellers/:id` & `POST /admin/inventory/:id/adjust-stock` to mutate DB atomically.
   - Integrate Distance Matrix / Directions API (Google Maps or OSRM/MapMyIndia) with Redis caching inside `routingService.ts`.
6. **Files/modules likely involved:** New `src/routes/onboardingRoutes.ts`, `src/routes/catalogRoutes.ts`, `src/modules/kyc/`, `src/modules/routing/routingService.ts`, `src/modules/sellers/sellerService.ts`, `src/modules/catalog/catalogService.ts`, `src/modules/orders/orderService.ts`, `src/modules/pricing/pricingEngine.ts`, `src/modules/delivery/fulfilmentSelectionService.ts`, `src/routes/adminCompatibilityRoutes.ts`.
7. **Database changes likely required:** New migration `030`: `merchant_kyc_documents`, `rider_documents`, `merchant_trade_categories` (replacing hardcoded array), plus indexes on spatial/serviceability fields.
8. **API changes likely required:** Onboarding/KYC endpoints, Seller catalog CRUD endpoints, S3 pre-signed upload endpoint for KYC & POD photos.
9. **Tests required:** Multi-store cart checkout rejection when store is closed / out of radius / missing item 2; seller catalog isolation & price bounds tests; KYC state gate blocking unverified merchant activation/payouts; real road-distance mock/sandbox test.
10. **Security impact:** Prevents unauthorized sellers from accessing another merchant's catalog/prices (`requireMerchantOwnership`), authenticates KYCs & verified bank accounts before payout eligibility.
11. **Financial impact:** Prevents payouts to unverified bank accounts and prevents unfulfillable cross-city delivery fee under-quotes from Haversine inaccuracies.
12. **Dependencies:** External KYC/Penny-drop provider, Cloud Object Storage (S3/GCS), Maps API key (Deliverable 5).
13. **Definition of done:** External merchant & rider can register, upload KYC/bank proof, get verified/approved, configure store hours/catalog/prices, and accept orders only within serviceable radius/hours.
14. **Risk if deferred:** Cannot legally/safely onboard third-party merchants or riders; orders routed to closed shops or wrong-distance fees.

---

## STAGE D: MANDATORY BEFORE LIMITED PILOT

### Roadmap Sprint 5 — Persistent Cart, Compliant GST Invoices/Credit Notes, Reverse Trips, Packaging & Observability/Backup DR (Stage D)
1. **Sprint title:** Persistent Server Cart, Real PDF Invoices & Credit Notes, Reverse-Pickup Trips, Packaging Fix & Cloud Observability/DR
2. **Business objective:** Provide seamless cart recovery, compliant PDF tax documents/credit notes, safe reverse logistics for returns, standalone deployment packaging, and production monitoring + verified database recovery before admitting pilot customers.
3. **Problem being solved:** Missing `carts` (`F-15.6-P1-01`), return tax/discount proration & `payment_status` & `delivery_trips UNIQUE(order_id)` collision (`F-15.6-P1-06`), plain-text PDFs/fake IRN/hardcoded `'29'`/`'2026-27'`/static delay penalty/missing Credit Notes (`F-15.6-P1-07`), missing `ioredis` in backend `package.json`/fail-closed Redis SPOF/zero structured logs & alerts (`F-15.6-P1-10`), zero automated backups/PITR tests (`F-15.6-P0-08`).
4. **Concrete defects or gaps:** `F-15.6-P0-08`, `F-15.6-P1-01`, `F-15.6-P1-06`, `F-15.6-P1-07`, `F-15.6-P1-10`.
5. **Proposed implementation:**
   - Add `carts` + `cart_items` tables & `/api/v1/cart` routes (single-merchant guard, live price/stock sync).
   - Add `trip_type ('FORWARD'|'REVERSE_PICKUP')` to `delivery_trips`, changing uniqueness from `(order_id)` to `(order_id, trip_type)` so returns create independent reverse-pickup trips; fix return refund proration across item GST + discounts and update `orders.payment_status`.
   - Fix `placeOfSupplyStateCode` from customer address/GSTIN state code; fix `settlementAllocationService.ts` `isInterState` TCS computation & dynamic FY; implement real `jspdf` binary PDF rendering + state lookup table + GST Credit Notes on returns (gating NIC IRP e-Invoice behind configurable turnover/feature flag).
   - Add `ioredis` & align `zod` in `QCOM/backend/package.json`; add `pino` structured JSON logging, Prometheus `/metrics` (or OTel), Sentry error tracking, outbox/webhook/reconciliation alert hooks; provision Redis HA + Managed PG 16 PITR + run and document a live staging backup-restore test.
6. **Files/modules likely involved:** `QCOM/backend/package.json`, `src/modules/invoices/{invoiceService.ts,pdfGenerator.ts}`, `src/modules/orders/{orderService.ts,returnService.ts}`, `src/modules/dispatch/dispatchService.ts`, `src/modules/settlements/settlementAllocationService.ts`, `src/app.ts`, `src/server.ts`, `src/modules/audit/auditService.ts` (propagate alert on audit failure).
7. **Database changes likely required:** New migration `031`: `carts`, `cart_items`, `credit_notes` (or `invoices.document_type` `'TAX_INVOICE'|'CREDIT_NOTE'`), `delivery_trips` `trip_type` + updated unique constraint.
8. **API changes likely required:** `/api/v1/cart/*`, `GET /api/v1/orders/:id/credit-note`, `/metrics` (internal/admin-protected).
9. **Tests required:** Cart single-merchant & price-change revalidation tests; reverse-pickup trip creation leaving forward POD trip intact; return proportional GST refund test; real PDF binary header (`%PDF-`) test; standalone `npm --prefix QCOM/backend ci && npm --prefix QCOM/backend run build` test; staged backup restore drill verification.
10. **Security impact:** Structured audit/alerting eliminates silent blind spots; backup encryption protects PII at rest.
11. **Financial impact:** Accurate return refunds, legally valid GST invoices & Credit Notes, and recoverable financial ledger under catastrophic DB failure.
12. **Dependencies:** Managed PG 16 + Managed Redis 7 HA + Off-site encrypted S3 bucket + Sentry/Monitoring workspace; CA validation of Credit Note & TCS intra/inter-state logic.
13. **Definition of done:** Backend builds/runs standalone cleanly without root `node_modules`; binary PDF invoices & credit notes generated; backup restore drill passes RTO/RPO SLA; pilot monitoring alerts verified.
14. **Risk if deferred:** Corrupted forward trip histories on returns, unrecoverable ledger loss in DB incident, standalone Docker deploy failure, non-compliant customer tax bills.

---

## STAGE E: MANDATORY BEFORE PUBLIC LAUNCH

### Roadmap Sprint 6 — Support Ticketing, Fraud Rule Engine, DPDP Consent/Deletion & Load Benchmarking (Stage E)
1. **Sprint title:** Customer/Merchant/Rider Support System, Active Fraud Controls, DPDP Privacy Workflows & Scale Benchmarking
2. **Business objective:** Equip operations with real ticketing/disputes, enforce anti-abuse fraud protections (COD/returns/bot protection), fulfill India DPDP data access/erasure requirements while retaining statutory tax records, and establish measured latency/throughput capacity limits before opening public traffic.
3. **Problem being solved:** Static mocked `/admin/support/tickets` & `/disputes`, non-functional `/customers/:id/fraud-controls` & `/notes` (`F-15.6-P1-08`), WhatsApp/Email communication channels missing, zero DPDP consent/export/anonymization pipeline, zero load/stress benchmarks (`F-15.6-P1-11` / Section 15).
4. **Concrete defects or gaps:** `F-15.6-P1-08`, plus missing WhatsApp/Email transactional notification adapters, async campaign batch worker, runtime feature flags / emergency kill-switch, and performance benchmarks.
5. **Proposed implementation:**
   - Create `support_tickets`, `ticket_messages`, `customer_notes`, and `customer_fraud_flags` tables; wire `/api/v1/support/*` & `/api/v1/admin/support/*` & `/disputes/*` with SLA tracking and strict separation so support staff use audited workflow approvals rather than raw ledger writes; enforce `cod_blocked`/`account_hold` in `orderService.ts`.
   - Implement `user_consents` versioned ledger, `/api/v1/customers/me/export`, and account deletion/anonymization job (scrubbing PII from `users`/`saved_addresses`/`notification_deliveries` while retaining anonymized `orders`/`invoices`/`general_ledger_entries` tax/audit records).
   - Integrate Email (SES/Postmark) + WhatsApp Business API notification channels + move `campaignService.executeCampaign` batching off HTTP request into background worker + replace static `/admin/cities` & `/service-areas` stubs + add runtime feature flags/kill-switches.
   - Run k6/Artillery non-destructive load benchmarks on staging PG 16 + Redis 7 measuring p50/p95/p99 latency, connection pool sizing (`max: 20` vs PgBouncer), and hot-SKU checkout contention.
6. **Files/modules likely involved:** New `src/modules/support/`, `src/modules/privacy/`, `src/modules/notifications/{emailProvider.ts,whatsappProvider.ts,campaignService.ts}`, `src/routes/{customerRoutes.ts,adminCompatibilityRoutes.ts}`, `src/modules/orders/orderService.ts`.
7. **Database changes likely required:** New migration `032`: `support_tickets`, `ticket_messages`, `customer_fraud_flags`, `customer_notes`, `user_consents`, `account_deletion_requests`, `service_areas`, `feature_flags`.
8. **API changes likely required:** `/api/v1/support/tickets`, `/api/v1/customers/me/consents`, `/export`, `/delete-account`, `/api/v1/admin/feature-flags`, working `/admin/support/tickets` & `/customers/:id/fraud-controls`.
9. **Tests required:** Fraud-blocked user rejected on COD checkout; DPDP deletion scrubs PII while keeping `verifyTrialBalance().balanced === true`; support RBAC permissions tests; k6/Artillery load benchmark report.
10. **Security impact:** Blocks COD/coupon/return fraud rings, adds CAPTCHA/Turnstile risk option on OTP, protects personal data lifecycle per DPDP principles.
11. **Financial impact:** Prevents scaled COD & return abuse losses; eliminates support-team manual financial tampering risk.
12. **Dependencies:** Email/WhatsApp vendor verification, Privacy Policy / DPDP legal review, Staging load-test environment.
13. **Definition of done:** Support ticketing, fraud enforcement, DPDP export/erasure, and WhatsApp/Email live-tested; staging load benchmark confirms SLA targets under expected public traffic.
14. **Risk if deferred:** High fraud losses during public growth, unmanageable customer complaint backlog, regulatory exposure under DPDP, unknown crash threshold at launch traffic spike.

---

## STAGE F: POST-LAUNCH IMPROVEMENTS

### Roadmap Sprint 7 — Catalog Variants & Auto-Parts Fitment Taxonomy, Statutory Tax Report Exports, Customer OAuth & Ratings (Stage F)
1. **Sprint title:** Product Variants/Barcodes/Specialty Taxonomy, GSTR/TDS Exports, Ratings & Consumer OAuth
2. **Business objective:** Expand QCOM beyond single-SKU hardware items into variant-heavy categories (e.g., automobile spare parts with vehicle fitment, sizes/voltages, brands, and EAN barcodes), automate monthly GST/TDS accounting exports, and add post-delivery ratings + social login.
3. **Problem being solved:** Missing `product_variants`/`brands`/`barcodes`, missing SQL full-text/trigram catalog search, missing downloadable GSTR-1/GSTR-8/Form 26Q CSV exports, missing customer ratings/reviews & OAuth.
4. **Concrete defects or gaps:** Catalog normalization gaps (Section 6A), tax filing export gaps (Section 9), P3 Customer features (`OAuth`, `Ratings & Reviews`).
5. **Proposed implementation:** Add `brands`, `categories`, `product_variants`, `barcodes`, and flexible `compatibility_tags` / GIN-indexed search (`pg_trgm` / `tsvector`); build async financial/GST export endpoints (`/api/v1/admin/reports/gstr8`, `/tds-26q`, `/settlement-csv`) outputting signed S3 download links; add `order_reviews` (updating merchant/rider ratings) and optional Google OAuth login.
6. **Files/modules likely involved:** `src/modules/catalog/`, `src/routes/pricingRoutes.ts`, `src/modules/invoices/`, `src/routes/settlementRoutes.ts`, `src/routes/authRoutes.ts`, `src/routes/customerRoutes.ts`.
7. **Database changes likely required:** New migration `033`: `brands`, `product_variants`, `product_compatibility`, `order_reviews`, GIN/trigram search indexes on `products`.
8. **API changes likely required:** `/api/v1/catalog/search`, `/api/v1/orders/:id/review`, `/api/v1/admin/reports/tax-export`, `/api/v1/auth/oauth/*`.
9. **Tests required:** Multi-variant SKU inventory reservation tests, tax export reconciliation totals matching `general_ledger_entries`, review authorization tests (delivered owner only).
10. **Security impact:** Validate OAuth PKCE/state tokens; enforce export RBAC (`finance.export`).
11. **Financial impact:** Reduces manual CA/finance reconciliation overhead as monthly transaction volume grows.
12. **Dependencies:** Stage E live launch & CA template confirmation for Tally/GSTR export formats.
13. **Definition of done:** Multi-variant catalog search <100ms, monthly tax CSVs match GL totals to the paisa, ratings flow live.
14. **Risk if deferred:** Low launch risk; affects scale efficiency and expansion into auto spare parts/apparel/electronics rather than core trade hardware MVP.
