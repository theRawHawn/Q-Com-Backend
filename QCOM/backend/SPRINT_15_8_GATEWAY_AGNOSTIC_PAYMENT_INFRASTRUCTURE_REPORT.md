# Sprint 15.8 — Gateway-Agnostic Payment Infrastructure, Payment Lifecycle Integrity & Integration Readiness Report

> **Gateway Selection Status:** **QCOM has not selected a payment gateway. No provider integration, SDK, gateway credentials, sandbox transactions, or live payment transactions are implemented or authorized.**

---

## 1. Executive Summary

Sprint 15.8 audited, repaired, and hardened QCOM's internal, gateway-agnostic payment infrastructure inside `QCOM/backend` so that QCOM owns the complete payment obligation lifecycle, attempt history, normalized transaction ledger (`payment_transactions`), PostgreSQL-backed idempotency (`idempotency_keys`), state transition matrix (`paymentStateMachine.ts`), multi-partial refund integrity, double-entry general ledger guarantees, internal reconciliation (`reconciliation_runs`, `reconciliation_discrepancies`), bounded crash-recovery escalation (`financialRecoveryWorker.ts`), PII/secret-redacted observability (`paymentLogger.ts`), and readiness/health probing without selecting or connecting to any external payment gateway.

When `PAYMENT_MODE=none` (default for unselected production environments), QCOM fails closed with `503 PAYMENT_GATEWAY_NOT_CONFIGURED` on payment initiation and webhook ingestion while continuing to serve health, readiness, COD orders, order management, and internal reconciliation cleanly.

---

## 2. Baseline Commit

- **Repository:** `https://github.com/theRawHawn/Q-Com-Backend.git`
- **Branch:** `main`
- **Remote Baseline SHA:** `299820c83697e279693fe691e1da38996a7fc0cd`

---

## 3. Code & CI Verification Commit

- **Implementation & Integration Commit SHA:** `f71916220e3b7df98ead949da2d60ecd4004d5b3` (preceded by `f9f96efaa76d517453656b9cdc911407f0581981`)
- **Verified Code+Tests CI Run ID:** [`45004681368`](https://github.com/theRawHawn/Q-Com-Backend/actions/runs/45004681368) (`conclusion: success` across all 57 test suites and the Real-Services Integration Harness on PostgreSQL 16 and Redis 7.0.15)
- **Final Report Commit:** Added cleanly on top of `f71916220e3b7df98ead949da2d60ecd4004d5b3` (this document) with full synchronization and CI closure verified after push.

---

## 4. Git Status & Frontend Protection Verification

- Working tree cleanly synchronized with `origin/main`; transient askpass credentials deleted immediately after push.
- **Protected frontend paths (`QCOM/customer-app/src/**`, `QCOM/delivery-app/**`, `QCOM/admin-portal/src/**`, root `src/**`):** **0 files modified.**
- **Existing migrations (`001–028`):** **0 files modified.** All schema changes are isolated in Migration `029`.

---

## 5. Initial Architecture Audited

Before making changes, the following existing QCOM modules were inspected:
- `QCOM/backend/src/modules/payments/`: `paymentService.ts`, `refundService.ts`, `paymentProvider.ts`, `paymentStateMachine.ts`, `paymentTypes.ts`, `paymentEvents.ts`, `financialWebhookService.ts`, `provider/types.ts`, `provider/paymentProviderRegistry.ts`.
- `QCOM/backend/src/modules/ledger/ledgerService.ts` & `QCOM/backend/src/modules/pricing/money.ts` (`bignumber.js`).
- `QCOM/backend/src/modules/orders/`: `orderService.ts`, `cancellationService.ts`, `returnService.ts`.
- `QCOM/backend/src/modules/inventory/inventoryService.ts`.
- `QCOM/backend/src/modules/recovery/financialRecoveryWorker.ts`.
- `QCOM/backend/src/routes/`: `paymentRoutes.ts`, `refundRoutes.ts`, `adminRoutes.ts` (and `admin/reconciliation` handlers).
- `QCOM/backend/src/middleware/rateLimiter.ts` & `resourceOwnership.ts`.
- `QCOM/backend/migrations/001–028`, `.github/workflows/ci.yml`, `tests/run-all-tests.ts`, `tests/integration/real-services.test.ts`.

---

## 6. Audit Findings Classification

| Finding | Classification | Summary |
|---|---|---|
| Double-entry ledger, immutable triggers, settlement allocations, 3-phase lock-free refunds (`Sprint 15.5` / `15.7`) | **Already implemented & verified** | Reused directly without rewriting GL or refund orchestration. |
| Single-obligation / single-capture uniqueness in PostgreSQL (`payment_intents`, `payment_attempts`, `payment_receipts`) | **Missing** | Needed partial unique indexes (`uq_payment_intents_single_captured_per_order`, `uq_payment_intents_single_active_per_order`, `uq_payment_attempts_single_succeeded_per_order`, `uq_payment_tx_single_capture_per_order`, `uq_payment_receipts_order_success`) and normalized `payment_transactions` ledger table. |
| Client-submitted `amount`/`currency` validation on `POST /create-order` and `POST /attempt` | **Missing** | `createPaymentOrder` / `createPaymentAttempt` needed explicit rejection of `PAYMENT_AMOUNT_TAMPERED` and `UNSUPPORTED_CURRENCY` while preserving authoritative order total lookup. |
| `UNKNOWN` state & expiry lifecycle on `payment_intents`, `payment_attempts`, `refunds` | **Partially implemented** | Added `UNKNOWN`, `EXPIRED`, `REQUIRES_REVIEW` constraints, lifecycle timestamps (`expires_at`, `succeeded_at`, `failed_at`, `cancelled_at`, `expired_at`), `failure_classification`, and stale intent auto-expiry (`expireStalePaymentIntents()`). |
| Payment idempotency under Redis outage & operation scoping | **Partially implemented** | Extracted and hardened `idempotencyService.ts` with canonical JSON SHA-256 fingerprints, `operation_type`/`actor_id`/`endpoint` scoping, stale lease reclamation, and PostgreSQL PK concurrency protection. |
| Unselected gateway mode (`PAYMENT_MODE=none`) fail-closed behavior | **Defective** | Fixed `getProvider()` / `processWebhook()` and `/ready` readiness probe so `PAYMENT_MODE=none` fails closed with `503 PAYMENT_GATEWAY_NOT_CONFIGURED` even on provider-named webhook routes (e.g., `/webhooks/razorpay`). |
| Internal payment reconciliation & exception persistence | **Missing** | Implemented `PaymentReconciliationService` (`reconciliation_runs`, `reconciliation_discrepancies`) with deterministic auto-repair and admin resolution workflows. |
| Bounded worker recovery escalation | **Partially implemented** | Upgraded `financialRecoveryWorker.ts` to escalate retry-exhausted intents/refunds cleanly to `REQUIRES_REVIEW` + `requires_manual_review = TRUE` + reconciliation exception record. |
| Structured PII/secret redaction in payment logging | **Missing / Defective edge case** | Added `paymentLogger.ts` with word-boundary-safe key redaction so short sensitive tokens (`pan`, `cvv`, `otp`, etc.) redact secrets without corrupting safe names such as `discrepanciesFound`. |
| Webhook `error_message` on transaction rollback | **Defective** | Fixed catch block in `paymentService.processWebhook()` to store canonical error code (`PAYMENT_AMOUNT_MISMATCH` / `CURRENCY_MISMATCH`) instead of truncating the error message string. |

---

## 7. Existing Features Reused Without Duplication

- **General Ledger & Double-Entry Accounting (`ledgerService.ts`)**: Reused `recordOrderPayment`, `recordPreFulfillmentCancellationRefund`, reversal entries, sequence numbers, and `getTrialBalance()` (`bignumber.js`).
- **Outbox & Domain Event Dispatch (`outboxService.ts`, `paymentEvents.ts`)**: Reused transactional outbox staging and lease-fenced workers.
- **Three-Phase Refund & Cancellation Decoupling (`refundService.ts`, `cancellationService.ts`)**: Kept Phase 1 (`prepareRefundIntent` under `FOR UPDATE`), Phase 2 (gateway boundary outside DB locks), Phase 3 (short reconciliation TX) intact.
- **Rate Limiting (`rateLimiter.ts`)**: Reused Redis sliding-window Lua script + in-memory fallback with `paymentInitiationRateLimiter` and `paymentWebhookRateLimiter`.

---

## 8. Actual Defects Fixed

1. **`POST /create-order` and `POST /attempt` ignored client `amount`/`currency` tampering**: Added server-side mismatch validation rejecting client amount tampering (`PAYMENT_AMOUNT_TAMPERED`, HTTP 400) and non-`INR` currency (`UNSUPPORTED_CURRENCY`, HTTP 400) after ownership verification (`403`), while still deriving the payable obligation from `orders.total_amount`.
2. **`PAYMENT_MODE=none` bypassed fail-closed guard on `/webhooks/razorpay` and stale `/ready` probe**: Updated `PaymentService.getProvider()` and `processWebhook()` to check effective `PAYMENT_MODE=none` before signature verification and updated `/ready` in `app.ts` to inspect dynamic runtime mode.
3. **`webhook_events.error_message` overwritten on rolled-back `PAYMENT_AMOUNT_MISMATCH`**: Updated catch handler in `paymentService.ts` to persist exact canonical error code `'PAYMENT_AMOUNT_MISMATCH'` / `'CURRENCY_MISMATCH'`.
4. **`pg-mem` partial-index / query compatibility defects exposed during migration & reconciliation testing**: Ordered `idx_payment_transactions_order` prior to `uq_payment_tx_single_capture_per_order`, replaced correlated `NOT EXISTS` / `HAVING` / `ABS(float)` in `paymentReconciliationService.ts`, avoided redundant `expires_at IS NOT NULL` alongside `expires_at <= NOW()`, and guarded `SAVEPOINT` usage appropriately for test harness vs real PostgreSQL.
5. **`paymentLogger.ts` substring false-positive redaction**: Fixed `isSensitiveKey()` token matching so `'discrepanciesFound'` is not matched by `'pan'`.
6. **Integration test Redis socket leak (`real-services.test.ts`)**: Saved and restored the live Redis client (`prevRedisClient = getRedisClient()`) instead of resetting to `null` after testing Redis-outage fallback.

---

## 9. Implementations Delivered

- **Migration `029_sprint15_8_gateway_agnostic_payment_integrity.sql`**: Schema constraints, partial unique indexes, `payment_transactions`, `reconciliation_runs`, `reconciliation_discrepancies`, `idempotency_keys` scoping columns, and expanded `refunds`/`orders`/`payment_intents`/`payment_attempts` status domains.
- **`paymentStateMachine.ts`**: Centralized transition matrices (`PAYMENT_STATE_TRANSITION_MATRIX`, attempt/refund transition validation), terminal state protections, late capture compensation (`allowLateCaptureCompensation`), and row-locked state transitions.
- **`idempotencyService.ts`**: Canonical JSON serialization (`computeCanonicalFingerprint`), actor + operation + endpoint scoping, stale `PROCESSING` lease reclamation, `23505` race recovery, and PostgreSQL fallback when Redis is unavailable.
- **`paymentReconciliationService.ts`**: Multi-check internal reconciliation comparing orders, `payment_intents`, `payment_attempts`, `payment_receipts`, `payment_transactions`, `refunds`, and `general_ledger_entries`, with idempotent `ON CONFLICT (discrepancy_key) DO UPDATE` persistence, safe auto-repair of lapsed uncaptured intents to `EXPIRED`, and admin discrepancy resolution endpoints.
- **`paymentLogger.ts`**: Structured redacting payment observability logger + operational counters and `/api/v1/admin/payments/observability` reporting.
- **`financialRecoveryWorker.ts`**: Bounded retry recovery with lease fencing and terminal escalation to `REQUIRES_REVIEW` + `requires_manual_review = TRUE` + exception recording.

---

## 10. Files Modified & Created

- **Workflow**: `.github/workflows/ci.yml`
- **Migration**: `QCOM/backend/migrations/029_sprint15_8_gateway_agnostic_payment_integrity.sql`
- **Backend Core**:
  - `QCOM/backend/src/app.ts`
  - `QCOM/backend/src/modules/inventory/inventoryService.ts`
  - `QCOM/backend/src/modules/orders/cancellationService.ts`
  - `QCOM/backend/src/modules/payments/idempotencyService.ts` *(new)*
  - `QCOM/backend/src/modules/payments/paymentLogger.ts` *(new)*
  - `QCOM/backend/src/modules/payments/financialWebhookService.ts`
  - `QCOM/backend/src/modules/payments/paymentEvents.ts`
  - `QCOM/backend/src/modules/payments/paymentProvider.ts`
  - `QCOM/backend/src/modules/payments/paymentService.ts`
  - `QCOM/backend/src/modules/payments/paymentStateMachine.ts`
  - `QCOM/backend/src/modules/payments/paymentTypes.ts`
  - `QCOM/backend/src/modules/payments/provider/paymentProviderRegistry.ts`
  - `QCOM/backend/src/modules/payments/provider/types.ts`
  - `QCOM/backend/src/modules/payments/refundService.ts`
  - `QCOM/backend/src/modules/reconciliation/paymentReconciliationService.ts` *(new)*
  - `QCOM/backend/src/modules/recovery/financialRecoveryWorker.ts`
  - `QCOM/backend/src/routes/paymentRoutes.ts`
  - `QCOM/backend/src/routes/refundRoutes.ts`
- **Documentation & Env**: `QCOM/backend/.env.example`, `QCOM/backend/payments.md`, `QCOM/backend/database-lowercase.md`, `QCOM/backend/security.md`, `QCOM/backend/SPRINT_15_8_GATEWAY_AGNOSTIC_PAYMENT_INFRASTRUCTURE_REPORT.md`
- **Tests**:
  - `QCOM/backend/tests/sprint15-8-gateway-agnostic-payment-infrastructure.test.ts` *(new)*
  - `QCOM/backend/tests/integration/real-services.test.ts`
  - `QCOM/backend/tests/run-all-tests.ts`
  - `QCOM/backend/tests/sprint9-returns-cancellations.test.ts`

---

## 11. Migrations Summary

Migration `029_sprint15_8_gateway_agnostic_payment_integrity.sql`:
- Expands `payment_intents` (user, method, `internal_transaction_reference`, `expires_at`, `succeeded_at`, `failed_at`, `cancelled_at`, `expired_at`, `failure_classification`, `next_retry_at`, `requires_manual_review`, `version`, `metadata`) and adds partial unique indexes:
  - `uq_payment_intents_single_captured_per_order`
  - `uq_payment_intents_single_active_per_order`
  - `uq_payment_intents_internal_tx_ref`
- Expands `payment_attempts` and adds:
  - `uq_payment_attempts_single_succeeded_per_order`
  - `uq_payment_attempts_single_active_per_order`
  - `uq_payment_attempts_internal_ref`
- Creates immutable `payment_transactions` ledger table with:
  - `uq_payment_tx_single_capture_per_order` (`WHERE transaction_type = 'CAPTURE' AND status = 'SUCCEEDED'`)
  - `uq_payment_tx_provider_ext_ref`
- Adds `uq_payment_receipts_order_success` on `payment_receipts(order_id) WHERE status = 'SUCCESS'`.
- Hardens `idempotency_keys` (`operation_type`, `updated_at`, `locked_until`, `idx_idempotency_scope`).
- Expands `refunds` (`REVERSED`, `UNKNOWN`, `REQUIRES_REVIEW`, retry metadata) and `orders.payment_status` (`EXPIRED`, `UNKNOWN`, `REQUIRES_REVIEW`, etc.).
- Creates `reconciliation_runs` and `reconciliation_discrepancies`.

---

## 12. Payment State Machine

- Validated in `paymentStateMachine.ts`:
  - `CREATED -> INITIATED | PENDING | PROCESSING | AUTHORIZED | CAPTURED | FAILED | CANCELLED | EXPIRED | UNKNOWN | RECONCILIATION_REQUIRED | REQUIRES_REVIEW`
  - Terminal states: `CAPTURED` (only refund transitions allowed), `FAILED`, `CANCELLED`, `EXPIRED`, `REFUNDED` (`[]` unless explicit late capture compensation flag raises `REFUND_PENDING`).
  - `UNKNOWN` / `RECONCILIATION_REQUIRED` resolve cleanly via authoritative inquiry (`CAPTURED`, `FAILED`, `EXPIRED`, `CANCELLED`) or escalate to `REQUIRES_REVIEW`.
  - Self-transitions return `isDuplicate: true` idempotently without re-applying financial effects.

---

## 13. PostgreSQL-Backed Idempotency

- `idempotencyService.claimKey()` executes directly against PostgreSQL `idempotency_keys` using canonical SHA-256 request fingerprints, `actor_id` isolation (`403 UNAUTHORIZED_IDEMPOTENCY_KEY_ACCESS`), `operation_type` isolation (`422 IDEMPOTENCY_SCOPE_MISMATCH`), payload mismatch rejection (`422 IDEMPOTENCY_PAYLOAD_MISMATCH`), `23505` PK contention resolution, and expired/stale `PROCESSING` lease reclamation.
- Verified in both `pg-mem` unit tests and real PostgreSQL 16 integration harness with Redis client forced offline (`ECONNREFUSED`).

---

## 14. Duplicate Payment Protection

Layered defenses protect all five failure modes independently of any single idempotency key:
1. API request deduplication (`idempotency_keys` scoped by actor + operation + endpoint + fingerprint).
2. Active intent/attempt deduplication (`uq_payment_intents_single_active_per_order`, `uq_payment_attempts_single_active_per_order`).
3. Single capture enforcement across PostgreSQL (`uq_payment_intents_single_captured_per_order`, `uq_payment_attempts_single_succeeded_per_order`, `uq_payment_tx_single_capture_per_order`, `uq_payment_receipts_order_success`).
4. Authoritative ledger batch/journal reference uniqueness (Sprint 15.5 triggers + ledger journal uniqueness).
5. Post-cancellation late capture escalation (`REFUND_PENDING` -> automated refund + balanced GL reversal).

---

## 15. Concurrency & Transaction Boundaries

- Consistent lock ordering preserved across payment workflows: `orders (FOR UPDATE) -> inventory_reservations (FOR UPDATE) -> payment_intents (FOR UPDATE) -> payment_attempts (FOR UPDATE) -> ledger/outbox`.
- Database row locks are **never** held across external HTTP gateway calls (refund preparation, execution, and reconciliation follow Sprint 15.7's 3-phase decoupled transaction pattern; verified zero conflicting write locks via `pg_locks` in CI).
- Real PostgreSQL 16 concurrency tests verified single active intent convergence, `23505` duplicate capture rejection, `1/4` concurrent idempotency winner, and `1/2` concurrent 60% partial refund ceiling winner.

---

## 16. Refund Integrity

- Unpaid/uncaptured orders reject refunds (`ORDER_NOT_REFUNDABLE`).
- Cumulative captured refund ceiling computed using `bignumber.js` across `REQUESTED`, `PENDING`, `PROCESSING`, `UNKNOWN`, `COMPLETED`, and `REQUIRES_REVIEW` rows under row-level `FOR UPDATE` locking.
- Partial refunds cleanly transition order/intent states `CAPTURED -> PARTIALLY_REFUNDED -> REFUNDED`.

---

## 17. Ledger Integration

- Payment captures, cancellations, partial/full refunds, COD remittances, and clawbacks route through `ledgerService.ts` using decimal-safe `bignumber.js` arithmetic, append-only PostgreSQL immutability triggers (`027`), and canonical journal batch references.
- Global Trial Balance invariant (`Total Debits === Total Credits`, `difference === 0`) verified after Sprint 15.8 payment, failure, timeout/reconciliation, multi-partial refund, and escalation flows.

---

## 18. Internal Reconciliation

- `PaymentReconciliationService.runReconciliation()` executes internal cross-table integrity checks (paid order missing capture/receipt, missing GL entry, duplicate successful attempts/captures, amount/currency mismatch, stale/stuck `PROCESSING`/`UNKNOWN` attempts, lapsed intents, cumulative refund ceiling checks).
- Persists deduplicated findings into `reconciliation_discrepancies` with `ON CONFLICT (discrepancy_key) DO UPDATE` incrementing `occurrence_count`, safely auto-repairs lapsed uncaptured intents to `EXPIRED`, and supports admin RBAC listing & resolution (`/api/v1/admin/reconciliation/discrepancies`).

---

## 19. Recovery & Crash Safety

- `financialRecoveryWorker.ts` acquires bounded leases and recovers ambiguous `RECONCILIATION_REQUIRED` / `UNKNOWN` / `PROCESSING` intents and refunds.
- Exhausted retry budgets transition cleanly to `REQUIRES_REVIEW` with `requires_manual_review = TRUE`, `error_code = 'RECOVERY_RETRY_EXHAUSTED'`, and a reconciliation discrepancy record instead of silently marking failures or retrying indefinitely.

---

## 20. Security Audit & Controls

- JWT auth + `requireOrderOwnership` + `403` cross-customer IDOR rejection on payment creation, verification, status, and idempotency keys.
- Strict admin RBAC on reconciliation discrepancies, observability counters, and recovery triggers (`403` for customer tokens).
- Server-authoritative `orders.total_amount` + INR enforcement; `400 PAYMENT_AMOUNT_TAMPERED` / `UNSUPPORTED_CURRENCY`.
- HMAC-SHA256 webhook & internal payment signatures using isolated `PAYMENT_SECRET`.
- PII/secret/PAN/CVV/OTP/token redaction via `paymentLogger.ts`.

---

## 21–25. Six System Design Requirements

- **21. Rate Limiting:** Payment initiation (`paymentInitiationRateLimiter`) and webhooks (`paymentWebhookRateLimiter`) enforced via Redis atomic sliding-window script with bounded `Retry-After` and internal worker isolation (internal recovery/reconciliation runs bypass public HTTP limiters).
- **22. Latency:** Transactions kept short with zero external HTTP calls inside DB locks (`pg_locks` verified zero held table write locks during Phase 2 gateway calls); idempotency fast-path O(1) PK lookup. No synthetic load latency claims made beyond observed CI suite timings (`31.43s` total for all 57 backend suites).
- **23. Throughput:** Bounded connection pools and `FOR UPDATE` per-order serialization allow independent orders to process concurrently while strictly serializing contention on the same order/intent/idempotency key. Exact peak TPS under production load is **not benchmarked/verified** in this sprint.
- **24. Timeouts:** Payment intent expiry timestamps (`expires_at`), bounded DB connect/query timeouts, and explicit mapping of provider timeouts to `UNKNOWN` / `RECONCILIATION_REQUIRED` (`202`) rather than false failure. Future live provider adapter timeout budgets are documented in `payments.md` as integration requirements.
- **25. Backpressure:** Exponential backoff retry scheduling (`computeNextRetryAt`), max recovery retry escalation to `REQUIRES_REVIEW`, bounded batch limits in reconciliation and recovery workers, and atomic Redis rate limiters prevent retry storms.

---

## 26. Tests Added

1. **Unit & API Suite (`QCOM/backend/tests/sprint15-8-gateway-agnostic-payment-infrastructure.test.ts`)** — 8 comprehensive sections:
   - Test 1: Migration 029 tables (`payment_transactions`, `reconciliation_runs`, `reconciliation_discrepancies`) & columns.
   - Test 2: Centralized payment/attempt/refund state machine transitions & late capture compensation.
   - Test 3: Server-authoritative amount/currency tampering rejections (`400`) & anti-IDOR (`403`).
   - Test 4: Canonical PostgreSQL idempotency surviving simulated Redis outage (`ECONNREFUSED`), actor/operation/payload mismatch rejection, stale lease reclamation.
   - Test 5: Stale intent auto-expiry (`EXPIRED`), timeout -> `UNKNOWN`/`RECONCILIATION_REQUIRED` preservation, recovery on delayed confirmation, `DUPLICATE_PAYMENT_CAPTURE`.
   - Test 6: Unpaid refund rejection (`ORDER_NOT_REFUNDABLE`), multi-partial refund ceiling enforcement, cumulative state transitions `PARTIALLY_REFUNDED -> REFUNDED`.
   - Test 7: Internal reconciliation auto-repair & discrepancy upsert `occurrence_count`, bounded worker escalation to `REQUIRES_REVIEW`, admin RBAC endpoints.
   - Test 8: `paymentLogger` secret/PII redaction, `PAYMENT_MODE=none` fail-closed `503`, `/health` & `/ready` reporting, GL trial balance (`difference === 0`).
2. **Real PostgreSQL 16 + Redis 7.0.15 Harness (`QCOM/backend/tests/integration/real-services.test.ts` -> `runSprint15_8PostgresChecks`)**:
   - Migration `001–029` fresh & `001–024 -> 025–029` upgrade checks.
   - Verification of all 6 Migration 029 partial unique indexes in `pg_indexes`.
   - Concurrent `createPaymentOrder` convergence + real PG `23505` duplicate active intent & duplicate `CAPTURE/SUCCEEDED` rejection.
   - Concurrent `idempotencyService.claimKey` 4-way race with Redis disabled (`1` winner, `3` `PROCESSING`).
   - Concurrent 2x 60% `refundService.createRefund` ceiling race (`1` fulfilled, `1` `REFUND_CEILING_EXCEEDED`).
   - Internal reconciliation `occurrence_count` increment & worker escalation to `REQUIRES_REVIEW` on real PG 16.

---

## 27–30. Verification Matrix (Explicit Separation of Scope)

| Verification Layer | Status | Scope & Honest Distinction |
|---|---|---|
| **Local `pg-mem` Unit/API Checks** | Passed (Exit 0) | Local workspace (`tsx`) ran `migrations`–`sprint15-2-5` (53 suites), `sprint15-7`, and `sprint15-8` under `pg-mem` + `tsc --noEmit` + lint/build. Local sandbox lacks local PostgreSQL 16 / Redis 7.0.15 daemons. |
| **CI Job 1: `All 57 Test Suites & Infrastructure Verification`** | **Passed (`success`)** | GitHub Actions Run `45004681368` (Job `137153510726`) against **real PostgreSQL 16.16** & **Redis 7.0.15**: migrations `001–029`, seeds, all **57** automated suites (`31.43s`), `npx tsc --noEmit`, `npm run lint`, backend & root builds. |
| **CI Job 2: `Real-Services Integration Harness (PG 16 & Redis 7.0.15)`** | **Passed (`success`)** | GitHub Actions Run `45004681368` (Job `137153510412`) against isolated `postgres:16.6-alpine` & `redis:7.0.15`: fresh/upgrade migrations `001–029`, Redis multi-process rate-limit & failure-mode checks, Sprint 15.7 `pg_locks` & Sprint 15.8 real PostgreSQL 16 concurrency checks. |

---

## 31. Documentation Updated

- `QCOM/backend/payments.md`
- `QCOM/backend/database-lowercase.md`
- `QCOM/backend/security.md`
- `QCOM/backend/.env.example`
- `QCOM/backend/SPRINT_15_8_GATEWAY_AGNOSTIC_PAYMENT_INFRASTRUCTURE_REPORT.md` *(this report)*

---

## 32. Remaining Risks

- Live gateway webhook signature schemas, exact subunit currencies/rounding edge cases for a specific future provider, HTTP timeout tuning, and multi-region clock skew must be validated when an actual provider adapter is implemented in a future sprint.
- High-RPS load/soak benchmarking against sustained concurrent checkouts remains an operational pre-launch activity.

---

## 33. Unverified Behavior

- Live/sandbox external gateway network calls, hosted checkout redirects/SDK callbacks, real card/UPI settlement webhooks, and bank payout API settlement delays are **intentionally not implemented or tested** in Sprint 15.8.
- High-concurrency multi-host TPS throughput benchmarks were not executed.

---

## 34. Future Gateway Integration Requirements

1. Select a single primary provider via business/founder sign-off and implement an isolated adapter conforming to `PaymentProvider` (`src/modules/payments/provider/types.ts`).
2. Enforce strict external HTTP timeouts (`connect <= 3s`, total `<= 8–10s`) strictly **outside** database transactions, mapping ambiguous network failures to `UNKNOWN` / `RECONCILIATION_REQUIRED`.
3. Map provider-specific webhook events & raw status strings cleanly into QCOM's canonical state machine at the adapter edge without leaking provider states into `orders`, `ledger`, `settlements`, or `refunds`.
4. Inject provider secrets via secure secret manager environment variables (`PAYMENT_WEBHOOK_SECRET`, API keys) with `PAYMENT_MODE=<provider>` and `MockPaymentProvider` disabled in production.
5. Connect scheduled cron/worker execution for `paymentReconciliationService.runReconciliation()` and `financialRecoveryWorker` against real provider status inquiry (`getPaymentStatus`).

---

## 35. Gateway Non-Selection Confirmation

**Confirmed:** No payment gateway was selected, no provider SDK was installed, no gateway credentials were requested or committed, no sandbox/live external payment transactions were executed, and production/unconfigured mode (`PAYMENT_MODE=none`) fails closed with `503 PAYMENT_GATEWAY_NOT_CONFIGURED`.
