# SPRINT 15.6 — EXTERNAL DEPENDENCY AND ACTIVATION CHECKLIST

**Project:** QCOM (`QCOM/backend`)
**Baseline Commit SHA:** `c384268da1d0f24a93aaf86215b18ead5a56b1fa`
**Security Note:** Zero credentials, API keys, or secrets are stored or requested in this document.

---

## Activation Timeline Overview

- **Immediate (Before Roadmap Sprint 1 — Stage A):** Payment Gateway, Payout Gateway, SMS/OTP Telephony + DLT, Firebase Push (FCM), Managed PG 16 + Redis 7 Cloud Infra + Off-Site Backup Storage.
- **Pre-Onboarding (Before Roadmap Sprint 4 — Stage B/C):** KYC/PAN/GSTIN/Penny-Drop API, Cloud Object Storage + CDN (S3/GCS), Maps/Distance API.
- **Pre-Pilot / Pre-Public (Before Roadmap Sprints 5–6 — Stage D/E):** Domain & SSL/TLS, Transactional Email, WhatsApp Business API, Monitoring/Error Alerting (Sentry/Prometheus/PagerDuty), CA/Legal Compliance Sign-offs.

---

## Detailed External Dependency Inventory

### 1. Payment Gateway (Razorpay / Cashfree Payments)
- **Code present?** Partial — Clean `PaymentProvider` interface, webhook verifier, `paymentService.ts`, and `RazorpayPaymentProvider` class exist (`paymentProviderRegistry.ts`), **but** methods are in-memory `Map` stubs with zero HTTP/SDK calls (`F-15.6-P0-02`).
- **Configuration present?** Env schema exists in `src/config/env.ts` (`PAYMENT_MODE`, `PAYMENT_SECRET`), missing live gateway SDK key variables validation for active Razorpay REST adapter.
- **Credentials status:** **Absent** (CI uses `PAYMENT_MODE=mock`).
- **Sandbox tested?** **No.**
- **Live tested?** **No.**
- **What founder needs to do:** Complete business onboarding & KYC with Razorpay (or Cashfree), enable UPI/Cards/Netbanking, obtain Sandbox & Live Key ID/Secret + Webhook Secret, and whitelist production webhook URL (`https://api.<domain>/api/v1/payments/webhook/razorpay`).
- **When to activate:** **Immediately (Stage A — before any real-money transaction testing).**

### 2. Payout Disbursement Gateway (RazorpayX / Cashfree Payouts)
- **Code present?** Partial — `payoutProvider.ts` defines `IPayoutProvider` and dual-transaction `sellerSettlementService.ts`/`riderPayoutService.ts` + webhook handler (`financialWebhookService.ts`), **but** production `getPayoutProvider()` throws `PAYOUT_PROVIDER_NOT_CONFIGURED` (`F-15.6-P0-01`).
- **Configuration present?** Minimal (`PAYOUT_MODE` mocked).
- **Credentials status:** **Absent.**
- **Sandbox tested?** **No.**
- **Live tested?** **No.**
- **What founder needs to do:** Activate RazorpayX (or Cashfree Payouts) current/escrow account, complete corporate KYC, configure IP whitelisting for backend egress IPs, fund test/live source account, and generate Payout API & webhook secrets.
- **When to activate:** **Stage A (before real-money merchant/rider settlements).**

### 3. SMS & OTP Telephony Provider (Exotel / Twilio / MSG91 + India DLT)
- **Code present?** Partial — `otpProvider.ts` defines interface and OTP hashing/rate limits exist in `authService.ts`, **but** `ProductionSmsProvider` throws unconditionally in `NODE_ENV=production` (`F-15.6-P0-01`).
- **Configuration present?** `TELEPHONY_MODE` enum in `src/config/env.ts` (`mock|exotel|twilio`), no API key/SID/DLT Template ID config wired.
- **Credentials status:** **Absent** (`TELEPHONY_MODE=mock` in CI).
- **Sandbox tested?** **No.**
- **Live tested?** **No.**
- **What founder needs to do:** Register business Principal Entity ID, Sender Header (e.g., `QCOMHD`), and exact SMS OTP/Transactional templates on an Indian telecom DLT portal (Jio/Airtel/Vodafone), then activate Exotel, MSG91, or Twilio with DLT-approved template IDs. (DLT approval typically takes 3–7 business days—start early!)
- **When to activate:** **Immediately (Stage A — required for production customer/rider login).**

### 4. Push Notifications (Firebase Cloud Messaging — FCM / APNs)
- **Code present?** Partial — `pushProvider.ts`, `deviceTokenService.ts`, `notificationService.ts` exist, **but** `FcmPushProvider.sendPush()` is a fake stub returning synthetic IDs (`F-15.6-P0-01`).
- **Configuration present?** `FCM_SERVICE_ACCOUNT` checked in `pushProvider.ts`.
- **Credentials status:** **Absent.**
- **Sandbox tested?** **No.**
- **Live tested?** **No.**
- **What founder needs to do:** Create Firebase project, register QCOM Customer/Seller/Delivery mobile apps + Apple APNs key (for iOS), and generate restricted Firebase Admin Service Account credentials.
- **When to activate:** **Stage A/C (essential for rider dispatch offer wake-up & customer/seller order alerts).**

### 5. Cloud Infrastructure (Compute, Managed PostgreSQL 16 & Managed Redis 7 HA)
- **Code present?** Yes — DB pool (`connection.ts`), Redis HA client (`redis.ts`), health/readiness probes (`app.ts`), `migrations/001–027`. Packaging fix needed (`ioredis` missing from `QCOM/backend/package.json`).
- **Configuration present?** `DATABASE_URL`, `REDIS_URL`, `EXPECTED_REDIS_VERSION=7.0.15`.
- **Credentials status:** CI-only ephemeral test containers.
- **Sandbox tested?** CI PG 16 + Redis 7.0.15 only; zero cloud staging/load testing.
- **Live tested?** **No.**
- **What founder needs to do:** Provision cloud account (AWS / GCP / DigitalOcean), Managed PostgreSQL 16 (with Multi-AZ/automated PITR) and Managed Redis 7.0+ (HA Sentinel/Replication so auth/checkout fail-closed checks never outage on single-node restart), plus private VPC networking and Secrets Manager.
- **When to activate:** **Stage A/B (required for staging validation & real-data protection).**

### 6. Off-Site Encrypted Backup Storage
- **Code present?** **No** (`0` backup/PITR/restore scripts in repo; `F-15.6-P0-08`).
- **Configuration present?** **No.**
- **Credentials status:** **Absent.**
- **Sandbox tested?** **No.**
- **Live tested?** **No.**
- **What founder needs to do:** Enable automated daily DB snapshots + continuous WAL PITR retention (minimum 30 days, longer if statutory financial retention needed) replicated to an access-restricted, encrypted cross-region bucket (S3/GCS), and approve quarterly restore-drill budget.
- **When to activate:** **Before Stage A / any persistent real-money ledger data exists.**

### 7. Domain Name, DNS & SSL/TLS Certificates
- **Code present?** Yes — `CORS_ALLOWED_ORIGINS` & `TRUSTED_PROXY_IPS` production guards in `env.ts` / `app.ts`, `Secure`/`HttpOnly`/`SameSite` session cookies.
- **Configuration present?** Env keys declared (`CORS_ALLOWED_ORIGINS`).
- **Credentials status:** Absent (`http://localhost` only in tests).
- **Sandbox tested?** No.
- **Live tested?** No.
- **What founder needs to do:** Purchase production domain, configure DNS (`api.<domain>`, portal subdomains), and provision TLS termination (AWS ACM / Cloudflare / Let's Encrypt on load balancer) forwarding `X-Forwarded-For` cleanly from `TRUSTED_PROXY_IPS`.
- **When to activate:** **Before Stage D (Limited Pilot — browsers require HTTPS for Secure cookies & WebSockets `wss://`).**

### 8. KYC, PAN, GSTIN & Bank Account Penny-Drop Verification
- **Code present?** **No** — Schema columns exist (`pan_number`, `gstin`, `bank_verified`, `kyc_status`), but zero onboarding routes or external KYC verification adapter exist (`F-15.6-P1-02`).
- **Configuration present?** **No.**
- **Credentials status:** **Absent.**
- **Sandbox tested?** **No.**
- **Live tested?** **No.**
- **What founder needs to do:** Select an India KYC aggregator (Cashfree Verification Suite / Karza / RazorpayX / Signzy), complete commercial contract, obtain sandbox & live API keys for PAN, GSTIN, Driving License/RC, and ₹1 Bank Penny-Drop verification.
- **When to activate:** **Before Stage B/C (Merchant & Rider Onboarding).**

### 9. Maps, Geocoding & Road-Distance Matrix (Google Maps / MapMyIndia / OSRM)
- **Code present?** Partial — `routingService.ts` calculates Haversine × 1.25 locally with Redis route caching; zero external Maps HTTP integration (`F-15.6-P1-09`).
- **Configuration present?** **No.**
- **Credentials status:** **Absent.**
- **Sandbox tested?** **No.**
- **Live tested?** **No.**
- **What founder needs to do:** Enable Google Maps Platform (Distance Matrix, Directions, Places/Geocoding) or MapMyIndia/OSRM hosting, set billing alerts/quotas, and provision server-restricted API key.
- **When to activate:** **Before Stage C/D (Accurate delivery ETA, distance pricing, and address coordinate snapping).**

### 10. Cloud Object Storage & CDN (AWS S3 / GCS + CloudFront/Cloudflare)
- **Code present?** **No** — `contactless_photo_url`, `image_url`, and invoice PDFs lack upload/storage adapters; `pdfGenerator.ts` only emits strings in memory.
- **Configuration present?** **No.**
- **Credentials status:** **Absent.**
- **Sandbox tested?** **No.**
- **Live tested?** **No.**
- **What founder needs to do:** Provision private buckets for sensitive KYC/invoices/POD photos (pre-signed short-TTL URLs) and public CDN bucket for catalog product images.
- **When to activate:** **Before Stage B/D (Merchant catalog images, KYC uploads, PDF invoices, delivery POD photos).**

### 11. Transactional Email Provider (AWS SES / Postmark / SendGrid)
- **Code present?** **No.**
- **Configuration present?** **No.**
- **Credentials status:** **Absent.**
- **Sandbox tested?** **No.**
- **Live tested?** **No.**
- **What founder needs to do:** Verify domain SPF, DKIM, DMARC DNS records and request production sending quota for sending tax invoices, credit notes, seller onboarding emails, and admin password-reset links.
- **When to activate:** **Before Stage D/E (Pilot / Public Launch).**

### 12. WhatsApp Business API (BSP: Interakt / Gupshup / Twilio / Meta Cloud)
- **Code present?** **No.**
- **Configuration present?** **No.**
- **Credentials status:** **Absent.**
- **Sandbox tested?** **No.**
- **Live tested?** **No.**
- **What founder needs to do:** Register Meta Business Manager + WhatsApp Business number + approved message templates (order confirmation, rider arrival, merchant order alert, refund issued).
- **When to activate:** **Before Stage E (optional for closed pilot if SMS + Push work; strong value for merchant/customer engagement at public launch).**

### 13. Monitoring, Error Tracking & Alerting (Sentry / Prometheus + Grafana / PagerDuty)
- **Code present?** Partial — `/health`, `/health/live`, `/ready` probes and Bloom/worker metrics endpoints exist (`app.ts`, `refundRoutes.ts`), **but** zero error-tracking SDK, zero structured JSON logs, and zero automated alerts (`F-15.6-P1-10`).
- **Configuration present?** **No.**
- **Credentials status:** **Absent.**
- **Sandbox tested?** **No.**
- **Live tested?** **No.**
- **What founder needs to do:** Create Sentry + Prometheus/Datadog/Grafana Cloud + Slack/PagerDuty accounts and define on-call escalation alerts for `5xx` spikes, webhook signature/processing failures, `RECONCILIATION_REQUIRED` backlog, and PG/Redis outages.
- **When to activate:** **Before Stage D (Limited Pilot — never run live customer traffic blind).**

### 14. Statutory GST / TDS & Legal / DPDP Processes (Chartered Accountant + Legal Counsel + NIC IRP)
- **Code present?** Technical tax tables (`taxEngine.ts`, `migrations/007`, `010`, `invoiceService.ts`) exist, **but** contain bugs (`F-15.6-P0-07`, `F-15.6-P1-07`) and zero NIC IRP / GSP integration or GSTR-8/Form 26Q exports.
- **Configuration present?** DB statutory seeds exist (`007`), unverified by CA for QCOM's actual contracts.
- **Credentials status:** **Absent** (no NIC IRP/GSP API credentials).
- **Sandbox tested?** **No.**
- **Live tested?** **No.**
- **What founder needs to do:** Engage an Indian Chartered Accountant & corporate counsel to: (1) confirm QCOM's marketplace GST, Section 52 GST-TCS, delivery-fee SAC `9968` taxability, and Section 194O / IT Act 2025 Section 393 TDS obligations; (2) verify whether NIC e-Invoice IRP applies immediately or post-turnover threshold; (3) finalize DPDP Privacy Policy, Terms of Service, Merchant Agreements, and Rider Contracts.
- **When to activate:** **Before Stage B (Merchant/Rider Agreements) & Stage D (Tax Invoices in Pilot).**

### 15. Offline Merchant & Delivery Partner Onboarding Operations
- **Code present?** Backend onboarding/KYC endpoints are currently **Missing** (`F-15.6-P1-02`); operational SOPs must exist alongside code in Roadmap Sprint 4.
- **What founder needs to do:** Prepare standardized merchant commission contracts, store operating-hour SLAs, return/damage dispute rules, rider COD deposit SOPs, and physical store verification checklists for initial pilot zones.
- **When to activate:** **Stage B/C (Merchant & Rider Onboarding).**
