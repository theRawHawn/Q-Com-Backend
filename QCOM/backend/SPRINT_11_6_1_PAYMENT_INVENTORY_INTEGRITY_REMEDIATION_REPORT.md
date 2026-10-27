# SPRINT 11.6.1: CRITICAL PAYMENT-INVENTORY INTEGRITY REMEDIATION REPORT

**Target Directory**: `QCOM/backend`  
**Date**: October 17, 2026  
**Status**: COMPLETED & VERIFIED (All 25 Test Suites Passing: Sprints 1 through 11.6.1)  
**Priority**: P0 FINANCIAL INTEGRITY  

---

## 1. Executive Summary

In Sprint 11.6.1, we resolved all verified P0, P1, and P2 defects discovered during the Sprint 11.6 Read-Only Audit. These defects threatened financial consistency, risked overselling under concurrent execution, allowed late payment callbacks to charge customers on dead orders without inventory allocations, permitted bypassed payment initiation on cancelled orders, orphaned active payment intents, and obscured true sellable inventory from sellers.

All state transitions, database locking sequences, automated refund compensations, and inventory calculations were hardened and verified against race conditions with targeted transactional tests.

---

## 2. Remediated Defect Matrix

| ID | Priority | Description | Root Cause | Remediation | Verification Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **P0-A** | **P0 (Blocker)** | Late payment capture on expired or cancelled orders debited customer without inventory allocation | `handleWebhookEvent` and `verifyPayment` did not check reservation status or order cancellation status under row lock, prematurely updating order to `PAID` while `commitStock` updated 0 rows. | Added PostgreSQL row locking on `orders` and `inventory_reservations`. If order is cancelled, reservation expired, or inventory hold missing: order remains `cancelled`, payment transitions to `REFUND_PENDING`/`REFUNDED`, `commitStock` is strictly skipped, escrow liability is balanced, and durable automated refund is initiated via `refundService.createRefund()`. | **VERIFIED (Tests 1, 2, 8)** |
| **P0-B** | **P0 (Blocker)** | Case-sensitive cancelled-order check allowed payment order creation on dead orders | `o.status === 'CANCELLED'` in `createPaymentOrder` failed to match PostgreSQL `'cancelled'`. Furthermore, active inventory reservations were not re-validated prior to generating payment intents. | Normalized comparison to `(o.status \|\| '').toLowerCase() === 'cancelled'` and verified that orders must have active, unexpired `RESERVED` allocations in `inventory_reservations` before creating a gateway order intent. | **VERIFIED (Tests 3, 4)** |
| **P1-A** | **P1 (High)** | Active payment intents survived order cancellation and reservation expiry | Neither `cancellationService` nor `inventoryService.reapExpiredReservations` invalidated active in-flight `payment_intents`. | `cancellationService` and `inventoryService.reapExpiredReservations` now execute `UPDATE payment_intents SET status = 'CANCELLED' WHERE order_id = $1 AND status IN ('CREATED', 'PENDING', 'AUTHORIZED')`. | **VERIFIED (Test 5)** |
| **P1-B** | **P1 (High)** | Seller inventory API omitted authoritative available-to-sell quantity | `resourceDemoRoutes.ts` returned raw shelf stock and hold counts without computing free sellable units. | Updated SQL query and response serialization to compute `available_to_sell = GREATEST(0, si.stock_count - si.reserved_count)` (`Math.max(0, stock - reserved)`). | **VERIFIED (Test 6)** |
| **P2-A** | **P2 (Medium)** | Hardcoded 15-minute checkout reservation TTL | Hardcoded literals prevented dynamic adjustment during peak hours or operations. | Moved TTL configuration to `env.RESERVATION_TTL_MINUTES` supporting both `CHECKOUT_RESERVATION_TTL_MINUTES` and `QCOM_RESERVATION_TTL_MINUTES` with a default of 15. | **VERIFIED (Test 7)** |

---

## 3. Inventory Accounting Model & Concurrency Guarantees

### 3.1 Mathematical Formulations
- **Physical Shelf Stock** (`stock_count`): Physical units physically present in the merchant store. Decremented only upon physical commitment (COD order placement or captured online payment).
- **Active Hold** (`reserved_count`): Total units currently held in unfinalized checkouts.
- **Authoritative Available to Sell**:
  $$\text{Available to Sell} = \max\Big(0,\; \text{stock\_count} - \text{reserved\_count}\Big)$$

### 3.2 State Machine Transition Rules
```
                [Checkout Initiated]
                         │
                         ▼
             [reserveStock: status = 'RESERVED']
             (reserved_count += Q, stock_count unchanged)
                         │
         ┌───────────────┼───────────────┐
         │               │               │
  (Payment Capture) (Expiry/Reaper) (Cancellation)
         │               │               │
         ▼               ▼               ▼
[commitStock: COMMITTED] [releaseStock: RELEASED] [releaseStock: RELEASED]
(stock_count -= Q)       (reserved_count -= Q)   (reserved_count -= Q)
(reserved_count -= Q)    (order cancelled)       (order cancelled)
```

### 3.3 Race Condition Prevention (Concurrency Invariants)
1. **Reaper vs Late Webhook**: Both operations acquire `SELECT ... FOR UPDATE` locks on `orders` and `inventory_reservations`. If the reaper commits first, the late webhook detects the released reservation and order cancellation, refuses to revive the order, records the payment receipt, and initiates an immediate compensatory refund.
2. **Reallocation to Customer B vs Customer A Late Payment**: If Customer A's hold expires and Customer B purchases the item, Customer B's order commits normally. When Customer A's late payment arrives, Customer A is automatically refunded and physical stock NEVER goes negative ($\text{stock\_count} \ge 0$).
3. **Double-Entry Ledger Balancing**: Escrow cash collected via `recordOrderPayment` (Dr 1010, Cr 2010) is reversed upon cancellation refund by `recordPreFulfillmentCancellationRefund` (Dr 2010, Cr 1010), maintaining $\sum\text{Debits} \equiv \sum\text{Credits}$.

---

## 4. Verification Test Suite Summary

Executed test suite command:
```bash
npm --prefix /app/applet/QCOM/backend test
```

### Results
- **Sprint 11.6.1 Remediation Suite**: **8/8 Tests Passed** (`tests/sprint11-6-payment-inventory-remediation.test.ts`)
  - `[Test 1] Late payment.captured Webhook On Reaped/Cancelled Order` — **PASSED**
  - `[Test 2] Late verifyPayment On Customer-Cancelled Order` — **PASSED**
  - `[Test 3] P0-B Case-Sensitive Cancelled Order Guard` — **PASSED**
  - `[Test 4] P0-B Payment Retry Blocked When Reservation Is Released` — **PASSED**
  - `[Test 5] P1-A Payment Intents Invalidation` — **PASSED**
  - `[Test 6] P1-B Seller Inventory available_to_sell Visibility` — **PASSED**
  - `[Test 7] P2-A Configurable Reservation TTL` — **PASSED**
  - `[Test 8] Concurrency Race: Reallocation to Customer B vs Late Payment from Customer A` — **PASSED**
- **Full Backend Regression Suite**: **25/25 Test Suites Passed (100%)** across Sprints 1 through 11.6.1 in 24.59s.
- **Frontend & Server Status**: Dev server running on port 3000, Vite compilation and `tsc --noEmit` build clean.
