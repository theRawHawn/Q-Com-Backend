-- Migration 015: Create Marketplace Settlement Allocations, Seller Payouts, and Rider Payouts

-- 1. Order Settlement Allocations: Authoritative post-fulfillment financial split snapshot
CREATE TABLE IF NOT EXISTS order_settlement_allocations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID UNIQUE NOT NULL REFERENCES orders(id),
    merchant_id UUID NOT NULL REFERENCES merchants(id),
    rider_id UUID REFERENCES riders(id),
    trip_id UUID REFERENCES delivery_trips(id),
    journal_batch_id UUID NOT NULL,
    order_total NUMERIC(10,2) NOT NULL,
    gross_gmv NUMERIC(10,2) NOT NULL,
    seller_goods_taxable NUMERIC(10,2) NOT NULL,
    seller_goods_gst NUMERIC(10,2) NOT NULL,
    platform_commission NUMERIC(10,2) NOT NULL,
    commission_gst NUMERIC(10,2) NOT NULL,
    gst_tcs_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    seller_tds_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    store_delay_penalty NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    net_seller_payable NUMERIC(10,2) NOT NULL,
    customer_delivery_fee NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    customer_handling_fee NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    gross_rider_fare NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    customer_tip NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    rider_tds_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    net_rider_payable NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    platform_subsidy NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    status VARCHAR(30) NOT NULL DEFAULT 'ALLOCATED' CHECK (status IN ('ALLOCATED', 'SETTLED', 'REVERSED')),
    allocated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_order_alloc_order ON order_settlement_allocations(order_id);
CREATE INDEX IF NOT EXISTS idx_order_alloc_merchant ON order_settlement_allocations(merchant_id);
CREATE INDEX IF NOT EXISTS idx_order_alloc_rider ON order_settlement_allocations(rider_id);

-- 2. Seller Payout Batches
CREATE TABLE IF NOT EXISTS seller_payout_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_reference VARCHAR(80) UNIQUE NOT NULL,
    settlement_cycle VARCHAR(40) NOT NULL,
    total_orders INT NOT NULL DEFAULT 0,
    total_gross_gmv NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    total_commission NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    total_commission_gst NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    total_gst_tcs NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    total_seller_tds NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    total_penalties NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    total_net_payable NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    status VARCHAR(30) NOT NULL DEFAULT 'CREATED' CHECK (status IN ('CREATED', 'SCHEDULED', 'PROCESSING', 'COMPLETED', 'FAILED')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Seller Payouts
CREATE TABLE IF NOT EXISTS seller_payouts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payout_reference VARCHAR(80) UNIQUE NOT NULL,
    batch_id UUID REFERENCES seller_payout_batches(id),
    merchant_id UUID NOT NULL REFERENCES merchants(id),
    amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    currency VARCHAR(10) DEFAULT 'INR',
    status VARCHAR(30) NOT NULL DEFAULT 'ELIGIBLE' CHECK (status IN ('ELIGIBLE', 'SCHEDULED', 'PROCESSING', 'PAID', 'FAILED')),
    bank_account_number VARCHAR(40) NOT NULL,
    bank_ifsc VARCHAR(20) NOT NULL,
    bank_account_holder VARCHAR(150),
    bank_name VARCHAR(100),
    utr_number VARCHAR(80),
    provider_payout_id VARCHAR(100),
    journal_batch_id UUID,
    failure_reason TEXT,
    idempotency_key VARCHAR(120),
    processed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_seller_payout_merchant ON seller_payouts(merchant_id);
CREATE INDEX IF NOT EXISTS idx_seller_payout_status ON seller_payouts(status);

-- 4. Rider Payouts
CREATE TABLE IF NOT EXISTS rider_payouts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payout_reference VARCHAR(80) UNIQUE NOT NULL,
    rider_id UUID NOT NULL REFERENCES riders(id),
    amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    currency VARCHAR(10) DEFAULT 'INR',
    payout_method VARCHAR(20) NOT NULL DEFAULT 'UPI' CHECK (payout_method IN ('UPI', 'BANK')),
    destination_vpa VARCHAR(80),
    destination_account VARCHAR(40),
    destination_ifsc VARCHAR(20),
    status VARCHAR(30) NOT NULL DEFAULT 'PAYOUT_PENDING' CHECK (status IN ('PAYABLE', 'PAYOUT_PENDING', 'PROCESSING', 'PAID', 'FAILED', 'REVERSED')),
    utr_number VARCHAR(80),
    provider_payout_id VARCHAR(100),
    journal_batch_id UUID,
    failure_reason TEXT,
    idempotency_key VARCHAR(120),
    processed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rider_payout_rider ON rider_payouts(rider_id);
CREATE INDEX IF NOT EXISTS idx_rider_payout_status ON rider_payouts(status);
