# QCOM Database & Schema Architecture Specification (DATABASE)

**Engine Requirement:** PostgreSQL 16+  
**Migration Tool:** Custom Idempotent Advisory-Locked Migrator (`scripts/migrate.ts`)  
**Migrations Defined:** 001 through 025; deployed application of Migration 025 must be verified per environment.

---

## 1. Schema Migration Registry

| Migration | File | Key Tables / Constraints |
| :--- | :--- | :--- |
| **001** | `001_enable_extensions.sql` | `uuid-ossp`, `pgcrypto`, `btree_gist` |
| **002** | `002_create_users_and_auth.sql` | `users`, `roles`, `permissions`, `role_permissions`, `user_roles` |
| **003** | `003_create_merchants_and_catalog.sql`| `merchants`, `stores`, `categories`, `products`, `merchant_inventory` |
| **004** | `004_create_orders_and_trips.sql` | `orders`, `order_items`, `delivery_trips`, `rider_locations` |
| **005** | `005_create_financial_ledgers.sql` | `accounts`, `journal_batches`, `journal_entries` |
| **006** | `006_create_idempotency_and_webhooks.sql`| `idempotency_keys`, `webhook_events` (UNIQUE `event_id`) |
| **007** | `007_create_statutory_tax_rules.sql` | `statutory_tax_rules`, `withholding_rules` |
| **008** | `008_create_auth_and_sessions.sql` | `auth_sessions`, `otp_challenges` |
| **009** | `009_create_pricing_snapshots_and_rules.sql` | `pricing_rules`, `order_pricing_snapshots` |
| **010** | `010_create_seller_product_tax.sql` | `merchant_tax_configs`, `product_tax_overrides` |
| **011** | `011_create_coupons_and_promotions.sql` | `coupons`, `coupon_redemptions` |
| **012** | `012_create_migration_extensions.sql` | Advisory lock compatibility & health probes |
| **013** | `013_create_dispatch_tables.sql` | `dispatch_broadcasts`, `rider_duty_sessions` |
| **014** | `014_update_payment_state_machine.sql`| `payment_intents` state enum expansion |
| **015** | `015_create_settlement_and_payout_tables.sql`| `seller_payouts`, `rider_payouts` |
| **016** | `016_create_realtime_outbox_and_notifications.sql`| `outbox_events`, `notifications` |
| **017** | `017_create_returns_and_refunds.sql` | `return_requests`, `refunds` |
| **018** | `018_enforce_general_ledger_uniqueness.sql` | UNIQUE constraint on `journal_entries(journal_batch_id, line_number)` |
| **019** | `019_enforce_payout_idempotency_uniqueness.sql` | UNIQUE constraint on `seller_payouts(idempotency_key)` & `rider_payouts(idempotency_key)` |
| **020** | `020_add_financial_recovery_metadata.sql` | Stalled state recovery columns and retry counters |
| **021** | `021_create_selective_reservations_and_stock_alerts.sql` | `inventory_reservations`, `stock_alerts` |
| **022** | `022_create_payment_attempts_and_provider_agnostic_schema.sql`| `payment_attempts` with `UNIQUE (order_id, attempt_number)` |
| **023** | `023_add_payment_intent_recovery_leases.sql`| `payment_intent_recovery_leases` for distributed worker fencing |
| **024** | `024_add_password_hash_and_otp_salt.sql`| `salt` on `otp_challenges`; `password_hash`, `password_updated_at`, `failed_password_attempts`, `password_locked_until` on `users` |
| **025** | `025_add_outbox_worker_leases.sql` | `lease_token` and `lease_expires_at` for durable outbox worker fencing |

---

## 2. Critical Database Invariants

1. **Zero Oversell Invariant:**  
   Store inventory quantity check: `CHECK (available_quantity >= 0)`. Concurrency is managed via `SELECT ... FOR UPDATE` row locks inside explicit transactions during checkout.
2. **Double-Entry General Ledger Balance:**  
   Every `journal_batches` record must contain journal entries where:
   $$\sum \text{Debit Amounts} == \sum \text{Credit Amounts}$$
3. **Idempotency Guarantees:**  
   - Webhook events: `UNIQUE (event_id)`.
   - Payment attempts: `UNIQUE (order_id, attempt_number)` and `UNIQUE (provider_id, provider_reference)`.
   - Payout releases: `UNIQUE (idempotency_key)`.
4. **Advisory Lock Migrations:**  
   Migrations use a serialized advisory lock (`SELECT pg_advisory_lock(42424242)`) to ensure multiple backend instances starting concurrently do not run race-conditioned migrations.
5. **Outbox Worker Fencing:**
    Migration 025 leases pending events for five minutes without changing their business status. Expired claims are reclaimable; only the current, unexpired token may mark an event published or retry it. Event consumers must remain idempotent because delivery is at-least-once if a lease expires after an external side effect.
