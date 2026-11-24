-- Migration 030: Sprint 15.9 COD Cash Accountability, Rider Cash Liability, Remittance & Reconciliation Integrity
-- Forward-only migration introducing authoritative COD collection custody records, multi-stage cash remittances,
-- order-level collection-to-remittance allocations, shortage/excess dispute resolution records,
-- decoupled COD rider restrictions, separation-of-duties constraints, and COD Chart of Accounts extensions.

-- ============================================================================
-- 1. Chart of Accounts (COA) & General Ledger Transaction Type Extensions
-- ============================================================================
INSERT INTO general_ledger_accounts (account_code, account_name, category, normal_balance, description)
VALUES
    ('1050', 'Rider Cash Shortage Receivable', 'ASSET', 'DEBIT', 'Recognized COD cash shortages owed by delivery partners pending recovery or authorized settlement'),
    ('2080', 'Unidentified / Excess COD Cash Suspense', 'LIABILITY', 'CREDIT', 'Excess cash remitted by riders above expected COD liability pending reconciliation or return'),
    ('5030', 'COD Cash Variance & Authorized Write-Off Expense', 'EXPENSE', 'DEBIT', 'Formally authorized finance write-offs for unrecoverable COD cash shortages')
ON CONFLICT (account_code) DO NOTHING;

ALTER TABLE general_ledger_entries DROP CONSTRAINT IF EXISTS general_ledger_entries_transaction_type_check;
ALTER TABLE general_ledger_entries DROP CONSTRAINT IF EXISTS general_ledger_entries_constraint_1;
DO $$
DECLARE
    con_name TEXT;
BEGIN
    FOR con_name IN
        SELECT c.conname
        FROM pg_constraint c
        JOIN pg_class t ON c.conrelid = t.oid
        WHERE t.relname = 'general_ledger_entries'
          AND c.contype = 'c'
          AND pg_get_constraintdef(c.oid) LIKE '%transaction_type%'
    LOOP
        EXECUTE format('ALTER TABLE general_ledger_entries DROP CONSTRAINT IF EXISTS %I', con_name);
    END LOOP;
END $$;
ALTER TABLE general_ledger_entries ADD CONSTRAINT general_ledger_entries_transaction_type_check CHECK (
    transaction_type IN (
        'CUSTOMER_PAYMENT',
        'ORDER_FULFILLMENT',
        'MERCHANT_SETTLEMENT',
        'RIDER_PAYOUT',
        'COD_COLLECTION',
        'COD_REMITTANCE',
        'COD_SHORTAGE',
        'COD_EXCESS',
        'COD_ADJUSTMENT',
        'COD_REVERSAL',
        'REFUND',
        'ADJUSTMENT'
    )
);

-- ============================================================================
-- 2. Riders: Decoupled COD Restrictions, Ceiling Overrides & Dispute Counters
-- ============================================================================
ALTER TABLE riders
    ADD COLUMN IF NOT EXISTS cod_restricted BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS cod_restriction_reason TEXT,
    ADD COLUMN IF NOT EXISTS cod_restricted_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS cod_ceiling_override_limit NUMERIC(12,2),
    ADD COLUMN IF NOT EXISTS cod_ceiling_override_by UUID REFERENCES users(id),
    ADD COLUMN IF NOT EXISTS cod_ceiling_override_reason TEXT,
    ADD COLUMN IF NOT EXISTS cod_ceiling_override_until TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS active_cod_dispute_count INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS cod_overdue_since TIMESTAMPTZ;

ALTER TABLE riders DROP CONSTRAINT IF EXISTS chk_riders_floating_cash_limit_pos;
ALTER TABLE riders ADD CONSTRAINT chk_riders_floating_cash_limit_pos CHECK (
    floating_cash_limit IS NULL OR floating_cash_limit > 0
);

ALTER TABLE riders DROP CONSTRAINT IF EXISTS chk_riders_cod_override_limit_pos;
ALTER TABLE riders ADD CONSTRAINT chk_riders_cod_override_limit_pos CHECK (
    cod_ceiling_override_limit IS NULL OR cod_ceiling_override_limit > 0
);

ALTER TABLE riders DROP CONSTRAINT IF EXISTS chk_riders_active_cod_dispute_nonneg;
ALTER TABLE riders ADD CONSTRAINT chk_riders_active_cod_dispute_nonneg CHECK (
    active_cod_dispute_count >= 0
);

-- ============================================================================
-- 3. Authoritative Order-Level COD Collections (1:1 per COD Order)
-- ============================================================================
CREATE TABLE IF NOT EXISTS cod_collections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    collection_reference VARCHAR(120) UNIQUE NOT NULL,
    order_id UUID UNIQUE NOT NULL REFERENCES orders(id),
    trip_id UUID UNIQUE REFERENCES delivery_trips(id),
    rider_id UUID NOT NULL REFERENCES riders(id),
    currency VARCHAR(10) NOT NULL DEFAULT 'INR',
    expected_amount NUMERIC(12,2) NOT NULL CHECK (expected_amount > 0),
    collected_amount NUMERIC(12,2) NOT NULL CHECK (collected_amount > 0 AND collected_amount <= expected_amount),
    allocated_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (allocated_amount >= 0),
    cleared_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (cleared_amount >= 0),
    disputed_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (disputed_amount >= 0),
    status VARCHAR(40) NOT NULL DEFAULT 'COLLECTED' CHECK (
        status IN (
            'COLLECTED',
            'PARTIALLY_ALLOCATED',
            'ALLOCATED',
            'PARTIALLY_CLEARED',
            'CLEARED',
            'SHORTAGE_DISPUTED',
            'REVERSED',
            'WRITTEN_OFF'
        )
    ),
    journal_batch_id UUID,
    ledger_transaction_reference VARCHAR(120),
    collected_by_user_id UUID REFERENCES users(id),
    collector_source VARCHAR(40) NOT NULL DEFAULT 'DELIVERY_OTP_COMPLETION',
    idempotency_key VARCHAR(120),
    collected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    cleared_at TIMESTAMPTZ,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_cod_collections_allocation_bounds CHECK (allocated_amount + cleared_amount <= collected_amount)
);

CREATE INDEX IF NOT EXISTS idx_cod_collections_rider_status
    ON cod_collections(rider_id, status, collected_at ASC);

CREATE INDEX IF NOT EXISTS idx_cod_collections_open_fifo
    ON cod_collections(rider_id, collected_at ASC, id ASC)
    WHERE status IN ('COLLECTED', 'PARTIALLY_ALLOCATED', 'PARTIALLY_CLEARED', 'SHORTAGE_DISPUTED');

-- ============================================================================
-- 4. Multi-Stage Cash Remittances with Separation of Duties
-- ============================================================================
CREATE TABLE IF NOT EXISTS cod_remittances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    remittance_reference VARCHAR(120) UNIQUE NOT NULL,
    idempotency_key VARCHAR(120),
    rider_id UUID NOT NULL REFERENCES riders(id),
    currency VARCHAR(10) NOT NULL DEFAULT 'INR',
    submitted_amount NUMERIC(12,2) NOT NULL CHECK (submitted_amount > 0),
    received_amount NUMERIC(12,2) CHECK (received_amount IS NULL OR received_amount >= 0),
    verified_amount NUMERIC(12,2) CHECK (verified_amount IS NULL OR verified_amount >= 0),
    cleared_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (cleared_amount >= 0),
    shortage_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (shortage_amount >= 0),
    excess_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (excess_amount >= 0),
    remittance_method VARCHAR(30) NOT NULL DEFAULT 'CASH_HUB' CHECK (
        remittance_method IN ('CASH_HUB', 'UPI', 'BANK', 'KIOSK', 'DEPOSIT_SLIP')
    ),
    collection_location VARCHAR(150),
    evidence_reference VARCHAR(150),
    status VARCHAR(40) NOT NULL DEFAULT 'SUBMITTED' CHECK (
        status IN (
            'DRAFT',
            'SUBMITTED',
            'RECEIVED',
            'VERIFICATION_PENDING',
            'VERIFIED',
            'LIABILITY_CLEARED',
            'SHORTAGE',
            'EXCESS',
            'DISPUTED',
            'REJECTED',
            'CANCELLED',
            'REVERSED'
        )
    ),
    submitted_by UUID REFERENCES users(id),
    received_by UUID REFERENCES users(id),
    verified_by UUID REFERENCES users(id),
    rejected_by UUID REFERENCES users(id),
    reversed_by UUID REFERENCES users(id),
    submitted_at TIMESTAMPTZ,
    received_at TIMESTAMPTZ,
    verification_started_at TIMESTAMPTZ,
    verified_at TIMESTAMPTZ,
    cleared_at TIMESTAMPTZ,
    rejected_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    reversed_at TIMESTAMPTZ,
    journal_batch_id UUID,
    ledger_transaction_reference VARCHAR(120),
    reversal_journal_batch_id UUID,
    reversal_transaction_reference VARCHAR(120),
    discrepancy_notes TEXT,
    rejection_reason TEXT,
    reversal_reason TEXT,
    version INT NOT NULL DEFAULT 1,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_cod_remit_receiver_not_submitter CHECK (
        received_by IS NULL OR submitted_by IS NULL OR received_by <> submitted_by
    ),
    CONSTRAINT chk_cod_remit_verifier_not_submitter CHECK (
        verified_by IS NULL OR submitted_by IS NULL OR verified_by <> submitted_by
    ),
    CONSTRAINT chk_cod_remit_verifier_not_receiver CHECK (
        verified_by IS NULL OR received_by IS NULL OR verified_by <> received_by
    )
);

CREATE INDEX IF NOT EXISTS idx_cod_remittances_rider_status
    ON cod_remittances(rider_id, status, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cod_remittances_idempotency
    ON cod_remittances(rider_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cod_remittances_stale_scan
    ON cod_remittances(status, submitted_at, received_at)
    WHERE status IN ('SUBMITTED', 'RECEIVED', 'VERIFICATION_PENDING', 'VERIFIED');

-- ============================================================================
-- 5. Remittance-to-Collection Allocations (Order-Level Traceability)
-- ============================================================================
CREATE TABLE IF NOT EXISTS cod_remittance_allocations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    remittance_id UUID NOT NULL REFERENCES cod_remittances(id),
    collection_id UUID NOT NULL REFERENCES cod_collections(id),
    order_id UUID NOT NULL REFERENCES orders(id),
    allocated_amount NUMERIC(12,2) NOT NULL CHECK (allocated_amount > 0),
    cleared_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (cleared_amount >= 0),
    status VARCHAR(30) NOT NULL DEFAULT 'RESERVED' CHECK (
        status IN ('RESERVED', 'CLEARED', 'SHORTAGE_PARTIAL', 'RELEASED', 'REVERSED')
    ),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_cod_remit_alloc_pair UNIQUE (remittance_id, collection_id)
);

CREATE INDEX IF NOT EXISTS idx_cod_remit_alloc_collection
    ON cod_remittance_allocations(collection_id, status);

CREATE INDEX IF NOT EXISTS idx_cod_remit_alloc_order
    ON cod_remittance_allocations(order_id);

-- ============================================================================
-- 6. COD Shortages, Excesses & Cash Accountability Disputes
-- ============================================================================
CREATE TABLE IF NOT EXISTS cod_cash_disputes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dispute_number VARCHAR(60) UNIQUE NOT NULL,
    remittance_id UUID REFERENCES cod_remittances(id),
    collection_id UUID REFERENCES cod_collections(id),
    order_id UUID REFERENCES orders(id),
    rider_id UUID NOT NULL REFERENCES riders(id),
    dispute_type VARCHAR(30) NOT NULL CHECK (
        dispute_type IN ('SHORTAGE', 'EXCESS', 'MISSING_COLLECTION', 'CUSTOMER_DISPUTE', 'VERIFICATION_DISPUTE', 'OVERDUE_LIABILITY')
    ),
    status VARCHAR(30) NOT NULL DEFAULT 'OPEN' CHECK (
        status IN ('OPEN', 'UNDER_INVESTIGATION', 'RESOLVED', 'ESCALATED', 'REJECTED')
    ),
    resolution_type VARCHAR(40) CHECK (
        resolution_type IS NULL OR resolution_type IN (
            'RECOVERED_CASH',
            'RECOVERED_FROM_WALLET',
            'ESCALATED_TO_RECEIVABLE',
            'RECEIVABLE_COLLECTED',
            'WRITTEN_OFF',
            'EXCESS_RETURNED',
            'EXCESS_ALLOCATED_TO_COLLECTION',
            'CONFIRMED_NO_VARIANCE',
            'REVERSED'
        )
    ),
    expected_amount NUMERIC(12,2) NOT NULL CHECK (expected_amount >= 0),
    submitted_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (submitted_amount >= 0),
    verified_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (verified_amount >= 0),
    disputed_amount NUMERIC(12,2) NOT NULL CHECK (disputed_amount > 0),
    reason TEXT NOT NULL,
    evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
    opened_by UUID REFERENCES users(id),
    verified_by UUID REFERENCES users(id),
    resolved_by UUID REFERENCES users(id),
    resolution_notes TEXT,
    journal_batch_id UUID,
    ledger_transaction_reference VARCHAR(120),
    opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cod_disputes_rider_status
    ON cod_cash_disputes(rider_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cod_disputes_remit_type_open
    ON cod_cash_disputes(remittance_id, dispute_type)
    WHERE remittance_id IS NOT NULL AND dispute_type IN ('SHORTAGE', 'EXCESS');

-- ============================================================================
-- 7. Reconciliation Discrepancies COD Correlation Columns
-- ============================================================================
ALTER TABLE reconciliation_discrepancies
    ADD COLUMN IF NOT EXISTS rider_id UUID,
    ADD COLUMN IF NOT EXISTS remittance_id UUID,
    ADD COLUMN IF NOT EXISTS collection_id UUID;

CREATE INDEX IF NOT EXISTS idx_reconciliation_discrepancies_rider
    ON reconciliation_discrepancies(rider_id)
    WHERE rider_id IS NOT NULL;
