-- Migration 010: Create Seller Product Tax Configuration & Review Ledger
-- Separates Seller's Goods Tax from QCOM's Service Fees & Statutory Collections

CREATE TABLE IF NOT EXISTS seller_product_tax (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    hsn_code VARCHAR(20) NOT NULL,
    gst_rate_percent NUMERIC(5,2) NOT NULL CHECK (gst_rate_percent >= 0 AND gst_rate_percent <= 100),
    cgst_rate_percent NUMERIC(5,2) NOT NULL CHECK (cgst_rate_percent >= 0),
    sgst_rate_percent NUMERIC(5,2) NOT NULL CHECK (sgst_rate_percent >= 0),
    igst_rate_percent NUMERIC(5,2) NOT NULL CHECK (igst_rate_percent >= 0),
    tax_rate_source VARCHAR(40) NOT NULL DEFAULT 'SELLER_DECLARED',
    status VARCHAR(30) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'UNDER_REVIEW', 'SUPERSEDED')),
    admin_review_flag BOOLEAN DEFAULT FALSE,
    admin_review_notes TEXT,
    effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
    effective_to DATE,
    seller_declared_at TIMESTAMPTZ DEFAULT NOW(),
    verified_at TIMESTAMPTZ,
    verified_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_seller_product_tax UNIQUE(product_id, merchant_id, effective_from),
    CONSTRAINT chk_seller_tax_dates CHECK (effective_to IS NULL OR effective_from <= effective_to)
);

CREATE INDEX IF NOT EXISTS idx_seller_product_tax_lookup ON seller_product_tax(product_id, merchant_id, effective_from);
CREATE INDEX IF NOT EXISTS idx_seller_product_tax_hsn ON seller_product_tax(hsn_code);
CREATE INDEX IF NOT EXISTS idx_seller_product_tax_review ON seller_product_tax(admin_review_flag);
