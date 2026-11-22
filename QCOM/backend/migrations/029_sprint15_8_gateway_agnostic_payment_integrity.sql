-- Migration 029: Sprint 15.8 Gateway-Agnostic Payment Infrastructure, Lifecycle Integrity & Internal Reconciliation
-- 1. Hardens payment_intents and payment_attempts with lifecycle timestamps, failure classification,
--    retry scheduling, optimistic versioning, and single-obligation / single-capture partial unique indexes.
-- 2. Introduces normalized immutable payment_transactions ledger table separating Order -> Payment -> Attempt -> Transaction.
-- 3. Adds operation scoping and expiry indexing on PostgreSQL-backed idempotency_keys.
-- 4. Enforces single successful payment receipt per order.
-- 5. Expands refunds and orders status domains for UNKNOWN and REQUIRES_REVIEW outcomes.
-- 6. Adds durable reconciliation_runs and reconciliation_discrepancies exception persistence tables.

-- ============================================================================
-- 1. Harden payment_intents (Authoritative Payment Obligation Record)
-- ============================================================================
ALTER TABLE payment_intents
    ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id),
    ADD COLUMN IF NOT EXISTS payment_method VARCHAR(40),
    ADD COLUMN IF NOT EXISTS internal_transaction_reference VARCHAR(120),
    ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS succeeded_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS expired_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS failure_classification VARCHAR(30),
    ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS requires_manual_review BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;

ALTER TABLE payment_intents DROP CONSTRAINT IF EXISTS payment_intents_status_check;
ALTER TABLE payment_intents ADD CONSTRAINT payment_intents_status_check
  CHECK (status IN (
    'CREATED',
    'INITIATED',
    'PENDING',
    'PROCESSING',
    'AUTHORIZED',
    'CAPTURED',
    'FAILED',
    'CANCELLED',
    'EXPIRED',
    'UNKNOWN',
    'RECONCILIATION_REQUIRED',
    'REQUIRES_REVIEW',
    'REFUND_PENDING',
    'PARTIALLY_REFUNDED',
    'REFUNDED'
  ));

ALTER TABLE payment_intents DROP CONSTRAINT IF EXISTS chk_payment_intents_failure_class;
ALTER TABLE payment_intents ADD CONSTRAINT chk_payment_intents_failure_class
  CHECK (failure_classification IS NULL OR failure_classification IN ('TRANSIENT', 'PERMANENT', 'AMBIGUOUS', 'POLICY'));

-- Partial unique index: at most ONE captured/post-capture payment obligation per order
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_intents_single_captured_per_order
    ON payment_intents(order_id)
    WHERE status IN ('CAPTURED', 'REFUND_PENDING', 'PARTIALLY_REFUNDED', 'REFUNDED');

-- Partial unique index: at most ONE active/in-flight/pending-review payment obligation per order
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_intents_single_active_per_order
    ON payment_intents(order_id)
    WHERE status IN ('CREATED', 'INITIATED', 'PENDING', 'PROCESSING', 'AUTHORIZED', 'UNKNOWN', 'RECONCILIATION_REQUIRED', 'REQUIRES_REVIEW');

CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_intents_internal_tx_ref
    ON payment_intents(internal_transaction_reference)
    WHERE internal_transaction_reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payment_intents_retry_schedule
    ON payment_intents(status, next_retry_at)
    WHERE next_retry_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payment_intents_expires_at
    ON payment_intents(expires_at)
    WHERE expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payment_intents_user
    ON payment_intents(user_id)
    WHERE user_id IS NOT NULL;

-- ============================================================================
-- 2. Harden payment_attempts (Bounded & Uniquely Tracked Payment Attempts)
-- ============================================================================
ALTER TABLE payment_attempts
    ADD COLUMN IF NOT EXISTS internal_reference VARCHAR(120),
    ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS failure_classification VARCHAR(30),
    ADD COLUMN IF NOT EXISTS retry_eligible BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1;

ALTER TABLE payment_attempts DROP CONSTRAINT IF EXISTS payment_attempts_status_check;
ALTER TABLE payment_attempts DROP CONSTRAINT IF EXISTS payment_attempts_constraint_1;
ALTER TABLE payment_attempts ADD CONSTRAINT payment_attempts_status_check
  CHECK (status IN (
    'INITIATED',
    'PENDING',
    'PROCESSING',
    'SUCCEEDED',
    'FAILED',
    'CANCELLED',
    'EXPIRED',
    'UNKNOWN',
    'RECONCILIATION_REQUIRED',
    'REQUIRES_REVIEW'
  ));

ALTER TABLE payment_attempts DROP CONSTRAINT IF EXISTS chk_payment_attempts_failure_class;
ALTER TABLE payment_attempts ADD CONSTRAINT chk_payment_attempts_failure_class
  CHECK (failure_classification IS NULL OR failure_classification IN ('TRANSIENT', 'PERMANENT', 'AMBIGUOUS', 'POLICY'));

CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_attempts_internal_ref
    ON payment_attempts(internal_reference)
    WHERE internal_reference IS NOT NULL;

-- At most ONE succeeded payment attempt per order (prevents double capture across attempts)
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_attempts_single_succeeded_per_order
    ON payment_attempts(order_id)
    WHERE status = 'SUCCEEDED';

-- At most ONE active in-flight attempt per order
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_attempts_single_active_per_order
    ON payment_attempts(order_id)
    WHERE status IN ('INITIATED', 'PENDING', 'PROCESSING', 'UNKNOWN', 'RECONCILIATION_REQUIRED', 'REQUIRES_REVIEW');

-- ============================================================================
-- 3. Normalized Immutable Payment Transactions Ledger Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS payment_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    internal_reference VARCHAR(120) UNIQUE NOT NULL,
    order_id UUID NOT NULL REFERENCES orders(id),
    payment_intent_id UUID REFERENCES payment_intents(id),
    payment_attempt_id UUID REFERENCES payment_attempts(id),
    refund_id UUID REFERENCES refunds(id),
    transaction_type VARCHAR(30) NOT NULL CHECK (
        transaction_type IN ('AUTHORIZATION', 'CAPTURE', 'REFUND', 'REVERSAL', 'VOID', 'CHARGEBACK', 'STATUS_CHECK')
    ),
    status VARCHAR(30) NOT NULL CHECK (
        status IN ('PENDING', 'SUCCEEDED', 'FAILED', 'UNKNOWN', 'CANCELLED')
    ),
    amount NUMERIC(10,2) NOT NULL CHECK (amount >= 0),
    currency VARCHAR(10) NOT NULL DEFAULT 'INR',
    payment_mode VARCHAR(40),
    provider_id VARCHAR(50) NOT NULL DEFAULT 'UNSELECTED',
    external_reference VARCHAR(120),
    idempotency_key VARCHAR(120),
    ledger_transaction_reference VARCHAR(120),
    metadata JSONB DEFAULT '{}'::jsonb,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_transactions_order
    ON payment_transactions(order_id);

CREATE INDEX IF NOT EXISTS idx_payment_transactions_order_created
    ON payment_transactions(order_id, created_at);

-- At most ONE successful CAPTURE transaction per order
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_tx_single_capture_per_order
    ON payment_transactions(order_id)
    WHERE transaction_type = 'CAPTURE' AND status = 'SUCCEEDED';

-- Unique provider external reference per transaction type (when external ref exists)
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_tx_provider_ext_ref
    ON payment_transactions(transaction_type, provider_id, external_reference)
    WHERE external_reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payment_transactions_intent
    ON payment_transactions(payment_intent_id);

-- ============================================================================
-- 4. Single Successful Receipt Guard & PostgreSQL Idempotency Scoping
-- ============================================================================
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_receipts_order_success
    ON payment_receipts(order_id)
    WHERE status = 'SUCCESS';

ALTER TABLE idempotency_keys
    ADD COLUMN IF NOT EXISTS operation_type VARCHAR(80) NOT NULL DEFAULT 'GENERAL',
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_idempotency_scope
    ON idempotency_keys(actor_id, operation_type, endpoint, idempotency_key);

-- ============================================================================
-- 5. Expand Refunds & Orders Status Constraints for Explicit UNKNOWN / Review
-- ============================================================================
ALTER TABLE refunds
    ADD COLUMN IF NOT EXISTS failure_classification VARCHAR(30),
    ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS requires_manual_review BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1;

ALTER TABLE refunds DROP CONSTRAINT IF EXISTS refunds_status_check;
ALTER TABLE refunds DROP CONSTRAINT IF EXISTS refunds_constraint_3;
ALTER TABLE refunds ADD CONSTRAINT refunds_status_check
  CHECK (status IN ('REQUESTED', 'PENDING', 'PROCESSING', 'UNKNOWN', 'COMPLETED', 'FAILED', 'REVERSED', 'REQUIRES_REVIEW'));

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_payment_status_check
  CHECK (payment_status IN ('PENDING', 'PAID', 'FAILED', 'EXPIRED', 'UNKNOWN', 'REQUIRES_REVIEW', 'REFUNDED', 'PARTIALLY_REFUNDED', 'REFUND_PENDING'));

-- ============================================================================
-- 6. Internal Reconciliation Runs & Persistent Discrepancy Exceptions
-- ============================================================================
CREATE TABLE IF NOT EXISTS reconciliation_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_type VARCHAR(40) NOT NULL CHECK (run_type IN ('SCHEDULED', 'MANUAL', 'ORDER_SCOPED', 'TEST')),
    triggered_by VARCHAR(80),
    status VARCHAR(30) NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED')),
    scanned_orders INT NOT NULL DEFAULT 0,
    discrepancies_found INT NOT NULL DEFAULT 0,
    auto_repaired_count INT NOT NULL DEFAULT 0,
    manual_review_count INT NOT NULL DEFAULT 0,
    summary JSONB DEFAULT '{}'::jsonb,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS reconciliation_discrepancies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    discrepancy_key VARCHAR(160) UNIQUE NOT NULL,
    run_id UUID NOT NULL REFERENCES reconciliation_runs(id),
    category VARCHAR(60) NOT NULL,
    severity VARCHAR(20) NOT NULL CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
    status VARCHAR(30) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'AUTO_REPAIRED', 'REQUIRES_REVIEW', 'RESOLVED')),
    order_id UUID,
    payment_intent_id UUID,
    payment_attempt_id UUID,
    refund_id UUID,
    expected_amount NUMERIC(10,2),
    actual_amount NUMERIC(10,2),
    currency VARCHAR(10) DEFAULT 'INR',
    repair_action VARCHAR(120),
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    occurrence_count INT NOT NULL DEFAULT 1,
    detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ,
    resolved_by VARCHAR(80)
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_discrepancies_status_sev
    ON reconciliation_discrepancies(status, severity, category);

CREATE INDEX IF NOT EXISTS idx_reconciliation_discrepancies_order
    ON reconciliation_discrepancies(order_id);
