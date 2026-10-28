# QCOM Authentication, Authorization & Security Architecture (AUTH)

**Compliance Standard:** High-Security Zero-Trust Architecture  
**Verification Decision:** `SECURITY GATE PASSED WITH EVIDENCE` (Sprint 14.4)  

---

## 1. Authentication Mechanisms by Application

| Application | Auth Workflow | Credential Storage & Transit |
| :--- | :--- | :--- |
| **Customer App** | 6-digit numeric OTP via `/api/auth/request-otp` & `/api/auth/verify-otp` | Secure Bearer JWT in memory or HttpOnly cookie |
| **Seller Portal** | Merchant admin phone OTP with store role validation | Role-scoped Bearer JWT with `merchant_id` claim |
| **Delivery App** | Rider phone OTP with duty status binding | Mobile device secure keystore/bearer token |
| **Admin Portal** | Multi-factor / privileged OTP with permission allowlists | Restricted session with idle/absolute expiration |

---

## 2. Password Hashing & OTP Security

- **No Plaintext Passwords:** QCOM uses phone-based OTP authentication for operational simplicity and speed. Any administrative accounts requiring password authentication are protected via high-cost Argon2id or salted bcrypt algorithms.
- **Cryptographic OTP Generation:** Generated using `crypto.randomInt(100000, 999999)`.
- **Brute-Force & Flooding Defense:** Sliding-window rate-limiting (maximum 3 OTP requests per 10 minutes) with a 30-second resend cooldown.
- **Strict Expiry & Invalidation:** OTPs expire in 5 minutes (`env.OTP_TTL_MINUTES`) and are invalidated upon successful verification.

---

## 3. Session Lifecycle & Token Management

- **Cryptographic Session IDs:** UUIDv4 identifiers stored in PostgreSQL `auth_sessions`.
- **JWT Architecture:** Short-lived access tokens signed using HMAC-SHA256 (`JWT_ACCESS_SECRET` >= 32 chars).
- **Active Server-Side Revocation:** Calling `POST /api/auth/logout` sets `auth_sessions.status = 'REVOKED'`. Subsequent requests with the associated JWT are rejected immediately by database validation middleware.

---

## 4. IDOR & Tenant Isolation Safeguards

1. **Customer Isolation:** Customers can only inspect and cancel their own orders. Requests for foreign `order_id`s return `HTTP 403 Forbidden`.
2. **Merchant Tenant Isolation:** Merchants can only access inventory and catalog items belonging to their assigned `merchant_id`. Cross-tenant reads/writes are blocked.
3. **Delivery Partner Isolation:** Riders can only modify trips actively assigned to their authenticated rider principal.
4. **WebSocket Channel Authorization:** Private channels (e.g., `order:<orderId>`) verify subscriber ownership before admitting the client to the broadcast room.
