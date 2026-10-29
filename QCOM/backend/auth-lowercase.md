# QCOM Authentication, Authorization & Security Architecture (AUTH)

**Compliance Standard:** High-Security Zero-Trust Architecture  
**Verification Decision:** `SECURITY GATE PASSED WITH EVIDENCE` (Sprint 14.7)  
**Last Audit:** Sprint 14.7 Credential Security & Password Hardening

---

## 1. Authentication Mechanisms by Application

| Application | Auth Workflow | Credential Storage & Transit | Session Strategy |
| :--- | :--- | :--- | :--- |
| **Customer App** | 6-digit numeric OTP via `/api/auth/request-otp` & `/api/auth/verify-otp` | Secure Bearer JWT in memory or HttpOnly cookie | PostgreSQL-backed UUIDv4 session with idle/absolute TTL |
| **Seller Portal** | Merchant admin phone OTP with store role validation | Role-scoped Bearer JWT with `merchant_id` claim | Distributed Redis/PostgreSQL session tracking |
| **Delivery App** | Rider phone OTP with duty status binding | Mobile device secure keystore/bearer token | Device-bound session with token rotation |
| **Admin Portal** | Employee code + Scrypt password / multi-factor OTP | Restricted session with idle/absolute expiration | Strict 15-min lockout after 5 failed attempts |

---

## 2. Password Security & Scrypt Hashing Architecture (Sprint 14.7)

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
- **Constant-Time Verification:** Hash comparison employs `crypto.timingSafeEqual` with length-normalized buffers to eliminate timing side-channel attacks.
- **Opportunistic Rehashing:** The verification engine checks for legacy hashes (PBKDF2/Argon2/bcrypt) and returns `{ verified: true, needsRehash: true }`, automatically upgrading legacy credentials to Scrypt upon legitimate authentication.
- **Account Lockout:** 5 consecutive failed password attempts trigger an automated 15-minute account lockout recorded in `users.password_locked_until`.
- **Immediate Session Revocation on Password Change:** Updating or resetting a password via `/api/auth/admin/set-password` immediately terminates all active sessions (`auth_sessions.status = 'REVOKED'`) for that user across all cluster instances.

---

## 3. Cryptographic OTP Generation & Lifecycle (Sprint 14.7)

- **Uniform Numeric Generation:** 6-digit OTPs are generated via `crypto.randomInt(100000, 1000000)` to guarantee uniform distribution with zero modulo bias.
- **Per-Challenge Cryptographic Salt:** Every OTP challenge is assigned a 16-byte unique cryptographic salt (`otp_challenges.salt` added via migration 024) and HMAC-SHA256 hashed:
  `HMAC-SHA256(salt, phone:otp:purpose)`
- **Atomic Concurrency Protection:** OTP verification queries the challenge with `FOR UPDATE` row-locking, verifying `is_consumed = FALSE` and atomically marking `is_consumed = TRUE` in the same transaction, preventing race-condition replays.
- **Resend Cooldown & Expiry:** 30-second resend cooldown (`resend_available_at`) and 5-minute absolute TTL (`expires_at`).
- **Audit Logging:** Every OTP request, verification success, and verification failure is recorded in `audit_events` with IP, timestamp, and actor ID. Raw OTPs are never written to logs or audit records.

---

## 4. Session Lifecycle & Token Management

- **Cryptographic Session IDs:** UUIDv4 identifiers stored authoritatively in PostgreSQL `auth_sessions`.
- **JWT Architecture:** Short-lived access tokens signed using HMAC-SHA256 (`JWT_ACCESS_SECRET` >= 32 chars).
- **Active Server-Side Revocation:** Calling `POST /api/auth/logout` sets `auth_sessions.status = 'REVOKED'`. All subsequent requests with the associated JWT are rejected immediately by database validation middleware across all instances.
- **Distributed Session Sync:** Multi-instance deployments query PostgreSQL session status, ensuring instant cross-instance session termination.

---

## 5. IDOR & Tenant Isolation Safeguards

1. **Customer Isolation:** Customers can only inspect and cancel their own orders. Requests for foreign `order_id`s return `HTTP 403 Forbidden`.
2. **Merchant Tenant Isolation:** Merchants can only access inventory and catalog items belonging to their assigned `merchant_id`. Cross-tenant reads/writes are blocked.
3. **Delivery Partner Isolation:** Riders can only modify trips actively assigned to their authenticated rider principal.
4. **WebSocket Channel Authorization:** Private channels (e.g., `order:<orderId>`) verify subscriber ownership before admitting the client to the broadcast room.
