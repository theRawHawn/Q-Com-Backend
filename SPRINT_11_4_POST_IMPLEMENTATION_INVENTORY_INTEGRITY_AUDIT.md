# SPRINT 11.4 — POST-IMPLEMENTATION INVENTORY INTEGRITY, CONCURRENCY, PAYMENT FAILURE & RESERVATION READINESS AUDIT

```
========================================================================================
PROJECT: QCOM — Seller-Owned Hardware Quick-Commerce Marketplace
SPRINT: 11.4
TITLE: Post-Implementation Inventory Integrity, Concurrency, Payment Failure and Reservation Readiness Audit
TARGET DIRECTORY: QCOM/backend
AUDIT MODE: STRICT READ-ONLY ARCHITECTURAL AUDIT
DATE: OCTOBER 2026
AUDITOR: Senior Principal Distributed Systems, Financial Integrity & Inventory Concurrency Architect
STATUS: AUDIT COMPLETE — CRITICAL PRODUCTION DEFECTS & ARCHITECTURAL GAPS IDENTIFIED
========================================================================================
```

---

## 1. EXECUTIVE SUMMARY & VERDICT

An exhaustive, non-intrusive, read-only architectural investigation was conducted across `QCOM/backend` to audit the state of inventory concurrency, order-placement deductions, payment failure handling, and checkout reservation readiness following Sprint 11.3.

### 1.1 Summary of Verified Findings
1. **Sprint 11.3 Implementation Reality**:
   - `OrderService.createOrder` (`orderService.ts:103`) does call `inventoryService.commitStock(orderId, client)` inside the PostgreSQL transaction immediately after `inventoryService.reserveStock()`.
   - Physical inventory (`stock_count`) is decremented immediately at order placement for **both** Online Payment and Cash on Delivery (COD) orders.
   - `inventoryService.commitStock()` commits only reservations in `RESERVED` status. Subsequent calls (e.g. from `paymentService.verifyPayment:290`) are idempotent no-ops.
   - `CancellationService.executeCancellation` (`cancellationService.ts:230`) was updated to unconditionally call `inventoryService.restockCommittedStock`.

2. **Critical Architectural Hazard: Unpaid Online Orders & Inventory Leakage (Severity: P0 / CRITICAL)**:
   - By committing physical inventory (`stock_count = stock_count - qty`) immediately during `POST /api/orders/create` for online payment orders (where `payment_status = 'PENDING'`), QCOM incurs severe inventory leakage whenever an online payment fails or is abandoned.
   - If payment fails (`payment.failed` webhook in `paymentService.ts:609`), the payment intent is marked `FAILED`, but the order remains `placed`, the reservation remains `COMMITTED`, and **zero inventory restoration occurs**.
   - If a customer abandons checkout at the payment gateway, the background reaper `inventoryService.reapExpiredReservations` **skips** the order because it only inspects `status = 'RESERVED'`. Physical stock remains permanently lost from the seller's catalog.

3. **Regression Test Failure Discovered (Severity: P1 / HIGH)**:
   - Unconditional invocation of `restockCommittedStock` in `cancellationService.ts` broke the existing test suite (`sprint9-returns-cancellations.test.ts:168`), where pre-fulfillment cancellation of an uncommitted order failed with `AssertionError: Expected 'RESERVED' to be 'RELEASED'`. Furthermore, calling `restockCommittedStock` on uncommitted orders triggers a fallback that increments `stock_count`, generating **phantom inventory**!

4. **PostgreSQL Deadlock Risk in Multi-Item Carts (Severity: P2 / HIGH)**:
   - Neither `orderService.createOrder` nor `inventoryService.reserveStock` sorts item lines by `product_id` before acquiring `SELECT ... FOR UPDATE` row locks. Concurrent orders competing for the same multi-SKU combinations can trigger PostgreSQL deadlocks (`40P01`).

5. **Readiness for Production Checkout Reservation (Business Requirement)**:
   - The current system lacks a pre-payment checkout reservation boundary. Quote calculation (`/api/v1/pricing/quote`) does not invoke `checkAvailability()`, leaving stock validation until order submission.
   - A complete architectural blueprint is provided in Section 6 to safely decouple pre-payment reservations from post-payment inventory commitment.

---

## 2. PHASE 1 — VERIFICATION OF SPRINT 11.3 CLAIMS

| Sprint 11.3 Claim | Code Location | Source Code Reality | Verified Status |
|---|---|---|---|
| **Claim 1**: `createOrder` calls `commitStock` inside transaction | `orderService.ts:103` | `await inventoryService.commitStock(orderId, client);` called inside `transaction(async (client) => { ... })` | **VERIFIED** |
| **Claim 2**: Physical stock deducted on placement for Online & COD | `inventoryService.ts:127`, `orderService.ts:103` | `stock_count = GREATEST(0, stock_count - $3::int)` executed on all placed orders regardless of `paymentMethod` | **VERIFIED** |
| **Claim 3**: `commitStock` only commits `RESERVED` records | `inventoryService.ts:120, 137` | `WHERE order_id = $1 AND status = 'RESERVED'` | **VERIFIED** |
| **Claim 4**: `executeCancellation` calls `restockCommittedStock` | `cancellationService.ts:230` | `await inventoryService.restockCommittedStock(orderId, client);` called unconditionally | **VERIFIED (With Critical Defect)** |
| **Claim 5**: TypeScript & Applet compilation passing | `tsc --noEmit`, `compile_applet` | Applet compilation succeeds with 0 errors | **VERIFIED** |

---

## 3. PHASE 2 — INVENTORY MATHEMATICS & DATABASE CONSTRAINTS

### 3.1 Authoritative Inventory Formulas
Across `store_inventory` and `inventoryService.ts`:
- **Physical On-Hand Quantity**: `store_inventory.stock_count`
- **Reserved Hold Quantity**: `store_inventory.reserved_count`
- **Authoritative Available Quantity**:
  $$\text{Available Stock} = \max(0, \text{stock\_count} - \text{reserved\_count})$$
- **Database Schema Invariant (`003_create_merchants_and_catalog.sql:104`)**:
  ```sql
  CONSTRAINT chk_reserved_le_stock CHECK (reserved_count <= stock_count)
  ```

### 3.2 State Transitions Under Sprint 11.3
Let initial state for SKU 101 be `stock_count = 10`, `reserved_count = 0` (Available = 10). Customer orders quantity 2.

```
+-----------------------------------------------------------------------------------------+
| Initial State:             stock_count = 10 | reserved_count = 0 | Available = 10       |
+-----------------------------------------------------------------------------------------+
                                           |
                                           v
[Step 1: reserveStock()]     stock_count = 10 | reserved_count = 2 | Available = 8        |
                             inventory_reservations.status = 'RESERVED'
                                           |
                                           v
[Step 2: commitStock()]      stock_count = 8  | reserved_count = 0 | Available = 8        |
                             inventory_reservations.status = 'COMMITTED'
+-----------------------------------------------------------------------------------------+
```

### 3.3 The Inherent Inconsistency
While the available stock ($8$) is mathematically identical in both steps, **physical stock has already been written off** ($10 \to 8$). 
If payment is abandoned or rejected, the business no longer possesses an active reservation; it possesses a phantom sold order with depleted inventory on the books!

---

## 4. PHASE 3 — CRITICAL DEFECT ANALYSIS (PAYMENT FAILURE & ABANDONMENT)

### 4.1 Defect 1: Online Payment Failure Leaves Stock Permanently Depleted (P0 / CRITICAL)
- **Source Code**: `paymentService.ts:609-648` (`handleWebhookEvent` on `payment.failed`).
- **Current Behavior**:
  ```typescript
  } else if (eventType === 'payment.failed') {
    if (order.payment_status !== 'PAID') {
      if (currentIntent) {
        await client.query(`UPDATE payment_intents SET status = 'FAILED' ... WHERE id = $1`, [currentIntent.id]);
      }
      stagedEvents.push(paymentEventPublisher.createEvent('PaymentFailed', { ... }));
    }
    // Webhook marked processed, but:
    // 1. Order status remains 'placed'
    // 2. Order payment_status remains 'PENDING'
    // 3. ZERO inventory restoration or compensation is executed!
  }
  ```
- **Financial & Operational Impact**:
  Because stock was committed at `createOrder`, the seller's inventory remains permanently reduced. Competing customers cannot buy the item. The seller loses revenue, and inventory audits reveal unexplained stock discrepancies.

### 4.2 Defect 2: Customer Checkout Abandonment Bypasses Reaper (P0 / CRITICAL)
- **Source Code**: `inventoryService.ts:270-278` (`reapExpiredReservations`).
- **Current Behavior**:
  ```sql
  SELECT id, order_id, merchant_id, product_id, quantity, expires_at
  FROM inventory_reservations
  WHERE status = 'RESERVED' AND expires_at < NOW()
  ORDER BY expires_at ASC LIMIT $1 FOR UPDATE SKIP LOCKED
  ```
- **Flaw**: Because `orderService.createOrder` immediately flips reservation status to `'COMMITTED'`, `reapExpiredReservations` **never** picks up abandoned online orders. Abandoned orders remain in `placed` / `PENDING` indefinitely, holding stock forever.

### 4.3 Defect 3: Broken Pre-Fulfillment Cancellation & Phantom Stock Inflation (P1 / HIGH)
- **Source Code**: `cancellationService.ts:230` vs `inventoryService.ts:184-228`.
- **Current Behavior**:
  `cancellationService.executeCancellation` calls `inventoryService.restockCommittedStock(orderId, client)`.
- **Failure Modes**:
  1. If an order reservation is in `RESERVED` status (e.g., standard pending reservations or cancellation tests):
     `restockCommittedStock` queries `WHERE status = 'COMMITTED'`, finds 0 rows, leaves the `RESERVED` record untouched (breaking `sprint9-returns-cancellations.test.ts`), and executes the fallback:
     ```typescript
     // Fallback: restock from order_items and orders.merchant_id
     UPDATE store_inventory SET stock_count = stock_count + $3::int ...
     ```
  2. **Phantom Inventory Creation**: Incrementing `stock_count` when stock was never deducted (`reserved_count` was incremented, not `stock_count`) inflates `stock_count` beyond actual physical goods in the store!

### 4.4 Defect 4: Multi-Item Deadlock in PostgreSQL Row-Level Locking (P2 / HIGH)
- **Source Code**: `inventoryService.ts:55-63`.
- **Current Behavior**:
  ```typescript
  for (const item of items) {
    const checkRes = await client.query(`
      SELECT id, stock_count, reserved_count
      FROM store_inventory
      WHERE merchant_id = $1 AND product_id = $2
      FOR UPDATE
    `, [merchantId, item.productId]);
  }
  ```
- **Flaw**: Items are locked in whatever order they were submitted in `req.body.items`. If Order 1 locks SKU A then SKU B, and Order 2 locks SKU B then SKU A, PostgreSQL aborts one transaction with `40P01 deadlock_detected`.
- **Required Fix**: Sort items by `productId ASC` prior to executing queries inside `reserveStock`.

---

## 5. PHASE 4 — CHECKOUT & QUOTE INTEGRITY AUDIT

### 5.1 Cart Operations
- Adding items to cart: **Zero DB calls, zero stock reservations** (Client-side / local state).
- Updating quantities: **Zero DB calls, zero stock reservations**.
- Cart viewing: **Zero reservations**.

### 5.2 Pricing Engine Quote Endpoint (`/api/v1/pricing/quote`)
- **Source Code**: `pricingEngine.ts:200-225`, `pricingRoutes.ts:40-160`.
- **Current Validation**:
  - Validates `si.is_available = TRUE`.
  - Validates product existence in merchant catalog.
  - **Does NOT validate quantity availability**: `pricingEngine.ts` does not check if `available < itm.quantity`!
  - `inventoryService.checkAvailability()` is defined in `inventoryService.ts:9` but is **never invoked anywhere in the active codebase**.
- **Customer Experience Issue**: A customer with 10 units in cart gets a valid price quote even if only 1 unit exists in store inventory. They discover the shortfall only upon final order placement (`INSUFFICIENT_STOCK`).

---

## 6. PHASE 5 — PRODUCTION-GRADE CHECKOUT RESERVATION BLUEPRINT

To satisfy the Critical New Business Requirement without inventory leakage or concurrency deadlocks, QCOM requires a strict Two-Phase Reservation State Machine.

### 6.1 Target Checkout & Payment Lifecycle Architecture

```
[CUSTOMER ACTION]                [INVENTORY STATE]            [DATABASE STATE]
----------------------------------------------------------------------------------
1. Add to Cart / View Cart   --> No Lock / No Reservation --> Zero DB Mutation
2. Open Checkout / Quote     --> Pre-flight Availability  --> Read-Only checkAvailability()
3. Begin Payment (Online)    --> Short-lived Hold (10m)   --> status = 'RESERVED'
                                                               stock_count: UNCHANGED
                                                               reserved_count: +QTY
                                                               (reapable if expired)
4. Payment Captures          --> Permanent Commitment     --> status = 'COMMITTED'
                                                               stock_count: -QTY
                                                               reserved_count: -QTY
5. Payment Fails / Timeout   --> Automatic Release        --> status = 'RELEASED'
                                                               stock_count: UNCHANGED
                                                               reserved_count: -QTY
6. Place COD Order           --> Atomic Commit on Confirm --> status = 'COMMITTED'
                                                               stock_count: -QTY
```

### 6.2 Implementation Blueprint Specifications

#### Specification 1: Deterministic SKU Ordering (Deadlock Prevention)
Inside `inventoryService.ts:reserveStock`:
```typescript
// Sort items deterministically by productId to eliminate PostgreSQL 40P01 deadlocks
const sortedItems = [...items].sort((a, b) => a.productId.localeCompare(b.productId));
```

#### Specification 2: Decoupled Reservation vs Commitment
- **For Online Orders (`paymentMethod !== 'Pay on Delivery'`)**:
  - `OrderService.createOrder` reserves stock via `reserveStock(orderId, merchantId, items, 10, client)` with a 10-minute TTL.
  - Does **NOT** call `commitStock`.
  - The order is created with `status = 'placed'` and `payment_status = 'PENDING'`.
  - When payment succeeds (`paymentService.verifyPayment`), `inventoryService.commitStock` transitions `RESERVED` $\to$ `COMMITTED` and decrements `stock_count`.
  - If payment fails (`payment.failed` webhook) or expires, `paymentService` triggers `inventoryService.releaseStock(orderId, client)` and transitions order status to `'cancelled'` / `'FAILED'`.

- **For COD Orders (`paymentMethod === 'Pay on Delivery'`)**:
  - `OrderService.createOrder` reserves and commits stock atomically inside the placement transaction, as COD orders have no asynchronous payment gateway phase.

#### Specification 3: Compensation in `paymentService.ts` for `payment.failed`
In `paymentService.ts:handleWebhookEvent` on `payment.failed`:
```typescript
// Release reservation and mark order cancelled to return stock to available pool
await inventoryService.releaseStock(order.id, client);
await client.query(`UPDATE orders SET status = 'cancelled', cancellation_reason = 'Payment failed at provider' WHERE id = $1`, [order.id]);
```

#### Specification 4: Dual-State Resilient Cancellation in `cancellationService.ts`
```typescript
// Inspect reservation state to perform exact compensation
const resCheck = await client.query(`SELECT status FROM inventory_reservations WHERE order_id = $1 LIMIT 1`, [orderId]);
const resStatus = resCheck.rows[0]?.status;

if (resStatus === 'COMMITTED' || o.payment_status === 'PAID') {
  await inventoryService.restockCommittedStock(orderId, client);
} else {
  await inventoryService.releaseStock(orderId, client);
}
```

#### Specification 5: Pre-Flight Quote Availability Validation
Integrate `inventoryService.checkAvailability()` into `PricingEngine.calculate()` and `/api/v1/pricing/quote` to return granular item status:
```json
{
  "isAvailable": false,
  "unavailableItems": [
    {
      "productId": "7a8b...",
      "requestedQuantity": 5,
      "availableStock": 2
    }
  ]
}
```

---

## 7. PHASE 6 — AUDIT MATRIX & DEFECT SUMMARY

| ID | Issue Description | Severity | Area | Recommended Sprint Action |
|---|---|---|---|---|
| **DEF-01** | Immediate `commitStock` on online orders causes permanent inventory loss on payment failure/abandonment | **P0 (Critical)** | `orderService.ts` / `paymentService.ts` | Decouple online order reservation from commitment; commit on payment capture |
| **DEF-02** | `reapExpiredReservations` blind to abandoned online orders due to `'COMMITTED'` status | **P0 (Critical)** | `inventoryService.ts` | Keep unconfirmed online orders in `'RESERVED'` status with TTL |
| **DEF-03** | Unconditional `restockCommittedStock` in cancellation breaks uncommitted cancellation tests & creates phantom stock | **P1 (High)** | `cancellationService.ts` | Check reservation status; release if `RESERVED`, restock if `COMMITTED` |
| **DEF-04** | Items in `reserveStock` not sorted by SKU, exposing DB to deadlocks under concurrency | **P2 (High)** | `inventoryService.ts` | Sort items by `productId ASC` before `SELECT ... FOR UPDATE` |
| **DEF-05** | Pricing quote does not call `checkAvailability` or report item availability shortfalls | **P3 (Medium)** | `pricingEngine.ts` | Include stock validation in `/api/v1/pricing/quote` |

---

## 8. FINAL AUDITOR STATEMENT & NEXT STEPS

- **Audit Completion**: All code paths, transaction boundaries, state machines, and concurrency interactions have been thoroughly traced.
- **Rule Compliance**: This audit was strictly non-intrusive and read-only. No application files, database migrations, or dependencies were altered.
- **Decision**: **SPRINT 11.4 AUDIT CONCLUDED**. Sprint 11.5 / implementation must prioritize remediating DEF-01, DEF-02, and DEF-03 before opening the platform to high-concurrency production checkout traffic.
