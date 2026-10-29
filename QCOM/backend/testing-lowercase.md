# QCOM Automated Testing Architecture & Suite Guide (TESTING)

**Test Framework:** Node.js Native Test Runner / `tsx` Execution<br>
**Current Test Coverage:** Sprint 14.7 reports 39 passing suites; Sprint 14.8 adds rate-limit regression coverage.
**Execution Runtime:** ~20–22 seconds for complete test battery<br>

---

## 1. Test Commands

- **Run Complete Master Test Battery (Workspace Root):**
  ```bash
  npm run test:backend
  ```

- **Run Complete Master Test Battery (from `QCOM/backend`):**
  ```bash
  npm test
  ```

- **Run an Individual Test Suite:**
  ```bash
  npx tsx QCOM/backend/tests/<test-suite-name>.test.ts
  ```

---

## 2. Test Battery Organization & Suite Matrix

| Milestone / Sprint | Suite File | Scope Covered |
| :--- | :--- | :--- |
| **Foundations** | `migrations.test.ts`, `seeds.test.ts`, `constraints.test.ts` | Schema integrity, foreign keys, and seed data |
| **Security & Auth** | `auth-rbac.test.ts`, `jwt-security.test.ts`, `auth-remediation.test.ts` | Token lifecycle, RBAC enforcement, session security |
| **Domain Models** | `idor-resource.test.ts`, `pricing-tax.test.ts`, `business-model.test.ts` | Object-level authorization, Indian GST rules |
| **Dispatch & Schedulers**| `sprint5-dispatch.test.ts`, `sprint8-realtime-notifications.test.ts` | Rider assignment, WebSocket room subscriptions |
| **Payments & Ledgers** | `sprint6-payments.test.ts`, `sprint7-settlements.test.ts` | Payment state machine, double-entry trial balance |
| **Financial Recovery** | `sprint10-1a-decoupling.test.ts`, `sprint10-1c-recovery-webhooks.test.ts` | Recovery worker, webhook HMAC, outbox idempotency |
| **Inventory Integrity** | `sprint11-5-inventory-remediation.test.ts`, `sprint11-6-payment-inventory-remediation.test.ts`, `sprint11-7-selective-reservations-and-stock-alerts.test.ts`, `sprint11-8-concurrency-and-integrity.test.ts` | Concurrency contention, zero-oversell, cancellation |
| **Payment Neutrality** | `sprint12-payment-provider-agnostic.test.ts`, `sprint12-5-recovery-concurrency-and-provider-neutrality.test.ts` | Mock sandbox provider, recovery leases, state reconciliation |
| **Cross-Panel Orchestration**| `sprint13-cross-panel-integration.test.ts`, `sprint13-1-production-security-and-recovery.test.ts` | End-to-end multi-role workflows across all 4 apps |
| **PostgreSQL 16 Staging**| `four-app-compatibility.test.ts`, `sprint14-staging-validation.test.ts`, `sprint14-1-real-postgresql16.test.ts`, `sprint14-2-workflow-closure.test.ts`, `sprint14-3-staging-release-candidate.test.ts` | Real PostgreSQL 16 verification, advisory locks, release candidate |
| **High-Security Gate** | `sprint14-4-auth-idor-security-gate.test.ts` | IDOR protection, session logout, WebSocket auth |
| **Payment Idempotency**| `sprint14-5-payment-idempotency-and-integrity.test.ts` | Duplicate webhook handling, transaction rollback, failure isolation |
| **Credential Security** | `sprint14-7-authentication-and-credential-security.test.ts` | Password hashing, OTP single-use behavior, session revocation |
| **Resilience Admission** | `middleware.test.ts`, `app-health.test.ts` | Concurrent rate limits, safe limiter outage response, untrusted forwarded-IP rejection |
| **Outbox Fencing** | `sprint8-realtime-notifications.test.ts` | Persisted claims, concurrent claim exclusion, stale-token rejection, durable retry |

---

## 3. Test Isolation & Database Fixtures

- Every test suite initializes an isolated PostgreSQL test database instance via `createTestDatabase()` (`tests/helpers/testDb.js`).
- Migrations 001–025 are run fresh using advisory locks.
- Fixtures and initial seeds (`runSeeds()`) establish baseline roles, permissions, chart of accounts, statutory tax rules, and test merchants.

## 4. Sprint 14.8 Verification Boundaries

- The new deterministic rate-limit tests use the in-memory implementation in test mode; they verify the policy boundary and middleware behavior, not Redis cluster performance.
- The production Redis sliding-window operation is one Lua script so cleanup, count, admission, and insertion are atomic across instances. Validate the script against the deployed Redis 7 topology before release.
- No throughput benchmark is claimed by this sprint. PostgreSQL 16 contention, Redis outage, saturated-pool, and multi-instance tests require isolated services and are not represented by the in-memory tests.
- The outbox lease regression runs on the repository's in-memory test database; it is not evidence of multi-process PostgreSQL locking behavior. Verify the lease migration and simultaneous claims on PostgreSQL 16 before release.
# Real PostgreSQL 16 and Redis 7 integration tests

The standard `npm test` command uses `pg-mem` and mocks for most database/cache tests. It does not prove PostgreSQL or Redis integration behavior. The opt-in `npm run test:integration:real-services` command requires real PostgreSQL 16 and Redis 7 and will fail rather than substitute simulated services.

On a machine with Docker Compose v2, start the isolated, test-only services from the backend directory. These containers bind only to loopback, use no persistent volumes, and do not alter the staging Compose configuration:

```powershell
$env:QCOM_IT_POSTGRES_PASSWORD = [guid]::NewGuid().ToString('N')
$env:QCOM_IT_REDIS_PASSWORD = [guid]::NewGuid().ToString('N')
$itProject = "qcom-sprint1482-$([guid]::NewGuid().ToString('N'))"
docker compose -f docker-compose.integration.yml -p $itProject up -d --wait
$env:QCOM_IT_POSTGRES_URL = "postgresql://qcom_it_admin:$($env:QCOM_IT_POSTGRES_PASSWORD)@127.0.0.1:55432/postgres"
$env:QCOM_IT_REDIS_URL = "redis://:$($env:QCOM_IT_REDIS_PASSWORD)@127.0.0.1:56379/0"
npm run test:integration:real-services
docker compose -f docker-compose.integration.yml -p $itProject down
```

Use newly generated test-only passwords as shown; do not put production credentials in these variables. The runner accepts only loopback PostgreSQL/Redis URLs. PostgreSQL must use the dedicated `qcom_it_admin` account, port `55432`, and the `postgres` maintenance database; Redis must use port `56379`. It creates uniquely named `qcom_it_<random>` databases, applies migrations to disposable databases, then drops only those databases. Redis keys are scoped to a unique run ID and only those exact keys are deleted. The script does not start or stop containers.

The PostgreSQL user must be allowed to create/drop databases. Do not forward these local ports to shared, staging, or production endpoints. A successful harness setup is not test evidence: record actual version output and test results from the runner.
