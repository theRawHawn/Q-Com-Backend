# QCOM — Sprint 10.1A / 10.1B Remediation Status Reconciliation

**Mode:** Strict Read-Only Audit  
**Target:** `QCOM/backend`  
**Date:** October 12, 2026  

---

## Executive Decision

**APPROVED WITH CONDITIONS**

While all core financial database decoupling, idempotency, race-condition protection, and double-entry general ledger balancing invariants (Tests 1–18) are fully implemented and verified passing, critical operational components—specifically automated background worker recovery for stale `PROCESSING` operations (P0-1) and dedicated webhook ingestion/reconciliation endpoints for refund and payout gateway events (P0-3)—remain unimplemented in the codebase. Production deployment is conditioned upon implementing automated background reconciliation workers and refund/payout webhook handlers.

---

## Status of Findings

### P0-1: No automated background recovery for stale PROCESSING operations
*   **Status:** **NOT FIXED**
*   **Source File & Function:** `QCOM/backend/src/modules/payments/refundService.ts` (`reconcileRefund`), `QCOM/backend/src/modules/settlements/sellerSettlementService.ts` (`reconcileSellerPayout`), `QCOM/backend/src/modules/settlements/riderPayoutService.ts` (`reconcileRiderPayout`).
*   **Implementation Evidence:** Manual reconciliation methods exist in service classes and admin HTTP routes (`POST /api/v1/admin/refunds/:refundId/reconcile`), but there is zero scheduler registration, cron trigger, or background worker loop in `QCOM/backend/src/server.ts` or `app.ts` to automatically discover and recover stale `PROCESSING` operations.
*   **Relevant Test & Proof:** Tests 5 and 6 prove that *manual* calls to `reconcileRefund` successfully resolve ambiguous states, but do not test automated background sweep/recovery.
*   **Remaining Limitations:** Operations left in `PROCESSING` due to hard process crashes or network black holes will remain stuck indefinitely unless an administrator manually invokes the reconcile endpoint.

### P0-2: PayoutProvider lacks status lookup/idempotency inquiry capabilities
*   **Status:** **VERIFIED FIXED**
*   **Source File & Function:** `QCOM/backend/src/modules/settlements/payoutProvider.ts` (`PayoutProvider` interface, `MockPayoutProvider`).
*   **Implementation Evidence:** The `PayoutProvider` interface defines explicit optional/required methods `getPayoutStatus` and `getPayoutByIdempotencyKey`. `MockPayoutProvider` implements both, maintaining internal state maps (`payoutsByIdempotency`, `payoutsByReference`, `payoutsById`) to support safe inquiry and idempotent replay.
*   **Relevant Test & Proof:** Tests 9, 10, 14 prove provider status lookup and idempotency key deduplication under mocked conditions.
*   **Remaining Limitations:** `MockPayoutProvider` is strictly guarded against production usage (`if (env.NODE_ENV === 'production') throw new Error(...)`). A live production adapter (e.g., RazorpayX / Cashfree) must implement these exact interface contracts.

### P0-3: Payment webhook handlers discard refund.* and payout.* events
*   **Status:** **NOT FIXED**
*   **Source File & Function:** `QCOM/backend/src/routes/paymentRoutes.ts` and `QCOM/backend/src/modules/payments/paymentService.ts` (`handleWebhookEvent`).
*   **Implementation Evidence:** Webhook handling exists exclusively for payment lifecycle events (`payment.captured`, `order.paid`, `payment.failed`). There are no webhook endpoints, signature verification bindings, or event routers for Razorpay/gateway `refund.*` or `payout.*` webhook events.
*   **Relevant Test & Proof:** None. No tests cover webhook ingestion for refunds or payouts.
*   **Remaining Limitations:** Asynchronous gateway refund completions or payout transfers sent via webhooks are ignored, forcing reliance on manual or batch reconciliation.

### P1-1: Failure-related balance restoration concurrency locking
*   **Status:** **VERIFIED FIXED**
*   **Source File & Function:** `QCOM/backend/src/modules/settlements/sellerSettlementService.ts` and `riderPayoutService.ts` (failure rollback handlers).
*   **Implementation Evidence:** Explicit PostgreSQL row-level locks (`SELECT id FROM merchants WHERE id = $1 FOR UPDATE` and `SELECT id FROM riders WHERE id = $1 FOR UPDATE`) are acquired inside the atomic transaction block prior to inserting balance restoration ledger entries.
*   **Relevant Test & Proof:** Tests 11 and 15 prove that conclusive payout failures correctly restore merchant and rider wallet balances atomically.
*   **Remaining Limitations:** Relies on PostgreSQL row locking; distributed locking across multi-region DB replicas is governed by DB isolation levels (REPEATABLE READ / SERIALIZABLE).

### P1-2: Pre-fulfillment cancellation ledger reference collision (ON CONFLICT DO NOTHING)
*   **Status:** **VERIFIED FIXED**
*   **Source File & Function:** `QCOM/backend/src/modules/ledger/ledgerService.ts` (`recordPreFulfillmentCancellationRefund`).
*   **Implementation Evidence:** The transaction reference is constructed dynamically using `refundKey` (`params.refundNumber || params.refundId || 'FULL'`): `TX_CANCEL_REFUND_${params.orderId}_${refundKey}`. This guarantees that multiple partial refunds or cancellations on the same order produce distinct ledger transaction references and are never suppressed by `ON CONFLICT DO NOTHING`.
*   **Relevant Test & Proof:** Tests 2, 3, and 16 prove unique constraint enforcement and non-suppression of distinct transaction lines.
*   **Remaining Limitations:** Requires strict uniqueness on `(transaction_reference, account_code, entry_side)` as enforced by migration 018.

---

## Migration 020 Verification

*   **File Existence:** Exists at `QCOM/backend/migrations/020_add_financial_recovery_metadata.sql`.
*   **SQL Validity:** Syntactically valid PostgreSQL statements (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...`). Adds `reconciliation_attempts`, `last_reconciled_at`, `recovery_lease_id`, and `recovery_lease_expires_at` to `refunds`, `seller_payouts`, and `rider_payouts`.
*   **Migration Execution:** Successfully tracked and executed by `runMigrations` in `migrator.ts` when initialized against the test pool.
*   **Limitations:** While the schema columns exist to support distributed worker leasing and retry tracking, no background worker daemon currently queries or updates these columns.

---

## Test Inventory & Execution Results

All 18 integration tests in `QCOM/backend/tests/sprint10-1a-decoupling.test.ts` were executed successfully:

1.  **Test 1:** Refund Gateway Call Executes Strictly Outside DB Transaction — Proves non-blocking external I/O during state persistence.
2.  **Test 2:** Concurrent Refunds Cannot Exceed Order Total (Atomic Ceiling Guard) — Proves strict SQL check / locking constraint against over-refunding.
3.  **Test 3:** Idempotent Replay of Refund Request — Proves duplicate requests return existing record without triggering provider calls.
4.  **Test 4:** Gateway Network Timeout Preserves PROCESSING (Outcome Unknown) — Proves timeout resilience without false failures.
5.  **Test 5:** Status Reconciliation Resolves Ambiguous Refund to COMPLETED — Proves correct manual/inquiry reconciliation flow.
6.  **Test 6:** Concurrent Reconciliation Idempotency — Proves thread-safe race handling during reconciliation.
7.  **Test 7:** Seller Payout Disbursed Outside DB Transaction — Proves decoupling of merchant settlement disbursement.
8.  **Test 8:** Concurrent Seller Payouts Cannot Double-Spend Balance — Proves atomic balance checks and row locks.
9.  **Test 9:** Seller Payout Idempotency Key Replay — Proves idempotency deduplication for seller payouts.
10. **Test 10:** Seller Payout Ambiguous Timeout Preserves PROCESSING — Proves safety under network loss.
11. **Test 11:** Conclusive Payout Failure Restores Merchant Running Balance — Proves correct ledger credit restoration upon bank rejection.
12. **Test 12:** Rider Payout Disbursed Outside DB Transaction — Proves decoupled rider payout dispatch.
13. **Test 13:** Concurrent Rider Payouts Cannot Over-Deduct Wallet — Proves wallet race protection.
14. **Test 14:** Rider Payout Idempotency Key Replay — Proves rider payout deduplication.
15. **Test 15:** Conclusive Rider Payout Failure Restores Wallet — Proves wallet balance rollback on rejection.
16. **Test 16:** General Ledger Unique Constraint Blocks Duplicate Journal Lines — Proves database-level double-entry integrity.
17. **Test 17:** Unique Constraints on Payout Tables (Migration 019) — Proves idempotency key enforcement at schema level.
18. **Test 18:** Double-Entry Ledger Mathematical Balance Invariant — Proves total debits equal total credits across all payout batches ($\sum \text{Debits} == \sum \text{Credits}$).

*Missing Tests:* No automated tests exist for background worker sweeps (P0-1) or incoming refund/payout webhook event processing (P0-3).

---

## Production Blockers & Priority Remediation

1.  **Blocker 1 (P0-1):** Implement an automated background recovery worker (using `recovery_lease_id` and `recovery_lease_expires_at` from Migration 020 with cron/setInterval) to sweep stale `PROCESSING` refunds and payouts.
2.  **Blocker 2 (P0-3):** Implement dedicated webhook verification and ingestion endpoints for gateway `refund.*` and `payout.*` asynchronous events.
