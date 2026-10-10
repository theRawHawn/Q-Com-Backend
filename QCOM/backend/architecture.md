# QCOM Backend Architecture Specification

**Architecture Version:** 3.0.0 (Phase 0.5 Final Correction Pass — September 2026)  
**Target Throughput:** 250,000 Orders/Day | Sub-15s End-to-End Dispatch Latency | 99.99% Availability  
**Core Stack:** Supabase PostgreSQL 16 + PostGIS (Durable Source of Truth) | Redis Cluster (Ephemeral Accelerator) | Node.js 22 LTS / Express / TypeScript  

---

## 1. System Topology & Data Tier Boundaries

```
                                 INTERNET & CLIENTS
   +----------------+   +---------------+   +--------------+   +---------------+
   |  Customer App  |   | Admin Portal  |   |  Seller App  |   | Delivery App  |
   | (Web/Mobile)   |   | (Desktop Ops) |   | (Store PWA)  |   | (Mobile PWA)  |
   +-------+--------+   +-------+-------+   +------+-------+   +-------+-------+
           │                    │                  │                   │
           │ HTTPS / REST       │ HTTPS / REST     │ HTTPS / REST      │ WSS / REST
           ▼                    ▼                  ▼                   ▼
   +---------------------------------------------------------------------------+
   |                     INGRESS & SECURITY MIDDLEWARE                         |
   | - Dynamic CORS & Security Headers (CSP, Anti-Sniff, HSTS)                 |
   | - Recursive Object Prototype Pollution Defense                            |
   | - Sliding Window Rate Limiters (Redis Multi-Tier Counters)                |
   | - Cryptographic Session & JWT Handshake Validation                        |
   +---------------------------------------------------------------------------+
                                        │
                                        ▼
   +---------------------------------------------------------------------------+
   |                   EXPRESS BACKEND RUNTIME (MODULAR MONOLITH)              |
   | ┌───────────────────────────┐ ┌───────────────────────────┐               |
   | │ /api/checkout & Pricing   │ │ /api/seller & Store Queue │               |
   | │ - Dynamic GST & ITC slabs │ │ - Live order accept/pack  │               |
   | │ - Distance to 100m round  │ │ - Bin location picker     │               |
   | └───────────────────────────┘ └───────────────────────────┘               |
   | ┌───────────────────────────┐ ┌───────────────────────────┐               |
   | │ /api/orders & State Machine││ /api/qrider & Dispatch    │               |
   | │ - Authoritative Postgres  │ │ - Haversine/OSRM routing  │               |
   | │   CAS stock decrement     │ │ - Anti-spoof velocity chk │               |
   | └───────────────────────────┘ └───────────────────────────┘               |
   | ┌───────────────────────────┐ ┌───────────────────────────┐               |
   | │ /api/admin Operations     │ │ Financial Ledger & Taxes  │               |
   | │ - 12-Module Dynamic RBAC  │ │ - Double-Entry COA Engine │               |
   | │ - Manual Seller Approval  │ │ - Dynamic Sec 52 GST-TCS  │               |
   | │ - Audit Control Room      │ │ - Income-tax Act 2025 Sec │               |
   | │                           │ │   393 Dynamic Withholding │               |
   | └───────────────────────────┘ └───────────────────────────┘               |
   +---------------------------------------------------------------------------+
                     │                                   │
                     ▼                                   ▼
   +------------------------------------+ +------------------------------------+
   |  SUPABASE POSTGRESQL + POSTGIS     | |           REDIS ACCELERATOR        |
   |  (DURABLE SINGLE SOURCE OF TRUTH)  | |        (STRICTLY EPHEMERAL ONLY)   |
   | - ACID Double-Entry General Ledger | | - Ephemeral CAS mutexes (5-15s)    |
   | - Orders, Items, Invoices, KYC     | | - Sliding-Window Rate Limit Caches |
   | - Authoritative Inventory Decrement| | - Live Rider Lat/Lng Geo Spatial   |
   | - Versioned Tax & Withholding Rules| | - Real-Time Pub/Sub Dispatch Mesh  |
   | - Connection Pooling (Supavisor)   | | - BullMQ Queues (Background only)  |
   | - Multi-Tier Immutable Audit Store | | - Zero uncommitted customer orders |
   +------------------------------------+ +------------------------------------+
```

---

## 2. Critical Architectural Invariants

### 2.1 Order Creation Resiliency (Zero Uncommitted Orders in Redis)
> **CRITICAL STABILITY INVARIANT:**  
> If PostgreSQL becomes temporarily unavailable or connection pool is exhausted, the backend MUST NEVER accept and queue an uncommitted order into Redis.  
> Accepting an order without database confirmation violates inventory reservation, price locks, tax calculation, and double-entry accounting.
> 
> **Correct Protocol**:
> 1. Detect PostgreSQL connectivity failure.
> 2. Immediately reject checkout request with HTTP `503 Service Unavailable` and header `Retry-After: 3`.
> 3. Customer client automatically retries using the same `Idempotency-Key`.
> 4. Once PostgreSQL recovers, the idempotent request executes authoritatively.
> 
> *BullMQ is strictly reserved for retrying background work: SMS/WhatsApp alerts, payment webhook processing, delivery dispatch escalation, and scheduled settlement crons.*

### 2.2 PostgreSQL as Primary Inventory Authority
- All inventory allocation operates directly against PostgreSQL using atomic Compare-and-Swap:
  ```sql
  UPDATE store_inventory 
  SET stock_count = stock_count - $qty,
      reserved_count = reserved_count + $qty,
      version = version + 1
  WHERE product_id = $id AND merchant_id = $mId AND stock_count >= $qty;
  ```
- The transaction commits ONLY if `rows_affected == 1`. If zero, the order transaction rolls back and returns `409 OUT_OF_STOCK`.
- Redis locks serve purely as an optional high-speed debounce layer to absorb flash-sale concurrent clicks, but PostgreSQL remains the sole authoritative gatekeeper.

### 2.3 Tiered Audit Log Retention (No Deletions of Critical History)
- Financial transactions, tax records, settlements, ledger entries, payment records, KYC records, and administrative action logs are **NEVER deleted**.
- **Storage Tiering**:
  - *Hot Tier (0–90 Days)*: Indexed relational tables in Supabase PostgreSQL for sub-second admin query performance.
  - *Cold Tier (>90 Days)*: Partitioned archive tables retained permanently in compliance with Indian statutory books-of-account requirements (minimum 8 years under Section 128 of Companies Act, 2013 and Section 44AA of Income-tax Act).
  - Short 90-day retention policies apply strictly to non-critical high-frequency telemetry and debug logs.

---

## 3. Approved Owner Decisions for Phase 1 Stack

1. **Database Tier**:
   - Primary: **Supabase PostgreSQL + PostGIS**.
   - Operating under ₹0 Free Tier boundaries during development (connection pooling via Supavisor on port 6543; telemetry kept ephemeral).
2. **Payment Engine**:
   - Pluggable payment abstraction supporting:
     - `PAYMENT_MODE=mock` (Default for local development — zero external network dependencies).
     - `PAYMENT_MODE=razorpay_test` (Ready for test keys).
     - `PAYMENT_MODE=production`.
3. **SMS / IVR Gateway**:
   - Initial implementation uses **Mock OTP and Mock IVR** with deterministic testing capabilities.
   - Provider interface designed for pluggable drop-in integration (Exotel / Twilio) via environment variables.
4. **Merchant Onboarding Workflow**:
   - Initial status: `PENDING`.
   - Requires manual Super Admin review and approval (`POST /api/admin/sellers/:id/approve`) before store can go online or receive orders.
