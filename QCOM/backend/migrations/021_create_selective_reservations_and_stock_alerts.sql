-- Migration 021: Selective Reservations and Stock Alerts
-- Adds threshold configuration and alert episode tracking

-- 1. Merchant-level default thresholds
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS default_low_stock_threshold INT DEFAULT 5;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS default_scarce_stock_threshold INT DEFAULT 3;

-- 2. Store inventory scarce threshold and alert state tracking
ALTER TABLE store_inventory ADD COLUMN IF NOT EXISTS scarce_stock_threshold INT DEFAULT 3;
ALTER TABLE store_inventory ADD COLUMN IF NOT EXISTS low_stock_alert_triggered BOOLEAN DEFAULT FALSE;
ALTER TABLE store_inventory ADD COLUMN IF NOT EXISTS out_of_stock_alert_triggered BOOLEAN DEFAULT FALSE;
ALTER TABLE store_inventory ADD COLUMN IF NOT EXISTS last_alert_at TIMESTAMPTZ;

-- 3. Dedicated seller stock alerts table for in-app alert log and audit
CREATE TABLE IF NOT EXISTS seller_stock_alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    alert_type VARCHAR(40) NOT NULL CHECK (alert_type IN ('LOW_STOCK', 'OUT_OF_STOCK')),
    available_stock INT NOT NULL CHECK (available_stock >= 0),
    physical_stock INT NOT NULL CHECK (physical_stock >= 0),
    reserved_stock INT NOT NULL CHECK (reserved_stock >= 0),
    threshold_value INT NOT NULL CHECK (threshold_value >= 0),
    dedupe_key VARCHAR(160) UNIQUE NOT NULL,
    metadata JSONB DEFAULT '{}'::jsonb,
    is_read BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_seller_stock_alerts_merchant ON seller_stock_alerts(merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_seller_stock_alerts_product ON seller_stock_alerts(product_id);
