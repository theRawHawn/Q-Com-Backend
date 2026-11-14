# QCOM Automated Testing Architecture & Suite Guide (TESTING)

**Test Framework:** Node.js Native Test Runner / `tsx` Execution  
**Current Test Coverage:** 54 Comprehensive Test Suites (100% Pass Rate)  
**Required Real Services:** PostgreSQL 16 (`16.x`) & Redis **7.0.15** (`redis:7.0.15-alpine`)  

---

## 1. Preflight Service & Version Requirements

Integration tests execute against real PostgreSQL 16 and Redis **7.0.15** (`FORCE_REDIS=1`)—no in-memory SQL or Redis mocks are substituted for integration suites.

Before running `tests/run-all-tests.ts`, a mandatory preflight check (`verifyRedisExactVersion()` in `scripts/verify-redis-version.ts`) runs `INFO server` against `REDIS_URL` and asserts exact `redis_version:7.0.15`:
- If Redis is unreachable or reports any version other than `7.0.15` (or if `EXPECTED_REDIS_VERSION` conflicts with `7.0.15`), the test runner aborts immediately with exit code `1` and displays expected (`7.0.15`), actual version, and remediation commands.
- You can run the Redis preflight check independently:
  ```bash
  npm --prefix QCOM/backend run verify:redis
  ```

---

## 2. Test Commands

- **Run Complete Master Test Battery (from `QCOM/backend`):**
  ```bash
  npm test
  ```

- **Run Real-Service Integration Harness (isolated disposable PG 16 DB + Redis 7.0.15):**
  ```bash
  npm --prefix QCOM/backend run test:integration:real-services
  ```

- **Run an Individual Test Suite:**
  ```bash
  npx tsx QCOM/backend/tests/<test-suite-name>.test.ts
  ```

---

## 3. Test Battery Organization & Suite Matrix (54 Suites)

| Milestone / Sprint | Suite File | Scope Covered |
| :--- | :--- | :--- |
| **Foundations** | `migrations.test.ts`, `seeds.test.ts`, `constraints.test.ts`, `middleware.test.ts`, `redis-cache.test.ts`, `app-health.test.ts` | Schema integrity, foreign keys, seed data, Redis cache, health |
| **Security & Auth** | `auth-rbac.test.ts`, `jwt-security.test.ts`, `auth-remediation.test.ts` | Token lifecycle, RBAC enforcement, session security |
| **Domain Models** | `idor-resource.test.ts`, `pricing-tax.test.ts`, `business-model.test.ts` | Object-level authorization, Indian GST rules |
| **Domain & Dispatch** | `sprint4-migration.test.ts`, `sprint5-dispatch.test.ts`, `sprint8-realtime-notifications.test.ts`, `sprint9-returns-cancellations.test.ts` | Consolidated schema, rider assignment, WebSocket room subscriptions, returns |
| **Payments & Ledgers** | `sprint6-payments.test.ts`, `sprint7-settlements.test.ts` | Payment state machine, double-entry trial balance |
| **Cache & Overload Resilience** | `sprint9-1-bloom-resilience.test.ts`, `sprint9-1-remediation.test.ts`, `sprint9-2-subscriber-cache-resilience.test.ts` | Bloom filter, subscriber lifecycle, cache stampede protection |
| **Financial Recovery** | `sprint10-1a-decoupling.test.ts`, `sprint10-1c-recovery-webhooks.test.ts` | Recovery worker, webhook HMAC, outbox idempotency |
| **Inventory Integrity** | `sprint11-5-inventory-remediation.test.ts`, `sprint11-6-payment-inventory-remediation.test.ts`, `sprint11-7-selective-reservations-and-stock-alerts.test.ts`, `sprint11-8-concurrency-and-integrity.test.ts` | Concurrency contention, zero-oversell, cancellation |
| **Payment Neutrality** | `sprint12-payment-provider-agnostic.test.ts`, `sprint12-5-recovery-concurrency-and-provider-neutrality.test.ts` | Mock sandbox provider, recovery leases, state reconciliation |
| **Cross-Panel Orchestration**| `sprint13-cross-panel-integration.test.ts`, `sprint13-1-production-security-and-recovery.test.ts` | End-to-end multi-role workflows across all 4 apps |
| **PostgreSQL 16 Staging**| `four-app-compatibility.test.ts`, `sprint14-staging-validation.test.ts`, `sprint14-1-real-postgresql16.test.ts`, `sprint14-2-workflow-closure.test.ts`, `sprint14-3-staging-release-candidate.test.ts` | Real PostgreSQL 16 verification, advisory locks, release candidate |
| **Security & Scale Gates** | `sprint14-4-auth-idor-security-gate.test.ts`, `sprint14-5-payment-idempotency-and-integrity.test.ts`, `sprint14-6-scalability-and-multi-instance.test.ts`, `sprint14-7-authentication-and-credential-security.test.ts` | IDOR protection, WebSocket auth, multi-instance safety, password hashing |
| **Payment Integrity Audits** | `sprint15-1-payment-idempotency-and-integrity.test.ts` through `sprint15-1-8-build-failure-and-refund-integrity.test.ts` (8 suites) | Duplicate webhooks, transaction rollback, lease reclamation, refund integrity |
| **Capacity & Real DB Concurrency** | `sprint15-2-capacity-concurrency-and-resilience.test.ts`, `sprint15-2-1-concurrency-authorization-and-resilience.test.ts`, `sprint15-2-2-real-database-concurrency-and-sync.test.ts` | High-concurrency contention, RBAC, real DB sync |
| **PG 16 & Redis 7.0.15 Closure** | `sprint15-2-3-real-pg16-redis7-infrastructure.test.ts`, `sprint15-2-4-inventory-lifecycle-and-financial-integrity.test.ts`, `sprint15-2-5-git-sync-and-financial-integrity-closure.test.ts` | Exact Redis `7.0.15` & PG 16 verification, full inventory & ledger lifecycle |

---

## 4. Test Isolation & Database Fixtures

- Test suites execute against real PostgreSQL 16 (`qcom_test` or isolated schemas/databases) and real Redis **7.0.15**.
- Migrations `001`–`026` are applied in order using PostgreSQL advisory locks (`pg_advisory_lock`).
- Fixtures and initial seeds (`runSeeds()`) establish baseline roles, permissions, chart of accounts, statutory tax rules, and test merchants.
- GitHub Actions CI (`.github/workflows/ci.yml`) provisions `postgres:16` and `redis:7.0.15-alpine`, runs `verify-redis-version.ts`, applies migrations `001`–`026`, runs `seed.ts`, and executes all 54 backend test suites plus `tsc --noEmit`.
