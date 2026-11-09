# QCOM Platform — Product Requirements Document (PRD)

**Document Version:** 1.0.0 (Sprint 14.6 Release Baseline)  
**Status:** Approved / Active Baseline  
**Audience:** Engineering, Architecture, Product, Operations  

---

## 1. Executive Summary & Purpose

QCOM is a production-grade, hyper-local Quick Commerce (10-to-20 minute delivery) marketplace engineered specifically for the Indian retail ecosystem. The platform bridges urban consumers, neighborhood kirana/merchant stores (dark stores & partner merchant warehouses), freelance delivery riders, and central operations staff through four cohesive frontends backed by an authoritative, transactional engine.

The core mandate is **zero-inventory-oversell, tamper-proof statutory tax compliance (GST & TDS/TCS under Indian Law), mathematically balanced double-entry financial accounting, sub-second dispatch optimization, and high-concurrency resilience**.

---

## 2. The Four Applications

1. **Customer Web & Mobile PWA (`QCOM/customer-app`):**
   - Geofenced catalog browsing (100m coordinate precision).
   - Real-time stock availability with outbox-driven back-in-stock alerts.
   - Dynamic fee quotation (delivery, handling, surge, promotional discounts).
   - Order placement (Cash on Delivery / UPI / Card intents).
   - Live order tracking with second-by-second rider GPS telemetry over WebSockets.

2. **Seller / Merchant Warehouse Portal (`QCOM/seller-app`):**
   - Multi-tenant catalog and batch/inventory management.
   - Inbound order notifications and packing workflow transitions (`ORDER_PACKED`).
   - Store geofence and service radius management.
   - Statutory GSTIN configuration (Composition vs Regular scheme tax handling).
   - Daily settlement reports and payout reconciliation.

3. **Delivery Partner Rider App (`QCOM/delivery-app`):**
   - On-duty / off-duty toggle with live location heartbeat.
   - Trip broadcasts and atomic task acceptance (`WHERE status = 'BROADCASTING'`).
   - Turn-by-turn routing navigation from store to customer doorstep.
   - OTP delivery handshake with cash collection logging for COD orders.
   - Rider earnings ledger, incentive tracking, and payout disbursement status.

4. **Admin Central Operations Portal (`QCOM/admin-portal`):**
   - Real-time order monitoring across city micro-hubs.
   - Fleet oversight (active riders, cash limits, duty compliance).
   - Merchant compliance verification (GSTIN, legal entity validation).
   - Financial ledger inspection (General Ledger trial balance, TDS/TCS withholdings).
   - Automated & manual seller/rider payout batch releases.
   - Immutable security audit logs with request tracing.

---

## 3. User Roles & Permission Model

- **CUSTOMER:** End-user account bound to phone number OTP. Limited to own profile, orders, addresses, and subscribed stock alerts.
- **MERCHANT_ADMIN & MERCHANT_STAFF:** Store operators restricted strictly to their assigned merchant tenant (`merchant_id`).
- **DELIVERY_PARTNER:** Field rider authorized for duty toggle, accepting broadcast trips, and updating assigned delivery legs.
- **FINANCE_ADMIN & OPERATIONS_MANAGER:** Operational staff with permissions to manage settlements, dispatch overrides, and refunds.
- **SUPER_ADMIN:** Complete system oversight, permission management, and audit log inspection.

---

## 4. Core Business Workflows

1. **Checkout & Quoting:** Calculate distance-based delivery fees, rain/night surge, handling fees, and GST rates (CGST + SGST for intra-state; IGST for inter-state) with sub-cent BigNumber rounding.
2. **Order Placement & Stock Commitment:** Row-level locking (`SELECT ... FOR UPDATE`) prevents overselling. Stock reservations transition atomically to committed upon successful checkout.
3. **Dispatch & Assignment:** Proximity-based delivery trip broadcasting. Concurrency-safe atomic updates ensure a single rider claims the trip without race conditions.
4. **Fulfillment Handshake:** Dual-confirmation model: store handover token followed by customer delivery OTP verification.
5. **Settlement & Payouts:** Post-delivery financial posting into immutable double-entry ledgers (`journal_entries`), statutory withholding calculation (1% TDS u/s 194-O, 0.5% GST-TCS u/s 52), and idempotent payout release.

---

## 5. Non-Functional Requirements & Invariants

- **Zero-Oversell Invariant:** Stock deductions and selective reservations are strictly serialized in PostgreSQL transactions.
- **Statutory Financial Integrity:** Every transaction adheres to double-entry bookkeeping (Debits == Credits). Ledger entries are append-only.
- **Idempotent Webhook Processing:** Webhooks from payment or banking gateways are recorded durably with unique constraints on `event_id` and idempotent state transitions.
- **Fail-Safe Offline Mode:** In the absence of live third-party gateway credentials, payments fail safely (`HTTP 400 Bad Request`) without ghost authorizations or false captures.
- **Data Protection & Privacy:** No plaintext tokens, OTPs, or credentials in browser `localStorage`, URLs, or application logs.
