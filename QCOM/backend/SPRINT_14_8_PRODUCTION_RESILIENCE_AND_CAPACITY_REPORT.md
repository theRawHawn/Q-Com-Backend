# Sprint 14.8 — Production Resilience, Capacity Controls & Overload Protection

**Repository:** QCOM Backend<br>
**Gate:** **FAIL — production integration evidence is still required for critical distributed controls.**<br>
**Scope:** Backend only; no protected frontend files changed.

## A. Executive Summary

Sprint 14.8 addressed three verified weaknesses:

1. The Redis sliding-window limiter used separate pipelined commands, so concurrent instances could make admission decisions from non-atomic counts. Production Redis errors also failed open, and the unavailable-client path could use process-local counters.
2. Outbox selection used row locks but did not persist a claim after the selection transaction ended. Another instance could select and deliver the same pending event.
3. The administrative password endpoints authenticated users but did not require an administrative role. A customer could set a password on their own account through the administrative route.

The changes add atomic Redis admission, explicit fail-open/fail-closed behavior, trusted proxy CIDRs, durable fenced outbox leases, and admin-role authorization. Closure verification added current-password checking to the administrative change-password path and exercised role denial, session revocation, expired leases, ambiguous handler outcomes, and duplicate delivery in the test database. The full registered backend test battery passed. However, Redis 7 and PostgreSQL 16 were unavailable, and the backend TypeScript build remains blocked by 31 pre-existing diagnostics in untouched files. No production service or capacity claim is made; under the requested gate criteria, the sprint is **FAIL**.

## B. Existing Controls Inventory

| Control | Classification | Evidence and limitations |
|---|---|---|
| Rate limiting | **Implemented but only partially verified** | Atomic Redis Lua admission and route policies are implemented. Middleware tests use an in-memory/test evaluator; Redis 7 script execution, outage recovery, and independent-instance enforcement were not verified. |
| Latency measurement and percentiles | **Partially implemented** | Per-request duration/status logging exists. Percentile aggregation (p50/p95/p99), dependency timings, and an SLO-grade latency report are not implemented. |
| Throughput benchmarking | **Not implemented** | A synthetic concurrency check exists, but no controlled throughput benchmark, representative workload, or operations/second result is available. |
| Request and dependency timeouts | **Partially implemented** | PostgreSQL acquisition and Redis connection timeouts exist. HTTP deadlines, database statement/transaction deadlines, Redis command deadlines, and general worker deadlines/cancellation are absent or unverified. |
| Concurrency | **Implemented but only partially verified** | Existing database transactions, constraints, inventory locking, payment idempotency, and recovery leases remain. Outbox lease fencing is implemented and test-database scenarios pass; PostgreSQL 16 concurrency across real connections was not run. |
| Backpressure | **Partially implemented** | Per-process pool caps, bounded outbox/recovery batches, retry backoff, and rate-limit admission exist. Queue-depth/pool-saturation admission and overload behavior are not implemented or load-tested. |

## C. Changes Implemented

- `src/database/redis.ts`: Replaced pipelined sliding-window commands with one atomic Redis Lua operation. Production rate-limit coordination now throws when Redis cannot be used rather than silently using process-local state.
- `src/middleware/rateLimiter.ts`: Added scoped multi-key limits, identity hashing, explicit failure policy, safe 503 responses, and `Retry-After` handling. General admission explicitly fails open with a warning/header; sensitive route policies fail closed.
- `src/app.ts` and `src/config/env.ts`: Replaced the assumed one-hop proxy trust with explicit `TRUST_PROXY_CIDRS`; moved the general guard before body parsing and attached request logging before admission.
- `src/routes/authRoutes.ts`: Required an admin/operations role for administrative set/change-password endpoints.
- `src/routes/orderRoutes.ts`, `src/routes/paymentRoutes.ts`, `src/routes/dispatchRoutes.ts`, and `src/routes/resourceDemoRoutes.ts`: Applied route-category controls to order creation, payment initiation/webhooks, dispatch actions, and inventory restock.
- `migrations/025_add_outbox_worker_leases.sql`, `src/modules/outbox/outboxService.ts`, and `src/modules/outbox/outboxTypes.ts`: Added five-minute PostgreSQL outbox leases with per-claim fencing tokens, reclaim of expired claims, and fenced publish/retry transitions. Business status remains `PENDING` while an event is leased.
- Tests cover in-memory rate admission and injected limiter failures, outbox claim exclusion/fencing/recovery/duplicate delivery, and administrative password role and current-password enforcement.
- No payment provider was added; PostgreSQL remains the authority for financial and inventory state.

## D. Rate Limiting

Initial values are **provisional**; production traffic assumptions were not available to establish final limits.

| Category | Limit | Keying / behavior |
|---|---:|---|
| General API | 120/minute | Per route and source IP; explicit fail-open on Redis outage with warning and `X-RateLimit-Status: unavailable`. |
| OTP request | 5 / 10 minutes per phone; 30 / 10 minutes per IP | Phone value is SHA-256 keyed; aliases share a scope. |
| Authentication | 30/minute per identity; 120/minute per IP | Identity value is SHA-256 keyed; auth routes share a scope. |
| Order creation | 10/minute per authenticated user; 120/minute per IP | Fails closed if distributed coordination is unavailable. |
| Payment initiation | 10/minute per authenticated user; 120/minute per IP | Fails closed. |
| Payment webhook ingestion | 120/minute per IP | Shared across webhook aliases; fails closed. Provider retries should honor 429/503 and `Retry-After`. |
| Dispatch assignment/acceptance/rematch | 30/minute per authenticated user; 120/minute per IP | Fails closed. |
| Inventory restock | 30/minute per authenticated user; 120/minute per IP | Fails closed. |

Redis admission now performs cleanup, count, admission, and insertion in one Lua script. Critical policies return `503 RATE_LIMIT_UNAVAILABLE` with a safe message if distributed admission cannot be evaluated; they do not fall back to local counters. Requests exceeding a policy receive HTTP 429 and `Retry-After`.

`TRUST_PROXY_CIDRS` defaults to empty, so forwarded headers are not trusted by default. Deployments behind an ingress must configure only the exact proxy IPs/CIDRs. The full suite verifies the untrusted-proxy default; trusted-proxy deployment behavior was not tested against a real ingress.

The concurrent-limit and outage-response tests passed in the full test battery. Redis 7 atomic-script execution, cross-instance enforcement, Redis saturation, and production outage behavior remain unverified.

## E. Latency

No Sprint 14.8 p50, p95, or p99 measurements were collected. Existing request logs include duration and status, but do not produce bounded-cardinality percentile metrics. Database query duration, pool wait, Redis operation duration, and background-job duration are not consistently measured.

The final full test run took **37.78 seconds**. The suite also reported a synthetic 50-concurrent-read scenario, but it does not provide the workload duration profile, error rate, p50/p95/p99, or representative production infrastructure evidence required for an SLO. It is not presented as a production latency result.

## F. Throughput

No formal Sprint 14.8 throughput benchmark was run. Therefore completed operations/second, request count, error rate, and latency percentiles are **not reported**. No request-per-second or user-capacity claim is made.

## G. Timeouts

Verified settings:

- PostgreSQL pool maximum: `DATABASE_MAX_POOL_SIZE=10` by default (schema permits 1–50 per process).
- PostgreSQL idle pool timeout: `DATABASE_IDLE_TIMEOUT_MS=30000`.
- PostgreSQL connection acquisition timeout: `DATABASE_CONNECTION_TIMEOUT_MS=5000`.
- Redis connection timeout: 5 seconds in production and 2 seconds outside production; production retry configuration is bounded by the existing ioredis strategy.
- Financial recovery worker defaults include a 60-second lease and a 10-item batch.
- Outbox event claims now expire after five minutes and are fenced by a unique lease token.

There is no explicit application response deadline, PostgreSQL statement/transaction timeout, Redis command timeout, or general worker execution deadline in the inspected configuration. HTTP client disconnects are not proof that a database transaction rolled back; existing transaction cleanup remains responsible for commit/rollback. Timeout/cancellation safety for slow PostgreSQL and Redis operations remains unverified.

## H. Concurrency

The existing suite covers inventory contention, webhook idempotency, session revocation, and financial state transitions. Sprint 14.8 adds outbox lease persistence, two simultaneous claim attempts, stale-token rejection, and customer-role denial of administrative password management.

The outbox test uses `pg-mem`: concurrent claim attempts produced one active claim; expired-lease reclaim issued a new fencing token; the stale token was rejected; and an ambiguous handler result and an accelerated lease overrun caused safe at-least-once re-delivery. These tests do not prove PostgreSQL row-lock behavior across processes. The environment had no PostgreSQL listener, and the Sprint 14.1 test reported its `pg-mem` fallback. Real PostgreSQL 16 tests using separate connections/processes remain required.

## I. Backpressure

- Outbox batches are capped by the caller (the production relayer requests 50 events) and are processed sequentially with one active batch per process.
- Outbox data remains durable in PostgreSQL. Claims expire after five minutes; only the current, unexpired token can publish or schedule a retry.
- The financial recovery worker uses bounded batches and PostgreSQL-backed leases.
- No request admission based on PostgreSQL pool saturation, outbox queue depth, or worker saturation was added. The database-backed outbox has no configured hard queue-size limit; committed work is not discarded.
- PostgreSQL saturation, Redis outage under real traffic, queue growth, worker saturation, and duplicate-webhook burst tests were not run in isolated real infrastructure.

## J. Resource Budgets

- PostgreSQL defaults: maximum 10 clients per backend process, 30-second idle timeout, and 5-second acquisition timeout. Total deployment demand is at most `instance_count × DATABASE_MAX_POOL_SIZE` for the HTTP process's shared pool, plus any separately configured processes. The actual PostgreSQL capacity and instance count are unknown, so a safe deployment-wide budget cannot be calculated.
- Redis uses a primary client and may create dedicated subscriber clients. Redis `maxmemory`, client limit, command latency, and production topology were not measured here.
- Outbox batch size is 50 in the server relayer; recovery defaults to batches of 10. Outbox delivery is sequential within a batch.
- Readiness requires PostgreSQL. Redis is reported as degraded when unavailable; sensitive routes that need distributed rate limiting reject traffic, while other application features may remain available.

## K. Authentication Regression

The two administrative password endpoints require one of `ADMIN`, `SUPER_ADMIN`, `OPERATIONS`, or `FINANCE_ADMIN` (with the existing super-admin bypass) in addition to authentication. They only target the authenticated user's own user ID. `/change-password` now requires a valid `currentPassword`; its conditional update rejects a stale password hash and leaves credential/session state unchanged on a failed check. Successful changes retain session revocation and audit behavior. Tests exercised unauthenticated, customer, delivery-partner (`RIDER`), and authorized super-admin access against both endpoints; requests rejected by RBAC did not change credential state.

The full test suite verifies that an authenticated customer receives HTTP 403 from the administrative password endpoint, while existing Sprint 14.7 tests verify admin password updates and session revocation. No broader authentication rewrite was made.

## L. Financial Integrity

No payment, refund, payout, ledger, or inventory transaction boundary was changed. The full registered suite passed existing payment idempotency, refund/payout, ledger, and inventory assertions in the test environment. Because real PostgreSQL was unavailable, this is not new PostgreSQL 16 evidence. Outbox delivery remains at-least-once; consumers must be idempotent if an external side effect completes before a lease expires.

## M. Test Evidence

| Command / check | Result |
|---|---|
| `npm.cmd run test:backend` | **PASS** — all registered suites passed in 37.78 seconds. Database suites used `pg-mem` where no real PostgreSQL was available. |
| Focused RBAC/password test | **PASS** — both endpoints, unauthenticated/customer/RIDER denials, current-password rejection, authorized password change, and session revocation. Test database: `pg-mem`. |
| Focused outbox test | **PASS** — claim exclusion/recovery, fencing, ambiguous retry, and over-lease duplicate delivery. Test database: `pg-mem`. |
| Focused rate-limiter test | **PASS** — rate headers, shared-IP admission, fail-closed/fail-open responses. Evaluator: in-memory/injected; not Redis 7. |
| Focused migration test | **PASS** — 25 migrations on fresh test database and rerun idempotency. Engine: `pg-mem`. |
| Migration 025 upgrade simulation | **PASS in `pg-mem` only** — apply 001–024, retain a pre-existing pending event, then apply 025; row remained `PENDING` with nullable lease columns. Not PostgreSQL 16 evidence. |
| `npm.cmd run build --prefix QCOM\backend -- --pretty false` | **FAIL** — 31 diagnostics in source/test files unchanged by Sprint 14.8. No diagnostics point to Sprint 14.8 implementation files. All are listed in the closure addendum below. |
| PostgreSQL 16 / Redis 7 service availability | **UNAVAILABLE** — local checks found no listener on ports 5432 or 6379. The PostgreSQL 16 suite used its documented `pg-mem` fallback. |
| Whitespace check | **PASS for Sprint 14.8 changes**; the only `git diff --check` warning is a pre-existing trailing blank line in `vite.config.ts`. |

Dependencies were restored from the existing package manifest with `npm.cmd install --no-save --package-lock=false --no-audit --no-fund`; package manifests and lockfiles were not changed.

## N. Documentation Changes

- `API.md`: initial route policies, retry responses, and proxy trust.
- `ARCHITECTURE.md`: distributed rate admission and outbox fencing.
- `DATABASE.md`: Migration 025 and lease invariant.
- `DEBUGGING.md`: limiter degradation diagnostics.
- `INTEGRATIONS.md`: actual PostgreSQL pool defaults and Redis failure behavior.
- `README.md`: Redis and proxy configuration notes.
- `TESTING.md`: Sprint 14.8 tests and verification boundaries.
- `PLAN.md`: Sprint 14.8 implementation and gate status.
- `.env.example`: `TRUST_PROXY_CIDRS`.

## O. Remaining Risks and Production Prerequisites

1. Apply Migration 025 to a disposable PostgreSQL 16 instance and verify simultaneous claims, lease expiry/reclaim, and stale-token rejection using separate connections/processes.
2. Run the limiter Lua script against Redis 7, including concurrent clients on multiple backend instances and a Redis failure/recovery test.
3. Establish representative workloads and report p50/p95/p99, successful operations/second, error rate, and PostgreSQL/Redis observations before setting production limits or SLOs.
4. Define HTTP, database query/transaction, Redis command, and worker timeout/cancellation behavior with tests that verify transaction cleanup and safe retries.
5. Calculate the deployment-wide PostgreSQL connection budget from actual instance count and database capacity.
6. Outbox leases are five minutes and are not renewed while a handler runs. A handler that exceeds the lease can be delivered again; consumers must remain idempotent, and long-running handlers need a tested renewal/deadline strategy.
7. `TRUST_PROXY_CIDRS` must match the deployment ingress. If unset behind a load balancer, limiting will use the proxy peer address and may group many clients together.
8. The backend build remains blocked by the 31 pre-existing diagnostics listed below. They span payment-provider contract drift, older test fixtures, and unrelated order/compatibility code. A full fix would require broader changes to financial-provider interfaces and test contracts; no such refactor was made during this scoped closure.

## P. Git Evidence

- Base `HEAD`: `86669616c5cfbd4adbdb1ad18803fd00f91e680e`.
- No commit was created.
- No push was performed.
- Staged lowercase documentation changes were preserved and not restaged or altered in the index.
- Pre-existing `vite.config.ts` edit was preserved.
- Sprint closure changes remain unstaged; see the final status addendum below.

## Q. Gate Decision

**FAIL.** The scoped authentication and test-database regressions pass, but the backend build still has 31 unresolved pre-existing TypeScript diagnostics, and critical Redis 7/PostgreSQL 16 distributed behavior has not been verified against real services.

## R. Sprint 14.8 Closure Verification Addendum — 2026-10-29

### Build diagnostics and attribution

Command: `npm.cmd run build --prefix QCOM\backend -- --pretty false`<br>
Result: **FAIL, 31 TypeScript diagnostics.** The affected diagnostic files were unchanged in the Sprint 14.8 worktree diff and no diagnostic points to a Sprint 14.8 file. They are therefore classified as **pre-existing relative to Sprint 14.8**. The payment-provider diagnostics form a cross-contract type mismatch affecting financial provider/service interfaces and fixtures; no compatibility casts, compiler suppression, strictness changes, or test removals were used. No broad financial-provider refactor was judged safe within this closure.

| # | File | Line | Code | Diagnostic message | Attribution / resolution |
|---:|---|---:|---|---|---|
| 1 | `src/modules/orders/orderService.ts` | 82 | TS18048 | `'deliveryDest' is possibly 'undefined'.` | Pre-existing; unchanged file; unresolved. |
| 2 | `src/modules/orders/orderService.ts` | 83 | TS18048 | `'deliveryDest' is possibly 'undefined'.` | Pre-existing; unchanged file; unresolved. |
| 3 | `src/modules/payments/paymentProvider.ts` | 72 | TS2430 | `Interface 'import("C:/Users/rohan/Downloads/q-commerce-backend-architect/QCOM/backend/src/modules/payments/paymentProvider").PaymentProvider' incorrectly extends interface 'import("C:/Users/rohan/Downloads/q-commerce-backend-architect/QCOM/backend/src/modules/payments/provider/PaymentProvider").PaymentProvider'.` | Pre-existing provider-contract mismatch; unchanged file; unresolved. |
| 4 | `src/modules/payments/paymentProvider.ts` | 742 | TS2739 | `Type 'import("C:/Users/rohan/Downloads/q-commerce-backend-architect/QCOM/backend/src/modules/payments/provider/PaymentProvider").PaymentProvider' is missing the following properties from type 'import("C:/Users/rohan/Downloads/q-commerce-backend-architect/QCOM/backend/src/modules/payments/paymentProvider").PaymentProvider': mode, createOrder, verifyPaymentSignature, mapProviderStatus` | Pre-existing; unchanged file; unresolved. |
| 5 | `src/modules/payments/paymentProvider.ts` | 747 | TS2739 | `Type 'import("C:/Users/rohan/Downloads/q-commerce-backend-architect/QCOM/backend/src/modules/payments/provider/PaymentProvider").PaymentProvider' is missing the following properties from type 'import("C:/Users/rohan/Downloads/q-commerce-backend-architect/QCOM/backend/src/modules/payments/paymentProvider").PaymentProvider': mode, createOrder, verifyPaymentSignature, mapProviderStatus` | Pre-existing; unchanged file; unresolved. |
| 6 | `src/modules/payments/paymentService.ts` | 24 | TS2345 | `Argument of type 'import("C:/Users/rohan/Downloads/q-commerce-backend-architect/QCOM/backend/src/modules/payments/paymentProvider").PaymentProvider' is not assignable to parameter of type 'import("C:/Users/rohan/Downloads/q-commerce-backend-architect/QCOM/backend/src/modules/payments/provider/PaymentProvider").PaymentProvider'.` | Pre-existing provider-contract mismatch; unchanged file; unresolved. |
| 7 | `src/modules/payments/paymentService.ts` | 29 | TS2739 | `Type 'import("C:/Users/rohan/Downloads/q-commerce-backend-architect/QCOM/backend/src/modules/payments/provider/PaymentProvider").PaymentProvider' is missing the following properties from type 'import("C:/Users/rohan/Downloads/q-commerce-backend-architect/QCOM/backend/src/modules/payments/paymentProvider").PaymentProvider': mode, createOrder, verifyPaymentSignature, mapProviderStatus` | Pre-existing; unchanged file; unresolved. |
| 8 | `src/modules/payments/paymentService.ts` | 716 | TS2322 | `Type '{ receipt: { id: any; orderId: any; transactionId: any; amount: number; status: any; signature: any; verifiedAt: any; }; order: any; isDuplicate: boolean; isReconciliationRequired?: undefined; status?: undefined; needsRefund?: undefined; authoritativeAmount?: undefined; } \| { ...; } \| { ...; }' is not assignable to type '{ receipt: PaymentReceipt; order: any; isDuplicate?: boolean \| undefined; isReconciliationRequired?: boolean \| undefined; status?: string \| undefined; }'.` | Pre-existing webhook result typing mismatch; unchanged file; unresolved. |
| 9 | `src/modules/payments/paymentService.ts` | 770 | TS2322 | `Type 'string | undefined' is not assignable to type 'string'.` | Pre-existing optional webhook signature mismatch; unchanged file; unresolved. |
| 10 | `src/modules/payments/provider/DisabledPaymentProvider.ts` | 26 | TS2420 | `Class 'DisabledPaymentProvider' incorrectly implements interface 'PaymentProvider'.` | Pre-existing provider-interface mismatch; unchanged file; unresolved. |
| 11 | `src/modules/payments/provider/paymentProviderRegistry.ts` | 31 | TS2741 | `Property 'normalizeError' is missing in type 'DisabledPaymentProvider' but required in type 'PaymentProvider'.` | Pre-existing provider-interface mismatch; unchanged file; unresolved. |
| 12 | `src/routes/partnerCompatibilityRoutes.ts` | 4 | TS2307 | `Cannot find module '../modules/delivery/deliveryTaskService.js' or its corresponding type declarations.` | Pre-existing unused/missing module import; unchanged file; unresolved. |
| 13 | `tests/sprint12-5-recovery-concurrency-and-provider-neutrality.test.ts` | 68 | TS2353 | `workerId` does not exist in type `RecoveryWorkerOptions`. | Pre-existing test/API drift; unchanged file; unresolved. |
| 14 | `tests/sprint12-5-recovery-concurrency-and-provider-neutrality.test.ts` | 118 | TS2353 | `workerId` does not exist in type `RecoveryWorkerOptions`. | Pre-existing test/API drift; unchanged file; unresolved. |
| 15 | `tests/sprint12-5-recovery-concurrency-and-provider-neutrality.test.ts` | 126 | TS2353 | `workerId` does not exist in type `RecoveryWorkerOptions`. | Pre-existing test/API drift; unchanged file; unresolved. |
| 16 | `tests/sprint12-5-recovery-concurrency-and-provider-neutrality.test.ts` | 156 | TS2353 | `workerId` does not exist in type `RecoveryWorkerOptions`. | Pre-existing test/API drift; unchanged file; unresolved. |
| 17 | `tests/sprint12-5-recovery-concurrency-and-provider-neutrality.test.ts` | 157 | TS2353 | `workerId` does not exist in type `RecoveryWorkerOptions`. | Pre-existing test/API drift; unchanged file; unresolved. |
| 18 | `tests/sprint12-5-recovery-concurrency-and-provider-neutrality.test.ts` | 202 | TS2353 | `workerId` does not exist in type `RecoveryWorkerOptions`. | Pre-existing test/API drift; unchanged file; unresolved. |
| 19 | `tests/sprint12-5-recovery-concurrency-and-provider-neutrality.test.ts` | 203 | TS2353 | `workerId` does not exist in type `RecoveryWorkerOptions`. | Pre-existing test/API drift; unchanged file; unresolved. |
| 20 | `tests/sprint12-5-recovery-concurrency-and-provider-neutrality.test.ts` | 325 | TS2345 | `MockPaymentProvider` is not assignable to `PaymentProvider`. | Pre-existing provider-contract mismatch; unchanged file; unresolved. |
| 21 | `tests/sprint12-payment-provider-agnostic.test.ts` | 264 | TS2554 | `Expected 0-1 arguments, but got 2.` | Pre-existing test/API drift; unchanged file; unresolved. |
| 22 | `tests/sprint12-payment-provider-agnostic.test.ts` | 445 | TS2554 | `Expected 0-1 arguments, but got 2.` | Pre-existing test/API drift; unchanged file; unresolved. |
| 23 | `tests/sprint12-payment-provider-agnostic.test.ts` | 485 | TS2554 | `Expected 0-1 arguments, but got 2.` | Pre-existing test/API drift; unchanged file; unresolved. |
| 24 | `tests/sprint12-payment-provider-agnostic.test.ts` | 535 | TS2554 | `Expected 0-1 arguments, but got 2.` | Pre-existing test/API drift; unchanged file; unresolved. |
| 25 | `tests/sprint12-payment-provider-agnostic.test.ts` | 622 | TS2554 | `Expected 0-1 arguments, but got 2.` | Pre-existing test/API drift; unchanged file; unresolved. |
| 26 | `tests/sprint13-1-production-security-and-recovery.test.ts` | 447 | TS2353 | `workerId` does not exist in type `RecoveryWorkerOptions`. | Pre-existing test/API drift; unchanged file; unresolved. |
| 27 | `tests/sprint13-1-production-security-and-recovery.test.ts` | 723 | TS2353 | `workerId` does not exist in type `RecoveryWorkerOptions`. | Pre-existing test/API drift; unchanged file; unresolved. |
| 28 | `tests/sprint13-cross-panel-integration.test.ts` | 798 | TS2353 | `workerId` does not exist in type `RecoveryWorkerOptions`. | Pre-existing test/API drift; unchanged file; unresolved. |
| 29 | `tests/sprint13-cross-panel-integration.test.ts` | 804 | TS2353 | `workerId` does not exist in type `RecoveryWorkerOptions`. | Pre-existing test/API drift; unchanged file; unresolved. |
| 30 | `tests/sprint14-1-real-postgresql16.test.ts` | 13 | TS2307 | `Cannot find module '../src/config/production-security.js' or its corresponding type declarations.` | Pre-existing test import drift; unchanged file; unresolved. |
| 31 | `tests/sprint14-3-staging-release-candidate.test.ts` | 137 | TS2561 | Property `role` does not exist in the token payload type; compiler suggests `roles`. | Pre-existing test/API drift; unchanged file; unresolved. |

### Real-service availability and integration evidence

The local availability checks found no listener on `127.0.0.1:5432` or `127.0.0.1:6379`; `docker`, `podman`, `postgres`/`pg_ctl`/`psql`, `redis-server`/`redis-cli` were unavailable, and WSL is not installed. No service was installed or production configuration changed.

- **PostgreSQL 16:** Not available. The full suite explicitly logged the Sprint 14.1 and 14.2 `pg-mem` fallbacks and Sprint 14.3's offline fallback. Fresh migration and idempotent rerun passed in `pg-mem`. A separate upgrade simulation applied migrations 001–024, inserted an existing `PENDING` outbox row, then applied 025 and confirmed the row survived with nullable lease fields. This is not real PostgreSQL evidence.
- **Outbox concurrency/fencing:** `pg-mem` test runs observed one claim from concurrent calls, expired-claim reclaim with a new token, rejection of a stale token, retry after an ambiguous handler outcome, and duplicate invocation after an accelerated lease overrun. No independent PostgreSQL connections/processes, actual five-minute wait, process crash/restart, or production index-catalog verification occurred.
- **Delivery contract:** At-least-once only. Ambiguous handler outcomes and a handler that outlives its lease can cause duplicate execution. Consumers must be idempotent. Lease renewal/deadline enforcement remains future design work; no exactly-once claim is made.
- **Redis 7:** Not available. The Lua script was not executed by Redis. Focused limiter tests used the in-memory/test evaluator and injected failures; they cover middleware limit headers, 429/Retry-After presence, sensitive-route 503, general-route fail-open status, and shared-key concurrency only within the test process. Two independent backend instances, Redis loss/recovery, actual Redis `Retry-After` timing, and trusted-ingress CIDR behavior remain unverified. Forwarded-header default-untrusted behavior was covered by the registered suite.

### Final focused validation and financial regression coverage

| Check | Result and actual service |
|---|---|
| `npm.cmd run build --prefix QCOM\backend -- --pretty false` | **FAIL**, 31 listed diagnostics; no Sprint 14.8 file diagnostics. |
| `npm.cmd run test:backend` | **PASS**, all registered suites in 37.78 seconds. Database-backed suites used `pg-mem`; Redis-dependent behavior used the test/in-memory fallback. |
| Focused `runSprint14_7AuthenticationSecurityTests()` | **PASS**; Express endpoints with `pg-mem`, covering both routes and session revocation. |
| Focused `runSprint8RealtimeNotificationsTests()` | **PASS**; `pg-mem`, including lease expiry/reclaim, ambiguous retries, and over-lease duplicate delivery. |
| Focused `testMiddleware()` | **PASS**; in-memory rate evaluator and injected Redis failures; no Redis server. |
| Focused `testMigrations()` | **PASS**; `pg-mem`, all 25 migrations and idempotent rerun. |
| Migration 025 upgrade simulation | **PASS in `pg-mem` only**; existing pending row preserved from the pre-025 state. |
| `git diff --check` | Only the pre-existing trailing blank line in `vite.config.ts`; no whitespace issue in closure edits. |

The complete backend suite also passed its payment webhook/idempotency and concurrent webhook coverage, late payment/recovery, cancellations/inventory restoration, settlement/ledger balance checks, outbox retry/replay, and database-unavailability/recovery tests. They used the test database and do not establish PostgreSQL 16 financial behavior.

### Files changed during this closure

- `QCOM/backend/src/modules/auth/authService.ts`
- `QCOM/backend/src/routes/authRoutes.ts`
- `QCOM/backend/tests/sprint14-7-authentication-and-credential-security.test.ts`
- `QCOM/backend/tests/sprint8-realtime-notifications.test.ts`
- `QCOM/backend/API.md`
- `QCOM/backend/SPRINT_14_8_PRODUCTION_RESILIENCE_AND_CAPACITY_REPORT.md`

The staged lowercase `auth.md` was restored to its staged worktree content and left unchanged; current-password documentation is recorded in `API.md` and this report. The rest of the unstaged Sprint 14.8 implementation/documentation and the pre-existing user edits remain untouched by this closure.

### Final Git state

- Branch: `main`, tracking `origin/main`.
- `HEAD`: `86669616c5cfbd4adbdb1ad18803fd00f91e680e`.
- Staged diff remains the pre-existing five lowercase documentation paths (`api.md`, `architecture.md`, `auth.md`, `database.md`, `testing.md`): 284 insertions / 697 deletions. No staging operation was performed.
- Unstaged diff contains the Sprint 14.8 implementation, closure changes, and the pre-existing `vite.config.ts` edit. The report and migration 025 remain untracked as deliverables.
- No commit or push was made.
