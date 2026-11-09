-- Migration 016: Create Realtime Outbox, Device Tokens, Notification Preferences, Rich Push Campaigns, Deliveries, and Metrics

-- 1. Transactional Outbox Events Table
CREATE TABLE IF NOT EXISTS outbox_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type VARCHAR(100) NOT NULL,
    aggregate_type VARCHAR(60) NOT NULL,
    aggregate_id UUID NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    published_at TIMESTAMPTZ,
    attempt_count INT DEFAULT 0,
    next_attempt_at TIMESTAMPTZ DEFAULT NOW(),
    last_error TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (
        status IN ('PENDING', 'PUBLISHED', 'FAILED', 'DEAD_LETTER')
    )
);

CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox_events(status, next_attempt_at)
WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_outbox_aggregate ON outbox_events(aggregate_type, aggregate_id);

-- 2. User Device Tokens (Push Notification Registry)
CREATE TABLE IF NOT EXISTS user_device_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(64) NOT NULL,
    raw_token_preview VARCHAR(16) NOT NULL,
    provider VARCHAR(20) NOT NULL DEFAULT 'FCM' CHECK (
        provider IN ('FCM', 'APNS', 'MOCK', 'WEB_PUSH')
    ),
    platform VARCHAR(20) NOT NULL CHECK (
        platform IN ('ANDROID', 'IOS', 'WEB')
    ),
    app_version VARCHAR(30),
    device_metadata_minimal JSONB DEFAULT '{}'::jsonb,
    is_active BOOLEAN DEFAULT TRUE,
    last_seen_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_user_device_token UNIQUE (user_id, token_hash)
);

CREATE INDEX IF NOT EXISTS idx_device_tokens_user ON user_device_tokens(user_id, is_active);

-- 3. Customer Notification Preferences & Consent Controls
CREATE TABLE IF NOT EXISTS notification_preferences (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    push_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    transactional_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    delivery_updates_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    promotional_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Admin Rich Push Campaigns
CREATE TABLE IF NOT EXISTS notification_campaigns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_by UUID NOT NULL REFERENCES users(id),
    name VARCHAR(150) NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'DRAFT' CHECK (
        status IN ('DRAFT', 'SCHEDULED', 'PROCESSING', 'COMPLETED', 'CANCELLED', 'FAILED', 'EXPIRED')
    ),
    title VARCHAR(200) NOT NULL,
    body TEXT NOT NULL,
    image_url TEXT,
    deep_link VARCHAR(255),
    audience_type VARCHAR(60) NOT NULL CHECK (
        audience_type IN (
            'ALL_ACTIVE_CUSTOMERS',
            'LOCATION_OR_ZONE',
            'NEW_CUSTOMERS',
            'INACTIVE_CUSTOMERS',
            'CATEGORY_PURCHASERS',
            'PRODUCT_PURCHASERS',
            'CUSTOMER_SEGMENT',
            'FUTURE_ALGORITHM_AUDIENCE'
        )
    ),
    audience_definition JSONB DEFAULT '{}'::jsonb,
    scheduled_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    priority VARCHAR(20) NOT NULL DEFAULT 'NORMAL' CHECK (
        priority IN ('LOW', 'NORMAL', 'HIGH', 'CRITICAL')
    ),
    frequency_policy JSONB DEFAULT '{"cooldownHours": 24, "maxPerUserPerDay": 1}'::jsonb,
    dedupe_key VARCHAR(120),
    campaign_type VARCHAR(30) NOT NULL DEFAULT 'ADMIN_CAMPAIGN' CHECK (
        campaign_type IN ('ADMIN_CAMPAIGN', 'ALGORITHM_CAMPAIGN')
    ),
    algorithm_metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campaigns_status ON notification_campaigns(status);

-- 5. Notification Deliveries (Audit, Delivery Tracking, and Deduplication)
CREATE TABLE IF NOT EXISTS notification_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    notification_id_or_campaign_id UUID NOT NULL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_token_reference UUID REFERENCES user_device_tokens(id),
    notification_type VARCHAR(40) NOT NULL CHECK (
        notification_type IN ('TRANSACTIONAL', 'DELIVERY_UPDATE', 'PROMOTIONAL', 'DISPATCH_OFFER', 'SYSTEM_ALERT')
    ),
    dedupe_key VARCHAR(160) NOT NULL UNIQUE,
    status VARCHAR(30) NOT NULL DEFAULT 'QUEUED' CHECK (
        status IN ('QUEUED', 'SENT', 'DELIVERED', 'FAILED', 'SKIPPED_PREFERENCE', 'SKIPPED_COOLDOWN')
    ),
    provider VARCHAR(20) NOT NULL DEFAULT 'MOCK',
    provider_message_id VARCHAR(120),
    sent_at TIMESTAMPTZ,
    delivered_at_if_available TIMESTAMPTZ,
    opened_at_if_available TIMESTAMPTZ,
    clicked_at_if_available TIMESTAMPTZ,
    failure_code VARCHAR(60),
    failure_reason TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_user ON notification_deliveries(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_camp ON notification_deliveries(notification_id_or_campaign_id);

-- 6. Notification Event Metrics (Analytics & Future Algorithmic Optimization)
CREATE TABLE IF NOT EXISTS notification_event_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    notification_id UUID NOT NULL,
    campaign_id_nullable UUID REFERENCES notification_campaigns(id),
    event_type VARCHAR(30) NOT NULL CHECK (
        event_type IN ('SENT', 'DELIVERED', 'OPENED', 'CLICKED', 'DISMISSED', 'FAILED')
    ),
    occurred_at TIMESTAMPTZ DEFAULT NOW(),
    metadata_minimal JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_event_metrics_user_type ON notification_event_metrics(user_id, event_type);
CREATE INDEX IF NOT EXISTS idx_event_metrics_campaign ON notification_event_metrics(campaign_id_nullable);
