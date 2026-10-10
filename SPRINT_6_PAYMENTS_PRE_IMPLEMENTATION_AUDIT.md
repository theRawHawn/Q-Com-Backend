# SPRINT 6 — PAYMENTS & PAYMENT WEBHOOKS PRE-IMPLEMENTATION ARCHITECTURAL AUDIT

**Date:** 2026-10-04  
**Auditor:** Senior Backend Architect  
**Domain Target:** `QCOM/backend` — Payments, Payment Webhooks, Ledger, Idempotency  
**Status:** **AUDIT COMPLETE — READY FOR REVIEW & APPROVAL**  

---

## 1. EXECUTIVE SUMMARY

An exhaustive pre-implementation architectural audit of the existing codebase was conducted prior to writing payment feature code. The goal is to establish the baseline of payment-related artifacts, identify risks, gaps, and integration boundaries, and design the complete Sprint 6 Payments & Payment Webhooks domain without regressing any prior sprint invariants (Sprint 1–5, specifically Dispatch F-01 through F-04).

---

## 2. EXISTING CODEBASE INVENTORY

### A. Existing Payment Code & Services
1. **`QCOM/backend/src/modules/payments/paymentService.ts`**:
   - `generatePaymentSignature(orderId, amount, timestamp)`: Computes HMAC-SHA256 signature using `env.JWT_SECRET` (fallback).
   - `createPaymentOrder(orderId, userId)`: Validates order existence and customer ownership, computes HMAC signature, inserts record into `payment_intents`.
   - `verifyPayment(params)`: Executes inside a PostgreSQL `transaction()`, locks `orders` row `FOR UPDATE`, checks `payment_receipts` for `transactionId` to prevent replay attacks, validates HMAC signature, updates `orders.payment_status = 'PAID'`, calls `inventoryService.commitStock()`, writes `payment_receipts`, and invokes `ledgerService.recordOrderPayment()`.
2. **`QCOM/backend/src/routes/paymentRoutes.ts`**:
   - Dual-mounted at `/api/payment` and `/api/payments` (and `/api/v1/payment`, `/api/v1/payments`).
   - `POST /create-order`: Protected by `authenticate`. Generates payment intent.
   - `POST /verify`: Protected by `authenticate`. Captures payment, verifies HMAC signature, handles replay attacks with HTTP 409.
3. **`QCOM/backend/src/modules/payments/paymentTypes.ts`**:
   - Interfaces: `PaymentIntent` and `PaymentReceipt`.

### B. Existing Payment Tables & Database Schemas
1. **`orders` table** (`migrations/004_create_orders_and_trips.sql`):
   - `payment_method VARCHAR(40) CHECK (payment_method IN ('Instant UPI', 'Corporate Card', 'Pay on Delivery', 'Trade Credit (Net 30)'))`
   - `payment_status VARCHAR(30) DEFAULT 'PENDING' CHECK (payment_status IN ('PENDING', 'PAID', 'FAILED', 'REFUNDED'))`
   - `total_amount NUMERIC(10,2) NOT NULL CHECK (total_amount >= 0)`
   - Breakdown columns: `items_subtotal`, `delivery_fee`, `handling_fee`, `urgency_fee`, `discount_amount`, `taxable_amount`, `cgst_amount`, `sgst_amount`, `igst_amount`, `withholding_amount`, `gst_tcs_amount`.
2. **`payment_intents` table** (`migrations/012_create_migration_extensions.sql`):
   - Columns: `id UUID PRIMARY KEY`, `payment_order_id VARCHAR(80) UNIQUE`, `order_id UUID NOT NULL`, `amount NUMERIC(10,2)`, `currency VARCHAR(10) DEFAULT 'INR'`, `status VARCHAR(30) DEFAULT 'CREATED'`, `signature VARCHAR(128)`, `created_at`, `updated_at`.
   - Existing CHECK constraint: `status IN ('CREATED', 'CAPTURED', 'FAILED', 'REFUNDED')`.
3. **`payment_receipts` table** (`migrations/012_create_migration_extensions.sql`):
   - Columns: `id UUID PRIMARY KEY`, `order_id UUID NOT NULL`, `transaction_id VARCHAR(100) UNIQUE`, `amount NUMERIC(10,2)`, `status VARCHAR(30) DEFAULT 'SUCCESS'`, `signature VARCHAR(128)`, `verified_at`.
   - Existing CHECK constraint: `status IN ('SUCCESS', 'FAILED', 'REFUNDED')`.
4. **`webhook_events` table** (`migrations/006_create_idempotency_and_webhooks.sql`):
   - Columns: `id UUID PRIMARY KEY`, `gateway VARCHAR(40) DEFAULT 'RAZORPAY'`, `event_id VARCHAR(120) UNIQUE NOT NULL`, `event_type VARCHAR(80) NOT NULL`, `payload JSONB NOT NULL`, `status VARCHAR(30) DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED'))`, `received_at`, `processed_at`, `retry_count`, `error_message`.

### C. Existing Idempotency Infrastructure
- **`idempotency_keys` table** (`migrations/006_create_idempotency_and_webhooks.sql`):
  - Primary key: `idempotency_key VARCHAR(120)`.
  - Columns: `actor_id`, `endpoint`, `status` (`'PROCESSING'`, `'COMPLETED'`, `'FAILED'`), `request_fingerprint`, `status_code`, `response_body`, `created_at`, `expires_at`.
  - Fully implemented and battle-tested in `orderRoutes.ts` and `dispatchRoutes.ts`.
  - Currently **NOT** attached to `paymentRoutes.ts` endpoints.

### D. Existing Financial Ledger Infrastructure
1. **`general_ledger_accounts`** (`migrations/005_create_financial_ledgers.sql`):
   - Chart of Accounts includes:
     - `1010`: Cash at Payment Gateway (Escrow) [ASSET / DEBIT]
     - `1020`: Bank Operating Account [ASSET / DEBIT]
     - `1030`: Floating Cash in Hands of Riders (COD) [ASSET / DEBIT]
     - `2010`: Customer Funds Held in Escrow [LIABILITY / CREDIT]
     - `2020`: Merchant Accounts Payable [LIABILITY / CREDIT]
     - `2030`: Delivery Partner Wallet Payable [LIABILITY / CREDIT]
     - `2040`: GST-TCS Section 52 Payable [LIABILITY / CREDIT]
     - `2050`: Income-Tax Withholding Payable [LIABILITY / CREDIT]
     - `2070`: Output GST Liability on Platform Fees [LIABILITY / CREDIT]
     - `4010`: Marketplace Commission Revenue [REVENUE / CREDIT]
     - `4020`: Customer Delivery Fee Revenue [REVENUE / CREDIT]
     - `4030`: Convenience & Handling Fee Revenue [REVENUE / CREDIT]
     - `5010`: Delivery Rider Logistics Expense [EXPENSE / DEBIT]
     - `5020`: Payment Gateway Interchange Fees [EXPENSE / DEBIT]
2. **`ledgerService.ts`**:
   - `recordOrderPayment(entry)`: Posts a balanced double-entry journal batch:
     - DEBIT Account 1010 (Gateway Escrow Asset)
     - CREDIT Account 2010 (Customer Escrow Liability)
   - Balanced Invariant: $\sum \text{Debits} == \sum \text{Credits}$.

### E. Environment Configuration (`src/config/env.ts`)
- `PAYMENT_MODE: z.enum(['mock', 'razorpay_test', 'production']).default('mock')`
- `RAZORPAY_KEY_ID: z.string().optional()`
- `RAZORPAY_KEY_SECRET: z.string().optional()`
- **Gap**: `RAZORPAY_WEBHOOK_SECRET` is not yet defined in `env.ts`.

### F. Existing Test Coverage
- **`sprint4-migration.test.ts`**:
  - Test 5: Validates payment intent creation, cryptographic verification, and replay attack rejection (HTTP 409).
  - Test 6: Validates double-entry ledger debit/credit equality.
- All 30 existing tests pass cleanly (15 Sprint 1–4, 15 Sprint 5).

---

## 3. IDENTIFIED ARCHITECTURAL GAPS & RISKS

| ID | Category | Gap / Risk Description | Severity | Remediation Strategy |
| :--- | :--- | :--- | :--- | :--- |
| **G-01** | Webhook Route | No webhook endpoint exists in `paymentRoutes.ts` or `app.ts` (`POST /api/webhooks/razorpay` / `POST /api/v1/payments/webhook`). | **HIGH** | Implement dedicated webhook handler with signature validation and transactional idempotency. |
| **G-02** | Webhook Signature | Raw body buffer is required for cryptographic HMAC-SHA256 signature verification (`x-razorpay-signature`). | **HIGH** | Use raw payload verification or verify against normalized JSON string with `timingSafeEqual`. |
| **G-03** | Amount Tampering | `verifyPayment` in `paymentService.ts` accepts an optional `amount` in payload. If client sends tampered amount, backend currently uses `authoritativeAmount` but does not explicitly reject mismatch if supplied. | **MEDIUM** | Implement explicit reconciliation: if client supplies `amount` and `amount !== authoritativeAmount`, reject with `PAYMENT_AMOUNT_MISMATCH` (HTTP 400). |
| **G-04** | State Machine | `payment_intents.status` only allows `CREATED`, `CAPTURED`, `FAILED`, `REFUNDED`. It lacks `PENDING`, `AUTHORIZED`, `CANCELLED`, `PARTIALLY_REFUNDED`. | **MEDIUM** | Expand payment state machine in types and schema to represent provider lifecycle states explicitly. |
| **G-05** | Idempotency | `paymentRoutes.ts` does not integrate `idempotency_keys` table for `/create-order` or `/verify`. | **HIGH** | Attach existing idempotency check & persistence pattern to payment routes. |
| **G-06** | Concurrency Race | Webhook and API verification can fire concurrently for the same order. | **HIGH** | Enforce row-level lock (`FOR UPDATE`) on `orders` and `payment_intents` to serialize verification and ensure exactly-once stock commit and ledger posting. |
| **G-07** | Post-Commit Events | Payment verification does not currently stage domain events to publish strictly post-commit (violating F-04 pattern). | **HIGH** | Integrate transactional event queue pattern (`PaymentCreated`, `PaymentCaptured`, `PaymentFailed`). |
| **G-08** | Secret Key | `paymentService.ts` constructor defaults to `JWT_SECRET` for HMAC key. | **MEDIUM** | Use `RAZORPAY_KEY_SECRET` or dedicated `PAYMENT_SECRET` config. |

---

## 4. PROPOSED PAYMENT STATE MACHINE

```text
               ┌───────────┐
               │  CREATED  │
               └─────┬─────┘
                     │ (Issue Payment Intent)
                     ▼
               ┌───────────┐
               │  PENDING  │
               └─────┬─────┘
                     │
       ┌─────────────┼─────────────┐
       ▼             ▼             ▼
  AUTHORIZED      FAILED       CANCELLED
       │         (Terminal)    (Terminal)
       │ (Capture)
       ▼
   CAPTURED
       │
       ├─────────────────────────┐
       ▼                         ▼
PARTIALLY_REFUNDED            REFUNDED
       │                     (Terminal)
       ▼
    REFUNDED
   (Terminal)
```

### Transition Matrix:
| From \ To | PENDING | AUTHORIZED | CAPTURED | FAILED | CANCELLED | PARTIALLY_REFUNDED | REFUNDED |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **CREATED** | Allowed | Allowed | Allowed | Allowed | Allowed | Forbidden | Forbidden |
| **PENDING** | - | Allowed | Allowed | Allowed | Allowed | Forbidden | Forbidden |
| **AUTHORIZED** | Forbidden | - | Allowed | Allowed | Allowed | Forbidden | Forbidden |
| **CAPTURED** | Forbidden | Forbidden | Idempotent | Forbidden | Forbidden | Allowed | Allowed |
| **FAILED** | Forbidden | Forbidden | Forbidden | Idempotent | Forbidden | Forbidden | Forbidden |
| **CANCELLED** | Forbidden | Forbidden | Forbidden | Forbidden | Idempotent | Forbidden | Forbidden |
| **PARTIALLY_REFUNDED**| Forbidden | Forbidden | Forbidden | Forbidden | Forbidden | Allowed | Allowed |
| **REFUNDED** | Forbidden | Forbidden | Forbidden | Forbidden | Forbidden | Forbidden | Idempotent |

---

## 5. RECONCILIATION & DOUBLE-ENTRY LEDGER SPECIFICATION

### Order Payment Event (Customer Payment Capture)
* **Trigger:** Payment capture verified (via API signature or Webhook `payment.captured`).
* **Debited Account:** `1010` (Cash at Payment Gateway - Escrow Asset) $\rightarrow$ `+total_amount`
* **Credited Account:** `2010` (Customer Funds Held in Escrow - Liability) $\rightarrow$ `+total_amount`
* **Invariant:** $\text{Debit (1010)} == \text{Credit (2010)} == \text{Order Total Amount}$.
* **Separation of Buckets:** Gross customer payment is held in escrow. Platform commission (`4010`), delivery fee (`4020`), convenience fee (`4030`), seller payable (`2020`), GST liability (`2070`), and GST-TCS (`2040`) are **NOT** recognized at payment capture; they are recognized during fulfillment settlement.

---

## 6. PROPOSED IMPLEMENTATION PLAN

1. **Environment & Secrets Update**:
   - Add `RAZORPAY_WEBHOOK_SECRET` and `PAYMENT_SECRET` to `env.ts`.
2. **Schema & Migration 014**:
   - Update `payment_intents.status` check constraint to support full payment state machine (`CREATED`, `PENDING`, `AUTHORIZED`, `CAPTURED`, `FAILED`, `CANCELLED`, `REFUNDED`, `PARTIALLY_REFUNDED`).
   - Add foreign key / indexing where appropriate without dropping tables.
3. **Payment State Machine Implementation (`paymentStateMachine.ts`)**:
   - Explicit state transitions, terminal state verification, and transition validation functions.
4. **Payment Service Hardening (`paymentService.ts`)**:
   - Enforce authoritative order amount derivation (`total_amount`).
   - Add explicit check rejecting client-submitted amount mismatch (`PAYMENT_AMOUNT_MISMATCH`).
   - Add idempotency support using `idempotency_keys` table.
   - Enforce row-level lock (`FOR UPDATE`) on `orders` and `payment_intents`.
   - Post-commit domain events pattern (`paymentEvents.ts`).
5. **Webhook Implementation (`paymentWebhookService.ts` & `paymentRoutes.ts`)**:
   - Endpoint: `POST /api/v1/payments/webhook` and `POST /api/webhooks/razorpay`.
   - Cryptographic signature verification (`x-razorpay-signature`) using `crypto.createHmac('sha256', secret)`.
   - Record webhook event in `webhook_events` with unique `event_id`.
   - If duplicate `event_id`: return HTTP 200 with `{ success: true, duplicate: true }`.
   - Process `payment.captured`, `payment.failed`, `order.paid`.
   - Transition payment and order state transactionally.
6. **API Routes Protection (`paymentRoutes.ts`)**:
   - Apply `authenticate` to all customer-initiated payment routes.
   - Verify customer ownership (`orders.user_id === req.auth.userId`).
   - Attach idempotency middleware with request fingerprinting.
7. **Automated Test Suite (`sprint6-payments.test.ts`)**:
   - Implement comprehensive tests covering all prompt requirements (creation, idempotency, amount security, webhook signatures, webhook replays, concurrent races, ledger integrity, database 503 failure, post-commit events).
   - Integrate into `run-all-tests.ts`.

---

## 7. DECISIONS REQUIRING USER CONFIRMATION

1. **Provider Mode:** The system will use native Node.js `crypto` with pluggable `PAYMENT_MODE` (`'mock' | 'razorpay_test' | 'production'`), requiring zero external npm SDK additions.
2. **Webhook Endpoints:** Dual-mount webhook endpoints at `POST /api/webhooks/razorpay` and `POST /api/v1/payments/webhook` for maximum compatibility.
3. **Migration Number:** Name the schema migration `014_update_payment_state_machine.sql`.

---

## 8. INTEGRITY CHECKPOINT ATTESTATION

- **Completed Dispatch Domain:** 100% LOCKED (F-01, F-02, F-03, F-04 remain untouched).
- **Customer Frontend:** 0 files modified in `QCOM/customer-app/src/**`.
- **Infrastructure:** 0 Kafka, 0 WebSockets, 0 H3, 0 ML introduced.
- **Authoritative Database:** PostgreSQL is the sole source of truth; Redis remains non-authoritative.
