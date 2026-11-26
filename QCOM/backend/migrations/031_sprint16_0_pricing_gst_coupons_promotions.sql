-- Migration 031: Sprint 16.0 — Pricing, Indian GST Classification, Coupons, Promotions, Carts & Credit Notes
-- Forward-only schema extensions compatible with both PostgreSQL 16 and pg-mem.

-- ============================================================================
-- 1. Statutory Indian States & Union Territories Master Reference (GST Codes)
-- ============================================================================
CREATE TABLE IF NOT EXISTS indian_states (
    code VARCHAR(10) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    is_union_territory BOOLEAN NOT NULL DEFAULT FALSE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO indian_states (code, name, is_union_territory, is_active) VALUES
('01', 'Jammu and Kashmir', TRUE, TRUE),
('02', 'Himachal Pradesh', FALSE, TRUE),
('03', 'Punjab', FALSE, TRUE),
('04', 'Chandigarh', TRUE, TRUE),
('05', 'Uttarakhand', FALSE, TRUE),
('06', 'Haryana', FALSE, TRUE),
('07', 'Delhi', TRUE, TRUE),
('08', 'Rajasthan', FALSE, TRUE),
('09', 'Uttar Pradesh', FALSE, TRUE),
('10', 'Bihar', FALSE, TRUE),
('11', 'Sikkim', FALSE, TRUE),
('12', 'Arunachal Pradesh', FALSE, TRUE),
('13', 'Nagaland', FALSE, TRUE),
('14', 'Manipur', FALSE, TRUE),
('15', 'Mizoram', FALSE, TRUE),
('16', 'Tripura', FALSE, TRUE),
('17', 'Meghalaya', FALSE, TRUE),
('18', 'Assam', FALSE, TRUE),
('19', 'West Bengal', FALSE, TRUE),
('20', 'Jharkhand', FALSE, TRUE),
('21', 'Odisha', FALSE, TRUE),
('22', 'Chhattisgarh', FALSE, TRUE),
('23', 'Madhya Pradesh', FALSE, TRUE),
('24', 'Gujarat', FALSE, TRUE),
('26', 'Dadra and Nagar Haveli and Daman and Diu', TRUE, TRUE),
('27', 'Maharashtra', FALSE, TRUE),
('29', 'Karnataka', FALSE, TRUE),
('30', 'Goa', FALSE, TRUE),
('31', 'Lakshadweep', TRUE, TRUE),
('32', 'Kerala', FALSE, TRUE),
('33', 'Tamil Nadu', FALSE, TRUE),
('34', 'Puducherry', TRUE, TRUE),
('35', 'Andaman and Nicobar Islands', TRUE, TRUE),
('36', 'Telangana', FALSE, TRUE),
('37', 'Andhra Pradesh', FALSE, TRUE),
('38', 'Ladakh', TRUE, TRUE),
('97', 'Other Territory', TRUE, TRUE)
ON CONFLICT (code) DO NOTHING;

-- ============================================================================
-- 2. Chart of Accounts: Platform Promotional & Coupon Subsidy Expense (5040)
-- ============================================================================
INSERT INTO general_ledger_accounts (account_code, account_name, category, normal_balance, description)
SELECT
    '5040',
    'Platform Promotional & Coupon Subsidy Expense',
    'EXPENSE',
    'DEBIT',
    'Platform-funded coupon and promotion discount subsidy granted to customers'
WHERE EXISTS (SELECT 1 FROM general_ledger_accounts WHERE account_code = '4010')
ON CONFLICT (account_code) DO NOTHING;

-- ============================================================================
-- 3. Product & Seller Tax Classification Extensions (Cess, Inclusivity, Category)
-- ============================================================================
ALTER TABLE products
    ADD COLUMN IF NOT EXISTS tax_category VARCHAR(20) NOT NULL DEFAULT 'TAXABLE'
        CHECK (tax_category IN ('TAXABLE', 'EXEMPT', 'NIL_RATED', 'ZERO_RATED'));
ALTER TABLE products
    ADD COLUMN IF NOT EXISTS cess_rate_percent NUMERIC(5,2) NOT NULL DEFAULT 0.00
        CHECK (cess_rate_percent >= 0 AND cess_rate_percent <= 100);
ALTER TABLE products
    ADD COLUMN IF NOT EXISTS tax_inclusive BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE products
    ADD COLUMN IF NOT EXISTS is_tax_classification_verified BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE seller_product_tax
    ADD COLUMN IF NOT EXISTS tax_category VARCHAR(20) NOT NULL DEFAULT 'TAXABLE'
        CHECK (tax_category IN ('TAXABLE', 'EXEMPT', 'NIL_RATED', 'ZERO_RATED'));
ALTER TABLE seller_product_tax
    ADD COLUMN IF NOT EXISTS cess_rate_percent NUMERIC(5,2) NOT NULL DEFAULT 0.00
        CHECK (cess_rate_percent >= 0 AND cess_rate_percent <= 100);
ALTER TABLE seller_product_tax
    ADD COLUMN IF NOT EXISTS tax_inclusive BOOLEAN NOT NULL DEFAULT FALSE;

-- ============================================================================
-- 4. Saved Addresses State Code Extension
-- ============================================================================
ALTER TABLE saved_addresses
    ADD COLUMN IF NOT EXISTS state_code VARCHAR(10);

-- ============================================================================
-- 5. Coupons Extensions & Concurrency-Safe Coupon Redemptions Ledger
-- ============================================================================
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS title VARCHAR(150);
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS per_user_limit INT CHECK (per_user_limit IS NULL OR per_user_limit > 0);
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS first_order_only BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS applicable_categories JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS applicable_product_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS is_stackable BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS funding_source VARCHAR(20) NOT NULL DEFAULT 'SELLER'
    CHECK (funding_source IN ('SELLER', 'PLATFORM', 'SHARED'));
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS seller_share_percent NUMERIC(5,2) NOT NULL DEFAULT 100.00
    CHECK (seller_share_percent >= 0 AND seller_share_percent <= 100);

CREATE TABLE IF NOT EXISTS coupon_redemptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    coupon_id UUID NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    merchant_id UUID NOT NULL REFERENCES merchants(id),
    coupon_code VARCHAR(40) NOT NULL,
    discount_amount NUMERIC(10,2) NOT NULL CHECK (discount_amount >= 0),
    seller_share_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00 CHECK (seller_share_amount >= 0),
    platform_share_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00 CHECK (platform_share_amount >= 0),
    status VARCHAR(20) NOT NULL DEFAULT 'RESERVED'
        CHECK (status IN ('RESERVED', 'REDEEMED', 'RELEASED', 'REVERSED')),
    reserved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    redeemed_at TIMESTAMPTZ,
    released_at TIMESTAMPTZ,
    reversed_at TIMESTAMPTZ,
    reversed_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00 CHECK (reversed_amount >= 0),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_coupon_redemption_order UNIQUE (coupon_id, order_id)
);

CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_user ON coupon_redemptions(coupon_id, user_id, status);
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_order ON coupon_redemptions(order_id);

-- ============================================================================
-- 6. Promotions Engine & Promotion Applications Ledger
-- ============================================================================
CREATE TABLE IF NOT EXISTS promotions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(50) UNIQUE NOT NULL,
    title VARCHAR(150) NOT NULL,
    description TEXT,
    promotion_type VARCHAR(30) NOT NULL
        CHECK (promotion_type IN ('PERCENTAGE', 'FLAT_AMOUNT', 'CART_SLAB', 'CATEGORY_DISCOUNT', 'BOGO', 'FREE_DELIVERY')),
    discount_value NUMERIC(10,2) NOT NULL DEFAULT 0.00 CHECK (discount_value >= 0),
    max_discount_inr NUMERIC(10,2) CHECK (max_discount_inr IS NULL OR max_discount_inr > 0),
    min_order_value_inr NUMERIC(10,2) NOT NULL DEFAULT 0.00 CHECK (min_order_value_inr >= 0),
    min_quantity INT NOT NULL DEFAULT 1 CHECK (min_quantity >= 1),
    max_quantity INT CHECK (max_quantity IS NULL OR max_quantity >= 1),
    buy_quantity INT CHECK (buy_quantity IS NULL OR buy_quantity >= 1),
    get_quantity INT CHECK (get_quantity IS NULL OR get_quantity >= 1),
    applicable_merchant_id UUID REFERENCES merchants(id) ON DELETE CASCADE,
    applicable_categories JSONB NOT NULL DEFAULT '[]'::jsonb,
    applicable_product_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    slab_rules JSONB NOT NULL DEFAULT '[]'::jsonb,
    first_order_only BOOLEAN NOT NULL DEFAULT FALSE,
    priority INT NOT NULL DEFAULT 100,
    conflict_group VARCHAR(60),
    is_stackable BOOLEAN NOT NULL DEFAULT FALSE,
    stackable_with_coupons BOOLEAN NOT NULL DEFAULT TRUE,
    funding_source VARCHAR(20) NOT NULL DEFAULT 'PLATFORM'
        CHECK (funding_source IN ('SELLER', 'PLATFORM', 'SHARED')),
    seller_share_percent NUMERIC(5,2) NOT NULL DEFAULT 0.00
        CHECK (seller_share_percent >= 0 AND seller_share_percent <= 100),
    usage_limit INT CHECK (usage_limit IS NULL OR usage_limit > 0),
    usage_count INT NOT NULL DEFAULT 0 CHECK (usage_count >= 0),
    per_user_limit INT CHECK (per_user_limit IS NULL OR per_user_limit > 0),
    valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    valid_to TIMESTAMPTZ,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_promo_dates CHECK (valid_to IS NULL OR valid_from <= valid_to)
);

CREATE INDEX IF NOT EXISTS idx_promotions_active ON promotions(is_active, valid_from, valid_to);
CREATE INDEX IF NOT EXISTS idx_promotions_merchant ON promotions(applicable_merchant_id);

CREATE TABLE IF NOT EXISTS promotion_applications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    promotion_id UUID NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    merchant_id UUID NOT NULL REFERENCES merchants(id),
    promotion_code VARCHAR(50) NOT NULL,
    discount_amount NUMERIC(10,2) NOT NULL CHECK (discount_amount >= 0),
    seller_share_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00 CHECK (seller_share_amount >= 0),
    platform_share_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00 CHECK (platform_share_amount >= 0),
    status VARCHAR(20) NOT NULL DEFAULT 'RESERVED'
        CHECK (status IN ('RESERVED', 'APPLIED', 'RELEASED', 'REVERSED')),
    reversed_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00 CHECK (reversed_amount >= 0),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_promotion_application_order UNIQUE (promotion_id, order_id)
);

CREATE INDEX IF NOT EXISTS idx_promo_apps_user ON promotion_applications(promotion_id, user_id, status);
CREATE INDEX IF NOT EXISTS idx_promo_apps_order ON promotion_applications(order_id);

-- ============================================================================
-- 7. Authoritative Persistent Carts & Cart Items
-- ============================================================================
CREATE TABLE IF NOT EXISTS carts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    coupon_code VARCHAR(40),
    place_of_supply_state_code VARCHAR(10),
    last_quote_id UUID,
    last_quoted_total NUMERIC(10,2),
    last_quoted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_user_merchant_cart UNIQUE (user_id, merchant_id)
);

CREATE TABLE IF NOT EXISTS cart_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cart_id UUID NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    quantity INT NOT NULL CHECK (quantity > 0),
    unit_price_snapshot NUMERIC(10,2) NOT NULL CHECK (unit_price_snapshot >= 0),
    tax_rate_snapshot NUMERIC(5,2) NOT NULL DEFAULT 0.00,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_cart_product UNIQUE (cart_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_carts_user ON carts(user_id);
CREATE INDEX IF NOT EXISTS idx_cart_items_cart ON cart_items(cart_id);

-- ============================================================================
-- 8. Orders & Order Items Financial Snapshot & Return Tracking Extensions
-- ============================================================================
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cess_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS coupon_id UUID REFERENCES coupons(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS coupon_code VARCHAR(40);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS applied_promotions JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS quote_id UUID;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS platform_discount_subsidy NUMERIC(10,2) NOT NULL DEFAULT 0.00;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS seller_discount_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00;

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (
    status IN (
        'placed', 'accepted', 'picking', 'packed', 'out_for_delivery', 'arriving', 'delivered',
        'cancelled', 'return_requested', 'return_approved', 'return_rejected',
        'return_picked_up', 'partially_returned', 'returned'
    )
);

ALTER TABLE order_items ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS cess_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS tax_inclusive BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS tax_category VARCHAR(20) NOT NULL DEFAULT 'TAXABLE';
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS line_total_payable NUMERIC(10,2);
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS refunded_quantity INT NOT NULL DEFAULT 0;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS refunded_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS applied_discounts JSONB NOT NULL DEFAULT '[]'::jsonb;

-- ============================================================================
-- 9. Settlement Allocations Subsidy & Cess Extensions
-- ============================================================================
ALTER TABLE order_settlement_allocations ADD COLUMN IF NOT EXISTS platform_discount_subsidy NUMERIC(10,2) NOT NULL DEFAULT 0.00;
ALTER TABLE order_settlement_allocations ADD COLUMN IF NOT EXISTS seller_discount_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00;
ALTER TABLE order_settlement_allocations ADD COLUMN IF NOT EXISTS cess_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00;

-- ============================================================================
-- 10. GST Invoices & Formal GST Credit Notes
-- ============================================================================
ALTER TABLE invoices ALTER COLUMN irn DROP NOT NULL;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS place_of_supply_state_code VARCHAR(10);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS supplier_state_code VARCHAR(10);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS is_inter_state BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS cess_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS financial_year VARCHAR(16);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS e_invoicing_status VARCHAR(30) NOT NULL DEFAULT 'NOT_APPLICABLE';

ALTER TABLE invoice_line_items ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00;
ALTER TABLE invoice_line_items ADD COLUMN IF NOT EXISTS cess_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00;
ALTER TABLE invoice_line_items ADD COLUMN IF NOT EXISTS tax_inclusive BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS credit_notes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    credit_note_number VARCHAR(60) UNIQUE NOT NULL,
    invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL,
    order_id UUID NOT NULL REFERENCES orders(id),
    return_id UUID REFERENCES order_returns(id) ON DELETE SET NULL,
    refund_id UUID REFERENCES refunds(id) ON DELETE SET NULL,
    credit_note_type VARCHAR(30) NOT NULL
        CHECK (credit_note_type IN ('SELLER_CREDIT_NOTE', 'QCOM_CREDIT_NOTE')),
    reason_code VARCHAR(60) NOT NULL,
    seller_gstin VARCHAR(15),
    seller_legal_name VARCHAR(255),
    customer_gstin VARCHAR(15),
    customer_business_name VARCHAR(255),
    place_of_supply_state_code VARCHAR(10),
    supplier_state_code VARCHAR(10),
    is_inter_state BOOLEAN NOT NULL DEFAULT FALSE,
    financial_year VARCHAR(16) NOT NULL,
    irn VARCHAR(64),
    e_invoicing_status VARCHAR(30) NOT NULL DEFAULT 'NOT_APPLICABLE',
    taxable_amount NUMERIC(10,2) NOT NULL CHECK (taxable_amount >= 0),
    cgst_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00 CHECK (cgst_amount >= 0),
    sgst_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00 CHECK (sgst_amount >= 0),
    igst_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00 CHECK (igst_amount >= 0),
    cess_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00 CHECK (cess_amount >= 0),
    total_amount NUMERIC(10,2) NOT NULL CHECK (total_amount >= 0),
    issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_credit_notes_order ON credit_notes(order_id);
CREATE INDEX IF NOT EXISTS idx_credit_notes_return ON credit_notes(return_id);
CREATE INDEX IF NOT EXISTS idx_credit_notes_invoice ON credit_notes(invoice_id);

CREATE TABLE IF NOT EXISTS credit_note_line_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    credit_note_id UUID NOT NULL REFERENCES credit_notes(id) ON DELETE CASCADE,
    order_item_id UUID REFERENCES order_items(id) ON DELETE SET NULL,
    item_description VARCHAR(255) NOT NULL,
    hsn_sac_code VARCHAR(20) NOT NULL,
    quantity INT NOT NULL CHECK (quantity > 0),
    taxable_value NUMERIC(10,2) NOT NULL CHECK (taxable_value >= 0),
    gst_rate_percent NUMERIC(5,2) NOT NULL DEFAULT 0.00,
    cgst_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    sgst_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    igst_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    cess_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    total_line_amount NUMERIC(10,2) NOT NULL CHECK (total_line_amount >= 0)
);

CREATE INDEX IF NOT EXISTS idx_cn_line_items_cn ON credit_note_line_items(credit_note_id);
