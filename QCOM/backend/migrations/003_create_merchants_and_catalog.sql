-- Migration 003: Create Merchants, Stores, Staff, Catalog Products, and Store Inventory

CREATE TABLE IF NOT EXISTS merchants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_code VARCHAR(40) UNIQUE NOT NULL,
    name VARCHAR(200) NOT NULL,
    business_name VARCHAR(255) NOT NULL,
    constitution_type VARCHAR(40) NOT NULL DEFAULT 'INDIVIDUAL' CHECK (
        constitution_type IN ('INDIVIDUAL', 'HUF', 'COMPANY', 'FIRM_LLP')
    ),
    pan_number VARCHAR(10) NOT NULL,
    pan_status VARCHAR(40) NOT NULL DEFAULT 'VALID_PAN' CHECK (
        pan_status IN ('VALID_PAN', 'INVALID_OR_MISSING_PAN', 'INOPERATIVE_PAN')
    ),
    locality VARCHAR(120) NOT NULL,
    address TEXT NOT NULL,
    latitude NUMERIC(10,7) NOT NULL,
    longitude NUMERIC(10,7) NOT NULL,
    accessible_entrance_latitude NUMERIC(10,7),
    accessible_entrance_longitude NUMERIC(10,7),
    pickup_notes TEXT,
    phone VARCHAR(20) NOT NULL,
    email VARCHAR(180),
    gstin VARCHAR(15) NOT NULL,
    state_code VARCHAR(10) NOT NULL DEFAULT '29',
    is_gst_registered BOOLEAN DEFAULT TRUE,
    commission_rate_percent NUMERIC(5,2) DEFAULT 15.00,
    fy_gross_sales_inr NUMERIC(14,2) DEFAULT 0.00,
    base_prep_mins INT DEFAULT 8,
    service_radius_meters INT DEFAULT 7000,
    is_online BOOLEAN DEFAULT TRUE,
    is_paused BOOLEAN DEFAULT FALSE,
    pause_reason VARCHAR(255),
    status VARCHAR(30) DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACTIVE', 'SUSPENDED', 'REJECTED')),
    bank_account_number VARCHAR(40),
    bank_ifsc VARCHAR(20),
    bank_name VARCHAR(100),
    bank_account_holder VARCHAR(150),
    bank_verified BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_merchants_pan ON merchants(pan_number);

CREATE TABLE IF NOT EXISTS merchant_stores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    store_code VARCHAR(40) UNIQUE NOT NULL,
    store_name VARCHAR(200) NOT NULL,
    is_primary BOOLEAN DEFAULT TRUE,
    operating_hours_start TIME DEFAULT '08:00:00',
    operating_hours_end TIME DEFAULT '20:00:00',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS store_staff (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id),
    name VARCHAR(120) NOT NULL,
    phone VARCHAR(20) NOT NULL,
    role VARCHAR(30) NOT NULL CHECK (role IN ('STORE_OWNER', 'STORE_MANAGER', 'STAFF_PACKER')),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_store_staff_phone ON store_staff(phone);

CREATE TABLE IF NOT EXISTS products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sku VARCHAR(60) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    category VARCHAR(60) NOT NULL,
    subcategory VARCHAR(80) NOT NULL,
    hsn_code VARCHAR(20) NOT NULL,
    gst_rate_percent NUMERIC(5,2) NOT NULL DEFAULT 18.00,
    itc_eligible BOOLEAN DEFAULT TRUE,
    unit_weight_kg NUMERIC(6,3) NOT NULL DEFAULT 0.250,
    description TEXT,
    specifications JSONB DEFAULT '{}'::jsonb,
    image_url TEXT,
    badge VARCHAR(50),
    tags TEXT[] DEFAULT ARRAY[]::TEXT[],
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
CREATE INDEX IF NOT EXISTS idx_products_hsn ON products(hsn_code);

CREATE TABLE IF NOT EXISTS store_inventory (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    selling_price NUMERIC(10,2) NOT NULL CHECK (selling_price >= 0),
    original_mrp NUMERIC(10,2) CHECK (original_mrp IS NULL OR original_mrp >= selling_price),
    stock_count INT NOT NULL DEFAULT 0 CHECK (stock_count >= 0),
    reserved_count INT NOT NULL DEFAULT 0 CHECK (reserved_count >= 0),
    low_stock_threshold INT NOT NULL DEFAULT 5,
    bin_location VARCHAR(80) NOT NULL,
    is_available BOOLEAN DEFAULT TRUE,
    version INT NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_merchant_product UNIQUE(merchant_id, product_id),
    CONSTRAINT chk_reserved_le_stock CHECK (reserved_count <= stock_count)
);
CREATE INDEX IF NOT EXISTS idx_inventory_lookup ON store_inventory(merchant_id, product_id);
