# QCOM REST & Realtime API Contract Specification (API)

**Base URL:** `http://localhost:3000/api` (Production: HTTPS)  
**Realtime WebSocket URL:** `ws://localhost:3000/ws` (also accepts `/ws/v1`)  
**Authentication Scheme:** Bearer JWT (`Authorization: Bearer <accessToken>`)  

---

## 1. Authentication & Session Endpoints (`/api/auth`)

| Path | Method | Auth Required | Description |
| :--- | :--- | :--- | :--- |
| `/request-otp` | POST | None (OTP Rate Limited) | Dispatches 6-digit numeric OTP with per-challenge salt & Redis rate limiting |
| `/verify-otp` | POST | None (Auth Rate Limited) | Validates OTP atomically (`FOR UPDATE`) and returns access token + refresh token + session |
| `/refresh` | POST | None (Auth Rate Limited) | Rotates single-use refresh token, preserves `token_version`, detects replay reuse |
| `/logout` | POST | Bearer | Revokes current session record in `auth_sessions` and emits WS disconnect |
| `/logout-all` | POST | Bearer | Revokes all active `auth_sessions` & `refresh_tokens` and severs all user WebSockets |
| `/me` | GET | Bearer | Returns authenticated user profile, roles, permissions, and tenant scope |
| `/admin/login` (`/admin/auth/login`) | POST | None (Auth Rate Limited) | Admin login requiring employee code + Scrypt password (5-fail lockout, no auto-create) |
| `/admin/set-password` | POST | Bearer (Admin) | Sets Scrypt password and revokes active sessions, refresh tokens & WebSockets |
| `/admin/change-password` | POST | Bearer (Admin) | Verifies current Scrypt password, updates hash, revokes sessions/refresh/WebSockets |

---

## 2. Customer, Pricing & Order Endpoints (`/api/catalog`, `/api/checkout`, `/api/pricing`, `/api/orders`, `/api/invoices`)

| Path | Method | Auth / Role Required | Description |
| :--- | :--- | :--- | :--- |
| `/catalog/products` | GET | None | Browse geofenced catalog products |
| `/checkout/quote` | POST | Optional Auth | Calculates itemized quotation (delivery, handling, taxes) |
| `/checkout/pricing-config` / `/pricing/pricing-config` | POST | Bearer (`SUPER_ADMIN`, `FINANCE_ADMIN`, `OPERATIONS`) | Updates platform pricing rules |
| `/checkout/sellers-geofence/:sellerId` | POST | Bearer (`requireMerchantOwnership`) | Updates store availability & geofence radius |
| `/orders/delivery-economics/config` | POST | Bearer (`SUPER_ADMIN`, `FINANCE_ADMIN`, `OPERATIONS`) | Updates delivery economics configuration |
| `/orders/create` | POST | Bearer | Places order with reserved inventory (Idempotency-Key support) |
| `/orders` | GET | Bearer | Retrieves authenticated customer's order history |
| `/orders/:orderId` | GET | Bearer (`requireOrderOwnership`) | Retrieves single order details (customer, merchant staff, assigned rider, or admin only) |
| `/orders/:orderId/cancel` | POST | Bearer (`requireOrderOwnership`) | Cancels unassigned/unpacked order with stock restitution |
| `/invoices/order/:orderId` & `/text` | GET | Bearer (`requireOrderOwnership`) | Downloads GST tax invoice JSON or formatted text |

---

## 3. Merchant, Return & Settlement Endpoints (`/api/merchants`, `/api/returns`, `/api/settlements`)

| Path | Method | Roles Allowed | Description |
| :--- | :--- | :--- | :--- |
| `/merchants/:id/inventory` | GET | Bearer (`requireMerchantOwnership`) | Store inventory levels query |
| `/merchants/:id/inventory/:productId/restock`| POST | Bearer (`requireMerchantOwnership`) | Restocks product and fires back-in-stock alerts |
| `/merchants/:id/orders/:orderId/pack` | POST | Bearer (`requireMerchantOwnership`) | Marks order packed and ready for rider pickup |
| `/orders/:orderId/returns` | GET | Bearer (`requireOrderOwnership`) | Lists return requests for an order |
| `/returns/:returnId` | GET | Bearer (Order owner / Merchant / Admin) | Reads specific return record |
| `/returns/:returnId/review` / `receive` / `qc-inspect` | POST | Bearer (Return merchant / Admin) | Processes merchant return workflow (forged `body.merchantId` rejected) |
| `/settlements/allocate` | POST | Bearer (`SUPER_ADMIN`, `FINANCE_ADMIN`, `OPERATIONS`) | Computes and stores post-delivery settlement allocation |
| `/settlements/order/:orderId/allocation` | GET | Bearer (Merchant / Rider / Admin) | Reads order settlement breakdown |
| `/settlements/cod/remit` | POST | Bearer (`requireRiderOwnership`) | Records rider COD deposit (`{ riderId, amount, method, reference }`, `RIDER` own ID or Finance/Ops/Super Admin) |

---

## 4. Delivery Partner & Routing Endpoints (`/api/partner`, `/api/tasks`, `/api/dispatch`, `/api/routing`)

| Path | Method | Roles Allowed | Description |
| :--- | :--- | :--- | :--- |
| `/partner/duty-status` | POST | Bearer (`RIDER`) | Toggles authenticated rider online/offline duty status |
| `/tasks/:id/accept` | POST | Bearer (`RIDER`) | Atomically claims a broadcast trip leg |
| `/tasks/:id/arrived-pickup`| POST | Bearer (`RIDER` assigned / Dispatch Admin) | Records arrival at merchant warehouse (trip ownership enforced) |
| `/tasks/:id/pickup-confirm`| POST | Bearer (`RIDER` assigned / Dispatch Admin) | Confirms handover from merchant (trip ownership enforced) |
| `/tasks/:id/verify-otp` | POST | Bearer (`RIDER` assigned / Dispatch Admin) | Constant-time delivery OTP completion & `409` replay protection |
| `/dispatch/orders/:orderId` | GET | Bearer (`requireOrderOwnership`) | Inspects dispatch offers for an order |
| `/dispatch/assignments/:assignmentId` | GET | Bearer (Customer / Merchant / Rider / Admin) | Reads dispatch assignment details |
| `/routing/reroute` / `entrance-correction` / `telemetry` | POST | Bearer (`RIDER`, Store, Dispatch Admin) | Real-time route adjustments & rider-bound telemetry |

---

## 5. Admin & Central Governance Endpoints (`/api/admin`)

All `/api/admin/*` endpoints require valid JWT `Authorization: Bearer <token>`; legacy `x-admin-role` / `x-admin-id` headers are ignored.

| Path | Method | Roles Allowed | Description |
| :--- | :--- | :--- | :--- |
| `/admin/me` | GET | Any Admin role | Returns JWT-verified admin identity and permissions |
| `/admin/cities` | GET | Any Admin role | Operational hub configurations |
| `/admin/orders` | GET | Ops / Admin / Finance Admin | Real-time global order monitor |
| `/admin/riders` | GET | Ops / Admin / Finance Admin | Fleet monitor and cash collection balances |
| `/admin/sellers` | GET | Ops / Admin | Seller KYC and GSTIN compliance |
| `/admin/settlements` | GET | Admin / Finance / Ops | Payout reconciliations and statutory withholding |
| `/admin/refunds` | GET | Admin / Finance / Ops | Customer refund status queue (`refunds` ledger) |
| `/admin/customers` & `PATCH /status` & `POST /reset-session` | GET/PATCH/POST | Ops / Admin (`adminSensitiveRateLimiter` on mutations) | Lists customers, suspends accounts (`is_suspended` + HTTP/Refresh/WS revocation), or revokes active sessions |
| `/admin/employees/list`, `/create`, `/:id/assign-roles` | GET/POST | List: Ops/Admin; Create/Assign: `SUPER_ADMIN` only | Manages internal employee RBAC roles (self-mutation blocked) |
| `/admin/audit-logs` | GET | Admin / Finance / Ops | Redacted immutable security and transaction audit trail |
| `/admin/riders/:id/release-payout`| POST | `SUPER_ADMIN`, `FINANCE_ADMIN` | Idempotently releases rider payout batch |

---

## 6. Financial Webhook Ingestion (`/api/payments/webhook/:providerId`, `/api/webhooks/razorpay`, `/api/settlements/webhooks/payouts`, `/api/refunds/webhooks/refunds`)

- **Method:** `POST` (protected by `paymentWebhookRateLimiter`)
- **Headers:** Provider HMAC signature headers (`X-Razorpay-Signature`, etc.)
- **Behavior:** Validates cryptographic HMAC signature, performs durable deduplication, processes refunds/payouts in atomic database transactions, and returns HTTP 200 with `{ success: true, duplicate?: boolean }`.

---

## 7. Health & Telemetry Probes

- `GET /health/live`: Process liveness probe (returns 200 OK).
- `GET /health/ready`: Database connection and Redis cluster readiness check (returns 200 OK or 503 Service Unavailable).

