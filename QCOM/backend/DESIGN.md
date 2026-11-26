# QCOM Platform — System Design & Architecture Decisions (DESIGN)

**Document Version:** 1.0.0  
**Status:** Approved Architectural Baseline  

---

## 1. Architectural Philosophy & Principles

QCOM is architected as a **Modular Monolith** in TypeScript / Node.js running on Express and WebSockets, backed authoritatively by **PostgreSQL 16** with **Redis 7** for transient caching and pub/sub broadcasting.

### Core Design Principles:
1. **Single Source of Truth:** PostgreSQL 16 is the sole authoritative store for all financial, inventory, order, and authorization state. Redis is strictly non-authoritative.
2. **Encapsulated Domain Modules:** Code is organized by domain in `src/modules/*`. Inter-module communication occurs via defined service classes (`orderService`, `inventoryService`, `ledgerService`) rather than ad-hoc database queries across boundaries.
3. **Pessimistic Concurrency for Scarce Resources:** Row-level locks (`SELECT ... FOR UPDATE`) are used for inventory stock commitment and payout processing to eliminate race conditions.
4. **Outbox Pattern for Decoupled Side-Effects:** Real-time push notifications, back-in-stock alerts, and external event dispatches are written to the database outbox table within the same transaction as the business mutation, ensuring reliable delivery without distributed transactions.
5. **Fail-Safe Gateways:** Third-party integrations (payments, SMS, payouts) are abstracted behind strict provider interfaces with graceful mock implementations for offline development and safety validations for production.

---

## 2. Key Subsystems & Design Choices

### 2.1 Double-Entry General Ledger (`src/modules/ledger`)
Every financial movement creates an immutable `journal_batches` record containing balanced `journal_entries`:
- Total Debits must exactly equal Total Credits.
- Uses decimal BigNumber representation to eliminate floating-point rounding errors.
- Chart of Accounts (COA) covers Customer Receivables, Merchant Payables, Rider Payables, Platform Commissions, and Statutory Tax liabilities (CGST, SGST, IGST, TDS, TCS).

### 2.2 Payment State Machine & Provider Neutrality (`src/modules/payments`)
- Abstraction layer (`PaymentProvider` interface) enables swapping payment providers (Razorpay, mock provider, future banking APIs) without altering core order workflows.
- Webhook deduplication is enforced by unique constraints on `webhook_events(event_id)`. Replays of terminal states (`PROCESSED`, `IGNORED`, `FAILED`) return idempotent acknowledgments.
- Distributed recovery leases (`payment_intent_recovery_leases`) allow background reconciliation workers to detect and resolve stuck transactions without double-charging.

### 2.3 Inventory Management & Selective Reservations (`src/modules/inventory`)
- Two-phase inventory model: temporary reservation during checkout, followed by atomic commit upon order placement.
- When stock reaches 0, customers can subscribe to stock alerts. When restocked via `inventoryService.restock()`, the system publishes outbox events for consumer notifications.

### 2.4 Dispatch & Real-Time Telemetry (`src/modules/dispatch`, `src/modules/realtime`)
- Order trip broadcasting targets available riders within the merchant store's geofenced radius.
- Rider GPS pings are ingested at 1-second intervals into memory/Redis and broadcast directly to subscribers without writing high-frequency telemetry into persistent PostgreSQL tables.

### 2.5 Authoritative Pricing, Indian GST Engine, Concurrency-Safe Promotions/Coupons & GST Credit Notes (`src/modules/pricing`, `src/modules/invoices`)
- **Decimal-Safe Arithmetic (`money.ts`):** All price, discount, GST (`CGST`/`SGST`/`IGST`), Cess, prorated refund, and settlement math executes via `bignumber.js` (`ROUND_HALF_UP` to 2 decimals) — never binary floats.
- **GST Inclusivity & Fail-Closed Classification (`taxEngine.ts`):** Supports `tax_inclusive` MRP back-calculation (`taxable = gross / (1 + (gstRate + cessRate)/100)`), `tax_exclusive` forward calculation, and `TAXABLE`/`EXEMPT`/`NIL_RATED`/`ZERO_RATED` categories. Products or sellers missing verified tax classifications fail closed with HTTP `422` (`UNVERIFIED_PRODUCT_TAX` / `INVALID_STATE_CONFIGURATION`).
- **Dynamic Place of Supply:** Inter-state vs. intra-state GST splits resolve dynamically from seller (`merchants.state_code`) vs. customer delivery state (`indian_states` 36-state/UT master) with zero hardcoded `'29'` defaults.
- **Concurrency-Safe Coupons, Promotions & Funding Splits (`couponPromotionService.ts`):** Coupons lock under `SELECT ... FOR UPDATE` and track `RESERVED` -> `REDEEMED` / `RELEASED` / `REVERSED` slots, rejecting over-limit checkouts even under 200-way concurrent bursts. Discounts allocate proportionally across line items and split funding (`SELLER`, `PLATFORM`, `SHARED`), crediting/debiting COA `5040` (`Platform Promotion Subsidy`) in balanced GL batches.
- **Persistent Carts, Quote Integrity & Prorated Credit Notes:** DB-backed carts (`carts`/`cart_items`) verify server-computed checkout quotes (`409 PRICE_CHANGED` / `QUOTE_EXPIRED`). Invoices stamp real dynamic Apr–Mar Indian FY and honest `irn: null` / `eInvoicingStatus: 'NOT_APPLICABLE'` when IRP is disabled. Partial/full returns generate immutable GST `credit_notes` & `credit_note_line_items` matching prorated discounted tax-inclusive item totals (`line_total_payable`).

---

## 3. Error-Handling & Resilience Conventions

- **Structured API Errors:** All endpoints return standard JSON error envelopes with clear error codes (`INSUFFICIENT_STOCK`, `UNAUTHORIZED`, `INVALID_OTP`, `UNCONFIGURED_PAYMENT_GATEWAY`).
- **Transaction Rollback Safety:** Database interactions use transactional wrappers (`transaction(async (client) => { ... })`) ensuring atomic rollback on unhandled exceptions.
- **Circuit-Breakers & Graceful Degradation:** If Redis becomes unavailable, the system safely falls back to local in-memory pub/sub and continues processing core HTTP transactions.
