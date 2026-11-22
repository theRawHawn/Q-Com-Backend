# QCOM Gateway-Agnostic Payment, Refund & Reconciliation Architecture

> **Gateway Selection Status:**
> **QCOM has not selected a payment gateway. No provider integration, SDK, gateway credentials, sandbox transactions, or live payment transactions are implemented or authorized.**

---

## 1. Architectural Principle: QCOM Owns the Payment Lifecycle

QCOM's core payment system is strictly provider-independent. A future payment gateway acts solely as an interchangeable external execution boundary behind `PaymentProvider` (`src/modules/payments/provider/PaymentProvider.ts`) and `paymentProviderRegistry` (`src/modules/payments/provider/paymentProviderRegistry.ts`). It never owns order validation, payment state transitions, idempotency, financial ledger entries, refund accounting, reconciliation, or recovery.

```text
CUSTOMER / ADMIN CLIENT
  └─> ROUTE LAYER (paymentRoutes.ts / refundRoutes.ts)
       ├─ JWT Auth + Role Guard + Resource Ownership (anti-IDOR)
       ├─ Sliding-Window Rate Limiters (paymentInitiation / webhook / adminSensitive)
       └─ Durable PostgreSQL Idempotency (idempotencyService.ts)
  └─> ORDER & PAYMENT CORE (paymentService.ts / paymentStateMachine.ts)
       ├─ Server-authoritative payable amount & currency ('INR') enforcement
       ├─ Single active obligation & single capture PostgreSQL invariants
       └─ Row-locked CAS state transitions + UNKNOWN/EXPIRED handling
  └─> QCOM FINANCIAL SYSTEM (ledgerService.ts / refundService.ts / reconciliation)
       ├─ Atomic Double-Entry General Ledger Batches (decimal-safe via money.ts)
       ├─ Three-phase Refund Engine (lock-free gateway I/O boundary)
       └─ Internal Reconciliation + Bounded Recovery Worker
  └─> FUTURE PAYMENT ADAPTER BOUNDARY (Unselected: DisabledPaymentProvider in PAYMENT_MODE=none)
```

---

## 2. Payment Domain Data Model (Normalized Separation)

QCOM strictly separates the four financial entities across PostgreSQL tables (Migrations `004`, `006`, `014`, `017`, `022`, `023`, `029`):

1. **Order (`orders`)**: Commercial contract containing authoritative `total_amount`, tax breakdown, `payment_method` (`Pay on Delivery` vs online rails), `payment_status`, and fulfillment lifecycle.
2. **Payment Obligation (`payment_intents`)**: Durable financial collection lifecycle linked 1:1 per active obligation or capture (`uq_payment_intents_single_active_per_order`, `uq_payment_intents_single_captured_per_order`). Tracks `expires_at`, `succeeded_at`, `failed_at`, `cancelled_at`, `expired_at`, `failure_classification`, `next_retry_at`, `requires_manual_review`, `version`, and `internal_transaction_reference`.
3. **Payment Attempt (`payment_attempts`)**: Bounded retry attempts (`UNIQUE (order_id, attempt_number)`). Enforces at most one in-flight attempt (`uq_payment_attempts_single_active_per_order`) and at most one succeeded attempt (`uq_payment_attempts_single_succeeded_per_order`) per order.
4. **Payment Transaction (`payment_transactions`)**: Append-only normalized event ledger (`AUTHORIZATION`, `CAPTURE`, `REFUND`, `REVERSAL`, `VOID`, `CHARGEBACK`, `STATUS_CHECK`) enforcing at most one `SUCCEEDED` `CAPTURE` per order (`uq_payment_tx_single_capture_per_order`) and provider external ref deduplication (`uq_payment_tx_provider_ext_ref`).
5. **Reconciliation Records (`reconciliation_runs`, `reconciliation_discrepancies`)**: Durable audit runs and persisted financial exceptions with deduplicated `discrepancy_key`, `occurrence_count`, `severity`, `repair_action`, and manual resolution workflow.

---

## 3. Centralized Payment State Machine (`paymentStateMachine.ts`)

All `payment_intents`, `payment_attempts`, and `refunds` status changes are routed through row-locked optimistic-version CAS helpers (`transitionPaymentIntentState`, `transitionPaymentAttemptState`, `transitionRefundState`) using `PAYMENT_STATE_TRANSITION_MATRIX`:

### 3.1 Valid Intent Transitions

| From State | Allowed Target States |
| :--- | :--- |
| `CREATED` | `INITIATED`, `PENDING`, `PROCESSING`, `AUTHORIZED`, `CAPTURED`, `FAILED`, `CANCELLED`, `EXPIRED`, `UNKNOWN`, `RECONCILIATION_REQUIRED`, `REQUIRES_REVIEW` |
| `INITIATED` | `PENDING`, `PROCESSING`, `AUTHORIZED`, `CAPTURED`, `FAILED`, `CANCELLED`, `EXPIRED`, `UNKNOWN`, `RECONCILIATION_REQUIRED`, `REQUIRES_REVIEW` |
| `PENDING` | `INITIATED`, `PROCESSING`, `AUTHORIZED`, `CAPTURED`, `FAILED`, `CANCELLED`, `EXPIRED`, `UNKNOWN`, `RECONCILIATION_REQUIRED`, `REQUIRES_REVIEW` |
| `PROCESSING` | `AUTHORIZED`, `CAPTURED`, `FAILED`, `CANCELLED`, `EXPIRED`, `UNKNOWN`, `RECONCILIATION_REQUIRED`, `REQUIRES_REVIEW` |
| `AUTHORIZED` | `CAPTURED`, `FAILED`, `CANCELLED`, `EXPIRED`, `UNKNOWN`, `RECONCILIATION_REQUIRED`, `REQUIRES_REVIEW` |
| `UNKNOWN` | `CAPTURED`, `FAILED`, `CANCELLED`, `EXPIRED`, `RECONCILIATION_REQUIRED`, `REQUIRES_REVIEW`, `REFUND_PENDING` |
| `RECONCILIATION_REQUIRED` | `CAPTURED`, `FAILED`, `CANCELLED`, `EXPIRED`, `UNKNOWN`, `REQUIRES_REVIEW`, `REFUND_PENDING` |
| `REQUIRES_REVIEW` | `CAPTURED`, `FAILED`, `CANCELLED`, `EXPIRED`, `REFUND_PENDING`, `REFUNDED` |
| `CAPTURED` | `REFUND_PENDING`, `PARTIALLY_REFUNDED`, `REFUNDED` |
| `REFUND_PENDING` | `CAPTURED`, `PARTIALLY_REFUNDED`, `REFUNDED`, `REQUIRES_REVIEW` |
| `PARTIALLY_REFUNDED` | `REFUND_PENDING`, `PARTIALLY_REFUNDED`, `REFUNDED` |
| `FAILED`, `CANCELLED`, `EXPIRED`, `REFUNDED` | *(Terminal — no normal transitions permitted; late authoritative capture uses audited `allowLateCaptureCompensation -> REFUND_PENDING` without reviving cancelled orders)* |

Key invariants enforced at DB and code levels:
- `CAPTURED` cannot downgrade to `FAILED`, `PENDING`, `CANCELLED`, or `EXPIRED`.
- `FAILED`, `CANCELLED`, `EXPIRED`, and `REFUNDED` cannot silently become `CAPTURED`.
- Duplicate transitions are idempotent no-ops and never duplicate ledger batches.

---

## 4. PostgreSQL-Backed Idempotency (`idempotencyService.ts`)

Financial API endpoints (`POST /api/v1/payments/create-order`, `verify`, `attempt`, `POST /api/v1/admin/refunds/issue`) enforce PostgreSQL-backed idempotency via `idempotency_keys`:
- **Actor + Operation + Endpoint Scoping**: Rejects cross-actor replay (`403 UNAUTHORIZED_IDEMPOTENCY_KEY_ACCESS`) and cross-operation replay (`422 IDEMPOTENCY_SCOPE_MISMATCH`).
- **Canonical Payload Fingerprint**: SHA-256 over key-sorted JSON (`computeCanonicalFingerprint`). Different payload with same key returns `422 IDEMPOTENCY_PAYLOAD_MISMATCH`.
- **Crash & Lease Reclamation**: `PROCESSING` rows carry `locked_until` (120s default); stale crashed leases and expired keys (`expires_at <= NOW()`) are atomically reclaimed within actor scope.
- **23505 Race Resolution**: Concurrent inserts catching PostgreSQL unique violation (`23505`) re-validate actor, scope, and fingerprint before returning `409` or cached `200/201`.
- **Redis Outage Survival**: Idempotency depends strictly on PostgreSQL, never on Redis.

---

## 5. Unknown Outcomes, Expiry & Bounded Recovery

- **Unknown Outcome Rule**: Network timeouts (`ETIMEDOUT`), ambiguous responses, or missing webhooks NEVER transition payment obligations or orders to `FAILED` or release inventory. They transition to `RECONCILIATION_REQUIRED` (intent) and `UNKNOWN` (attempt) with `failure_classification = 'AMBIGUOUS'`, recording a `STATUS_CHECK`/`UNKNOWN` `payment_transactions` row and scheduling `next_retry_at`.
- **Intent Expiration**: Uncaptured intents past `expires_at` transition safely to `EXPIRED` (`expireStalePaymentIntents`) without affecting already-captured payments.
- **Bounded Worker Recovery (`financialRecoveryWorker.ts`)**: Claims stale recoverable rows using `FOR UPDATE SKIP LOCKED` with worker leases, exponential backoff (`computeNextRetryAt`), and bounded max attempts/age (`maxAttempts = 10`, `maxAgeHours = 72`). Exhaustion escalates `payment_intents` to `REQUIRES_REVIEW` and persists a `reconciliation_discrepancies` exception (`refunds` remain `PROCESSING` with `requires_manual_review = TRUE` and persisted discrepancy).

---

## 6. Three-Phase Refund & Multi-Partial Refund Integrity (`refundService.ts`)

1. **Refund Eligibility**: Rejects unpaid/non-captured online orders (`PENDING`, `FAILED`, `EXPIRED`, `CANCELLED` -> `ORDER_NOT_REFUNDABLE`). Requires capture proof (`payment_receipts` / captured intent) in production.
2. **Ceiling Enforcement**: Sums all active/completed/processing/unknown/review refunds under `FOR UPDATE` on `orders`; rejects any request exceeding remaining captured balance (`REFUND_CEILING_EXCEEDED`).
3. **Cumulative Status Sync**: Across multiple partial refunds, sets `orders.payment_status` and `payment_intents.status` to `PARTIALLY_REFUNDED` until cumulative completed refunds reach the captured ceiling, then transitions cleanly to terminal `REFUNDED`.
4. **Lock-Free Provider Boundary**: External adapter calls run strictly between short Phase 1 (`prepareRefundIntent`) and Phase 3 (`executePreparedRefund` reconciliation) transactions.

---

## 7. Internal Reconciliation (`paymentReconciliationService.ts`)

Executes idempotent, provider-independent financial integrity checks:
- Paid online orders missing capture proof; captured intents/receipts whose order is unpaid/cancelled/expired.
- Captured payments missing balanced General Ledger batches (`recordOrderPayment` check).
- Multiple receipts or succeeded attempts per order; `orders.total_amount` vs capture amount mismatches; currency != `INR`.
- Refund totals exceeding captured ceiling; duplicate completed full refunds; missing attempt history on non-POD payments; stuck `PROCESSING`/`UNKNOWN` intents and refunds.
- **Deterministic Safe Auto-Repair**: Only transitions unambiguously expired uncaptured intents (`CREATED`/`INITIATED`/`PENDING` past `expires_at` with zero receipts/captures) to `EXPIRED`. All financial ambiguity or mismatch persists an idempotent `reconciliation_discrepancies` row (`occurrence_count` incremented on reruns) for Finance Admin triage.

Admin operational endpoints (`SUPER_ADMIN` / `FINANCE_ADMIN`):
- `POST /api/v1/admin/reconciliation/payments/run`
- `GET /api/v1/admin/reconciliation/discrepancies`
- `POST /api/v1/admin/reconciliation/discrepancies/:discrepancyId/resolve`
- `GET /api/v1/admin/payments/observability`

---

## 8. Database Transaction Boundaries & Lock Ordering

To prevent circular deadlocks across concurrent checkout verification, webhooks, refunds, cancellations, and recovery workers, transactions MUST acquire row locks in strict hierarchical order and hold zero locks during external HTTP calls:

1. `orders` (`FOR UPDATE`)
2. `inventory_reservations` (`FOR UPDATE`)
3. `payment_intents` (`FOR UPDATE`)
4. `payment_attempts` (`FOR UPDATE`)
5. `payment_transactions` / `refunds`
6. `general_ledger_entries` (`journal_batches` / `journal_entries` balanced via `money.ts` decimal arithmetic)

---

## 9. Security, Mock Isolation & Observability

- **Mock Isolation**: `MockPaymentProvider` is permitted only when `NODE_ENV !== 'production'`. `validateProductionSecurity()` fails startup if `PAYMENT_MODE=mock` or `'test'` or dev secrets are used in production. When `PAYMENT_MODE=none`, `DisabledPaymentProvider` boots general services safely while rejecting online payment initiation, verification, webhook processing, and gateway refunds fail-closed (`503 PAYMENT_GATEWAY_NOT_CONFIGURED`).
- **Rate Limiting**: Dedicated sliding-window limiters protect payment initiation (`paymentInitiationRateLimiter`), webhooks (`paymentWebhookRateLimiter`), and admin refund/reconciliation APIs (`adminSensitiveRateLimiter`), without blocking internal background recovery workers.
- **Redacted Correlation Logging (`paymentLogger.ts` & `paymentEvents.ts`)**: Logs include `orderId`, `paymentIntentId`, `attemptId`, `providerId`, and `internalReference` while recursively redacting `secret`, `token`, `signature`, `cardNumber`, `cvv`, `aadhaar`, `pan`, and `bankAccount`.

---

## 10. Future Payment Gateway Onboarding Checklist

When QCOM selects a future payment provider, integration requires ONLY:
1. Implement a dedicated adapter implementing `PaymentProvider` (`src/modules/payments/provider/PaymentProvider.ts`) in a separate provider package/module with accurate `PaymentProviderCapabilities`.
2. Enforce strict outbound HTTP timeouts, explicit webhook signature verification (`rawBody` HMAC/asymmetric check), and normalized error classification (`TRANSIENT` vs `PERMANENT` vs `AMBIGUOUS`).
3. Configure non-placeholder production secrets (`PAYMENT_MODE=production`, `PAYMENT_PROVIDER=<chosen>`, key ID/secret, webhook secret) passing `validateProductionSecurity()`.
4. Keep all payment state transitions, PostgreSQL idempotency, ledger postings, multi-partial refund ceilings, and internal reconciliation inside QCOM core services—never delegate business state to the external gateway.
