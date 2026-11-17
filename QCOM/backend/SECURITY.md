# QCOM Security & Access-Control Architecture (`SECURITY`)

**Last Hardened:** Sprint 15.4 — Production-Grade Security & Access-Control Hardening  
**Scope:** Unified Backend Engine (`QCOM/backend`) serving Customer, Seller, Delivery Partner, and Admin Operations applications.

---

## 1. Defense-in-Depth Trust Boundaries

| Boundary | Enforcement Mechanism | Source |
| :--- | :--- | :--- |
| **Environment & Secrets** | Zod schema with `JWT_SECRET` alias preprocessing + fail-closed `validateProductionSecurity()` | `src/config/env.ts` |
| **Transport & CORS** | Helmet security headers; `CORS_ALLOWED_ORIGINS='*'` disables `Access-Control-Allow-Credentials` (`credentials: false`); explicit allowlists enable credentials | `src/app.ts` |
| **Proxy IP Resolution** | Exact IP and CIDR matching (`TRUST_PROXY_CIDRS`) on HTTP and WebSocket upgrades; arbitrary `X-Forwarded-For` ignored | `src/utils/network.ts`, `src/modules/realtime/websocketServer.ts` |
| **Authentication & Session Version** | Bearer JWT HS256 (`JWT_ACCESS_SECRET`), live `auth_sessions` lookup, `is_suspended = FALSE`, and `token_version` equality across HTTP and WebSocket | `src/middleware/auth.ts`, `src/modules/realtime/websocketServer.ts` |
| **Cross-Instance Revocation** | PostgreSQL `auth_sessions` + `refresh_tokens` revocation synced across nodes via Redis `qcom:ws:broadcast` `SESSION_REVOKED` / `USER_LOGOUT_ALL` | `src/modules/auth/authService.ts`, `src/modules/realtime/websocketServer.ts` |
| **Rate Limiting** | Redis-backed sliding-window limiters (`otpRateLimiter`, `authRateLimiter`, `checkoutRateLimiter`, `paymentInitiationRateLimiter`, `paymentWebhookRateLimiter`, `adminSensitiveRateLimiter`, `riderTelemetryRateLimiter`) | `src/middleware/rateLimiter.ts` |
| **Audit Redaction** | Automatic scrubbing of `password_hash`, `salt`, `access_token`, `refresh_token`, `session_token`, `api_key`, `private_key`, `signature`, `otp`, and `secret` keys before persistence | `src/modules/audit/auditService.ts` |

---

## 2. Authentication & Credential Hardening

### 2.1 Admin Authentication
- **Mandatory Password + Exact Lookup:** `POST /api/auth/admin/login` and `POST /api/admin/auth/login` validate `employeeCode` against `^[A-Z0-9_-]{3,32}$`, query strictly via `LOWER(email) = LOWER($1)` (wildcard `ILIKE` matching and silent user auto-provisioning removed), verify Scrypt `password_hash`, and perform constant-work dummy Scrypt verification when accounts do not exist or lack credentials.
- **Brute-Force Lockout:** 5 consecutive invalid attempts lock the account for 15 minutes (`users.password_locked_until`) and emit `ADMIN_LOGIN_FAILED` audit records.
- **Password Rotation Revocation:** `set-password` and `change-password` revoke all active `auth_sessions`, revoke all active `refresh_tokens`, and publish `USER_LOGOUT_ALL` to close live WebSocket connections.

### 2.2 Per-Challenge Salted OTP & Single-Use Concurrency
- `requestOtp` generates a uniform 6-digit code (`crypto.randomInt`) hashed with a unique 16-byte per-challenge `salt`.
- `verifyOtp` executes inside a PostgreSQL transaction with `FOR UPDATE` row locking on `otp_challenges`. Failed verification atomically commits `attempt_count + 1` and logs `OTP_VERIFICATION_FAILED` before returning error `400`. Valid verification marks `is_consumed = TRUE` once, preventing concurrent races or replays.

### 2.3 Refresh Token Family & `token_version` Preservation
- Refresh tokens execute single-use family rotation inside PostgreSQL transactions (`FOR UPDATE`). Replaying an already-rotated token revokes the entire token family and session (`SESSION_REVOKED`).
- `executeRefreshTokens` preserves the session's `auth_sessions.token_version` in newly minted access JWTs.

---

## 3. Authorization, RBAC & Multi-Tenant IDOR Isolation

- **Header Spoofing Eliminated:** All `/api/admin/*` compatibility endpoints require valid Bearer JWTs and explicit role guards (`ANY_ADMIN_ROLES`, `OPS_ADMIN_ROLES`, `SELLER_OPS_ROLES`, `FINANCE_ROLES`, `AUDIT_VIEW_ROLES`, `PROMO_ROLES`, `SUPER_ADMIN`). Client headers (`x-admin-role`, `x-admin-id`, `x-user-id`) are never trusted.
- **Privilege Escalation Prevention:** Non-`SUPER_ADMIN` actors cannot create, update, delete, or assign `SUPER_ADMIN` / `ADMIN` / `FINANCE_ADMIN` / `OPERATIONS` / `SYSTEM` roles, nor elevate themselves. Blocked attempts return `403 PRIVILEGE_ESCALATION_DENIED` and persist `PRIVILEGE_ESCALATION_BLOCKED`.
- **Customer Isolation:** Customer reads and mutations across `/api/orders/*`, `/api/invoices/order/*`, `/api/orders/:orderId/returns`, `/api/returns/:returnId`, `/api/dispatch/orders/:orderId`, `/api/dispatch/assignments/:assignmentId`, and `/api/payments/reconcile/:orderId` strictly enforce `requireOrderOwnership` / actor checks.
- **Merchant / Seller Isolation:** `SELLER` role no longer bypasses order ownership in `orderService.getOrderById`. Merchant return workflows (`/review`, `/receive`, `/qc-inspect`) ignore forged `req.body.merchantId` and enforce authoritative store staff ownership (`CROSS_MERCHANT_RETURN_MUTATION_BLOCKED` audit on mismatch). Pricing geofence and settlement preview routes enforce merchant ownership.
- **Delivery Partner Isolation & Delivery OTP Integrity:** Partner routes (`/api/partner/duty-status`, `/api/tasks/:id/arrived-pickup`, `/api/tasks/:id/pickup-confirm`, `/api/tasks/:id/verify-otp`) enforce JWT identity and `delivery_trips.rider_id` ownership (`403 RIDER_ACCESS_DENIED`). Hardcoded delivery OTP backdoors (`1234`, `123456`, suffix matching) are removed in favor of exact-length `constantTimeCompare` and `409` replay rejection. Dispatch offer expiry, COD remittance, and routing telemetry enforce rider binding.

---

## 4. Not Implemented (Out of Scope / Absent by Design)
- **Third-Party OAuth / SSO:** OAuth2/OIDC social or enterprise SSO flows are not implemented in QCOM; authentication uses Phone OTP (Customer/Seller/Rider) and Employee Code + Scrypt password (Admin).
