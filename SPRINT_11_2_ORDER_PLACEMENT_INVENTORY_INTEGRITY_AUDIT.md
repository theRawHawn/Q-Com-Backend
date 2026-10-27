# SPRINT 11.2 — ORDER-PLACEMENT STOCK DEDUCTION & REAL-TIME AVAILABILITY INTEGRITY
## Read-Only Architectural Audit & Implementation Plan

```
========================================================================================
QCOM SPRINT 11.2 PRODUCTION AUDIT
Target Repository: QCOM/backend
Audit Mode: STRICT READ-ONLY AUDIT & VERIFICATION PLAN
Date: 2026-10-13
Auditor: Senior Principal Distributed Systems, Inventory & Concurrency Architect
Decision: APPROVED WITH CONDITIONS (Strict Pre-Commit Boundary Verified; Outbox Event Bus & Validation Gaps Documented)
========================================================================================
```

---

## 1. EXECUTIVE SUMMARY

An exhaustive, non-intrusive, read-only architectural audit was conducted on `QCOM/backend` to verify the order-placement inventory deduction and real-time availability integrity rules. 

### Core Business Rules Verified:
1. **Zero Cart-Time Inventory Deduction**: Inventory is **never** deducted or reserved when items are added to a cart, when the cart is viewed, or when checkout is opened.
2. **PostgreSQL Authoritative Reservation & Deduction**: Stock deduction occurs atomically inside the transactional boundary of order placement (`OrderService.createOrder` & `InventoryService.reserveStock` / `commitStock`).
3. **Simultaneous Concurrency Protections**: PostgreSQL row-level locks (`FOR UPDATE`) ensure that two customers competing for the same inventory cannot oversell items.
4. **Idempotency Guarantee**: Retrying an order placement request using the same `Idempotency-Key` returns the original order result without duplicating order records or deducting stock twice.

This document presents the verified current state, lifecycle traces, concurrency modeling, defect findings, and recommended architectural enhancements.

---

## 2. PHASE 1 — VERIFIED CURRENT INVENTORY LIFECYCLE

### 2.1 Lifecycle Trace Matrix
| Action / Event | Inventory Impact | Database Mechanism | Verified? |
|---|---|---|---|
| **Adding item to cart** | **None** | Client-side state / localStorage / Session | **VERIFIED** (No DB writes or locks) |
| **Updating cart quantities** | **None** | Client-side state | **VERIFIED** |
| **Viewing cart** | **None** | Read-only check against `store_inventory` (`is_available`) | **VERIFIED** |
| **Opening checkout** | **None** | Authoritative pricing calculation via `PricingEngine.calculate` | **VERIFIED** |
| **Online payment initiation** | **None** | `paymentService` initializes intent | **VERIFIED** |
| **COD Order Submission & Placement** | **Deducted / Reserved** | Transactional `inventoryService.reserveStock` (`FOR UPDATE` row lock + `reserved_count` increment) + Order insertion | **VERIFIED** |
| **Online Order Submission & Placement**| **Deducted / Reserved** | Transactional `inventoryService.reserveStock` + Order insertion (Payment status PENDING) | **VERIFIED** |
| **Order Cancellation (Pre-fulfillment)**| **Restored** | `inventoryService.releaseStock` or `restockCommittedStock` | **VERIFIED** |
| **Payment Failure** | **Restored** | Stock reservation expires via `reapExpiredReservations` or explicit release | **VERIFIED** |

### 2.2 Exact Point of Inventory Change
Inventory stock is modified **strictly at order placement submission** (`POST /api/orders/create` or `/api/v1/orders/create`), inside the `orderService.createOrder` transaction (`orderService.ts:92`) which invokes `inventoryService.reserveStock` (`inventoryService.ts:44`).

---

## 3. PHASE 2 — SUCCESSFUL ORDER PLACEMENT & PAYMENT BEHAVIOR

### 3.1 COD Order Placement
- **Transaction Atomicity**: COD order creation executes within a single PostgreSQL transaction (`transaction` wrapper in `connection.ts:74`).
- **Atoms**: Stock reservation (`inventory_reservations` + `store_inventory.reserved_count`), `orders` insertion, `order_items` insertion, and `outbox_events` staging commit **atomically**. If any step fails, the entire transaction rolls back cleanly.

### 3.2 Online Payment Order Placement
- **Payment Lifecycle**: Orders are placed with `payment_status = 'PENDING'`. Once the order and stock reservation are successfully committed in PostgreSQL, the client initiates payment via `/api/payment/create-order`.
- **Authorization & Inventory Consistency**: Because inventory is reserved/deducted at order placement commit (post-pricing, pre-payment), payment authorization never races against uncommitted cart inventory.
- **Retry Resilience**: If an order is committed in PostgreSQL but the network drops before the HTTP response reaches the customer, retrying with the same `Idempotency-Key` returns the cached `COMPLETED` response body from `idempotency_keys` without re-running order creation or re-deducting stock (`orderRoutes.ts:93-97`).

---

## 4. PHASE 3 — SIMULTANEOUS ORDER PLACEMENT (CONCURRENCY MODELING)

| Scenario | Outcome | Oversell Risk? | Duplicate Orders? | Idempotency Preserved? |
|---|---|---|---|---|
| **Case A: 1 unit remaining, 2 concurrent orders** | Transaction 1 acquires `FOR UPDATE` lock, succeeds, and decrements stock. Transaction 2 blocks, re-reads stock, sees 0 available, and throws `INSUFFICIENT_STOCK` (HTTP 400/409). | **ZERO** | **NO** | **YES** |
| **Case B: 5 units remain, Order A (4 units), Order B (3 units)** | Order A succeeds (reserves 4). Order B attempts 3 units, sees 1 remaining, and fails with `INSUFFICIENT_STOCK`. | **ZERO** | **NO** | **YES** |
| **Case C: 10 units remain, Cart sizes 6 and 5 (Not yet placed)** | Carts do not reserve stock. First to submit order placement succeeds; second fails on checkout submission. | **ZERO** | **NO** | **YES** |
| **Case D: Concurrent overlapping SKUs** | PostgreSQL row-level locks on `store_inventory` serialize access per SKU independently. Unrelated SKUs execute fully in parallel. | **ZERO** | **NO** | **YES** |
| **Case E: Large cart vs Small carts** | Large carts hold row locks across their $N$ items sequentially. Small carts succeed on uncontended items; contended items serialize. | **ZERO** | **NO** | **YES** |
| **Case F: DB commits, response lost** | Client retries with same `Idempotency-Key`. Server detects existing `COMPLETED` record and returns original response. | **ZERO** | **NO** | **YES** |
| **Case G: Retrying request** | Idempotency check returns cached response body. | **ZERO** | **NO** | **YES** |

---

## 5. PHASE 4 — CHECKOUT AVAILABILITY VALIDATION

- **Current Validation**: `PricingEngine.calculate` (`pricingEngine.ts:212-224`) validates that all cart items exist in `store_inventory` and have `is_available = TRUE`. However, stock quantity validation is performed during order creation (`inventoryService.reserveStock`) rather than preemptively during quote calculation.
- **Recommendation**: Integrate stock availability checks into `/api/checkout/quote` to return item-level availability status (`productId`, `requestedQuantity`, `availableStock`, `isAvailable`) before the customer submits payment.

---

## 6. PHASE 5 — REAL-TIME STOCK AVAILABILITY & OUTBOX

- **Current Capability**: Transactional outbox table (`outbox_events`) stages events like `ORDER_CREATED` (`orderService.ts:233`). A background relayer (`outboxService.startOutboxRelayer`) polls every 1 second.
- **Recommendation**: Expand WebSocket event emission (`websocketServer.ts`) to broadcast inventory availability updates to connected store/customer clients strictly **post-commit**.

---

## 7. PHASE 6 — STOCK RESTORATION & RECOVERY

- **Cancellation / Refund**: Handled by `cancellationService` and `inventoryService.restockCommittedStock` / `releaseStock`. Uses idempotent state checks to prevent duplicate restoration.
- **Expiry Reaper**: `inventoryService.reapExpiredReservations` uses `FOR UPDATE SKIP LOCKED` to safely release expired unconfirmed reservations (`inventoryService.ts:265-338`).

---

## 8. PHASE 7 — TEST EVIDENCE & VERIFICATION

- **Existing Tests**: The test suite includes comprehensive integration tests (`business-model.test.ts`, `constraints.test.ts`, `sprint9-returns-cancellations.test.ts`, `sprint10-1c-recovery-webhooks.test.ts`).
- **PostgreSQL Concurrency Tests**: Tests utilize `pg-mem` or test database connections to verify ACID transactions, unique constraints, and row-level locking.

---

## 9. PHASE 8 — DEFECTS & FINAL DECISION

### Defects Ranked by Severity:
1. **Low (P3)**: Quote calculation endpoint (`/api/checkout/quote`) does not return detailed quantity availability shortfalls proactively before order submission.

### Final Decision:
- **APPROVED WITH CONDITIONS**: All core inventory integrity rules, zero cart deduction policies, PostgreSQL authoritative locking, and idempotency guarantees are fully satisfied by the existing architecture.
