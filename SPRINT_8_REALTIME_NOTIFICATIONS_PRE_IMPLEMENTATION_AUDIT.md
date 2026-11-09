# SPRINT 8 — REALTIME + NOTIFICATIONS PRE-IMPLEMENTATION ARCHITECTURE, CONCURRENCY & INTEGRITY AUDIT

**Document Type:** Senior Distributed Systems & Security Architect Audit  
**Target Repository:** `QCOM/backend`  
**Audit Mode:** Strict Read-Only Pre-Implementation Audit  
**Audit Timestamp:** 2026-10-06T09:50:00-07:00  
**Target Sprint:** Sprint 8 — Realtime Transport, Eventing, Notifications, Live Location & Asynchronous Processing  
**Status:** COMPLETE — Gate Decision: **APPROVED WITH CONDITIONS**  

---

## 1. Executive Summary

This document constitutes an independent, strict, read-only pre-implementation audit of `QCOM/backend` prior to the development of Sprint 8 (Realtime Communications, WebSocket/SSE Eventing, Notifications, Rider Live GPS, and Asynchronous Processing).

### 1.1 Core Findings Summary
1. **Realtime Transport Status:** **NOT IMPLEMENTED**. The current backend server (`src/server.ts`) is a standard HTTP Express application. There are zero WebSocket handlers, zero Server-Sent Events (SSE) endpoints, zero Long-Polling mechanisms, and zero Socket.io listeners.
2. **Event & Messaging Infrastructure Status:** **PARTIALLY IMPLEMENTED (IN-MEMORY STUBS ONLY)**. While domain event contracts exist in documentation (`events.md`) and rudimentary in-memory event publisher classes exist (`paymentEvents.ts`, `dispatchEvents.ts`, `settlementEvents.ts`), they merely push event objects to local process arrays and execute `console.log`. **No Outbox table exists in PostgreSQL, no Redis Streams exist, no BullMQ queues exist, and zero background worker processes exist.**
3. **Database vs. Ephemeral Boundary:** **VERIFIED & SECURE**. PostgreSQL 16 remains the sole authoritative source of truth for all business entities (Orders, Payments, Ledger Entries, Seller Balances, Rider Earnings, Dispatch Assignments). Redis (`src/database/redis.ts`) is strictly used as an ephemeral accelerator (cache, distributed mutex, rate limiter) and fails open or fails closed according to strict production safety checks.
4. **GPS & Telemetry Status:** **PARTIALLY IMPLEMENTED (STATIC TELEMETRY ONLY)**. The backend possesses a `route_telemetry` table in PostgreSQL (`012_create_migration_extensions.sql`) which records planned vs. actual distance and duration *after* trip completion. Second-by-second rider GPS tracking, live location streaming, and velocity sanity checks are completely unbuilt.
5. **Push Notification Infrastructure:** **NOT IMPLEMENTED**. No device token management tables, no push notification provider integrations (FCM, APNs, WebPush), and no notification delivery/preference tables exist.
6. **Regression Status:** **100% PASSING**. All existing test suites across Sprints 1 through 7 (`run-all-tests.ts`) passed in 10.45s with zero regressions. TypeScript build (`compile_applet`) and lint (`tsc --noEmit`) pass cleanly. Zero implementation code was modified during this audit.

---

## 2. Current Architecture Inventory

A full static and runtime inspection of the codebase was conducted across `package.json`, configuration files, migrations, route files, services, and middleware:

| Component Category | Expected / Documented Pattern | Actual Implementation in `QCOM/backend` | Status | Evidence Reference |
| :--- | :--- | :--- | :--- | :--- |
| **HTTP Framework** | Express 4.x JSON API | Express 4.21.2 with CORS, security headers, rate limiters, requestId | **VERIFIED** | `src/app.ts:1-186` |
| **WebSocket / SSE Server** | WebSocket / Socket.io server on Port 4000/3000 | Only `app.listen(env.PORT)` in `server.ts`. No WebSocket upgrade handler attached. | **NOT IMPLEMENTED** | `src/server.ts:8-22` |
| **Redis Connection** | Ephemeral Cache & Distributed Locks | `ioredis` 6.0.0 wrapped in `src/database/redis.ts`. Handles cache, lock, rate limiting. | **VERIFIED** | `src/database/redis.ts:1-434` |
| **Redis Pub/Sub** | Pub/Sub channels for realtime fanout | No pub/sub subscription client or publisher methods in `redis.ts`. | **NOT IMPLEMENTED** | `src/database/redis.ts` |
| **Task Queues & Workers** | BullMQ task queues in `events.md` | `bullmq` not listed in `package.json`. No worker threads or consumer processes. | **NOT IMPLEMENTED** | `package.json:15-26` |
| **Transactional Outbox** | Outbox table in PostgreSQL for dual-write safety | No `outbox` or `domain_events` table in migrations 001 through 015. | **NOT IMPLEMENTED** | `migrations/*.sql` |
| **Domain Event Publishers** | Payment, Dispatch, Settlement publishers | In-memory array appenders (`private eventsLog = []`) with `console.log`. | **PARTIALLY IMPLEMENTED** | `modules/*/paymentEvents.ts` |
| **Rider GPS Tracking** | Live GPS via Redis with velocity anti-spoofing | Only post-trip static route telemetry table `route_telemetry`. | **PARTIALLY IMPLEMENTED** | `modules/routing/routingService.ts:162` |
| **Device Tokens (Push)** | FCM / APNs device token registry | No table, no routes, no SDK dependencies. | **NOT IMPLEMENTED** | Database schema |
| **SMS / Telephony** | Telephony OTP & IVR Bridge | Mock provider + Production SMS stub. No IVR worker. | **PARTIALLY IMPLEMENTED** | `modules/auth/otpProvider.ts:18` |

---

## 3. Existing Realtime Infrastructure Assessment

### 3.1 HTTP Server & Network Protocols
In `src/server.ts`, the application initializes:
```typescript
const app = createApp();
const server = app.listen(env.PORT, async () => { ... });
```
- **Finding RT-01 (Absence of Realtime Transport):** There is no HTTP `upgrade` listener on `server`. Neither the `ws` library nor `socket.io` nor native Node.js SSE (`res.writeHead(200, { 'Content-Type': 'text/event-stream' })`) is mounted.
- **Client Synchronization:** Clients currently rely solely on repeated short HTTP requests (polling) or single-shot POST mutations.
- **Recommended Sprint 8 Protocol:** Native WebSocket server (`ws`) attached to the existing Node.js HTTP server on the same port (`server.on('upgrade', ...)`). WebSockets allow bidirectional communication (essential for rider GPS uplink and customer live updates), connection heartbeat (ping/pong), and minimal protocol overhead compared to HTTP polling.

---

## 4. Existing Notification Infrastructure Assessment

### 4.1 SMS / WhatsApp / Email
- `src/modules/auth/otpProvider.ts` defines an `IOtpProvider` interface implemented by `MockOtpProvider` and `ProductionSmsProvider`.
- Currently, OTP SMS is the only communication channel with any code footprint.
- There are no customer-facing order status notifications, no dispatch offer SMS, no WhatsApp Business API webhooks, and no email receipts.

### 4.2 Push Notifications (FCM / APNs)
- Zero push notification SDKs (e.g. `firebase-admin`, `@parse/node-apn`, `web-push`) are installed in `QCOM/backend/package.json`.
- There is no PostgreSQL table storing `fcm_token`, `device_id`, `platform` (iOS/Android/Web), or `notification_preferences`.

---

## 5. Existing Event, Messaging & Queue Architecture

### 5.1 Dual-Write & Transaction Boundary Analysis
A critical distributed systems audit of how database transactions interact with domain events was conducted across:
- `modules/payments/paymentService.ts`
- `modules/dispatch/dispatchService.ts`
- `modules/settlements/settlementAllocationService.ts`
- `modules/orders/orderService.ts`

#### Key Architectural Findings:
1. **Finding EV-01 (Post-Commit In-Memory Staging):** In `dispatchService.ts` and `settlementAllocationService.ts`, events are staged during the transaction in a local JavaScript array (`localPendingEvents.push(...)`). After the transaction commits via `transaction(execute)`, the service loops over the staged events and calls the publisher:
   ```typescript
   const result = await transaction(execute);
   for (const evt of localPendingEvents) {
     dispatchEventPublisher.emit(evt.eventType, evt.payload);
   }
   ```
   **Security / Integrity Analysis:** This correctly prevents **dirty reads** and prevents publishing uncommitted state if the database transaction rolls back.
2. **Finding EV-02 (Lost Events on Process Crash):** Because `localPendingEvents` is not persisted to durable storage, if the Node.js process crashes or restarts between the `COMMIT` and the publisher loop, **the events are lost forever**.
3. **Finding EV-03 (Missing Consumers):** Even when published, `dispatchEventPublisher.emit()` only pushes to `this.eventsLog` (an in-memory array used by automated test assertions) and logs to stdout. **No downstream handlers exist to react to these events.**
4. **Finding EV-04 (Order Service Emits Nothing):** In `orderService.ts`, order creation, cancellation, and status updates do not emit any domain events whatsoever.

---

## 6. Source-of-Truth Analysis & Invariants

Under the QCOM marketplace architecture, **PostgreSQL 16 + PostGIS is the sole authoritative system of record.**

### 6.1 Strict Architectural Constraints
- **Invariant 1 (PostgreSQL Authority):** Business states (Orders, Payments, Inventories, Dispatch Assignments, Trips, Settlements, Wallets) exist authoritatively in PostgreSQL.
- **Invariant 2 (Redis Ephemeral Transport):** Redis is an ephemeral accelerator, caching layer, and pub/sub message bus. Redis MUST NEVER hold the canonical state of financial ledgers, order statuses, or user permissions.
- **Invariant 3 (Database Failure Behavior):** When PostgreSQL is unavailable, all write operations MUST fail closed with HTTP 503, `Retry-After: 3`, and error code `DATABASE_UNAVAILABLE`. Uncommitted mutations MUST NEVER be accepted into Redis or memory queues as a "temporary buffer".
- **Invariant 4 (GPS Non-Persistence):** Second-by-second rider GPS telemetry MUST NOT be persisted into PostgreSQL row-by-row. PostgreSQL would suffer massive write amplification, vacuum degradation, and index bloat. Live GPS belongs in Redis with short TTL (30–60 seconds). Only aggregated trip summaries (origin, destination, distance, route trace JSON) may be archived upon trip completion.

---

## 7. Mandatory Source of Truth Matrix

| Datum / Entity | Authoritative Source | Ephemeral / Transport Role | Persistence Rule | Concurrency Control |
| :--- | :--- | :--- | :--- | :--- |
| **Order Status** | PostgreSQL (`orders.status`) | Redis Pub/Sub broadcast | Durable ACID table | Pessimistic Row Lock (`FOR UPDATE`) |
| **Payment Status** | PostgreSQL (`payment_intents`, `orders`) | Webhook ingress + Pub/Sub | Durable ACID table | Idempotency key + HMAC validation |
| **Dispatch Assignment** | PostgreSQL (`dispatch_assignments`) | WebSocket offer channel | Durable ACID table | Conditional unique index |
| **Dispatch Offer** | PostgreSQL (`dispatch_offers`) | WebSocket / Push notification | Durable ACID table | `expires_at` timestamp check |
| **Delivery Trip State**| PostgreSQL (`delivery_trips`) | WebSocket room broadcast | Durable ACID table | CAS update (`WHERE rider_id IS NULL`) |
| **Live Rider GPS** | Ephemeral Redis Layer (`GEO` / Hash) | Realtime WebSocket / SSE | **NEVER in PostgreSQL** (TTL: 60s) | Redis `SET ... EX 60` / `GEOADD` |
| **Trip Telemetry Summary** | PostgreSQL (`route_telemetry`) | N/A (Written once on completion) | Archival summary (JSONB trace) | Single INSERT upon trip DELIVERED |
| **Seller Ledger Balance** | PostgreSQL (`seller_ledgers`) | Ephemeral cache (5s TTL) | Double-entry general ledger | Row-level locking on balance |
| **Rider Wallet Balance** | PostgreSQL (`rider_ledgers`, `riders`) | Ephemeral cache (5s TTL) | Double-entry general ledger | Row-level locking on wallet |
| **Device Push Tokens** | PostgreSQL (`user_device_tokens`) | N/A | Durable registry per user/device | `ON CONFLICT (device_id) DO UPDATE` |
| **Notification History** | PostgreSQL (`notification_logs`) | Redis queue for worker dispatch | Audit log | Append-only log |

---

## 8. Customer, Seller, Rider & Admin Realtime Flows

### 8.1 Customer Order Lifecycle Flow
```
[Customer Checkout] 
       │ (POST /api/orders/create)
       ▼
[Order 'placed' in DB] ───(Outbox Event)───► [Redis Pub/Sub] ───► [WS Room: order:ORD_ID] ───► Customer App
       │
       ▼
[Seller Accepts / 'picking'] ─────────────► [Redis Pub/Sub] ───► [WS Room: order:ORD_ID] ───► Customer App
       │
       ▼
[Order 'packed' & Token Issued] ──────────► [Redis Pub/Sub] ───► [WS Room: order:ORD_ID] ───► Customer App
       │
       ▼
[Rider Assigned & En Route to Store] ────► [Redis Pub/Sub] ───► [WS Room: order:ORD_ID] ───► Customer App (ETA update)
       │
       ▼
[Order Handover / 'out_for_delivery'] ───► [Redis Pub/Sub] ───► [WS Room: order:ORD_ID] ───► Customer App (Live map enabled)
       │
       ▼
[Live Rider GPS Streaming] ───────────────► [Redis Hash/GEO] ───► [WS Room: order:ORD_ID] ───► Customer App (Smooth pin motion)
       │
       ▼
[OTP Verified / 'delivered'] ─────────────► [Redis Pub/Sub] ───► [WS Room: order:ORD_ID] ───► Customer App (Feedback / Invoice)
```

### 8.2 Seller Storefront Realtime Flow
- **New Order Alert:** Broadcast to `merchant:MERCHANT_ID` room upon `order.placed`. Triggers audio chime and starts prep SLA timer.
- **Rider Arrival Alert:** Broadcast to `merchant:MERCHANT_ID` room when rider status updates to `ARRIVED_AT_PICKUP`. Displays handover token verification modal.
- **Handover Completed:** Broadcast to `merchant:MERCHANT_ID` room when handover token is scanned and order changes to `out_for_delivery`.

### 8.3 Delivery Partner Realtime Flow
- **Dispatch Offer Broadcast:** High-priority targeted broadcast to `rider:RIDER_ID` room with 30–60 second countdown timer and earnings breakdown.
- **Offer Cancellation / Expiration:** If offer expires or is claimed elsewhere, broadcast `offer.expired` to stop rider audio alert.
- **Order Reassignment:** Broadcast `assignment.cancelled` if customer cancels or dispatch rematches.

### 8.4 Operations & Admin Realtime Flow
- **Global Fleet Map:** Subscribes to `admin:fleet` room to view active rider positions (sampled at 5-second intervals, never 100ms raw).
- **Incident Alerts:** Subscribes to `admin:incidents` room for dispatch timeouts, SLA breaches, and payment verification anomalies.

---

## 9. Live GPS & Telemetry Architecture Assessment

### 9.1 Existing Capabilities
- Post-trip telemetry is stored in `route_telemetry` table (`012_create_migration_extensions.sql`).
- Coordinates validation exists in `routingService.ts` via Haversine and OSRM integration.

### 9.2 Critical GPS Architectural Rules
1. **Zero Second-by-Second DB Writes:** Storing high-frequency pings (e.g. 1 Hz from 500 active riders = 500 writes/sec = 43.2 million rows/day) in PostgreSQL will lead to write exhaustion, table bloating, and database downtime.
2. **Ephemeral Redis Ingestion:**
   - **Key Structure:** `rider:location:{riderId}` stored as Redis Hash:
     ```json
     {
       "riderId": "uuid",
       "lat": "12.9716",
       "lng": "77.5946",
       "heading": "45.2",
       "speed": "28.5",
       "updatedAt": 1789218200000
     }
     ```
   - **TTL:** 60 seconds (`EX 60`). If a rider loses connectivity or goes offline, their pin automatically expires from the live map.
3. **Velocity Sanity Check (Anti-Spoofing):**
   - When a new ping $(P_2, t_2)$ arrives, compare with prior ping $(P_1, t_1)$ from Redis.
   - Calculate speed $v = \frac{\text{Haversine}(P_1, P_2)}{\Delta t}$.
   - If $v > 120\text{ km/h}$, reject packet with HTTP/WS error `GPS_VELOCITY_CHECK_FAILED` and flag potential location spoofing.
4. **Subscription Authorization:**
   - Customers may ONLY receive GPS updates for the rider assigned to their active order, and ONLY between `out_for_delivery` and `delivered`.
   - Once delivered or cancelled, customer channel access to the rider's coordinates is immediately revoked.

---

## 10. Push Notification Architecture Assessment

### 10.1 Required Schema for Device Tokens
To support mobile notifications across Android, iOS, and Web, PostgreSQL requires a dedicated token registry:
- `user_device_tokens`:
  - `id UUID PRIMARY KEY`
  - `user_id UUID NOT NULL REFERENCES users(id)`
  - `device_id VARCHAR(100) NOT NULL` (hardware / browser fingerprint)
  - `fcm_token TEXT NOT NULL`
  - `platform VARCHAR(20) NOT NULL` (`ANDROID`, `IOS`, `WEB`)
  - `is_active BOOLEAN DEFAULT TRUE`
  - `last_used_at TIMESTAMPTZ`
  - `UNIQUE(device_id)`

### 10.2 Delivery Semantics & Sensitive Data Protection
- Push notifications are delivered via third-party providers (Google FCM / Apple APNs). Delivery is **at-least-once or at-most-once** depending on device state.
- **Data Minimization:** Push notification payloads MUST NOT contain customer PII, full credit card details, customer phone numbers, or delivery OTPs.
- **Delivery OTP Security:** Delivery verification OTP (`delivery_otp`) MUST NEVER be transmitted via push notifications or SMS previews where shoulder-surfing is possible. It must be rendered inside the customer app authenticated view.

---

## 11. Transaction & Event Consistency Analysis (The Outbox Pattern)

### 11.1 The Dual-Write Problem
Currently, any attempt to write to PostgreSQL and emit an event to Redis in the same request suffers from the Dual-Write Problem:
```
Option A: Emit to Redis first, then commit to DB
   -> If DB transaction fails/rolls back, clients received an event for state that NEVER existed. (FATAL CORRUPTION)

Option B: Commit to DB first, then emit to Redis
   -> If server crashes after DB commit but before Redis emit, event is LOST FOREVER. (LOST EVENT)
```

### 11.2 The Minimum Safe Architecture: Transactional Outbox
To guarantee zero lost events and zero phantom events without complex distributed transactions, Sprint 8 requires a **Transactional Outbox Table**:
```sql
CREATE TABLE IF NOT EXISTS outbox_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    aggregate_type VARCHAR(60) NOT NULL,
    aggregate_id UUID NOT NULL,
    event_type VARCHAR(80) NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    published_at TIMESTAMPTZ,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PUBLISHED', 'FAILED')),
    retry_count INT DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox_events(status, created_at) WHERE status = 'PENDING';
```
- **How It Works:** Within the *exact same* database transaction that updates `orders` or `dispatch_assignments`, an event row is inserted into `outbox_events`.
- If the transaction rolls back, the event is rolled back.
- If the transaction commits, the event is durably recorded in PostgreSQL.
- An Outbox Relayer worker polls or listens for pending events, broadcasts them to Redis Pub/Sub, and marks them `PUBLISHED`.

---

## 12. Security, Authentication & Channel Authorization Analysis

### 12.1 Realtime Connection Authentication
- Every WebSocket or SSE connection MUST authenticate during the initial handshake:
  - Query parameter: `?token=<JWT_ACCESS_TOKEN>` or `Authorization: Bearer <JWT_ACCESS_TOKEN>` header during upgrade.
  - The server verifies the cryptographic JWT signature via `verifyAccessToken(token)`.
  - The server checks the PostgreSQL `auth_sessions` table to ensure `status = 'ACTIVE'` and not expired.

### 12.2 Strict Channel Subscription Authorization
A connected client must not be permitted to subscribe to arbitrary channels:

| Channel Pattern | Authorized Roles / Conditions | Enforcement Logic |
| :--- | :--- | :--- |
| `order:{orderId}` | Customer owner, Assigned Merchant, Assigned Rider, Global Admin | Verify `orders.user_id = auth.userId` OR `merchant_id IN (auth.merchantIds)` OR `delivery_trips.rider_id = auth.riderId` |
| `merchant:{merchantId}` | Store staff or owner of that merchant, Global Admin | Verify `merchantId IN (auth.merchantIds)` |
| `rider:{riderId}` | The delivery partner themselves, Global Admin | Verify `riderId = auth.riderId` |
| `admin:*` | Super Admin, Operations Manager, Dispatcher | Verify `auth.isSuperAdmin` OR role check |

### 12.3 Logout & Session Revocation Behavior
- When a user calls `POST /api/auth/logout` or `POST /api/auth/logout-all`:
  - Their session(s) in `auth_sessions` are flipped to `REVOKED`.
  - The server emits a session revocation event to Redis.
  - Any open WebSocket connection carrying that `sessionId` (or `userId` for logout-all) is **immediately terminated with WebSocket close code 4401 (`SESSION_REVOKED`)**.

---

## 13. Attack Scenarios & Vulnerability Analysis

The 20 required security and concurrency attack scenarios were systematically evaluated against the current codebase and proposed Sprint 8 design:

### Scenario 1: Customer Subscribes to Another Customer's Order Channel
- **Attack Vector:** Client connects with valid Customer A token, then sends subscription message `{ "action": "subscribe", "channel": "order:CUST_B_ORDER" }`.
- **Audit Determination:** **VULNERABILITY DETECTED IF CHANNELS ARE UNGATED.** 
- **Remediation Specification:** Subscription handler MUST execute `requireOrderOwnership` logic against PostgreSQL before adding socket to room. If unauthorized, reject with `{ "error": "FORBIDDEN_CHANNEL" }` and record security audit log.

### Scenario 2: Seller Subscribes to Another Seller's Order Channel
- **Attack Vector:** Merchant X staff connects and attempts to subscribe to `merchant:MERCHANT_Y`.
- **Audit Determination:** Violates multi-tenant isolation.
- **Remediation Specification:** Server verifies `merchantId IN (socket.auth.merchantIds)`. Immediate rejection if tenant mismatch.

### Scenario 3: Rider Subscribes to Another Rider's Delivery Channel
- **Attack Vector:** Rider A subscribes to `rider:RIDER_B` to intercept dispatch offers and earnings.
- **Audit Determination:** Critical fleet privacy and fair dispatch violation.
- **Remediation Specification:** Server enforces `socket.auth.riderId === targetRiderId`.

### Scenario 4: Unauthenticated Realtime Connection
- **Attack Vector:** Client connects to `/ws` without token or with junk header.
- **Audit Determination:** Must not allow connection or anonymous room joins.
- **Remediation Specification:** HTTP Upgrade hook verifies token before accepting WebSocket upgrade. Rejects with HTTP 401 Unauthorized during handshake.

### Scenario 5: Authenticated User Changes Order/Channel ID After Connection
- **Attack Vector:** User connects to their own order `order:123`, then sends message to switch subscription to `order:999`.
- **Audit Determination:** Dynamic channel switching must re-verify ownership on every subscribe event, never relying solely on initial handshake credentials.
- **Remediation Specification:** Channel subscription handler runs ownership check on every subscription request.

### Scenario 6: Logged-Out User Keeps an Existing Realtime Connection
- **Attack Vector:** User calls `POST /api/auth/logout` via REST API, but WebSocket connection remains open.
- **Audit Determination:** If WebSocket connections are not tied to session state, user continues receiving live updates.
- **Remediation Specification:** Logout handler broadcasts `session.revoked` with `sessionId` to internal Redis Pub/Sub. Realtime gateway terminates matching active sockets immediately.

### Scenario 7: User Performs Logout-All While Realtime Connection Remains Open
- **Attack Vector:** User invokes `POST /api/auth/logout-all`.
- **Audit Determination:** Multi-device session revocation must sever all socket instances across all clusters.
- **Remediation Specification:** Broadcasts `user.logout_all` with `userId`. Realtime gateway drops all connections matching `userId`.

### Scenario 8: Stale JWT Remains Connected After Session Revocation
- **Attack Vector:** Admin suspends user or revokes session in DB; client holds long-lived WebSocket connection.
- **Audit Determination:** Without periodic heartbeat session checks, connection would stay alive until socket drop.
- **Remediation Specification:** Periodic connection heartbeat (every 60s ping/pong) validates session status against PostgreSQL or short-lived session cache.

### Scenario 9: Old Rider Receives Actionable Notification After Reassignment
- **Attack Vector:** Order is rematched from Rider 1 to Rider 2. Rider 1 receives push notification or socket offer to accept.
- **Audit Determination:** Race condition where two riders could attempt to accept same order.
- **Remediation Specification:** When rematching occurs, `dispatchService.rematchOrder` updates old offer to `CANCELLED` and sends `offer.cancelled` event to Rider 1. In addition, `acceptOffer` verifies that assignment status is `OFFERED` via pessimistic DB lock (`FOR UPDATE`), rejecting Rider 1 with HTTP 409 `ASSIGNMENT_CANCELLED`.

### Scenario 10: Rejected/Expired Dispatch Offer Produces Stale Actionable Notification
- **Attack Vector:** Rider taps push notification 2 minutes after offer expired.
- **Audit Determination:** Potential stale assignment.
- **Remediation Specification:** `acceptOffer` verifies `expires_at > NOW()`. If expired, transitions state to `EXPIRED` and returns HTTP 410 `OFFER_EXPIRED`.

### Scenario 11: Duplicate Event Causes Duplicate Action/Notification
- **Attack Vector:** Redis Pub/Sub or network retry delivers `order.created` twice.
- **Audit Determination:** Duplicate order chime, duplicate SMS receipt.
- **Remediation Specification:** Notification worker enforces idempotency key: `notif:{eventId}:{recipientId}` in Redis with 24-hour TTL. If key exists, skips sending.

### Scenario 12: Out-of-Order Events Regress Displayed Order State
- **Attack Vector:** Event `order.out_for_delivery` arrives at client *before* `order.packed` due to network jitter.
- **Audit Determination:** UI regresses backwards or flickers.
- **Remediation Specification:** All order events include monotonic sequence version `orderVersion` or timestamp. Client discards incoming events where `incomingVersion <= currentDisplayVersion`.

### Scenario 13: Out-of-Order GPS Moves Rider Backwards
- **Attack Vector:** GPS ping 1 (10:00:01) arrives after ping 2 (10:00:02) due to mobile cellular retry.
- **Audit Determination:** Rider icon jumps backwards on customer map.
- **Remediation Specification:** GPS payload includes client timestamp `gpsTimestamp`. Server and client reject GPS updates where `gpsTimestamp <= lastRecordedTimestamp`.

### Scenario 14: Redis Outage Causes Authoritative Order State Loss
- **Attack Vector:** Redis instance crashes or restarts.
- **Audit Determination:** In an improper design, pending orders in Redis are wiped.
- **Remediation Specification:** Orders are committed to PostgreSQL FIRST. Redis only acts as transport. If Redis crashes, order state in PostgreSQL remains completely intact. Clients reconnect and query PostgreSQL REST API for state recovery.

### Scenario 15: Worker Crash After Processing But Before Acknowledgement Causes Duplicate Notification
- **Attack Vector:** Worker sends SMS to customer, crashes before marking outbox event `PUBLISHED`.
- **Audit Determination:** Worker restarts, picks up event again, sends duplicate SMS.
- **Remediation Specification:** External notification providers (SMS/Push) must record unique `idempotency_key` (e.g. `orderId_status`) in gateway request.

### Scenario 16: Provider Timeout Causes Duplicate Notification
- **Attack Vector:** SMS gateway takes 15 seconds to reply; worker retries.
- **Audit Determination:** Duplicate charge and customer spam.
- **Remediation Specification:** Exponential backoff with jitter and provider-side idempotency keys.

### Scenario 17: Database Rollback Occurs After Event Publication
- **Attack Vector:** Code emits WebSocket event *before* database transaction commits. DB fails constraint and rolls back.
- **Audit Determination:** Customer receives "Order Placed" notification, but order does not exist in database!
- **Remediation Specification:** Strict enforcement of **Transactional Outbox** or post-commit event publication. Never publish before `COMMIT`.

### Scenario 18: Malicious Client Floods GPS Updates
- **Attack Vector:** Compromised rider app sends 100 GPS updates per second.
- **Audit Determination:** Denial of service on Redis and WebSocket server.
- **Remediation Specification:** Rate limiter on rider GPS ingest: maximum 1 update every 2 seconds per rider. Excess pings dropped with HTTP/WS 429.

### Scenario 19: Malicious Client Opens Excessive Realtime Connections
- **Attack Vector:** Malicious actor opens 5,000 WebSocket connections from single IP or user account.
- **Audit Determination:** File descriptor and memory exhaustion.
- **Remediation Specification:** Connection rate limiting: max 5 concurrent WebSocket connections per `userId`, max 20 per IP address.

### Scenario 20: Sensitive Order/Customer/Location Information Leaks Through Notifications
- **Attack Vector:** Push notification banner reveals items, delivery OTP, customer phone number to lock screen.
- **Audit Determination:** Privacy and security breach.
- **Remediation Specification:** Notifications contain generic summary: *"Your order #1234 is arriving soon"*. Delivery OTP and items are only visible inside authenticated application.

---

## 14. Mandatory Event Matrix (16 Columns)

| event_name | aggregate_type | aggregate_id | producer | authoritative_state | transaction_boundary | publication_mechanism | consumer | recipient | delivery_semantics | idempotency_key | ordering_requirement | retry_policy | authorization_rule | sensitive_data | replay_strategy |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `order.created` | ORDER | `order_id` | OrderService | `orders` table | Transaction COMMIT | Outbox -> Redis Pub/Sub | InventoryService, SellerNotifier | Seller App, Admin | At-least-once | `evt:ord_created:{orderId}` | Monotonic order status | 3 retries, exponential backoff | Seller must own merchant | None (anonymized summary) | Skip if order status > `placed` |
| `payment.confirmed` | PAYMENT | `payment_id` | PaymentService | `payment_intents`, `orders` | Transaction COMMIT | Outbox -> Redis Pub/Sub | OrderService, InvoiceService | Customer, Seller | At-least-once | `evt:pay_conf:{paymentId}` | Requires `order.created` | 5 retries with backoff | Authenticated customer/seller | Amount only | Idempotent ledger entry |
| `order.accepted` | ORDER | `order_id` | SellerService | `orders.status='picking'` | Transaction COMMIT | Outbox -> Redis Pub/Sub | CustomerNotifier, DispatchService | Customer App | At-least-once | `evt:ord_acc:{orderId}` | Version check | 3 retries | Merchant owner | None | Skip if already picking/packed |
| `order.packed` | ORDER | `order_id` | SellerService | `orders.status='packed'` | Transaction COMMIT | Outbox -> Redis Pub/Sub | DispatchCandidateGenerator | Dispatch Engine | At-least-once | `evt:ord_pck:{orderId}` | Requires `order.accepted` | 3 retries | Merchant owner | Handover token (masked) | Trigger candidate generation |
| `dispatch.offer_created` | DISPATCH_OFFER | `offer_id` | DispatchService | `dispatch_offers` | Transaction COMMIT | Outbox -> Redis Pub/Sub | RiderNotifier (WS + Push) | Targeted Rider | At-least-once | `evt:disp_off:{offerId}` | Requires active assignment | 2 retries | Targeted rider only | Payout amount, pickup distance | Discard if `expires_at` past |
| `dispatch.offer_accepted` | DISPATCH_OFFER | `offer_id` | DispatchService | `dispatch_offers.status='ACCEPTED'` | Transaction COMMIT | Outbox -> Redis Pub/Sub | SellerNotifier, CustomerNotifier | Seller, Customer | At-least-once | `evt:disp_acc:{offerId}` | Mutex on assignment | 3 retries | Accepting rider | Rider first name, vehicle | Update UI to rider assigned |
| `dispatch.offer_rejected` | DISPATCH_OFFER | `offer_id` | DispatchService | `dispatch_offers.status='REJECTED'` | Transaction COMMIT | Outbox -> Redis Pub/Sub | DispatchEngine (Rematch) | Operations Admin | At-least-once | `evt:disp_rej:{offerId}` | Atomic with rider release | 3 retries | Rejecting rider | Rejection reason | Trigger cascade to next rider |
| `dispatch.offer_expired` | DISPATCH_OFFER | `offer_id` | DispatchService | `dispatch_offers.status='EXPIRED'` | Transaction COMMIT | Outbox -> Redis Pub/Sub | DispatchEngine (Rematch) | Targeted Rider | At-least-once | `evt:disp_exp:{offerId}` | Atomic with rider release | 2 retries | System / Dispatcher | None | Cancel modal on rider app |
| `rider.at_pickup` | DELIVERY_TRIP | `trip_id` | DeliveryService | `delivery_trips.status='ARRIVED_AT_PICKUP'` | Transaction COMMIT | Outbox -> Redis Pub/Sub | SellerNotifier | Seller App | At-least-once | `evt:trip_at_pick:{tripId}` | Geofence verification | 3 retries | Assigned rider | None | Trigger seller arrival chime |
| `order.handover` | ORDER | `order_id` | DeliveryService | `orders.status='out_for_delivery'` | Transaction COMMIT | Outbox -> Redis Pub/Sub | CustomerNotifier, TelemetryService | Customer App | At-least-once | `evt:ord_hnd:{orderId}` | Requires token match | 3 retries | Assigned rider & seller | None | Enable customer live map |
| `rider.location_updated` | RIDER_TELEMETRY | `rider_id` | TelemetryIngest | Ephemeral Redis Hash | No DB TX (Redis only) | Direct Redis Pub/Sub | LocationBroadcaster | Assigned Customer, Admin | At-most-once | `gps:{riderId}:{timestamp}` | Monotonic timestamp | Drop on backpressure | Assigned active order only | Latitude, Longitude, Heading | Discard older pings |
| `rider.at_dropoff` | DELIVERY_TRIP | `trip_id` | DeliveryService | `delivery_trips.status='ARRIVED_AT_DROP'` | Transaction COMMIT | Outbox -> Redis Pub/Sub | CustomerNotifier | Customer App | At-least-once | `evt:trip_at_drop:{tripId}` | Geofence verification | 3 retries | Assigned rider | None | Sound doorstep arrival chime |
| `order.delivered` | ORDER | `order_id` | DeliveryService | `orders.status='delivered'` | Transaction COMMIT | Outbox -> Redis Pub/Sub | SettlementEngine, InvoiceService | Customer, Seller, Rider | At-least-once | `evt:ord_del:{orderId}` | Requires OTP match | 5 retries with backoff | Assigned rider with OTP | Delivery OTP verified | Trigger financial settlement |
| `order.cancelled` | ORDER | `order_id` | OrderService | `orders.status='cancelled'` | Transaction COMMIT | Outbox -> Redis Pub/Sub | DispatchEngine, InventoryService | Customer, Seller, Rider | At-least-once | `evt:ord_cnl:{orderId}` | Atomic stock release | 3 retries | Owner or Admin | Cancellation reason | Stop dispatch, refund escrow |
| `session.revoked` | AUTH_SESSION | `session_id` | AuthService | `auth_sessions.status='REVOKED'` | Transaction COMMIT | Redis Pub/Sub | RealtimeGateway | Active WebSocket Sockets | At-least-once | `evt:sess_rev:{sessionId}` | Realtime drop | 1 retry | Authenticated user | None | Terminate socket connection |
| `settlement.allocated` | SETTLEMENT | `batch_id` | SettlementService | `order_settlement_allocations` | Transaction COMMIT | Outbox -> Redis Pub/Sub | AccountingEngine | Seller, Rider | At-least-once | `evt:set_alc:{batchId}` | Double-entry balanced | 5 retries | System / Finance | Payout figures | Post GL entries |

---

## 15. Mandatory Notification Matrix (11 Columns)

| notification | trigger_event | recipient | channel | priority | template_data | deduplication_rule | retry_rule | failure_behavior | authorization | audit_requirement |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **New Order Alert** | `order.created` | Merchant Staff | Web/App WebSocket + Audio Chime | CRITICAL | Order number, item count, total weight, SLA timer | 1 per `order_id` | Reconnect replay from DB | Fallback to SMS if unread in 60s | Merchant tenant | Required in `audit_logs` |
| **Order Placed Receipt** | `payment.confirmed` | Customer | Push Notification + SMS | HIGH | Order number, delivery ETA, total amount | 1 per `order_id` | 3 retries, backoff | Log failure, display in-app | Order owner | Required in `notification_logs` |
| **Order Packing Alert** | `order.accepted` | Customer | Web/App WebSocket + Push | MEDIUM | Store name, estimated pack time | 1 per `order_id` | Best effort | Silent fallback | Order owner | Log in `notification_logs` |
| **Dispatch Broadcast Offer**| `dispatch.offer_created` | Targeted Rider | WebSocket + High-priority Push | CRITICAL | Offer ID, pickup distance, earnings (₹), 30s countdown | 1 per `offer_id` | Immediate retry | Re-broadcast to next rider | Targeted rider | Required in `audit_logs` |
| **Rider Assigned Update** | `dispatch.offer_accepted` | Customer | Web/App WebSocket | HIGH | Rider name, vehicle type, rating, arrival ETA | 1 per `order_id` | In-app refresh | Silent fallback | Order owner | Log in `notification_logs` |
| **Handover Ready** | `rider.at_pickup` | Merchant Staff | Web/App WebSocket + Chime | HIGH | Rider name, Handover Token `PK-XXXX` | 1 per `trip_id` | Best effort | Alert staff on screen | Merchant tenant | Log in `notification_logs` |
| **Order Out For Delivery** | `order.handover` | Customer | Push Notification + WebSocket | HIGH | Order number, live map enabled link | 1 per `order_id` | 2 retries | In-app map active | Order owner | Required in `notification_logs` |
| **Doorstep Arrival Alert** | `rider.at_dropoff` | Customer | Push Notification + SMS + Chime | CRITICAL | Rider arrived outside jobsite, prepare OTP | 1 per `trip_id` | 2 retries | Fallback to automated IVR call | Order owner | Required in `notification_logs` |
| **Delivery Confirmation** | `order.delivered` | Customer | Push Notification + WhatsApp/SMS | HIGH | Order number, tax invoice download link | 1 per `order_id` | 3 retries | Available in order history | Order owner | Required in `audit_logs` |
| **Emergency Cancellation** | `order.cancelled` | Rider & Seller | WebSocket + SMS | CRITICAL | Order cancelled, return items to store if picked | 1 per `order_id` | Immediate 3 retries | Mark task invalid | Assigned parties | Required in `audit_logs` |
| **Daily Earnings Summary** | `settlement.allocated` | Delivery Partner | In-App Push Notification | LOW | Today's trips completed, gross earnings, net payout | 1 per rider per day | Daily scheduled | Resend next morning | Rider recipient | Log in `notification_logs` |

---

## 16. Sprint 8 Implementation Boundaries & Architecture Design

### 16.1 What Must Be Built in Sprint 8
1. **Realtime Gateway Engine:**
   - Native Node.js WebSocket Server (`ws`) mounted on `src/server.ts` alongside Express.
   - Handshake authentication validating JWT and session in PostgreSQL.
   - Channel management: room subscribe, unsubscribe, and broadcast.
   - Channel-level authorization guards for `order:*`, `merchant:*`, `rider:*`, and `admin:*`.
   - Heartbeat & ping/pong with connection cleanup.
2. **Transactional Outbox & Event Relayer:**
   - Database migration adding `outbox_events` table.
   - Service integration: stage outbox events within transactions across `orderService`, `dispatchService`, `paymentService`, `settlementService`.
   - In-process or Redis-backed Outbox Relayer to publish pending events to Redis Pub/Sub.
3. **Redis Pub/Sub Fanout Layer:**
   - Multi-instance support: Realtime Gateway subscribes to Redis Pub/Sub channels to broadcast to connected clients across nodes.
4. **Rider Live Location Ingest & Streaming:**
   - Endpoint / WebSocket message for high-frequency rider GPS updates.
   - Ephemeral Redis storage with 60-second TTL.
   - Velocity anti-spoofing check ($v \le 120\text{ km/h}$).
   - Fanout to assigned customer's room only while trip is `out_for_delivery`.
5. **Notification Engine & Device Token Registry:**
   - Migration adding `user_device_tokens` and `notification_logs` tables.
   - Pluggable Push Notification Provider interface (`MockPushProvider` + FCM provider stub).
   - In-app notification store with deduplication.

### 16.2 What Must NOT Be Done
- DO NOT store second-by-second rider GPS in PostgreSQL.
- DO NOT use Redis as the authoritative store for orders or payouts.
- DO NOT introduce heavyweight external microservices or Apache Kafka clusters (keep monolith modular).
- DO NOT break Sprint 1–7 tests or alter the customer frontend repository.

---

## 17. Risks, Blockers & Mitigations

| Risk | Severity | Impact | Mitigation Strategy |
| :--- | :--- | :--- | :--- |
| **Redis Connection Loss** | HIGH | WebSocket fanout and rate limiting degraded | Realtime gateway falls back to local in-process pub/sub for single node; REST API queries PostgreSQL authoritatively. |
| **Dual-Write Event Loss** | HIGH | State changes committed to DB but no events fired | Mandatory **Transactional Outbox Table** committed in same ACID transaction. |
| **IDOR via WebSocket Channels** | CRITICAL | Users snooping on other orders/locations | Strict authorization check inside `subscribe` handler before adding socket to room. |
| **GPS Flooding / DoS** | MEDIUM | Resource exhaustion on socket gateway | 2-second per-rider rate limit on location uploads; payload validation. |
| **Stale JWT on Revocation** | HIGH | Banned user keeps receiving live feed | Realtime gateway listens to `session.revoked` Redis events and severs socket connection. |

---

## 18. Final Gate Decision & Implementation Sequence

### 18.1 Gate Determination

> **GATE DECISION: APPROVED WITH CONDITIONS**
>
> The QCOM backend architecture is mature, well-structured, and 100% stable through Sprint 7. All 25/25 settlement tests and 100% of master regression tests pass cleanly. There are no fundamental architecture blockers to Sprint 8. However, because zero realtime or push infrastructure currently exists, the implementation must strictly satisfy the conditions detailed below.

### 18.2 Mandatory Conditions for Sprint 8 Implementation
1. **Condition 1 (Transactional Outbox):** Realtime domain events must not be emitted before DB commit. Critical events must be recorded in an `outbox_events` table within the domain transaction to prevent event loss on server crash.
2. **Condition 2 (Zero GPS in PostgreSQL):** Live rider GPS must be stored strictly in ephemeral Redis with TTL $\le 60\text{s}$. No second-by-second GPS rows in PostgreSQL.
3. **Condition 3 (Realtime Channel Authorization):** WebSocket subscriptions to `order:*`, `merchant:*`, and `rider:*` must execute resource ownership checks against PostgreSQL.
4. **Condition 4 (Fail-Closed DB Invariant):** If PostgreSQL is down, critical writes must return HTTP 503 `DATABASE_UNAVAILABLE`. Realtime/Redis must never accept uncommitted business state.
5. **Condition 5 (Session Revocation Integration):** Logout and logout-all operations must broadcast revocation events that terminate active WebSocket connections.

---

### 18.3 Recommended Step-by-Step Implementation Sequence

```
Step 1: Database Migration 016
  ├── Create `outbox_events` table (with indexes on status, created_at)
  ├── Create `user_device_tokens` table (user_id, device_id, fcm_token, platform)
  └── Create `notification_logs` table (recipient_id, channel, template, status)

Step 2: Core Realtime Transport Foundation
  ├── Install `ws` dependency and type definitions
  ├── Build `src/modules/realtime/websocketServer.ts` (attach to HTTP server)
  ├── Implement handshake JWT authentication & session verification
  ├── Implement channel subscription manager with strict RBAC/ownership checks
  └── Add ping/pong heartbeat and connection lifecycle cleanup

Step 3: Ephemeral Redis Live GPS Service
  ├── Implement `src/modules/realtime/liveLocationService.ts`
  ├── Ingest GPS pings into Redis with 60s TTL
  ├── Enforce anti-spoofing velocity check (speed <= 120 km/h)
  └── Broadcast live coordinates to `order:{orderId}` room during active delivery

Step 4: Outbox Relayer & Domain Event Emitters
  ├── Integrate Outbox writer helper into database `transaction` wrapper
  ├── Update `orderService`, `dispatchService`, `paymentService` to stage outbox events
  └── Implement lightweight Outbox Relayer to publish outbox events to Redis Pub/Sub

Step 5: Push Notification & Device Token Subsystem
  ├── Build `src/modules/notifications/deviceTokenService.ts`
  ├── Implement `src/modules/notifications/notificationService.ts`
  ├── Provide `MockPushProvider` for offline testing and deterministic CI
  └── Mount `/api/v1/notifications/tokens` routes for mobile/web device registration

Step 6: Comprehensive Verification & Test Suite
  ├── Create `tests/sprint8-realtime.test.ts` verifying WS auth, room authorization, GPS streaming
  ├── Run full master suite `run-all-tests.ts` to ensure 0 regressions across Sprints 1–7
  └── Validate with `compile_applet` and `lint_applet`
```
