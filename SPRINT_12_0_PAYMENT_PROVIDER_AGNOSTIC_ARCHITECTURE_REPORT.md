# SPRINT 12.0 — PAYMENT-PROVIDER-AGNOSTIC ARCHITECTURE AND PRODUCTION INTEGRATION READINESS REPORT

**Project:** QCOM — Seller-Owned Hardware Quick-Commerce Marketplace  
**Sprint:** 12.0  
**Status:** COMPLETE & VERIFIED  
**Date:** October 20, 2026  
**Auditor Roles:** Principal Payment Systems Architect, Senior Backend Engineer, PostgreSQL Specialist, and Financial Integrity Auditor  

---

## EXECUTIVE SUMMARY & BUSINESS DECISION AFFIRMATION

In accordance with explicit business directives:
1. **No Payment Gateway Selected:** QCOM has not selected Razorpay, Cashfree, PayU, Stripe, or any external gateway. No provider selection was made on behalf of the business.
2. **Zero Provider Credentials Requested or Used:** No API keys, secret credentials, or merchant accounts were configured or contacted.
3. **Zero Network Calls:** No real customer charges, sandbox API calls, or external network requests were made.
4. **Architectural Objective Achieved:** The QCOM backend checkout, payment intent lifecycle, multi-attempt tracking, webhook ingestion, cryptographic evidence handling, double-entry financial ledgering, inventory reservations, and compensation refunds are now completely decoupled from provider-specific APIs, SDKs, event schemas, and signature headers.
5. **Future-Proof Gateway Pluggability:** Any gateway (UPI, card networks, netbanking, wallets) can be integrated via a single standardized `PaymentProvider` adapter implementation without touching core order placement, inventory reservation, payment state machine, or double-entry ledger journals.

---

## SECTION 1 — ARCHITECTURAL AUDIT & EXISTING SYSTEM INSPECTION

Before implementing Sprint 12.0, the codebase was audited against Sprint 11.9 findings:

### 1.1 Audit Findings on Existing Services
* **PaymentService (`QCOM/backend/src/modules/payments/paymentService.ts`):**  
  * *Previous State:* Tightly coupled to Razorpay terminology (`razorpayOrderId`, `razorpayPaymentId`, `razorpaySignature`, and hardcoded `x-razorpay-signature` webhook header check).
  * *Resolution:* Refactored to operate on abstract `providerReference`, provider-agnostic signatures, multi-attempt tracking, and dynamic registry-driven gateway dispatch.
* **Payment State Machine (`paymentStateMachine.ts`):**  
  * *Previous State:* Handled basic transitions (`CREATED`, `CAPTURED`, `FAILED`, `REFUNDED`), but lacked intermediate transition states for asynchronous gateway handoffs (`PROCESSING`, `AUTHORIZED`, `REFUND_PENDING`, `RECONCILIATION_REQUIRED`).
  * *Resolution:* Formalized strict deterministic state transition graph with transition validation, terminal state guards, and recovery routing for ambiguous outcomes.
* **Webhook Ingestion (`paymentRoutes.ts` & `paymentService.ts`):**  
  * *Previous State:* Only checked `x-razorpay-signature` header; assumed Razorpay JSON payload hierarchy (`payload.payment.entity`).
  * *Resolution:* Built header-agnostic lookup supporting standard signature headers (`x-webhook-signature`, `x-signature`, `x-provider-signature`, `x-razorpay-signature`), adapter-delegated signature validation on exact raw request buffer, and payload normalization into `ProviderWebhookEvent`.
* **Database Models (`payment_intents`, `payment_attempts`, `webhook_events`):**  
  * *Previous State:* Single `payment_intents` table per order; unable to cleanly model customer payment retries, abandoned attempts, or multi-provider routing without overwriting previous attempt references.
  * *Resolution:* Added Migration 022 creating `payment_attempts` with compound uniqueness `(order_id, attempt_number)` and `(provider_id, provider_reference)`.

---

## SECTION 2 — PROVIDER-AGNOSTIC CONTRACT & CAPABILITY MODEL

A stable, provider-neutral contract has been established in `QCOM/backend/src/modules/payments/provider/`:

### 2.1 File Structure
```
QCOM/backend/src/modules/payments/provider/
├── types.ts                      # Normalized domain types, params, and capability definitions
├── PaymentProvider.ts            # Authoritative PaymentProvider interface
├── MockPaymentProvider.ts        # Production-grade mock sandbox adapter (zero network dependencies)
├── paymentProviderRegistry.ts   # Thread-safe gateway registry & dynamic adapter resolver
└── index.ts                      # Clean barrel exports
```

### 2.2 Capability Flag Matrix
Not all payment gateways support identical features. The contract explicitly exposes capability flags:
```typescript
export interface PaymentProviderCapabilities {
  readonly supportsPaymentSession: boolean;           // Hosted checkout / client SDK session
  readonly supportsServerInitiatedOrder: boolean;     // Server-to-server order pre-creation
  readonly supportsPaymentVerification: boolean;       // Evidence verification (signatures/tokens)
  readonly supportsWebhookVerification: boolean;       // Asynchronous webhook signature verification
  readonly supportsStatusInquiry: boolean;             // Authoritative server-to-server polling
  readonly supportsRefunds: boolean;                   // Programmatic refund execution
  readonly supportsRefundStatusInquiry: boolean;       // Asynchronous refund status query
  readonly supportsNativeIdempotency: boolean;         // Provider accepts idempotency keys
  readonly supportsSeparateAuthAndCapture: boolean;    // Two-step auth & capture flow
  readonly currencySubunitFactor: number;              // 100 for INR (paise) / USD (cents), 1 for JPY
}
```

### 2.3 Normalized Domain Types
* `CreatePaymentSessionParams` / `PaymentSessionResult`: Clean abstraction over client checkout sessions, tokens, and redirect URLs without exposing provider-specific payloads.
* `VerifyPaymentParams` / `PaymentVerificationResult`: Cryptographic and token evidence verification returning standardized statuses (`SUCCEEDED`, `FAILED`, `RECONCILIATION_REQUIRED`).
* `ProviderWebhookEvent`: Normalized event types (`PAYMENT_SUCCESS`, `PAYMENT_FAILED`, `PAYMENT_AUTHORIZED`, `REFUND_SUCCESS`, `REFUND_FAILED`, `UNKNOWN`).
* `NormalizedProviderError`: Standardized error categories (`AUTHENTICATION_ERROR`, `NETWORK_TIMEOUT`, `RATE_LIMITED`, `INVALID_REQUEST`, `PROVIDER_UNAVAILABLE`, `CARD_DECLINED`, `EXPIRED_SESSION`, `UNKNOWN`) with `retryable` boolean flags.

---

## SECTION 3 — AUTHORITATIVE QCOM INTERNAL PAYMENT STATE MACHINE

The internal business state is strictly managed by QCOM's authoritative state machine (`paymentStateMachine.ts`). Third-party gateway responses cannot dictate or bypass internal invariants:

```
                  ┌───────────────┐
                  │    CREATED    │
                  └───────┬───────┘
                          │ (Initiate Attempt)
                          ▼
                  ┌───────────────┐
         ┌───────►│    PENDING    │◄──────┐
         │        └───────┬───────┘       │
         │                │ (Handoff)     │
         │                ▼               │
         │        ┌───────────────┐       │
         │        │  PROCESSING   │       │
         │        └───┬───┬───┬───┘       │
         │            │   │   │           │
(Retry / │  (Capture) │   │   │ (Timeout) │ (Reconcile
Re-init) │            │   │   │           │  Failed)
         │            │   │   └────────────────┐
         │            │   │                    │
         │            │   │ (Decline)          ▼
         │            │   │             ┌─────────────────────────┐
         │            │   ▼             │ RECONCILIATION_REQUIRED │
         │            │ ┌────────────┐  └────────────┬────────────┘
         │            │ │   FAILED   │               │ (Reconcile Success)
         │            │ └────────────┘               ▼
         │            ▼                     ┌─────────────────┐
         │       ┌───────────┐              │    CAPTURED     │
         │       │ CAPTURED  ├─────────────►│     (PAID)      │
         │       └─────┬─────┘              └────────┬────────┘
         │             │                             │
         │             │ (Cancellation / Late Pmt)   │ (Customer Return)
         │             ▼                             ▼
         │     ┌─────────────────┐           ┌─────────────────┐
         │     │ REFUND_PENDING  │           │ REFUND_PENDING  │
         │     └───────┬─────────┘           └───────┬─────────┘
         │             │ (Refund Processed)          │
         │             ▼                             ▼
         │     ┌─────────────────┐           ┌─────────────────┐
         │     │    REFUNDED     │           │    REFUNDED     │
         │     └─────────────────┘           └─────────────────┘
```

### 3.1 Terminal Guard Guarantees
* Terminal states (`CAPTURED`, `REFUNDED`, `CANCELLED`) reject illegal state mutations.
* Network timeouts, HTTP 504s, and connection drops NEVER mark an order or payment attempt as `FAILED` or cancel orders blindly. Instead, they transition into `RECONCILIATION_REQUIRED`.
* Duplicate events or retry attempts perform idempotent no-op returns without re-allocating inventory or duplicating ledger entries.

---

## SECTION 4 — PAYMENT ATTEMPTS & IDEMPOTENCY MODEL

### 4.1 Schema Migration 022
Migration `022_create_payment_attempts_and_provider_agnostic_schema.sql` establishes:
1. **Extended `payment_intents` status check constraint:**  
   Supports `'CREATED'`, `'PENDING'`, `'PROCESSING'`, `'AUTHORIZED'`, `'CAPTURED'`, `'FAILED'`, `'CANCELLED'`, `'REFUND_PENDING'`, `'PARTIALLY_REFUNDED'`, `'REFUNDED'`, `'RECONCILIATION_REQUIRED'`.
2. **Provider Tracking Columns on `payment_intents`:**  
   `active_provider VARCHAR(50) DEFAULT 'mock'`, `idempotency_key VARCHAR(120)`.
3. **Dedicated `payment_attempts` Table:**
   ```sql
   CREATE TABLE IF NOT EXISTS payment_attempts (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       order_id UUID NOT NULL,
       payment_intent_id UUID NOT NULL,
       attempt_number INT NOT NULL DEFAULT 1,
       provider_id VARCHAR(50) NOT NULL,
       provider_reference VARCHAR(120),
       status VARCHAR(40) NOT NULL DEFAULT 'INITIATED' CHECK (status IN (
         'INITIATED', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'RECONCILIATION_REQUIRED'
       )),
       amount NUMERIC(10,2) NOT NULL CHECK (amount >= 0),
       currency VARCHAR(10) NOT NULL DEFAULT 'INR',
       idempotency_key VARCHAR(120),
       error_code VARCHAR(80),
       error_message TEXT,
       provider_metadata JSONB DEFAULT '{}'::jsonb,
       initiated_at TIMESTAMPTZ DEFAULT NOW(),
       completed_at TIMESTAMPTZ,
       UNIQUE (order_id, attempt_number),
       UNIQUE (provider_id, provider_reference)
   );
   ```

### 4.2 Idempotency Invariants Enforced
* **Order Separation:** Customer Order (`orders`) is distinct from logical Payment Intent (`payment_intents`) and physical gateway attempts (`payment_attempts`).
* **Attempt Number Uniqueness:** The compound constraint `UNIQUE(order_id, attempt_number)` guarantees deterministic multi-attempt sequencing without race conditions.
* **Provider Reference Uniqueness:** `UNIQUE(provider_id, provider_reference)` guarantees that a gateway reference cannot be re-used across distinct customer orders.

---

## SECTION 5 — PROVIDER-AGNOSTIC WEBHOOK INGESTION & NORMALIZATION

### 5.1 Raw Body Preservation & Header Independence
* In `paymentRoutes.ts` and `paymentService.ts`, the exact raw binary buffer (`req.rawBody` or `Buffer.from(...)`) is retained for HMAC verification.
* Signature verification checks candidate headers in order:
  1. `x-webhook-signature` (Provider-neutral standard)
  2. `x-signature`
  3. `x-provider-signature`
  4. `x-razorpay-signature` (Legacy compatibility)
  5. Fallback to `provider.extractSignature(headers)`
* Webhook deduplication is enforced via the `webhook_events` PostgreSQL table with row-level locks and `ON CONFLICT (event_id) DO NOTHING`. Replayed events return HTTP 200 with `duplicate: true` without executing duplicate inventory or ledger operations.

### 5.2 Server-Authoritative Amount Matching
* Provider amount is checked against the internal order total using the provider's `currencySubunitFactor`.
* Any discrepancy between the external provider amount and the locked PostgreSQL `orders.total_amount` immediately aborts the transaction, updates `webhook_events.status = 'FAILED'`, and throws `PAYMENT_AMOUNT_MISMATCH`.

---

## SECTION 6 — REFUND AND RECONCILIATION WORKFLOWS

### 6.1 Late Payment Capture Protection (P0-A Safety Invariant)
* If a customer payment succeeds at the provider after the order's inventory reservation has expired or the order was cancelled:
  1. The payment is captured into escrow liabilities (`Dr 1010 Gateway Cash, Cr 2010 Escrow Liability`).
  2. The order is NOT revived, and inventory is NEVER oversold.
  3. The order payment status is set to `REFUND_PENDING`.
  4. A durable compensation refund is scheduled.

### 6.2 Authoritative Reconciliation Engine
* Method `paymentService.reconcilePayment(orderId)`:
  * Acquires a row-level lock on `orders` and `payment_intents`.
  * Queries the active provider's authoritative status via `provider.getPaymentStatus(providerRef, providerPaymentId)`.
  * If confirmed captured externally: updates order to `PAID` (or `REFUND_PENDING` if late), commits stock, creates ledger journals, and records payment receipt.
  * If provider inquiry times out: maintains `RECONCILIATION_REQUIRED` without marking the payment failed.

---

## SECTION 7 — INTEGRATION READINESS & ADAPTER CHECKLIST

When QCOM leadership selects a payment gateway, integration requires only implementing the `PaymentProvider` interface and registering it with the registry:

### 7.1 New Gateway Adapter Implementation Checklist
```typescript
import { PaymentProvider, PaymentProviderCapabilities, ... } from './provider/index.js';

export class NewGatewayAdapter implements PaymentProvider {
  public readonly providerId = 'new_gateway';
  public readonly displayName = 'New Gateway Production';

  public getCapabilities(): PaymentProviderCapabilities {
    return {
      supportsPaymentSession: true,
      supportsServerInitiatedOrder: true,
      supportsPaymentVerification: true,
      supportsWebhookVerification: true,
      supportsStatusInquiry: true,
      supportsRefunds: true,
      supportsRefundStatusInquiry: true,
      supportsNativeIdempotency: true,
      supportsSeparateAuthAndCapture: false,
      currencySubunitFactor: 100, // paise
    };
  }

  // 1. Map QCOM params to gateway session
  public async createPaymentSession(params: CreatePaymentSessionParams): Promise<PaymentSessionResult> { ... }

  // 2. Verify client-side payment evidence
  public async verifyPayment(params: VerifyPaymentParams): Promise<PaymentVerificationResult> { ... }

  // 3. Verify incoming webhook signature on exact raw buffer
  public verifyWebhookSignature(params: { rawBody: Buffer | string; headers: Record<string, any> }): boolean { ... }

  // 4. Normalize gateway JSON payload to ProviderWebhookEvent
  public parseWebhookEvent(params: { rawBody: Buffer | string; headers: Record<string, any> }): ProviderWebhookEvent { ... }

  // 5. Query gateway for reconciliation
  public async getPaymentStatus(providerReference: string, providerPaymentId?: string): Promise<ProviderPaymentStatus> { ... }

  // 6. Programmatic refund execution
  public async createRefund(params: ProviderRefundRequest): Promise<ProviderRefundResult> { ... }
  public async getRefundStatus(providerRefundId: string): Promise<ProviderRefundResult> { ... }

  // 7. Normalize gateway errors
  public normalizeError(error: any): NormalizedProviderError { ... }
}
```

### 7.2 Zero-Touch Registration
```typescript
import { paymentProviderRegistry } from './provider/paymentProviderRegistry.js';
import { NewGatewayAdapter } from './adapters/NewGatewayAdapter.js';

paymentProviderRegistry.registerProvider(new NewGatewayAdapter(), { isDefault: true });
```
No changes to `OrderService`, `InventoryService`, `FinancialLedgerService`, or `paymentRoutes` are required.

---

## SECTION 8 — AUTOMATED VERIFICATION RESULTS

### 8.1 Sprint 12.0 Dedicated Test Suite
**File:** `QCOM/backend/tests/sprint12-payment-provider-agnostic.test.ts`

| Test Suite ID | Test Description | Invariant Verified | Result |
|---|---|---|:---:|
| **Test A** | Provider-Agnostic Interface & Capability Model | Capability flags, currency subunit factors, error normalization | **PASSED** |
| **Test B** | Provider Registry & Dynamic Adapter Hot-Swapping | Runtime registration, active provider resolution, default fallbacks | **PASSED** |
| **Test C** | Authoritative QCOM Payment State Machine Invariants | Allowed transitions, terminal state enforcement, duplicate self-transitions | **PASSED** |
| **Test D** | Durable Multi-Attempt Tracking & Database Uniqueness | Incrementing attempt numbers, separate provider references, `UNIQUE(order_id, attempt_number)` | **PASSED** |
| **Test E** | Provider-Agnostic Webhook Ingestion & Header Independence | Header-agnostic (`x-webhook-signature`), HMAC verification on raw body, replay attack rejection | **PASSED** |
| **Test F** | Server-Authoritative Amount Matching with Subunits | Tampered amount rejection, currency validation, exact subunit conversion | **PASSED** |
| **Test G** | Gateway Timeout Handling & Zero Blind Failure | Preserves order on 504 timeout, routes to `RECONCILIATION_REQUIRED`, zero blind stock release | **PASSED** |
| **Test H** | Payment Reconciliation Workflow for Ambiguous Outcomes | Reconciles ambiguous intent with provider inquiry, atomically captures payment post-timeout | **PASSED** |
| **Test I** | Late Payment on Expired Order (Escrow Capture & Refund) | Captures late payment into escrow liabilities, prevents overselling expired stock, routes to refund | **PASSED** |
| **Test J** | Double-Entry Financial Ledger Equality (Debits == Credits) | All general ledger batches balance strictly (`Debits == Credits`) across provider captures | **PASSED** |
| **Test K** | Provider-Agnostic HTTP API Endpoints | `GET /api/v1/payments/providers`, `POST /api/v1/payments/attempt`, `POST /api/v1/payments/reconcile/:orderId` | **PASSED** |

**Sprint 12.0 Status:** `✓ ALL SPRINT 12.0 PROVIDER-AGNOSTIC TESTS PASSED (11/11)!`

---

### 8.2 Master Test Suite Regression
**File:** `QCOM/backend/tests/run-all-tests.ts`  
**Execution Command:** `npx tsx QCOM/backend/tests/run-all-tests.ts`

* Sprint 1: Migrations, Seeds, Constraints, Middleware, Redis Cache, App Health (PASSED)
* Sprint 2: JWT Security, Auth & RBAC, IDOR & Resource Ownership, Auth Remediation (PASSED)
* Sprint 3: Pricing & Tax Engine, Statutory Tax Rules, GST-TCS, TDS (PASSED)
* Section 40: Business Model Requirements (PASSED)
* Sprint 4: Domain Migrations & PostgreSQL Constraints (PASSED)
* Sprint 5: Dispatch & Rider Assignment, Delivery Deadlines (PASSED)
* Sprint 6: Payments & Payment Webhooks (PASSED)
* Sprint 7: Marketplace Settlement, Seller Payouts & Rider Earnings (PASSED)
* Sprint 8: Realtime WebSockets, Transactional Outbox & Rich Notifications (PASSED)
* Sprint 9: Returns, Cancellations, Refunds & Reverse Logistics (PASSED)
* Sprint 9.1: Database Overload Protection, Bloom Filter & Resilience (PASSED)
* Sprint 9.1: Remediation, Multi-Instance Sync & Critical Invariants (PASSED)
* Sprint 9.2: Redis Subscriber, Stampede Protection & Cache Resilience (PASSED)
* Sprint 10.1A: Financial Transaction Decoupling & Concurrency Remediation (PASSED)
* Sprint 10.1C: Durable Financial Recovery & Webhook Ingestion (PASSED)
* Sprint 11.5: Critical Inventory Remediation (PASSED)
* Sprint 11.6.1: Critical Payment-Inventory Remediation (PASSED)
* Sprint 11.7: Selective Stock Reservation & Seller Stock Alerts (PASSED)
* Sprint 11.8: Concurrency Stress Testing & Financial Integrity Verification (PASSED)
* **Sprint 12.0: Payment-Provider-Agnostic Architecture & Production Integration Readiness (PASSED)**

**Final Master Result:**  
`✓ ALL SPRINT 1 TO 12.0 TESTS PASSED SUCCESSFULLY in 36.29s!`
