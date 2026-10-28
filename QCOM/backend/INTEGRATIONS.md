# QCOM Platform — External Integrations & Service Adapters (INTEGRATIONS)

---

## 1. Primary Infrastructure Integrations

### 1.1 PostgreSQL 16 (Authoritative Database)
- **Status:** **REAL INTEGRATION (ACTIVE)**
- **Role:** Authoritative ACID storage for financial ledgers, catalog, inventory, orders, auth sessions, and idempotency records.
- **Connection Management:** Connection pool (`pg.Pool`) with 25 maximum clients, 5000ms idle timeout, and serialized advisory locking for migrations (`scripts/migrate.ts`).

### 1.2 Redis 7 (Caching & Pub/Sub)
- **Status:** **REAL INTEGRATION (WITH RESILIENT IN-MEMORY FALLBACK)**
- **Role:** Ephemeral rider GPS coordinates, real-time WebSocket room broadcasting, and transient session caching.
- **Fail-Safe:** If Redis is partitioned or unconfigured, the system automatically falls back to an internal in-memory event bus without failing HTTP requests.

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
