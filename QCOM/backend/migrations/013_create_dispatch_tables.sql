-- Migration 013: Create Dispatch Assignments, Offers, and Rider Status Extension

-- 1. Extend rider status constraint to support state machine transitions
ALTER TABLE riders DROP CONSTRAINT IF EXISTS riders_status_check;
ALTER TABLE riders DROP CONSTRAINT IF EXISTS riders_constraint_5;
ALTER TABLE riders ADD CONSTRAINT riders_status_check CHECK (
    status IN ('OFFLINE', 'IDLE_AT_HUB', 'AVAILABLE', 'OFFERED', 'ASSIGNED', 'PICKING_UP', 'IN_TRANSIT', 'ON_TRIP', 'ARRIVED_AT_DROP', 'UNAVAILABLE', 'SUSPENDED')
);

-- 2. Dispatch Assignments Table
CREATE TABLE IF NOT EXISTS dispatch_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id),
    delivery_trip_id UUID REFERENCES delivery_trips(id),
    rider_id UUID NOT NULL REFERENCES riders(id),
    status VARCHAR(30) NOT NULL DEFAULT 'CREATED' CHECK (
        status IN ('CREATED', 'OFFERED', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED', 'COMPLETED')
    ),
    scoring_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dispatch_assignments_order ON dispatch_assignments(order_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_assignments_rider ON dispatch_assignments(rider_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_assignments_status ON dispatch_assignments(status);

-- Ensure only one active assignment per order
CREATE UNIQUE INDEX IF NOT EXISTS idx_active_dispatch_assignment ON dispatch_assignments(order_id)
WHERE status IN ('CREATED', 'OFFERED', 'ACCEPTED');

-- 3. Dispatch Offers Table
CREATE TABLE IF NOT EXISTS dispatch_offers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    assignment_id UUID NOT NULL REFERENCES dispatch_assignments(id) ON DELETE CASCADE,
    rider_id UUID NOT NULL REFERENCES riders(id),
    order_id UUID NOT NULL REFERENCES orders(id),
    status VARCHAR(30) NOT NULL DEFAULT 'OFFERED' CHECK (
        status IN ('OFFERED', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED')
    ),
    rejection_reason TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dispatch_offers_assignment ON dispatch_offers(assignment_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_offers_rider ON dispatch_offers(rider_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_offers_status ON dispatch_offers(status);

-- Ensure only one active offer per rider
CREATE UNIQUE INDEX IF NOT EXISTS idx_active_rider_offer ON dispatch_offers(rider_id)
WHERE status = 'OFFERED';
