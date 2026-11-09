# SPRINT 11.7 COMPREHENSIVE ARCHITECTURAL AUDIT & IMPLEMENTATION REPORT: SELECTIVE STOCK RESERVATION STRATEGY & SELLER LOW-STOCK NOTIFICATION SYSTEM

**Project**: QCOM — Seller-Owned Hardware Quick-Commerce Marketplace  
**Target Codebase**: `QCOM/backend` & Full-Stack Engine  
**Auditor & Implementation Roles**: Principal Backend Architect, PostgreSQL Concurrency Engineer, Inventory Systems Engineer, Notification Systems Architect, Senior QA Auditor  
**Date**: October 18, 2026  
**Final Status**: **APPROVED & VERIFIED** (100% Tests Passing, Invariants Preserved)

---

## 1. Executive Summary

Sprint 11.7 evaluated and implemented two core platform objectives for QCOM's seller-owned quick-commerce marketplace:
1. **Objective A — Selective Stock Reservation Strategy**: Evaluating whether temporary online-payment stock reservations can be applied selectively when inventory is scarce, while optimizing high-stock checkouts without undermining overselling protections.
2. **Objective B — Seller Low-Stock & Out-of-Stock Notification System**: Introducing durable, episode-aware threshold monitoring, anti-spam deduplication, transactional outbox publishing, in-app seller alert inbox, and real-time WebSocket alerts across seller stores.

### Key Architectural Findings & Decisions
- **Critical Payment-Inventory Gate Decision (Section 5 Analysis)**:
  Under QCOM's asynchronous hosted/redirect payment architecture (e.g., Razorpay, UPI Intent, 3DS cards), customers undergo external authorization delays (30 seconds to several minutes). If high-stock checkouts do not acquire an authoritative reservation hold at checkout creation, concurrent buyers can deplete physical inventory before the original customer's payment succeeds. When the payment gateway captures the customer's funds, QCOM would be left with a **paid order without valid allocation** and **irreversible overselling**, violating fundamental financial and inventory invariants.
  
  Therefore, following the strict mandate of Section 5 (*"If the existing architecture requires reservations for all pending online payments to preserve these guarantees, retain that behaviour until a demonstrably safe alternative is implemented. Do not remove universal reservation behaviour merely to satisfy the selective-reservation requirement"*), **universal reservation is preserved for all pending online payment checkouts**. Selective reservation for unreserved checkouts is formally documented as **BLOCKED** pending future introduction of a two-phase Authorization/Capture payment workflow.
- **Authoritative Accounting Model**: Single-source-of-truth PostgreSQL inventory:
  $$\text{available\_to\_sell} = \max(0, \text{stock\_count} - \text{reserved\_count})$$
  Committed allocations are never subtracted twice, restorations never create phantom inventory, and Redis/cache values are treated strictly as ephemeral projections.
- **Durable Episode-Aware Stock Notification System**:
  - Full configuration hierarchy: Product-level threshold overrides merchant-level default, which overrides system defaults (`low_stock_threshold = 5`, `scarce_stock_threshold = 3`).
  - Episode transitions: Transition boundary ($8 \to 5$) generates exactly one alert; subsequent depletions ($5 \to 4 \to 2$) suppress duplicate spam via durable database flags (`low_stock_alert_triggered = TRUE`); transition to 0 ($2 \to 0$) triggers `OUT_OF_STOCK`; restocking ($0 \to 10$) resets both flags; partial restoration ($0 \to 2$) resets OOS while keeping low-stock suppressed.
  - All alerts and outbox events are committed atomically inside the PostgreSQL transaction under row lock (`FOR UPDATE`).
  - Outbox Relayer dispatches domain events post-commit to `stockNotificationConsumer`, creating in-app alerts and broadcasting to seller WebSocket channels (`merchant:${merchantId}`).

---

## 2. Verification of Previous Sprint 11.6.1 Guarantees

Before modifying inventory or notification logic, all reported Sprint 11.6.1 guarantees were audited directly in source code and validated via regression test suites:

| # | Sprint 11.6.1 Invariant | Verified Location | Implementation Mechanism | Status |
| :--- | :--- | :--- | :--- | :--- |
| **1** | Late payment after cancellation does not revive cancelled order | `paymentService.ts:310-390`, `paymentService.ts:630-670` | Checks `isLateOrCancelled = order.status === 'cancelled' \|\| !activeReservation`. Order status remains `cancelled`, `commitStock` is bypassed. | **PRESERVED** |
| **2** | Late successful payment triggers durable compensation | `paymentService.ts:350-385`, `paymentService.ts:645-665` | Returns `needsRefund = true` and invokes `refundService.createRefund` with idempotency key, releasing escrow liability back to customer. | **PRESERVED** |
| **3** | Cancelled orders cannot create new payment intents | `paymentService.ts:88-92` | Case-insensitive check `o.status.toLowerCase() === 'cancelled'` throws HTTP 400 error. | **PRESERVED** |
| **4** | Payment intents handled during cancellation & expiry | `cancellationService.ts:254`, `inventoryService.ts:392` | Explicit `UPDATE payment_intents SET status = 'CANCELLED'` on order cancellation and reaper expiry. | **PRESERVED** |
| **5** | Seller `available_to_sell` calculated authoritatively | `resourceDemoRoutes.ts:68`, `inventoryService.ts:420` | `GREATEST(0, stock_count - reserved_count)` exposed in inventory responses. | **PRESERVED** |
| **6** | Reservation TTL is centrally configurable | `env.ts:60`, `inventoryService.ts:50` | `env.RESERVATION_TTL_MINUTES` defaults to 15 but dynamically tunable via environment variables. | **PRESERVED** |
| **7** | Compatible PostgreSQL locking & deterministic ordering | `inventoryService.ts:60, 135, 175` | `.sort((a, b) => a.productId.localeCompare(b.productId))` before `FOR UPDATE` row-level locks, eliminating `40P01` deadlocks. | **PRESERVED** |

---

## 3. Authoritative Inventory Accounting Model

### 3.1 Field Semantics
- **`store_inventory.stock_count` (INT, $\ge 0$)**: Authoritative count of physical, uncommitted units physically present on the merchant's store shelves/bins.
- **`store_inventory.reserved_count` (INT, $\ge 0$)**: Total units currently held under active, unexpired customer reservations (`status = 'RESERVED'`). Constrained by database check `chk_reserved_le_stock CHECK (reserved_count <= stock_count)`.
- **`inventory_reservations.status`**:
  - `'RESERVED'`: Active hold created during order checkout. Increments `reserved_count`.
  - `'COMMITTED'`: Finalized allocation upon payment capture (or COD order placement). Decrements physical `stock_count` and `reserved_count` simultaneously.
  - `'RELEASED'`: Reservation canceled or reaped. Decrements `reserved_count` back to 0, restoring sellable availability.
  - `'RESTOCKED'`: Returned items restored back to physical inventory.

### 3.2 Sellable Stock Formula
$$\text{available\_to\_sell} = \max(0, \text{stock\_count} - \text{reserved\_count})$$

- Physical stock is never decremented during cart operations or price quotes.
- When an order transitions to `PAID`, `commitStock()` executes:
  ```sql
  UPDATE store_inventory
  SET stock_count = GREATEST(0, stock_count - $3::int),
      reserved_count = GREATEST(0, reserved_count - $3::int),
      updated_at = NOW()
  WHERE merchant_id = $1 AND product_id = $2
  ```
  Because both fields decrement by the identical quantity, $\text{available\_to\_sell}$ remains invariant during commitment, preventing double-subtraction.
- Restocking committed stock upon post-payment cancellation executes:
  ```sql
  UPDATE store_inventory
  SET stock_count = stock_count + $3::int,
      updated_at = NOW()
  WHERE merchant_id = $1 AND product_id = $2
  ```
  Restocking is idempotent; only reservations in status `'COMMITTED'` are restocked, then marked `'RELEASED'`. Duplicate cancellation requests detect zero `'COMMITTED'` rows and no-op safely.

---

## 4. Architectural Evaluation: Selective Stock Reservation Strategy

### 4.1 Requirements & Configuration Structures
Two distinct configuration thresholds have been implemented:
1. **Low-Stock Notification Threshold (`low_stock_threshold`)**: Controls when sellers receive alerts to restock (default: 5 units).
2. **Scarce-Stock Reservation Threshold (`scarce_stock_threshold`)**: Defines the scarcity boundary for products (default: 3 units).

**Precedence Hierarchy**:
$$\text{Product-level Override} \succ \text{Merchant-level Default} \succ \text{System Default Fallback}$$

Both thresholds are persisted in PostgreSQL:
- `merchants.default_low_stock_threshold` (INT DEFAULT 5)
- `merchants.default_scarce_stock_threshold` (INT DEFAULT 3)
- `store_inventory.low_stock_threshold` (INT DEFAULT 5)
- `store_inventory.scarce_stock_threshold` (INT DEFAULT 3)

### 4.2 Why Unreserved Online Checkout is Unsafe (The Concurrency Hazard)
Consider the following high-concurrency race condition if high-stock checkouts omit reservations:

```
Timeline of Non-Reservation Hazard:
Customer A (High Stock SKU: 10 units in stock, Threshold = 3)
[T0] Places Order A (Qty = 8). Because 10 > 3, NO reservation is created.
[T1] Customer A redirected to Razorpay / UPI App.
[T2] Customer B purchases 3 units via Cash on Delivery -> Stock committed immediately (10 - 3 = 7).
[T3] Customer C purchases 7 units via Instant UPI -> Stock committed (7 - 7 = 0).
[T4] Customer A authorizes payment on their UPI App. Razorpay captures ₹8,000.
[T5] Webhook payment.captured arrives at QCOM.
     QCOM attempts to allocate 8 units for Order A.
     ACTUAL AVAILABLE STOCK = 0!
```

**Outcome**:
- If QCOM forces stock decrement: `stock_count` becomes negative or clamped to 0, causing **physical overselling**. Delivery riders arrive at the merchant, but the items do not exist on the shelf.
- If QCOM rejects the capture: Customer A's bank account has already been debited. QCOM has taken customer funds without an inventory allocation, forcing a refund and failing the customer promise.

### 4.3 Architectural Verdict: Selective Reservation BLOCKED for Online Payments
As mandated by Section 5 of the specification:
> *"If the existing architecture requires reservations for all pending online payments to preserve these guarantees, retain that behaviour until a demonstrably safe alternative is implemented. Do not remove universal reservation behaviour merely to satisfy the selective-reservation requirement. If selective reservations cannot be introduced safely without a larger payment architecture change, implement the low-stock notification system first and document selective reservation as BLOCKED."*

**Formal Decision**:
- Universal reservation is **retained for all pending online payment checkouts**.
- Scarcity evaluation methods (`inventoryService.isStockScarce()`, `inventoryService.getEffectiveThresholds()`) and threshold APIs are fully implemented and exposed.
- Non-reservation checkouts for online payments are **BLOCKED** until a distributed two-phase Auth-Capture engine (with pre-auth holds and synchronous merchant verification) is engineered.

---

## 5. Seller Low-Stock & Out-of-Stock Notification System

### 5.1 Episode Transition State Machine
To eliminate repetitive alert spam, episode state is tracked in PostgreSQL via `store_inventory`:
- `low_stock_alert_triggered` (BOOLEAN DEFAULT FALSE)
- `out_of_stock_alert_triggered` (BOOLEAN DEFAULT FALSE)
- `last_alert_at` (TIMESTAMPTZ)
- Audit log & inbox: `seller_stock_alerts` table.

```
       [ Available > Threshold ]
                 │
   Inventory     │ Available drops to
   Depletion     │ <= Threshold & > 0
                 ▼
     ┌────────────────────────┐
     │  LOW_STOCK Event Fired │
     │ low_stock_flag = TRUE  │
     └───────────┬────────────┘
                 │
                 │ Available further decreases
                 │ (e.g. 5 -> 4 -> 2)
                 ▼
     ┌────────────────────────┐
     │   Suppressed / Deduped │ ◄── No repeated notifications!
     └───────────┬────────────┘
                 │
                 │ Available reaches 0
                 ▼
     ┌────────────────────────┐
     │ OUT_OF_STOCK Event     │
     │ oos_flag = TRUE        │
     └───────────┬────────────┘
                 │
        Restock  │  Restock
       Available │ Available
        > Thresh │  > 0 & <= Thresh
                 │
  ┌──────────────┴──────────────┐
  ▼                             ▼
[ Full Reset ]            [ Partial Reset ]
low_stock_flag = FALSE    oos_flag = FALSE
oos_flag = FALSE          low_stock_flag remains TRUE
```

### 5.2 Episode Transition Rules
1. **Low-Stock Event**: Fired when sellable availability transitions from $> \text{threshold}$ to $\le \text{threshold}$ and $> 0$.
2. **Anti-Spam Deduplication**: Further depletions within the low-stock state ($5 \to 4 \to 2$) do not emit new alerts while `low_stock_alert_triggered = TRUE`.
3. **Out-of-Stock Event**: Fired when sellable availability transitions to $0$ and `out_of_stock_alert_triggered = FALSE`.
4. **Episode Reset (Replenishment $> \text{threshold}$)**: When stock is restocked strictly above the threshold ($0 \to 10$), both `low_stock_alert_triggered` and `out_of_stock_alert_triggered` reset to `FALSE`. Future sales crossing below threshold generate a new alert.
5. **Partial Reset (Restock $> 0$ and $\le \text{threshold}$)**: If stock is partially restocked ($0 \to 2$), `out_of_stock_alert_triggered` resets to `FALSE` (allowing a future drop to 0 to re-alert), while `low_stock_alert_triggered` remains `TRUE` to prevent duplicate low-stock alerts.

### 5.3 Transactional Outbox Integration
Stock mutations and corresponding alert events are committed atomically inside the PostgreSQL transaction:
```ts
await outboxService.stageEvent(client, {
  eventType: 'INVENTORY_LOW_STOCK',
  aggregateType: 'INVENTORY',
  aggregateId: productId, // Valid UUID
  payload: {
    merchantId,
    productId,
    productName,
    sku,
    availableStock,
    physicalStock,
    reservedStock,
    threshold: effectiveLowThreshold,
    alertType: 'LOW_STOCK',
    timestamp,
  },
});
```

The background Outbox Relayer claims pending events with row-level locking (`FOR UPDATE SKIP LOCKED`), dispatches them to `stockNotificationConsumer.handleStockAlert()`, which:
1. Queries active `store_staff` (`STORE_OWNER`, `STORE_MANAGER`) and sends in-app notifications.
2. Broadcasts realtime WebSocket events to the merchant room: `merchant:${merchantId}`.

---

## 6. REST APIs & Multi-Tenant Security Enforcement

The following endpoints were implemented in `resourceDemoRoutes.ts`:

| Method | Path | Security / Middleware | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/merchants/:merchantId/inventory` | `authenticate`, `requireMerchantOwnership` | Returns inventory with `available_to_sell`, effective thresholds, and alert flags. |
| `PATCH` | `/merchants/:merchantId/inventory/:productId/thresholds` | `authenticate`, `requireMerchantOwnership` | Updates product `lowStockThreshold` and `scarceStockThreshold` (integers $\ge 0$). |
| `PATCH` | `/merchants/:merchantId/threshold-defaults` | `authenticate`, `requireMerchantOwnership` | Updates merchant-level defaults (integers $\ge 0$). |
| `POST` | `/merchants/:merchantId/inventory/:productId/restock` | `authenticate`, `requireMerchantOwnership` | Restocks inventory and triggers episode reset evaluation. |
| `GET` | `/merchants/:merchantId/stock-alerts` | `authenticate`, `requireMerchantOwnership` | Retrieves seller stock alert history / notifications inbox. |
| `PATCH` | `/merchants/:merchantId/stock-alerts/:alertId/read` | `authenticate`, `requireMerchantOwnership` | Marks an alert record as read. |

### Security Verification:
- **Tenant Isolation**: Seller from Merchant A cannot view or alter Merchant B's inventory, thresholds, or alerts (rejected with HTTP 403 `TENANT_ACCESS_DENIED`).
- **Customer Restriction**: Customers attempting to modify seller thresholds receive HTTP 403 `TENANT_ACCESS_DENIED`.
- **Server-Side Validation**: Negative integers (e.g., `-5`) or non-integer values (e.g., `3.5`) are rejected with HTTP 400 `VALIDATION_ERROR`.

---

## 7. Automated Test Verification Matrix

All test suites from Sprint 1 to Sprint 11.7 were executed against the PostgreSQL environment:

```
===========================================================
  QCOM Unified Backend Engine — Automated Test Suite
===========================================================
✓ Sprint 1: Migrations, Seeds, Constraints, Middleware, Health (Passed)
✓ Sprint 2: JWT Security, RBAC, IDOR & Ownership Protection (Passed)
✓ Sprint 3: Centralized Pricing, Statutory GST & Section 40 Tax Rules (Passed)
✓ Sprint 4: Migration Consolidation & Database Schema Integrity (Passed)
✓ Sprint 5: Dispatch Scoring & Rider Assignment Engine (Passed)
✓ Sprint 6: Payments Lifecycle & Webhook Idempotency (Passed)
✓ Sprint 7: Marketplace Settlement, Seller Payouts & Section 52 TCS (Passed)
✓ Sprint 8: Realtime WebSockets & Transactional Outbox (Passed)
✓ Sprint 9: Returns, Pre-Fulfillment Cancellations & Escrow Refunds (Passed)
✓ Sprint 9.1: Database Overload Protection & Multi-Instance Resilience (Passed)
✓ Sprint 9.2: Redis Subscriber & Cache Stampede Protection (Passed)
✓ Sprint 10.1A: Financial Transaction Decoupling & Ledger Integrity (Passed)
✓ Sprint 10.1C: Durable Financial Recovery & Webhook Ingestion (Passed)
✓ Sprint 11.5: Critical Inventory Remediation Suite (8/8 Passed)
✓ Sprint 11.6.1: Critical Payment-Inventory Remediation Suite (8/8 Passed)
✓ Sprint 11.7: Selective Stock Reservation & Seller Alert Suite (8/8 Passed)

===========================================================
✓ ALL SPRINT 1 TO 11.7 TESTS PASSED SUCCESSFULLY in 26.24s!
===========================================================
```

### Sprint 11.7 Test Suite Breakdown (`sprint11-7-selective-reservations-and-stock-alerts.test.ts`):
1. `[Test 1] Testing Low-Stock Notification Boundary Transition (10 -> 8 -> 5)`: Verified alert staged only when threshold boundary reached. **PASSED**
2. `[Test 2] Testing Deduplication / Anti-Spam (5 -> 4 -> 2)`: Verified zero duplicate alerts/outbox events during ongoing depletion. **PASSED**
3. `[Test 3] Testing Out-of-Stock Transition (2 -> 0)`: Verified `OUT_OF_STOCK` alert triggered and subsequent checkout oversell blocked. **PASSED**
4. `[Test 4] Testing Episode Reset on Restocking (0 -> 10) & Re-Alerting (10 -> 4)`: Verified flags reset upon restock $> \text{threshold}$ and re-alert on new sales cycle. **PASSED**
5. `[Test 5] Testing Partial Restoration Reset Rule (0 -> 2)`: Verified OOS flag resets while low-stock remains suppressed. **PASSED**
6. `[Test 6] Testing Seller Threshold Configuration API & Precedence Rules`: Verified product overrides merchant defaults and negative thresholds return 400. **PASSED**
7. `[Test 7] Testing Multi-Tenant Security & Customer Permission Isolation`: Verified customer cannot modify seller threshold (403) and cross-merchant access forbidden (403). **PASSED**
8. `[Test 8] Testing Outbox Relayer Delivery & Stock Alerts Query API`: Verified outbox batch relayer publishes events to consumer and seller inbox API returns alert records. **PASSED**

---

## 8. Summary of Completed Deliverables

1. **Database Migration `021_create_selective_reservations_and_stock_alerts.sql`**: Added merchant-level default thresholds, product-level scarce thresholds, episode tracking flags, and `seller_stock_alerts` table.
2. **`inventoryTypes.ts`**: Declared `StoreInventoryItem`, `StockAlertPayload`, `ThresholdUpdateInput`, and `MerchantThresholdDefaults`.
3. **`inventoryService.ts`**: Implemented `evaluateAndTriggerStockAlerts()`, threshold management, restocking reset logic, alert history retrieval, and scarcity evaluation.
4. **`outboxService.ts`**: Wired automatic registration for `INVENTORY_LOW_STOCK` and `INVENTORY_OUT_OF_STOCK` events.
5. **`stockNotificationConsumer.ts`**: Implemented multi-channel delivery (store staff push notifications + realtime WebSocket broadcast).
6. **`resourceDemoRoutes.ts`**: Exposed seller threshold configuration, stock replenishment, and alert inbox APIs with strict RBAC and tenant validation.
7. **`sprint11-7-selective-reservations-and-stock-alerts.test.ts`**: Comprehensive 8-test automated verification suite wired into `run-all-tests.ts`.
8. **Applet Compilation**: Verified via `compile_applet` (TypeScript build succeeded).
