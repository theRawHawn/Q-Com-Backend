# QCOM Platform — Engineering Roadmap & Milestone Plan (PLAN)

**Current Milestone:** Sprint 16.1 Independent Financial Integrity Verification & Remediation (Staging Verified)  
**Release Candidate Target:** v1.0.0-rc2 (Staging-Ready; Production Gated on Founder/Tax/Gateway Approvals)  

---

## 1. Verified Completed Milestones

- **Sprint 1.0 – 4.0:** Core domain foundation, unified schemas, migrations (001–012), pricing snapshots, statutory GST tax engine.
- **Sprint 5.0 – 9.0:** Multi-tenant dispatch engine, payment state machine, seller/rider settlements, double-entry General Ledger, real-time WebSocket notifications.
- **Sprint 10.0 – 10.1C:** Durable financial recovery, outbox idempotency, financial webhook processing with HMAC signatures, and zero-sum ledgers.
- **Sprint 11.0 – 11.9:** Selective inventory reservations, outbox-driven back-in-stock alerts, zero-oversell row locking (`SELECT FOR UPDATE`), and concurrency contention stress testing.
- **Sprint 12.0 – 12.7:** Provider-agnostic payment abstraction (`PaymentProvider`), `MockPaymentProvider` sandbox, distributed recovery leases (`payment_intent_recovery_leases`), and non-blocking reconciliation worker.
- **Sprint 13.0 – 13.1:** Cross-panel orchestration, admin/partner compatibility routes, and failure-recovery hardening.
- **Sprint 14.0 – 14.8:** Staging environment topology, four-application backend compatibility verification, Scrypt password hardening, distributed rate limits, and PostgreSQL outbox lease fencing (Migration 025).
- **Sprint 15.0 – 15.5:** Real PostgreSQL 16 + Redis 7.0.15 CI verification, immutable GL triggers (`LEDGER_IMMUTABLE`, Migration 027), FIFO seller settlement allocations, post-`PAID` reversal recovery, and `requireOrderOwnership` / `requireMerchantOwnership` / `requireRiderOwnership` hardening.
- **Sprint 15.7 – 15.8:** Reverse-trip partial uniqueness (Migration 028), normalized payment concurrency constraints (Migration 029), provider-agnostic payment boundary (`PaymentProvider` with zero provider lock-in), and initial 12-check reconciliation engine.
- **Sprint 15.9 & 15.9.1:** COD Cash Accountability & Remittance Integrity (`cod_collections`, `cod_remittances` DB separation of duties, `cod_cash_disputes`, COA `1050`/`2080`/`5030`, Checks `13–13F`) and independent financial verification closure.
- **Sprint 16.0:** Decimal-safe `bignumber.js` pricing engine, dynamic `indian_states` Place of Supply, GST exclusivity/inclusivity + Cess, fail-closed `422` tax guards, atomic coupon/promotion concurrency (`FOR UPDATE`), DB-backed carts (`carts`/`cart_items`), checkout price-drift guard (`409 PRICE_CHANGED`/`QUOTE_EXPIRED`), prorated credit notes (`credit_notes`), honest `irn: null`, COA `5040`, and Check 14 (`14A–14D`) reconciliation (Migration 031).
- **Sprint 16.1:** Independent verification & remediation (Migration 032): duplicate-line merge & `distanceKm` bounds, quote ownership/merchant/single-use (`converted_at`)/drift hardening, canonical `Idempotency-Key` payload fingerprint, deterministic discount remainder sweep & funding reconciliation, under-lock `PROMOTION_INACTIVE` guard, `FREE_DELIVERY` return preservation, fail-closed invoice service GST (`TaxAmount` fix eliminating `QCOM_PLATFORM_INVOICE` line drift), sequential partial return `₹0.00` rounding clamp, 3-phase crash-safe return QC (`uq_credit_notes_return_type`), proportional COA `5040` return unwind (`reversed_platform_subsidy`), expanded Check `14E–14J` read-only reconciliation, and pricing/coupon/cart/return rate limiters across 61 backend suites + PG16/Redis 7.0.15 CI.

---

## 2. Prioritized Forward Roadmap & Production Prerequisites

1. **Payment Gateway Selection & Secret Provisioning (Founder Decision):**  
   QCOM intentionally keeps payment infrastructure gateway-neutral; select and legally onboard a production PSP before setting `NODE_ENV=production`.
2. **Tax Counsel & CA Accounting Sign-Offs:**  
   Approve HSN/SAC catalog audits, Section 34 GST Credit Note time limits & B2B/B2C reporting rules, `FREE_DELIVERY` & partial-return coupon reversal commercial policies, and NIC IRP credentials (`EINVOICING_ENABLED=true`) once turnover crosses statutory thresholds.
3. **Authoritative Telephony Provider Integration:**  
   Transition from `TELEPHONY_MODE=mock` to production SMS aggregators for OTP delivery.
4. **Managed PostgreSQL (`NOSUPERUSER` App Role) & HA Redis Cluster:**  
   Deploy production PostgreSQL 16 under a dedicated non-owner `NOSUPERUSER` role so `LEDGER_IMMUTABLE` triggers cannot be bypassed, paired with managed HA Redis `>= 7.0.15`.

