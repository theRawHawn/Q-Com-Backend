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
| **Pricing Engine** | Statutory GST Tax Rules | **IMPLEMENTED** | `src/modules/pricing/pricingEngine.ts`, CGST/SGST/IGST |
| **Pricing Engine** | Dynamic Delivery & Handling | **IMPLEMENTED** | Distance-based tiers, surge pricing, promotional coupons |
| **Inventory** | Selective Stock Reservation | **IMPLEMENTED** | `inventory_reservations` table with expiration TTL |
| **Inventory** | Zero-Oversell Serialization | **IMPLEMENTED** | Row-level locks (`SELECT ... FOR UPDATE`), check constraints |
| **Inventory** | Back-in-Stock Alerts | **IMPLEMENTED** | Outbox events, `stockNotificationConsumer.ts` |
| **Orders** | Full Order Lifecycle | **IMPLEMENTED** | `src/modules/orders/orderService.ts`, state machine |
| **Orders** | Idempotent Cancellation | **IMPLEMENTED** | Single-release stock restoration, terminal state locks |
| **Payments** | Provider-Agnostic Abstraction | **IMPLEMENTED** | `PaymentProvider` interface, `MockPaymentProvider` sandbox |
| **Payments** | Webhook Deduplication | **IMPLEMENTED** | `financialWebhookService.ts`, unique `event_id` constraints |
| **Payments** | Distributed Recovery Worker | **IMPLEMENTED** | `financialRecoveryWorker.ts`, lease fencing |
| **Settlement** | Double-Entry General Ledger | **IMPLEMENTED** | `ledgerService.ts`, balanced `journal_entries` |
| **Settlement** | Statutory Withholding (TDS/TCS)| **IMPLEMENTED**| Section 194-O (1%) & Section 52 GST-TCS (0.5%) |
| **Settlement** | Idempotent Payout Execution | **IMPLEMENTED** | Payout idempotency constraints, batch release routes |
| **Dispatch** | Trip Broadcasting & Claiming | **IMPLEMENTED** | Atomic `UPDATE ... WHERE status = 'BROADCASTING'` |
| **Delivery** | Doorstep OTP Handshake | **IMPLEMENTED** | Verification via `orders.delivery_otp` |
| **Realtime** | WebSocket Event Streaming | **IMPLEMENTED** | `/ws/v1`, channel authorization (`order:<id>`) |
| **Realtime** | Ephemeral GPS Telemetry | **IMPLEMENTED** | 1-second ping memory/Redis broadcast (0 PG writes) |
| **Observability** | Health & Readiness Probes | **IMPLEMENTED** | `/health/live`, `/health/ready` |
| **External Payment**| Live Production Gateway Call | **NOT IMPLEMENTED**| By design. Mock sandbox active; live keys unconfigured |
| **MCP** | Model Context Protocol Server | **NOT IMPLEMENTED**| Not detected or implemented in codebase |
