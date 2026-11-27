# QCOM Database & Schema Architecture Specification (DATABASE)

**Engine Requirement:** PostgreSQL 16+  
**Migration Tool:** Custom Idempotent Advisory-Locked Migrator (`scripts/migrate.ts`)  
**Migrations Applied:** 001 through 032 (Verified & Tested)  

---

## 1. Schema Migration Registry

| Migration | File | Key Tables / Constraints |
| :--- | :--- | :--- |
| **001** | `001_enable_extensions.sql` | `uuid-ossp`, `pgcrypto`, `btree_gist` |
| **002** | `002_create_users_and_auth.sql` | `users`, `roles`, `permissions`, `role_permissions`, `user_roles` |
| **003** | `003_create_merchants_and_catalog.sql`| `merchants`, `merchant_stores`, `store_staff`, `products`, `store_inventory` |
| **004** | `004_create_orders_and_trips.sql` | `orders`, `order_items`, `riders`, `delivery_trips` |
| **005** | `005_create_financial_ledgers.sql` | `general_ledger_accounts`, `general_ledger_entries`, `seller_ledgers`, `rider_ledgers` |
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
| **017** | `017_create_returns_and_refunds.sql` | `refunds`, `order_returns`, `order_return_items` |
| **018** | `018_enforce_general_ledger_uniqueness.sql` | Idempotent unique ledger constraints on `general_ledger_entries` |
| **019** | `019_enforce_payout_idempotency_uniqueness.sql` | UNIQUE constraint on `seller_payouts(idempotency_key)` & `rider_payouts(idempotency_key)` |
| **020** | `020_add_financial_recovery_metadata.sql` | Stalled state recovery columns and retry counters |
| **021** | `021_create_selective_reservations_and_stock_alerts.sql` | `seller_stock_alerts` and reservation expiry metadata |
| **022** | `022_create_payment_attempts_and_provider_agnostic_schema.sql`| `payment_attempts` with `UNIQUE (order_id, attempt_number)` |
| **023** | `023_add_payment_intent_recovery_leases.sql`| `payment_intent_recovery_leases` for distributed worker fencing |
| **024** | `024_add_password_hash_and_otp_salt.sql`| `salt` on `otp_challenges`; `password_hash`, `password_updated_at`, `failed_password_attempts`, `password_locked_until` on `users` |
| **025** | `025_add_outbox_worker_leases.sql` | Durable outbox relay leases across workers |
| **026** | `026_sprint15_2_capacity_indexes_and_concurrency.sql` | Hot-path indexes and capacity concurrency optimizations |
| **027** | `027_sprint15_5_financial_ledger_settlement_integrity.sql` | `ledger_journal_batches` atomic claim registry, FIFO `settled_amount` & `refunded_amount` on `order_settlement_allocations`, `seq_no` triggers on `seller_ledgers`/`rider_ledgers`, `REVERSED` status on `seller_payouts`, append-only `UPDATE`/`DELETE`/`TRUNCATE` triggers (`LEDGER_IMMUTABLE`), and `PUBLIC` mutation revocations |
| **028** | `028_sprint15_7_transaction_cod_reverse_trip_integrity.sql` | Partial unique trip indexes (`uq_delivery_trips_forward_order`, `uq_delivery_trips_reverse_return`, `uq_delivery_trips_active_reverse_order`), GPS candidate index `idx_riders_dispatch_candidates` |
| **029** | `029_sprint15_8_gateway_agnostic_payment_integrity.sql` | Normalized payment integrity indexes (`uq_payment_intents_single_active_per_order`, `uq_payment_intents_single_captured_per_order`, `uq_payment_attempts_single_active_per_order`, `uq_payment_attempts_single_succeeded_per_order`, `uq_payment_tx_single_capture_per_order`, `uq_payment_receipts_order_success`), `reconciliation_runs`, `reconciliation_discrepancies` |
| **030** | `030_sprint15_9_cod_cash_accountability.sql` | `cod_collections` (1:1 per COD order), `cod_remittances` with DB `CHECK` separation of duties (`submitted_by <> received_by <> verified_by`), `cod_remittance_allocations`, `cod_cash_disputes`, `riders.cod_restricted` & ceiling override columns, and COA accounts `1050`, `2080`, `5030` |
| **031** | `031_sprint16_0_pricing_gst_coupons_promotions.sql` | `indian_states` (37 state/UT codes), `pricing_calculation_snapshots` & `seller_product_tax` extensions, `promotions`, `promotion_applications`, `coupon_redemptions` (`RESERVED`/`REDEEMED`/`RELEASED`/`REVERSED`), `carts`, `cart_items`, `credit_notes`, `credit_note_line_items`, COA `5040` (`Platform Promotion Subsidy`), `products.pricing_mode`/`cess_rate_percent`/`tax_category`/`is_tax_classification_verified`, `merchants.state_code`, `orders` Place of Supply & price-drift columns, `gst_invoices` honest `irn` (`NULL` default) & `e_invoicing_status` |
| **032** | `032_sprint16_1_financial_integrity_remediation.sql` | `pricing_calculation_snapshots.converted_at` + `idx_snapshots_order_converted`, `order_settlement_allocations.reversed_platform_subsidy` (`CHECK >= 0`), unique partial index `uq_credit_notes_return_type` (`return_id, credit_note_type`), DB ceiling constraints `chk_coupons_usage_within_limit`, `chk_promotions_usage_within_limit`, and `chk_order_items_refund_qty_bound` |

---

## 2. Critical Database Invariants

1. **Zero Oversell Invariant:**  
   Store inventory quantity check: `CHECK (stock_count >= 0)`, `CHECK (reserved_count >= 0)`, and `CONSTRAINT chk_reserved_le_stock CHECK (reserved_count <= stock_count)` on `store_inventory`. Concurrency is managed via `SELECT ... FOR UPDATE` row locks inside explicit transactions during checkout.
2. **Double-Entry General Ledger Balance:**  
   Every posted transaction batch in `general_ledger_entries` enforces:
   $$\sum \text{DEBIT Amounts} == \sum \text{CREDIT Amounts}$$
3. **Idempotency Guarantees:**  
   - Webhook events: `UNIQUE (event_id)`.
   - Payment attempts: `UNIQUE (order_id, attempt_number)` and `UNIQUE (provider_id, provider_reference)`.
   - Payout releases: `UNIQUE (idempotency_key)`.
4. **Advisory Lock Migrations:**  
   Migrations use a serialized advisory lock (`SELECT pg_advisory_lock(42424242)`) to ensure multiple backend instances starting concurrently do not run race-conditioned migrations.
5. **Security & Suspension Schema:**  
   User suspension state is stored authoritatively on `users.is_suspended` / `users.suspension_reason`, session versioning on `auth_sessions.token_version`, return requests on `order_returns`, and refund records on `refunds`.
6. **Append-Only Ledger Immutability & Deterministic Ordering:**  
   PostgreSQL triggers (`fn_prevent_gl_mutation` on `general_ledger_entries`/`ledger_journal_batches`, `fn_prevent_subledger_mutation` on `seller_ledgers`/`rider_ledgers`, and `fn_prevent_ledger_truncate` on all four tables) block historical `UPDATE`, `DELETE`, and `TRUNCATE` mutations with `LEDGER_IMMUTABLE`, reinforced by `REVOKE UPDATE, DELETE, TRUNCATE ... FROM PUBLIC`. Monotonic `seq_no` triggers guarantee deterministic balance snapshot reads even under identical millisecond timestamps. *(Security boundary: while triggers fire for normal SQL sessions, PostgreSQL database owners and superusers technically retain DDL/trigger-disable privileges, so production deployments must connect using a dedicated `NOSUPERUSER` non-owner application role.)*
7. **COD Cash Custody & Separation-of-Duties Constraints (Migration 030):**  
   `cod_collections` enforces `UNIQUE (order_id)` and `allocated_amount + cleared_amount <= collected_amount`. `cod_remittances` enforces `chk_cod_remit_receiver_not_submitter`, `chk_cod_remit_verifier_not_submitter`, and `chk_cod_remit_verifier_not_receiver` at the database layer alongside partial idempotency uniqueness `uq_cod_remittances_idempotency`. `cod_cash_disputes` enforces single open shortage/excess dispute per remittance (`uq_cod_disputes_remit_type_open`).
8. **Pricing Snapshot Immutability, Coupon Slot Integrity & GST Credit Notes (Migrations 031 & 032):**  
   `coupons` and `promotions` enforce `usage_limit IS NULL OR usage_count <= usage_limit` (`chk_coupons_usage_within_limit` / `chk_promotions_usage_within_limit`) and `usage_count >= 0`, mutated atomically under `users FOR UPDATE` + row-level coupon/promotion locks with `coupon_redemptions` (`RESERVED` -> `REDEEMED` / `RELEASED` / `REVERSED`). `order_items` enforces `refunded_quantity >= 0 AND refunded_quantity <= quantity` (`chk_order_items_refund_qty_bound`). `credit_notes` enforces `UNIQUE (return_id, credit_note_type) WHERE return_id IS NOT NULL` (`uq_credit_notes_return_type`). `pricing_calculation_snapshots` enforces single-use conversion via `converted_at` + ownership/merchant matching, and `order_settlement_allocations.reversed_platform_subsidy` tracks COA `5040` unwinding on returns.

