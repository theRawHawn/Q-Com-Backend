# SPRINT 11.6 AUDIT REPORT: CHECKOUT RESERVATION LIFECYCLE, PAYMENT RETRIES, EXPIRY RACES & INVENTORY INTEGRITY VERIFICATION

**Project**: QCOM — Seller-Owned Hardware Quick-Commerce Marketplace  
**Target Directory**: `QCOM/backend`  
**Audit Mode**: STRICT READ-ONLY AUDIT  
**Auditor Roles**: Principal Backend Architect, PostgreSQL Concurrency Engineer, Payment Lifecycle Auditor, QA Engineer  
**Date**: October 15, 2026  
**Final Verdict**: **NOT APPROVED** (Blocking P0 and P1 Defects Identified)

---

## 1. Executive Summary

Following the completion of Sprint 11.5, which aimed to remediate four critical inventory defects, Sprint 11.6 conducted an independent, rigorous, read-only architectural and concurrency audit of the QCOM backend.

The audit examined the source code across `orderService.ts`, `inventoryService.ts`, `paymentService.ts`, `cancellationService.ts`, `pricingEngine.ts`, `orderRoutes.ts`, database schemas, migrations, background workers, and automated test suites. In addition, the automated test suite was executed against the isolated test database environment.

### Final Verdict: NOT APPROVED

While Sprint 11.5 successfully decoupled online order stock commitment from COD order placement and introduced deterministic SKU row locking, **two critical P0 race conditions and several P1 integrity defects were uncovered** that can result in **customers being charged for orders whose inventory was reaped and sold to competing customers, without automatic refund or inventory re-allocation**.

### Summary of Critical Blocking Findings

1. **[P0] Late Payment Capture on Reaped/Cancelled Order Takes Money With Zero Stock Allocated** (`paymentService.ts:289-291`, `paymentService.ts:561-563`, `inventoryService.ts:120-130`):
   When an online order reservation expires, `reapExpiredReservations()` marks `inventory_reservations.status = 'RELEASED'` and `orders.status = 'cancelled'`, returning the units to sellable stock. If a delayed payment capture arrives afterward (via browser `verifyPayment` or Razorpay `payment.captured` webhook), `paymentService` checks only that `orders.payment_status !== 'PAID'`. It does not check if `orders.status === 'cancelled'` or if the reservation was released. It marks `orders.payment_status = 'PAID'`, books the ledger journal entry taking customer funds, and calls `commitStock()`. Because `commitStock()` filters on `status = 'RESERVED'`, it silently finds 0 rows and no-ops. If another customer already purchased those units, **QCOM takes the customer's money for an order that has status 'cancelled' and zero inventory allocated, without initiating a refund**.

2. **[P0] Case-Sensitivity Bug Enables Payment Retry on Cancelled/Expired Orders Without Stock Validation** (`paymentService.ts:90`):
   In `createPaymentOrder()`, the guard against cancelled orders is written as `if (o.status === 'CANCELLED')`. Throughout PostgreSQL and all QCOM domain models, order status is stored in lowercase (`'placed'`, `'confirmed'`, `'cancelled'`). Because `'cancelled' === 'CANCELLED'` evaluates to `false`, **a customer can initiate payment retries on expired or cancelled orders**. The system generates a valid payment intent for an order whose reservation is already `RELEASED`, without re-validating catalog price or stock availability.

3. **[P1] In-Flight Payment Capture vs Customer Pre-Fulfillment Cancellation Race** (`cancellationService.ts:270-280`):
   When an unpaid order is cancelled by the customer, `executeCancellation()` marks `orders.status = 'cancelled'` and releases the reservation, but **does not cancel or invalidate the active `payment_intents` record**. If the customer's payment was in-flight, `payment.captured` or `verifyPayment` succeeds immediately after cancellation, charging the user for a cancelled order without inventory.

4. **[P1] Seller Inventory Visibility Omits Dedicated Available-to-Sell Metric** (`resourceDemoRoutes.ts:66-78`):
   The merchant inventory API returns raw `store_inventory` rows (`stock_count` and `reserved_count`). It does not expose a calculated `available_to_sell` metric ($\max(0, \text{stock\_count} - \text{reserved\_count})$) or indicate out-of-stock status when `reserved_count == stock_count`. Sellers relying on `stock_count` see physical shelf inventory without awareness of active checkout holds.

5. **[P2] Hardcoded 15-Minute Reservation TTL** (`orderService.ts:98`, `inventoryService.ts:48`):
   The 15-minute checkout reservation timeout is hardcoded in source code rather than being driven by configuration tables or environment variables, preventing dynamic tuning under high contention or flash-sale conditions.

---

## 2. Sprint 11.5 Remediation Verification

Each of the nine claims from Sprint 11.5 was verified against the source code:

| # | Claim | Status | File & Line Evidence | Audit Analysis |
| :--- | :--- | :--- | :--- | :--- |
| **A** | Online orders create `RESERVED` allocations without prematurely decrementing physical stock. | **VERIFIED** | `orderService.ts:102-107`<br>`inventoryService.ts:79-92` | `orderService.ts` explicitly checks `isCod`. For online orders, `commitStock` is skipped; `inventory_reservations` row is created with `status = 'RESERVED'` and `reserved_count` is incremented while `stock_count` remains untouched. |
| **B** | COD orders allocate inventory atomically during order placement. | **VERIFIED** | `orderService.ts:104-107`<br>`inventoryService.ts:118-148` | If `isCod` is true, `inventoryService.commitStock(orderId, client)` is called within the same PostgreSQL transaction block as order creation, decrementing both `stock_count` and `reserved_count` atomically. |
| **C** | Verified payment capture commits inventory allocation exactly once. | **VERIFIED (With Edge-Case Caveat)** | `paymentService.ts:289-291`<br>`paymentService.ts:561-563` | `commitStock` is invoked upon verification and webhook capture. Protected by `order.payment_status === 'PAID'` check. Once committed, reservation status transitions to `COMMITTED`, preventing repeated decrements. *Caveat*: If reservation was reaped/released before capture, `commitStock` no-ops silently. |
| **D** | Definitive payment failure safely releases reservation. | **VERIFIED** | `paymentService.ts:626-634`<br>`inventoryService.ts:159-188` | Webhook `payment.failed` calls `inventoryService.releaseStock(order.id, client)` and marks `orders.status = 'cancelled'`. `releaseStock` decrements `reserved_count` and sets status to `RELEASED`. |
| **E** | Expired reservations are reaped safely. | **VERIFIED (With Race Gap)** | `inventoryService.ts:299-397`<br>`server.ts:101-110` | Worker runs every 30s using `FOR UPDATE SKIP LOCKED`. Expired `RESERVED` rows for unpaid orders are marked `RELEASED`, `reserved_count` is restored, and order is marked `cancelled`. *Gap*: Does not mark `payment_intents` as `FAILED` or `CANCELLED`. |
| **F** | Cancellation distinguishes `RESERVED`, `COMMITTED`, and `RELEASED` without double restoration. | **VERIFIED** | `cancellationService.ts:230-251`<br>`inventoryService.ts:199-262` | `executeCancellation` queries `inventory_reservations` under row lock. Calls `restockCommittedStock` only if `hasCommitted`, `releaseStock` only if `hasReserved`, and no-ops if all rows are `RELEASED`. |
| **G** | Multi-SKU operations acquire locks in deterministic product ID order. | **VERIFIED** | `inventoryService.ts:56, 131, 172, 210, 249` | Line items and reservation rows are explicitly sorted with `.sort((a, b) => a.productId.localeCompare(b.productId))` before acquiring `SELECT ... FOR UPDATE` row locks, eliminating PostgreSQL `40P01` deadlocks. |
| **H** | Pricing & availability endpoints validate requested quantity against authoritative PostgreSQL inventory. | **VERIFIED** | `pricingEngine.ts:224-234`<br>`orderRoutes.ts:14-53` | `pricingEngine.calculate()` computes `available = stock_count - reserved_count` and rejects with HTTP 422 `INSUFFICIENT_STOCK`. `orderRoutes.ts` exposes `POST /api/orders/check-availability`. |
| **I** | Idempotency prevents duplicate order creation and inventory deduction after retries. | **VERIFIED** | `orderRoutes.ts:71-133` | PostgreSQL `idempotency_keys` table enforces status transitions (`PROCESSING` $\to$ `COMPLETED`). Duplicate requests return original 200 payload without re-executing `createOrder()`. |

---

## 3. Inventory Accounting Model Analysis

### 3.1 Field Semantics

- **`store_inventory.stock_count`** (INT, $\ge 0$): Represents physical units currently located in the merchant's physical dark store or warehouse. It is only decremented when physical allocation is finalized (COD order placement or captured online payment). It is incremented only during verified post-fulfillment returns or post-commitment cancellations.
- **`store_inventory.reserved_count`** (INT, $\ge 0$): Represents the aggregate quantity of items held for active, unconfirmed checkout or pending online payment orders. Enforced by database constraint `CONSTRAINT chk_reserved_le_stock CHECK (reserved_count <= stock_count)`.
- **`inventory_reservations.status`** (VARCHAR):
  - `'RESERVED'`: Active temporary hold. `reserved_count` is incremented; `stock_count` is untouched.
  - `'COMMITTED'`: Finalized sale. `stock_count` and `reserved_count` are both decremented by the reserved quantity.
  - `'RELEASED'`: Hold relinquished (due to payment failure, reservation expiry, or order cancellation). `reserved_count` is decremented; `stock_count` is untouched.

### 3.2 Authoritative Available-to-Sell Formula

$$\text{Available to Sell} = \max\Big(0,\; \text{stock\_count} - \text{reserved\_count}\Big)$$

**Correctness Evaluation Across States**:
1. **Unreserved Shelf Stock**: `stock_count = 10, reserved_count = 0` $\implies$ Available = $10$. (Correct)
2. **Pending Online Order (Quantity 3)**: `stock_count = 10, reserved_count = 3` $\implies$ Available = $7$. (Correct: 7 units available for other customers; 3 units held).
3. **Payment Captured / COD Committed**: `stock_count = 7, reserved_count = 0` $\implies$ Available = $7$. (Correct: 3 units physically allocated to courier/order; remaining shelf stock is 7).
4. **Payment Failed / Reservation Expired**: `stock_count = 10, reserved_count = 0` $\implies$ Available = $10$. (Correct: hold released, physical stock intact).
5. **Committed Order Cancelled**: `stock_count = 10, reserved_count = 0` $\implies$ Available = $10$. (Correct: physical stock restored).

The mathematical model is sound **provided** the state machine transitions between `RESERVED`, `COMMITTED`, and `RELEASED` are strictly guarded against race conditions.

### 3.3 12-Stage Lifecycle Trace

```
[1. Add to Cart]
      │ (No DB reservation; client-side state)
[2. Pricing Quote]
      │ (Validates: stock_count - reserved_count >= requested_qty)
[3. Checkout Initiated]
      │
[4. Online Order Created] ───(COD Branch)───> [7. COD Placement: Atomically COMMITTED]
      │                                                │
[5. RESERVED Hold Created]                             │
      │                                                │
      ├─────────────────┬─────────────────┐            │
      ▼                 ▼                 ▼            ▼
[6. Payment Capture] [8. Payment Fail] [9. Expiry] [10. Cancellation]
      │                 │                 │            │
      ▼                 ▼                 ▼            ▼
COMMITTED (stock - Q) RELEASED          RELEASED     RESTOCKED (if COMMITTED)
                      (reserved - Q)    (reserved - Q)RELEASED (if RESERVED)
                                                       │
                                                 [11. Payment Retry] ──> (VULNERABILITY!)
                                                       │
                                                 [12. Restocking]
```

---

## 4. Payment, Expiry & Concurrency Race Analysis

### Race Scenario A: Payment Succeeds While Reservation Expires
* **Sequence**:
  1. Customer completes payment at provider at T=14:59.
  2. Reaper worker executes at T=15:01 (`reapExpiredReservations`).
  3. Webhook delivery (`payment.captured`) or browser callback (`verifyPayment`) arrives at T=15:02.
* **Analysis**:
  - The reaper finds `orders.payment_status === 'PENDING'`, marks `inventory_reservations.status = 'RELEASED'`, restores `store_inventory.reserved_count`, and sets `orders.status = 'cancelled'`.
  - When `payment.captured` or `verifyPayment` executes, it locks `orders`. Because `payment_status` is still `'PENDING'`, it proceeds.
  - It sets `orders.payment_status = 'PAID'`.
  - It executes `commitStock(orderId)`. Inside `commitStock`:
    ```sql
    SELECT merchant_id, product_id, quantity
    FROM inventory_reservations
    WHERE order_id = $1 AND status = 'RESERVED' FOR UPDATE
    ```
    This query returns **0 rows** because the status was already changed to `'RELEASED'`.
  - `commitStock` returns with no-op.
  - The payment receipt is inserted, the double-entry ledger records debits/credits, and the event `PaymentCaptured` is published.
* **Failure Outcome**: **CRITICAL DEFECT**. Customer's account was charged. Order is in status `'cancelled'` with `payment_status = 'PAID'`. No physical stock is allocated. No refund is created.

### Race Scenario B: Reservation Expires, Another Customer Purchases Units, Late Payment Arrives
* **Sequence**:
  1. Customer A places order for last available unit (Product 1: `stock_count = 1, reserved_count = 1`).
  2. Reservation expires; Reaper releases hold (`reserved_count = 0`). Customer A order status set to `'cancelled'`.
  3. Customer B places order for Product 1 (`stock_count = 1, reserved_count = 1`), and immediately confirms via COD or instant capture (`stock_count = 0, reserved_count = 0`).
  4. Customer A's late `payment.captured` webhook arrives.
* **Analysis**:
  - Customer A's payment handler runs.
  - `commitStock` finds 0 `RESERVED` rows and no-ops.
  - Payment is captured; ledger records transaction.
* **Failure Outcome**: **P0 OVERSELLING & ORPHANED PAYMENT**. Customer A was charged for an item that was already physically sold and committed to Customer B. Customer A has an unfulfilled cancelled order with no automated refund trigger.

### Race Scenario C: `verifyPayment` Races With `payment.captured` Webhook
* **Sequence**:
  - Customer browser submits `POST /api/payments/verify` simultaneously with Razorpay webhook `POST /api/webhooks/razorpay` (`payment.captured`).
* **Analysis**:
  - Both endpoints begin with a PostgreSQL transaction and execute `SELECT * FROM orders WHERE id = $1 FOR UPDATE`.
  - Transaction 1 acquires the lock. It sets `orders.payment_status = 'PAID'`, commits stock, records receipt, and commits.
  - Transaction 2 unblocks. It reads `order.payment_status === 'PAID'`.
  - In `verifyPayment`: lines 191-218 return existing receipt with `isDuplicate: true`.
  - In `handleWebhookEvent`: lines 523-538 mark `webhook_events.status = 'PROCESSED'` and return `duplicate: true`.
* **Verdict**: **SAFE**. Protected by PostgreSQL row-level locking on `orders` and idempotency checks.

### Race Scenario D: Adverse Ordering of Payment Failure and Success Events
* **Case D1: `payment.failed` arrives before late `payment.captured`**:
  - `payment.failed` sets `payment_intents.status = 'FAILED'`, releases reservation, and marks order `'cancelled'`.
  - When `payment.captured` arrives, line 540 executes `validatePaymentTransition('FAILED', 'CAPTURED')`.
  - `isTerminalPaymentState('FAILED')` returns `valid: false`. An exception is thrown and the transaction rolls back.
  - *Risk*: Razorpay debited the customer, but QCOM rejected the webhook without initiating an automated refund.
* **Case D2: `payment.captured` arrives before `payment.failed`**:
  - `payment.captured` sets `orders.payment_status = 'PAID'` and commits stock.
  - `payment.failed` arrives. Line 610 checks `if (order.payment_status !== 'PAID')`. Since it is `'PAID'`, the failure handler is skipped entirely.
  - *Verdict*: **SAFE**.

### Race Scenario E: Pre-Fulfillment Cancellation Races With Payment Capture
* **Sequence**:
  - Customer submits cancellation (`POST /api/orders/:id/cancel/customer`) at the exact millisecond payment is being authorized.
* **Analysis**:
  - `cancellationService.ts` acquires row lock on `orders`. It sees `o.payment_status === 'PENDING'`, releases the reservation, and sets `orders.status = 'cancelled'`. It **does not update `payment_intents`**.
  - `verifyPayment` or `payment.captured` unblocks, locks `orders`, and executes.
  - It does not check `orders.status === 'cancelled'`.
  - It charges the customer, marks `payment_status = 'PAID'`, and commits 0 inventory.
* **Failure Outcome**: **P1 INTEGRITY DEFECT**. Payment captured on customer-cancelled order without stock or refund.

### Race Scenario F: Expiry Worker Crashes After Claiming Reservation
* **Analysis**:
  - `inventoryService.reapExpiredReservations()` executes all batch operations inside `transaction(execute)`.
  - If the Node.js process crashes, PostgreSQL drops the connection and automatically issues a `ROLLBACK`.
  - The rows remain `RESERVED` with `expires_at < NOW()`. The next reaper tick safely re-claims them.
* **Verdict**: **SAFE**.

### Race Scenario G: PostgreSQL Unavailable During Critical Transition
* **Analysis**:
  - In both `orderRoutes.ts` and `pricingRoutes.ts`, `isDatabaseUnavailable(err)` catches 57P01, connection timeouts, and ECONNREFUSED, returning HTTP 503 with header `Retry-After: 3`.
  - Uncommitted transactions are automatically rolled back by PostgreSQL.
* **Verdict**: **SAFE**.

### Race Scenario H: Client Times Out After Order Creation and Retries
* **Analysis**:
  - Handled by `idempotency_keys` table in `orderRoutes.ts`.
  - If retry arrives while original is `PROCESSING`: Returns HTTP 409 `ORDER_CREATION_IN_PROGRESS`.
  - If retry arrives after original is `COMPLETED`: Returns cached HTTP 200 payload without executing a second `orderService.createOrder()`.
* **Verdict**: **SAFE**.

### Race Scenario I: Payment Provider Returns Ambiguous Outcome
* **Analysis**:
  - In `paymentService.ts`, payment capture requires cryptographic HMAC-SHA256 signature validation matching Razorpay order ID, payment ID, and order amount.
  - If signature validation fails or network times out, payment is not assumed captured.
  - *Gap*: The background `financialRecoveryWorker` (Sprint 10.1C) reconciles stale payout and refund intents, but **does not currently poll Razorpay Orders API (`GET /orders/:id`) for ambiguous payment intents in `CREATED` status**.
* **Verdict**: **PARTIAL / NEEDS RECONCILIATION WORKER EXPANSION**.

---

## 5. Payment Retry Behavior Verification

An analysis was conducted on customer retry flows:

### 5.1 Case-Sensitivity Vulnerability on Payment Retry
In `paymentService.ts` line 90:
```typescript
if (o.status === 'CANCELLED') {
  throw new Error('ORDER_CANCELLED: Cannot initiate payment for a cancelled order.');
}
```
In PostgreSQL, `orders.status` is stored in lowercase (`'cancelled'`). Because JavaScript strict equality (`===`) is case-sensitive:
`'cancelled' === 'CANCELLED' // FALSE`
This guard **never triggers**! A customer whose order was cancelled due to expiry or failed payment can invoke `paymentService.createPaymentOrder()`, obtain a new `payment_intents` row, and successfully pay through the payment gateway for an order with zero inventory allocation.

### 5.2 Failure to Revalidate Inventory on Payment Retry
When `createPaymentOrder()` is called for a retry:
1. It does not check if the associated `inventory_reservations` row is `EXPIRED` or `RELEASED`.
2. It does not call `inventoryService.checkAvailability()` to confirm the merchant still has physical stock.
3. It does not re-acquire a reservation in `store_inventory`.
4. It does not re-verify product pricing, active promotions, or tax rates.

---

## 6. Reservation TTL & Worker Architecture

| Attribute | Current Value | Assessment |
| :--- | :--- | :--- |
| **Duration** | 15 Minutes | **Hardcoded** in `orderService.ts:98` and `inventoryService.ts:48`. Not configurable via `env` or database config. |
| **Calculation** | `new Date(Date.now() + durationMinutes * 60 * 1000)` | Accurate UTC timestamp stored in PostgreSQL `TIMESTAMPTZ`. |
| **Polling Interval** | 30 Seconds | Scheduled via `setInterval(..., 30000).unref()` in `server.ts:102`. |
| **Batch Size** | 50 Rows | Bounded batch per tick. |
| **Concurrency Control** | `FOR UPDATE SKIP LOCKED` | Safe for horizontal scaling across multiple backend instances. |
| **Batch Atomicity Risk** | Entire batch in single transaction | If 1 candidate throws an unhandled error, all 50 candidates in the batch roll back. |

---

## 7. Seller Inventory Visibility

Inspection of `resourceDemoRoutes.ts` lines 61-82 (`GET /merchants/:merchantId/inventory`):

```sql
SELECT si.*, p.name as product_name, p.sku, p.category, p.hsn_code 
FROM store_inventory si
JOIN products p ON p.id = si.product_id
WHERE si.merchant_id = $1
```

### Visibility Gaps
1. **Raw Database Columns**: The endpoint returns raw `stock_count` and `reserved_count`.
2. **Missing Available-to-Sell Property**: The API does not expose an explicit `available_to_sell` field ($\max(0, \text{stock\_count} - \text{reserved\_count})$).
3. **Misleading `is_available` Flag**: If a seller has 5 units on the shelf and all 5 are reserved in active checkouts (`stock_count = 5, reserved_count = 5`), `is_available` in `store_inventory` remains `TRUE`. Seller dashboards inspecting `is_available` or `stock_count` cannot distinguish between free inventory and reserved inventory without manual arithmetic.

---

## 8. Executed Test Suite & Targeted Scenario Audit

The automated test suite was executed in the test environment:

```bash
npm --prefix /app/applet/QCOM/backend test
```

### Execution Output & Performance
- **Command**: `tsx tests/run-all-tests.ts`
- **Result**: `✓ ALL SPRINT 1 TO 11.5 TESTS PASSED SUCCESSFULLY in 17.37s!`
- **Total Test Suites Executed**: 24 suites (Sprints 1 through 11.5).
- **Sprint 11.5 Suite**: 8/8 tests passed.

### Detailed Coverage Matrix for 15 Targeted Concurrency Scenarios

| # | Concurrency / Lifecycle Scenario | Actual Status in Test Suite | Audit Findings |
| :--- | :--- | :--- | :--- |
| **1** | Two customers competing for the last unit | **PARTIALLY COVERED** | Tested sequentially via `checkAvailability` in `sprint11-5.test.ts:95-98`. True parallel HTTP checkout contention with `Promise.all` is NOT COVERED. |
| **2** | Payment success vs reservation expiry | **NOT COVERED** | No test simulates `reapExpiredReservations()` racing against `verifyPayment`. (Vulnerability exists). |
| **3** | Payment failure vs expiry | **PARTIALLY COVERED** | Both tested in isolation in `sprint11-5.test.ts` (Test 4 and Test 5), but not racing concurrently. |
| **4** | `verifyPayment` vs `payment.captured` webhook | **PARTIALLY COVERED** | Concurrent identical webhooks tested in `sprint6-payments.test.ts:380-420`, but browser callback vs webhook race is NOT COVERED. |
| **5** | Duplicate payment webhooks | **COVERED** | `sprint6-payments.test.ts` Test 10–12 verifies idempotent acknowledgement. |
| **6** | Out-of-order payment webhooks | **PARTIALLY COVERED** | Covered for settlement payouts in Sprint 10.1C; NOT COVERED for `payment.failed` followed by late `payment.captured`. |
| **7** | Cancellation vs payment capture | **NOT COVERED** | No test executes customer cancellation concurrently with payment capture. (Vulnerability exists). |
| **8** | Payment retry after reservation expiry | **NOT COVERED** | No test attempts `createPaymentOrder` after reservation expiry. (Vulnerability exists). |
| **9** | Late payment success after another customer buys stock | **NOT COVERED** | Critical unhandled defect. No test exists. |
| **10** | Duplicate expiry workers | **NOT COVERED** | `reapExpiredReservations` uses `SKIP LOCKED`, but multi-worker contention is not tested. |
| **11** | Duplicate cancellation requests | **COVERED** | `sprint11-5.test.ts` Test 6 verifies idempotent double cancellation prevents phantom inventory. |
| **12** | Transaction rollback during inventory commitment | **COVERED** | `sprint4-migration.test.ts` Test 15 and `sprint6-payments.test.ts` Test 19 verify clean rollbacks. |
| **13** | Multi-SKU concurrent orders | **PARTIALLY COVERED** | `sprint11-5.test.ts` Test 7 verifies deterministic sorting, but concurrent opposite-order requests are not tested. |
| **14** | PostgreSQL unavailability during critical writes | **COVERED** | `business-model.test.ts:285-320` verifies HTTP 503 + `Retry-After: 3`. |
| **15** | Client timeout and idempotent order retry | **COVERED** | `sprint4-migration.test.ts:355-375` verifies exact-order return on retry. |

---

## 9. Comprehensive Defect Register

### P0 (Blocker — Must Fix Before Sprint 12)
1. **DEFECT-11.6-01: Late Payment Capture On Expired / Reaped Order Debits Customer Without Stock**
   - **Location**: `paymentService.ts:289-291`, `paymentService.ts:561-563`, `inventoryService.ts:120-130`
   - **Impact**: Customer is charged; order is marked `PAID` but remains `status = 'cancelled'`; physical stock is not allocated; no automated refund is issued.
   - **Fix Requirement**: In both `verifyPayment` and `handleWebhookEvent`, if `order.status === 'cancelled'` or if `inventory_reservations` status is not `RESERVED`, the payment capture must either:
     - Automatically trigger a full refund via `refundService.createRefund()`, OR
     - Atomically re-reserve and commit stock if available, and if unavailable, trigger an immediate refund.

2. **DEFECT-11.6-02: Case-Sensitivity Bug in `createPaymentOrder` Allows Payment On Cancelled Orders**
   - **Location**: `paymentService.ts:90`
   - **Impact**: `if (o.status === 'CANCELLED')` fails to match `'cancelled'`, permitting customers to initiate payment on dead orders.
   - **Fix Requirement**: Change comparison to `if (o.status.toLowerCase() === 'cancelled')`. Furthermore, verify that active reservations exist before generating a payment intent.

### P1 (High Priority)
3. **DEFECT-11.6-03: Pre-Fulfillment Cancellation Fails to Invalidate Active Payment Intents**
   - **Location**: `cancellationService.ts:270-280`
   - **Impact**: In-flight payments succeed post-cancellation, leaving customer debited on a cancelled order.
   - **Fix Requirement**: In `executeCancellation()`, update all active payment intents for the order:
     ```sql
     UPDATE payment_intents SET status = 'CANCELLED', updated_at = NOW()
     WHERE order_id = $1 AND status IN ('CREATED', 'PENDING', 'AUTHORIZED')
     ```

4. **DEFECT-11.6-04: Merchant Inventory API Omits `available_to_sell` Calculation**
   - **Location**: `resourceDemoRoutes.ts:66-78`
   - **Impact**: Sellers see raw shelf count, risking confusion over active checkout holds.
   - **Fix Requirement**: Expose `available_to_sell: GREATEST(0, si.stock_count - si.reserved_count)` in the merchant inventory response.

### P2 (Medium Priority)
5. **DEFECT-11.6-05: Hardcoded Reservation TTL**
   - **Location**: `orderService.ts:98`, `inventoryService.ts:48`
   - **Impact**: Inflexible timeout. Cannot be adjusted for peak hours or operational changes without code redeployment.
   - **Fix Requirement**: Move timeout to `env.CHECKOUT_RESERVATION_TTL_MINUTES` with a default of 15.

6. **DEFECT-11.6-06: Batch Rollback Risk in Reservation Reaper**
   - **Location**: `inventoryService.ts:402`
   - **Impact**: If one reservation candidate fails processing, all 50 candidates in the batch roll back.
   - **Fix Requirement**: Process each candidate in its own sub-transaction or handle errors per-item to prevent poison-pill stalls.

---

## 10. Required Follow-up Work & Roadmap for Sprint 12

Prior to implementing the Sprint 12 pre-payment short-lived checkout reservation system, the following remediations must be implemented and verified:

1. **Implement Terminal State Reconciliation in Payment Service**:
   - Reject payment capture if `orders.status === 'cancelled'`.
   - If payment provider captures funds after cancellation/expiry, automatically stage a compensatory refund via `refundService` and notify the customer.
2. **Harmonize Status Enums & Case Sensitivity**:
   - Normalize order status comparison across all services using `.toLowerCase()` or strict TypeScript union types.
3. **Invalidate Payment Intents on Cancellation**:
   - Cancel associated payment intents whenever an order is cancelled or reaped.
4. **Build Payment Recovery Worker for Ambiguous Captures**:
   - Expand `financialRecoveryWorker` to reconcile pending `payment_intents` with Razorpay's API.
5. **Add Concurrency Integration Tests**:
   - Implement tests simulating `verifyPayment` racing against `reapExpiredReservations` and late payments arriving after inventory reallocation.

---

**Report Prepared By**: QCOM Principal Backend Architecture & Concurrency Audit Team  
**Audit Status**: COMPLETE & FILED (`SPRINT_11_6_CHECKOUT_RESERVATION_PAYMENT_RETRY_AUDIT.md`)
