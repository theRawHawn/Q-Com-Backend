# QCOM Platform — Local Setup & Deployment Guide (SETUP)

**Runtime:** Node.js v20.x or v22.x  
**Database:** PostgreSQL 16+  
**Cache/Broker (Local Dev & Integration Testing / CI):** Redis **7.0.15** (`redis:7.0.15-alpine`)  
**Cache/Broker (Production):** Managed Redis HA Cluster (`>= 7.0.15`)

---

## 1. Environment Configuration

1. Clone repository:
   ```bash
   git clone https://github.com/theRawHawn/Q-Com-Backend.git
   cd Q-Com-Backend
   ```

2. Copy environment template:
   ```bash
   cp .env.example .env
   ```

3. Configure variables in `.env`:
   - `PORT=4000`
   - `NODE_ENV=development`
   - `DATABASE_URL=postgresql://qcom_user:qcom_password@127.0.0.1:5432/qcom_db`
   - `REDIS_URL=redis://127.0.0.1:6379`
   - `JWT_ACCESS_SECRET=<high-entropy-secret-minimum-32-chars>`
   - `JWT_REFRESH_SECRET=<high-entropy-secret-minimum-32-chars>`
   - `PAYMENT_MODE=mock` (Never use live payment credentials in development)
   - `TELEPHONY_MODE=mock`

---

## 2. PostgreSQL 16 & Redis 7.0.15 Initialization

QCOM pins **exact Redis `7.0.15`** (`redis:7.0.15-alpine`) across local integration testing, Docker Compose (`docker-compose.integration.yml`, `docker-compose.staging.yml`), and GitHub Actions CI. Pinning prevents behavioral drift across Lua sliding-window rate limiting, TTL expiration semantics, and Pub/Sub delivery.

### Option A: Docker (Standalone or Compose)

1. Start PostgreSQL 16 and Redis `7.0.15`:
   ```bash
   docker compose -f QCOM/backend/docker-compose.integration.yml up -d
   ```
   Or start Redis `7.0.15` standalone:
   ```bash
   docker run --name qcom-redis -p 6379:6379 -d redis:7.0.15-alpine
   ```
   (Never use unpinned tags like `redis:7`, `redis:7-alpine`, or `redis:latest`.)

### Option B: Debian 12 Native Packages (Sandbox / Local Linux)

```bash
bash QCOM/backend/scripts/start-services.sh
```

### Verify Installed & Running Redis Version

Check via `redis-cli` or the repository preflight script:
```bash
redis-cli -h 127.0.0.1 -p 6379 INFO server | grep redis_version
# Expected: redis_version:7.0.15

npm --prefix QCOM/backend run verify:redis
```
If the active Redis server does not report exact `redis_version:7.0.15`, `verify:redis` and the integration test runner abort cleanly with the expected version (`7.0.15`), actual version found, and manual provisioning steps—existing local Redis installations are never modified automatically, and in-memory fallbacks are never substituted in integration tests.

### Database Migrations & Seeds

1. Run schema migrations (`001`–`026`):
   ```bash
   npm --prefix QCOM/backend run db:migrate
   ```

2. Seed initial development fixtures (demo merchants, catalog, tax rules):
   ```bash
   npm --prefix QCOM/backend run db:seed
   ```

---

## 3. Running Backend Services

- **Development Server with Hot Reloading:**
  ```bash
  npm --prefix QCOM/backend run dev
  ```

- **Production Build & Execution:**
  ```bash
  npm --prefix QCOM/backend run build
  npm --prefix QCOM/backend start
  ```

- **Staging Orchestration via Docker Compose (uses `redis:7.0.15-alpine`):**
  ```bash
  docker compose -f QCOM/backend/docker-compose.staging.yml up -d
  ```

---

## 4. Production vs. Integration Redis Note

- **Local Integration & CI:** Strictly pinned to `redis:7.0.15-alpine` (`7.0.15`).
- **Production:** Deploy managed Redis High-Availability (Sentinel/Cluster, `>= 7.0.15`) with TLS, `requirepass`/ACL, and persistent AOF/RDB snapshots as required.

---

## 5. Troubleshooting Common Setup Errors

- **`ECONNREFUSED 127.0.0.1:5432`:** PostgreSQL server is not running or incorrect port configured.
- **`Advisory lock timeout during migration`:** A previous migration process terminated abruptly while holding lock `42424242`. Release using: `SELECT pg_advisory_unlock(42424242);`.
- **`[FATAL] Redis version mismatch detected`:** Your local Redis instance is not `7.0.15`. Stop the mismatched instance or point `REDIS_URL` to a `redis:7.0.15-alpine` container (`docker run -d --name qcom-redis -p 6379:6379 redis:7.0.15-alpine`).
- **`Redis connection refused`:** When running the app server standalone in `NODE_ENV=development` (outside integration tests), non-critical caches degrade gracefully; integration tests and production rate-limiting require live Redis (`FORCE_REDIS=1`).
