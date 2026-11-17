# Sprint 15.4 — Production-Grade Security & Access-Control Hardening Report

**Project:** QCOM Quick Commerce Platform (`QCOM/backend`)  
**Sprint:** 15.4 — Production-Grade Security & Access-Control Hardening  
**Date:** 2026-11-15  
**Target:** `QCOM/backend` (`customer-app`, `delivery-app`, and `admin-portal` frontends left strictly untouched)

---

## 1. Executive Summary

Sprint 15.4 eliminated critical authentication bypasses, privilege escalation vectors, cross-tenant IDOR vulnerabilities, delivery OTP backdoors, credential hashing flaws, and fail-open production configuration risks across `QCOM/backend`, while aligning all affected regression suites and adding a dedicated 14-section security verification suite (`tests/sprint15-4-security-and-access-control-hardening.test.ts`, registered as Suite #55).

All **55 backend test suites** (`tests/run-all-tests.ts`), **Sprint 15.4's 14 security hardening sections**, and **TypeScript builds** (`npx tsc --noEmit` and `npm --prefix QCOM/backend run build`) passed cleanly against **live PostgreSQL 16.16** and **live Redis 7.0.15**.

---

## 2. Vulnerability Remediation Matrix

| ID | Severity | Vulnerability (Before) | Remediation (After) | Primary Files / Routes |
| :--- | :--- | :--- | :--- | :--- |
| **SEC-01** | **CRITICAL** | Admin login (`POST /api/auth/admin/login`) matched `email ILIKE '%...%'`, auto-provisioned missing accounts in dev, and did not verify `password_hash` when unset or missing. | Enforced `^[A-Z0-9_-]{3,32}$` employee code validation, exact `LOWER(email) = LOWER($1)` lookup, mandatory Scrypt `password_hash` check, constant-work dummy Scrypt verification on unknown users, and 5-attempt / 15-minute lockout (`users.password_locked_until`) with `ADMIN_LOGIN_FAILED` audit logging. | `src/modules/auth/authService.ts`, `seeds/seedData.ts` |
| **SEC-02** | **CRITICAL** | `adminCompatibilityRouter` authenticated callers via spoofable `x-admin-role` / `x-admin-id` headers (`legacyAdminAuthShim`), allowing unauthenticated callers to impersonate `SUPER_ADMIN`. | Removed header-auth shim completely; enforced `authenticate` (Bearer JWT) + strict role checks (`ANY_ADMIN_ROLES`, `OPS_ADMIN_ROLES`, `SELLER_OPS_ROLES`, `FINANCE_ROLES`, `AUDIT_VIEW_ROLES`, `PROMO_ROLES`, `SUPER_ADMIN`) + `adminSensitiveRateLimiter`. | `src/routes/adminCompatibilityRoutes.ts`, `src/middleware/rbac.ts` |
| **SEC-03** | **CRITICAL** | Delivery OTP verification (`verifyDeliveryOtp`) accepted hardcoded backdoors (`1234`, `123456`) and suffix matching, and lacked atomic replay protection. | Removed all hardcoded backdoors and suffix shortcuts; enforced exact-length `constantTimeCompare` against `orders.delivery_otp` and atomic conditional state transition returning `409` on replay. | `src/routes/partnerCompatibilityRoutes.ts` |
| **SEC-04** | **HIGH** | Partner routes (`partnerCompatibilityRoutes.ts`) trusted `req.body.riderId` / unauthenticated context and allowed cross-rider trip state tampering, COD remittance spoofing, and routing telemetry spoofing. | Enforced `authenticate` + `requireRole` + strict `req.auth.riderId` vs `delivery_trips.rider_id` ownership (`403 RIDER_ACCESS_DENIED`), plus pre-validation rider binding on `POST /api/routing/telemetry` and `POST /api/settlements/cod/remit`. | `src/routes/partnerCompatibilityRoutes.ts`, `src/routes/settlementRoutes.ts`, `src/routes/routingRoutes.ts` |
| **SEC-05** | **HIGH** | OTP verification (`requestOtp` / `verifyOtp`) used unsalted hashes and updated `attempt_count` outside rollback boundaries or without row-level locking, enabling concurrent single-use races. | Added per-challenge 16-byte cryptographic salt (`otp_challenges`), transactional `FOR UPDATE` row locking on `verifyOtp`, atomic `attempt_count + 1` commit + `OTP_VERIFICATION_FAILED` audit on wrong code, and single-winner `is_consumed = TRUE` under concurrency. | `src/modules/auth/authService.ts` |
| **SEC-06** | **HIGH** | Refresh token rotation (`executeRefreshTokens`) reset or dropped `auth_sessions.token_version` and lacked strict single-winner locking on concurrent replay. | Locked refresh rows with `FOR UPDATE`, revoked entire token family + session on replay (`SESSION_REVOKED`), preserved `auth_sessions.token_version` in newly minted JWTs, and rejected tokens when `jwt.tokenVersion !== session.token_version` across HTTP & WebSocket. | `src/modules/auth/authService.ts`, `src/middleware/auth.ts`, `src/modules/realtime/websocketServer.ts` |
| **SEC-07** | **HIGH** | Password rotation (`setPassword` / `changePassword`), user suspension, and admin session reset left active JWTs, refresh tokens, and live WebSockets alive. | Atomically revoked all `auth_sessions` and `refresh_tokens` in PostgreSQL, bumped `token_version`, and triggered `realtimeGateway.handleUserLogoutAll(userId)` + Redis `qcom:ws:broadcast` `USER_LOGOUT_ALL` (`code >= 4000`). | `src/modules/auth/authService.ts`, `src/routes/adminCompatibilityRoutes.ts`, `src/modules/realtime/websocketServer.ts` |
| **SEC-08** | **HIGH** | Privilege escalation in RBAC and employee role assignment (`POST /api/admin/rbac/*`, `POST /api/admin/employees/:id/assign-roles`) lacked role-tier restrictions and self-mutation prevention. | Blocked non-`SUPER_ADMIN` actors from creating/modifying/assigning protected system/admin roles (`403 PRIVILEGE_ESCALATION_DENIED`), blocked self-role modification (`403 SELF_ROLE_MUTATION_DENIED`), and audited all blocked attempts as `PRIVILEGE_ESCALATION_BLOCKED`. | `src/modules/rbac/rbacService.ts`, `src/routes/rbacRoutes.ts`, `src/routes/adminCompatibilityRoutes.ts` |
| **SEC-09** | **HIGH** | Cross-customer and cross-merchant IDOR across orders, cancellation, invoices, returns, dispatch, payments, geofencing, and settlement allocation/previews; `SELLER` bypassed `orderService.getOrderById`; forged `req.body.merchantId` on returns was accepted. | Removed `SELLER` blanket bypass; enforced `requireOrderOwnership` across order/invoice/return/dispatch/payment routes (including `POST /api/orders/:orderId/cancel`); checked merchant ownership before payload validation on `/settlement/preview` and `/returns/:returnId/review` & `/qc-inspect`, rejecting forged `body.merchantId` (`403` + `CROSS_MERCHANT_RETURN_MUTATION_BLOCKED`). | `src/middleware/resourceOwnership.ts`, `src/modules/orders/orderService.ts`, `src/routes/orderRoutes.ts`, `src/routes/returnRoutes.ts`, `src/routes/pricingRoutes.ts`, `src/routes/settlementRoutes.ts`, `src/routes/dispatchRoutes.ts`, `src/routes/paymentRoutes.ts`, `src/routes/refundRoutes.ts` |
| **SEC-10** | **MEDIUM** | `CORS_ALLOWED_ORIGINS='*'` emitted `Access-Control-Allow-Credentials: true`; weak secrets or wildcard CORS could start in production; proxy IPs trusted unrestricted `X-Forwarded-For`; audit logs risked persisting sensitive keys. | Disabled `credentials` when origin is `*`; added fail-closed `validateProductionSecurity()` guard; enforced exact/CIDR `TRUST_PROXY_CIDRS` matching; redacted `password_hash`, `salt`, `access_token`, `refresh_token`, `session_token`, `api_key`, `private_key`, `signature`, `otp`, and `secret` in `auditService.ts`. | `src/config/env.ts`, `src/app.ts`, `src/utils/network.ts`, `src/modules/audit/auditService.ts` |
| **SEC-11** | **MEDIUM** | `GET /api/orders/:orderId` / `GET /api/invoices/order/:orderId` had a PostgreSQL deadlock when generating missing invoices recursively inside an uncommitted transaction; `/api/admin/customers` and `/api/admin/refunds` referenced non-existent table/column names; `/catalog/products` admin-gating blocked public storefront reads. | Fixed `invoiceService.getOrCreateOrderInvoices` to commit transaction before returning generated invoices; aligned `/api/admin/customers` and `/api/admin/refunds` SQL to real schema; preserved public storefront `GET /api/catalog/products` (`catalogSearchRateLimiter`) while keeping `GET /api/admin/catalog/products` strictly admin-only. | `src/modules/invoices/invoiceService.ts`, `src/routes/adminCompatibilityRoutes.ts`, `src/app.ts` |

---

## 3. Admin Portal Migration & Deprecation Note

- `QCOM/admin-portal/src/**` (along with `QCOM/customer-app/src/**` and `QCOM/delivery-app/**`) remained **read-only / untouched** in this sprint.
- Because `x-admin-role` and `x-admin-id` headers are no longer accepted by `QCOM/backend`, any Admin Portal client or operator script calling `/api/admin/*` must authenticate via `POST /api/auth/admin/login` (or `POST /api/admin/auth/login`) using employee credentials (`employeeCode` + `password`) and pass `Authorization: Bearer <accessToken>` on subsequent requests.

---

## 4. Verification Breakdown

### A. Implemented
- Full backend security hardening across `src/config/env.ts`, `src/app.ts`, `src/middleware/auth.ts`, `src/middleware/rbac.ts`, `src/middleware/resourceOwnership.ts`, `src/middleware/errorHandler.ts`, `src/modules/audit/auditService.ts`, `src/modules/auth/authService.ts`, `src/modules/rbac/rbacService.ts`, `src/modules/orders/orderService.ts`, `src/modules/invoices/invoiceService.ts`, `src/modules/realtime/websocketServer.ts`, `seeds/seedData.ts`, and routes (`authRoutes.ts`, `rbacRoutes.ts`, `adminCompatibilityRoutes.ts`, `partnerCompatibilityRoutes.ts`, `orderRoutes.ts`, `pricingRoutes.ts`, `settlementRoutes.ts`, `dispatchRoutes.ts`, `paymentRoutes.ts`, `refundRoutes.ts`, `returnRoutes.ts`, `routingRoutes.ts`).
- New 14-section regression test suite `tests/sprint15-4-security-and-access-control-hardening.test.ts` registered in `tests/run-all-tests.ts` (Suite #55), plus 12 existing test suites aligned to real JWT/Scrypt/salted-OTP contracts.
- Updated documentation: `SECURITY.md`, `AUTH.md`, `API.md`, `ARCHITECTURE.md`, `DATABASE.md`, `TESTING.md`, `README.md`, and `.github/workflows/ci.yml` (suite count 54 → 55, preserving PostgreSQL 16 + `redis:7.0.15-alpine`).

### B. Tested Locally (Live PostgreSQL 16.16 & Redis 7.0.15)
All commands below were executed locally in this environment and passed with exit code `0`:
1. `npx --prefix QCOM/backend tsx QCOM/backend/scripts/verify-redis-version.ts`  
   - Verified `redis_version:7.0.15` on `redis://127.0.0.1:6379`.
2. `FORCE_REDIS=1 npx --prefix QCOM/backend tsx QCOM/backend/tests/sprint15-4-security-and-access-control-hardening.test.ts`  
   - **Result:** All **14/14** security & concurrency hardening sections passed against PostgreSQL 16.16 and Redis 7.0.15.
3. `FORCE_REDIS=1 npx --prefix QCOM/backend tsx QCOM/backend/tests/run-all-tests.ts`  
   - **Result:** All **55/55** test suites (Sprint 1 through Sprint 15.4) passed in **60.13s** (`✓ ALL TESTS & FOUR-APPLICATION COMPATIBILITY PASSED in 60.13s!`), including double-entry general ledger balance verification (`17091.92 == 17091.92`) and zero-oversell / idempotency invariants.
4. `npx tsc --noEmit && npm --prefix QCOM/backend run build`  
   - **Result:** 0 TypeScript compilation errors across root and `QCOM/backend`.

### C. Verified in CI
- **None in this session.** `.github/workflows/ci.yml` was updated to reflect all 55 suites while preserving PostgreSQL 16 and `redis:7.0.15-alpine`, but GitHub Actions CI was not executed from this environment.

### D. Not Implemented
- **Third-Party OAuth2 / OIDC / Social SSO:** Intentionally absent; QCOM authenticates customers/sellers/riders via salted Phone OTP and administrators via Employee Code + Scrypt password.
- **Frontend Client Updates:** `QCOM/customer-app/src/**`, `QCOM/delivery-app/**`, and `QCOM/admin-portal/src/**` were kept strictly unmodified per sprint boundary.

### E. Not Independently Verified
- **Git Commit, Push & GitHub Actions Workflow Execution:** No `.git` repository directory or remote GitHub credentials exist in this workspace snapshot; therefore no commits, pushes to `theRawHawn/Q-Com-Backend.git`, or remote CI workflow runs were performed.
- **`npm --prefix QCOM/backend run test:integration:real-services` (`tests/integration/real-services.test.ts`):** Not executed because this test script requires dedicated loopback service instances on ports `55432` (`qcom_it_admin`) and `56379` (separate from the standard `5432`/`6379` services), and contains a legacy migration-count assertion (`applied.length === 25`) from prior to migration `026`. All 26 migrations (`001`–`026`) and live PostgreSQL 16.16 / Redis 7.0.15 integration behaviors were exercised via `run-all-tests.ts`.
