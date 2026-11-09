# QCOM SPRINTS 1–3 ARCHITECTURE REPAIR & BUSINESS-MODEL AUDIT REPORT

**Date**: September 27, 2026  
**Auditor**: Lead Systems & Security Architect  
**Target Specification**: QCOM Final Business Model Alignment & Pre-Sprint 4 Verification  
**Repository Components**: `QCOM/backend/`, `QCOM/customer-app/`, `QCOM/admin-portal/`, `QCOM/delivery-app/`  
**Classification**: High-Priority Business Model & Architecture Alignment  

---

## 1. Locked Final Business Model

QCOM is explicitly a **Seller-Owned Marketplace and Quick-Commerce Aggregator**.

| Attribute | Final QCOM Model | Antipatterns Rejected |
| :--- | :--- | :--- |
| **Product Ownership** | **Seller / Merchant** owns all goods. | Dark-store inventory, QCOM-owned warehouses, QCOM purchase orders. |
| **Catalog & Pricing** | **Seller** defines SKU, product name, selling price, HSN, and GST rate. | Platform arbitrarily setting product prices or inventing product tax rates. |
| **Availability & Stock** | **Seller** maintains availability; order acceptance determines fulfillment. | Centralized atomic stock reservation, CAS mutex locks, checkout stock decrements. |
| **QCOM Platform Role** | Discovery, Cart, Checkout, Pricing, Payments, Delivery Orchestration, Financial Ledger, Commission. | Merchandising, warehouse storage, dark-store replenishment. |
| **Customer Journey** | Browse → Product → Add to Cart → Cart → Checkout → Pay → Track. | Customer-facing "Request Quote", "Generate Quote", or "Ask Seller for Quote". |
| **"Quote" Semantics** | **Internal Implementation Object Only** (Checkout calculation & snapshot). | B2B quote negotiation, quote acceptance/expiry workflows. |

---

## 2. Repository Audit Findings (7 Core Dimensions)

### 2.1 What Already Works
1. **Relational Database Foundation**: PostgreSQL serves as the authoritative source of truth for all users, merchants, stores, products, orders, ledger entries, and audit logs across migrations `001` through `011`.
2. **Session Security (Sprint 2)**: Hybrid cryptographic JWT transport + authoritative PostgreSQL session ledger (`auth_sessions`). Revocation is instantaneous; Redis outages fail closed without bypassing session or permission checks.
3. **Double-Entry Financial Ledger**: Chart of Accounts (`general_ledger_accounts`) and journal entries (`general_ledger_entries`) enforce balanced DEBIT == CREDIT rules. No simple balance increment shortcuts.
4. **Financial Decimal Precision**: Authoritative `money.ts` module with `BigNumber.js` configured with Indian statutory `ROUND_HALF_UP` to 2 decimal places. Floating-point arithmetic is strictly forbidden.
5. **Effective-Dated Tax Architecture**: Versioned tables for `statutory_tax_rules` (QCOM services), `gst_tcs_rules` (Section 52), and `statutory_withholding_rules` (Section 393 under Income-tax Act 2025 vs legacy Section 194-O under Income-tax Act 1961).
6. **Sprint 3.1 Separation**: Migration `010_create_seller_product_tax.sql` isolates Seller's Goods GST from QCOM's own fees and statutory collections.
7. **Frontend Applications**: Customer app and Admin portal build cleanly in Vite without unresolved errors.

### 2.2 What Is Inconsistent
1. **Checkout Endpoint Naming**: The endpoint was named `/pricing/quote`, creating conceptual ambiguity with quotation workflows.  
   *Fix*: Alias `/api/v1/checkout/calculate` alongside `/api/v1/pricing/quote` and explicitly document `quote` as an internal checkout pricing calculation snapshot.
2. **Delivery Distance Fallback**: In early iterations, a 2.5 km static fallback was used if distance was omitted.  
   *Fix*: Fully dynamically resolved via Haversine formula from `saved_addresses` and `merchants` GPS coordinates.

### 2.3 What Is Dangerous (Identified & Remediated)
1. **Database Outage Behavior (Section 5 Failure Rule)**:  
   *Hazard*: If PostgreSQL is unavailable while creating a critical transaction, unhandled exceptions could return generic 500 errors or tempt silent queuing in Redis.  
   *Remediation*: Implement strict database outage detection: on DB unavailability, the server returns **HTTP 503** with header **`Retry-After: 3`** and error **`DATABASE_UNAVAILABLE`**. The client must retry using the same `Idempotency-Key`. Never create ghost orders in Redis.

### 2.4 What Violates the Marketplace Model (Identified & Remediated)
1. **Dark-Store CAS Stock Reservation Algorithm in `inventory.md`**:  
   *Violation*: `inventory.md` described an "Atomic Stock Reservation Algorithm (CAS)" acquiring distributed locks and decrementing `stock_count` on checkout order placement.  
   *Remediation*: Rewrite `inventory.md` and `QCOM/backend/inventory.md`. Stock is seller-owned. Availability is verified against seller store indicators; fulfillment is determined by seller order acceptance, not QCOM dark-store reservation.
2. **Customer-App Server Mock Reservation in `store.ts` & `routes/orders.ts`**:  
   *Violation*: `authoritativeProductStore.reserveStock()` in `customer-app/server/store.ts` acquired mutex locks and mutated `prod.stockCount -= item.quantity`.  
   *Remediation*: Replace `reserveStock()` with `verifySellerAvailability()`. Remove atomic decrements; seller availability is read-only from the seller's catalog.

### 2.5 What Needs Migration
- Schema migrations `001` through `011` are structurally sound, idempotent, and verified.
- The `store_inventory` table represents **seller-managed store availability**, not QCOM-owned inventory.

### 2.6 What Needs Tests
Implement the **9 mandatory business-model test cases** specified in Section 40:
- **Test 1 — Seller product**: Seller creates Product = ₹1,000 with applicable GST. Customer sees correct calculated product amount.
- **Test 2 — Seller tax change**: Seller changes product GST after order; historical order uses frozen snapshot.
- **Test 3 — QCOM fee**: Delivery fee taxation calculated independently from seller product GST.
- **Test 4 — Seller commission**: Commission represented as a seller/QCOM financial event, not confused with product GST.
- **Test 5 — Marketplace TCS**: Section 52 GST-TCS represented separately from product GST.
- **Test 6 — Income-tax transition**: Pre-01-Apr-2026 uses 1961 Act, Post-01-Apr-2026 uses 2025 Act Section 393 via effective-dated configuration.
- **Test 7 — Missing tax rule**: No matching rule → `TAX_RULE_NOT_FOUND` (HTTP 422), never silent 0%.
- **Test 8 — Conflicting tax rules**: Multiple conflicting active rules → `TAX_RULE_CONFLICT` (HTTP 409).
- **Test 9 — PostgreSQL failure**: Critical transaction during DB outage → **HTTP 503** with **`Retry-After: 3`** and identical Idempotency-Key retry instructions. Never ghost order in Redis.

### 2.7 What Should NOT Be Changed
- The hybrid JWT + PostgreSQL session authority model.
- Double-entry general ledger architecture.
- BigNumber decimal money arithmetic.
- Dynamic RBAC and tenant ownership checks.
- Frontend quick-commerce flow (Browse → Cart → Checkout → Pay).
