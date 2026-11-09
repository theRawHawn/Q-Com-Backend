# QCOM Quick Commerce Platform — Master Product Document (PRD)

**Document Version:** 1.0.0  
**Domain:** Hyper-Local B2B & B2C Quick Commerce for Industrial Hardware, Electrical, Plumbing, Carpentry, and Automotive Spares  
**Ecosystem Applications:** Customer App, Admin Control Portal, Seller Merchant App, Delivery Partner App, Unified Backend Engine  
**Operating Hours:** 08:00 AM – 08:00 PM (12-Hour Daily Window, 4 Distinct 3-Hour Shifts)  

---

## 1. Product Vision & Ecosystem Overview

QCOM is an ultra-fast on-demand commerce ecosystem engineered specifically for the construction, trades, renovation, and automotive repair sectors. Unlike conventional grocery or FMCG quick commerce platforms, QCOM solves the high-cost problem of **jobsite downtime**: when an electrician, plumber, contractor, or mechanic runs out of critical components (valves, MCBs, fasteners, diamond cutting discs, engine oil, brake pads), leaving the jobsite incurs heavy labor losses and project delays.

QCOM connects contractors, tradespeople, mechanics, and individual consumers with vetted local hardware merchants, authorized dark stores, and an optimized EV/cargo fleet capable of delivering heavy, bulky, and technical supplies in **15 to 30 minutes**.

```
+-----------------------------------------------------------------------------------+
|                            QCOM 4-APPLICATION ECOSYSTEM                           |
+-----------------------------------------------------------------------------------+
|  1. Customer App         2. Admin Portal        3. Seller App      4. Delivery App |
|  - Tradespeople & B2B    - Operations Command   - Merchant Store   - Gig & EV Fleet|
|  - Fast Re-orders        - Dynamic RBAC         - Live Prep Queue  - Safe Navigation|
|  - Authoritative Pricing - Financial Audits     - Stock & Pricing  - Proof & OTP   |
|  - Tax Invoices & ITC    - Dispatch & Fleet     - Bank & Ledger    - COD & Float   |
+-----------------------------------------------------------------------------------+
                                         │
                                         ▼
+-----------------------------------------------------------------------------------+
|                           5. UNIFIED BACKEND ENGINE                               |
|  - Distributed Stock Locks (CAS)         - Authoritative Pricing & Tax Engine     |
|  - Multi-Zone Dispatch Matrix            - Double-Entry Financial Ledgers         |
|  - Real-Time Geospatial Telemetry        - Cryptographic Security & RBAC          |
+-----------------------------------------------------------------------------------+
```

---

## 2. Key Personas & Operational Roles

### 2.1 Customer Personas
1. **Licensed Tradesperson / Contractor (B2B)**:
   - Needs emergency replacement parts at active construction or repair sites.
   - Demands GST-compliant tax invoices with valid GSTINs for 100% Input Tax Credit (ITC).
   - Values rapid 15–25 minute delivery to avoid halting entire crews.
   - Uses Trade Persona filters (Plumber, Electrician, Carpenter, Mason, Auto Mechanic).
2. **Automotive Garage Owner / Mechanic**:
   - Needs immediate delivery of vehicle spares (brake pads, clutch cables, spark plugs, lubricants).
   - Relies on exact technical specification matching (thread diameter, voltage, part numbers).
3. **Retail Property Owner / DIY Homeowner (B2C)**:
   - Needs household hardware (taps, modular switches, LED lighting, mounting anchors).
   - Requires easy search, part finder visual matching, and transparent delivery fees.

### 2.2 Merchant / Seller Personas
1. **Store Owner / Hardware Wholesaler**:
   - Oversees store catalog, stock pricing, bank account settings, and instant settlement requests.
   - Tracks net margins after commission, GST on commission, and TDS under Section 194-O.
2. **Store Manager / Dispatch Lead**:
   - Monitors live incoming order audio alerts and supervises order acceptance.
   - Adjusts operational buffer times and toggles store online/paused states.
3. **Staff Picker & Packer**:
   - Locates SKUs via physical bin locations (e.g., `Aisle 3 - Bin 14B`).
   - Packs items into tamper-evident bags and completes physical handovers to riders with tokens (`PK-XXXX`).

### 2.3 Delivery Partner Personas
1. **Full-Time 2W / EV Gig Rider**:
   - Completes 15–25 orders/day during scheduled 3-hour shift blocks.
   - Requires rapid OTP customer verification, turn-by-turn navigation, and transparent instant payouts.
2. **Express Bicycle / Light EV Courier**:
   - Handles short-distance, lightweight orders (≤2.5 km, ≤5 kg, e.g., switches, tapes, fasteners).
3. **Heavy Cargo 3-Wheeler Operator**:
   - Handles high-payload bulk runs (pipe bundles, inverters, car batteries, submersible pumps up to 120 kg).

### 2.4 Administrative & Operations Personas
1. **Super Administrator**: Complete platform governance, system configuration, master audit access.
2. **City Operations / Dispatch Manager**: Live order flow, fleet rebalancing, SLA breach alerts, manual overrides.
3. **Finance & Settlement Officer**: Merchant payout clearance, rider instant withdrawal approvals, tax reporting (GST, TDS).
4. **Trust, Safety & Customer Support Agent**: Dispute handling, refund approvals, seller suspension, fraud reviews.

---

## 3. Core Domain Rules & Operating Principles

1. **Operating Hours (08:00 AM – 08:00 PM)**:
   - All customer order placements, store operations, and rider shifts occur strictly between 08:00 AM and 08:00 PM.
   - 4 Structured 3-Hour Shifts:
     - Shift 1: `08:00 AM – 11:00 AM` (Morning Contractor & Site Rush — 1.25x Surge)
     - Shift 2: `11:00 AM – 02:00 PM` (Midday Workshop & Garage Peak — 1.35x Surge)
     - Shift 3: `02:00 PM – 05:00 PM` (Afternoon Express Spares Run — 1.20x Surge)
     - Shift 4: `05:00 PM – 08:00 PM` (Evening Maintenance & Repair Surge — 1.50x Surge)
2. **Dual-Sector Catalog (Hardware & Automotive)**:
   - Primary categories: Plumbing, Electrical, Fasteners, Tools, Adhesives, Safety Gear, Auto Maintenance, Lighting.
   - Technical specifications: Wire gauge, thread pitch, HSN code, voltage, burst pressure, manufacturer part number.
3. **Zero-Trust Pricing Architecture**:
   - Client applications never calculate final totals, discounts, or delivery fees. All pricing is determined authoritatively by the backend pricing engine with cryptographic HMAC validation.
4. **Tamper-Evident Fulfillment & Privacy**:
   - Store packers seal orders in numbered bags. Delivery riders do not see individual customer purchase items; they verify bag counts and store handover tokens.
   - All voice calls between riders and customers route through a masked telephony proxy.
5. **Two-Tiered Delivery Verification**:
   - Delivery is completed exclusively via a 4-digit PIN OTP entered by the customer, or authorized contactless photo proof with GPS watermarking if contactless delivery is requested.
