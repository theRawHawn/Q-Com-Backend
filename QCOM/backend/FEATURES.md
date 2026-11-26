# QCOM Platform — Feature Matrix & Implementation Status (FEATURES)

| Feature Domain | Capability | Status | Implementation Evidence |
| :--- | :--- | :--- | :--- |
| **Authentication** | Phone OTP Authentication | **IMPLEMENTED** | `src/modules/auth/authService.ts`, `src/routes/authRoutes.ts` |
| **Authentication** | Session Management & Logout | **IMPLEMENTED** | `auth_sessions` table, active revocation endpoint |
| **Authentication** | Scrypt Password Hashing & DoS Bounds | **IMPLEMENTED** | `src/modules/auth/crypto.ts`, standard crypt `$scrypt$N=16384,r=8,p=1$` |
| **Authentication** | Account Lockout Protection | **IMPLEMENTED** | 5 failed attempts = 15m lockout on `users.password_locked_until` |
| **Authentication** | Per-Challenge OTP Salt & Concurrency | **IMPLEMENTED** | Migration 024 (`otp_challenges.salt`), `FOR UPDATE` single-use consumption |
| **RBAC** | Multi-Role & Tenant Isolation | **IMPLEMENTED** | `src/modules/rbac/rbacService.ts`, permission guards |
| **Catalog** | Geofenced Product Browsing | **IMPLEMENTED** | `src/routes/pricingRoutes.ts`, coordinate bounding |
| **Pricing Engine** | Decimal-Safe Indian GST, Cess & Dynamic POS | **IMPLEMENTED** | `src/modules/pricing/taxEngine.ts`, `money.ts` (`bignumber.js`), `indian_states`, `tax_inclusive`/`tax_exclusive`, fail-closed `422` |
| **Pricing Engine** | Concurrency-Safe Coupons & Promotions | **IMPLEMENTED** | `couponPromotionService.ts`, `FOR UPDATE` slots, `CART_SLAB`/`BOGO`/`FREE_DELIVERY`, conflict groups, `SELLER`/`PLATFORM`/`SHARED` splits |
| **Pricing Engine** | DB Cart & Checkout Price-Drift Guard | **IMPLEMENTED** | `cartService.ts` (`/api/v1/cart`), `409 PRICE_CHANGED` / `QUOTE_EXPIRED` in `orderService.ts` |
| **Invoices & Returns** | GST Credit Notes & Prorated Return Refunds | **IMPLEMENTED** | `invoiceService.ts`, `returnService.ts` (`credit_notes` against `line_total_payable`, dynamic Apr–Mar FY) |
| **Inventory** | Selective Stock Reservation | **IMPLEMENTED** | `inventory_reservations` table with expiration TTL |
| **Inventory** | Zero-Oversell Serialization | **IMPLEMENTED** | Row-level locks (`SELECT ... FOR UPDATE`), check constraints |
| **Inventory** | Back-in-Stock Alerts | **IMPLEMENTED** | Outbox events, `stockNotificationConsumer.ts` |
| **Orders** | Full Order Lifecycle | **IMPLEMENTED** | `src/modules/orders/orderService.ts`, state machine |
| **Orders** | Idempotent Cancellation | **IMPLEMENTED** | Single-release stock restoration, terminal state locks, atomic coupon/promo slot release |
| **Payments** | Provider-Agnostic Abstraction | **IMPLEMENTED** | `PaymentProvider` interface, `MockPaymentProvider` sandbox |
| **Payments** | Webhook Deduplication | **IMPLEMENTED** | `financialWebhookService.ts`, unique `event_id` constraints |
| **Payments** | Distributed Recovery Worker | **IMPLEMENTED** | `financialRecoveryWorker.ts`, lease fencing |
| **Settlement** | Double-Entry General Ledger | **IMPLEMENTED** | `ledgerService.ts`, balanced `journal_entries`, COA `5040` platform subsidy, Migration 027 `LEDGER_IMMUTABLE` triggers |
| **Settlement** | Statutory Withholding (TDS/TCS)| **IMPLEMENTED**| Section 194-O / Sec 393 & Section 52 GST-TCS |
| **Settlement** | Idempotent Payout, FIFO & Reversal | **IMPLEMENTED** | `sellerSettlementService.ts`, `riderPayoutService.ts`, FIFO `settled_amount`/`refunded_amount`, post-`PAID` reversal webhooks & `1040->2020` clawback offset |
| **Reconciliation** | Automated Audit Checks (1–14) | **IMPLEMENTED** | `paymentReconciliationService.ts` (payments, COD checks 13–13F, pricing/GST/coupon checks 14A–14D) |
| **Dispatch** | Trip Broadcasting & Claiming | **IMPLEMENTED** | Atomic `UPDATE ... WHERE status = 'BROADCASTING'` |
| **Delivery** | Doorstep OTP Handshake | **IMPLEMENTED** | Constant-time verification via `orders.delivery_otp`, server-derived COD collection (`partnerCompatibilityRoutes.ts`) |
| **Realtime** | WebSocket Event Streaming | **IMPLEMENTED** | `/ws/v1`, channel authorization (`order:<id>`) |
| **Realtime** | Ephemeral GPS Telemetry | **IMPLEMENTED** | 1-second ping memory/Redis broadcast (0 PG writes) |
| **Observability** | Health & Readiness Probes | **IMPLEMENTED** | `/health/live`, `/health/ready` |
| **External Payment**| Live Production Gateway Call | **NOT IMPLEMENTED**| By design. Mock sandbox active; live keys unconfigured |
| **e-Invoicing (IRP)** | Live NIC IRP IRN Submission | **NOT IMPLEMENTED**| `EINVOICING_ENABLED=false` yields `irn: null` & `NOT_APPLICABLE` (no fake IRN hashes) |
| **MCP** | Model Context Protocol Server | **NOT IMPLEMENTED**| Not detected or implemented in codebase |
