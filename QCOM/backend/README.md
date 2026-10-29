# QCOM Unified Quick Commerce Backend Engine

QCOM is an enterprise-grade backend platform powering a 10-to-20 minute quick-commerce marketplace in India. It serves four distinct applications: Customer PWA, Seller Portal, Delivery Partner App, and Admin Operations Portal.

---

## Documentation Quick Links

| Document | Purpose |
| :--- | :--- |
| [PRD.md](./PRD.md) | Product requirements, business domain, and applications |
| [DESIGN.md](./DESIGN.md) | Architectural choices, trade-offs, and domain design |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Component inventory, topology, and scaling strategy |
| [DATABASE.md](./DATABASE.md) | PostgreSQL 16 schema, migrations (001-025), and invariants |
| [API.md](./API.md) | HTTP and WebSocket API contracts and error schemas |
| [AUTH.md](./AUTH.md) | Authentication flows, session lifecycle, and IDOR protection |
| [PLAN.md](./PLAN.md) | Engineering milestones and forward roadmap |
| [SETUP.md](./SETUP.md) | Local development setup and environment configuration |
| [FEATURES.md](./FEATURES.md) | Feature matrix and implementation status |
| [INTEGRATIONS.md](./INTEGRATIONS.md) | Service adapters, Redis, and payment provider abstraction |
| [TESTING.md](./TESTING.md) | Test organization, test commands, and concurrency suites |
| [DEBUGGING.md](./DEBUGGING.md) | Troubleshooting guides, health probes, and recovery tools |
| [AGENTS.md](./AGENTS.md) | Instructions and rules for AI coding assistants |
| [MCP.md](./MCP.md) | Model Context Protocol implementation status (Not Implemented) |

---

## Quick Start

### 1. Prerequisites
- Node.js v20+ / v22+
- PostgreSQL 16
- Redis 7 (optional for local development; production security-sensitive rate limits require distributed Redis)

### 2. Environment Configuration
Copy `.env.example` to `.env` and configure your database target:
```bash
cp .env.example .env
```
When running behind a reverse proxy, set `TRUST_PROXY_CIDRS` to a comma-separated list of the proxy's exact IPs/CIDRs. Leave it empty for direct connections; arbitrary `X-Forwarded-For` headers are not trusted.

### 3. Database Migration & Seeding
```bash
npm run db:migrate
npm run db:seed
```

### 4. Running Backend
```bash
npm run dev
```

### 5. Running the Complete Automated Test Suite
From workspace root:
```bash
npm run test:backend
```
Or from `QCOM/backend`:
```bash
npm test
```
