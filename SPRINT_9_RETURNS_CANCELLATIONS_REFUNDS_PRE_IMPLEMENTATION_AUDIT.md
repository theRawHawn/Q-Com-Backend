# SPRINT 9 — RETURNS, CANCELLATIONS & REFUNDS
## PRE-IMPLEMENTATION ARCHITECTURE, FINANCIAL, TAX, CONCURRENCY & SECURITY AUDIT

**Document Type:** Senior Distributed Systems, Financial & Security Architect Audit  
**Audit Type:** Strict Read-Only Pre-Implementation Audit  
**Target Repository:** `QCOM/backend`  
**Target Architecture:** Multi-Tenant Quick-Commerce Marketplace (Seller-Owned Inventory Model)  
**Date:** 2026-10-07  
**Audit Mode:** **STRICT READ-ONLY** (Zero code, schema, test, or config modifications)  
**Implementation Clearance:** **BLOCKED PENDING SPRINT 9 ARCHITECTURAL BLUEPRINT**  

---

## 1. REPOSITORY BASELINE & ARTIFACT INVENTORY

An exhaustive, non-intrusive inspection of the `QCOM/backend` codebase was conducted to establish the exact baseline upon which Sprint 9 will build.

### 1.1 Repository Structure & Module Topology
```text
QCOM/backend/
├── src/
│   ├── app.ts                          # Express application factory & middleware chain
│   ├── server.ts                       # HTTP server & WebSocket gateway initialization
│   ├── config/
│   │   ├── env.ts                      # Zod-validated environment schema
│   │   └── index.ts                    # Configuration re-exports
│   ├── database/
│   │   ├── connection.ts               # PostgreSQL connection pool & transaction manager
│   │   ├── migrator.ts                 # Schema migration runner (001–016)
│   │   └── redis.ts                    # Ephemeral cache, rate limiter & in-memory store
│   ├── middleware/
│   │   ├── auth.ts                     # JWT & session verification
│   │   ├── errorHandler.ts             # Global error handler with 503 fail-closed support
│   │   ├── rateLimiter.ts              # Tiered token-bucket rate limiter
│   │   ├── rbac.ts                     # Role-based access control middleware
│   │   ├── requestId.ts                # Correlation ID injector
│   │   ├── requestLogger.ts            # Structured JSON HTTP logger
│   │   ├── resourceOwnership.ts        # Tenant & customer IDOR guards
│   │   └── securityHeaders.ts          # Helmet-style OWASP security headers
│   ├── modules/
│   │   ├── ai/                         # Gemini AI assistant & catalogue enrichment
│   │   ├── audit/                      # Immutable audit log service
│   │   ├── auth/                       # Centralized authentication & session rotation
│   │   ├── catalog/                    # Seller-owned product & SKU catalogue
│   │   ├── customers/                  # Customer profile & addresses
│   │   ├── delivery/                   # Delivery economics & SLA thresholds
│   │   ├── dispatch/                   # Dynamic candidate scoring, offer & matching
│   │   ├── inventory/                  # Stock reservations & committed stock updates
│   │   ├── invoices/                   # Statutory GST B2B/B2C PDF tax invoice generation
│   │   ├── ledger/                     # Double-entry General Ledger & Chart of Accounts
│   │   ├── notifications/              # SHA-256 tokens, preferences, campaigns, delivery
│   │   ├── orders/                     # Order placement, pricing locking, 5-min cancellation
│   │   ├── outbox/                     # Transactional outbox, SKIP LOCKED relayer
│   │   ├── payments/                   # Payment state machine, Razorpay/Mock provider
│   │   ├── pricing/                    # Multi-tier pricing engine, money math, GST engine
│   │   ├── rbac/                       # Dynamic permissions & role resolution
│   │   ├── realtime/                   # Native WebSocket gateway & ephemeral GPS
│   │   ├── routing/                    # PostGIS spatial routing & route telemetry
│   │   ├── sellers/                    # Merchant profiles, KYC & store staff
│   │   └── settlements/                # Seller settlement allocation & rider payouts
│   └── routes/                         # REST API route controllers
├── migrations/                         # 001_enable_extensions.sql through 016_create_realtime_outbox_and_notifications.sql
├── seeds/                              # Statutory tax rules, roles, permissions, COA seed data
└── tests/                              # Automated integration suites (Sprints 1–8)
```

### 1.2 Baseline Verification Metrics
- **Automated Test Suite:** 100% passing across all 8 sprints (`tests/run-all-tests.ts`: 13.33s).
- **Compilation & Static Checks:** `npm run build` and `tsc --noEmit` pass with zero diagnostics.
- **Customer Frontend Isolation:** `QCOM/customer-app/src/**` has 0 modifications.

---

## 2. CURRENT ORDER STATE MACHINE AUDIT

### 2.1 Actual Order Lifecycle in PostgreSQL
In `QCOM/backend/migrations/004_create_orders_and_trips.sql` (Line 8–10), the database strictly constrains order status via a table-level check:
```sql
CHECK (status IN ('placed', 'picking', 'packed', 'out_for_delivery', 'arriving', 'delivered', 'cancelled'))
```
The application code in `orderTypes.ts` mirrors this constraint:
```typescript
export type OrderStatus = 'placed' | 'picking' | 'packed' | 'out_for_delivery' | 'arriving' | 'delivered' | 'cancelled';
```

### 2.2 Order State Transition Matrix (Current State)
| From State | Allowed Target States | Permitted Actors | Row Lock | Transactional | Inventory Side-Effect | Financial / Ledger Side-Effect | Outbox Event |
|---|---|---|:---:|:---:|---|---|---|
| **[NONE]** | `placed` | Customer | `FOR UPDATE` on inventory | Yes (`transaction`) | Stock reserved (`inventory_reservations`) | None (`payment_status: PENDING`) | `ORDER_CREATED` |
| `placed` | `picking` | Seller / Staff | No | No | None | None | None |
| `placed` | `cancelled` | Customer (<= 5 min) | `FOR UPDATE` on orders | Yes (`transaction`) | Stock released if `status = 'RESERVED'` | Pseudo-refund in memory; sets `payment_status = 'REFUNDED'` | `ORDER_CANCELLED` |
| `picking` | `packed` | Seller / Staff | No | No | None | None | None |
| `picking` | `cancelled` | Customer (<= 5 min) | `FOR UPDATE` on orders | Yes (`transaction`) | Stock released if `status = 'RESERVED'` | Pseudo-refund in memory; sets `payment_status = 'REFUNDED'` | `ORDER_CANCELLED` |
| `packed` | `out_for_delivery` | Rider / Dispatch | `FOR UPDATE` on trips | Yes (`transaction`) | None (already committed on payment) | None | `TRIP_STARTED` |
| `packed` | `cancelled` | Customer (<= 5 min) | `FOR UPDATE` on orders | Yes (`transaction`) | Stock released if `status = 'RESERVED'` | Pseudo-refund in memory; sets `payment_status = 'REFUNDED'` | `ORDER_CANCELLED` |
| `out_for_delivery` | `arriving` | Rider / Dispatch | No | No | None | None | None |
| `out_for_delivery` | `delivered` | Rider / OTP | `FOR UPDATE` on orders/trips | Yes (`transaction`) | None | Settlement allocated (`seller_ledgers`, `rider_ledgers`, GL) | `TRIP_COMPLETED` |
| `arriving` | `delivered` | Rider / OTP | `FOR UPDATE` on orders/trips | Yes (`transaction`) | None | Settlement allocated (`seller_ledgers`, `rider_ledgers`, GL) | `TRIP_COMPLETED` |
| `delivered` | **[TERMINAL]** | None | — | — | — | — | — |
| `cancelled` | **[TERMINAL]** | None | — | — | — | — | — |

### 2.3 Critical Architectural Gaps in Current State Machine
1. **Zero Return Statuses:** Neither the database schema (`orders` table CHECK constraint) nor TypeScript types define any return statuses (`return_requested`, `return_approved`, `return_rejected`, `return_picked_up`, `return_received`, `returned`).
2. **Missing Granular Cancellation States:** Only a coarse `cancelled` status exists. No distinction exists between `cancelled_by_customer`, `cancelled_by_seller`, `cancelled_by_admin`, or `failed_delivery_cancelled`.
3. **Missing Refund Lifecycle States:** In `orders.payment_status`, only `PENDING`, `PAID`, `FAILED`, and `REFUNDED` are permitted. Intermediate states (`REFUND_REQUESTED`, `REFUND_PENDING`, `PARTIALLY_REFUNDED`, `REFUND_FAILED`) do not exist on the `orders` record.

---

## 3. CANCELLATION ARCHITECTURE AUDIT

### 3.1 Existing Implementation (`orderService.cancelOrder`)
The sole existing cancellation implementation resides in `src/modules/orders/orderService.ts` (Lines 390–461) and is exposed via `POST /api/v1/orders/:orderId/cancel`.

```typescript
// orderService.ts lines 414-439
const placedTime = new Date(o.placed_at || o.created_at).getTime();
const elapsedMinutes = (Date.now() - placedTime) / (1000 * 60);
if (elapsedMinutes > 5) {
  throw new Error(`Cancellation window expired. Orders can only be cancelled within 5 minutes of placement...`);
}

await client.query(`
  UPDATE orders
  SET status = 'cancelled',
      cancellation_reason = $2,
      payment_status = CASE WHEN payment_status = 'PAID' THEN 'REFUNDED' ELSE payment_status END
  WHERE id = $1
`, [orderId, reason || 'Customer requested cancellation within grace period.']);

await inventoryService.releaseStock(orderId, client);

const refundRecord = {
  refundId: `ref_${crypto.randomBytes(8).toString('hex')}`,
  orderId,
  amount: parseFloat(o.total_amount),
  status: 'PROCESSED',
  timestamp: new Date().toISOString(),
};
```

### 3.2 Severe Defects in Existing Cancellation Logic
1. **Simulated Phantom Refund:** The system generates a fake string `refundId` (`ref_...`) in memory. It **never calls the payment gateway**, generates no gateway refund transaction, and leaves the customer's actual funds trapped at the payment processor.
2. **Missing General Ledger Integration:** Despite `ledgerService.recordPreFulfillmentCancellationRefund` existing in the codebase (Batch Q: Dr 2010 Cr 1010), `orderService.cancelOrder` **never calls the ledger**. Customer funds remain recorded as active platform escrow liability in Account 2010.
3. **Broken Committed Inventory Restoration:** `inventoryService.releaseStock` queries `inventory_reservations WHERE status = 'RESERVED'`. However, when payment captures, `inventoryService.commitStock` transitions reservations to `COMMITTED` and decrements `store_inventory.stock_count`. If a paid order is cancelled, `releaseStock` finds zero `RESERVED` rows, releasing nothing and silently desynchronizing physical stock from seller inventory.
4. **No Dispatch Decoupling:** If an order has an active dispatch assignment (`dispatch_assignments`) or an active offer (`dispatch_offers`), cancelling the order leaves the dispatch assignment in `OFFERED` or `ASSIGNED` and the delivery partner locked in `OFFERED`.
5. **No Actor Differentiation:** The endpoint only accepts `req.auth!.userId` and strictly checks `WHERE id = $1 AND user_id = $2`. Merchants, riders, and platform administrators cannot cancel an order even when operationally mandatory (e.g. merchant out-of-stock or customer address unserviceable).
6. **Uncontrolled Reason Strings:** Cancellation reasons are arbitrary unvalidated strings (`req.body.reason`), preventing automated reporting, liability attribution, or cancellation metrics.

---

## 4. CONCURRENCY & RACE CONDITIONS AUDIT

An evaluation of high-concurrency race condition scenarios across the marketplace was conducted:

### Race Scenario A: Customer Cancels while Seller Accepts / Prepares
- **Vulnerability:** `orderService.cancelOrder` locks `orders FOR UPDATE`. However, seller order state transition endpoints in `orderRoutes.ts` execute non-transactional `UPDATE orders SET status = 'picking'` without taking a row-level lock on `orders`.
- **Impact:** Lost-update anomaly. If the customer cancellation executes concurrently with seller acceptance, the seller update may overwrite `status = 'cancelled'` back to `picking`, or the customer cancel may abort an in-flight order without notifying the merchant.
- **Required Guard:** Deterministic `SELECT ... FOR UPDATE` row locks on `orders` across all merchant status transition endpoints.

### Race Scenario B: Customer Cancels while Rider Assignment / Dispatch Occurs
- **Vulnerability:** Dispatch engine (`dispatchService.assignOrder`) acquires row locks on `dispatch_assignments` and `delivery_trips`, but does not acquire a lock on `orders`. Concurrently, `orderService.cancelOrder` updates `orders` without locking `dispatch_assignments`.
- **Impact:** Ghost delivery dispatch. A rider accepts an offer for an order that was cancelled milliseconds earlier. The rider travels to the merchant store for an order that no longer exists.
- **Required Guard:** Lock ordering hierarchy: `orders` -> `dispatch_assignments` -> `delivery_trips` -> `riders`. When an order is cancelled, the transaction must atomically cancel any active dispatch assignment and restore the rider to `AVAILABLE`.

### Race Scenario C: Customer Cancels while Payment Webhook Captures Payment
- **Vulnerability:** `PaymentService.handleWebhookEvent` processes `payment.captured` by locking `orders FOR UPDATE` and setting `payment_status = 'PAID'`. Concurrently, `orderService.cancelOrder` checks `payment_status` to decide whether to set `payment_status = 'REFUNDED'`.
- **Impact:** Unrefunded cancelled order. If cancellation executes right before the webhook acquires the lock, cancellation sees `payment_status = 'PENDING'` and does not mark it refunded. Milliseconds later, the webhook acquires the lock and marks the order `payment_status = 'PAID'`. The order is now `status = 'cancelled'` but `payment_status = 'PAID'`, with zero refund triggered.
- **Required Guard:** Both cancellation and payment capture must inspect and synchronize `payment_intents` and `orders` under an atomic transaction with terminal state guards.

### Race Scenario D: Simultaneous Duplicate Cancellation Requests
- **Vulnerability:** `POST /api/v1/orders/:orderId/cancel` lacks idempotency key enforcement.
- **Impact:** If two parallel requests fire, both enter `orderService.cancelOrder`. While the `FOR UPDATE` serializes them, the second request throws an unhandled error `Order is already cancelled` (HTTP 400) instead of returning the cached idempotent cancellation payload.
- **Required Guard:** Idempotency key tracking via `idempotency_keys` table on all cancellation and refund endpoints.

### Race Scenario E: Cancellation while Settlement Allocation Occurs
- **Vulnerability:** If an order is delivered and `settlementAllocationService.allocateFulfilledOrder` executes concurrently with an administrative cancellation, double-credit or unallocated state occurs.
- **Required Guard:** Strict terminal state guard: once an order is `delivered`, cancellations are forbidden and must be routed exclusively through the **Return & Refund** pipeline.

---

## 5. PAYMENT & REFUND ARCHITECTURE AUDIT

### 5.1 Existing Payment Subsystem Analysis
The current payment subsystem (`QCOM/backend/src/modules/payments/`) consists of:
- `payment_intents` table (tracks gateway orders and authorizations)
- `payment_receipts` table (records successful capture transactions)
- `webhook_events` table (deduplicates and logs inbound provider webhooks)
- `PaymentStateMachine` (defines state transitions: `CREATED` -> `PENDING` -> `AUTHORIZED` -> `CAPTURED` -> `REFUNDED` / `PARTIALLY_REFUNDED`)
- `PaymentProvider` abstraction with `MockPaymentProvider` and `RazorpayPaymentProvider`

### 5.2 Critical Refund Infrastructure Deficiencies
1. **Zero Database Refund Records:** There is no `refunds` or `payment_refunds` table anywhere in the schema. Neither gateway refund IDs, refund amounts, reason codes, nor statuses are persisted.
2. **Missing Provider Refund Integration:** The `PaymentProvider` interface defines:
   ```typescript
   export interface PaymentProvider {
     createOrder(orderId: string, amount: number, timestamp: number): Promise<ProviderPaymentOrderResult>;
     verifyPaymentSignature(params: ProviderVerifyParams): boolean;
     verifyWebhookSignature(params: ProviderWebhookVerifyParams): boolean;
     mapProviderStatus(providerStatus: string): string;
   }
   ```
   **It has zero methods for refund operations.** It cannot initiate refunds, query refund status, or process gateway refund callbacks.
3. **Missing Webhook Refund Handlers:** `PaymentService.handleWebhookEvent` handles `payment.captured` and `payment.failed`. It has zero logic for `refund.created`, `refund.processed`, `refund.failed`, or `payment.refunded`.

---

## 6. REFUND IDEMPOTENCY & SAFETY REQUIREMENTS

### 6.1 Idempotency Invariants
Sprint 9 must strictly enforce that **one logical refund request produces at most one payment gateway refund transaction**.

```text
[Client / Admin Request] ──(Idempotency Key)──> [PostgreSQL refund_requests]
                                                        │
                                          ┌─────────────┴─────────────┐
                                      (Found)                     (New)
                                          │                           │
                                    Return Cached               Lock Order
                                    Refund Result              Create Row: PENDING
                                                                      │
                                                              Call Gateway Refund
                                                                      │
                                                        ┌─────────────┴─────────────┐
                                                    (Success)                    (Failure)
                                                        │                           │
                                                Update: PROCESSED           Update: FAILED
                                                Post GL Reversals           Release Locks
```

### 6.2 Failure & Webhook Race Handling
- **Gateway Network Timeout:** If the gateway API call times out, the local refund status must transition to `GATEWAY_PENDING`, not `FAILED`. The system must rely on inbound webhooks or an outbox reconciliation poller rather than blindly retrying an unconfirmed refund call (which would trigger a double refund).
- **Out-of-Order Webhooks:** If a gateway `refund.processed` webhook arrives before the synchronous API call completes, the webhook must record the event in `webhook_events` and transition the refund atomically without error.

---

## 7. PARTIAL REFUND & FINANCIAL FACT ENGINE

### 7.1 Historical Snapshot Invariant
In quick-commerce, product prices, delivery fees, and statutory tax rates change frequently. **A refund must NEVER recalculate economics based on live catalogue or current tax rates.** It must exclusively reference the historical facts frozen in `orders.pricing_snapshot`.

### 7.2 Partial Refund Mathematical Allocation
When a customer returns a subset of items (e.g. 1 out of 3 units), the refund engine must distinguish between product-level charges and order-level fixed charges:

$$\text{Item Refund} = \text{Unit Gross Price} \times \text{Returned Qty}$$

$$\text{Taxable Reversal} = \text{Unit Taxable Amount} \times \text{Returned Qty}$$

$$\text{GST Reversal} = (\text{CGST} + \text{SGST} + \text{IGST}) \times \text{Returned Qty}$$

### 7.3 Treatment of Platform & Delivery Fees
- **Pre-Dispatch / Store Cancellation:** Platform fees (Delivery Fee, Handling Fee) were never incurred and must be refunded 100% to the customer.
- **Post-Delivery Return:** The delivery was successfully performed. The customer delivery fee (Account 4020) and delivery GST (Account 2070) **must NOT be refunded** unless the return is due to a merchant defect or platform delivery failure.

---

## 8. STATUTORY TAX & GST REVERSAL AUDIT

### 8.1 GST Compliance Requirements (Section 34, CGST Act 2017)
Under Indian statutory tax law:
1. **Credit Note Issuance:** Every return or downward price adjustment requires a formal GST Credit Note referencing the original Tax Invoice number and date.
2. **Tax Components:** Reversals must match the original supply classification:
   - Intra-state (Karnataka -> Karnataka): Reverse CGST + SGST in identical proportions.
   - Inter-state: Reverse IGST.
3. **GST-TCS Adjustment (Section 52):** Marketplace TCS deducted at 0.50% (0.25% CGST + 0.25% SGST) must be reduced from the seller's net taxable supplies reported in GSTR-8 for the tax period.
4. **Income-Tax TDS Adjustment (Section 194-O / 393):** E-commerce TDS deducted at 1% on gross merchandise value must be adjusted against the seller's cumulative monthly threshold.

---

## 9. SELLER SETTLEMENT REVERSAL ARCHITECTURE

### 9.1 Seller Settlement Invariants
In Sprint 7, `settlementAllocationService.allocateFulfilledOrder` credits `net_seller_payable` to `seller_ledgers` (Account 2020).

### 9.2 The Three Settlement Lifecycles
```text
State 1: Cancellation Before Settlement Allocation
  └─ Customer Escrow (2010) holds full funds. Merchant has not been credited.
     Reversal: Dr 2010, Cr 1010. Zero merchant ledger mutation needed.

State 2: Return After Settlement Allocation but BEFORE Bank Payout
  └─ Merchant ledger has ORDER_CREDIT (Account 2020). Payout has not been disbursed.
     Reversal: Dr 2020 (Merchant Payable), Cr 1010 (Gateway Escrow).
     Action: Post ORDER_DEBIT to seller_ledgers, reducing available payout balance.

State 3: Return AFTER Bank Payout Disbursed (Account 1020 Cleared)
  └─ Payout was already transferred to seller's bank via IMPS/NEFT (UTR generated).
     Reversal: Dr 1040 (Merchant Receivable / Overdrawn Balance), Cr 1010 (Gateway Escrow).
     Action: Post CLAWBACK_DEBIT to seller_ledgers.
     If seller balance turns negative: Block payouts, offset against future daily orders.
```
**CRITICAL SECURITY INVARIANT:** Seller funds must never disappear silently. Every clawback must be supported by an immutable subledger entry in `seller_ledgers`.

---

## 10. RIDER EARNINGS REVERSAL & POLICY AUDIT

### 10.1 Rider Logistics Compensation Rules
Riders operate as independent gig partners. The audit establishes that rider earnings must adhere to fair compensation boundaries:

1. **Cancellation Before Rider Acceptance:** No trip created; rider receives ₹0.
2. **Cancellation After Rider Reaches Store (Arrival SLA):** Rider expended fuel and time. Rider must receive **Base Fare Compensation** (₹35.00) charged to platform logistics expense (Account 5010), funded by cancellation fee or platform subsidy.
3. **Cancellation After Rider Pickup:** Rider has physical custody of goods. Rider must return goods to the merchant store and receive **Full Delivery Fare + Return Leg Mileage**.
4. **Post-Delivery Return:** Delivery was successfully completed. **The rider's delivery earning is NEVER clawed back.** If a return pickup is scheduled, a **new independent delivery trip** is created with a separate earning for the return rider.

---

## 11. INVENTORY RESTORATION & STOCK MODEL AUDIT

### 11.1 Marketplace Stock Boundary
QCOM does NOT own inventory. Inventory resides in `store_inventory` linked to `merchants`.

### 11.2 Reservation Release vs. Physical Restock
```text
Case A: Cancellation Prior to Store Pick/Pack
  - Stock was only in inventory_reservations (status = 'RESERVED').
  - Physical goods never left shelf.
  - Action: Execute inventoryService.releaseStock. Decrement reserved_count.

Case B: Cancellation After Pick/Pack / During Transit
  - Stock was COMMITTED. Physical goods are in delivery container.
  - Action: Goods must be physically returned and accepted by the merchant before restock.

Case C: Customer Return After Delivery
  - Goods were in customer possession.
  - Risk of damage, tampering, broken seals, or expired hardware items.
  - Action: Goods enter RETURN_INSPECTION.
  - ONLY items passing quality check (QC) are restored to store_inventory.stock_count.
  - Damaged or rejected returns are written off to seller damage logs, NOT restocked.
```

---

## 12. RETURN STATE MACHINE SPECIFICATION

Sprint 9 must establish a dedicated, secure Return Lifecycle:

```text
[DELIVERED]
    │
    ▼
[RETURN_REQUESTED] ──(Seller/Admin Rejection)──> [RETURN_REJECTED] (Terminal)
    │
    ▼ (Eligibility Verified: Window <= 48 hrs, Category Allowed)
[RETURN_APPROVED]
    │
    ▼ (Dispatch Engine Generates Reverse Pickup Trip)
[RETURN_PICKUP_ASSIGNED]
    │
    ▼
[RETURN_PICKED_UP] ──(Rider Verifies Item Code / Serial)
    │
    ▼
[RETURN_RECEIVED_AT_STORE]
    │
    ▼ (Merchant QC Inspection)
┌───┴────────────────────────┐
▼                            ▼
[RETURN_ACCEPTED]         [RETURN_REJECTED_QC] ──> Goods Returned to Customer
    │
    ▼ (Triggers Refund Pipeline)
[REFUND_PROCESSING]
    │
    ▼
[REFUNDED] (Terminal)
```

---

## 13. RETURN ABUSE & DUPLICATE PREVENTION GUARDS

### 13.1 Required Database & Domain Guards
1. **Quantity Ceiling Constraint:** Total returned quantity across all return requests for an order line item must not exceed `order_items.quantity`.
2. **Refund Ceiling Constraint:** Total refunded amount across an order must never exceed `orders.total_amount`.
3. **Window Enforcement:** Return requests must be rejected if `NOW() - orders.delivered_at > return_window_hours` (e.g. 48 hours for hardware spares, non-returnable for consumables/cement/chemicals).
4. **Anti-IDOR Verification:** Customer can only request returns for orders where `order.user_id === req.auth.userId`.
5. **Merchant Cross-Tenant Isolation:** Merchants can only inspect and approve returns for orders where `order.merchant_id === req.auth.merchantId`.

---

## 14. CASH ON DELIVERY (COD) & ACCOUNT 1030 RECONCILIATION

### 14.1 The Cash-in-Hand Risk
In Indian quick-commerce, Cash on Delivery (Pay on Delivery) introduces severe reconciliation risks:
- When COD is delivered, cash is in Account `1030` (*Floating Cash in Hands of Riders*).
- If the customer cancels at doorstep or returns items:
  - If cash was NOT yet handed over: No cash refund needed. Escrow liability is null.
  - If cash WAS handed over and order is subsequently returned: Rider cannot hand cash back from pocket without formal verification. Refund must be disbursed via **Instant UPI / Bank Transfer to customer's account**, while the rider remains obligated to remit the physical cash collected via Account 1030 remittance.

---

## 15. DOUBLE-ENTRY GENERAL LEDGER REVERSAL BLUEPRINT

To guarantee the primary accounting invariant:
$$\sum \text{Debits} \equiv \sum \text{Credits}$$

### 15.1 Accounting Treatment Matrix for Sprint 9
| Financial Scenario | Debit Entry | Credit Entry | Balance Validation |
|---|---|---|:---:|
| **Full Pre-Fulfillment Cancellation (Online Paid)** | **Dr 2010** Customer Escrow Payable (₹Total) | **Cr 1010** Cash at Gateway / Escrow (₹Total) | Balanced |
| **Post-Fulfillment Return & Refund (Pre-Payout)** | **Dr 2020** Merchant Payable (₹Net Goods)<br>**Dr 4010** Commission Revenue (₹Commission)<br>**Dr 2070** Output GST on Fees (₹Fee GST)<br>**Dr 2040** GST-TCS Section 52 (₹TCS)<br>**Dr 2050** Income-Tax TDS (₹TDS) | **Cr 1010** Cash at Gateway / Escrow (₹Total Refund) | Balanced |
| **Post-Fulfillment Return & Refund (Post-Payout)** | **Dr 1040** Merchant Receivable / Clawback (₹Net Goods)<br>**Dr 4010** Commission Revenue (₹Commission)<br>**Dr 2070** Output GST on Fees (₹Fee GST)<br>**Dr 2040** GST-TCS Section 52 (₹TCS)<br>**Dr 2050** Income-Tax TDS (₹TDS) | **Cr 1010** Cash at Gateway / Escrow (₹Total Refund) | Balanced |
| **Partial Return (Single SKU Refunded)** | **Dr 2020** Merchant Payable (Proportional)<br>**Dr 4010** Commission (Proportional)<br>**Dr 2070** GST on Comm (Proportional) | **Cr 1010** Cash at Gateway / Escrow (Item Gross) | Balanced |
| **COD Return (Cash Remitted by Rider)** | **Dr 2020** Merchant Payable (Net Goods)<br>**Dr 4010** Commission / Platform Revenue | **Cr 1020** Bank Operating Account (Customer UPI Refund) | Balanced |

---

## 16. EVENT, OUTBOX & NOTIFICATION ARCHITECTURE

Sprint 9 domain state mutations must integrate seamlessly with Sprint 8's transactional outbox engine (`outbox_events`).

### 16.1 Domain Event Catalog for Sprint 9
```typescript
type Sprint9DomainEvents =
  | 'OrderCancelled'
  | 'OrderCancellationFailed'
  | 'RefundRequested'
  | 'RefundInitiated'
  | 'RefundCompleted'
  | 'RefundFailed'
  | 'ReturnRequested'
  | 'ReturnApproved'
  | 'ReturnRejected'
  | 'ReturnPickupAssigned'
  | 'ReturnReceivedAtStore'
  | 'ReturnAccepted'
  | 'ReturnRejectedQC'
  | 'SellerClawbackRecorded'
  | 'InventoryRestocked';
```
- **Dual-Write Rule:** Staged via `outboxService.stageEvent(client, event)` inside the same PostgreSQL transaction as the order/refund mutation.
- **Realtime Broadcasts:** Dispatched to rooms `order:<id>`, `user:<id>`, `merchant:<id>`, and `admin:fleet`.
- **Push Notifications:** Dispatched via `notificationService` to Customer (Refund confirmation), Merchant (Return arrival alert), and Rider (Pickup dispatch).

---

## 17. AUTHORIZATION, RBAC & ANTI-IDOR MATRIX

| Operation | Required Role / Permission | Tenant / Ownership Guard |
|---|---|---|
| `POST /api/v1/orders/:id/cancel` (Customer) | `CUSTOMER` / `orders.cancel` | `order.user_id === req.auth.userId` |
| `POST /api/v1/orders/:id/cancel-merchant` | `SELLER` / `orders.cancel` | `order.merchant_id IN (req.auth.merchantIds)` |
| `POST /api/v1/admin/orders/:id/cancel` | `SUPER_ADMIN`, `OPERATIONS` | Global override with audit log |
| `POST /api/v1/orders/:id/returns` | `CUSTOMER` | `order.user_id === req.auth.userId` |
| `POST /api/v1/returns/:id/review` | `SELLER`, `SUPER_ADMIN` | Merchant ownership of return order |
| `POST /api/v1/returns/:id/qc-inspect` | `SELLER` | Merchant store staff authorization |
| `POST /api/v1/admin/refunds/issue` | `FINANCE_ADMIN`, `SUPER_ADMIN` | RBAC permission `refunds.approve` |

---

## 18. FAILURE RECOVERY & FAIL-CLOSED BEHAVIOR

1. **Database Disconnect during Refund:** Must fail closed (`HTTP 503 DATABASE_UNAVAILABLE`, `Retry-After: 3`). No gateway refund may be committed without database state persistence.
2. **Gateway Disconnect during Refund API Call:** The local state must remain `REFUND_PENDING` with an outbox polling worker scheduled to check status via gateway reconciliation API.
3. **Webhook Replay:** Webhook handler must check `webhook_events` by `event_id` and return `200 OK` on duplicates without repeating financial postings.

---

## 19. REQUIRED SCHEMA DESIGN SPECIFICATION (MIGRATION 017)

To support Sprint 9 without breaking existing schema constraints, Migration 017 must provision:

```sql
-- 1. Extend orders status CHECK constraint to support returns
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (
    status IN (
        'placed', 'picking', 'packed', 'out_for_delivery', 'arriving', 'delivered', 
        'cancelled', 'return_requested', 'return_approved', 'return_rejected', 
        'return_picked_up', 'returned'
    )
);

-- 2. Extend orders payment_status CHECK constraint
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_payment_status_check CHECK (
    payment_status IN ('PENDING', 'PAID', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'REFUND_PENDING')
);

-- 3. Create refunds table
CREATE TABLE IF NOT EXISTS refunds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    refund_number VARCHAR(40) UNIQUE NOT NULL,
    order_id UUID NOT NULL REFERENCES orders(id),
    payment_id VARCHAR(100),
    amount NUMERIC(10,2) NOT NULL CHECK (amount > 0),
    currency VARCHAR(10) DEFAULT 'INR',
    reason_code VARCHAR(50) NOT NULL,
    reason_description TEXT,
    refund_type VARCHAR(20) NOT NULL CHECK (refund_type IN ('FULL', 'PARTIAL')),
    status VARCHAR(30) NOT NULL DEFAULT 'REQUESTED' CHECK (
        status IN ('REQUESTED', 'PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'REVERSED')
    ),
    provider_refund_id VARCHAR(100),
    idempotency_key VARCHAR(120) UNIQUE,
    created_by UUID REFERENCES users(id),
    processed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Create returns table
CREATE TABLE IF NOT EXISTS order_returns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    return_number VARCHAR(40) UNIQUE NOT NULL,
    order_id UUID NOT NULL REFERENCES orders(id),
    user_id UUID NOT NULL REFERENCES users(id),
    merchant_id UUID NOT NULL REFERENCES merchants(id),
    status VARCHAR(30) NOT NULL DEFAULT 'REQUESTED' CHECK (
        status IN (
            'REQUESTED', 'APPROVED', 'REJECTED', 'PICKUP_ASSIGNED', 
            'PICKED_UP', 'RECEIVED_AT_STORE', 'ACCEPTED', 'REJECTED_QC', 'CANCELLED'
        )
    ),
    reason_code VARCHAR(50) NOT NULL,
    customer_notes TEXT,
    qc_notes TEXT,
    pickup_trip_id UUID REFERENCES delivery_trips(id),
    refund_id UUID REFERENCES refunds(id),
    requested_at TIMESTAMPTZ DEFAULT NOW(),
    approved_at TIMESTAMPTZ,
    received_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
);

-- 5. Create return items table
CREATE TABLE IF NOT EXISTS order_return_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    return_id UUID NOT NULL REFERENCES order_returns(id) ON DELETE CASCADE,
    order_item_id UUID NOT NULL REFERENCES order_items(id),
    product_id UUID NOT NULL REFERENCES products(id),
    quantity INT NOT NULL CHECK (quantity > 0),
    qc_status VARCHAR(20) DEFAULT 'PENDING' CHECK (qc_status IN ('PENDING', 'PASSED', 'FAILED')),
    restocked BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. Add Account 1040 (Merchant Receivable / Clawback Asset) to Chart of Accounts
INSERT INTO general_ledger_accounts (account_code, account_name, category, normal_balance, description)
VALUES ('1040', 'Merchant Receivable (Clawbacks & Returns)', 'ASSET', 'DEBIT', 'Unrecovered balances owed by merchants due to post-payout returns')
ON CONFLICT (account_code) DO NOTHING;
```

---

## 20. PHASED IMPLEMENTATION BLUEPRINT (FOR SPRINT 9)

When Sprint 9 execution begins, the engineer must execute along the following strictly ordered, test-verified phases:

1. **Phase 1 — Schema Migration 017:** Apply table extensions and new entities (`refunds`, `order_returns`, `order_return_items`, Account 1040).
2. **Phase 2 — Payment Gateway Refund Adapter:** Enhance `PaymentProvider` interface to support `createRefund`, `getRefundStatus`. Add `MockPaymentProvider` and `RazorpayPaymentProvider` implementations.
3. **Phase 3 — Refund & Cancellation Service Engine:**
   - Multi-actor cancellation (`cancelByCustomer`, `cancelBySeller`, `cancelByAdmin`).
   - Integration with `inventoryService.restockCommittedStock`.
   - Integration with `dispatchService.cancelOrderDispatch`.
   - General Ledger batch reversals in `ledgerService`.
4. **Phase 4 — Return & Reverse Logistics Pipeline:**
   - Return request validation (window, category, condition).
   - Seller approval and reverse pickup trip generation in `dispatchService`.
   - Store QC inspection and stock restoration.
5. **Phase 5 — Seller Clawback & Settlement Reversal:**
   - Debit note generation in `seller_ledgers`.
   - Offset handling against future merchant payouts.
6. **Phase 6 — API Routes & RBAC Integration:** Mount endpoints in `orderRoutes`, `returnRoutes`, `refundRoutes`.
7. **Phase 7 — Comprehensive Test Suite & Zero Regression:** Build `tests/sprint9-returns-cancellations.test.ts` covering all concurrency, financial balance, and tax invariants.

---

## 21. AUDIT CONCLUSION & GATE DECISION

- **Audit Findings:** The existing backend provides solid foundations in payments, ledger, and dispatch, but **completely lacks production-grade return workflows, payment gateway refunds, post-payout seller clawbacks, and committed inventory restock logic**.
- **Audit Decision:** **APPROVED WITH CONDITIONS (ROADMAP LOCKED)**
- **Next Step:** Awaiting user instruction to commence Phase 1 implementation of Sprint 9 according to this audit blueprint. Zero code modifications were made during this audit turn.
