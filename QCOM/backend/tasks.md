# QCOM Backend Implementation Task Breakdown & WBS

**Status:** Phase 0.5 Approved with Corrections — Ready for Phase 1  
**Architecture Version:** 3.0.0 (September 2026 Direct Tax Regime)  

---

## Approved Technology Stack & Boundaries

- **Durable Source of Truth:** Supabase PostgreSQL 16 + PostGIS (Port 6543 via Supavisor pooler)
- **Ephemeral Accelerator:** Redis (CAS Mutexes, Rate Limiters, BullMQ background queues, Socket PubSub)
- **Runtime:** Node.js 22 LTS / Express 4.x / TypeScript 5.x
- **Payment Engine:** Multi-mode (`PAYMENT_MODE=mock` default; `razorpay_test`; `production`)
- **SMS / Telephony:** Multi-mode (`MOCK_TELEPHONY=true` default; pluggable Exotel/Twilio)
- **Merchant Onboarding:** Manual Super Admin review (`PENDING` $\to$ `APPROVED`)
- **Direct Tax Engine:** Versioned statutory rules supporting Income-tax Act, 2025 (Section 393) and legacy Act 1961

---

## Work Breakdown Structure (WBS)

### Phase 0 & 0.5: Audits, Validations & Corrections (COMPLETED)
- [x] Clone and inspect all 4 repositories into unified workspace (`customer-app`, `admin-portal`, `seller-app`, `delivery-app`).
- [x] Identify security pentest remediations (CWE-20, CWE-287, CWE-362, CWE-565, CWE-602, CWE-639, CWE-840, CWE-841, CWE-862).
- [x] Codify 2026 direct tax regime (Income-tax Act, 2025 Section 393 Table 8(v) consolidation).
- [x] Establish rule-driven higher rate resolution (no hardcoded "5% if no PAN").
- [x] Version Section 52 GST-TCS rules in database.
- [x] Enforce PostgreSQL as primary inventory authority (CAS decrements).
- [x] Enforce zero uncommitted orders in Redis on DB failure (controlled 503 retry).
- [x] Define tiered immutable audit log retention policy (no 90-day deletions).
- [x] Separate customer tip business policy (100% pass-through) from tax engine determinations.
- [x] Synchronize all 16 specification documents across `/` and `/QCOM/backend/`.

---

### Phase 1: Consolidated Backend Foundation & Database Initialization (COMPLETED)
- [x] Task 1.1: Initialize `QCOM/backend` project structure (`package.json`, `tsconfig.json`, `server.ts`).
- [x] Task 1.2: Set up Supabase PostgreSQL connection pooler (Supavisor port 6543) and Redis client.
- [x] Task 1.3: Execute DDL migrations for all 19 relational tables (including `statutory_withholding_rules`, `gst_tcs_rules`, `general_ledger_accounts`, and `general_ledger_entries`).
- [x] Task 1.4: Seed versioned statutory tax rules (Income-tax Act 2025 Sec 393, CGST Act Sec 52, SAC/HSN codes).
- [x] Task 1.5: Implement core Express middleware stack (dynamic CORS, prototype pollution defense, security headers, sliding-window rate limiters).

---

### Phase 2: Authentication, Security & Dynamic RBAC Engine (COMPLETED)
- [x] Task 2.1: Implement Customer Phone OTP authentication with sliding-window rate limiting, constant-time hash comparison, and brute-force lockout.
- [x] Task 2.2: Implement Delivery Partner token verification and authoritative session tracking in PostgreSQL.
- [x] Task 2.3: Implement Seller multi-role RBAC (`STORE_OWNER`, `STORE_MANAGER`, `STAFF_PACKER`) with store-id scoping and tenant isolation.
- [x] Task 2.4: Implement Admin session authentication with dynamic 12-module granular permission enforcement.
- [x] Task 2.5: Implement universal input sanitization middleware, prototype pollution defenses, and security audit log integration.

---

### Phase 3: Dynamic Tax Rules & Authoritative Pricing Engine (COMPLETED)
- [x] Task 3.1: Centralized authoritative pricing engine (`PricingEngine.calculate`, version 3.0.0, distance rounding to 100m, free delivery threshold).
- [x] Task 3.2: Implement statutory Indian GST engine (HSN/SAC code resolution, effective dates, intra-state CGST+SGST vs inter-state IGST split).
- [x] Task 3.3: Implement dynamic withholding engine resolving Section 393 Table 8(v) (or 194-O) and Section 52 GST-TCS from active rules.
- [x] Task 3.4: Implement zero-trust client price and tax tampering defense (database-derived prices and rules only).
- [x] Task 3.5: Implement pricing quote API (`POST /api/v1/pricing/quote` and `/quote/:quoteId`) with idempotency and snapshot persistence.
- [x] Task 3.6: Implement administrative tax and delivery rules listing with pagination, filtering, and sorting.
- [x] Task 3.7: Implement financial decimal arithmetic (`BigNumber.js`) with statutory Round-Half-Up precision.

---

### Phase 4: Orders & Authoritative Concurrency (CAS)
- [ ] Task 4.1: Implement PostgreSQL atomic CAS stock reservation (`UPDATE store_inventory SET stock_count = ...`).
- [ ] Task 4.2: Implement order creation endpoint (`POST /api/orders/create` with mandatory `Idempotency-Key`).
- [ ] Task 4.3: Implement controlled 503 error handling on database connection failure (zero uncommitted orders in Redis).
- [ ] Task 4.4: Implement deterministic order lifecycle state machine with status transition validations.
- [ ] Task 4.5: Implement store packing delay reporting and live wait-time compensation meter (₹1.20/min past 5 min).

---

### Phase 5: Delivery Dispatch, Routing & Telematics
- [ ] Task 5.1: Implement dispatch match engine with vehicle constraint matrix (Bicycle, Light EV, Motorcycle, Cargo 3W).
- [ ] Task 5.2: Implement atomic batch claim endpoint (`POST /api/delivery/delivery/claim`) with CAS concurrency protection.
- [ ] Task 5.3: Integrate zero-API-key OpenStreetMap and OSRM turn-by-turn routing with dual accessible entrance pins.
- [ ] Task 5.4: Implement telemetry ingestion (`POST /api/qrider/telemetry/location`) with velocity plausibility sanity filter (≤120 km/h).
- [ ] Task 5.5: Implement customer unreachable protocol with 5-minute countdown and return-to-hub trip compensation (+₹25).

---

### Phase 6: Double-Entry Financial Ledgers, Payments & Settlements
- [ ] Task 6.1: Implement multi-mode payment engine (`mock` default, `razorpay_test`, `production`) with HMAC verification.
- [ ] Task 6.2: Implement double-entry General Ledger journal engine with 15 Chart of Accounts; enforce $\sum \text{Debits} == \sum \text{Credits}$.
- [ ] Task 6.3: Implement COD reconciliation against authoritative database invoice due (CWE-602).
- [ ] Task 6.4: Enforce rider floating cash liability ceiling (₹2,500.00 max) with automated broadcast suspension.
- [ ] Task 6.5: Implement dynamic merchant settlement with Section 393 withholding and Section 52 GST-TCS deductions.
- [ ] Task 6.6: Implement rider wallet payout with tip pass-through and instant UPI withdrawal.
- [ ] Task 6.7: Implement Admin refund and dispute resolution workflows with gateway refund API triggers.

---

### Phase 7: Real-Time WebSockets, Background Queues & Audits
- [ ] Task 7.1: Implement secure WebSocket server with JWT authentication and dispatcher role guards (CWE-287).
- [ ] Task 7.2: Implement real-time order tracking stream for Customer App and live dispatch map for Admin Portal.
- [ ] Task 7.3: Implement BullMQ queues for background tasks only (SMS/WhatsApp, webhook retries, dispatch timeout, settlement cron).
- [ ] Task 7.4: Implement multi-tier immutable audit logging (0–90 days hot; >90 days cold storage; zero deletions).

---

### Phase 8: Verification & Automated Test Suites
- [ ] Task 8.1: Run `test-pricing-suite.ts` (100m distance rounding, pricing tiers).
- [ ] Task 8.2: Run `test_part2_delivery_economics.ts` (Delivery margins, subsidies).
- [ ] Task 8.3: Run `test-routing-suite.ts` (OSRM dual accessible entrance pins).
- [ ] Task 8.4: Run `test-security.ts` (Brute-force OTP, price tampering, BOLA/IDOR, CAS race conditions, velocity sanity).
- [ ] Task 8.5: Run full applet compilation (`compile_applet`) and lint validation (`lint_applet`).
