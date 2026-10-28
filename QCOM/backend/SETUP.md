# QCOM Platform — Local Setup & Deployment Guide (SETUP)

**Runtime:** Node.js v20.x or v22.x  
**Database:** PostgreSQL 16+  
**Cache/Broker:** Redis 7+  

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
   - `PORT=3000`
   - `NODE_ENV=development`
   - `DATABASE_URL=postgresql://qcom_user:qcom_pass@localhost:5432/qcom_db`
   - `REDIS_URL=redis://localhost:6379`
   - `JWT_ACCESS_SECRET=<high-entropy-secret-minimum-32-chars>`
   - `JWT_REFRESH_SECRET=<high-entropy-secret-minimum-32-chars>`
   - `PAYMENT_MODE=mock` (Never use live payment credentials in development)
   - `TELEPHONY_MODE=mock`

---

## 2. PostgreSQL 16 Database Initialization

1. Start PostgreSQL 16 locally or via Docker:
   ```bash
   docker run --name qcom-postgres -e POSTGRES_USER=qcom_user -e POSTGRES_PASSWORD=qcom_pass -e POSTGRES_DB=qcom_db -p 5432:5432 -d postgres:16
   ```

2. Run schema migrations:
   ```bash
   npm run db:migrate
   ```

3. Seed initial development fixtures (demo merchants, catalog, tax rules):
   ```bash
   npm run db:seed
   ```

---

## 3. Running Backend Services

- **Development Server with Hot Reloading:**
  ```bash
  npm run dev
  ```

- **Production Build & Execution:**
  ```bash
  npm run build
  npm start
  ```

- **Staging Orchestration via Docker Compose:**
  ```bash
  docker compose -f QCOM/backend/docker-compose.staging.yml up -d
  ```

---

## 4. Troubleshooting Common Setup Errors

- **`ECONNREFUSED 127.0.0.1:5432`:** PostgreSQL server is not running or incorrect port configured.
- **`Advisory lock timeout during migration`:** A previous migration process terminated abruptly while holding lock `42424242`. Release using: `SELECT pg_advisory_unlock(42424242);`.
- **`Redis connection refused`:** Redis is optional in development. The backend automatically activates the in-memory fallback without crashing.
