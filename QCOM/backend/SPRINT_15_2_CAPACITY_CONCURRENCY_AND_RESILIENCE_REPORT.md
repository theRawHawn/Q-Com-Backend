# SPRINT 15.2 — BACKEND CAPACITY, CONCURRENCY & OPERATIONAL RESILIENCE REPORT

**Project:** QCOM — Unified Quick Commerce Backend Engine  
**Repository:** `https://github.com/theRawHawn/Q-Com-Backend`  
**Branch:** `main`  
**Target:** `QCOM/backend`  
**Sprint:** 15.2  
**Status:** PASS — PRODUCTION RESILIENCE HARDENED  
**Date:** November 7, 2026  

---

## 1. EXECUTIVE SUMMARY

Sprint 15.2 focused on strengthening QCOM's backend capacity, concurrency controls, and operational resilience across six core architectural pillars:
1. **Rate Limiting:** Granular, identity-aware sliding-window rate limiters with graceful degradation.
2. **Latency:** Complete elimination of the N+1 query bottleneck in order history queries and creation of composite indexes for hot-path lookups.
3. **Throughput:** PostgreSQL connection pool protection with strict statement and query timeout limits.
4. **Timeouts:** Ambiguous outcome preservation, bounded retries with jitter, and fail-safe timeout handling.
5. **Concurrency:** Atomic single-winner seller order acceptance and delivery task assignment with race-condition prevention.
6. **Backpressure:** Outbox queue depth monitoring, backlog metrics, adaptive throttling warnings, and guaranteed durable event retention.

All changes were implemented within the existing Express/PostgreSQL/Redis architecture without prematurely introducing microservices, Kafka, or RabbitMQ. Protected frontend source trees remained completely untouched.

---

## 2. PRE-IMPLEMENTATION INSPECTION & GAP MATRIX

An exhaustive code audit of `QCOM/backend` prior to implementation revealed the following architectural state and operational gaps:

| System Domain | Existing State | Identified Gap | Sprint 15.2 Remediation |
|---|---|---|---|
| **Rate Limiting** | OTP, auth, checkout, webhook, and inventory mutation limiters were implemented in `rateLimiter.ts`. | Missing catalog search, cart operations, rider telemetry, and sensitive admin operation limiters. | Added `catalogSearchRateLimiter` (60 req/min, open degradation), `cartRateLimiter` (60 req/min, open degradation), `sellerActionRateLimiter` (45 req/min, closed), `riderTelemetryRateLimiter` (60 req/min, open), and `adminSensitiveRateLimiter` (30 req/min, closed). |
| **Order History Latency** | `orderService.getOrders(userId)` fetched orders via SQL, then iterated through each order row to issue a separate `SELECT * FROM order_items WHERE order_id = $1`. | Classic N+1 query pattern generating $1 + N$ database round-trips; unacceptable latency under load. | Replaced row-by-row item queries with a single batch `WHERE order_id IN (...)` fetch, reducing database round-trips from $1 + N$ to exactly 2. |
| **Database Pool Safety** | `connection.ts` configured connection count, idle timeout, and connection timeout, but lacked statement/query execution timeouts. | Runaway or slow queries could hold connections indefinitely and exhaust pool capacity. | Configured `DATABASE_STATEMENT_TIMEOUT_MS` (10s) and `DATABASE_QUERY_TIMEOUT_MS` (10s) on `pg.Pool`. |
| **Delivery Task Concurrency** | `partnerCompatibilityRoutes.ts` evaluated task state in JavaScript (`if (trip.status !== 'BROADCASTING')`), then ran an unconditional `UPDATE delivery_trips SET status = 'ACCEPTED'`. | Race condition: concurrent riders both seeing `BROADCASTING` could both claim the same trip. | Implemented atomic conditional update: `UPDATE delivery_trips SET status = 'ACCEPTED' WHERE id = $1 AND status = 'BROADCASTING' RETURNING *`. Secondary claimants receive `HTTP 409 TASK_ALREADY_CLAIMED`. |
| **Seller Order Acceptance** | No dedicated atomic single-winner seller order acceptance route existed; order updates were manual or unconstrained. | Multiple seller staff/terminals could accept the same placed order concurrently without serialized state transition. | Added `POST /api/orders/:orderId/accept-seller` with atomic conditional transition `WHERE id = $1 AND status = 'placed' RETURNING *`. Losers receive `HTTP 409 ORDER_ALREADY_ACCEPTED`. |
| **Admin Rider Assignment** | `adminCompatibilityRoutes.ts` line 408 executed an unconditional `UPDATE delivery_trips SET rider_id = $1, status = 'ACCEPTED'` without checking current trip lifecycle state. | Unconditional assignment could overwrite active deliveries (`IN_TRANSIT`, `DELIVERED`) or reassign already accepted trips. | Added state guard restricting assignment strictly to `status IN ('BROADCASTING', 'CREATED', 'OFFERED', 'PENDING')`. Trips in `ACCEPTED` or transit return `HTTP 409 ALREADY_ASSIGNED` / `INVALID_TRIP_STATE`. |
| **Outbox Backpressure** | `outboxService.ts` processed batches with leases, but lacked queue-depth observation and admission backpressure metrics. | System could not monitor pending backlog depth or signal adaptive backoff under traffic spikes. | Implemented `getPendingQueueDepth()` and `getBackpressureMetrics(overloadThreshold)`, emitting structured warnings and recommended backoff ms. |

---

## 3. RATE LIMITING ARCHITECTURE & CONTROLS

The rate-limiting layer utilizes a sliding-window log/counter algorithm evaluated against Redis, falling back gracefully according to endpoint sensitivity:

### 3.1 Rate Limit Tiers

1. **Customer Catalog Search (`catalogSearchRateLimiter`):**
   - Limit: 60 requests per minute
   - Scope: `catalog:search`
   - Key: Authenticated user ID or remote IP
   - Failure Mode: `'open'` (Returns `X-RateLimit-Status: unavailable` on Redis downtime without failing legitimate customer product browsing)

2. **Customer Cart Operations (`cartRateLimiter`):**
   - Limit: 60 requests per minute
   - Scope: `cart:operation`
   - Key: Authenticated user ID or remote IP
   - Failure Mode: `'open'`

3. **Seller Operations (`sellerActionRateLimiter`):**
   - Limit: 45 requests per minute
   - Scope: `seller:action`
   - Key: Authenticated seller user ID and remote IP
   - Failure Mode: `'closed'` (Enforces admission limits; rejects with 503 + Retry-After on cache unavailability)

4. **Delivery Rider Telemetry (`riderTelemetryRateLimiter`):**
   - Limit: 60 requests per minute
   - Scope: `rider:telemetry`
   - Key: Authenticated rider user ID or remote IP
   - Failure Mode: `'open'`

5. **Sensitive Administrative Actions (`adminSensitiveRateLimiter`):**
   - Limit: 30 requests per minute
   - Scope: `admin:sensitive`
   - Key: Authenticated admin user ID and remote IP
   - Failure Mode: `'closed'`

### 3.2 Response Headers Standard
When rate limits are evaluated, all responses include:
- `X-RateLimit-Limit`: Maximum requests permitted in the window
- `X-RateLimit-Remaining`: Remaining requests allowed in the current window
- `X-RateLimit-Reset`: Seconds remaining until window reset
- `Retry-After`: Included on `HTTP 429 Too Many Requests` responses

---

## 4. LATENCY OPTIMIZATION & N+1 QUERY RESOLUTION

### 4.1 Root Cause & Remediation in `orderService.getOrders`
Prior to Sprint 15.2, `orderService.getOrders(userId)` executed:
```sql
SELECT o.* FROM orders o WHERE o.user_id = $1 ORDER BY o.created_at DESC;
```
It then iterated over every row:
```typescript
for (const r of res.rows) {
  const itemsRes = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [r.id]);
  ...
}
```
For a user with 20 orders, this caused 21 sequential database queries. Under concurrent customer load, this saturated the connection pool and elevated p99 latency.

**Remediation:**
`orderService.getOrders` was refactored to extract all order IDs from the first result set and perform a single bulk lookup:
```typescript
const orderIds = res.rows.map(r => r.id);
const placeholders = orderIds.map((_, i) => `$${i + 1}`).join(', ');
const itemsRes = await pool.query(
  `SELECT * FROM order_items WHERE order_id IN (${placeholders})`,
  orderIds
);
```
Line items are grouped in an in-memory `Map<string, OrderItemRecord[]>`.
**Result:** Exactly **2 database round-trips** regardless of the number of orders returned, completely resolving the N+1 latency bottleneck.

---

## 5. THROUGHPUT & DATABASE POOL CONFIGURATION

To prevent rogue queries or long-running transactions from holding pooled connections indefinitely, PostgreSQL configuration in `connection.ts` and `env.ts` was enhanced:

- `DATABASE_MAX_POOL_SIZE`: Configured pool size (default: 10, range: 1–50)
- `DATABASE_IDLE_TIMEOUT_MS`: 30,000ms idle client reap threshold
- `DATABASE_CONNECTION_TIMEOUT_MS`: 5,000ms connection acquisition timeout
- `DATABASE_STATEMENT_TIMEOUT_MS`: **10,000ms (10 seconds)** statement timeout
- `DATABASE_QUERY_TIMEOUT_MS`: **10,000ms (10 seconds)** client query timeout

Any query exceeding 10 seconds is automatically terminated by PostgreSQL, releasing the connection back to the pool and preventing cascading connection pool exhaustion.

---

## 6. TIMEOUTS & RETRY SAFEGUARDS

All external interactions and recovery workers adhere to the following principles:
- **Ambiguous Outcome Preservation:** Ambient timeouts during payment capture or refund processing NEVER mark the transaction as `FAILED`. The status is held in `PROCESSING` / `REFUND_PENDING` with an idempotency record until authoritative confirmation or webhook reconciliation arrives.
- **Full-Jitter Bounded Backoff:** Retry loops use exponential backoff with full decorrelated jitter to avoid the thundering herd problem.
- **Worker Leases:** Recovery workers use UUID leases with expiration timestamps (`lease_expires_at`), preventing dual-worker split-brain execution across multiple instances.

---

## 7. CONCURRENCY & RACE-CONDITION REMEDIATION

### 7.1 Atomic Single-Winner Seller Order Acceptance
- **Route:** `POST /api/orders/:orderId/accept-seller` (and alias `/api/orders/:orderId/accept`)
- **Protection:**
  ```sql
  UPDATE orders
  SET status = 'accepted', updated_at = NOW()
  WHERE id = $1 AND status = 'placed'
  RETURNING id, order_number, user_id, merchant_id, status, total_amount;
  ```
- **Concurrency Behavior:** When multiple seller terminals or browser tabs submit acceptance concurrently, the database serializes row locks. Exactly **one** request achieves `rowCount === 1` and returns `HTTP 200 OK`. All concurrent contenders receive `rowCount === 0` and are served `HTTP 409 ORDER_ALREADY_ACCEPTED`.

### 7.2 Atomic Single-Winner Delivery Task Acceptance
- **Route:** `POST /api/tasks/:taskId/accept`
- **Protection:**
  ```sql
  UPDATE delivery_trips 
  SET status = 'ACCEPTED', accepted_at = NOW() 
  WHERE (id = $1 OR order_id = $1) AND status = 'BROADCASTING' 
  RETURNING id, order_id, status;
  ```
- **Concurrency Behavior:** Only the first rider claiming the broadcasted trip transitions it to `ACCEPTED` (`HTTP 200`). Any concurrent rider attempting to claim the same task receives `HTTP 409 TASK_ALREADY_CLAIMED`.

### 7.3 Guarded Admin Rider Assignment
- **Route:** `POST /api/admin/orders/:orderId/assign-rider`
- **Protection:** Restricted strictly to trips in `'BROADCASTING'`, `'CREATED'`, `'OFFERED'`, or `'PENDING'` status. If a trip is already `ACCEPTED` or in transit, the reassignment is blocked with `HTTP 409 ALREADY_ASSIGNED` or `HTTP 409 INVALID_TRIP_STATE`.

---

## 8. BACKPRESSURE & OUTBOX QUEUE DEPTH MONITORING

The transactional outbox engine (`outboxService.ts`) now provides explicit backpressure observability:
- `getPendingQueueDepth()`: Returns the exact count of un-relayed domain events in `PENDING` status.
- `getBackpressureMetrics(overloadThreshold)`: Evaluates whether the pending queue exceeds the safety threshold (default: 5,000 events). When overloaded, it logs a structured warning and calculates a recommended adaptive backoff (`recommendedBackoffMs`).
- **Durable Event Retention:** Outbox events are NEVER dropped. Events that exceed retry limits are marked `FAILED` with full payload and error stack preserved in the database for dead-letter reprocessing and auditability.

---

## 9. MIGRATION 026 DETAILS

**Migration File:** `QCOM/backend/migrations/026_sprint15_2_capacity_indexes_and_concurrency.sql`

```sql
-- Migration 026: Sprint 15.2 Backend Capacity, Concurrency & Operational Resilience Indexes

-- 0. Extend orders status CHECK constraint to support 'accepted' status
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (
    status IN (
        'placed', 'accepted', 'picking', 'packed', 'out_for_delivery', 'arriving', 'delivered', 
        'cancelled', 'return_requested', 'return_approved', 'return_rejected', 
        'return_picked_up', 'returned'
    )
);

-- 1. Orders lookup by customer with reverse chronological sorting
CREATE INDEX IF NOT EXISTS idx_orders_user_placed_at
    ON orders(user_id, placed_at DESC);

-- 2. Order items join by order_id
CREATE INDEX IF NOT EXISTS idx_order_items_order_id
    ON order_items(order_id);

-- 3. Merchant orders lookup filtered by status
CREATE INDEX IF NOT EXISTS idx_orders_merchant_status
    ON orders(merchant_id, status);

-- 4. Delivery trips lookup by order and trip status
CREATE INDEX IF NOT EXISTS idx_delivery_trips_order_status
    ON delivery_trips(order_id, status);

-- 5. Store inventory composite lookup for high-frequency checkout reservation
CREATE INDEX IF NOT EXISTS idx_store_inventory_lookup
    ON store_inventory(merchant_id, product_id);

-- 6. Catalog products search by category and name
CREATE INDEX IF NOT EXISTS idx_products_category_name
    ON products(category, name);

-- 7. Payment intents lookup by order_id and status
CREATE INDEX IF NOT EXISTS idx_payment_intents_order_status
    ON payment_intents(order_id, status);

-- 8. Refunds lookup by order_id and status
CREATE INDEX IF NOT EXISTS idx_refunds_order_status
    ON refunds(order_id, status);

-- 9. Outbox queue depth and backpressure monitoring index
CREATE INDEX IF NOT EXISTS idx_outbox_events_backpressure
    ON outbox_events(status, created_at)
    WHERE status = 'PENDING';
```

---

## 10. TEST COVERAGE & VERIFICATION RESULTS

### 10.1 Dedicated Test Suite: `sprint15-2-capacity-concurrency-and-resilience.test.ts`

| Pillar | Test Case | Target Control | Observed Result | Status |
|---|---|---|---|---|
| **1. Rate Limiting** | Test 1.1 | Sliding-window threshold enforcement | Enforced limit of 3 requests; 4th request returned HTTP 429 with `Retry-After: 60`, `X-RateLimit-Limit: 3`, `X-RateLimit-Remaining: 0`. | **PASS** |
| **1. Rate Limiting** | Test 1.2 | Graceful cache degradation (`failureMode: open`) | Request permitted on simulated Redis downtime; emitted `X-RateLimit-Status: unavailable`. | **PASS** |
| **2. Latency** | Test 2.1 | N+1 query elimination in `getOrders` | Retrieved 3 orders and 6 items in exactly **2 database queries** instead of 4+. | **PASS** |
| **3. Throughput** | Test 3.1 | Statement timeout protection | `DATABASE_STATEMENT_TIMEOUT_MS: 10000` verified in runtime environment. | **PASS** |
| **4. Concurrency** | Test 4.1 | Concurrent seller order acceptance race | Two concurrent accept requests: exactly 1 winner (HTTP 200 OK) and 1 loser (HTTP 409 ORDER_ALREADY_ACCEPTED). | **PASS** |
| **5. Concurrency** | Test 5.1 | Concurrent delivery task claim race | Two concurrent task claim requests: exactly 1 winner (HTTP 200 OK) and 1 loser (HTTP 409 TASK_ALREADY_CLAIMED). | **PASS** |
| **5. Concurrency** | Test 5.2 | Guarded admin rider assignment | Attempt to re-assign an already accepted delivery trip blocked with HTTP 409 ALREADY_ASSIGNED. | **PASS** |
| **6. Backpressure** | Test 6.1 | Outbox queue depth & backpressure metrics | Accurately calculated queue depth; emitted warning and recommended backoff ms when safety threshold exceeded. | **PASS** |

### 10.2 Build Verification Commands

1. **Backend TypeScript Type Check (`tsc --noEmit`):**
   ```bash
   npm --prefix QCOM/backend run build
   # Exit code: 0 (Clean compilation, zero errors)
   ```

2. **Frontend & Applet Root Build:**
   ```bash
   npm run build
   # Built in 2.59s (Vite production bundle generated successfully)
   ```

3. **AI Studio Applet Tools:**
   ```
   compile_applet: Build succeeded - the applet is compiled
   lint_applet: Linting completed successfully ($ tsc --noEmit)
   ```

---

## 11. OPERATIONAL BASELINE & PRODUCTION RECOMMENDATIONS

1. **PostgreSQL Statement Timeout:** Ensure `DATABASE_STATEMENT_TIMEOUT_MS` (10s) remains enabled in staging and production to prevent long-running table locks from stalling the connection pool.
2. **Redis Memory Sizing:** The rate limiter utilizes sliding-window keys with 60-second TTLs; Redis memory usage scales linearly with active user concurrency ($O(N)$ with active actors). Monitor Redis memory fragmentation in high-traffic zones.
3. **Outbox Worker Autoscale:** Monitor `outboxService.getPendingQueueDepth()`. If the backlog consistently exceeds 1,000 events, scale background worker instances horizontally; worker leases ensure conflict-free concurrent batch claiming.
4. **Read-Replica Routing:** For future growth beyond 10,000 req/sec, route catalog read queries (`/catalog/products`) to PostgreSQL read replicas using composite index `idx_products_category_name`.

---

## 12. CONCLUSION

Sprint 15.2 has successfully resolved the identified architectural gaps in rate limiting, query latency, pool timeouts, concurrency safety, and backpressure monitoring. QCOM's backend engine is hardened and resilient for large-scale quick-commerce operations.
