# QCOM Platform — Engineering Roadmap & Milestone Plan (PLAN)

**Current Milestone:** Sprint 14.6 Completed  
**Release Candidate Target:** v1.0.0-rc1  

---

## 1. Verified Completed Milestones

- **Sprint 1.0 – 4.0:** Core domain foundation, unified schemas, migrations (001–012), pricing snapshots, statutory GST tax engine.
- **Sprint 5.0 – 9.0:** Multi-tenant dispatch engine, payment state machine, seller/rider settlements, double-entry General Ledger, real-time WebSocket notifications.
- **Sprint 10.0 – 10.1C:** Durable financial recovery, outbox idempotency, financial webhook processing with HMAC signatures, and zero-sum ledgers.
- **Sprint 11.0 – 11.9:** Selective inventory reservations, outbox-driven back-in-stock alerts, zero-oversell row locking (`SELECT FOR UPDATE`), and concurrency contention stress testing.
- **Sprint 12.0 – 12.7:** Provider-agnostic payment abstraction (`PaymentProvider`), `MockPaymentProvider` sandbox, distributed recovery leases (`payment_intent_recovery_leases`), and non-blocking reconciliation worker.
- **Sprint 13.0 – 13.1:** Cross-panel orchestration, admin/partner compatibility routes, and failure-recovery hardening.
- **Sprint 14.0 – 14.3:** Staging environment topology (`docker-compose.staging.yml`), four-application backend compatibility verification, and Release Candidate sign-off.
- **Sprint 14.4:** High-security authentication gate, password hashing audit, OTP rate-limiting, IDOR and object-level authorization across Customer, Seller, Rider, and Admin.
- **Sprint 14.5:** Payment idempotency, duplicate webhook deduplication across terminal states (`PROCESSED`, `IGNORED`, `FAILED`), and financial integrity validation.
- **Sprint 14.6:** Architecture readiness, 15 canonical Markdown specifications, multi-instance safety verification, and evidence-based performance baseline.

---

## 2. Prioritized Forward Roadmap

1. **Production Gateway Provisioning (Post-Staging Sign-off):**  
   Configure production API credentials for Razorpay / cash-free payment gateways in Cloud Secret Manager before setting `NODE_ENV=production`.
2. **Authoritative Telephony Provider Integration:**  
   Transition from `TELEPHONY_MODE=mock` to SMS aggregators (Fast2SMS / Twilio) for production SMS OTP delivery.
3. **Managed Redis Cluster Setup:**  
   Deploy an enterprise Redis 7 cluster with high-availability read replicas to handle cross-node WebSocket pub/sub at scale.
4. **Selective Microservice Extraction Preparation:**  
   As traffic expands beyond 50,000 orders/day, evaluate selective extraction of the real-time rider tracking and notification engine while keeping orders, payments, and ledger inside the transactional core.
