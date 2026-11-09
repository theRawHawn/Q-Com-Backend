# QCOM Database Architecture & Entity Specifications

**Document Version:** 3.0.0 (Phase 0.5 Final Correction Pass — September 2026)  
**Target DBMS:** Supabase PostgreSQL 16+ with PostGIS Extension  
**Authority Boundary:** Supabase PostgreSQL is the Sole Authoritative Source of Truth; Redis is Ephemeral Accelerator  

---

## 1. Concurrency, Durability & Retention Invariants

1. **PostgreSQL as Primary Inventory Authority**:
   - Inventory decrements execute directly against PostgreSQL via atomic Compare-and-Swap (CAS):
     ```sql
     UPDATE store_inventory 
     SET stock_count = stock_count - $qty,
         reserved_count = reserved_count + $qty,
         version = version + 1,
         updated_at = NOW()
     WHERE product_id = $productId 
       AND merchant_id = $merchantId 
       AND stock_count >= $qty;
     ```
   - If `rows_affected == 0`, the transaction aborts and returns `409 OUT_OF_STOCK`.
   - Redis distributed locks serve merely as a fast pre-check to reduce PostgreSQL contention during peak flash drops, but **PostgreSQL is the ultimate gatekeeper**.
2. **Order Creation Resiliency (Zero Uncommitted Orders in Redis)**:
   - If Supabase PostgreSQL is unreachable or connection pool is exhausted, the backend **DOES NOT queue uncommitted orders into Redis/BullMQ**.
   - Instead, the API returns a controlled `503 Service Unavailable` with a `Retry-After: 3` header. The customer app automatically retries with the same `Idempotency-Key`, guaranteeing zero ghost orders or unreserved stock.
3. **Audit Log Retention Policy (No Deletions)**:
   - Critical audit logs, financial ledger entries, tax records, settlements, and payment webhooks are **NEVER deleted**.
   - **Tiered Storage Model**:
     - *0–90 Days*: Active hot tables in Supabase PostgreSQL with high-performance B-tree indexes.
     - *>90 Days*: Partitioned cold-storage archive tables (or compressed parquet files in S3/Cloud Storage) retained in full compliance with Indian statutory books-of-account requirements (minimum 8 years under Companies Act and Income-tax Act).

---

## 2. Core Relational Tables & DDL Definitions

### 2.1 Versioned Statutory Withholding & Tax Rules

```sql
CREATE TABLE statutory_withholding_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_code VARCHAR(80) NOT NULL,
    governing_law VARCHAR(60) NOT NULL CHECK (
        governing_law IN ('INCOME_TAX_ACT_2025', 'INCOME_TAX_ACT_1961', 'CGST_ACT_2017')
    ),
    statutory_provision VARCHAR(80) NOT NULL,  -- e.g. 'SECTION_393', 'SECTION_194O', 'SECTION_194C'
    table_item VARCHAR(40),                    -- e.g. 'TABLE_8_V' for e-commerce sales in 2025 Act
    withholding_type VARCHAR(40) NOT NULL CHECK (
        withholding_type IN ('ECO_SALE_OF_GOODS', 'LOGISTICS_SERVICES', 'GST_TCS_SEC52')
    ),
    effective_from DATE NOT NULL,
    effective_to DATE,
    payee_type VARCHAR(40) NOT NULL CHECK (
        payee_type IN ('ALL', 'INDIVIDUAL', 'HUF', 'COMPANY', 'FIRM_LLP', 'TRANSPORTER_DECLARATION')
    ),
    pan_status VARCHAR(40) NOT NULL CHECK (
        pan_status IN ('VALID_PAN', 'INVALID_OR_MISSING_PAN', 'INOPERATIVE_PAN')
    ),
    aadhaar_linked_status VARCHAR(40) DEFAULT 'NOT_APPLICABLE' CHECK (
        aadhaar_linked_status IN ('NOT_APPLICABLE', 'LINKED', 'NOT_LINKED')
    ),
    threshold_single_txn_inr NUMERIC(12,2) DEFAULT 0.00,
    threshold_annual_aggregate_inr NUMERIC(12,2) DEFAULT 0.00,
    applicable_rate_percent NUMERIC(5,3) NOT NULL,
    calculation_base VARCHAR(60) NOT NULL CHECK (
        calculation_base IN ('GROSS_GMV_INCLUDING_TAX', 'NET_TAXABLE_SUPPLIES', 'RIDER_LOGISTICS_FARE')
    ),
    rounding_rule VARCHAR(40) NOT NULL DEFAULT 'ROUND_HALF_UP_2_DECIMALS',
    statutory_reporting_form VARCHAR(40) NOT NULL CHECK (
        statutory_reporting_form IN ('FORM_26Q', 'FORM_27EQ', 'GSTR-8')
    ),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_withholding_rule UNIQUE(rule_code, effective_from, payee_type, pan_status)
);

CREATE TABLE gst_tcs_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_code VARCHAR(60) NOT NULL,
    statutory_provision VARCHAR(80) NOT NULL DEFAULT 'CGST_ACT_SECTION_52',
    effective_from DATE NOT NULL,
    effective_to DATE,
    central_rate_percent NUMERIC(5,3) NOT NULL,
    state_rate_percent NUMERIC(5,3) NOT NULL,
    integrated_rate_percent NUMERIC(5,3) NOT NULL,
    calculation_basis VARCHAR(60) NOT NULL DEFAULT 'NET_TAXABLE_SUPPLIES',
    reporting_form VARCHAR(40) NOT NULL DEFAULT 'GSTR-8',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_gst_tcs_effective UNIQUE(rule_code, effective_from)
);
```

### 2.2 Merchants & Tax Profiles (`merchants`)

```sql
CREATE TABLE merchants (
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
    location GEOMETRY(Point, 4326) NOT NULL,
    accessible_entrance_location GEOMETRY(Point, 4326),
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
CREATE INDEX idx_merchants_spatial ON merchants USING GIST(location);
CREATE INDEX idx_merchants_pan ON merchants(pan_number);
```

### 2.3 Store Inventory & Physical Bins (`store_inventory`)

```sql
CREATE TABLE store_inventory (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    selling_price NUMERIC(10,2) NOT NULL,
    original_mrp NUMERIC(10,2),
    stock_count INT NOT NULL DEFAULT 0 CHECK (stock_count >= 0),
    reserved_count INT NOT NULL DEFAULT 0 CHECK (reserved_count >= 0),
    low_stock_threshold INT NOT NULL DEFAULT 5,
    bin_location VARCHAR(80) NOT NULL,
    is_available BOOLEAN DEFAULT TRUE,
    version INT NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_merchant_product UNIQUE(merchant_id, product_id)
);
CREATE INDEX idx_inventory_lookup ON store_inventory(merchant_id, product_id);
```

### 2.4 Orders & Dynamic Withholding Snapshots (`orders`)

```sql
CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_number VARCHAR(40) UNIQUE NOT NULL,
    user_id UUID NOT NULL REFERENCES users(id),
    merchant_id UUID NOT NULL REFERENCES merchants(id),
    status VARCHAR(30) NOT NULL DEFAULT 'placed' CHECK (
        status IN ('placed', 'picking', 'packed', 'out_for_delivery', 'arriving', 'delivered', 'cancelled')
    ),
    items_subtotal NUMERIC(10,2) NOT NULL,
    delivery_fee NUMERIC(10,2) NOT NULL,
    handling_fee NUMERIC(10,2) NOT NULL DEFAULT 0,
    urgency_fee NUMERIC(10,2) NOT NULL DEFAULT 0,
    discount_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
    taxable_amount NUMERIC(10,2) NOT NULL,
    cgst_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
    sgst_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
    igst_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
    total_amount NUMERIC(10,2) NOT NULL,
    
    -- Generic Dynamic Withholding Attributes (Income-tax Act 2025 / 1961)
    withholding_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    withholding_rule_id UUID REFERENCES statutory_withholding_rules(id),
    withholding_law VARCHAR(60),
    withholding_provision VARCHAR(80),
    withholding_table_item VARCHAR(40),
    tax_year VARCHAR(20) NOT NULL DEFAULT '2026-27',
    
    -- Section 52 GST-TCS Attributes
    gst_tcs_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    gst_tcs_rule_id UUID REFERENCES gst_tcs_rules(id),
    
    payment_method VARCHAR(40) NOT NULL CHECK (
        payment_method IN ('Instant UPI', 'Corporate Card', 'Pay on Delivery', 'Trade Credit (Net 30)')
    ),
    payment_status VARCHAR(30) NOT NULL DEFAULT 'PENDING' CHECK (
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
CREATE INDEX idx_orders_user ON orders(user_id);
CREATE INDEX idx_orders_merchant ON orders(merchant_id);
CREATE INDEX idx_orders_status ON orders(status);
```

### 2.5 Delivery Fleet & Tip Characterization (`riders`, `delivery_trips`)

```sql
CREATE TABLE riders (
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
    rating NUMERIC(3,2) DEFAULT 5.00,
    tier VARCHAR(20) DEFAULT 'Bronze' CHECK (tier IN ('Bronze', 'Silver', 'Gold', 'Platinum')),
    status VARCHAR(30) DEFAULT 'OFFLINE' CHECK (
        status IN ('OFFLINE', 'IDLE_AT_HUB', 'PICKING_UP', 'IN_TRANSIT', 'ARRIVED_AT_DROP', 'SUSPENDED')
    ),
    current_location GEOMETRY(Point, 4326),
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
CREATE INDEX idx_riders_phone ON riders(phone);
CREATE INDEX idx_riders_spatial ON riders USING GIST(current_location);

CREATE TABLE delivery_trips (
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
    cod_due_amount NUMERIC(10,2) DEFAULT 0.00,
    cod_collected_amount NUMERIC(10,2) DEFAULT 0.00,
    cod_reconciled BOOLEAN DEFAULT FALSE,
    wait_time_minutes INT DEFAULT 0,
    wait_time_compensation NUMERIC(10,2) DEFAULT 0.00,
    base_fare NUMERIC(10,2) NOT NULL DEFAULT 35.00,
    distance_fare NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    surge_fare NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    
    -- Tip Characterization Separation
    tip_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    platform_tip_commission NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    rider_tip_payable NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    
    -- Logistics Withholding Attributes (Income-tax Act 2025 / 1961)
    rider_withholding_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    rider_withholding_rule_id UUID REFERENCES statutory_withholding_rules(id),
    rider_withholding_law VARCHAR(60),
    rider_withholding_provision VARCHAR(80),
    rider_withholding_table_item VARCHAR(40),
    
    total_rider_payout NUMERIC(10,2) NOT NULL,
    route_polyline JSONB
);
CREATE INDEX idx_delivery_trips_order ON delivery_trips(order_id);
CREATE INDEX idx_delivery_trips_rider ON delivery_trips(rider_id);
```

### 2.6 Double-Entry General Ledger Tables (`general_ledger_accounts`, `general_ledger_entries`)

```sql
CREATE TABLE general_ledger_accounts (
    account_code VARCHAR(20) PRIMARY KEY,
    account_name VARCHAR(120) NOT NULL,
    category VARCHAR(30) NOT NULL CHECK (category IN ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE')),
    normal_balance VARCHAR(10) NOT NULL CHECK (normal_balance IN ('DEBIT', 'CREDIT')),
    description TEXT,
    is_active BOOLEAN DEFAULT TRUE
);

CREATE TABLE general_ledger_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    journal_batch_id UUID NOT NULL,
    transaction_reference VARCHAR(120) NOT NULL,
    transaction_type VARCHAR(40) NOT NULL CHECK (
        transaction_type IN ('CUSTOMER_PAYMENT', 'ORDER_FULFILLMENT', 'MERCHANT_SETTLEMENT', 'RIDER_PAYOUT', 'COD_COLLECTION', 'REFUND', 'ADJUSTMENT')
    ),
    account_code VARCHAR(20) NOT NULL REFERENCES general_ledger_accounts(account_code),
    entry_side VARCHAR(10) NOT NULL CHECK (entry_side IN ('DEBIT', 'CREDIT')),
    amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    currency VARCHAR(10) DEFAULT 'INR',
    order_id UUID REFERENCES orders(id),
    merchant_id UUID REFERENCES merchants(id),
    rider_id UUID REFERENCES riders(id),
    narration TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_gl_batch ON general_ledger_entries(journal_batch_id);
CREATE INDEX idx_gl_account ON general_ledger_entries(account_code);
CREATE INDEX idx_gl_ref ON general_ledger_entries(transaction_reference);
```
