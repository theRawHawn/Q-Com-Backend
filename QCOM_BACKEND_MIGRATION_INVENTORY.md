# QCOM Backend Migration Inventory & Technical Audit

**Generated Date:** 2026-09-29T05:42:15Z  
**Source Checkpoint:** Restored Checkpoint (Post Sprint 3.1)  
**Objective:** Complete structural inventory of existing Customer App backend capabilities and standalone QCOM Backend engine to enable safe, zero-downtime, contract-compatible backend consolidation into `QCOM/backend` without modifying Customer App frontend code.

---

## 1. Existing Customer Backend Modules (`QCOM/customer-app/server` & `src/utils`)

| Module / File | Primary Purpose | Dependencies / Importers |
| :--- | :--- | :--- |
| `server.ts` | Express server entrypoint, rate limiting, security headers, `/api/part-finder`, `/api/emergency-kit-planner` | `express`, `@google/genai`, `dotenv`, routes |
| `server/store.ts` | In-memory data store for products, OTPs, customers, profiles, orders, state machine, and route telemetry | Node `crypto`, `types.ts`, `data/products`, `data/sampleOrders` |
| `server/security.ts` | HMAC token generation & validation, rate limiting, timing-safe equality, input sanitization, payment signatures | Node `crypto` |
| `server/pricingEngine.ts` | Authoritative pricing quotes, dynamic coupons (`PROBUILD`, `SPEEDSITE`, `ELECTRO100`), snapshot creation | `store.ts`, `customerPricingService.ts` |
| `server/routes/auth.ts` | Customer OTP generation, verification, `/me`, and session logout | `security.ts`, `store.ts` |
| `server/routes/orders.ts` | `/quote`, `/calculate`, `/create`, `/pricing-config`, `/sellers-geofence`, `/delivery-economics/*`, order tracking & cancel | `store.ts`, `pricingEngine.ts`, `customerPricingService.ts`, `deliveryEconomicsService.ts` |
| `server/routes/payment.ts` | Payment intent generation (`/create-order`), cryptographic HMAC signature verification & replay attack prevention (`/verify`) | `security.ts`, `store.ts` |
| `server/routes/profile.ts` | Customer profile retrieval (`GET /`), updates (`PUT /`), and business GSTIN management (`POST /saved-gstin`) | `security.ts`, `store.ts` |
| `server/routes/routing.ts` | Multi-candidate OSRM routing, deterministic scoring, vehicle entrance corrections, courier rerouting on deviation, telemetry | `security.ts`, `store.ts`, OSRM public API, urban grid generator |
| `server/routes/strixAudit.ts` | Security benchmark endpoints (SSRF, NoSQL sanitization, prompt injection detection, path traversal defenses) | `security.ts`, `store.ts` |
| `src/utils/customerPricingService.ts`| CustomerPricingService: Admin dynamic commercial configs, seller geofence registry, item commission calculation, 7-step seller eligibility | `types.ts`, `sellers.ts`, `products.ts`, `gstEngine.ts`, `deliveryPricingService.ts` |
| `src/utils/deliveryPricingService.ts`| DeliveryPricingService: 100m distance rounding (`floor((d + 50)/100)*100`), eligible cart value calculation, tiered delivery fee slabs | `types.ts` |
| `src/utils/deliveryEconomicsService.ts`| DeliveryEconomicsService: Real-time rider payout, variable costs (PG, packaging, ops), contribution margin, maximum delivery subsidy rule | `types.ts`, `customerPricingService.ts`, `deliveryPricingService.ts` |
| `src/utils/fulfilmentSelectionService.ts`| FulfilmentSelectionService: Multi-attribute economic utility score ranking across candidates (SLA, distance, inventory, contribution) | `types.ts`, `customerPricingService.ts`, `deliveryEconomicsService.ts` |
| `src/utils/gstEngine.ts` | GST state codes mapping, 15-character GSTIN validation, HSN/SAC code mapping, place of supply resolution (Intra-state vs Inter-state) | `types.ts` |
| `src/utils/invoiceGenerator.ts` | Statutory GST Tax Invoices (Summary, Form GST INV-1 Seller Tax Invoice, QCOM Platform/Delivery Tax Invoice), 64-char IRN SHA-256, dynamic QR code, PDF generation | `jspdf`, `jspdf-autotable`, `qrcode`, `gstEngine.ts` |

---

## 2. Existing QCOM Backend Modules (`QCOM/backend/src`)

| Module / Path | Primary Purpose | Architectural Tenets |
| :--- | :--- | :--- |
| `src/server.ts` | HTTP bootstrap on port 3000 (or env port), graceful shutdown (`SIGTERM`, `SIGINT`) | Centralized entrypoint |
| `src/app.ts` | Express application, security headers, request ID, CORS, sanitization, rate limiting, readiness & liveness probes | High-performance middleware stack |
| `src/database/connection.ts` | PostgreSQL client pool (`pg` / `pg-mem`), transaction helper (`withTransaction`), health check probe | Authoritative persistent storage |
| `src/database/redis.ts` | Redis cache client (`ioredis` / in-memory fallback), non-authoritative accelerator | Non-authoritative cache only |
| `src/database/migrator.ts` | Schema migration runner (executes 001–011 SQL migrations in sequence with lock) | DDL versioning |
| `src/middleware/auth.ts` | JWT bearer token verification, active session check against Redis/DB, token revocation checking | Stateless tokens + stateful session revocations |
| `src/middleware/rbac.ts` | Dynamic RBAC permission validation (`requirePermission`), role-to-permission mapping with Redis caching | Granular access control |
| `src/middleware/errorHandler.ts` | Formatted error handler, database failure interceptor (HTTP 503 + Retry-After: 3 on DB outage) | Fail-closed resilience |
| `src/modules/auth/` | TokenService, SessionService, PasswordService (bcrypt), MockOtpProvider | Centralized auth & identity |
| `src/modules/rbac/` | Dynamic role assignment, granular permissions hierarchy, tenant isolation | Role & Permission management |
| `src/modules/pricing/money.ts` | Exact 4-decimal precision arithmetic using `bignumber.js`, statutory Half-Up rounding | Zero floating-point rounding errors |
| `src/modules/pricing/taxEngine.ts` | Statutory tax rule resolution, effective-dated taxes, fail-closed (`TAX_RULE_NOT_FOUND`, `TAX_RULE_CONFLICT`), Section 52 GST-TCS, Income-tax Act 2025/1961 withholding | Statutory compliance |
| `src/modules/pricing/pricingEngine.ts` | Authoritative server pricing engine, 3-bucket separation (Seller Goods, QCOM Commission/Platform Fee, QCOM Delivery Fee), frozen snapshot creation | Marketplace model authority |
| `src/routes/authRoutes.ts` | `/api/v1/auth/request-otp`, `/api/v1/auth/verify-otp`, `/api/v1/auth/refresh`, `/api/v1/auth/logout`, admin password login | Centralized auth endpoints |
| `src/routes/pricingRoutes.ts` | `/api/v1/pricing/quote`, `/calculate`, `/tax-rules`, `/delivery-rules`, `/handling-rules`, `/coupons` | Pricing & statutory endpoints |
| `src/routes/rbacRoutes.ts` | `/api/v1/admin/rbac/roles`, `/permissions`, `/users/:userId/roles` | Admin RBAC endpoints |
| `src/routes/resourceDemoRoutes.ts`| Multi-tenant IDOR protection demonstration endpoints | Tenant isolation audit |

---

## 3. API Endpoints, HTTP Methods & Contracts Consumed by Customer App

| HTTP Method | Customer Path | QCOM Backend Target Path | Request Payload Summary | Response Structure Summary | Auth Requirement |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `POST` | `/api/auth/request-otp` | `/api/v1/auth/request-otp` & `/api/auth/request-otp` | `{ phone: string }` | `{ success: boolean, message: string, expiresInSec: number, _devTestOtp?: string }` | Public / Rate-limited |
| `POST` | `/api/auth/verify-otp` | `/api/v1/auth/verify-otp` & `/api/auth/verify-otp` | `{ phone: string, otp: string, name?: string }` | `{ success: boolean, message: string, token: string, user: UserProfile }` | Public / Rate-limited |
| `GET` | `/api/auth/me` | `/api/v1/auth/me` & `/api/auth/me` | None | `{ success: boolean, user: UserProfile }` | Bearer Token Required |
| `POST` | `/api/auth/logout` | `/api/v1/auth/logout` & `/api/auth/logout` | None | `{ success: boolean, message: string }` | Bearer Token Required |
| `GET` | `/api/profile` | `/api/v1/profile` & `/api/profile` | None | `{ success: boolean, profile: CustomerProfile }` | Bearer Token Required |
| `PUT` | `/api/profile` | `/api/v1/profile` & `/api/profile` | `{ name?, email?, defaultAddress?, floorUnit?, landmark?, accountType? }` | `{ success: boolean, message: string, profile: CustomerProfile }` | Bearer Token Required |
| `POST` | `/api/profile/saved-gstin` | `/api/v1/profile/saved-gstin` & `/api/profile/saved-gstin` | `{ gstin, legalBusinessName, tradeName, billingAddress, state, stateCode, isDefault }` | `{ success: boolean, savedGstin: SavedGstinRecord, allSavedGstins: SavedGstinRecord[] }` | Bearer Token Required |
| `POST` | `/api/checkout/quote`<br>`/api/checkout/calculate` | `/api/v1/pricing/quote`<br>`/api/v1/checkout/calculate`<br>`/api/checkout/quote` | `{ cart_items \| items, delivery_coordinates?, coupon_code?, is_gst_enabled?, buyer_gstin?, rider_tip?, seller_funded_discounts? }` | `{ success: boolean, quote: AuthoritativeQuote, breakdown: PriceBreakdown }` | Optional Bearer |
| `GET` | `/api/checkout/pricing-config` | `/api/v1/pricing/config` & `/api/checkout/pricing-config` | None | `{ success: boolean, config: AdminCommercialConfig }` | Public / Admin |
| `POST` | `/api/checkout/pricing-config` | `/api/v1/pricing/config` & `/api/checkout/pricing-config` | `Partial<AdminCommercialConfig>` | `{ success: boolean, message: string, config: AdminCommercialConfig }` | Optional / Admin Auth |
| `GET` | `/api/checkout/sellers-geofence` | `/api/v1/sellers/geofence` & `/api/checkout/sellers-geofence` | None | `{ success: boolean, sellers: SellerGeofenceConfig[] }` | Public |
| `POST` | `/api/checkout/sellers-geofence/:sellerId` | `/api/v1/sellers/geofence/:sellerId` & `/api/checkout/sellers-geofence/:sellerId` | `Partial<SellerGeofenceConfig>` | `{ success: boolean, message: string, seller: SellerGeofenceConfig }` | Optional / Admin Auth |
| `GET` | `/api/orders/delivery-economics/config` | `/api/v1/delivery/economics/config` & `/api/orders/delivery-economics/config` | None | `{ success: boolean, config: DeliveryEconomicsConfig }` | Public / Admin |
| `POST` | `/api/orders/delivery-economics/config` | `/api/v1/delivery/economics/config` & `/api/orders/delivery-economics/config` | `Partial<DeliveryEconomicsConfig>` | `{ success: boolean, message: string, config: DeliveryEconomicsConfig }` | Optional / Admin Auth |
| `POST` | `/api/orders/delivery-economics/evaluate` | `/api/v1/delivery/economics/evaluate` & `/api/orders/delivery-economics/evaluate` | `{ deliveryCoordinates, cartItems, couponCode?, riderTip?, isBatched? }` | `{ success: boolean, evaluation: OptimalFulfilmentResult }` | Public |
| `POST` | `/api/orders/create` | `/api/v1/orders/create` & `/api/orders/create` | `{ items, jobSite, paymentMethod, couponCode?, isGstEnabled?, gstin?, businessName?, riderTip? }` | `{ success: boolean, order: Order, priceSnapshot: PricingSnapshot, message: string }` | Bearer Token + Idempotency-Key |
| `GET` | `/api/orders` | `/api/v1/orders` & `/api/orders` | None | `{ success: boolean, orders: Order[] }` | Bearer Token Required |
| `GET` | `/api/orders/:orderId` | `/api/v1/orders/:orderId` & `/api/orders/:orderId` | None | `{ success: boolean, order: Order }` | Bearer Token Required (IDOR protected) |
| `POST` | `/api/orders/:orderId/cancel` | `/api/v1/orders/:orderId/cancel` & `/api/orders/:orderId/cancel` | None | `{ success: boolean, message: string, order: Order, refund: RefundRecord }` | Bearer Token Required (Grace period enforced) |
| `POST` | `/api/payment/create-order` | `/api/v1/payments/create-order` & `/api/payment/create-order` | `{ orderId: string }` | `{ success: boolean, paymentOrder: { paymentOrderId, orderId, amount, currency, timestamp, signature } }` | Bearer Token Required |
| `POST` | `/api/payment/verify` | `/api/v1/payments/verify` & `/api/payment/verify` | `{ orderId, transactionId, timestamp, signature, amount }` | `{ success: boolean, message: string, order: Order, paymentReceipt: PaymentReceipt }` | Bearer Token Required (Replay Protected) |
| `POST` | `/api/routing/calculate` | `/api/v1/routing/calculate` & `/api/routing/calculate` | `{ sellerLocation, customerLocation, vehicleType? }` | `{ success: boolean, selectedRoute, alternativeRoutes, sellerPickupEntrance, customerDropoffEntrance, summary, cached }` | Public / Rate-limited |
| `POST` | `/api/routing/reroute` | `/api/v1/routing/reroute` & `/api/routing/reroute` | `{ orderId, currentRiderLocation, destinationLocation }` | `{ success: boolean, message: string, recalculatedRoute, summary }` | Public / Rate-limited |
| `POST` | `/api/routing/entrance-correction` | `/api/v1/routing/entrance-correction` & `/api/routing/entrance-correction` | `{ locationType, originalCoords, accessibleEntranceCoords, notes? }` | `{ success: boolean, message: string, locationKey, accessibleEntranceCoords }` | Public / Rate-limited |
| `POST` | `/api/routing/telemetry` | `/api/v1/routing/telemetry` & `/api/routing/telemetry` | `{ orderId, sellerId, originCoords, destinationCoords, ... }` | `{ success: boolean, message: string, recordId }` | Public / Rate-limited |
| `POST` | `/api/part-finder` | `/api/v1/ai/part-finder` & `/api/part-finder` | `{ prompt?, imageBase64?, mimeType?, tradeType? }` | `{ partName, confidenceScore, estimatedSize, material, threadType, commonIssues, matchedProductIds, recommendedAccessories, expertTip }` | Public / Rate-limited |
| `POST` | `/api/emergency-kit-planner` | `/api/v1/ai/emergency-kit-planner` & `/api/emergency-kit-planner` | `{ emergencyDescription, trade? }` | `{ kitName, estimatedFixTimeMinutes, suggestedItems, advice }` | Public / Rate-limited |

---

## 4. Database & Storage Architecture

### 4.1 Authoritative Persistent Store: PostgreSQL / PostGIS
- All business entities (users, profiles, saved GSTINs, orders, order items, pricing snapshots, statutory tax rules, audit trails, and idempotency states) reside in PostgreSQL tables.
- **Sprint 1–3.1 DB Failure Contract:** If PostgreSQL is unreachable or terminates:
  - Return **HTTP 503 Service Unavailable**
  - Set Header: `Retry-After: 3`
  - Error Body: `{ success: false, error: "DATABASE_UNAVAILABLE", message: "PostgreSQL database is currently unavailable. Please retry using the same Idempotency-Key." }`
  - Zero ghost records created in Redis or memory.

### 4.2 Non-Authoritative Cache: Redis
- Non-authoritative accelerator only:
  - Cache routing responses (10 min TTL key: `geo:route:<lat1>,<lng1>_<lat2>,<lng2>`)
  - Session and token revocation index
  - Rate limiting buckets (`rl:quote`, `rl:order`, `rl:otp:req`, `rl:otp:ver`)
  - If Redis is down, system degrades gracefully to direct DB/in-memory rate limiter without throwing 500.

---

## 5. External Service Integrations
1. **OSRM (Open Source Routing Machine) Public Demo & Tile Engine:**
   - Primary: `https://router.project-osrm.org/route/v1/driving/...`
   - Secondary: `https://router.project-osrm.org/route/v1/bike/...`
   - Fallback: Deterministic Urban Grid Algorithm with road curvature factor 1.25.
2. **Gemini AI API (@google/genai):**
   - Model: `gemini-3.7-flash` (used by Part Finder and Emergency Kit Planner)
   - Fallback: Pre-baked master tradesperson hardware matching dictionary when key is omitted or quota exceeded.
3. **SMS Gateway:**
   - Production abstraction with dev/test OTP pass-through.

---

## 6. Functional Capabilities Analysis

### 6.1 Cart & Checkout Functionality
- Zero-trust architecture: Client-submitted prices, tax totals, delivery fees, and discounts are never trusted.
- `/checkout/calculate` and `/checkout/quote` accept requested item IDs and quantities, look up authoritative seller prices and product HSN codes from DB, calculate statutory GST, verify seller stock availability, calculate road-distance-based delivery charges, apply coupons, and issue an immutable frozen pricing snapshot.
- Internal financial reproducibility mechanism rather than a negotiable quotation.

### 6.2 GST / Tax Functionality
- Effective-dated tax rules with fail-closed behavior (`TAX_RULE_NOT_FOUND` -> 422, `TAX_RULE_CONFLICT` -> 409).
- Separation of 3 distinct tax buckets:
  1. **Seller Goods GST:** Derived from seller's product HSN code (Intra-state CGST + SGST vs Inter-state IGST based on Place of Supply).
  2. **QCOM Platform & Handling Fee GST:** 18% GST (SAC 998319 / 9987).
  3. **QCOM Delivery Fee GST:** 18% GST (SAC 996813).
- Statutory withholdings:
  - Section 52 GST-TCS (1% on net taxable value).
  - Income-tax Act Section 194-O (1% / 0.1% transition architecture for 2025/1961 statutory regimes).
- All numbers computed using 4-decimal precision arithmetic (`bignumber.js`) with statutory Half-Up rounding.

### 6.3 Delivery Economics & Pricing Engine
- Mathematical 100m distance rounding formula: `floor((actual_distance_m + 50) / 100) * 100`.
- Delivery fee slabs:
  - 0–2,000m: ₹29 (or free if eligible cart value ≥ ₹499)
  - 2,001–4,000m: ₹39
  - 4,001–6,000m: ₹49
  - >6,000m: ₹49 + ₹10 per 1,000m increment
- Maximum customer delivery charge cap: ₹49 default, admin configurable.
- Real-time order contribution calculation:
  $$\text{Contribution} = \text{QCOM Commission} + \text{Customer Delivery Charge} + \text{Handling Fee} - \text{Rider Payout} - \text{PG Cost} - \text{Packaging} - \text{Ops Cost} - \text{Platform Coupon}$$
- Unviable order rejection if contribution < minimum threshold and exceeds maximum subsidy limit.

### 6.4 Invoice & PDF Generation
- Statutory GST tax invoices compliant with Indian GST rules:
  1. **Customer Summary Invoice:** High-level consolidated order summary.
  2. **Seller Tax Invoice (Form GST INV-1):** Issued on behalf of the registered seller for the hardware items, containing seller legal name, GSTIN, place of supply, HSN itemized table, taxable value, CGST/SGST/IGST breakdown, and reverse charge indicator.
  3. **QCOM Platform & Delivery Tax Invoice:** Issued by QCOM for delivery and convenience fees with QCOM GSTIN (`29AAACQ1928K1Z3`).
- Generation of 64-character SHA-256 GST IRN and dynamic QR code.
- Uses `jspdf` and `jspdf-autotable` to generate byte streams/PDF documents.

### 6.5 Maps, Routing & Telemetry
- Multi-candidate routing engine combining OSRM driving, bike courier corridor, and urban grid shortcut fallback.
- Snapping to designated vehicle-accessible loading bays / entrance pins.
- Courier rerouting on detected GPS deviation (>50m off route).
- Telemetry recording of historical rider traces, off-route deviations, and actual vs planned ETA.

---

## 7. Configuration & Environment Variables

| Variable | Scope | Purpose |
| :--- | :--- | :--- |
| `PORT` | Backend | HTTP Port (Default: 3000) |
| `DATABASE_URL` | Backend | PostgreSQL connection string |
| `REDIS_URL` | Backend | Redis connection string (Optional; in-memory fallback present) |
| `JWT_SECRET` | Backend | 256-bit secret key for HMAC token signing |
| `GEMINI_API_KEY` | Backend | Google Gemini API key for AI Part Finder & Kit Planner |
| `CORS_ALLOWED_ORIGINS` | Backend | Allowed CORS origins (e.g., `*` or comma-separated URLs) |
| `NODE_ENV` | Backend | `development` / `production` / `test` |

---

## 8. Potential Conflicts & Duplications

1. **Routing Prefix Conflict:**
   - Customer App calls `/api/checkout/quote`, `/api/orders`, `/api/payment`, etc.
   - QCOM Backend currently mounts its routers under `/api/v1` and partially under `/api`.
   - **Resolution:** Mount all migrated domain routers on both `/api/v1` and `/api` to provide 100% transparent backwards compatibility.
2. **Auth Token Format & User Shape:**
   - Customer App expects `user.profile` and `user.accountType` inside the auth verify response.
   - QCOM Backend currently returns `{ success: true, token, user: { id, email, phone, role } }`.
   - **Resolution:** Enhance QCOM backend auth verify response to include `name`, `accountType`, and `profile` sub-objects.
3. **Pricing Engine Consolidation:**
   - Both Customer App and QCOM Backend implemented pricing calculation logic.
   - **Authoritative Engine:** QCOM Backend's `modules/pricing` (`pricingEngine.ts`, `taxEngine.ts`, `money.ts`) is authoritative. The Customer App's 100m distance rounding, seller eligibility evaluation, delivery economics, and commercial config parameters must be consolidated into this engine so that there is a single authoritative implementation.
4. **Order Store vs PostgreSQL Orders Table:**
   - Customer App used an in-memory `authoritativeOrderStore`.
   - QCOM Backend has migration `004_create_orders_and_trips.sql` and `009_create_pricing_snapshots_and_rules.sql`.
   - **Resolution:** Persist migrated orders directly into PostgreSQL with full idempotency and state machine transitions.

---

## 9. Phased Migration Plan

### Phase 1: Preparation & Base Module Integration in QCOM Backend
1. Migrate `types.ts` data structures needed for orders, routing, invoices, and delivery economics into `QCOM/backend/src/types/`.
2. Migrate and integrate:
   - Maps & Routing module (`QCOM/backend/src/modules/routing/`)
   - Delivery Economics & Fulfilment Selection (`QCOM/backend/src/modules/delivery/`)
   - Invoice & PDF Generation (`QCOM/backend/src/modules/invoices/`)
   - AI Part Finder & Kit Planner service (`QCOM/backend/src/modules/ai/`)
   - Customer Profile & GSTIN service (`QCOM/backend/src/modules/customers/`)
   - Orders & Payments lifecycle service (`QCOM/backend/src/modules/orders/`, `QCOM/backend/src/modules/payments/`)

### Phase 2: Route Registration & Backward Compatibility Mounting
1. In `QCOM/backend/src/app.ts`, mount:
   - `/api/auth` (Customer & administrative auth)
   - `/api/profile` (Profile & saved GSTINs)
   - `/api/checkout` & `/api/pricing` (Consolidated pricing, geofences, commercial config)
   - `/api/orders` (Order creation, tracking, cancellation, delivery economics)
   - `/api/payment` (Payment intent & replay-protected verification)
   - `/api/routing` (Route calculation, rerouting, entrance correction, telemetry)
   - `/api/part-finder` & `/api/emergency-kit-planner` (Hardware assistance)

### Phase 3: Database & State Machine Hardening
1. Ensure all orders, payments, and profiles persist reliably in PostgreSQL.
2. Ensure fail-closed behavior (HTTP 503 + Retry-After: 3) is preserved when PostgreSQL is unavailable.
3. Ensure Idempotency-Key lifecycle (PROCESSING -> COMPLETED/FAILED) wraps order creation and payment verification.

### Phase 4: Test Suite Integration & Verification
1. Run existing Sprint 1–3.1 tests (`tests/run-all-tests.ts`) to ensure 0 regressions.
2. Add migration test suite (`tests/customer-backend-migration.test.ts`) covering:
   - Customer OTP & profile update
   - Authoritative pricing & 100m distance rounding
   - Seller geofencing & eligibility
   - Delivery economics contribution & subsidy check
   - Order creation & idempotency replay protection
   - Payment intent & HMAC signature verification
   - Multi-candidate routing & entrance snapping
   - Statutory invoice generation (PDF byte generation)
   - PostgreSQL failure 503 behavior
3. Verify Customer App frontend files remain 100% untouched (`CUSTOMER_FRONTEND_CHANGE_AUDIT.md`).
