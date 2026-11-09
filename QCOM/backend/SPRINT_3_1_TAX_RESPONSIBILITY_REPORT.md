# SPRINT 3.1 & ZERO-HARDCODING AUDIT REPORT: REAL-LIFE DATA-DRIVEN ENGINE

**Date**: September 27, 2026  
**Platform**: QCOM Unified Quick Commerce Platform  
**Target Specification**: Phase 0.5 Sprint 3 & Sprint 3.1 — Zero Hardcoded Amounts Guarantee  
**Engine Version**: 3.0.0  
**Verification Status**: FULLY DYNAMIC & VERIFIED (All 15 Integration Test Gates Passing)

---

## 1. Zero-Hardcoding Core Architecture

Every single monetary figure, tax percentage, logistics slab, distance calculation, discount, and statutory deduction is dynamically resolved from PostgreSQL database tables. There are **zero hardcoded prices, fees, rates, or promotional thresholds in application source code**.

| Value / Dimension | Authoritative Database Source Table | Resolution Mechanism |
| :--- | :--- | :--- |
| **Product Selling Price** | `store_inventory.selling_price` | Picked from live store inventory row for that merchant. |
| **Product MRP** | `store_inventory.original_mrp` | Picked from live store inventory row for that merchant. |
| **Seller Goods GST Rate & HSN** | `seller_product_tax.gst_rate_percent`, `hsn_code` | Versioned seller declaration; fallback to `products` catalogue. |
| **GST Slabs Validation** | `statutory_tax_rules.gst_rate_percent` | Validated against active government rules in DB (`SELECT DISTINCT`). |
| **Coupons & Discounts** | `coupons` table (Migration 011) | Dynamic DB query: discount type, value, min order, and max discount cap. |
| **Delivery Base Fee & Excess Pay**| `pricing_delivery_rules.base_fee_inr`, `per_km_fee_inr` | Date-effective database lookup; fails closed if no rule configured. |
| **Base Distance Threshold** | `pricing_delivery_rules.base_distance_km` | Date-effective database lookup. |
| **Free Delivery Order Value** | `pricing_delivery_rules.free_delivery_threshold_inr`| Date-effective database lookup. |
| **Handling & Packaging Fee** | `pricing_delivery_rules.handling_fee_inr` | Date-effective database lookup. |
| **Delivery Distance (km)** | `saved_addresses` & `merchants` GPS coordinates | Real-life Haversine distance from customer coordinates to store. |
| **Place of Supply State** | `saved_gstins.state_code` / `saved_addresses` | Customer registered state code; fallback to merchant store state. |
| **Delivery GST (SAC 9968)** | `statutory_tax_rules` (`DELIVERY_GST`) | Dynamic lookup by tax type; SAC code and rate read from database. |
| **Handling GST (SAC 9985)** | `statutory_tax_rules` (`HANDLING_GST`) | Dynamic lookup by tax type; SAC code and rate read from database. |
| **Commission GST (SAC 9983)** | `statutory_tax_rules` (`COMMISSION_GST`) | Dynamic lookup by tax type; SAC code and rate read from database. |
| **Merchant Commission Rate** | `merchants.commission_rate_percent` | Contractually configured merchant fee percentage in PostgreSQL. |
| **Section 52 GST-TCS Rate** | `gst_tcs_rules` | Date-effective statutory rate and reporting form (`GSTR-8`). |
| **Section 393 Withholding TDS** | `statutory_withholding_rules` | Date-effective rule by PAN status and constitution type (`Form 26Q`). |

---

## 2. Dynamic Coupon & Promotional Engine (Migration 011)

All hardcoded coupon codes have been replaced with a dynamic database schema:
```sql
CREATE TABLE coupons (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(40) UNIQUE NOT NULL,
    description TEXT,
    discount_type VARCHAR(20) NOT NULL CHECK (discount_type IN ('FLAT_AMOUNT', 'PERCENTAGE')),
    discount_value NUMERIC(10,2) NOT NULL CHECK (discount_value > 0),
    min_order_value_inr NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    max_discount_inr NUMERIC(10,2),
    applicable_merchant_id UUID REFERENCES merchants(id) ON DELETE CASCADE,
    valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    valid_to TIMESTAMPTZ,
    is_active BOOLEAN NOT NULL DEFAULT TRUE
);
```

- When `couponCode` is provided, `pricingEngine` queries `coupons` table matching date, validity, and merchant scope.
- New coupons inserted into PostgreSQL (e.g. `FESTIVE25` @ 25% off up to ₹150) immediately take effect dynamically without modifying or redeploying engine code.

---

## 3. Real-Life Distance & GPS Spatial Calculation

Instead of fixed or arbitrary distance numbers:
1. If client supplies `distanceKm`: used directly.
2. If client supplies `customerLocation`: calculates Haversine distance between customer coordinates and merchant store coordinates.
3. If user is authenticated (`userId`): queries `saved_addresses` for customer's real registered jobsite coordinates and calculates exact Haversine distance to the merchant hub.
4. Fallback: Uses `base_distance_km` from the database `pricing_delivery_rules` table.

---

## 4. Contractual Real-Life Merchant Settlement (`calculateMerchantSettlement`)

Calculates exact net settlement pulling live contract terms from the database:
- Reads `merchants.commission_rate_percent` (e.g. 15.00%).
- Resolves active `COMMISSION_GST` statutory rule (18.00% under SAC 9983).
- Resolves active `gst_tcs_rules` for Section 52 TCS.
- Resolves active `statutory_withholding_rules` for Section 393 TDS.

Example on ₹2,000.00 Taxable Order (GST @ 18% = ₹360.00):
$$\begin{aligned}
\text{Seller Gross Proceeds} &= ₹2,000.00 + ₹360.00 = ₹2,360.00 \\
\text{Less: Merchant Commission (15\% of ₹2,000)} &= -₹300.00 \\
\text{Less: GST on Commission (18\% of ₹300)} &= -₹54.00 \\
\text{Less: Section 52 GST-TCS (0.50\% of ₹2,000)} &= -₹10.00 \\
\text{Less: Section 393 TDS (0.10\% of ₹2,000)} &= -₹2.00 \\
\hline
\mathbf{Net\ Merchant\ Settlement} &= \mathbf{₹1,994.00}
\end{aligned}$$

---

## 5. Verification Gate Summary

All 15 test suites across Sprints 1, 2, 3, and 3.1 pass cleanly:
```
--- Running Centralized Pricing, GST & Tax Engine Test Suite (Sprint 3 & 3.1) ---
✓ Financial precision and statutory Half-Up rounding edge cases verified
✓ Client price, tax, and grand total tampering successfully blocked and overridden by DB authority
✓ Dynamic Intra-state (CGST+SGST) and Inter-state (IGST) split verified
✓ Effective-dated rule resolution, TAX_RULE_NOT_FOUND, and TAX_RULE_CONFLICT verified
✓ Deterministic delivery and handling calculations with SAC codes verified
✓ Section 52 GST-TCS and Income-tax Act 2025/1961 dynamic withholding verified
✓ Calculation snapshot persisted in PostgreSQL and reproducibly retrieved
✓ Idempotency-Key replay protection verified
✓ Unauthenticated (401), Revoked session (401), and Cross-Customer quote isolation (403) verified
✓ Administrative rules pagination, filtering, and RBAC permission checks verified
✓ Seller product GST classification, non-standard slab admin flagging, and tenant defense verified
✓ Strict 3-Bucket architectural separation verified in pricing output
✓ Contractual settlement formula (₹1,000 + ₹180 - ₹100 - ₹18 = ₹1,062) verified
✓ Historical order tax snapshot remains completely frozen and immutable
✓ Real-life merchant settlement dynamically derived from live database records without hardcoding
✓ Real-life Haversine distance dynamically calculated from customer saved address: Express Delivery Fee (0.6 km)
===========================================================
✓ ALL SPRINT 1, 2 & 3 TESTS PASSED SUCCESSFULLY in 5.07s!
===========================================================
```
