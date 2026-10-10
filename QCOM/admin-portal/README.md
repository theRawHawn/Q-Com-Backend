# Q-Commerce Marketplace Central Admin & Control Room

A comprehensive, production-grade quick-commerce admin panel and live control room built with React, TypeScript, Tailwind CSS, and Express.

---

## Environment Variables Reference

All configurable environment variables are documented in [`.env.example`](./.env.example). Below is an exhaustive reference of all variables supported by the system:

| Variable | Type | Default | Required? | Description |
| :--- | :--- | :--- | :--- | :--- |
| `NODE_ENV` | String | `development` | No | Runtime environment (`development` or `production`). Production mode enforces HSTS, suppresses debug error traces, and serves compiled static files. |
| `APP_URL` | String | `http://localhost:3000` | No | The public URL of the application. In Google AI Studio / Cloud Run, this is automatically injected. |
| `GEMINI_API_KEY` | String | *None* | Optional | API key for server-side Google Gemini AI calls (smart demand forecasting, catalog categorization, analytics insights). **Server-side only; never expose to client.** |
| `SESSION_TTL_HOURS` | Number | `24` | No | Cryptographic admin session token lifetime in hours before expiration. |
| `RATE_LIMIT_WINDOW_MS` | Number | `60000` (1 min) | No | Sliding window duration in milliseconds for IP and actor request throttling. |
| `RATE_LIMIT_MAX_GENERAL` | Number | `300` | No | Maximum permitted requests per window for standard admin endpoints. |
| `RATE_LIMIT_MAX_SENSITIVE` | Number | `40` | No | Maximum permitted requests per window for sensitive operations (rider payouts, refunds, employee permissions, account freezes). |
| `ALLOWED_ORIGINS` | String | *Empty* | No | Comma-separated list of additional external domain origins allowed by CORS (e.g. `https://ops.example.com,https://admin.example.com`). |
| `CSP_FRAME_ANCESTORS` | String | *Default below* | No | Custom Content Security Policy `frame-ancestors` directive. Default: `"frame-ancestors 'self' https://ai.studio https://*.ai.studio https://*.google.com https://*.run.app"`. |
| `SERVICE_NAME` | String | `QCOM Marketplace Central Control API` | No | Service identity name returned by `/api/health` and recorded in security audit logs. |
| `ACTIVE_ZONE` | String | `Bengaluru (BLR-1)` | No | Operations fulfillment cluster identifier returned by system telemetry. |

---

## Security & Architecture Highlights

1. **Cryptographic Session Authentication**:
   - Replaced spoofable request headers with high-entropy cryptographic session tokens (`qcom_adm_<hex>`).
   - Session tokens are acquired via `/api/admin/auth/session` or `/api/admin/auth/switch-persona` and sent via `Authorization: Bearer <token>` or `x-admin-session-token`.
   - Permissions and roles are strictly verified on the backend from the authoritative employee record—client-supplied role headers can never elevate privileges.

2. **Fine-Grained Dynamic RBAC**:
   - Every administrative action requires explicit granular permissions (e.g. `riders.payout`, `orders.cancel`, `settlements.approve`, `employees.create`).
   - Fleet payouts are strictly reserved for `DELIVERY_MANAGER`, `FINANCE_ADMIN`, and `SUPER_ADMIN`.

3. **Multi-Tier Rate Limiting**:
   - Standard routes: 300 requests/minute.
   - Sensitive financial and governance routes: 40 requests/minute.
   - Responds with RFC-compliant headers: `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, and `Retry-After`.

4. **Input Sanitization & Prototype Pollution Defense**:
   - Recursively strips dangerous object keys (`__proto__`, `constructor`, `prototype`).
   - Strips malicious HTML/script tags from user-supplied payloads to prevent Stored XSS.

5. **Hardened Headers & Framing**:
   - Dynamic CSP with `frame-ancestors` allowing seamless Google AI Studio preview while preventing unauthorized third-party framing / clickjacking.
   - `X-Content-Type-Options: nosniff`, `X-XSS-Protection`, `Referrer-Policy: strict-origin-when-cross-origin`, and `Permissions-Policy`.
   - `X-Powered-By` header disabled.

---

## Getting Started

### 1. Installation
```bash
npm install
```

### 2. Configure Environment
```bash
cp .env.example .env
```
Edit `.env` to customize session timeouts, rate limits, or add your Gemini API key if utilizing AI features.

### 3. Development Server
```bash
npm run dev
```
Starts Express with Vite middleware on `http://localhost:3000`.

### 4. Production Build & Start
```bash
npm run build
npm start
```
Builds the Vite client bundle to `dist/` and compiles the standalone backend server to `dist/server.cjs`, then launches on port 3000.
