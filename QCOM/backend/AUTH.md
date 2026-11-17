# QCOM Authentication, Authorization & Security Architecture (AUTH)

**Compliance Standard:** High-Security Zero-Trust Architecture  
**Verification Decision:** `HARDENED & VERIFIED LOCALLY AGAINST PG16 + REDIS 7.0.15` (Sprint 15.4)  
**Last Audit:** Sprint 15.4 Production-Grade Security & Access-Control Hardening

---

## 1. Authentication Mechanisms by Application

| Application | Auth Workflow | Credential Storage & Transit | Session Strategy |
| :--- | :--- | :--- | :--- |
| **Customer App** | 6-digit numeric OTP via `/api/auth/request-otp` & `/api/auth/verify-otp` | Bearer JWT + refresh token rotation | PostgreSQL `auth_sessions` (`token_version`) with idle/absolute TTL |
| **Seller Portal** | Merchant staff phone OTP with `store_staff` role validation | Role-scoped Bearer JWT with `merchantIds` claim | Distributed PostgreSQL session + cross-instance Redis revocation |
| **Delivery App** | Rider phone OTP bound to `riders.id` | Mobile Bearer JWT + refresh rotation | Rider-bound session with WebSocket/HTTP revocation sync |
| **Admin Portal** | Employee code (`^[A-Z0-9_-]{3,32}$`) + mandatory Scrypt password via `/api/auth/admin/login` | Signed Bearer JWT (legacy `x-admin-role`/`x-admin-id` headers deprecated & ignored) | Strict 15-min lockout after 5 failed attempts; immediate HTTP+Refresh+WS revocation on password change or suspension |

---

## 2. Password Security & Scrypt Hashing Architecture (Sprint 14.7 & 15.4)

- **Standard Crypt Format:** Passwords are never stored in plaintext. Administrative and staff passwords use memory-hard **Scrypt** formatted in modular crypt strings:
  `$scrypt$N=16384,r=8,p=1$<16-byte-salt-hex>$<64-byte-derived-key-hex>`
- **Cost Parameters:**
  - `N`: 16,384 (2^14 CPU/memory cost)
  - `r`: 8 (block size)
  - `p`: 1 (parallelization parameter)
  - `keylen`: 64 bytes (512 bits)
  - `maxmem`: 64 MB
- **DoS Bounds & Policy:**
  - Minimum length: 8 characters
  - Maximum length: 128 characters (strictly rejects excessively long inputs to prevent algorithmic CPU denial-of-service)
- **Constant-Time Verification:** Hash comparison employs `crypto.timingSafeEqual` with length-normalized buffers, plus constant-work dummy Scrypt verification when a login targets a missing account.
- **Opportunistic Rehashing:** The verification engine checks for legacy hashes (PBKDF2/Argon2/bcrypt) and returns `{ verified: true, needsRehash: true }`, automatically upgrading legacy credentials to Scrypt upon legitimate authentication.
- **No Auto-Provisioning or Partial Match:** `adminLogin` uses exact case-insensitive email match (`LOWER(u.email) = LOWER($1)`), never `ILIKE` wildcards, and requires an active admin role and stored `password_hash`.
- **Account Lockout:** 5 consecutive failed password attempts trigger an automated 15-minute account lockout recorded in `users.password_locked_until` and audited as `ADMIN_LOGIN_FAILED`.
- **Immediate Session Revocation on Password Change:** Updating or setting a password via `/api/auth/admin/set-password` or `/api/auth/admin/change-password` immediately terminates all active `auth_sessions`, revokes all `refresh_tokens`, and broadcasts `USER_LOGOUT_ALL` over Redis Pub/Sub (`qcom:ws:broadcast`) to sever active WebSockets.

---

## 3. Cryptographic OTP Generation & Lifecycle (Sprint 14.7 & 15.4)

- **Uniform Numeric Generation:** 6-digit OTPs are generated via `crypto.randomInt(100000, 1000000)` to guarantee uniform distribution with zero modulo bias.
- **Per-Challenge Cryptographic Salt:** Every OTP challenge is assigned a 16-byte unique cryptographic salt (`otp_challenges.salt` added via migration 024) and HMAC-SHA256 hashed:
  `HMAC-SHA256(salt, phone:otp:purpose)`
- **Atomic Concurrency Protection:** `verifyOtp` executes inside a PostgreSQL transaction (`FOR UPDATE` lock on `otp_challenges`), atomically committing `attempt_count + 1` on failed attempts before throwing `Invalid OTP`, and marking `is_consumed = TRUE` once on valid verification.
- **Resend Cooldown & Expiry:** 30-second resend cooldown (`resend_available_at`) and 5-minute absolute TTL (`expires_at`).
- **Audit Logging:** Every OTP request, verification success, and verification failure is recorded in `audit_logs` with IP, timestamp, and actor ID. Sensitive fields (`password_hash`, `refresh_token`, `session_token`, `salt`, `api_key`, `signature`) are automatically redacted.

---

## 4. Session Lifecycle, `token_version` & Token Management

- **Cryptographic Session IDs:** UUIDv4 identifiers stored authoritatively in PostgreSQL `auth_sessions`.
- **JWT Architecture:** Short-lived access tokens signed using HMAC-SHA256 (`JWT_ACCESS_SECRET` or `JWT_SECRET` alias >= 32 chars in production), embedding `sessionId` and `token_version`.
- **Session Version Enforcement:** Both `authenticate` HTTP middleware and WebSocket upgrade authentication verify `payload.token_version === session.token_version`, returning `401 SESSION_REVOKED` on mismatch. Refresh rotation preserves `auth_sessions.token_version`.
- **Active Server-Side Revocation:** Logout, password changes, user suspension (`PATCH /api/admin/customers/:id/status`), and admin session reset (`POST /api/admin/customers/:id/reset-session`) revoke both `auth_sessions` and `refresh_tokens` and emit cross-instance WebSocket disconnect events via Redis.

---

## 5. IDOR, RBAC & Tenant Isolation Safeguards

1. **Customer Isolation:** Customers can only inspect, cancel, invoice-download, reconcile, or request returns for their own orders (`requireOrderOwnership`). Requests for foreign `order_id`s return `HTTP 403 Forbidden`.
2. **Merchant Tenant Isolation:** `SELLER` accounts are restricted to their assigned `merchant_id`s on order reads, store geofencing, settlement previews, and return workflows (forged `body.merchantId` values are rejected with `403` and audited).
3. **Delivery Partner Isolation & Delivery OTP Integrity:** Riders can only accept, update, confirm pickup, verify delivery OTP, remit COD, expire offers, or emit telemetry for their own authenticated rider profile / assigned trip (`403 RIDER_ACCESS_DENIED`). Hardcoded delivery OTP bypasses (`1234`, `123456`, suffix matching) are removed; exact-length `constantTimeCompare` and `409` replay rejection are enforced.
4. **RBAC Privilege Escalation Protection:** Non-`SUPER_ADMIN` actors cannot create or modify protected admin roles (`SUPER_ADMIN`, `ADMIN`, `FINANCE_ADMIN`, `OPERATIONS`, `SYSTEM`) or assign roles to themselves (`403 PRIVILEGE_ESCALATION_DENIED` + `PRIVILEGE_ESCALATION_BLOCKED` audit).
5. **WebSocket Channel Authorization:** Private channels (`order:<orderId>`, `merchant:<merchantId>`, `rider:<riderId>`) verify subscriber ownership and `token_version` before admitting the client.
6. **Documentation Link:** See [SECURITY.md](./SECURITY.md) for the full defense-in-depth matrix.

