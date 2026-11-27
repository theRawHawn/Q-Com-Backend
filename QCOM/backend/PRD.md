# QCOM Platform — Product Requirements Document (PRD)

**Document Version:** 1.2.0 (Sprint 16.1 Staging Verified Baseline)  
**Status:** Approved for Staging (Gateway & Statutory Tax Counsel Sign-offs Pending Production)  
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

1. **Checkout & Quoting:** Calculate distance-based delivery fees, handling fees, coupon/promotion splits, and GST/Cess (`tax_inclusive`/`tax_exclusive`; CGST + SGST intra-state vs. IGST inter-state via `indian_states`) with `bignumber.js` rounding and single-use quote (`409 PRICE_CHANGED`/`QUOTE_EXPIRED`) validation.
2. **Order Placement & Stock Commitment:** Row-level locking (`SELECT ... FOR UPDATE`) serializes inventory stock, user `first_order_only` constraints, and coupon/promotion redemption slots without overselling or over-redemption.
3. **Dispatch & Assignment:** Proximity-based delivery trip broadcasting. Concurrency-safe atomic updates ensure a single rider claims the trip without race conditions.
4. **Fulfillment Handshake & COD Custody:** Dual-confirmation customer delivery OTP handshake with server-derived COD collection tracking and 3-stage separation-of-duties cash remittance (`SUBMITTED -> RECEIVED -> VERIFIED`).
5. **Settlement, Returns & Credit Notes:** Post-delivery posting into immutable double-entry ledgers (`LEDGER_IMMUTABLE`, including COA `5040` subsidy grant and return reversal), statutory withholding (Sec 194-O / 393 & Sec 52 GST-TCS), sequential prorated partial/full returns with crash-safe QC recovery, and GST Credit Notes (`irn: null` unless IRP enabled).

---

## 5. Non-Functional Requirements & Invariants

- **Zero-Oversell & Single-Use Slot Invariants:** Stock deductions, coupon/promotion slots, and checkout quotes are strictly serialized in PostgreSQL 16 transactions.
- **Statutory Financial Integrity:** Every transaction adheres to double-entry bookkeeping (Debits == Credits), append-only immutable ledgers, and read-only Checks 1–14J reconciliation.
- **Gateway-Neutral & Fail-Closed Tax Compliance:** No payment gateway is hardcoded by design; products/services missing verified HSN/SAC or active `statutory_tax_rules` fail closed (`422`) with zero guessed tax rates or fabricated IRNs.
- **Data Protection & Privacy:** No plaintext tokens, OTPs, or credentials in browser `localStorage`, URLs, or application logs.
