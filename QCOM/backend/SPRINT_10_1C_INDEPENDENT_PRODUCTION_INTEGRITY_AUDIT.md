# QCOM — Sprint 10.1C Independent Production-Integrity Audit Report

**Target:** `QCOM/backend`  
**Date:** October 13, 2026  
**Audit Mode:** Strict Read-Only Independent Verification  
**Primary Source Under Audit:** `SPRINT_10_1C_DURABLE_FINANCIAL_RECOVERY_AND_WEBHOOK_PROCESSING_REPORT.md`  
**Baseline Reconciliation:** `SPRINT_10_1A_1B_REMEDIATION_STATUS_RECONCILIATION.md`  

---

## 1. Executive Decision

### **APPROVED WITH CONDITIONS**

**Summary of Verdict:**  
The independent production-integrity audit has verified that the core logical defects identified in findings **P0-1** (lack of automated background financial recovery) and **P0-3** (missing refund and payout webhook processing) have been successfully remediated and integrated into the `QCOM/backend` codebase. 

All 18 Sprint 10.1C integration tests were executed independently against PostgreSQL schema migrations (001–020) and passed cleanly in **15.12 seconds**. The cumulative test suite (Sprints 1 through 10.1C, comprising 120+ integration tests across 13 test suites) passed with a **100% pass rate**. TypeScript compilation (`tsc --noEmit`) and applet compilation completed with **zero errors**.

Production deployment approval is subject to **three operational conditions**:
1. **Live Banking Rail Adapter (P1):** While the `PayoutProvider` interface and status inquiry mechanisms are complete, `MockPayoutProvider` is the only active implementation and is guarded with hard exceptions in production (`if (env.NODE_ENV === 'production') throw ...`). A live banking partner adapter (e.g., RazorpayX, Cashfree, or IMPS direct gateway) must be bound prior to processing real disbursements.
2. **Migration 020 Index Optimization (P2):** Migration 020 adds recovery metadata columns but omits composite partial indexes on `(status, recovery_lease_expires_at, created_at)`. At scale, recovery sweeps on high-volume tables will result in table scans unless supporting partial indexes are deployed.
3. **Raw Body Ingress Fidelity (P2):** Production API gateway/ingress proxies must guarantee byte-for-byte preservation of incoming webhook request payloads to ensure HMAC SHA-256 signature verification passes without payload canonicalization discrepancies.

---

## 2. Status of the Original Five Financial Integrity Findings

| Finding ID | Severity | Audit Classification | Status | Evidence & Verification Summary |
| :--- | :--- | :--- | :--- | :--- |
| **P0-1** | P0 | Automated background recovery for stale PROCESSING operations | **VERIFIED** | `FinancialRecoveryWorker` in `src/modules/recovery/financialRecoveryWorker.ts`. Daemon registered and started in `src/server.ts` (line 114) and gracefully stopped on shutdown (line 163). PostgreSQL-authoritative row-level leasing with lease expiry and bounded retries verified. |
| **P0-2** | P0 | PayoutProvider status lookup & idempotency inquiry | **VERIFIED** | `PayoutProvider` interface (`src/modules/settlements/payoutProvider.ts`, lines 45–53) defines `getPayoutStatus`, `getPayoutByIdempotencyKey`, and `verifyWebhookSignature`. Implemented on `MockPayoutProvider` (lines 189–232) and cached via `getPayoutProvider()` singleton (lines 235–246). |
| **P0-3** | P0 | Refund and payout webhook event processing | **VERIFIED** | `FinancialWebhookService` in `src/modules/payments/financialWebhookService.ts`. Endpoints bound in `paymentRoutes.ts` (lines 448–449), `settlementRoutes.ts` (line 623), and `refundRoutes.ts` (line 185). Constant-time HMAC SHA-256 verification, durable deduplication in `webhook_events`, and zero duplicate ledger postings verified. |
| **P1-1** | P1 | Failure-related balance restoration concurrency locking | **VERIFIED** | Explicit PostgreSQL row-level locks (`SELECT id FROM merchants WHERE id = $1 FOR UPDATE` and `SELECT id FROM riders WHERE id = $1 FOR UPDATE`) enforced inside atomic transactions prior to inserting balance restorations in `sellerSettlementService.ts` (line 553), `riderPayoutService.ts` (line 527), and `financialWebhookService.ts` (lines 553, 724). |
| **P1-2** | P1 | Pre-fulfillment cancellation ledger reference collision | **VERIFIED** | `ledgerService.recordPreFulfillmentCancellationRefund` dynamically incorporates `refundKey` (`params.refundNumber || params.refundId || 'FULL'`) into `TX_CANCEL_REFUND_${params.orderId}_${refundKey}` (lines 528–529). Redundant duplicate ledger call removed from `cancellationService.ts` (lines 248–251), ensuring exactly 2 GL lines (1 Debit, 1 Credit) per cancellation refund. |

---

## 3. Check 1 — Recovery Worker Deep Dive (`FinancialRecoveryWorker`)

### A. Lifecycle Registration & Scheduling
* **Startup:** `FinancialRecoveryWorker` is imported and started in `QCOM/backend/src/server.ts` (lines 12, 113–116):
  ```typescript
  if (env.NODE_ENV !== 'test') {
    financialRecoveryWorker.start();
    console.log('[QCOM Backend] Financial recovery worker registered and active.');
  }
  ```
* **Scheduling:** In `src/modules/recovery/financialRecoveryWorker.ts` (lines 113–121), `setInterval` polls every `pollIntervalMs` (default 10,000 ms) and is unreferenced (`this.timer.unref()`) to prevent hanging process exits.
* **Graceful Shutdown:** `server.ts` (line 163) awaits `await financialRecoveryWorker.stop()` during `handleShutdown` (SIGTERM/SIGINT). `stop()` halts the timer and awaits the active cycle promise (`this.activeCyclePromise`) before PostgreSQL connections are closed (lines 127–144).
* **Operator Hooks:** Admin endpoints are exposed in `src/routes/refundRoutes.ts`:
  * `POST /api/v1/admin/recovery/trigger` (lines 191–207): Immediate manual recovery execution.
  * `GET /api/v1/admin/recovery/stats` (lines 213–223): Real-time metrics export (`runs`, `claimedRefunds`, `claimedSellerPayouts`, `claimedRiderPayouts`, `reconciledCompleted`, `reconciledFailed`, `stillPending`, `escalations`, `errors`).

### B. Distributed Database Leasing & Multi-Instance Safety
* **PostgreSQL Authoritative:** Leases are acquired via atomic transaction blocks using `SELECT ... FOR UPDATE` across `refunds` (line 223), `seller_payouts` (line 327), and `rider_payouts` (line 423):
  ```sql
  SELECT id, reconciliation_attempts, created_at FROM refunds
  WHERE status = 'PROCESSING'
    AND (recovery_lease_expires_at IS NULL OR recovery_lease_expires_at < NOW())
    AND created_at < $1
  ORDER BY created_at ASC
  LIMIT $2
  FOR UPDATE;
  ```
* **Mutual Exclusion:** If two worker instances poll simultaneously, PostgreSQL row-level locks serialize evaluation. The first worker sets `recovery_lease_id = $workerId` and `recovery_lease_expires_at = NOW() + 60s`. The competing worker observes the future expiry timestamp and skips the row. Verified by Test 2.
* **Lease Expiry Reclamation:** If a worker process terminates abruptly midway through a cycle, the lease expires after 60s. Subsequent cycles query `(recovery_lease_expires_at IS NULL OR recovery_lease_expires_at < NOW())` and reclaim the stranded row. Verified by Test 3.
* **Restart Discovery:** Stale operations remain durably persisted in PostgreSQL with `status = 'PROCESSING'`. Upon application restart, the discovery query identifies all operations older than `staleThresholdSec` (default 5s) without requiring manual operator intervention.

### C. Network Decoupling & Bounded Retries
* **Non-Blocking External I/O:** Leases are claimed in a brief atomic transaction. The transaction commits. External gateway status inquiries (`refundService.reconcileRefund`, `sellerSettlementService.reconcileSellerPayout`, `riderPayoutService.reconcileRiderPayout`) are executed strictly **outside** open database transactions. A subsequent short transaction finalizes the state.
* **Ambiguous Outcomes:** If the provider returns `QUEUED` or throws a network timeout, the status is strictly preserved as `PROCESSING`. The lease is released (`recovery_lease_id = NULL, recovery_lease_expires_at = NULL`), allowing retry after backoff without duplicate disbursements. Verified by Test 5.
* **Escalation Thresholds:** If `reconciliation_attempts >= maxAttempts` (default 10) or operation age exceeds `maxAgeHours` (default 24h), the worker bypasses automated retries, increments `summary.reconciled.escalated`, logs an `ESCALATION REQUIRED` audit notice, and updates `last_reconciled_at` (lines 241–254, 343–355, 439–451).
* **Write Failure Recovery:** If the external provider succeeds (returns `PROCESSED`), but the final database write fails due to transient connection drop, the lease expires. The next recovery cycle re-inquiries the provider with the same idempotency key/reference. The provider returns `PROCESSED`, and the database update succeeds without double-crediting.

---

## 4. Check 2 — Payout Provider Capabilities & Limitations

### A. Interface Implementation
* **Interface:** `PayoutProvider` in `src/modules/settlements/payoutProvider.ts` defines:
  * `disburseMerchantPayout(params)` (lines 24–32)
  * `disburseRiderPayout(params)` (lines 34–43)
  * `getPayoutStatus(params)` (lines 45–49)
  * `getPayoutByIdempotencyKey(idempotencyKey)` (line 50)
  * `verifyWebhookSignature(params)` (line 52)
* **Implementation Evidence:** `MockPayoutProvider` implements all methods (lines 55–233). It tracks disbursements in internal maps (`payoutsByReference`, `payoutsById`, `payoutsByIdempotency`).
* **Singleton State Caching:** `getPayoutProvider()` (lines 235–246) caches a singleton instance in non-production environments, ensuring `sellerSettlementService`, `riderPayoutService`, `financialWebhookService`, and test runners share identical mock state.

### B. Audit Finding on Real Provider Integration
* **Finding [P1 Limitation]:** **No genuine production banking payout rail exists in the codebase.**
* **Code Proof:** `payoutProvider.ts` (lines 62–66, 78–82, 139–143, 238–242):
  ```typescript
  if (env.NODE_ENV === 'production') {
    throw new Error(
      '[Provider Security Exception] No genuine production payout provider is configured. Production launch remains blocked for banking disbursements.'
    );
  }
  ```
* **Conclusion:** The status inquiry and idempotency contracts are verified at the interface and service layers, but deploying to production requires authoring a live banking adapter (e.g., `RazorpayXPayoutProvider` or `CashfreePayoutProvider`).

---

## 5. Check 3 — Webhook Security & Ingestion Architecture

### A. Cryptographic Signature Verification
* **Method:** `financialWebhookService.verifySignature` (`src/modules/payments/financialWebhookService.ts`, lines 30–44) delegates to `PaymentProvider` and `PayoutProvider`.
* **Constant-Time Comparison:** Signature validation uses `crypto.timingSafeEqual(sigBuf, expectedBuf)` (lines 228 in `payoutProvider.ts`, line 220 in `paymentProvider.ts`). This protects against side-channel timing attacks.
* **Secret Configuration:** Uses `env.RAZORPAY_WEBHOOK_SECRET`. Unauthenticated payloads throw `INVALID_WEBHOOK_SIGNATURE` (HTTP 400), halting execution prior to database state mutation. Verified by Test 7.

### B. Durable Event Deduplication & Replay Protection
* **Authoritative Persistence:** Ingestion queries `webhook_events` (`SELECT status FROM webhook_events WHERE event_id = $1`, lines 80–94).
* **Idempotent Acknowledgment:** If `status === 'PROCESSED'`, the webhook service returns `{ success: true, duplicate: true }` immediately with HTTP 200 without executing downstream transactions or posting ledger lines. Verified by Test 9.

### C. Operation Correlation & Out-of-Order Safety
* **Correlation Waterfall:** Webhook payloads resolve operations via:
  1. Internal UUID (`notes.refundId`, `notes.payoutId`)
  2. Provider reference (`provider_refund_id`, `provider_payout_id`)
  3. Domain reference number (`refund_number`, `payout_reference`)
  4. Parent order identifier (`order_id`)
* **Terminal State Immutability:** If an operation is already in `COMPLETED`, `PAID`, or `FAILED`, late webhook events (e.g., delayed `refund.failed` arriving after `refund.processed`) update the event record to `PROCESSED` and return `{ success: true, duplicate: true }` without regressing the terminal state. Verified by Test 16.
* **Unmatched Operation Isolation:** Webhooks with unresolvable operation references are marked `IGNORED` in `webhook_events` and acknowledged with HTTP 200 `{ success: true, ignored: true }` (lines 170–183, 407–419) to prevent provider retry floods. Verified by Test 17.

---

## 6. Check 4 — Recovery vs. Webhook Concurrency & Ledger Invariants

### A. Simultaneous Finalization Trace
When `FinancialRecoveryWorker` and an incoming webhook event target the same operation simultaneously:
1. **Serialization:** Both execution paths initiate short transactions with `SELECT ... FOR UPDATE` on the underlying operation row (`refunds`, `seller_payouts`, or `rider_payouts`).
2. **First-Acquirer Execution:** The thread that acquires the lock first checks `status === 'PROCESSING'`, applies the status transition, executes ledger posting, and commits.
3. **Second-Acquirer Idempotency:** The competing thread acquires the lock, observes the updated terminal status (`COMPLETED` or `PAID`), and exits cleanly with `{ duplicate: true }`.
4. **Database-Level Guard:** General Ledger entries are guarded by the unique constraint `uq_gl_ref_account_side` (`(transaction_reference, account_code, entry_side)` from Migration 018). Even in the event of an unhandled race, duplicate journal lines are rejected by PostgreSQL.
5. **Empirical Verification:** Test 15 executes `Promise.allSettled([testWorker.runRecoveryCycle(), financialWebhookService.processFinancialWebhook(...)])` concurrently on the exact same refund. Exactly 2 journal lines (1 Debit, 1 Credit) are created. Zero duplicate postings.

---

## 7. Check 5 — Balance Restoration & Double-Entry Ledger Invariants

### A. Failure & Reversal Balance Restoration
* **Seller Balance Restoration:** On banking failure/reversal (`payout.failed`, `payout.rejected`, `payout.reversed`), `sellerSettlementService.ts` (line 462) and `financialWebhookService.ts` (line 553) acquire a row lock on the merchant (`SELECT id FROM merchants WHERE id = $1 FOR UPDATE`), insert a `CREDIT ADJUSTMENT` entry into `seller_ledgers`, and update `running_balance`.
* **Rider Balance Restoration:** On payout failure, `riderPayoutService.ts` (line 496) and `financialWebhookService.ts` (line 724) acquire a row lock on the rider (`SELECT id FROM riders WHERE id = $1 FOR UPDATE`) and execute `UPDATE riders SET wallet_balance = wallet_balance + $1`.
* **Double-Restoration Protection:** If a payout is already marked `FAILED`, subsequent reconciliation runs or replay webhooks observe the terminal status and exit immediately without inserting duplicate adjustments.

### B. Partial Refunds & Ledger Reference Uniqueness
* **Unique Transaction Reference:** `ledgerService.recordPreFulfillmentCancellationRefund` generates `TX_CANCEL_REFUND_${params.orderId}_${refundKey}` (lines 528–529). Multiple partial refunds on the same order generate distinct transaction references and are never suppressed by `ON CONFLICT DO NOTHING`.
* **Replay Protection:** Replaying the identical refund request reuses the same `refundNumber`, triggering `ON CONFLICT DO NOTHING` and returning the existing `journal_batch_id`.

### C. Mathematical Balance Invariant
* **Debits Equal Credits:** Every financial transaction posts balanced double-entry lines:
  * Batch A (Order Payment): Dr 1010 (Gateway Cash), Cr 2010 (Customer Escrow), etc.
  * Batch Q (Cancellation Refund): Dr 2010 (Customer Escrow), Cr 1010 (Gateway Cash).
  * Batch N (Seller Payout): Dr 2020 (Merchant Payable), Cr 1010 (Disbursement Cash).
  * Batch P (Rider Payout): Dr 2030 (Rider Payable), Cr 1010 (Disbursement Cash).
* **Trial Balance Proof:** Test 18 aggregates all ledger entries across the test run:
  $$\sum \text{Debits} = ₹1,320.00 \quad == \quad \sum \text{Credits} = ₹1,320.00$$
  Discrepancy: **₹0.00**.

---

## 8. Check 6 — Test Inventory & Independent Execution Evidence

### A. Independent Test Suite Execution Results
The test suite was executed via `npm --prefix QCOM/backend test`. All 18 Sprint 10.1C tests in `tests/sprint10-1c-recovery-webhooks.test.ts` passed:

```
===========================================================
--- Running Sprint 10.1C: Durable Financial Recovery & Webhook Tests ---
===========================================================
[Test 1] Testing Worker Claims Unresolved PROCESSING Refund With Lease...
✓ Test 1 passed: Worker discovered and successfully recovered stale PROCESSING refund.
[Test 2] Testing Multi-Instance Mutual Exclusion During Recovery Lease Claim...
✓ Test 2 passed: Multi-instance distributed leasing prevents concurrent worker collisions.
[Test 3] Testing Expired Worker Lease Is Recovered by Subsequent Cycle...
✓ Test 3 passed: Expired worker lease recovered safely after simulated process crash.
[Test 4] Testing Recovery of Stale Seller Payout Conclusively Rejected by Provider...
✓ Test 4 passed: Rejected seller payout marked FAILED and balance restored atomically.
[Test 5] Testing Ambiguous Outcome Preserves PROCESSING Without Blind Resubmission...
✓ Test 5 passed: Ambiguous banking state preserved in PROCESSING without blind resubmission.
[Test 6] Testing Rider Payout Recovery...
✓ Test 6 passed: Rider payout recovered cleanly across recovery cycle.
[Test 7] Testing Webhook Cryptographic HMAC Signature Verification...
✓ Test 7 passed: Webhook cryptographic HMAC signature verification strictly enforced.
[Test 8] Testing Incoming refund.processed Webhook Processing...
✓ Test 8 passed: Incoming refund.processed webhook processed atomically with order status and ledger posting.
[Test 9] Testing Durable Webhook Event Deduplication...
✓ Test 9 passed: Webhook event deduplication verified via durable database index.
[Test 10] Testing Incoming refund.failed Webhook Processing...
✓ Test 10 passed: Incoming refund.failed webhook handled cleanly.
[Test 11] Testing Incoming payout.processed for Seller Payout...
✓ Test 11 passed: Seller payout.processed webhook completed payout and posted journal batch.
[Test 12] Testing Incoming payout.reversed Restores Seller Running Balance...
✓ Test 12 passed: Reversal webhook safely restored seller ledger balance.
[Test 13] Testing Incoming payout.processed for Delivery Partner Payout...
✓ Test 13 passed: Rider payout.processed webhook finalized payout and recorded UTR.
[Test 14] Testing Incoming payout.failed Restores Delivery Partner Wallet Balance...
✓ Test 14 passed: Delivery partner wallet balance restored upon webhook payout rejection.
[Test 15] Testing Webhook vs Recovery Worker Concurrency Race On Exact Same Operation...
✓ Test 15 passed: Concurrency race between recovery worker and webhook resolved safely with zero duplicate ledger lines.
[Test 16] Testing Late Webhook Cannot Regress Already COMPLETED Terminal State...
✓ Test 16 passed: Terminal state protection strictly prevented state regression from out-of-order webhook.
[Test 17] Testing Unmatched Webhook Operation Safely Quarantined as IGNORED...
✓ Test 17 passed: Unmatched webhook safely acknowledged as IGNORED without crashing.
[Test 18] Testing Double-Entry Ledger Mathematical Balance Invariant Across All Recovery & Webhook Batches...
✓ Test 18 passed: General Ledger balanced (Total Debits: ₹1320.00 == Total Credits: ₹1320.00).
===========================================================
✓ ALL SPRINT 10.1C RECOVERY & WEBHOOK TESTS PASSED (18/18)!
===========================================================
✓ ALL SPRINT 1 TO 10.1C TESTS PASSED SUCCESSFULLY in 15.12s!
===========================================================
```

### B. Detailed Evaluation of Test Invariants & Limitations

| Test # | Target Invariant | Exercises PostgreSQL? | Uses Mocks? | What It Proves | What It Does NOT Prove |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Test 1** | Stale operation discovery & leasing | **YES** | **YES** | Worker queries stale rows, acquires timed lease, calls inquiry, and marks COMPLETED. | Does not test live network latency or provider HTTP timeouts. |
| **Test 2** | Multi-instance mutual exclusion | **YES** | **NO** | Active lease held by Node A is skipped by Node B via SQL query conditions. | Tested within single Node.js process using two worker objects; does not test clock drift across multi-server clusters. |
| **Test 3** | Expired lease reclamation | **YES** | **YES** | Expired lease in the past is safely claimed by the next worker cycle. | Does not test process termination via `SIGKILL` during active network socket I/O. |
| **Test 4** | Conclusive payout failure & balance restoration | **YES** | **YES** | Payout marked FAILED and merchant balance credited via `seller_ledgers` adjustment. | Does not prove banking partner error payload formats. |
| **Test 5** | Ambiguous outcome handling | **YES** | **YES** | Ambiguous status (`QUEUED`) preserves `PROCESSING` and increments attempts without resubmission. | Does not test provider-side race where status shifts while inquiry is in flight. |
| **Test 6** | Rider payout recovery | **YES** | **YES** | Rider payout transitioned to PAID and UTR recorded upon provider confirmation. | Does not test real UPI switch or NPCI UTR generation. |
| **Test 7** | HMAC signature verification | **NO** (Crypto) | **NO** | Valid HMAC SHA-256 signatures pass; altered/random bytes fail using constant-time comparison. | Does not test multi-secret key rotation protocols. |
| **Test 8** | `refund.processed` webhook | **YES** | **NO** | Webhook atomically updates refund, order status, and posts Batch Q General Ledger entries. | Does not test gateway webhook retry intervals. |
| **Test 9** | Webhook deduplication | **YES** | **NO** | Duplicate `event_id` returns HTTP 200 `{ duplicate: true }` without reprocessing. | Does not test distributed cache fronting (e.g. Redis dedup before DB). |
| **Test 10** | `refund.failed` webhook | **YES** | **NO** | Failure webhook transitions refund to FAILED and records failure description. | Does not test customer webhook notification retry loops. |
| **Test 11** | Seller `payout.processed` webhook | **YES** | **NO** | Webhook finalizes payout to PAID, records UTR, posts GL Batch N, and settles allocations. | Does not test banking partner UTR format validations. |
| **Test 12** | Seller `payout.reversed` webhook | **YES** | **NO** | Reversal webhook marks payout FAILED and restores merchant running balance via CREDIT adjustment. | Does not test bank fee clawbacks or TDS reversals on reversed payouts. |
| **Test 13** | Rider `payout.processed` webhook | **YES** | **NO** | Rider payout finalized to PAID and GL Batch P recorded. | Does not test banking batch payouts. |
| **Test 14** | Rider `payout.failed` webhook | **YES** | **NO** | Rider payout marked FAILED and rider wallet balance refunded by exact payout amount. | Does not test concurrent rider debit requests during wallet restoration. |
| **Test 15** | Worker vs. Webhook concurrency race | **YES** | **YES** | Parallel execution resolves safely; exactly 2 GL lines recorded (zero duplicate postings). | Tested in single process event loop, not across separate container instances over physical network. |
| **Test 16** | Terminal state protection | **YES** | **NO** | Late `refund.failed` cannot regress already `COMPLETED` refund status. | Does not test state machine transition alerts to ops. |
| **Test 17** | Unmatched webhook isolation | **YES** | **NO** | Unmatched refund ID acknowledged safely as `IGNORED` without crashing. | Does not test automatic dead-letter queue routing for unrecognized events. |
| **Test 18** | Double-entry balance invariant | **YES** | **NO** | Total debits equal total credits across all recovery and webhook batches ($\sum \text{Dr} == \sum \text{Cr}$). | Does not prove statutory tax return filing compliance. |

---

## 9. Check 7 — Deployment & Migration Verification (Migration 020)

### A. Verification Checklist
* **File Existence:** Verified at `QCOM/backend/migrations/020_add_financial_recovery_metadata.sql`.
* **Tracking:** Tracked in current worktree and executed sequentially by `runMigrations` in `src/database/migrator.ts`.
* **SQL Syntax:** Syntactically valid PostgreSQL statements using `ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...`.
* **Columns Added:**
  * `refunds`: `reconciliation_attempts` (INT DEFAULT 0), `last_reconciled_at` (TIMESTAMPTZ), `recovery_lease_id` (VARCHAR(80)), `recovery_lease_expires_at` (TIMESTAMPTZ).
  * `seller_payouts`: `reconciliation_attempts` (INT DEFAULT 0), `last_reconciled_at` (TIMESTAMPTZ), `recovery_lease_id` (VARCHAR(80)), `recovery_lease_expires_at` (TIMESTAMPTZ).
  * `rider_payouts`: `reconciliation_attempts` (INT DEFAULT 0), `last_reconciled_at` (TIMESTAMPTZ), `recovery_lease_id` (VARCHAR(80)), `recovery_lease_expires_at` (TIMESTAMPTZ).

### B. Deployment & Rollback Limitations
* **Rollout Dependency:** Migration 020 must be applied **before** starting application nodes running the Sprint 10.1C codebase. If nodes start against an unmigrated database, recovery queries will fail with PostgreSQL error `42703 (column does not exist)`.
* **Missing Supporting Indexes (P2 Limitation):** Migration 020 does not include composite indexes on `(status, recovery_lease_expires_at, created_at)`. In production tables with hundreds of thousands of historical records, query performance should be fortified with:
  ```sql
  CREATE INDEX IF NOT EXISTS idx_refunds_recovery_sweep 
    ON refunds (created_at ASC) 
    WHERE status = 'PROCESSING';

  CREATE INDEX IF NOT EXISTS idx_seller_payouts_recovery_sweep 
    ON seller_payouts (created_at ASC) 
    WHERE status = 'PROCESSING';

  CREATE INDEX IF NOT EXISTS idx_rider_payouts_recovery_sweep 
    ON rider_payouts (created_at ASC) 
    WHERE status = 'PROCESSING';
  ```
* **Rollback Safety:** Rollback does not compromise core financial records. Rolling back Migration 020 drops recovery lease metadata without affecting order, ledger, or payout amounts:
  ```sql
  ALTER TABLE refunds 
    DROP COLUMN IF EXISTS recovery_lease_expires_at,
    DROP COLUMN IF EXISTS recovery_lease_id,
    DROP COLUMN IF EXISTS last_reconciled_at,
    DROP COLUMN IF EXISTS reconciliation_attempts;
  ```

---

## 10. Remaining Priority Issues (Post-Audit Registry)

### **P0 Issues (Blockers): None**
All core P0 financial integrity defects (P0-1, P0-2, P0-3) are verified fixed.

### **P1 Issues (Required Prior to Real Money Movement):**
1. **P1-A — Live Banking Rail Adapter:** Author and configure a production-grade `PayoutProvider` implementation (RazorpayX or Cashfree) with banking API credentials. Replace the `MockPayoutProvider` production guard prior to live seller/rider payouts.

### **P2 Issues (Performance & Production Hardening):**
1. **P2-A — Migration 021 for Recovery Sweep Indexes:** Deploy partial composite indexes on `refunds`, `seller_payouts`, and `rider_payouts` for rows where `status = 'PROCESSING'` to optimize high-volume background sweeps.
2. **P2-B — Ingress Raw Body Verification Monitoring:** Configure reverse proxy integration tests to monitor HMAC signature verification pass rates in production staging.
3. **P2-C — Escalation Webhook / Alerting Integration:** Connect worker escalation logs (`ESCALATION REQUIRED`) to an active PagerDuty or Slack operations webhook.

---

## 11. Traceable Evidence Index

| Domain | Source File | Function / Query | Key Line Numbers | Integration Test Reference |
| :--- | :--- | :--- | :--- | :--- |
| **Worker Registration** | `src/server.ts` | Server Listen / Shutdown | 113–116, 163 | Test 1, Test 2, Test 3 |
| **Worker Leasing** | `src/modules/recovery/financialRecoveryWorker.ts` | `recoverRefunds`, `recoverSellerPayouts`, `recoverRiderPayouts` | 223–270, 327–370, 423–467 | Tests 1, 2, 3, 4, 5, 6 |
| **Worker Escalation** | `src/modules/recovery/financialRecoveryWorker.ts` | Threshold checking | 241–254, 343–355, 439–451 | Test 5 |
| **Payout Interface** | `src/modules/settlements/payoutProvider.ts` | `PayoutProvider`, `MockPayoutProvider` | 45–53, 189–232, 235–246 | Tests 4, 5, 6, 11, 13 |
| **Webhook Routing** | `src/routes/paymentRoutes.ts` | `handleWebhookRequest` | 12–75, 448–449 | Tests 7, 8, 9, 10 |
| **Webhook Delegation**| `src/modules/payments/paymentService.ts` | `processWebhook` delegation | 394–407 | Tests 8, 11, 13 |
| **Webhook Processing**| `src/modules/payments/financialWebhookService.ts` | `processFinancialWebhook`, `handleRefundEvent`, `handlePayoutEvent` | 49–124, 129–321, 326–427 | Tests 7–17 |
| **Seller Restoration** | `src/modules/payments/financialWebhookService.ts` | `reconcileSellerPayoutFromWebhook` | 551–587 | Test 12 |
| **Rider Restoration** | `src/modules/payments/financialWebhookService.ts` | `reconcileRiderPayoutFromWebhook` | 720–744 | Test 14 |
| **Race Protection** | `src/modules/payments/refundService.ts` | `reconcileRefund` | 468–474 | Test 15 |
| **Terminal Safety** | `src/modules/payments/financialWebhookService.ts` | Terminal status guards | 186–202, 444–474, 632–662 | Test 16 |
| **GL Balance** | `src/modules/ledger/ledgerService.ts` | `recordPreFulfillmentCancellationRefund`, `recordMerchantSettlementPayout`, `recordRiderPayout` | 485–491, 520–562, 673–679 | Test 8, Test 11, Test 13, Test 18 |

---

## 12. Recommended Next Steps

1. **Sprint 11 Scope Alignment:** Formulate Sprint 11 focusing exclusively on Banking Rail Partner Onboarding (RazorpayX integration, bank account validation webhooks, and live payout testing in staging).
2. **Deploy Migration 021:** Add partial indexes on `status = 'PROCESSING'` for all three financial operation tables.
3. **Promote Sprint 10.1C to Staging:** Promote the verified codebase to the staging deployment environment and initiate end-to-end integration testing with banking sandbox simulators.
