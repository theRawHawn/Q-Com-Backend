-- Migration 012: Additional Tables for Migration Consolidation (Reservations, Payments, Invoices, Routing, Configs)

-- 1. Inventory Reservations
CREATE TABLE IF NOT EXISTS inventory_reservations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL,
    merchant_id UUID NOT NULL REFERENCES merchants(id),
    product_id UUID NOT NULL REFERENCES products(id),
    quantity INT NOT NULL CHECK (quantity > 0),
    status VARCHAR(30) NOT NULL DEFAULT 'RESERVED' CHECK (status IN ('RESERVED', 'COMMITTED', 'RELEASED')),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_inv_res_order ON inventory_reservations(order_id);
CREATE INDEX IF NOT EXISTS idx_inv_res_merchant_prod ON inventory_reservations(merchant_id, product_id);

-- 2. Payment Intents & Receipts
CREATE TABLE IF NOT EXISTS payment_intents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_order_id VARCHAR(80) UNIQUE NOT NULL,
    order_id UUID NOT NULL,
    amount NUMERIC(10,2) NOT NULL CHECK (amount >= 0),
    currency VARCHAR(10) NOT NULL DEFAULT 'INR',
    status VARCHAR(30) NOT NULL DEFAULT 'CREATED' CHECK (status IN ('CREATED', 'CAPTURED', 'FAILED', 'REFUNDED')),
    signature VARCHAR(128) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payment_intents_order ON payment_intents(order_id);

CREATE TABLE IF NOT EXISTS payment_receipts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL,
    transaction_id VARCHAR(100) UNIQUE NOT NULL,
    amount NUMERIC(10,2) NOT NULL CHECK (amount >= 0),
    status VARCHAR(30) NOT NULL DEFAULT 'SUCCESS' CHECK (status IN ('SUCCESS', 'FAILED', 'REFUNDED')),
    signature VARCHAR(128) NOT NULL,
    verified_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payment_receipts_order ON payment_receipts(order_id);

-- 3. Invoices & Line Items
CREATE TABLE IF NOT EXISTS invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_number VARCHAR(60) UNIQUE NOT NULL,
    order_id UUID NOT NULL,
    invoice_type VARCHAR(40) NOT NULL CHECK (invoice_type IN ('SUMMARY', 'SELLER_TAX_INVOICE', 'QCOM_PLATFORM_INVOICE')),
    irn VARCHAR(64) NOT NULL,
    qr_data TEXT NOT NULL,
    seller_gstin VARCHAR(15),
    seller_legal_name VARCHAR(255),
    customer_gstin VARCHAR(15),
    customer_business_name VARCHAR(255),
    taxable_amount NUMERIC(10,2) NOT NULL CHECK (taxable_amount >= 0),
    cgst_amount NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (cgst_amount >= 0),
    sgst_amount NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (sgst_amount >= 0),
    igst_amount NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (igst_amount >= 0),
    total_amount NUMERIC(10,2) NOT NULL CHECK (total_amount >= 0),
    issued_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_invoices_order ON invoices(order_id);

CREATE TABLE IF NOT EXISTS invoice_line_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    item_description VARCHAR(255) NOT NULL,
    hsn_sac_code VARCHAR(20) NOT NULL,
    quantity INT NOT NULL DEFAULT 1,
    unit_price NUMERIC(10,2) NOT NULL,
    taxable_value NUMERIC(10,2) NOT NULL,
    gst_rate_percent NUMERIC(5,2) NOT NULL,
    cgst_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
    sgst_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
    igst_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
    total_line_amount NUMERIC(10,2) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inv_line_items_inv ON invoice_line_items(invoice_id);

-- 4. Entrance Corrections & Route Telemetry
CREATE TABLE IF NOT EXISTS entrance_corrections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    location_key VARCHAR(80) UNIQUE NOT NULL,
    location_type VARCHAR(40) NOT NULL,
    original_latitude NUMERIC(10,7) NOT NULL,
    original_longitude NUMERIC(10,7) NOT NULL,
    accessible_entrance_latitude NUMERIC(10,7) NOT NULL,
    accessible_entrance_longitude NUMERIC(10,7) NOT NULL,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS route_telemetry (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID,
    seller_id UUID,
    rider_id UUID,
    origin_latitude NUMERIC(10,7) NOT NULL,
    origin_longitude NUMERIC(10,7) NOT NULL,
    destination_latitude NUMERIC(10,7) NOT NULL,
    destination_longitude NUMERIC(10,7) NOT NULL,
    planned_distance_m INT NOT NULL,
    actual_distance_m INT,
    planned_duration_sec INT NOT NULL,
    actual_duration_sec INT,
    deviations_count INT DEFAULT 0,
    gps_trace JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_route_telemetry_order ON route_telemetry(order_id);

-- 5. Commercial Configs & Delivery Economics Dynamic Settings
CREATE TABLE IF NOT EXISTS commercial_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key VARCHAR(60) UNIQUE NOT NULL,
    free_delivery_threshold NUMERIC(10,2) NOT NULL DEFAULT 499.00,
    handling_fee NUMERIC(10,2) NOT NULL DEFAULT 10.00,
    base_commission_percent NUMERIC(5,2) NOT NULL DEFAULT 10.00,
    version VARCHAR(40) NOT NULL DEFAULT 'v1.1.0-qcom-admin-2026',
    is_active BOOLEAN DEFAULT TRUE,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS delivery_economics_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key VARCHAR(60) UNIQUE NOT NULL,
    rider_base_payout NUMERIC(10,2) NOT NULL DEFAULT 45.00,
    rider_per_km_rate NUMERIC(10,2) NOT NULL DEFAULT 8.00,
    max_delivery_subsidy NUMERIC(10,2) NOT NULL DEFAULT 35.00,
    pg_cost_percent NUMERIC(5,2) NOT NULL DEFAULT 1.80,
    packaging_cost_inr NUMERIC(10,2) NOT NULL DEFAULT 8.00,
    ops_cost_inr NUMERIC(10,2) NOT NULL DEFAULT 5.00,
    is_active BOOLEAN DEFAULT TRUE,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed default config rows if not exist
INSERT INTO commercial_configs (key, free_delivery_threshold, handling_fee, base_commission_percent, version)
VALUES ('default', 499.00, 10.00, 10.00, 'v1.1.0-qcom-admin-2026')
ON CONFLICT (key) DO NOTHING;

INSERT INTO delivery_economics_configs (key, rider_base_payout, rider_per_km_rate, max_delivery_subsidy, pg_cost_percent, packaging_cost_inr, ops_cost_inr)
VALUES ('default', 45.00, 8.00, 35.00, 1.80, 8.00, 5.00)
ON CONFLICT (key) DO NOTHING;
