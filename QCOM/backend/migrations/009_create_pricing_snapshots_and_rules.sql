-- Migration 009: Create Pricing Rules and Pricing Calculation Snapshots

-- 1. Pricing Delivery and Handling Rules Table
CREATE TABLE IF NOT EXISTS pricing_delivery_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_code VARCHAR(60) UNIQUE NOT NULL,
    name VARCHAR(120) NOT NULL,
    base_distance_km NUMERIC(6,2) NOT NULL DEFAULT 3.00 CHECK (base_distance_km >= 0),
    base_fee_inr NUMERIC(10,2) NOT NULL DEFAULT 35.00 CHECK (base_fee_inr >= 0),
    per_km_fee_inr NUMERIC(10,2) NOT NULL DEFAULT 10.00 CHECK (per_km_fee_inr >= 0),
    free_delivery_threshold_inr NUMERIC(10,2) CHECK (free_delivery_threshold_inr IS NULL OR free_delivery_threshold_inr >= 0),
    handling_fee_inr NUMERIC(10,2) NOT NULL DEFAULT 5.00 CHECK (handling_fee_inr >= 0),
    platform_fee_inr NUMERIC(10,2) NOT NULL DEFAULT 0.00 CHECK (platform_fee_inr >= 0),
    effective_from DATE NOT NULL,
    effective_to DATE,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT chk_pricing_delivery_dates CHECK (effective_to IS NULL OR effective_from <= effective_to)
);

CREATE INDEX IF NOT EXISTS idx_pricing_delivery_dates ON pricing_delivery_rules(effective_from, effective_to);

-- 2. Pricing Calculation Snapshots Table (Authoritative PostgreSQL Ledger for Frozen Quotes)
CREATE TABLE IF NOT EXISTS pricing_calculation_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key VARCHAR(120),
    pricing_engine_version VARCHAR(20) NOT NULL DEFAULT '3.0.0',
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    store_id UUID REFERENCES merchant_stores(id) ON DELETE SET NULL,
    place_of_supply_state_code VARCHAR(10) NOT NULL DEFAULT '29',
    currency VARCHAR(10) NOT NULL DEFAULT 'INR',
    items_subtotal NUMERIC(12,2) NOT NULL CHECK (items_subtotal >= 0),
    discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (discount_amount >= 0),
    taxable_amount NUMERIC(12,2) NOT NULL CHECK (taxable_amount >= 0),
    delivery_fee NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (delivery_fee >= 0),
    handling_fee NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (handling_fee >= 0),
    platform_fee NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (platform_fee >= 0),
    cgst_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (cgst_amount >= 0),
    sgst_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (sgst_amount >= 0),
    igst_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (igst_amount >= 0),
    total_tax NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (total_tax >= 0),
    grand_total NUMERIC(12,2) NOT NULL CHECK (grand_total >= 0),
    gst_tcs_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (gst_tcs_amount >= 0),
    withholding_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (withholding_amount >= 0),
    snapshot_data JSONB NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    is_converted_to_order BOOLEAN NOT NULL DEFAULT FALSE,
    order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pricing_snapshots_merchant ON pricing_calculation_snapshots(merchant_id);
CREATE INDEX IF NOT EXISTS idx_pricing_snapshots_user ON pricing_calculation_snapshots(user_id);
CREATE INDEX IF NOT EXISTS idx_pricing_snapshots_idempotency ON pricing_calculation_snapshots(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_pricing_snapshots_created ON pricing_calculation_snapshots(created_at);
CREATE INDEX IF NOT EXISTS idx_pricing_snapshots_expires ON pricing_calculation_snapshots(expires_at);
