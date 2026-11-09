-- Migration 004: Create Orders, Order Line Items, Delivery Riders, and Delivery Trips

CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_number VARCHAR(40) UNIQUE NOT NULL,
    user_id UUID NOT NULL REFERENCES users(id),
    merchant_id UUID NOT NULL REFERENCES merchants(id),
    status VARCHAR(30) NOT NULL DEFAULT 'placed' CHECK (
        status IN ('placed', 'picking', 'packed', 'out_for_delivery', 'arriving', 'delivered', 'cancelled')
    ),
    items_subtotal NUMERIC(10,2) NOT NULL CHECK (items_subtotal >= 0),
    delivery_fee NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (delivery_fee >= 0),
    handling_fee NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (handling_fee >= 0),
    urgency_fee NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (urgency_fee >= 0),
    discount_amount NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
    taxable_amount NUMERIC(10,2) NOT NULL CHECK (taxable_amount >= 0),
    cgst_amount NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (cgst_amount >= 0),
    sgst_amount NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (sgst_amount >= 0),
    igst_amount NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (igst_amount >= 0),
    total_amount NUMERIC(10,2) NOT NULL CHECK (total_amount >= 0),
    
    -- Generic Dynamic Withholding Attributes (Income-tax Act 2025 / 1961)
    withholding_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00 CHECK (withholding_amount >= 0),
    withholding_rule_id UUID,
    withholding_law VARCHAR(60),
    withholding_provision VARCHAR(80),
    withholding_table_item VARCHAR(40),
    tax_year VARCHAR(20) NOT NULL DEFAULT '2026-27',
    
    -- Section 52 GST-TCS Attributes
    gst_tcs_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00 CHECK (gst_tcs_amount >= 0),
    gst_tcs_rule_id UUID,
    
    payment_method VARCHAR(40) NOT NULL CHECK (
        payment_method IN ('Instant UPI', 'Corporate Card', 'Pay on Delivery', 'Trade Credit (Net 30)')
    ),
    payment_status VARCHAR(30) NOT NULL DEFAULT 'PENDING' CONSTRAINT orders_payment_status_check CHECK (
        payment_status IN ('PENDING', 'PAID', 'FAILED', 'REFUNDED')
    ),
    delivery_otp VARCHAR(6) NOT NULL,
    handover_token VARCHAR(20) NOT NULL,
    jobsite_address JSONB NOT NULL,
    customer_gstin VARCHAR(15),
    customer_business_name VARCHAR(255),
    place_of_supply_state_code VARCHAR(10) NOT NULL DEFAULT '29',
    pricing_snapshot JSONB NOT NULL,
    cancellation_reason TEXT,
    placed_at TIMESTAMPTZ DEFAULT NOW(),
    estimated_delivery_at TIMESTAMPTZ NOT NULL,
    delivered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_merchant ON orders(merchant_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

CREATE TABLE IF NOT EXISTS order_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id),
    product_name VARCHAR(255) NOT NULL,
    unit_price NUMERIC(10,2) NOT NULL CHECK (unit_price >= 0),
    quantity INT NOT NULL CHECK (quantity > 0),
    total_price NUMERIC(10,2) NOT NULL CHECK (total_price >= 0),
    hsn_code VARCHAR(20) NOT NULL,
    taxable_amount NUMERIC(10,2) NOT NULL CHECK (taxable_amount >= 0),
    gst_rate_percent NUMERIC(5,2) NOT NULL CHECK (gst_rate_percent >= 0),
    cgst_amount NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (cgst_amount >= 0),
    sgst_amount NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (sgst_amount >= 0),
    igst_amount NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (igst_amount >= 0),
    bin_location VARCHAR(80)
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

CREATE TABLE IF NOT EXISTS riders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rider_code VARCHAR(30) UNIQUE NOT NULL,
    name VARCHAR(120) NOT NULL,
    phone VARCHAR(20) UNIQUE NOT NULL,
    pan_number VARCHAR(10),
    pan_status VARCHAR(40) DEFAULT 'VALID_PAN' CHECK (
        pan_status IN ('VALID_PAN', 'INVALID_OR_MISSING_PAN', 'INOPERATIVE_PAN')
    ),
    vehicle_type VARCHAR(30) NOT NULL CHECK (vehicle_type IN ('bicycle', 'ev_scooter', 'motorcycle', 'cargo_3w')),
    vehicle_plate VARCHAR(30),
    payload_capacity_kg NUMERIC(6,2) NOT NULL DEFAULT 15.00,
    rating NUMERIC(3,2) DEFAULT 5.00 CHECK (rating >= 0 AND rating <= 5),
    tier VARCHAR(20) DEFAULT 'Bronze' CHECK (tier IN ('Bronze', 'Silver', 'Gold', 'Platinum')),
    status VARCHAR(30) DEFAULT 'OFFLINE' CHECK (
        status IN ('OFFLINE', 'IDLE_AT_HUB', 'PICKING_UP', 'IN_TRANSIT', 'ARRIVED_AT_DROP', 'SUSPENDED')
    ),
    latitude NUMERIC(10,7),
    longitude NUMERIC(10,7),
    floating_cash_balance NUMERIC(10,2) DEFAULT 0.00 CHECK (floating_cash_balance >= 0),
    floating_cash_limit NUMERIC(10,2) DEFAULT 2500.00,
    wallet_balance NUMERIC(10,2) DEFAULT 0.00,
    fy_gross_payout_inr NUMERIC(12,2) DEFAULT 0.00,
    is_payout_held BOOLEAN DEFAULT FALSE,
    payout_hold_reason TEXT,
    upi_vpa VARCHAR(80),
    bank_account_number VARCHAR(40),
    bank_ifsc VARCHAR(20),
    kyc_status VARCHAR(20) DEFAULT 'PENDING' CHECK (kyc_status IN ('PENDING', 'GREEN', 'AMBER', 'RED')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_riders_phone ON riders(phone);

CREATE TABLE IF NOT EXISTS delivery_trips (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID UNIQUE NOT NULL REFERENCES orders(id),
    rider_id UUID REFERENCES riders(id),
    status VARCHAR(30) NOT NULL DEFAULT 'BROADCASTING' CHECK (
        status IN ('BROADCASTING', 'ACCEPTED', 'ARRIVED_AT_PICKUP', 'PICKED_UP', 'ARRIVED_AT_DROP', 'DELIVERED', 'RETURNED_TO_HUB', 'CANCELLED')
    ),
    broadcasted_at TIMESTAMPTZ DEFAULT NOW(),
    accepted_at TIMESTAMPTZ,
    picked_up_at TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,
    otp_verified BOOLEAN DEFAULT FALSE,
    contactless_photo_url TEXT,
    photo_watermark_metadata JSONB,
    cod_due_amount NUMERIC(10,2) DEFAULT 0.00 CHECK (cod_due_amount >= 0),
    cod_collected_amount NUMERIC(10,2) DEFAULT 0.00 CHECK (cod_collected_amount >= 0),
    cod_reconciled BOOLEAN DEFAULT FALSE,
    wait_time_minutes INT DEFAULT 0 CHECK (wait_time_minutes >= 0),
    wait_time_compensation NUMERIC(10,2) DEFAULT 0.00 CHECK (wait_time_compensation >= 0),
    base_fare NUMERIC(10,2) NOT NULL DEFAULT 35.00 CHECK (base_fare >= 0),
    distance_fare NUMERIC(10,2) NOT NULL DEFAULT 0.00 CHECK (distance_fare >= 0),
    surge_fare NUMERIC(10,2) NOT NULL DEFAULT 0.00 CHECK (surge_fare >= 0),
    
    -- Tip Characterization Separation
    tip_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00 CHECK (tip_amount >= 0),
    platform_tip_commission NUMERIC(10,2) NOT NULL DEFAULT 0.00 CHECK (platform_tip_commission >= 0),
    rider_tip_payable NUMERIC(10,2) NOT NULL DEFAULT 0.00 CHECK (rider_tip_payable >= 0),
    
    -- Logistics Withholding Attributes (Income-tax Act 2025 / 1961)
    rider_withholding_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00 CHECK (rider_withholding_amount >= 0),
    rider_withholding_rule_id UUID,
    rider_withholding_law VARCHAR(60),
    rider_withholding_provision VARCHAR(80),
    rider_withholding_table_item VARCHAR(40),
    
    total_rider_payout NUMERIC(10,2) NOT NULL CHECK (total_rider_payout >= 0),
    route_polyline JSONB
);
CREATE INDEX IF NOT EXISTS idx_delivery_trips_order ON delivery_trips(order_id);
CREATE INDEX IF NOT EXISTS idx_delivery_trips_rider ON delivery_trips(rider_id);
