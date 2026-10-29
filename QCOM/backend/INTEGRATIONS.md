# QCOM Platform — External Integrations & Service Adapters (INTEGRATIONS)

---

## 1. Primary Infrastructure Integrations

### 1.1 PostgreSQL 16 (Authoritative Database)
- **Status:** **REAL INTEGRATION (ACTIVE)**
- **Role:** Authoritative ACID storage for financial ledgers, catalog, inventory, orders, auth sessions, and idempotency records.
- **Connection Management:** `pg.Pool` defaults to 10 maximum clients per process, a 30,000ms idle timeout, and a 5,000ms connection-acquisition timeout. Configure `DATABASE_MAX_POOL_SIZE` against the total deployment connection budget; all in-process workers share this pool.

### 1.2 Redis 7 (Caching & Pub/Sub)
- **Status:** **REAL INTEGRATION (EPHEMERAL DATA AND DISTRIBUTED ADMISSION)**
- **Role:** Caching, WebSocket pub/sub, and distributed rate-limit counters.
- **Fail-Safe:** Development/test may use in-memory fallbacks. Production rate-limit counters never fall back to process-local state: sensitive route policies return 503 when Redis is unavailable. The general request guard logs and marks its fail-open behavior. Cache reads may still fall back to PostgreSQL; PostgreSQL remains authoritative.

---

## 2. Payment Gateway Integration Posture

- **Current Status:** **PROVIDER-AGNOSTIC ABSTRACTION WITH MOCK SANDBOX**
- **Live Payment Gateway:** **NOT SELECTED / NOT INTEGRATED (BY DESIGN)**
- **Implementation Detail:**
  - `PaymentProvider` interface (`src/modules/payments/provider/PaymentProvider.ts`) defines payment creation, capture, verification, refund, and webhook signature validation contracts.
  - `MockPaymentProvider` (`src/modules/payments/provider/MockPaymentProvider.ts`) executes local deterministic simulations for all test and sandbox environments.
  - In production (`NODE_ENV=production`), `validateProductionSecurity()` explicitly forbids mock payments. Live credentials (`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`) must be provided via Cloud Secret Manager prior to deployment.
  - Webhook processing handles HMAC-SHA256 signature verification and durable deduplication.

---

## 3. Telephony & Notification Adapters

- **Current Status:** **DECOUPLED OUTBOX PATTERN WITH MOCK PROVIDER**
- **SMS / Push Provider:** Handled through `notificationService.ts`.
- **Telephony Mode:** Set to `mock` by default in development and test environments to prevent SMS leakage. Real integration adapters are pluggable via outbox event subscribers (`onOrderCreated`, `onDispatchAssigned`).

---

## 4. Real-Time Telemetry & WebSockets

- **Status:** **ACTIVE NATIVE INTEGRATION**
- **Technology:** `ws` WebSocket library mounted on HTTP server at `/ws/v1`.
- **Pub/Sub Cluster Backplane:** Redis pub/sub backplane relays broadcast events across horizontal backend instances.
