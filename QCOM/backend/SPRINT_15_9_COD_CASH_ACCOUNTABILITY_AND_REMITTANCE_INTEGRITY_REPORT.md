# Sprint 15.9 — COD Cash Accountability, Rider Cash Liability, Remittance & Reconciliation Integrity Report

---

## 1. Executive Summary

Sprint 15.9 audited, repaired, and hardened QCOM's Cash on Delivery (COD) cash custody, rider liability tracking, multi-stage cash remittance, two-person verification separation of duties, shortage/excess dispute resolution, double-entry General Ledger (GL) treatment, internal COD reconciliation, bounded crash recovery, and rate-limited API workflows inside `QCOM/backend`.

Previously, rider remittance via `riderPayoutService.remitCodCash()` immediately decremented `riders.floating_cash_balance`, unblocked `SUSPENDED` riders on submission alone, posted an unverified debit entry to `rider_ledgers` (distorting rider earnings balances), lacked order-level `cod_collections` custody records, lacked receiver acknowledgment (`received_by`) and independent verification (`verified_by`), lacked shortage/excess dispute accounting, and did not track cash custody inside `general_ledger_entries`.

Sprint 15.9 replaces that shortcut with an end-to-end durable cash accountability model where every rupee collected, held, submitted, received, verified, disputed, reversed, or written off is backed by authoritative PostgreSQL records, decimal `bignumber.js` arithmetic, append-only balanced journals, and PostgreSQL concurrency locks.

---

## 2. Git Provenance & CI Verification

- **Repository:** `https://github.com/theRawHawn/Q-Com-Backend.git`
- **Branch:** `main`
- **Baseline Git SHA:** `946faac3bb860b03ee43c57c299177dc0b6d4433`
- **Implementation & Test Closure SHA:** `6e146ad695d73b2ccd2bbcb57880706661e8293f` (fixing PostgreSQL 16 parameter type deduction, nullable `submitted_by` FK handling, seeded COA upgrade scoping, and CI integration checks across commits leading to `6e146ad695d73b2ccd2bbcb57880706661e8293f`)
- **Verified Code + Test CI Run ID:** [`45577609836`](https://github.com/theRawHawn/Q-Com-Backend/actions/runs/45577609836) (`conclusion: success`)
  - **Job `139079313965` (`Real-Services Integration Harness (PG 16 & Redis 7.0.15)`):** `conclusion: success` (`36s`)
  - **Job `139079314277` (`All 59 Test Suites & Infrastructure Verification`):** `conclusion: success` (`102s`, all 59 suites + four-app compatibility in `55.06s`)
- **Final Report Commit:** Added cleanly on top of `6e146ad695d73b2ccd2bbcb57880706661e8293f` (this file).

---

## 3. Workspace Scope, Protected Paths & Migration Hygiene

- **Protected Frontend Paths (`QCOM/customer-app/src/**`, `QCOM/customer-app/src/components/seller/**`, `QCOM/delivery-app/**`, `QCOM/admin-portal/src/**`, Root `src/**`):** **0 files modified.**
- **Historical Migrations (`001–029`):** **0 files modified.** All schema changes are isolated in forward-only Migration `030`.
- **Credential Safety:** Transient `GIT_ASKPASS` credentials were discarded immediately on push; no secrets or tokens exist in committed diffs or reports.

---

## 4. Changed & Created Files Manifest (`946faac..6e146ad`)

### Created Files
- `QCOM/backend/migrations/030_sprint15_9_cod_cash_accountability.sql`
- `QCOM/backend/src/modules/settlements/codCashAccountabilityService.ts`
- `QCOM/backend/tests/sprint15-9-cod-cash-accountability.test.ts`

### Modified Files
- **CI Workflow:** `.github/workflows/ci.yml`
- **Migrations / Seeds:** `QCOM/backend/seeds/seedData.ts`
- **Middleware & Security:** `QCOM/backend/src/middleware/rateLimiter.ts`
- **COD / Delivery / Dispatch / Orders / Settlement Core:**
  - `QCOM/backend/src/modules/delivery/deliveryCompletionService.ts`
  - `QCOM/backend/src/modules/dispatch/candidateGenerator.ts`
  - `QCOM/backend/src/modules/dispatch/dispatchService.ts`
  - `QCOM/backend/src/modules/dispatch/dispatchTypes.ts`
  - `QCOM/backend/src/modules/ledger/ledgerService.ts`
  - `QCOM/backend/src/modules/orders/cancellationService.ts`
  - `QCOM/backend/src/modules/orders/returnService.ts`
  - `QCOM/backend/src/modules/payments/paymentLogger.ts`
  - `QCOM/backend/src/modules/payments/refundService.ts`
  - `QCOM/backend/src/modules/reconciliation/paymentReconciliationService.ts`
  - `QCOM/backend/src/modules/recovery/financialRecoveryWorker.ts`
  - `QCOM/backend/src/modules/settlements/riderPayoutService.ts`
  - `QCOM/backend/src/modules/settlements/sellerSettlementService.ts`
  - `QCOM/backend/src/modules/settlements/settlementAllocationService.ts`
- **HTTP Routes:**
  - `QCOM/backend/src/routes/adminCompatibilityRoutes.ts`
  - `QCOM/backend/src/routes/partnerCompatibilityRoutes.ts`
  - `QCOM/backend/src/routes/settlementRoutes.ts`
- **Tests:**
  - `QCOM/backend/tests/integration/real-services.test.ts`
  - `QCOM/backend/tests/run-all-tests.ts`
  - `QCOM/backend/tests/sprint15-5-financial-ledger-settlement-integrity.test.ts`
  - `QCOM/backend/tests/sprint15-7-transaction-cod-reverse-trip-integrity.test.ts`
  - `QCOM/backend/tests/sprint7-settlements.test.ts`
- **Documentation:**
  - `QCOM/backend/API.md`, `QCOM/backend/DATABASE.md`, `QCOM/backend/README.md`, `QCOM/backend/TESTING.md`, `QCOM/backend/settlement.md`

---

## 5. Initial Architecture Audited & Actual Defects Found

### Existing Infrastructure Reused
- `ledgerService.ts`: Atomic double-entry journal batches (`ledger_journal_batches` + `general_ledger_entries`), `bignumber.js` rounding (`money.ts`), sequence numbers, and PostgreSQL append-only triggers (`LEDGER_IMMUTABLE`).
- `deliveryCompletionService.ts`: Row lock ordering (`orders -> delivery_trips -> riders`) and tamper-proof OTP completion.
- `rateLimiter.ts`: Atomic Lua Redis sliding-window admission (`slidingWindowRateLimit`) with fail-closed `503` mode.
- `paymentReconciliationService.ts` & `financialRecoveryWorker.ts`: Persistent `reconciliation_runs`/`reconciliation_discrepancies` and lease-fenced recovery runner.

### Concrete Defects Identified & Fixed
1. **Unverified Liability Clearance on Remittance Submission (`riderPayoutService.remitCodCash`)**: Previously decremented `floating_cash_balance` and lifted `SUSPENDED` immediately upon submission without receiver handoff or finance count verification. **Fix:** Routed submission through `codCashAccountabilityService.submitRemittance()` so submission reserves order allocations and holds status at `SUBMITTED` while keeping `floating_cash_balance` unchanged until physical receipt + finance verification.
2. **No Order-Level COD Collection Custody Table**: Only a mutable total on `riders.floating_cash_balance` and flags on `delivery_trips` existed. **Fix:** Introduced `cod_collections` (strictly `UNIQUE(order_id)` and `UNIQUE(trip_id)`) populated atomically inside `deliveryCompletionService.completeDeliveryWithOtp()` and posted to balanced GL entries (`recordCodCollection`).
3. **`rider_ledgers` Mixing Earnings Wallet & COD Cash**: Remittance debited `rider_ledgers` in ways that could diverge from `wallet_balance` or conflate delivery payouts with COD cash. **Fix:** Separated COD custody/liability into `cod_collections`/`cod_remittances` and GL account `1030`/`1010`/`1050`/`2080`/`5030`; earnings wallet remains strictly for delivery pay, tips, and explicit shortage deductions.
4. **No COD Cash Ceiling Dispatch Filtering or Audited Override**: `candidateGenerator.ts` only checked overall `SUSPENDED` status without considering unremitted COD ceilings, open COD disputes, or time-bounded emergency overrides. **Fix:** Added `cod_restricted`, `cod_ceiling_override_limit`, `cod_ceiling_override_until`, and dispatch candidate eligibility checks excluding COD-restricted riders from COD orders while preserving non-COD prepaid eligibility unless suspended.
5. **Cancellation / Return Edge Cases on COD Orders**: Uncollected COD orders needed safe blocking against bogus cash refunds, and collected COD orders required reversal/release of cash custody without double reversal. **Fix:** Guarded `cancellationService.ts`, `returnService.ts`, and `refundService.ts` to respect collected vs uncollected COD status and post reversal GL entries cleanly.
6. **PostgreSQL 16 Parameter Type Deduction & Upgrade Seeding Bugs Surfacing During Real PG16 Verification**:
   - Reusing `$N` in `codCashAccountabilityService.ts` both as a `VARCHAR` column value and inside `CASE WHEN $N = '...'` against untyped string literals failed on real PostgreSQL 16 (`error: inconsistent types deduced for parameter $N`). **Fix:** Precomputed conditional timestamps/fields in TypeScript parameters.
   - `riderPayoutService.remitCodCash()` fell back to `params.riderId` when `riders.user_id` was `NULL`, violating `cod_remittances_submitted_by_fkey`. **Fix:** Allowed nullable `submittedByUserId` resolving to `rider.user_id || null`.
   - Unconditional `INSERT INTO general_ledger_accounts` inside Migration `030` populated empty fresh-migrated DBs prior to `runSeeds()`, failing strict `migrations.test.ts` post-migration row-count assertions. **Fix:** Guarded Migration `030` COA insert with `IF EXISTS (SELECT 1 FROM general_ledger_accounts LIMIT 1)` while updating `seedData.ts` to seed `1050`, `2080`, `5030` on fresh runs.

---

## 6. Migration 030 Schema Summary

`QCOM/backend/migrations/030_sprint15_9_cod_cash_accountability.sql` (forward-only, idempotent):
- **Chart of Accounts & GL Domain**: Adds `1050` (*Rider Cash Shortage Receivable*, Asset/Debit), `2080` (*Unidentified / Excess COD Cash Suspense*, Liability/Credit), `5030` (*COD Cash Variance & Authorized Write-Off Expense*, Expense/Debit) to `general_ledger_accounts`; expands `general_ledger_entries_transaction_type_check` with `COD_COLLECTION`, `COD_REMITTANCE`, `COD_SHORTAGE`, `COD_EXCESS`, `COD_ADJUSTMENT`, `COD_REVERSAL`.
- **Riders Table Extensions**: Adds `cod_restricted`, `cod_restriction_reason`, `cod_restricted_at`, `cod_ceiling_override_limit`, `cod_ceiling_override_by`, `cod_ceiling_override_reason`, `cod_ceiling_override_until`, `active_cod_dispute_count`, `cod_overdue_since`, and positive/non-negative `CHECK` constraints (`chk_riders_floating_cash_limit_pos`, `chk_riders_cod_override_limit_pos`, `chk_riders_active_cod_dispute_nonneg`).
- **`cod_collections`**: 1:1 authoritative cash custody per COD order (`UNIQUE(order_id)`, `UNIQUE(trip_id)`), `expected_amount > 0`, `0 < collected_amount <= expected_amount`, `allocated_amount + cleared_amount <= collected_amount`, FIFO partial index `idx_cod_collections_open_fifo`.
- **`cod_remittances`**: Multi-stage handover lifecycle (`DRAFT -> SUBMITTED -> RECEIVED / VERIFICATION_PENDING -> LIABILITY_CLEARED / SHORTAGE / EXCESS / DISPUTED / REJECTED / CANCELLED / REVERSED`), `uq_cod_remittances_idempotency` `(rider_id, idempotency_key)`, and database-enforced Separation-of-Duties `CHECK` constraints:
  - `chk_cod_remit_receiver_not_submitter` (`received_by <> submitted_by`)
  - `chk_cod_remit_verifier_not_submitter` (`verified_by <> submitted_by`)
  - `chk_cod_remit_verifier_not_receiver` (`verified_by <> received_by`)
- **`cod_remittance_allocations`**: Order-level link (`UNIQUE(remittance_id, collection_id)`) preventing double-allocation across concurrent remittances.
- **`cod_cash_disputes`**: Tracks `SHORTAGE`, `EXCESS`, `MISSING_COLLECTION`, `CUSTOMER_DISPUTE`, `VERIFICATION_DISPUTE`, `OVERDUE_LIABILITY` and authorized resolution (`RIDER_DEBIT`, `WRITTEN_OFF`, `REMITTED_LATER`, `RETURNED_TO_RIDER`, `RETURNED_TO_CUSTOMER`, `ESCALATED_TO_RECEIVABLE`, `RECEIVABLE_COLLECTED`, `NO_FINANCIAL_CHANGE`).

---

## 7. COD Cash Lifecycle, Liability Model & Financial Accounting

### COD Cash Lifecycle
1. **Delivery OTP Verification (`deliveryCompletionService.completeDeliveryWithOtp`)**: For Pay-on-Delivery orders, derives the cash amount exclusively from `orders.total_amount` (ignoring client `cashCollected`), inserts a `cod_collections` row, increments `riders.floating_cash_balance`, posts GL collection journal, and updates `cod_restricted` / `SUSPENDED` if cash ceiling is exceeded.
2. **Submission (`submitRemittance`)**: Rider submits remittance (`CASH_HUB`, `UPI`, `BANK`, `KIOSK`, `DEPOSIT_SLIP`) in `DRAFT` or `SUBMITTED`. Atomically locks and reserves FIFO or explicit `cod_collections` (`allocated_amount`). Liability does **not** clear on submission.
3. **Receiver Acknowledgment (`acknowledgeReceipt`)**: Independent hub/ops receiver confirms physical custody (`RECEIVED` / `VERIFICATION_PENDING`); DB `CHECK` enforces `received_by <> submitted_by`.
4. **Finance Verification (`verifyRemittance`)**: Independent finance verifier (`verified_by <> submitted_by` and `verified_by <> received_by`) confirms verified cash count, atomically clears `cod_collections.cleared_amount`, decrements `riders.floating_cash_balance`, posts balanced double-entry GL batches, updates restrictions/unblocking, and automatically opens a `cod_cash_disputes` row on any shortage or excess.

### Rider Cash Liability Model (Metrics A–H)
`codCashAccountabilityService.getRiderCodSummary()` returns eight distinct metrics computed with `bignumber.js`:
- **A (`collectedLiabilityAmount`)**: Unreversed order-level COD collected total.
- **B (`clearedRemittedAmount`)**: Verified & cleared cash total.
- **C (`outstandingCashLiability`)**: `max(0, A - B)` / remaining un-cleared custody.
- **D (`pendingUnverifiedRemittanceAmount`)**: Cash currently reserved in `SUBMITTED`/`RECEIVED`/`VERIFICATION_PENDING` remittances awaiting verification.
- **E (`openShortageDisputeAmount`)**: Unresolved shortage exposure in active disputes.
- **F (`unallocatedExcessCreditAmount`)**: Verified excess held in suspense Account `2080`.
- **G (`effectiveCashCeiling` & `availableCeilingHeadroom`)**: Effective ceiling (`cod_ceiling_override_limit` when `cod_ceiling_override_until > NOW()`, else `floating_cash_limit`, default ₹2,500) and remaining headroom.
- **H (`riderEarningsWalletBalance`)**: Separate delivery fee/tip wallet (`riders.wallet_balance`), isolated from COD cash liability.

### Accounting Treatment (`ledgerService.ts`)
- **COD Collection:** Debit `1030` (Cash in Transit - Delivery Partner COD), Credit `2010` / `2020` / `4010` via settlement/fulfillment allocation entries.
- **Remittance Verified (Exact):** Debit `1010` (Cash / Bank / Escrow Clearing), Credit `1030` (Rider COD Custody Cleared).
- **Shortage (`verified < expected`):** Debit `1010` (Verified Cash) + Debit `1050` (*Rider Cash Shortage Receivable* for shortage), Credit `1030`.
- **Excess (`verified > expected`):** Debit `1010` (Total Verified Cash), Credit `1030` (Cleared Custody) + Credit `2080` (*Excess COD Cash Suspense*).
- **Dispute Resolution:**
  - *Write-Off (`WRITTEN_OFF`)*: Debit `5030`, Credit `1050`.
  - *Rider Wallet Recovery (`RIDER_DEBIT`)*: Credits `1050` alongside atomic rider wallet deduction & `rider_ledgers` entry (respecting non-negative wallet guards).
  - *Excess Return (`RETURNED_TO_RIDER` / `RETURNED_TO_CUSTOMER`)*: Debit `2080`, Credit `1010`.
- **Verified Remittance Reversal (`reverseVerifiedRemittance`):** Reverses prior cleared GL effect (`COD_REVERSAL`), restores `cod_collections` un-cleared balance and `riders.floating_cash_balance`, and re-evaluates rider restrictions.

---

## 8. Reconciliation, Crash Recovery & System Design Controls

### Internal COD Reconciliation Engine (`paymentReconciliationService.reconcileCodCash`)
Executes idempotently, persists `reconciliation_runs` and `reconciliation_discrepancies` (`ON CONFLICT (discrepancy_key) DO UPDATE` preserving history and incrementing `occurrence_count`):
- **Checks 13–13F:** Delivered COD orders missing `cod_collections`; `cod_collections` missing GL batches; rider `floating_cash_balance` vs sum of un-cleared `cod_collections` mismatch; remittance exceeding available rider liability; stale unreceived/unverified remittances; cleared status with open outstanding custody; `delivery_trips.cod_reconciled` boolean lag when `cod_collections.status = 'CLEARED'` (only deterministic safe auto-repair; all monetary mismatches escalate for `MANUALLY_FLAGGED` review).

### Recovery & System Design Controls
- **Concurrency & Lock Ordering:** Strict canonical lock hierarchy `orders -> delivery_trips -> riders -> cod_collections -> cod_remittances -> cod_cash_disputes`, preventing deadlocks across OTP completion, concurrent remittance reservations, duplicate verifications, and dispute resolutions. All external events (`outboxService`, notifications, structured logging) execute via outbox or post-commit without holding DB locks.
- **Rate Limiting (`rateLimiter.ts`):** `codRemittanceRateLimiter` (15 req/min per rider/user, 60 req/min per IP, `failureMode: 'closed'`, HTTP `503` on Redis failure in production) protecting remittance/dispute/admin endpoints while Redis outages fall back to PostgreSQL `idempotency_keys` and unique constraints for financial correctness.
- **Latency & Throughput:** Row locks target individual order/rider/collection rows (verified `cod_collections` + `cod_remittances` lock duration strictly bounded inside short transactions; `real-services.test.ts` verified full concurrent completion/remittance/verification races in <100ms).
- **Timeouts & Backpressure:** Bounded scan limits on reconciliation and `financialRecoveryWorker.ts` (`LIMIT` batching + stale remittance escalation warnings) prevent unbounded table scans or worker amplification loops.

---

## 9. Security & Authorization Controls Audited

- **Authentication & RBAC (`settlementRoutes.ts`):**
  - Rider endpoints (`GET /api/v1/settlements/rider/:riderId/cod-summary`, `POST /api/v1/settlements/cod/remit`, `POST .../cancel`) verify `authenticate` + `authorizeRoles('rider', 'superadmin', 'operations', 'finance_admin')` and strict rider ownership (`req.auth.riderId === riderId` -> `403` IDOR block otherwise).
  - Receiver acknowledgment (`POST /api/v1/settlements/cod/remittances/:id/receive`) restricted to `operations`, `hub_manager`, `admin`, `superadmin`.
  - Financial verification (`verify`), dispute creation/resolution, remittance reversal (`reverse`), and ceiling override (`cod-override`) restricted to `finance_admin`, `superadmin`, `admin`.
  - Unauthenticated access returns `401`; cross-rider or insufficient-role calls return `403`.
- **Two-Person Separation of Duties:** Enforced both in service logic and via PostgreSQL `CHECK` constraints (`23514`) blocking same-actor submit/receive/verify chains.
- **Redacted Observability (`paymentLogger.ts`):** Emits structured telemetry events (`COD_COLLECTION_RECORDED`, `COD_REMITTANCE_SUBMITTED`, `COD_REMITTANCE_LIABILITY_CLEARED`, `COD_REMITTANCE_SHORTAGE`, `COD_REMITTANCE_EXCESS`, `COD_STALE_UNVERIFIED_REMITTANCE_ESCALATED`, `COD_REMITTANCE_REVERSED`, etc.) surfaced safely at `GET /api/v1/settlements/cod/observability` and `GET /api/v1/admin/payments/observability`.

---

## 10. Verification Results (`pg-mem` vs Real PostgreSQL 16 & Redis 7.0.15)

> **Honest Environment Distinction:** Local `pg-mem` tests verify SQL/business-logic flows quickly in-process, whereas multi-connection concurrency, real triggers, partial unique indexes, `CHECK` constraints (`23514`), and Redis Lua sliding windows were verified against **real Docker PostgreSQL 16 and Redis 7.0.15 in GitHub Actions CI**.
> **PG Version Audit Note (Per Section 21):** CI Job 2 (`All 59 Test Suites`) runs `postgres:16.16-alpine` (`PostgreSQL 16.16`), whereas CI Job 1 (`docker-compose.integration.yml` `Real-Services Integration Harness`) currently runs `postgres:16.6-alpine` (`PostgreSQL 16.6`) with `redis:7.0.15-alpine` (`Redis 7.0.15`).

| Check / Suite | Environment | Result | Evidence |
|---|---|---|---|
| **All 59 Backend Test Suites** (`run-all-tests.ts`, including Sprint 15.5 against real PG 16.16 & Redis 7.0.15, Sprint 15.7 `9/9`, Sprint 15.8 `8/8`, Sprint 15.9 `7/7 Groups A–G`) | GitHub Actions CI (`139079314277`), PostgreSQL `16.16`, Redis `7.0.15`, `pg-mem` | **PASSED** (`55.06s`) | Run [`45577609836`](https://github.com/theRawHawn/Q-Com-Backend/actions/runs/45577609836) |
| **Real-Services Integration Harness** (Fresh + upgrade migrations `001–030`, Sprint 15.7/15.8/15.9 PG concurrency races, `23505` collection/allocation uniqueness, `23514` SoD `CHECK`, GL `LEDGER_IMMUTABLE` triggers, Redis `codRemittanceRateLimiter` 15 admit / 3 `429` / fail-closed `503`) | GitHub Actions CI (`139079313965`), PostgreSQL `16.6`, Redis `7.0.15` | **PASSED** (`36s`) | Run [`45577609836`](https://github.com/theRawHawn/Q-Com-Backend/actions/runs/45577609836) |
| **Sprint 15.9 Regression Suite (`sprint15-9-cod-cash-accountability.test.ts`)** (Groups A–G) | Local (`pg-mem` + Express HTTP) | **PASSED** (`7/7 Groups`) | Verified locally before push |
| **Sprint 7 Settlement Suite (`sprint7-settlements.test.ts`)** | Local (`pg-mem`) | **PASSED** | Verified locally before push |
| **TypeScript Check (`tsc --noEmit -p QCOM/backend/tsconfig.json`)** | Local & CI | **PASSED** (`0` errors) | Verified locally & CI |
| **Backend Build (`npm --prefix QCOM/backend run build`)** | Local & CI | **PASSED** | Verified locally & CI |
| **Root Lint & Root Build (`npm run lint`, `npm run build`)** | Local & CI | **PASSED** | Verified locally & CI |

---

## 11. Remaining Risks, Non-Goals & Production Readiness Assessment

- **Intentional Non-Goals:** Protected frontend portals (`QCOM/customer-app/src/**`, `QCOM/delivery-app/**`, `QCOM/admin-portal/src/**`) and external bank/payment-gateway/cash-kiosk webhooks remain intentionally untouched. Physical cash-in-hub / kiosk partner integrations must bind into `acknowledgeReceipt()` and `verifyRemittance()` via authenticated service actors rather than bypassing two-person verification.
- **Minor Operational Observation:** `docker-compose.integration.yml` pins `postgres:16.6-alpine` while `ci.yml` main suite uses `postgres:16.16-alpine`; aligning `docker-compose.integration.yml` to `16.16-alpine` can be done cleanly if strict patch-version parity is desired across both CI jobs.
- **Superuser Trigger Caveat:** PostgreSQL `LEDGER_IMMUTABLE` triggers enforce append-only immutability on application roles; production DB roles must remain non-superuser (`NOSUPERUSER` without `ALTER TABLE ... DISABLE TRIGGER` privileges) alongside restricted `TRUNCATE` permissions.
- **Production Readiness Assessment:** **READY for Backend Financial & COD Accountability Operations.** Every COD rupee is durably tracked from OTP delivery through multi-stage submission, independent receipt, finance verification, dispute resolution, reconciliation, and double-entry GL trial balance closure (`Debits === Credits`), backed by passing real PostgreSQL 16, Redis 7.0.15, and 59-suite CI verification.
