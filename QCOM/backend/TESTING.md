# QCOM Automated Testing Architecture & Suite Guide (TESTING)

**Test Framework:** Node.js Native Test Runner / `tsx` Execution  
**Current Test Coverage:** 37+ Comprehensive Test Suites (100% Pass Rate)  
**Execution Runtime:** ~20–22 seconds for complete test battery  

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

---

## 3. Test Isolation & Database Fixtures

- Every test suite initializes an isolated PostgreSQL test database instance via `createTestDatabase()` (`tests/helpers/testDb.js`).
- Migrations 001–023 are run fresh using advisory locks.
- Fixtures and initial seeds (`runSeeds()`) establish baseline roles, permissions, chart of accounts, statutory tax rules, and test merchants.
