# QCOM Persistent Project Memory & Architecture Decision Records (ADR)

**Ecosystem:** Quick Commerce for Industrial Hardware & Automotive Spares  
**Canonical Truth:** The 4 frontends (`customer-app`, `admin-portal`, `seller-app`, `delivery-app`) serve as authoritative specifications for UI contracts, business rules, and security remediations.  
**Validation Pass:** Phase 0.5 Complete  

---

## 1. Architectural Decision Records (ADRs)

### ADR-001: Consolidated Backend Architecture
- **Decision:** Consolidate disparate backend fragments into a unified, high-performance Node.js/Express service located in `QCOM/backend`.
- **Rationale:** Prevents data divergence between merchant inventory, customer orders, rider assignments, and admin oversight. Ensures atomic transactions and single-source financial ledgers.

### ADR-002: Zero-Trust Authoritative Pricing
- **Decision:** Pricing, delivery fees, taxes, discounts, and order totals are calculated exclusively on the backend. Frontend prices are treated solely as informational previews.
- **Rationale:** Blocks price manipulation attacks (CWE-602) where attackers tamper with request payloads to purchase high-value power tools for ₹1.

### ADR-003: Deterministic Distance Rounding
- **Decision:** All distance-based delivery calculations must apply the formula:
  $$\text{rounded\_distance\_m} = \left\lfloor \frac{\text{actual\_distance\_m} + 50}{100} \right\rfloor \times 100$$
- **Rationale:** Guaranteed consistency across pricing quotes, audit suites, and rider compensation receipts.

### ADR-004: Versioned Statutory Tax Engine (No Hardcoded Rates)
- **Decision:** All statutory percentages (GST slabs, Section 52 GST-TCS, Section 194-O TDS, Section 194-C TDS) are resolved dynamically from `statutory_tax_rules` and `statutory_withholding_rules` based on transaction date, constitution type, and PAN validity.
- **Rationale:** Indian tax laws change frequently (e.g., Section 194-O reduced from 1% to 0.1% on Oct 1, 2024; Section 52 TCS reduced from 1% to 0.5% on July 10, 2024; Section 206AA penal rates for non-PAN). Hardcoding rates directly violates statutory compliance.

### ADR-005: Section 52 GST-TCS Mandatory Collection
- **Decision:** Platform acts as an E-Commerce Operator (ECO) under Section 52 of the CGST Act, deducting 0.5% (or active statutory rate) on Net Taxable Supplies and reporting monthly via Form GSTR-8.
- **Rationale:** Mandatory statutory obligation for all e-commerce marketplaces collecting consideration in India.

### ADR-006: Double-Entry General Ledger with Chart of Accounts
- **Decision:** Financial balances (merchant earnings, rider wallets, customer escrow, tax payables) are maintained using double-entry journal entries with 15 standard Chart of Accounts.
- **Rationale:** Guarantees that every monetary transaction preserves the invariant $\sum \text{Debits} == \sum \text{Credits}$. Eliminates silent balance leakage and provides an auditable trial balance.

### ADR-007: Supabase PostgreSQL as Durable Source of Truth & Redis as Ephemeral Layer
- **Decision:** Supabase PostgreSQL + PostGIS is the sole durable source of truth. Redis is strictly an ephemeral accelerator for distributed mutexes, rate limiting, and Pub/Sub.
- **Rationale:** Prevents catastrophic data loss if Redis restarts. Complies with Supabase ₹0 free-tier constraints by avoiding raw second-by-second telemetry storage on Postgres disk.

### ADR-008: Tamper-Evident Packaging & Delivery Verification
- **Decision:** Store staff pack items into tamper-evident bags; delivery riders verify bag count and handover token `PK-XXXX` without viewing customer items. Delivery requires customer 4-digit PIN OTP or geotagged photo proof.
- **Rationale:** Protects customer privacy, eliminates part pilferage, and provides indisputable proof of delivery.

### ADR-009: Operating Window & 12-Hour Shift Structure
- **Decision:** Operational hours run strictly from **08:00 AM to 08:00 PM** across 4 structured 3-hour shifts:
  1. Morning Contractor Rush: 08:00 AM – 11:00 AM
  2. Midday Garage Peak: 11:00 AM – 02:00 PM
  3. Afternoon Spares Run: 02:00 PM – 05:00 PM
  4. Evening Maintenance Surge: 05:00 PM – 08:00 PM
- **Rationale:** Reflects trade hours of hardware markets and auto repair workshops.

### ADR-010: Zero-API-Key Mapping Architecture
- **Decision:** Use OpenStreetMap tile servers (`https://tile.openstreetmap.org/{z}/{x}/{y}.png`) and open OSRM routing engine with dual accessible entrance pins.
- **Rationale:** Eliminates external map API keys, vendor billing dependencies, and watermark issues.
