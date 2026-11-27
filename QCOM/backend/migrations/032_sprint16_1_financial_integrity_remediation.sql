-- Sprint 16.1: Independent Pricing, GST, Coupon, Refund & Financial Ledger Integrity Remediation
-- Forward-only migration (safe on PostgreSQL 16 and pg-mem).
-- Never modifies historical migrations 001 through 031.

-- 1. Track pricing quote conversion timestamp & support fast lookup on converted quotes
ALTER TABLE pricing_calculation_snapshots
  ADD COLUMN IF NOT EXISTS converted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_snapshots_order_converted
  ON pricing_calculation_snapshots(order_id, is_converted_to_order);

-- 2. Track proportional platform discount subsidy reversals on order_settlement_allocations
ALTER TABLE order_settlement_allocations
  ADD COLUMN IF NOT EXISTS reversed_platform_subsidy NUMERIC(10,2) NOT NULL DEFAULT 0.00
  CHECK (reversed_platform_subsidy >= 0);

-- 3. Prevent duplicate formal GST credit notes per return & document type
CREATE UNIQUE INDEX IF NOT EXISTS uq_credit_notes_return_type
  ON credit_notes(return_id, credit_note_type)
  WHERE return_id IS NOT NULL;

-- 4. Database-level invariants enforcing coupon/promotion usage caps & refunded quantity ceiling
ALTER TABLE coupons
  DROP CONSTRAINT IF EXISTS chk_coupons_usage_within_limit;
ALTER TABLE coupons
  ADD CONSTRAINT chk_coupons_usage_within_limit
  CHECK (usage_limit IS NULL OR usage_count <= usage_limit);

ALTER TABLE promotions
  DROP CONSTRAINT IF EXISTS chk_promotions_usage_within_limit;
ALTER TABLE promotions
  ADD CONSTRAINT chk_promotions_usage_within_limit
  CHECK (usage_limit IS NULL OR usage_count <= usage_limit);

ALTER TABLE order_items
  DROP CONSTRAINT IF EXISTS chk_order_items_refund_qty_bound;
ALTER TABLE order_items
  ADD CONSTRAINT chk_order_items_refund_qty_bound
  CHECK (refunded_quantity >= 0 AND refunded_quantity <= quantity);
