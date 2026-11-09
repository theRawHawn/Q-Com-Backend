# QCOM GST, Invoicing & Tax Architecture Specification

**Document Version:** 3.0.0 (Phase 0.5 Final Correction Pass — September 2026)  
**Statutory Frameworks:** 
- Central Goods and Services Tax (CGST) Act, 2017 & State GST (SGST) Acts
- Integrated Goods and Services Tax (IGST) Act, 2017
- Section 52 of CGST Act, 2017 (Tax Collection at Source - GST-TCS by E-Commerce Operators)
- **Income-tax Act, 2025 (Effective 1 April 2026):** Consolidated TDS provisions under **Section 393**, including Section 393(1), Table 8(v) for e-commerce operators/participants, and corresponding transport/logistics items
- **Income-tax Act, 1961 (Applicable for transactions prior to 1 April 2026):** Sections 194-O, 194-C, 206AA, 206AB

---

## 1. 2026 Statutory Reality: Income-tax Act, 2025 & Section 393 Consolidation

> **CRITICAL ARCHITECTURAL DIRECTIVE:**  
> As of September 2026, the Indian direct tax regime is governed by the **Income-tax Act, 2025** (effective from 1 April 2026). The legacy Income-tax Act, 1961 sections (such as 194-O, 194-C, 206AA) are consolidated into **Section 393** and corresponding tables.
> 
> Under no circumstances may old statutory section numbers or fixed tax percentages be hardcoded into database column names or source code.

### 1.1 Transition Architecture: Dual-Regime Resolution by Effective Date
The withholding engine determines the governing statute and provision dynamically based on transaction timestamp:

```
[Transaction Date]
         │
         ├── Before 01-Apr-2026 ──> Governing Law: Income-tax Act, 1961
         │                          - E-Commerce Sales: Section 194-O
         │                          - Logistics/Contractors: Section 194-C
         │                          - Higher Withholding: Section 206AA / 206AB
         │
         └── On/After 01-Apr-2026 ─> Governing Law: Income-tax Act, 2025
                                    - E-Commerce Sales: Section 393(1), Table 8(v)
                                    - Logistics/Contractors: Section 393 Corresponding Items
                                    - Higher Withholding: Section 393 / New Act Provisions
```

### 1.2 Rule-Driven Higher Rate Resolution (No Hardcoded "5% if No PAN")
Rather than simplistic shortcuts (`if (!pan) rate = 5%`), the tax engine executes a multi-factor statutory resolution chain:

```
Payee Profile (Merchant / Rider)
         │
         ▼
[PAN Status Verification] ── (VALID, INVALID, MISSING, INOPERATIVE)
         │
         ▼
[Aadhaar / PAN Linking Verification]
         │
         ▼
[Constitution of Payee] ───── (INDIVIDUAL, HUF, COMPANY, FIRM_LLP)
         │
         ▼
[Transaction Type] ────────── (ECO_SALE_OF_GOODS, LOGISTICS_CARRIAGE)
         │
         ▼
[Statutory Threshold Check] ─ (FY Aggregate vs Statutory Limit)
         │
         ▼
[Resolve Active Rule from statutory_withholding_rules]
(Matches: effective_from <= txn_date < effective_to, law, provision, payee_type, pan_status)
         │
         ▼
[Authoritative Statutory Rate & Base Determined]
```

---

## 2. Versioned GST-TCS (Section 52) Engine

The Section 52 GST-TCS rate is NOT treated as a permanent constant (e.g. fixed 0.5% or 1.0%). CBIC rules are fully versioned in `statutory_tax_rules` and `statutory_withholding_rules`:

```sql
-- Versioned GST-TCS Rule Structure
CREATE TABLE gst_tcs_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_code VARCHAR(60) NOT NULL,
    statutory_act VARCHAR(80) NOT NULL DEFAULT 'CGST_ACT_2017_SEC_52',
    effective_from DATE NOT NULL,
    effective_to DATE,
    central_rate_percent NUMERIC(5,3) NOT NULL,    -- e.g. 0.250% or 0.500%
    state_rate_percent NUMERIC(5,3) NOT NULL,      -- e.g. 0.250% or 0.500%
    integrated_rate_percent NUMERIC(5,3) NOT NULL, -- e.g. 0.500% or 1.000%
    calculation_basis VARCHAR(60) NOT NULL DEFAULT 'NET_TAXABLE_SUPPLIES',
    reporting_form VARCHAR(40) NOT NULL DEFAULT 'GSTR-8',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_gst_tcs_effective UNIQUE(rule_code, effective_from)
);
```

### Calculation Base: Net Taxable Supplies
$$\text{Net Taxable Supplies} = \sum (\text{Taxable Value of Delivered Goods}) - \sum (\text{Taxable Value of Returned Supplies})$$
*Note: GST charged by the merchant is statutorily excluded from the TCS calculation base.*

---

## 3. Product GST & SAC Services Architecture

### 3.1 Statutory Goods Classifications (Hardware & Spares)
All product SKUs map to an authoritative HSN code:
- **HSN 7318 (18%)**: Screws, bolts, nuts, rivets, threaded fasteners
- **HSN 8481 (18%)**: Brass angle valves, bib cocks, plumbing manifolds
- **HSN 8536 (18%)**: Modular electrical switches, MCBs, contactors
- **HSN 8544 (18%)**: Insulated copper cables, multi-strand flexible wires
- **HSN 8708 (28%)**: Automotive braking systems, clutch plates, suspension spares
- **HSN 2710 (18%)**: Engine lubricants, gear oils, brake fluids
- **HSN 8467 (18%)**: Hand-held power tools, rotary hammer drills, angle grinders
- **HSN 6804 (18%)**: Diamond cutting wheels, abrasive grinding discs

### 3.2 Platform Services SAC Classifications
- **SAC 9968 (18%)**: Delivery & express logistics charges
- **SAC 9985 (18%)**: Support services, handling & convenience fee
- **SAC 9983 (18%)**: Marketplace intermediation / commission fee

### 3.3 Dynamic Intra/Inter-State Tax Split
- **Intra-State Supply** (`merchant_state_code == place_of_supply`):
  $$\text{CGST} = \text{Taxable Amount} \times \frac{\text{Rate}}{2}, \quad \text{SGST} = \text{Taxable Amount} \times \frac{\text{Rate}}{2}$$
- **Inter-State Supply** (`merchant_state_code != place_of_supply`):
  $$\text{IGST} = \text{Taxable Amount} \times \text{Rate}, \quad \text{CGST} = 0, \quad \text{SGST} = 0$$

---

## 4. B2B Invoicing & Customer Input Tax Credit (ITC)

1. **GSTIN Checksum & State Validation**:
   - 15-character format: `^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$`
   - State code (first 2 digits) matched against Place of Supply.
2. **ITC Claimability Rules**:
   - B2B registered contractor with valid GSTIN: `itc_claimable = total_gst`
   - B2C / Unregistered consumer: `itc_claimable = 0.00`
3. **E-Invoicing Readiness**:
   - Fields stored for `IRN`, `acknowledgement_number`, `acknowledgement_date`, and `signed_qr_code` for qualifying enterprise merchants.
