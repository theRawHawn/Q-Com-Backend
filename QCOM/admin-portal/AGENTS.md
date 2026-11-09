# AI Agent Guidelines & Architecture Reference

This document provides persistent context and guidelines for AI coding agents and human developers maintaining the Q-Commerce Marketplace Admin Panel.

## 1. Environment Variables Guidelines

All configurable parameters MUST use environment variables and have fallbacks declared in `.env.example`:

- `NODE_ENV`: 'development' or 'production'.
- `APP_URL`: Base application URL.
- `GEMINI_API_KEY`: Server-side only Gemini AI key. Never prefix with `VITE_` or expose to browser.
- `SESSION_TTL_HOURS`: Admin session expiration in hours (default: `24`).
- `RATE_LIMIT_WINDOW_MS`: Sliding window in ms for rate limiters (default: `60000`).
- `RATE_LIMIT_MAX_GENERAL`: Max requests per window on regular endpoints (default: `300`).
- `RATE_LIMIT_MAX_SENSITIVE`: Max requests per window on payout/finance/admin mutation endpoints (default: `40`).
- `ALLOWED_ORIGINS`: Comma-separated list of CORS allowed origins.
- `CSP_FRAME_ANCESTORS`: Custom CSP frame-ancestors directive.
- `SERVICE_NAME`: Service label reported in `/api/health`.
- `ACTIVE_ZONE`: Fulfillment cluster reported in telemetry.

### Rules:
1. **Never Hardcode Values**: Avoid hardcoding financial totals, user IDs, business metrics, or URLs. Always pull from the store or configurable environment variables.
2. **Never Expose Secrets to Client**: All API keys and secrets belong in the Express backend (`server/`), accessed via `process.env`. Only non-sensitive public configs may be exposed to the client.

## 2. Security & Authentication Architecture

- **Session Store**: `server/security.ts` manages admin sessions (`AdminSessionManager`).
- **Authorization**: `server/routes/adminRoutes.ts` uses `authenticateAdmin` middleware to validate tokens (`Authorization: Bearer <token>` or `x-admin-session-token`).
- **Role Verification**: Admin roles and permissions are always read from the authoritative backend database (`authoritativeAdminStore.getEmployees()`), NEVER trusted blindly from headers.
- **RBAC**: Guard routes using `requirePermission('<permission_code>')`. Financial payout endpoints MUST require `riders.payout` and apply `sensitiveOpsLimiter`.
- **Input Sanitization**: All inbound JSON/form data passes through `inputSanitizationMiddleware` in `server.ts` to neutralize prototype pollution (`__proto__`, `constructor`, `prototype`) and script injection.

## 3. Server & Build Setup

- **Port**: Always bind to port `3000` and host `0.0.0.0`.
- **Build**: `npm run build` runs `vite build` for frontend and compiles `server.ts` to `dist/server.cjs` via esbuild.
- **Start**: `npm start` executes `node dist/server.cjs`.
