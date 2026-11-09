-- Migration 006: Create Idempotency Keys, Webhook Events, and Audit Logs

CREATE TABLE IF NOT EXISTS idempotency_keys (
    idempotency_key VARCHAR(120) PRIMARY KEY,
    actor_id VARCHAR(80) NOT NULL,
    endpoint VARCHAR(180) NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'PROCESSING' CHECK (status IN ('PROCESSING', 'COMPLETED', 'FAILED')),
    request_fingerprint VARCHAR(64),
    status_code INT,
    response_body JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_idempotency_expiry ON idempotency_keys(expires_at);

CREATE TABLE IF NOT EXISTS webhook_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    gateway VARCHAR(40) NOT NULL DEFAULT 'RAZORPAY',
    event_id VARCHAR(120) UNIQUE NOT NULL,
    event_type VARCHAR(80) NOT NULL,
    payload JSONB NOT NULL,
    status VARCHAR(30) DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED')),
    received_at TIMESTAMPTZ DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    retry_count INT DEFAULT 0 CHECK (retry_count >= 0),
    error_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_webhook_event_id ON webhook_events(event_id);

CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id VARCHAR(80) NOT NULL,
    actor_type VARCHAR(40) NOT NULL,
    action VARCHAR(100) NOT NULL,
    entity_type VARCHAR(80) NOT NULL,
    entity_id VARCHAR(80) NOT NULL,
    old_state JSONB,
    new_state JSONB,
    ip_address VARCHAR(45),
    user_agent TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor_id);
