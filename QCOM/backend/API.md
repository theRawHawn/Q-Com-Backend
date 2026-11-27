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
| `/v1/cart` | GET | Bearer (`cartRateLimiter` — 60/min open) | Retrieves authenticated customer's DB-backed cart with authoritative GST/discount pricing preview |
| `/v1/cart/items` | POST | Bearer (`cartRateLimiter` — 60/min open) | Upserts/sets item quantity in customer's persistent cart |
| `/v1/cart/items/:productId` | DELETE | Bearer (`cartRateLimiter` — 60/min open) | Removes product from persistent cart |
| `/v1/cart/coupon` | POST / DELETE | Bearer (`cartRateLimiter` — 60/min open) | Attaches or clears coupon code on persistent cart |
| `/v1/cart` | DELETE | Bearer (`cartRateLimiter` — 60/min open) | Clears customer's persistent cart |
| `/v1/pricing/coupons/validate` | POST | Bearer (`couponValidationRateLimiter` — 20/min fail-closed) | Validates coupon applicability, user/global eligibility & discount preview without burning usage slot |
| `/v1/pricing/promotions/active` | GET | Optional Auth | Lists currently active promotions (slabs, BOGO, category/free-delivery rules) |
| `/checkout/quote` | POST | Optional Auth (`pricingQuoteRateLimiter` — 60/min open) | Calculates itemized quotation (duplicate-line merged, `distanceKm >= 0`, `tax_inclusive`/`tax_exclusive`, Cess, dynamic POS) |
| `/checkout/pricing-config` / `/pricing/pricing-config` | POST | Bearer (`SUPER_ADMIN`, `FINANCE_ADMIN`, `OPERATIONS`) | Updates platform pricing rules |
| `/checkout/sellers-geofence/:sellerId` | POST | Bearer (`requireMerchantOwnership`) | Updates store availability & geofence radius |
| `/orders/delivery-economics/config` | POST | Bearer (`SUPER_ADMIN`, `FINANCE_ADMIN`, `OPERATIONS`) | Updates delivery economics configuration |
| `/orders/create` | POST | Bearer (`checkoutRateLimiter`) | Places order with server-recomputed pricing, single-use quote (`403`/`409 QUOTE_ALREADY_USED`/`PRICE_CHANGED`/`QUOTE_EXPIRED`), canonical payload fingerprint, and atomic `users FOR UPDATE` + coupon locks |
| `/orders` | GET | Bearer | Retrieves authenticated customer's order history |
| `/orders/:orderId` | GET | Bearer (`requireOrderOwnership`) | Retrieves single order details (customer, merchant staff, assigned rider, or admin only) |
| `/orders/:orderId/cancel` | POST | Bearer (`requireOrderOwnership`) | Cancels unassigned/unpacked order with stock restitution and coupon/promo reservation release |
| `/invoices/order/:orderId` & `/text` | GET | Bearer (`requireOrderOwnership`) | Downloads GST tax invoice JSON/text (dynamic Indian FY, fail-closed GST, honest `irn: null` when IRP disabled) |
| `/invoices/order/:orderId/credit-notes` & `/text` | GET | Bearer (`requireOrderOwnership`) | Lists/prints GST Credit Notes (unique per return & type, sequential rounding parity) |

---

## 3. Merchant, Return & Settlement Endpoints (`/api/merchants`, `/api/returns`, `/api/settlements`)

| Path | Method | Roles Allowed | Description |
| :--- | :--- | :--- | :--- |
| `/merchants/:id/inventory` | GET | Bearer (`requireMerchantOwnership`) | Store inventory levels query |
| `/merchants/:id/inventory/:productId/restock`| POST | Bearer (`requireMerchantOwnership`) | Restocks product and fires back-in-stock alerts |
| `/merchants/:id/orders/:orderId/pack` | POST | Bearer (`requireMerchantOwnership`) | Marks order packed and ready for rider pickup |
| `/orders/:orderId/returns` | GET | Bearer (`requireOrderOwnership`) | Lists return requests for an order |
| `/returns/:returnId` | GET | Bearer (Order owner / Merchant / Admin) | Reads specific return record |
| `/returns/:returnId/review` / `receive` / `qc-inspect` | POST | Bearer (Return merchant / Admin, `returnActionRateLimiter` — 30/min fail-closed) | Processes merchant return workflow with deterministic QC refund idempotency & crash recovery |
| `/settlements/allocate` | POST | Bearer (`SUPER_ADMIN`, `FINANCE_ADMIN`, `OPERATIONS`) | Computes and stores post-delivery settlement allocation |
| `/settlements/order/:orderId/allocation` | GET | Bearer (Merchant / Rider / Admin) | Reads order settlement breakdown |
| `/settlements/cod/remit` | POST | Bearer (`requireRiderOwnership`, `codRemittanceRateLimiter`) | Submits rider COD remittance (`SUBMITTED`; does not clear liability until receipt + verification) |
| `/settlements/rider/:riderId/cod-summary` | GET | Bearer (`requireRiderOwnership`) | Authoritative PostgreSQL rider COD metrics (A–H), open collections, remittances & disputes |
| `/settlements/cod/observability` | GET | Bearer (`SUPER_ADMIN`, `FINANCE_ADMIN`, `OPERATIONS`) | Portfolio-wide COD collection, unverified remittance & dispute monitoring metrics |
| `/settlements/cod/remittances` | POST | Bearer (`requireRiderOwnership`, `codRemittanceRateLimiter`) | Initiates `DRAFT` or `SUBMITTED` remittance with explicit order/collection IDs or FIFO reservation |
| `/settlements/cod/remittances/:remittanceId/submit` | POST | Bearer (Owning Rider / Admin, `codRemittanceRateLimiter`) | Finalizes `DRAFT` remittance to `SUBMITTED` |
| `/settlements/cod/remittances/:remittanceId/receive` | POST | Bearer (`OPERATIONS`, `DISPATCHER`, `FINANCE_ADMIN`, `SUPER_ADMIN`) | Acknowledges physical handover (`received_by <> submitted_by`) |
| `/settlements/cod/remittances/:remittanceId/verify` | POST | Bearer (`FINANCE_ADMIN`, `SUPER_ADMIN`) | Independent finance count & GL clearance (`verified_by <> received_by`, `verified_by <> submitted_by`) |
| `/settlements/cod/remittances/:remittanceId/reject` | POST | Bearer (`OPERATIONS`, `FINANCE_ADMIN`, `SUPER_ADMIN`) | Rejects unverified remittance and releases reserved collections |
| `/settlements/cod/remittances/:remittanceId/cancel` | POST | Bearer (Owning Rider / Admin) | Cancels `DRAFT`/`SUBMITTED` remittance prior to physical receipt |
| `/settlements/cod/remittances/:remittanceId/reverse` | POST | Bearer (`FINANCE_ADMIN`, `SUPER_ADMIN`) | Posts offsetting `COD_REVERSAL` GL batch and restores rider liability |
| `/settlements/cod/disputes` | POST | Bearer (`OPERATIONS`, `FINANCE_ADMIN`, `SUPER_ADMIN`) | Opens durable COD shortage/excess/missing-collection dispute |
| `/settlements/cod/disputes/:disputeId/resolve` | POST | Bearer (`FINANCE_ADMIN`, `SUPER_ADMIN`) | Resolves dispute with immutable GL recovery, wallet deduction, receivable, or write-off |
| `/settlements/cod/riders/:riderId/ceiling-override` | POST | Bearer (`FINANCE_ADMIN`, `SUPER_ADMIN`) | Grants time-bounded audited COD dispatch ceiling override (never clears liability) |

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
| `/v1/admin/coupons` (`GET`, `POST`, `PATCH /:id`) | GET/POST/PATCH | `SUPER_ADMIN`, `FINANCE_ADMIN`, `OPERATIONS` | Manages coupon definitions, usage limits, funding splits & conflict groups (audited) |
| `/v1/admin/promotions` (`GET`, `POST`, `PATCH /:id`, `DELETE /:id`) | GET/POST/PATCH/DELETE | `SUPER_ADMIN`, `FINANCE_ADMIN`, `OPERATIONS` | Manages promotional rules (`CART_SLAB`, `BOGO`, `CATEGORY_DISCOUNT`, `FREE_DELIVERY`) |
| `/v1/admin/discounts/report` | GET | `SUPER_ADMIN`, `FINANCE_ADMIN`, `OPERATIONS` | Aggregated seller vs. platform discount funding & COA `5040` subsidy report |

---

## 6. Financial Webhook Ingestion (`/api/payments/webhook/:providerId`, `/api/webhooks/razorpay`, `/api/settlements/webhooks/payouts`, `/api/refunds/webhooks/refunds`)

- **Method:** `POST` (protected by `paymentWebhookRateLimiter`)
- **Headers:** Provider HMAC signature headers (`X-Razorpay-Signature`, etc.)
- **Behavior:** Validates cryptographic HMAC signature, performs durable deduplication, processes refunds/payouts in atomic database transactions, and returns HTTP 200 with `{ success: true, duplicate?: boolean }`.

---

## 7. Health & Telemetry Probes

- `GET /health/live`: Process liveness probe (returns 200 OK).
- `GET /health/ready`: Database connection and Redis cluster readiness check (returns 200 OK or 503 Service Unavailable).

