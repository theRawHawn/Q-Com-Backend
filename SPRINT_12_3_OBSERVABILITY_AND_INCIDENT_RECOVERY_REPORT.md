# SPRINT 12.3 — PRODUCTION OBSERVABILITY, ALERTING AND INCIDENT RECOVERY REPORT

**Project:** QCOM — Seller-Owned Hardware Quick-Commerce Marketplace  
**Sprint:** 12.3  
**Status:** COMPLETE & VERIFIED  
**Date:** October 20, 2026  
**Auditor / Engineering Roles:** Principal Site Reliability Engineer, Backend Architect, PostgreSQL Reliability Engineer, Financial Systems Auditor, and Application Security Engineer  

---

## 1. EXECUTIVE SUMMARY & BUSINESS DECISION AFFIRMATION

In accordance with QCOM business directives:
1. **No Payment Gateway Selected:** QCOM has not selected Razorpay, Cashfree, PayU, Stripe, or any other payment gateway. No external payment API calls or credentials were requested or used.
2. **Customer Frontend Preserved:** `QCOM/customer-app/src/**` was strictly preserved without modification. Git diff verification confirms zero changes to frontend code.
3. **Primary Objective Achieved:** Established comprehensive operational observability metrics, production alert definitions, financial incident recovery runbooks, read-only diagnostic query specifications, and correlation tracing across QCOM's backend services.

---

## 2. INSPECTION OF EXISTING OBSERVABILITY

### 2.1 Inspected Components
* **Structured Logging (`requestLoggerMiddleware`, `errorHandler`):** Outputs JSON log records including timestamp, request ID, method, URL, status code, duration, and client IP. Redacts sensitive authentication and payment tokens.
* **Request Correlation (`requestIdMiddleware`):** Assigns or propagates `X-Request-Id` across all incoming requests and downstream database/worker logs.
* **Health Probes (`app.ts`):**  
  * `GET /health`: Liveness probe reporting process uptime and basic status.
  * `GET /ready`: Authoritative readiness probe querying PostgreSQL (`SELECT 1`) and ephemeral cache (Redis) with latency tracking.
* **Background Workers (`server.ts`, `financialRecoveryWorker.ts`, `outboxService.ts`, `inventoryService.ts`):** Periodic execution with multi-instance lease protection (`FOR UPDATE SKIP LOCKED`) and failure logging.

### 2.2 Gaps Identified & Architecture Boundary
* **Metrics Exporter:** While structured logs and health endpoints are fully active, an explicit Prometheus `/metrics` endpoint or APM vendor integration is intentionally deferred until a specific deployment platform (Kubernetes / ECS / Cloud Run) is chosen. The metrics definition and integration boundary are documented herein.

---

## 3. DEFINED OPERATIONAL METRICS

To maintain high performance and low cardinality, metric labels exclude unbounded identifiers (such as order IDs, user IDs, or payment references).

### A. Application Metrics
* `qcom_http_requests_total{method, route, status}` — Total HTTP request count.
* `qcom_http_request_duration_seconds{method, route}` — Request latency histogram.
* `qcom_http_errors_5xx_total{route}` — HTTP 5xx error count.
* `qcom_process_uptime_seconds` — Process liveness indicator.

### B. Database Metrics
* `qcom_db_connection_pool_total` — Total connections in pool.
* `qcom_db_connection_pool_idle` — Idle connection count.
* `qcom_db_connection_pool_waiting` — Clients waiting for connection.
* `qcom_db_query_latency_seconds{operation}` — Database query duration.

### C. Background Workers Metrics
* `qcom_worker_runs_total{worker_id}` — Total worker cycle executions.
* `qcom_worker_jobs_processed_total{worker_type, status}` — Successfully processed background jobs.
* `qcom_worker_jobs_failed_total{worker_type}` — Failed background jobs requiring retry or escalation.
* `qcom_worker_oldest_pending_job_age_seconds{worker_type}` — Age of oldest unclaimed job in queue.

### D. Financial Operations Metrics
* `qcom_payment_reconciliation_required_total` — Payment intents in `RECONCILIATION_REQUIRED` state.
* `qcom_refunds_pending_total` — Refunds stuck in `PENDING` state beyond threshold.
* `qcom_ledger_batch_imbalance_total` — Detected financial journal imbalance ($\sum \text{Debits} \neq \sum \text{Credits}$).

### E. Inventory & Outbox Metrics
* `qcom_inventory_expired_reservations_total` — Unreleased expired stock reservations.
* `qcom_outbox_events_pending_total` — Unprocessed outbox events.
* `qcom_outbox_oldest_event_age_seconds` — Age of oldest pending outbox event.

---

## 4. PRODUCTION ALERT DEFINITIONS

| Alert Name | Severity | Detection Condition | Evaluation Window | Threshold Rationale |
|---|---|---|---|---|
| **1. PostgreSQL Unavailable** | **CRITICAL** | `/ready` probe returns HTTP 503 or `checkDatabaseHealth()` fails. | 1 minute (3 consecutive failures) | Authoritative database outage halts all checkout, inventory, and payment operations. |
| **2. Sustained High HTTP 5xx Rate** | **HIGH** | HTTP 5xx error rate exceeds 2% of total requests. | 5 minutes | Indicates server-side exceptions, unhandled rejections, or database connectivity spikes. |
| **3. Database Connection Pool Saturation** | **HIGH** | Waiting connection count $> 5$ or idle pool $= 0$. | 3 minutes | Prevents new transactions from acquiring connections, causing request timeouts. |
| **4. Financial Recovery Backlog Growing** | **HIGH** | `qcom_payment_reconciliation_required_total` $> 10$ or increasing for 15 mins. | 15 minutes | Signals gateway timeouts or webhook delivery failures requiring reconciliation. |
| **5. Refunds Stuck in Pending** | **HIGH** | Refunds in `PENDING` state $> 30$ minutes without worker progress. | 30 minutes | Indicates potential worker deadlock, lease expiration failure, or provider payout blocking. |
| **6. Ledger Imbalance Detected** | **CRITICAL** | Any transaction journal where $\sum \text{Debits} \neq \sum \text{Credits}$. | Immediate (1 check) | Double-entry accounting integrity violation; requires immediate administrative audit. |
| **7. Outbox Backlog Growing** | **MEDIUM** | Pending outbox event count $> 100$ and oldest age $> 10$ mins. | 10 minutes | Signals WebSocket/notification consumer degradation or relayer worker crash. |

---

## 5. FINANCIAL INCIDENT RECOVERY RUNBOOKS

### Scenario A: Payment Outcome Unknown (Gateway Timeout / 504)
* **Detection:** Payment intent transitions to `RECONCILIATION_REQUIRED`.
* **Database Inspection:** Query `payment_intents` and `payment_attempts` where `status = 'RECONCILIATION_REQUIRED'`.
* **Automated Recovery:** `FinancialRecoveryWorker` or administrator invokes `paymentService.reconcilePayment(orderId)`, querying the gateway provider authoritatively.
* **Manual Intervention:** If gateway provider status remains ambiguous, review provider dashboard logs, then invoke reconciliation endpoint with valid transaction reference. Never manually mark successful without provider evidence.

### Scenario B: Payment Captured but Order Cancelled / Expired
* **Detection:** Payment webhook received with success status for an order whose reservation expired or was cancelled (P0-A late payment).
* **Automated Recovery:** QCOM automatically deposits funds into escrow liability (`Cr 2010 Escrow Liability`), releases stock (never overselling), sets order payment status to `REFUND_PENDING`, and queues a compensation refund.
* **Verification:** Check `payment_receipts`, escrow ledger entries, and `refunds` table.

### Scenario C: Ledger Imbalance Detected
* **Detection:** Alert triggered by general ledger sum query where $\sum \text{Debits} \neq \sum \text{Credits}$.
* **Inspection:** Query `general_ledger_entries` grouped by `journal_batch_id`.
* **Recovery:** Roll back or adjust compensating journal entries through controlled audit scripts. Never edit journal rows directly without balanced offsetting entries.

---

## 6. SAFE READ-ONLY DIAGNOSTICS & CORRELATION

* **Bounded Queries:** All administrative and diagnostic queries enforce strict pagination (`LIMIT 50`) and read-only transaction scopes.
* **Correlation Tracing:** Every log record carries `requestId`, connecting HTTP requests to payment intents, attempts, outbox events, and ledger batches.
* **Access Control:** Diagnostic queries and administrative endpoints are protected by RBAC middleware requiring `ADMIN` or `FINANCE_AUDITOR` roles.

---

## 7. FAILURE AND RECOVERY TESTS EXECUTED

1. **Health Probe Integrity Test:** Verified that `/health` succeeds even during temporary Redis cache degradation, while `/ready` correctly reflects PostgreSQL outages (HTTP 503).
2. **Webhook Idempotency & Replay Test:** Verified that duplicate webhook delivery results in `duplicate: true` without duplicating inventory commitments or ledger postings.
3. **Worker Crash & Lease Expiry Test:** Verified that interrupted worker leases expire correctly and are claimed by surviving worker instances without duplicate side effects.
4. **Log Redaction Test:** Verified that access tokens, JWT secrets, payment payloads, and passwords are fully redacted from log output.

---

## 8. COMPLIANCE & SAFETY CONFIRMATIONS

* **No Payment Gateway Selected:** CONFIRMED.
* **No External API Calls:** CONFIRMED.
* **Customer Frontend Unchanged:** CONFIRMED (`QCOM/customer-app/src/**` verified via Git status/diff to have zero modifications).

---
*End of Report.*
