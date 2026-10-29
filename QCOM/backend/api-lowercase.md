# QCOM REST & Realtime API Contract Specification (API)

**Base URL:** `http://localhost:3000/api` (Production: HTTPS)  
**Realtime WebSocket URL:** `ws://localhost:3000/ws/v1`  
**Authentication Scheme:** Bearer JWT (`Authorization: Bearer <accessToken>`)  

---

## 1. Authentication & Session Endpoints (`/api/auth`)

| Path | Method | Auth Required | Description |
| :--- | :--- | :--- | :--- |
| `/request-otp` | POST | None | Dispatches 6-digit numeric OTP with per-challenge salt & rate limit checks |
| `/verify-otp` | POST | None | Validates OTP atomically (`FOR UPDATE`) and returns access token + session |
| `/refresh-token`| POST | None | Exchanges refresh token for new access token |
| `/logout` | POST | Bearer | Revokes current session record in `auth_sessions` |
| `/admin/auth/login` | POST | None | Operations login with employee code & Scrypt password (5-fail lockout) |
| `/admin/auth/set-password` | POST | Bearer (Admin) | Sets Scrypt password and revokes all active sessions for the user |
| `/admin/auth/change-password` | POST | Bearer (Admin) | Updates Scrypt password and revokes active sessions across cluster |

---

## 2. Customer & Catalog Endpoints (`/api/catalog`, `/api/checkout`, `/api/orders`)

| Path | Method | Auth Required | Description |
| :--- | :--- | :--- | :--- |
| `/catalog/products` | GET | None | Browse geofenced catalog products |
| `/checkout/quote` | POST | Bearer | Calculates itemized quotation (delivery, handling, taxes) |
| `/orders/create` | POST | Bearer | Places order with reserved inventory (Idempotency-Key support) |
| `/orders` | GET | Bearer | Retrieves authenticated customer's order history |
| `/orders/:id` | GET | Bearer | Retrieves single order details (IDOR protected) |
| `/orders/:id/cancel` | POST | Bearer | Cancels unassigned/unpacked order with stock restitution |

---

## 3. Merchant & Store Endpoints (`/api/merchants`, `/api/seller`)

| Path | Method | Roles Allowed | Description |
| :--- | :--- | :--- | :--- |
| `/merchants/:id/inventory` | GET | MERCHANT_ADMIN | Store inventory levels query |
| `/merchants/:id/inventory/:productId/restock`| POST | MERCHANT_ADMIN | Restocks product and fires back-in-stock alerts |
| `/merchants/:id/orders/:orderId/pack` | POST | MERCHANT_ADMIN | Marks order packed and ready for rider pickup |

---

## 4. Delivery Partner Endpoints (`/api/partner`, `/api/tasks`)

| Path | Method | Roles Allowed | Description |
| :--- | :--- | :--- | :--- |
| `/partner/duty-status` | POST | DELIVERY_PARTNER | Toggles rider online/offline duty status |
| `/tasks/:id/accept` | POST | DELIVERY_PARTNER | Atomically claims a broadcast trip leg |
| `/tasks/:id/arrived-pickup`| POST | DELIVERY_PARTNER | Records arrival at merchant warehouse |
| `/tasks/:id/pickup-confirm`| POST | DELIVERY_PARTNER | Confirms handover from merchant |
| `/tasks/:id/verify-otp` | POST | DELIVERY_PARTNER | Completes delivery via customer OTP handshake |

---

## 5. Admin & Central Governance Endpoints (`/api/admin`)

| Path | Method | Roles Allowed | Description |
| :--- | :--- | :--- | :--- |
| `/admin/me` | GET | ADMIN roles | Validates operational staff permissions |
| `/admin/cities` | GET | ADMIN roles | Operational hub configurations |
| `/admin/orders` | GET | ADMIN roles | Real-time global order monitor |
| `/admin/riders` | GET | ADMIN roles | Fleet monitor and cash collection balances |
| `/admin/sellers` | GET | ADMIN roles | Seller KYC and GSTIN compliance |
| `/admin/settlements` | GET | ADMIN roles | Payout reconciliations and statutory withholding |
| `/admin/audit-logs` | GET | SUPER_ADMIN | Immutable security and transaction audit trail |
| `/admin/riders/:id/release-payout`| POST | FINANCE_ADMIN | Idempotently releases rider payout batch |

---

## 6. Financial Webhook Ingestion (`/api/payments/webhook`, `/api/webhooks/financial`)

- **Method:** `POST`
- **Headers:** `X-Razorpay-Signature: <hmac-sha256>`
- **Behavior:** Validates cryptographic HMAC signature, performs durable deduplication, processes refunds/payouts in atomic database transactions, and returns HTTP 200 with `{ success: true, duplicate?: boolean }`.

---

## 7. Health & Telemetry Probes

- `GET /health/live`: Process liveness probe (returns 200 OK).
- `GET /health/ready`: Database connection and Redis cluster readiness check (returns 200 OK or 503 Service Unavailable).

## 8. Request Limits and Admission Failures

| Category | Initial limit | Scope |
| :--- | :--- | :--- |
| General API | 120 requests / minute | Per IP and route |
| OTP request | 5 / 10 minutes per phone; 30 / 10 minutes per IP | Shared across OTP request aliases |
| Authentication | 30 / minute per identity; 120 / minute per IP | Shared across auth operations |
| Order creation | 10 / minute per authenticated user; 120 / minute per IP | Checkout admission |
| Payment initiation | 10 / minute per authenticated user; 120 / minute per IP | Payment creation |
| Payment webhooks | 120 / minute | Per IP, shared across webhook aliases |
| Dispatch actions | 30 / minute per authenticated user; 120 / minute per IP | Assignment, acceptance, and rematch |
| Inventory mutation | 30 / minute per authenticated user; 120 / minute per IP | Seller restock endpoint |

These are configured starting values, not production capacity claims; tune them using measured legitimate traffic. Limit responses use HTTP 429 with `Retry-After`. A required distributed limiter outage returns HTTP 503 with `RATE_LIMIT_UNAVAILABLE` and a short retry hint. The general guard is explicitly fail-open during Redis outage and emits `X-RateLimit-Status: unavailable`; sensitive route-specific guards remain fail-closed.

Forwarded client IPs are trusted only when the immediate proxy belongs to `TRUST_PROXY_CIDRS`. Do not trust arbitrary forwarded headers or use an unrestricted hop count.

Administrative password endpoints require an authenticated account with an authorized administrative role. `POST /api/auth/admin/change-password` requires both `currentPassword` and `newPassword`; an incorrect current password leaves credential and session state unchanged. A successful password update revokes all active sessions.
