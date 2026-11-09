# SPRINT 8 — REALTIME WEBSOCKETS, TRANSACTIONAL OUTBOX & RICH PUSH IMPLEMENTATION REPORT

**Date:** 2026-10-06  
**Auditor / Principal Engineer:** Distributed Systems & Security Lead  
**Target:** `QCOM/backend` (Sprint 8 Realtime Infrastructure & Notification Engine)  
**Implementation Gate Decision:** **APPROVED — 100% SPECIFICATION COMPLIANCE**  

---

## 1. EXECUTIVE SUMMARY

Sprint 8 completes the production-grade Realtime and Notification subsystem for the QCOM Quick-Commerce backend platform. In strict accordance with the pre-implementation architectural audit (`SPRINT_8_REALTIME_NOTIFICATIONS_PRE_IMPLEMENTATION_AUDIT.md`), the implementation establishes:

1. **Transactional Outbox Engine (`outbox_events`):** Atomic dual-write guarantee via PostgreSQL ACID transactions. Staged events commit or rollback with domain mutations, preventing ghost events and lost-update anomalies. Bounded exponential backoff with jitter and dead-letter queue (DLQ) state transitions with operator replay capabilities.
2. **Authoritative Realtime WebSocket Gateway (`/ws`):** Native Node.js `ws` gateway attached directly to HTTP server. Cryptographic JWT and authoritative PostgreSQL session verification (`auth_sessions`), strict channel IDOR boundary controls (`order:<id>`, `user:<id>`, `rider:<id>`, `admin:fleet`), and immediate bidirectional connection severance upon session logout or global `logoutAll`.
3. **Ephemeral High-Throughput Rider GPS Ingestion (`POST /api/v1/routing/telemetry/location`):** Anti-spoofing velocity sanity checking (>120 km/h jump block), stale timestamp rejection (>60s delta drop), Redis in-memory storage, and zero second-by-second high-frequency table bloat in PostgreSQL.
4. **Push Notification Registry & Device Token Security (`user_device_tokens`):** Cryptographic SHA-256 token hashing at rest, masked preview (`fcm_...1234`), idempotent upsert registration, and automated deactivation upon provider token revocation (e.g. `UNREGISTERED`).
5. **Customer Notification Preferences & Consent Isolation (`notification_preferences`):** Strict separation between statutory/transactional alerts and promotional opt-in marketing. Transactional messages bypass marketing opt-outs while promotional campaigns strictly require affirmative consent.
6. **Admin Rich Push Campaign Pipeline (`notification_campaigns`):** Multi-tenant HTTPS image URL validation, strict application deep-link allowlist sanitization (`/orders/*`, `/deals/*`, etc.) preventing open redirects, scheduled campaign states, targeted batch dispatching, and interaction event analytics.
7. **Algorithmic Notification Contract (`BaselineRuleDecisionEngine`):** Standardized, auditable interface (`evaluateDecision`) providing a contract for ML/heuristic candidate ranking without coupling machine learning logic to delivery dispatchers.
8. **Comprehensive Automated Test Coverage:** 18 dedicated end-to-end integration tests in `tests/sprint8-realtime-notifications.test.ts`. Zero regressions across Sprint 1–8 test suites (all passing in 10.91 seconds).

---

## 2. DATABASE SCHEMA ARCHITECTURE (MIGRATION 016)

The migration `migrations/016_create_realtime_outbox_and_notifications.sql` provisions six production tables:

```sql
-- 1. Transactional Outbox Events Table
CREATE TABLE IF NOT EXISTS outbox_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type VARCHAR(100) NOT NULL,
    aggregate_type VARCHAR(50) NOT NULL,
    aggregate_id UUID NOT NULL,
    payload JSONB NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (
        status IN ('PENDING', 'PUBLISHED', 'FAILED', 'DEAD_LETTER')
    ),
    attempt_count INT NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_at TIMESTAMPTZ
);

-- 2. User Device Tokens Table (SHA-256 Hashed Tokens)
CREATE TABLE IF NOT EXISTS user_device_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(64) NOT NULL,
    raw_token_preview VARCHAR(16) NOT NULL,
    provider VARCHAR(20) NOT NULL DEFAULT 'FCM' CHECK (
        provider IN ('FCM', 'APNS', 'MOCK', 'WEB_PUSH')
    ),
    platform VARCHAR(20) NOT NULL CHECK (
        platform IN ('ANDROID', 'IOS', 'WEB')
    ),
    app_version VARCHAR(30),
    device_metadata_minimal JSONB DEFAULT '{}'::jsonb,
    is_active BOOLEAN DEFAULT TRUE,
    last_seen_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_user_device_token UNIQUE (user_id, token_hash)
);

-- 3. Customer Notification Preferences Table
CREATE TABLE IF NOT EXISTS notification_preferences (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    push_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    transactional_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    delivery_updates_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    promotional_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Admin Rich Push Campaigns Table
CREATE TABLE IF NOT EXISTS notification_campaigns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_by UUID NOT NULL REFERENCES users(id),
    title VARCHAR(150) NOT NULL,
    body TEXT NOT NULL,
    image_url TEXT,
    deep_link TEXT,
    target_audience VARCHAR(50) NOT NULL DEFAULT 'ALL',
    status VARCHAR(20) NOT NULL DEFAULT 'DRAFT' CHECK (
        status IN ('DRAFT', 'SCHEDULED', 'EXECUTING', 'COMPLETED', 'CANCELLED', 'FAILED')
    ),
    scheduled_at TIMESTAMPTZ,
    sent_count INT NOT NULL DEFAULT 0,
    failed_count INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. Individual Notification Deliveries Log Table
CREATE TABLE IF NOT EXISTS notification_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_token_id UUID REFERENCES user_device_tokens(id) ON DELETE SET NULL,
    campaign_id UUID REFERENCES notification_campaigns(id) ON DELETE SET NULL,
    notification_type VARCHAR(30) NOT NULL CHECK (
        notification_type IN ('TRANSACTIONAL', 'DELIVERY_UPDATE', 'PROMOTIONAL', 'SYSTEM')
    ),
    priority VARCHAR(10) NOT NULL DEFAULT 'NORMAL' CHECK (
        priority IN ('HIGH', 'NORMAL', 'LOW')
    ),
    title VARCHAR(150) NOT NULL,
    body TEXT NOT NULL,
    deep_link TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'QUEUED' CHECK (
        status IN ('QUEUED', 'SENT', 'FAILED', 'SUPPRESSED')
    ),
    dedupe_key VARCHAR(120),
    suppression_reason VARCHAR(100),
    external_provider VARCHAR(20),
    external_message_id VARCHAR(120),
    error_message TEXT,
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_notification_dedupe UNIQUE (user_id, dedupe_key)
);

-- 6. Notification Analytics Interaction Metrics Table
CREATE TABLE IF NOT EXISTS notification_event_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    delivery_id UUID REFERENCES notification_deliveries(id) ON DELETE CASCADE,
    campaign_id UUID REFERENCES notification_campaigns(id) ON DELETE SET NULL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_type VARCHAR(20) NOT NULL CHECK (
        event_type IN ('DELIVERED', 'CLICKED', 'DISMISSED', 'FAILED')
    ),
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

## 3. CORE SERVICE MODULE IMPLEMENTATION

### 3.1 Transactional Outbox Service (`src/modules/outbox/`)
- **`stageEvent(client, input)`**: Staged within client transaction (`client.query('BEGIN')`). Zero orphan events if rolled back.
- **`claimPendingEvents(batchSize)`**: Uses row-level lock `FOR UPDATE SKIP LOCKED` (with fallback to `FOR UPDATE`) to ensure zero contention across horizontal relayer workers.
- **`markPublished(eventId)`**: Marks event as `PUBLISHED` with timestamp.
- **`markFailed(eventId, error)`**: Bounded exponential backoff (`delaySec = Math.min(2^attempts, 300)`). If attempts >= 5, transitions to `DEAD_LETTER`.
- **`replayFailedEvents(ids)`**: Operator remediation method resetting failed/DLQ events to `PENDING`.

### 3.2 Realtime WebSocket Gateway (`src/modules/realtime/websocketServer.ts`)
- **Transport Upgrade**: Intercepts HTTP `upgrade` event on `/ws`.
- **IP Connection Limiter**: Enforces max 25 sockets per IP address.
- **Authentication**: JWT signature and expiration verification, plus database session check against `auth_sessions` (`status === 'ACTIVE'`).
- **User Socket Limits**: Max 5 concurrent sockets per user account.
- **Authorization & Anti-IDOR**:
  - `order:<orderId>`: Customer must own the order or rider must be assigned to it or merchant staff must own it.
  - `user:<userId>`: Must match authenticated session `userId`.
  - `rider:<riderId>`: Must match authenticated rider.
  - `admin:fleet`: Requires `SUPER_ADMIN` or `DISPATCH_MANAGER` role.
- **Instant Revocation Handling**:
  - Session Logout -> Closes connection with code `4401` and reason `'SESSION_REVOKED'`.
  - Global `logoutAll` -> Closes all sockets associated with `userId` with code `4401` and reason `'LOGOUT_ALL'`.

### 3.3 Ephemeral Live Location Streaming (`src/modules/realtime/liveLocationService.ts`)
- **High-Velocity Anti-Spoofing Check**: Calculates Haversine distance and elapsed time between consecutive rider pings. Rejects jumps > 120 km/h with code `ERR_VELOCITY_ANOMALY`.
- **Clock Drift / Stale Pings**: Drops location updates older than 60 seconds (`ERR_STALE_TELEMETRY`).
- **Zero Table Bloat**: Ephemeral telemetry is written to Redis (`rider:telemetry:<riderId>`) with a 60-second TTL. PostgreSQL is bypassed for high-frequency coordinate pings, keeping database IOPS focused on ACID transactional operations.
- **Realtime Broadcast**: Dispatches location pings directly to `order:<orderId>` and `admin:fleet` rooms.

### 3.4 Push Notification Service (`src/modules/notifications/`)
- **Device Token Registry (`deviceTokenService.ts`)**: Generates SHA-256 hash for storage, stores masked preview, tracks platform/app version, and supports manual or automated deactivation.
- **Preferences (`preferenceService.ts`)**: Manages `push_enabled`, `delivery_updates_enabled`, `promotional_enabled`.
- **Delivery Engine (`notificationService.ts`)**:
  - Deduplication: Unique constraint `(user_id, dedupe_key)` rejects duplicate alerts.
  - Preference Enforcement: Promotional messages are suppressed if `promotional_enabled` is false.
  - Provider Integration: Pluggable `PushProvider` interface with `MockPushProvider` for testing and deterministic CI/CD execution.
  - Automatic Invalidation: If provider returns `UNREGISTERED` error, the device token is deactivated immediately.
- **Admin Campaigns (`campaignService.ts`)**:
  - Image URL Security: Strictly requires HTTPS protocol, rejecting HTTP/file/ftp protocols.
  - Deep-link Allowlist: Prevents open redirect attacks by restricting deep links to known internal route formats (`/orders/*`, `/deals/*`, `/category/*`, etc.).
  - Campaign State Machine: Manages `DRAFT` -> `SCHEDULED` -> `EXECUTING` -> `COMPLETED`.

---

## 4. VERIFICATION & TEST SUITE RESULTS

The automated test suite `QCOM/backend/tests/sprint8-realtime-notifications.test.ts` executes 18 integration tests:

| Test ID | Test Scenario | Result |
|---|---|:---:|
| Test 1 | Outbox Transactional Atomicity on Rollback (Zero phantom rows) | PASSED |
| Test 2 | Outbox Event Persistence on Commit (Atomic dual-write) | PASSED |
| Test 3 | Outbox Batch Claiming and Relayer Delivery to Consumers | PASSED |
| Test 4 | Outbox Bounded Exponential Backoff, DLQ & Operator Replay | PASSED |
| Test 5 | Realtime WebSocket Gateway Handshake & Auth (Rejects 401/Revoked) | PASSED |
| Test 6 | WebSocket Heartbeat Ping/Pong Protocol | PASSED |
| Test 7 | Channel Subscription Authorization & IDOR Block (Cross-order/Cross-user/Admin) | PASSED |
| Test 8 | Active WebSocket Severance on Session Logout (Code 4401) | PASSED |
| Test 9 | Global Logout-All Severance Across Devices (Code 4401) | PASSED |
| Test 10 | Ephemeral Live GPS & Anti-Spoofing Velocity Checks (>120km/h Block) | PASSED |
| Test 11 | Zero Second-by-Second GPS Rows in PostgreSQL (Table bloat prevention) | PASSED |
| Test 12 | Push Device Token Registration, SHA-256 Hashing & Masking | PASSED |
| Test 13 | Notification Preferences & Promotional Consent Isolation | PASSED |
| Test 14 | Idempotent Notification Deduplication (Unique dedupe_key) | PASSED |
| Test 15 | Unregistered Token Auto-Deactivation on Provider Rejection | PASSED |
| Test 16 | Admin Rich Push Campaigns, HTTPS Image & Deep Link Validation | PASSED |
| Test 17 | Notification Analytics Interaction Metrics Recording | PASSED |
| Test 18 | Future Algorithmic Decision Contract (BaselineRuleDecisionEngine) | PASSED |

### Full Test Suite Run:
```bash
npx tsx QCOM/backend/tests/run-all-tests.ts
```
**Outcome:**
`✓ ALL SPRINT 1, 2, 3, 4, 5, 6, 7 & 8 TESTS PASSED SUCCESSFULLY in 10.91s!`  
`compile_applet`: **SUCCESS**  
`lint_applet`: **SUCCESS**
