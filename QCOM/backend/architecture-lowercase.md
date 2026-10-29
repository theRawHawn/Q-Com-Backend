# QCOM Backend Architecture Specification

**Architecture Style:** Modular Monolith (Single-Process, Multi-Domain Engine)  
**Authoritative Store:** PostgreSQL 16  
**Ephemeral / PubSub Cache:** Redis 7  
**Gateway & Real-Time:** Express 4.x + `ws` WebSocket Server  
**Target Environment:** Containerized Node.js (Docker / Cloud Run)  

---

## 1. System Topology & Architecture Diagram

```mermaid
graph TD
    subgraph Clients
        CA[Customer App]
        SP[Seller Portal]
        DA[Delivery App]
        AP[Admin Portal]
    end

    subgraph QCOM_Backend_Modular_Monolith [QCOM Backend Engine]
        API_GW[Express REST Router & Security Middleware]
        WS_GW[WebSocket Gateway /ws/v1]
        
        subgraph Domain_Modules [Domain Modules]
            AUTH[Auth & RBAC Module]
            CAT[Catalog & Pricing]
            INV[Inventory Engine]
            ORD[Orders & Checkout]
            DISP[Dispatch & Delivery]
            PAY[Payment & Webhooks]
            SETT[Settlement & Ledger Engine]
            NOTIF[Notification & Outbox Bus]
        end

        subgraph Background_Workers [Background Workers]
            REC_W[Financial Recovery Worker]
            OUT_W[Outbox Event Relayer]
            STK_W[Stock Alert Consumer]
        end
    end

    subgraph Infrastructure
        PG[(PostgreSQL 16 Authoritative DB)]
        RD[(Redis 7 Ephemeral Cache & PubSub)]
    end

    CA -->|HTTP / JSON| API_GW
    SP -->|HTTP / JSON| API_GW
    DA -->|HTTP / JSON| API_GW
    AP -->|HTTP / JSON| API_GW

    CA -.->|WSS / Realtime| WS_GW
    DA -.->|WSS / Realtime| WS_GW

    API_GW --> Domain_Modules
    WS_GW --> Domain_Modules

    Domain_Modules -->|ACID SQL & Row Locks| PG
    Domain_Modules -->|Ephemeral GPS & Subscriptions| RD
    Background_Workers -->|Poll & Lease Execution| PG
    Background_Workers -->|PubSub Event Delivery| RD
```

---

## 2. Component Inventory & Module Responsibilities

| Module | Source Path | Primary Responsibility | Authoritative Tables |
| :--- | :--- | :--- | :--- |
| **Auth & RBAC** | `src/modules/auth`, `src/modules/rbac` | Phone OTP authentication, JWT generation, user sessions, role permissions | `users`, `auth_sessions`, `otp_challenges`, `roles`, `permissions` |
| **Catalog & Pricing** | `src/modules/catalog`, `src/modules/pricing` | Product master, merchant store catalog, dynamic delivery and tax pricing calculation | `products`, `merchants`, `pricing_rules`, `statutory_tax_rules` |
| **Inventory** | `src/modules/inventory` | Multi-store stock tracking, selective reservations, zero-oversell row locking | `merchant_inventory`, `inventory_reservations`, `stock_alerts` |
| **Orders** | `src/modules/orders` | Checkout orchestration, order state machine, cancellation & compensation | `orders`, `order_items` |
| **Dispatch & Delivery**| `src/modules/dispatch`, `src/modules/delivery` | Rider proximity discovery, trip broadcasting, delivery OTP handshakes | `delivery_trips`, `rider_profiles`, `rider_locations` |
| **Payments** | `src/modules/payments` | Payment provider abstraction, durable webhook deduplication, refund state machine | `payment_intents`, `payment_attempts`, `webhook_events`, `refunds` |
| **Settlement & Ledger**| `src/modules/settlements`, `src/modules/ledger` | Double-entry journal accounting, merchant payouts, rider earnings, statutory withholding (TDS/TCS) | `journal_batches`, `journal_entries`, `accounts`, `seller_payouts`, `rider_payouts` |
| **Outbox & Events** | `src/modules/outbox`, `src/modules/notifications` | Transactional outbox event publishing, SMS/push notification queues | `outbox_events`, `notifications` |
| **Realtime** | `src/modules/realtime` | WebSocket connection lifecycle, private channel authorization, ephemeral GPS telemetry | Ephemeral (Redis / Memory) |
| **Recovery** | `src/modules/recovery` | Lease-based financial recovery worker for stalled transactions and reconciliation | `payment_intent_recovery_leases` |

---

## 3. Request Flow & Transaction Boundaries

1. **Client Request:** Validated against input schemas (Zod/custom validators) in Express route controllers.
2. **Authentication Middleware:** Validates JWT signature and active session record in `auth_sessions`.
3. **RBAC Authorization:** Evaluates granular permissions (`orders:create`, `merchants:inventory:read`, etc.) and enforces tenant isolation (`merchant_id`).
4. **Service Execution & Atomic DB Transaction:** Services execute within `transaction(async (client) => { ... })`. For critical updates, row-level locks (`FOR UPDATE`) are acquired.
5. **Outbox Emission:** Event payloads are inserted into `outbox_events` as part of the same SQL transaction.
6. **Response Dispatch:** HTTP 200/201 response emitted to client; background worker picks up outbox records asynchronously.

---

## 4. Multi-Instance & Scaling Strategy

- **Stateless HTTP Layer:** Backend instances run statelessly behind a standard load balancer.
- **Distributed Lock Management:** PostgreSQL advisory locks (`pg_advisory_lock`) and leasing tables prevent concurrent worker conflicts across instances.
- **Redis Pub/Sub Backplane:** Multi-instance WebSocket broadcasting uses Redis Pub/Sub channels to ensure real-time messages reach clients connected to any node.
- **Outbox Worker Claims:** Workers persist a lease token and expiry in PostgreSQL before delivering pending events; a stale token cannot mark an event complete. Delivery remains at-least-once, so consumers must be idempotent.

### Request Admission and Failure Behavior

- Redis-backed sliding-window rate limits use a single atomic Lua script. Counters are shared across backend instances when they use the same Redis deployment.
- OTP, authentication, checkout, payment initiation, webhook ingestion, dispatch actions, and inventory mutations reject with `503 RATE_LIMIT_UNAVAILABLE` if distributed admission cannot be checked. They do not fall back to process-local counters in production.
- The general 120-request/minute per-route/IP guard is an availability-oriented outer limit: if Redis is unavailable it logs the condition, marks `X-RateLimit-Status: unavailable`, and continues. Sensitive route-specific limits remain fail-closed.
- `TRUST_PROXY_CIDRS` controls Express forwarded-address trust. An empty value trusts no proxy headers; configure only the exact ingress/load-balancer CIDRs used by the deployment.
- Initial limits are provisional because representative production traffic has not been measured. PostgreSQL remains authoritative for all financial and inventory state.
