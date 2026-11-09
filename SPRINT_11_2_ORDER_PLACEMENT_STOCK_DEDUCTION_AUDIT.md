# SPRINT 11.2 — ORDER-PLACEMENT STOCK DEDUCTION & REAL-TIME AVAILABILITY INTEGRITY AUDIT AND IMPLEMENTATION PLAN

```
========================================================================================
QCOM SPRINT 11.2 AUDIT REPORT & BLUEPRINT
MODE: READ-ONLY AUDIT & IMPLEMENTATION PLAN
TARGET: QCOM/backend & QCOM/customer-app
DATE: OCTOBER 2026
========================================================================================
```

---

## 1. Executive Summary

This independent read-only architectural audit and implementation plan investigates QCOM's stock deduction lifecycle during checkout, order placement, online payment, and Cash on Delivery (COD).

### Core Business Rule
> **Inventory must NOT be deducted** when adding items to cart, viewing cart, opening checkout, starting checkout, selecting payment methods (online or COD).
> **Inventory must be deducted atomically when the order is successfully placed**, applying equally to both online payment orders and Cash on Delivery orders.

---

## 2. Current State Findings & Architectural Verification

### A. Cart & Pricing Phase (Verified Non-Deducting)
- **Carts**: Client-side ephemeral arrays managed in React state (`CartPage.tsx`, `App.tsx`) with zero server-side cart inventory reservations.
- **Pricing Quotes**: `POST /api/pricing/quote` (`pricingRoutes.ts` / `pricingEngine.ts`) reads available stock (`stock_count - reserved_count`) to validate availability during quote calculation but performs **no database mutations or stock deductions**.

### B. Order Placement Phase (`POST /api/orders/create`)
- **Transaction Boundary**: Managed inside a PostgreSQL transaction (`orderService.ts`).
- **Stock Reservation**: Currently calls `inventoryService.reserveStock()`, which issues row-level locks (`FOR UPDATE` on `store_inventory`), checks available stock (`stock_count - reserved_count`), increments `reserved_count`, and inserts rows into `inventory_reservations` with status `'RESERVED'`.
- **The Gap (Online vs. COD)**:
  - **Online Payment Orders**: Historically relied on asynchronous payment verification (`paymentService.ts`) to call `inventoryService.commitStock()`, leaving items in `RESERVED` status until webhook or gateway callback completion.
  - **COD Orders**: Left items in `RESERVED` status indefinitely or until fulfillment/delivery, as there was no automated stock commit trigger for COD orders.

### C. Idempotency Protection
- **Idempotency Table**: `idempotency_keys` table with unique constraint on `idempotency_key` and SHA-256 request payload fingerprinting (`request_fingerprint`).
- **Resilience**: Prevents duplicate order creation and re-deduction of inventory during client network retries or timeouts.

---

## 3. Gaps and Correctness Deficiencies

1. **Delayed vs. Immediate Stock Deduction**:
   - Deducting stock only upon payment capture (for online orders) or delivery (for COD) creates race conditions where reserved stock is held across payment gateway timeouts, reducing real-time availability for other shoppers.
2. **Unified Commit Requirement**:
   - Both Online and COD orders must deduct actual stock (`stock_count = stock_count - quantity`) immediately upon successful order placement commit, transitioning inventory reservations directly to `'COMMITTED'`.
3. **Customer-Facing Error Contracts**:
   - When requested quantity exceeds available stock during checkout, the backend must return structured error codes (`INSUFFICIENT_STOCK`, `OUT_OF_STOCK`) with exact product IDs and available quantities to prompt cart adjustment.

---

## 4. Architectural Implementation Plan (Sprint 11.2)

### Step 1: Immediate Stock Deduction on Order Placement
- Update `orderService.createOrder` to invoke `inventoryService.commitStock` (or execute direct stock deduction & reservation commit) **inside the primary order creation transaction**, immediately upon successful order insertion.
- Remove reliance on payment webhooks for stock deduction. Payment status (`PENDING` vs `PAID`) remains orthogonal to physical inventory deduction.

### Step 2: Idempotent Retry Safety
- Maintain the existing `idempotency_keys` mechanism. If a client retries with the same `Idempotency-Key` after a dropped HTTP response, the middleware returns the cached 200 OK response containing the original order record, without creating duplicate orders or re-deducting stock.

### Step 3: Real-Time Availability & Checkout Validation
- Ensure checkout validation checks live `stock_count - reserved_count` with row-level locks (`FOR UPDATE`) and rejects orders with clear structured errors if stock runs out between quoting and checkout submission.

---

*Report generated in strict compliance with read-only audit rules. No source code modifications applied.*
