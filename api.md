# QCOM API Specification & Actor Boundary Contracts

**Document Version:** 2.0.0 (Phase 0.5 Validation Pass)  
**Protocol:** HTTPS RESTful JSON & WSS Real-Time Streams  
**Mandatory Headers:**  
- `Authorization: Bearer <token>`  
- `Idempotency-Key: <uuid>` (Enforced on all state-changing financial mutations)  
- `Content-Type: application/json`  

---

## 1. Customer APIs (`/api/*`)

### 1.1 Authentication & Profile
- `POST /api/auth/request-otp` — `{ phone: string }`
- `POST /api/auth/verify-otp` — `{ phone: string, otp: string, name?: string }`
- `GET /api/profile` / `PUT /api/profile` — Manages profile and default trade persona.
- `POST /api/profile/saved-gstin` — Saves 15-character GSTIN for B2B tax invoicing.

### 1.2 Authoritative Pricing & Quote (Zero-Trust)
- `POST /api/checkout/quote`
  - Input: Cart items, delivery coordinates, coupon code, B2B GSTIN.
  - Calculation: Resolves HSN product GST, delivery SAC 9968 (18%), handling SAC 9985 (18%), rounds distance to nearest 100m, applies coupons, computes CGST/SGST/IGST split.
  - Output: Authoritative payable total with itemized tax and distance audit breakdown.

### 1.3 Orders & Tracking
- `POST /api/orders/create` (Requires `Idempotency-Key`)
  - Executes atomic inventory reservation lock, stores immutable pricing snapshot, creates order, generates 4-digit PIN OTP and seller handover token.
- `GET /api/orders` / `GET /api/orders/:id`
  - Returns order details, invoice download link, and tracking status.
- `POST /api/orders/:id/cancel`
  - Allowed only in `placed` status. Releases stock locks atomically.

---

## 2. Admin Operations & Governance APIs (`/api/admin/*`)

### 2.1 Session & RBAC
- `POST /api/admin/auth/session` — Authenticates employee code and returns granular `effectivePermissions`.
- `POST /api/admin/auth/switch-persona` — Allows Super Admin persona simulation.

### 2.2 Dynamic Tax & Withholding Rules Governance
- `GET /api/admin/tax-rules` / `POST /api/admin/tax-rules`
  - Manages versioned GST slabs (`statutory_tax_rules`) with `effective_from` and `effective_to`.
- `GET /api/admin/withholding-rules` / `POST /api/admin/withholding-rules`
  - Manages versioned Section 52 GST-TCS, Section 194-O TDS, and Section 194-C TDS rules.
- `GET /api/admin/reports/gstr8`
  - Generates GSTR-8 report of net taxable supplies and TCS collected for monthly GST filing.
- `GET /api/admin/reports/form26q`
  - Generates quarterly Form 26Q dataset of TDS deducted under Section 194-O and 194-C.

### 2.3 Double-Entry General Ledger & Finance
- `GET /api/admin/finance/general-ledger`
  - Returns paginated immutable journal entries across all 15 Chart of Accounts.
- `GET /api/admin/finance/trial-balance`
  - Computes real-time trial balance ensuring $\sum \text{Debits} == \sum \text{Credits}$.
- `POST /api/admin/settlements/:id/process` (Permission: `settlements.process`)
  - Initiates net merchant settlement with Section 52 and 194-O withholding deductions.
- `POST /api/admin/riders/bulk-release-payout` (Permission: `riders.payout`)
  - Releases batch IMPS transfers for cleared rider earnings.

### 2.4 Fleet, Dispatch & Dispute Room
- `GET /api/admin/orders` / `POST /api/admin/orders/:id/assign-rider`
- `GET /api/admin/riders` / `POST /api/admin/riders/:id/toggle-payout-hold`
- `POST /api/admin/refunds/create` / `POST /api/admin/refunds/:id/approve`

---

## 3. Seller Merchant APIs (`/api/seller/*`)

### 3.1 Live Prep Queue & Handover
- `GET /api/seller/orders` — Live order stream filtered by store.
- `POST /api/seller/orders/:id/accept` — Transitions state to `picking`; starts 8-min SLA countdown.
- `POST /api/seller/orders/:id/packed` — Staff seals bag; reveals `PK-XXXX` handover token.
- `POST /api/seller/orders/:id/handover` — Verifies physical rider presence and completes handover.

### 3.2 Inventory & Bin Locations
- `GET /api/seller/catalog` — Store catalog with aisle/bin locations.
- `POST /api/seller/inventory/stock-update` — Concurrency-safe atomic stock count modification.
- `POST /api/seller/returns/:id/restock` — Restocks returned unopened parcels.

### 3.3 Financial Ledger & Instant IMPS
- `GET /api/seller/earnings` — Gross GMV, commission, GST on commission, GST-TCS, TDS 194-O, and net balance.
- `POST /api/seller/settlement/request-instant` (Requires `Idempotency-Key`)
  - Dispatches immediate IMPS bank payout for cleared balance.

---

## 4. Delivery Partner APIs (`/api/qrider/*` or `/api/delivery/*`)

### 4.1 Duty & Gig Shifts
- `POST /api/qrider/duty-status` — Enforces battery $\ge 15\%$, GPS accuracy, and floating cash $< ₹2,500$.
- `POST /api/qrider/shifts/book` — Reserves 3-hour shift slot (08:00 AM – 08:00 PM).

### 4.2 Task Lifecycle & Multi-Mode Verification
- `POST /api/delivery/delivery/claim` (Atomic CAS claim — CWE-362)
- `POST /api/delivery/orders/:id/advance-stage` (`ACCEPTED` $\to$ `ARRIVED_AT_PICKUP` $\to$ `PICKED_UP` $\to$ `ARRIVED_AT_DROP`)
- `POST /api/delivery/orders/:id/verify-otp` — Validates 4-digit customer PIN OTP.
- `POST /api/qrider/tasks/:id/contactless-proof` — Ingests photo with EXIF timestamp and GPS watermark.

### 4.3 COD Reconcile & Floating Cash Remittance
- `POST /api/qrider/cod/reconcile` (Reconciles against authoritative order due — CWE-602)
- `GET /api/qrider/cod/qr-code` — Generates dynamic UPI QR code for instant cash liability remittance.
- `POST /api/qrider/cod/remit-online` — Remits collected cash via UPI/IMPS and debits floating liability.
- `POST /api/qrider/payouts/withdraw` (Instant UPI withdrawal — CWE-840, Requires `Idempotency-Key`)
- `POST /api/qrider/telemetry/location` (GPS velocity sanity filter $\le 120\text{ km/h}$ — CWE-20 & CWE-862)

---

## 5. Telephony & Privacy Proxy APIs (`/api/telephony/*`)

- `POST /api/telephony/mask-call`
  - Request: `{ orderId: string, callerType: 'RIDER' | 'CUSTOMER' }`
  - Action: Initiates dual-legged outbound bridge via IVR provider. Neither party's real phone is disclosed (DPDP Act compliance).
