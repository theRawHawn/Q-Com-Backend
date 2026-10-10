-- Migration 011: Create Coupons and Promotions Table for Dynamic Data-Driven Discounts
-- Eliminates hardcoded coupon logic, percentages, and thresholds from application code

CREATE TABLE IF NOT EXISTS coupons (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(40) UNIQUE NOT NULL,
    description TEXT,
    discount_type VARCHAR(20) NOT NULL CHECK (discount_type IN ('FLAT_AMOUNT', 'PERCENTAGE')),
    discount_value NUMERIC(10,2) NOT NULL CHECK (discount_value > 0),
    min_order_value_inr NUMERIC(10,2) NOT NULL DEFAULT 0.00 CHECK (min_order_value_inr >= 0),
    max_discount_inr NUMERIC(10,2) CHECK (max_discount_inr IS NULL OR max_discount_inr > 0),
    applicable_merchant_id UUID REFERENCES merchants(id) ON DELETE CASCADE,
    usage_limit INT,
    usage_count INT NOT NULL DEFAULT 0,
    valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    valid_to TIMESTAMPTZ,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT chk_coupon_dates CHECK (valid_to IS NULL OR valid_from <= valid_to)
);

CREATE INDEX IF NOT EXISTS idx_coupons_code ON coupons(code);
CREATE INDEX IF NOT EXISTS idx_coupons_active ON coupons(is_active, valid_from, valid_to);
CREATE INDEX IF NOT EXISTS idx_coupons_merchant ON coupons(applicable_merchant_id);
