# SPRINT 6 — PAYMENTS & PAYMENT WEBHOOKS IMPLEMENTATION REPORT

**Date:** 2026-10-04  
**Sprint:** Sprint 6 — Payments & Payment Webhooks  
**Domain Target:** `QCOM/backend`  
**Status:** **COMPLETE — ALL GATES PASSED (30/30 baseline + 25/25 Sprint 6 tests passed)**

---

## 1. EXECUTIVE SUMMARY

Sprint 6 implements an authoritative, concurrency-safe, tamper-proof Payment and Payment Webhook infrastructure within the `QCOM/backend` service. All Sprint 1–5 domain capabilities (authentication, RBAC, statutory GST tax engine, commercial pricing, orders, double-entry financial ledger, and Dispatch F-01 through F-04) remain strictly preserved and regression-free.

---

## 2. FILES CREATED & MODIFIED

### Created Files
1. `QCOM/backend/migrations/014_update_payment_state_machine.sql`: Additive migration extending `payment_intents.status` check constraint to support the complete payment lifecycle, adding `provider_payment_id`, `provider_order_id`, and error metadata columns.
2. `QCOM/backend/src/modules/payments/paymentStateMachine.ts`: Explicit authoritative payment state machine defining allowable transitions, terminal states, and transition guards.
3. `QCOM/backend/src/modules/payments/paymentEvents.ts`: Transactional domain event publisher staging `PaymentCreated`, `PaymentAuthorized`, `PaymentCaptured`, `PaymentFailed`, and `PaymentCancelled` to emit strictly post-commit.
4. `QCOM/backend/src/modules/payments/paymentProvider.ts`: Native HTTPS/crypto payment provider abstraction implementing `PaymentProvider` interface with `MockPaymentProvider` and `RazorpayPaymentProvider` adapters.
5. `QCOM/backend/tests/sprint6-payments.test.ts`: Comprehensive 25-case automated test suite verifying payment creation, webhook HMAC verification, replay defense, concurrency race safety, inventory commit, and ledger balancing.

### Modified Files
1. `QCOM/backend/src/config/env.ts`: Added isolated `PAYMENT_SECRET` and `RAZORPAY_WEBHOOK_SECRET` environment configurations. Prevented silent fallback to `JWT_SECRET`.
2. `QCOM/backend/src/modules/payments/paymentTypes.ts`: Extended with `PaymentState`, `WebhookProcessingResult`, and `PaymentStatusSummary`.
3. `QCOM/backend/src/modules/payments/paymentService.ts`: Complete rewrite implementing row-level locking (`SELECT ... FOR UPDATE`), authoritative amount calculation, client amount tampering defense (`PAYMENT_AMOUNT_MISMATCH`), exactly-once stock commit, double-entry escrow ledger posting, and post-commit event emissions.
4. `QCOM/backend/src/routes/paymentRoutes.ts`: Dual-mounted at `/api/payment` and `/api/v1/payments` with customer JWT authentication, idempotency check & persistence, IDOR ownership defense, webhook handling, and `GET /:orderId` status endpoint.
5. `QCOM/backend/src/app.ts`: Attached `verify` hook to `express.json` to capture and preserve the exact raw byte Buffer for cryptographic webhook signature calculation. Mounted `/api/webhooks/razorpay` and dual-mounted payment router.
6. `QCOM/backend/tests/run-all-tests.ts`: Integrated `runSprint6PaymentsTests()` into the master test pipeline.

---

## 3. PAYMENT STATE MACHINE SPECIFICATION

The payment state machine governs both payment intents and order payment reconciliation:

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

- **Transitions:** Handled by `validatePaymentTransition(from, to)`.
- **Terminal States:** `FAILED`, `CANCELLED`, `REFUNDED`. Attempting to transition out of a terminal state is deterministically rejected.
- **Captured Safeguard:** Once `CAPTURED`, a payment cannot revert to `PENDING`, `AUTHORIZED`, `FAILED`, or `CANCELLED`. Idempotent repeat attempts return the existing capture outcome.

---

## 4. PROVIDER ADAPTER & SECRETS ISOLATION

1. **Provider Modes:**
   - Supported via `PAYMENT_MODE: 'mock' | 'razorpay_test' | 'production'`.
   - `MockPaymentProvider`: Generates HMAC-SHA256 signatures using isolated `PAYMENT_SECRET`.
   - `RazorpayPaymentProvider`: Verifies standard Razorpay checkout signatures (`order_id|payment_id`) and webhooks using `RAZORPAY_WEBHOOK_SECRET`.
2. **Secrets Isolation:**
   - `PAYMENT_SECRET` is strictly isolated from `JWT_SECRET`. No silent fallback to JWT tokens is permitted.
   - All secrets are redacted and never returned to the client in HTTP responses or query endpoints.

---

## 5. WEBHOOK RAW BODY CRYPTOGRAPHY & REPLAY PROTECTION

1. **Raw Body Buffer Retention:**
   - Express middleware configured with `express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } })`.
   - Verification computes HMAC-SHA256 directly over the unmodified raw bytes.
   - Signature comparison uses constant-time `crypto.timingSafeEqual`.
2. **Webhook Replay Protection:**
   - Webhook events are checked and inserted into `webhook_events (event_id UNIQUE)`.
   - If an `event_id` was already processed, the service returns HTTP 200 `{ success: true, duplicate: true }` without executing side effects.

---

## 6. CONCURRENCY & RACE CONDITION HANDLING

When client verification (`POST /api/payment/verify`) and provider webhook (`POST /api/webhooks/razorpay`) arrive simultaneously:
1. Both operations lock `orders` and `payment_intents` row-level via `SELECT ... FOR UPDATE`.
2. The first transaction captures the payment, transitions `orders.payment_status` to `'PAID'`, commits reserved inventory (`inventoryService.commitStock`), posts the double-entry escrow ledger journal (`ledgerService.recordOrderPayment`), and stages the `PaymentCaptured` event.
3. The second concurrent transaction acquires the row lock, detects `orders.payment_status === 'PAID'`, and immediately returns the existing receipt safely as an idempotent duplicate outcome.
4. Exactly-once invariant: Zero duplicate stock commits, zero duplicate ledger entries, zero duplicate receipts, and zero duplicate events.

---

## 7. FINANCIAL LEDGER INTEGRATION

- Customer payment capture posts a balanced double-entry journal batch:
  - **DEBIT Account 1010** (Cash at Payment Gateway - Escrow Asset): `+total_amount`
  - **CREDIT Account 2010** (Customer Funds Held in Escrow - Liability): `+total_amount`
- Balanced Invariant: $\sum \text{Debits} == \sum \text{Credits} == \text{Authoritative Order Total}$.
- Seller payables, platform commissions, and GST liabilities are **NOT** recognized at capture; they remain segregated for fulfillment settlement.

---

## 8. TEST SUITE & VERIFICATION RESULTS

Master runner: `npx tsx QCOM/backend/tests/run-all-tests.ts`
- **Baseline Sprint 1–5:** 30/30 passed.
- **Sprint 6 Payments Suite:** 25/25 passed.
- **Total:** 55/55 tests passed in ~9.32s.
- **Applet Compilation (`npm run build`):** Succeeded.
- **TypeScript Typecheck (`tsc --noEmit`):** Succeeded with 0 errors.

---

## 9. FRONTEND BOUNDARY VERIFICATION

- `QCOM/customer-app/src/**`: 0 files modified, 0 created, 0 deleted.
- No duplicate frontend or preview artifacts were created. Strict backend boundary maintained.
