-- Migration 007: Create Versioned Statutory Tax Rules, Withholding Rules, and GST TCS Rules

CREATE TABLE IF NOT EXISTS statutory_tax_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_code VARCHAR(60) NOT NULL,
    tax_type VARCHAR(40) NOT NULL CHECK (
        tax_type IN ('PRODUCT_GST', 'DELIVERY_GST', 'HANDLING_GST', 'COMMISSION_GST')
    ),
    hsn_or_sac_code VARCHAR(20) NOT NULL,
    description VARCHAR(255) NOT NULL,
    effective_from DATE NOT NULL,
    effective_to DATE,
    gst_rate_percent NUMERIC(5,2) NOT NULL,
    cgst_rate_percent NUMERIC(5,2) NOT NULL,
    sgst_rate_percent NUMERIC(5,2) NOT NULL,
    igst_rate_percent NUMERIC(5,2) NOT NULL,
    calculation_base VARCHAR(40) NOT NULL DEFAULT 'TAXABLE_VALUE',
    rounding_rule VARCHAR(40) NOT NULL DEFAULT 'ROUND_HALF_UP_2_DECIMALS',
    statutory_reference VARCHAR(120) NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_tax_rule_code_date UNIQUE(rule_code, effective_from)
);

CREATE TABLE IF NOT EXISTS statutory_withholding_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_code VARCHAR(80) NOT NULL,
    governing_law VARCHAR(60) NOT NULL CHECK (
        governing_law IN ('INCOME_TAX_ACT_2025', 'INCOME_TAX_ACT_1961', 'CGST_ACT_2017')
    ),
    statutory_provision VARCHAR(80) NOT NULL,
    table_item VARCHAR(40),
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

CREATE TABLE IF NOT EXISTS gst_tcs_rules (
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
