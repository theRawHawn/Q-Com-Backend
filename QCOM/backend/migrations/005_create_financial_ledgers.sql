-- Migration 005: Create Double-Entry Chart of Accounts, General Ledger, and Actor Ledgers

CREATE TABLE IF NOT EXISTS general_ledger_accounts (
    account_code VARCHAR(20) PRIMARY KEY,
    account_name VARCHAR(120) NOT NULL,
    category VARCHAR(30) NOT NULL CHECK (category IN ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE')),
    normal_balance VARCHAR(10) NOT NULL CHECK (normal_balance IN ('DEBIT', 'CREDIT')),
    description TEXT,
    is_active BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS general_ledger_entries (
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
CREATE INDEX IF NOT EXISTS idx_gl_batch ON general_ledger_entries(journal_batch_id);
CREATE INDEX IF NOT EXISTS idx_gl_account ON general_ledger_entries(account_code);
CREATE INDEX IF NOT EXISTS idx_gl_ref ON general_ledger_entries(transaction_reference);

CREATE TABLE IF NOT EXISTS seller_ledgers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES merchants(id),
    order_id UUID REFERENCES orders(id),
    entry_type VARCHAR(40) NOT NULL CHECK (
        entry_type IN ('ORDER_CREDIT', 'COMMISSION_DEBIT', 'GST_ON_COMMISSION_DEBIT', 'TDS_DEBIT', 'GST_TCS_DEBIT', 'PAYOUT_SETTLED', 'ADJUSTMENT')
    ),
    category VARCHAR(10) NOT NULL CHECK (category IN ('CREDIT', 'DEBIT')),
    amount NUMERIC(10,2) NOT NULL CHECK (amount > 0),
    running_balance NUMERIC(10,2) NOT NULL,
    utr_number VARCHAR(60),
    description TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_seller_ledger_merchant ON seller_ledgers(merchant_id);

CREATE TABLE IF NOT EXISTS rider_ledgers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rider_id UUID NOT NULL REFERENCES riders(id),
    trip_id UUID REFERENCES delivery_trips(id),
    entry_type VARCHAR(40) NOT NULL CHECK (
        entry_type IN ('DELIVERY_FARE', 'SURGE_BONUS', 'WAIT_TIME_PAY', 'CUSTOMER_TIP', 'COD_DEDUCTION', 'TDS_DEBIT', 'INSTANT_PAYOUT_DEBIT', 'ADJUSTMENT')
    ),
    category VARCHAR(10) NOT NULL CHECK (category IN ('CREDIT', 'DEBIT')),
    amount NUMERIC(10,2) NOT NULL CHECK (amount > 0),
    running_balance NUMERIC(10,2) NOT NULL,
    utr_number VARCHAR(60),
    description TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rider_ledger_rider ON rider_ledgers(rider_id);
