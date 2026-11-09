# SPRINT 11.5: CRITICAL INVENTORY INTEGRITY REMEDIATION REPORT
**Target Directory**: `QCOM/backend`  
**Date**: October 15, 2026  
**Status**: COMPLETED & VERIFIED (All Sprint 1–11.5 Suites Passing)

---

## 1. Executive Summary

In Sprint 11.5, the engineering team executed a comprehensive remediation of the four critical inventory integrity defects identified and documented during the Sprint 11.4 Audit. Before introducing the upcoming Sprint 12 short-lived checkout reservation feature, the core PostgreSQL transactional inventory invariants had to be made mathematically sound, race-free, and resilient against payment abandonment, payment failure, out-of-order cancellations, and multi-item deadlocks.

All 4 target defects were independently verified against the codebase and resolved with production-grade transactional guarantees. The full backend test suite—spanning Sprint 1 through Sprint 11.5 (including the dedicated 8-phase test suite in `tests/sprint11-5-inventory-remediation.test.ts`)—passed with **100% success in 17.37s**, and full applet TypeScript compilation passed without warnings.

---

## 2. In-Depth Verification & Resolution of Reported Defects

### Defect A: Unpaid Online Orders Prematurely Consumed Stock
* **Root Cause Verified**: `orderService.ts` was executing `inventoryService.commitStock()` unconditionally during order creation. For online payment orders (e.g. Instant UPI, Netbanking, Cards), `orders.payment_status` started as `PENDING`. However, `commitStock()` immediately decremented physical `store_inventory.stock_count` and zeroed `reserved_count`. If the customer subsequently abandoned checkout or if the issuing bank rejected payment (`payment.failed` webhook), physical inventory remained decremented forever without a restoration mechanism because `reapExpiredReservations()` skipped records that were no longer in `RESERVED` status.
* **Remediation**:
  1. **Decoupled Placement Commitment**: In `orderService.ts`, `commitStock()` is now strictly restricted to Cash on Delivery / Pay on Delivery orders (`input.paymentMethod === 'Pay on Delivery' || input.paymentMethod === 'COD' || input.paymentMethod === 'Cash on Delivery'`). Online orders retain their `RESERVED` row in `inventory_reservations` with a 15-minute validity window.
  2. **Exactly-Once Commit on Payment Capture**: In `paymentService.ts` (`verifyPayment` and `payment.captured` webhook handler), `inventoryService.commitStock(orderId, client)` is invoked inside the same database transaction that marks the payment `CAPTURED` and order `PAID`.
  3. **Automatic Stock Release on Payment Failure**: In `paymentService.ts` (`handleWebhookEvent` for `payment.failed`), `inventoryService.releaseStock(order.id, client)` is executed, and the unpaid order is transitioned to `cancelled` with reason `'Payment failed at provider'`.
  4. **Active Reaper Compensation**: In `inventoryService.reapExpiredReservations()`, any reservation in `RESERVED` status that has expired past its window is examined with `FOR UPDATE SKIP LOCKED`. If the order is unpaid and still `placed`, the hold is released back to available pool (`reserved_count = GREATEST(0, reserved_count - quantity)`) and the order is marked `cancelled` with reason `'Payment reservation window expired'`.

### Defect B: Order Cancellation Created Phantom Inventory
* **Root Cause Verified**: `cancellationService.ts` was invoking `inventoryService.restockCommittedStock(orderId)` unconditionally on every cancellation request (including pre-fulfillment customer cancellations where stock had never been committed to physical deduction). Furthermore, `restockCommittedStock()` contained a fallback that incremented `store_inventory.stock_count` from `order_items` even if reservation records had already been released or if the order was unpaid. Calling cancel multiple times or cancelling an unpaid order inflated seller inventory past physical reality.
* **Remediation**:
  1. **Atomic State Inspection**: In `cancellationService.ts` (`executeCancellation`), the system now inspects existing `inventory_reservations` with `SELECT status FROM inventory_reservations WHERE order_id = $1 FOR UPDATE`.
  2. **Selective State Restoration**:
     - If reservations are `COMMITTED`: `inventoryService.restockCommittedStock()` is called.
     - If reservations are `RESERVED`: `inventoryService.releaseStock()` is called.
     - If reservations are already `RELEASED`: The operation safely no-ops, strictly guaranteeing zero duplicate restorations.
  3. **Guarded Fallback**: The fallback in `inventoryService.restockCommittedStock` is only entered if zero reservation records exist in the database (untracked legacy orders), the order was `PAID` or `Pay on Delivery`, and the order is not already `cancelled`.

### Defect C: Multi-SKU Deadlock Risk (PostgreSQL 40P01)
* **Root Cause Verified**: Concurrent multi-item checkouts and inventory updates did not guarantee a consistent lock acquisition order across items in `orderService.ts` and `inventoryService.ts`. Two simultaneous orders containing items `[ProductA, ProductB]` and `[ProductB, ProductA]` could acquire row locks in reverse order, producing deadlock exceptions (`40P01`).
* **Remediation**:
  1. **Deterministic Lexicographical SKU / UUID Sorting**: `inventoryService.reserveStock()`, `inventoryService.commitStock()`, `inventoryService.releaseStock()`, and `inventoryService.restockCommittedStock()` all explicitly sort item lists by `productId` ascending before acquiring `SELECT ... FOR UPDATE` row locks:
     ```typescript
     const sortedItems = [...items].sort((a, b) => a.productId.localeCompare(b.productId));
     ```
  2. **Deterministic Fingerprinting**: `orderRoutes.ts` sorts line items during request fingerprinting to ensure consistent idempotency key hashing and transaction execution order.

### Defect D: Insufficient Quantity Check in Pricing & Quote Engine
* **Root Cause Verified**: `/api/v1/pricing/quote` and `/api/checkout/calculate` validated that `store_inventory.is_available = TRUE`, but did not evaluate whether `stock_count - reserved_count >= requestedQuantity`. A customer requesting 500 units of a product with only 2 available units received a valid quote with taxes and totals, which failed late during final order creation.
* **Remediation**:
  1. **Authoritative Available Stock Calculation**: `pricingEngine.ts` was upgraded to evaluate available stock:
     ```typescript
     const stockCount = Number(p.stock_count);
     const reservedCount = Number(p.reserved_count || 0);
     const available = stockCount - reservedCount;
     if (available < itm.quantity) {
       throw new PricingEngineError(
         'INSUFFICIENT_STOCK',
         `Insufficient stock for '${p.name}'. Requested ${itm.quantity}, but only ${Math.max(0, available)} available. Please reduce quantity or remove item.`,
         422
       );
     }
     ```
  2. **Clean HTTP 422 Contract**: Handled cleanly in `pricingRoutes.ts` with error code `INSUFFICIENT_STOCK` (HTTP 422) returning product name, requested quantity, and available units.
  3. **Dedicated Availability Route**: Added `POST /api/orders/check-availability` and `POST /api/v1/orders/check-availability` in `orderRoutes.ts` delegating to `inventoryService.checkAvailability(merchantId, items)` for lightweight cart pre-checks without calculating full GST matrices.

---

## 3. Inventory State Model & Accounting Invariants

| Field / State | Semantic Meaning | Accounting Formula |
| :--- | :--- | :--- |
| `stock_count` | Physical units currently on the seller's shelf. Decremented only when an order is confirmed (COD placement or captured online payment). | Restocked upon post-fulfillment return or post-payment cancellation. |
| `reserved_count` | Units locked in active checkout or pending payment. | Incremented upon order placement (`RESERVED`). Decremented upon commit or release. |
| Available Stock | Net units available for new orders or quotes. | $\text{Available} = \max(0, \text{stock\_count} - \text{reserved\_count})$ |
| `RESERVED` | Temporary hold created at order placement with a 15-minute expiry. | Does not decrement `stock_count`; increments `reserved_count`. |
| `COMMITTED` | Allocation finalized into physical deduction. | Decrements `stock_count` and decrements `reserved_count`. |
| `RELEASED` | Reservation cleared upon cancellation, payment failure, or expiry. | Decrements `reserved_count` back to 0. `stock_count` remains untouched. |

---

## 4. Verification Test Results

A dedicated test suite was constructed in `/QCOM/backend/tests/sprint11-5-inventory-remediation.test.ts` covering all remediation flows:

1. **Test 1**: Online Order Placement Decoupling (`RESERVED` hold, physical stock preserved, competing checkouts blocked).
2. **Test 2**: COD (Pay on Delivery) Placement Immediate Stock Commit (`COMMITTED` status, physical stock decremented).
3. **Test 3**: Online Payment Capture Transitions `RESERVED` $\to$ `COMMITTED` exactly once with physical decrement.
4. **Test 4**: Online Payment Failure Webhook Releases Reservation and safely cancels the order.
5. **Test 5**: Abandoned Reservation Reaper releases expired reservations using `FOR UPDATE SKIP LOCKED`.
6. **Test 6**: Zero Phantom Inventory on idempotent duplicate cancellations and restock calls.
7. **Test 7**: Deterministic SKU Ordering eliminates deadlocks in multi-item orders.
8. **Test 8**: Pricing Engine Rejection on Insufficient Quantity with HTTP 422 `INSUFFICIENT_STOCK`.

### Test Execution Summary
```
===========================================================
  QCOM Unified Backend Engine — Automated Test Suite
===========================================================
...
--- Running Sprint 11.5: Critical Inventory Remediation Suite ---
[Test 1] Testing Online Order Placement Decoupling...
✓ Test 1 passed: Online order placement holds RESERVED stock without prematurely writing off physical inventory
[Test 2] Testing COD (Pay on Delivery) Placement Immediate Stock Commit...
✓ Test 2 passed: COD orders commit stock immediately upon order placement
[Test 3] Testing Online Payment Capture Transitions RESERVED to COMMITTED...
✓ Test 3 passed: Payment verification transitions RESERVED to COMMITTED and decrements physical stock
[Test 4] Testing Online Payment Failure Releases Reservation & Cancels Order...
✓ Test 4 passed: Payment failure releases reservation and cancels order safely
[Test 5] Testing Abandoned Reservation Reaper...
✓ Test 5 passed: Abandoned reservation reaper releases inventory and cancels expired orders
[Test 6] Testing Zero Phantom Inventory On Multiple Cancellations...
✓ Test 6 passed: Duplicate cancellation / restock calls strictly prevent phantom inventory
[Test 7] Testing Deterministic SKU Ordering in Multi-Item Reservations...
✓ Test 7 passed: Multi-item orders reserve with deterministic SKU sorting
[Test 8] Testing Pricing Engine Rejection on Insufficient Quantity...
✓ Test 8 passed: Pricing quote validates stock_count - reserved_count and rejects over-quantity requests
================================================================
✓ ALL SPRINT 11.5 CRITICAL INVENTORY REMEDIATION TESTS PASSED!
================================================================

===========================================================
✓ ALL SPRINT 1 TO 11.5 TESTS PASSED SUCCESSFULLY in 17.37s!
===========================================================
```

---

## 5. Conclusion & Readiness for Sprint 12

The QCOM backend inventory engine is now hardened and mathematically consistent. Physical stock is protected against leakage from abandoned online checkouts, payment gateway failures, and spurious cancellations. With deterministic row locking, zero-phantom-inventory safeguards, and quantity-aware pricing validation in place, the system is fully prepared for the upcoming Sprint 12 implementation of temporary pre-payment checkout reservations.
