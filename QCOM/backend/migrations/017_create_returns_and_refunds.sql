-- Migration 017: Create Returns, Return Items, Refunds, and Chart of Accounts 1040

-- 1. Extend orders status CHECK constraint to support returns
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_constraint_1;
ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (
    status IN (
        'placed', 'picking', 'packed', 'out_for_delivery', 'arriving', 'delivered', 
        'cancelled', 'return_requested', 'return_approved', 'return_rejected', 
        'return_picked_up', 'returned'
    )
);

-- 2. Extend orders payment_status CHECK constraint
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_status_check;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_constraint_11;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_constraint_12;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_constraint_15;
ALTER TABLE orders ADD CONSTRAINT orders_payment_status_check CHECK (
    payment_status IN ('PENDING', 'PAID', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'REFUND_PENDING')
);

-- 3. Add updated_at column to orders
ALTER TABLE orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- 4. Extend inventory_reservations status CHECK constraint
ALTER TABLE inventory_reservations DROP CONSTRAINT IF EXISTS inventory_reservations_status_check;
ALTER TABLE inventory_reservations ADD CONSTRAINT inventory_reservations_status_check CHECK (
    status IN ('RESERVED', 'COMMITTED', 'RELEASED', 'RESTOCKED')
);

-- 5. Extend seller_ledgers entry_type CHECK constraint
ALTER TABLE seller_ledgers DROP CONSTRAINT IF EXISTS seller_ledgers_entry_type_check;
ALTER TABLE seller_ledgers DROP CONSTRAINT IF EXISTS seller_ledgers_constraint_1;
ALTER TABLE seller_ledgers ADD CONSTRAINT seller_ledgers_entry_type_check CHECK (
    entry_type IN ('ORDER_CREDIT', 'COMMISSION_DEBIT', 'GST_ON_COMMISSION_DEBIT', 'TDS_DEBIT', 'GST_TCS_DEBIT', 'PAYOUT_SETTLED', 'ADJUSTMENT', 'ORDER_DEBIT', 'RETURN_DEBIT', 'CLAWBACK_DEBIT')
);

-- 4. Create refunds table
CREATE TABLE IF NOT EXISTS refunds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    refund_number VARCHAR(40) UNIQUE NOT NULL,
    order_id UUID NOT NULL REFERENCES orders(id),
    payment_id VARCHAR(100),
    amount NUMERIC(10,2) NOT NULL CHECK (amount > 0),
    currency VARCHAR(10) DEFAULT 'INR',
    reason_code VARCHAR(50) NOT NULL,
    reason_description TEXT,
    refund_type VARCHAR(20) NOT NULL CHECK (refund_type IN ('FULL', 'PARTIAL')),
    status VARCHAR(30) NOT NULL DEFAULT 'REQUESTED' CHECK (
        status IN ('REQUESTED', 'PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'REVERSED')
    ),
    provider_refund_id VARCHAR(100),
    idempotency_key VARCHAR(120) UNIQUE,
    created_by UUID REFERENCES users(id),
    processed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_refunds_order ON refunds(order_id);
CREATE INDEX IF NOT EXISTS idx_refunds_status ON refunds(status);

-- 5. Create order_returns table
CREATE TABLE IF NOT EXISTS order_returns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    return_number VARCHAR(40) UNIQUE NOT NULL,
    order_id UUID NOT NULL REFERENCES orders(id),
    user_id UUID NOT NULL REFERENCES users(id),
    merchant_id UUID NOT NULL REFERENCES merchants(id),
    status VARCHAR(30) NOT NULL DEFAULT 'REQUESTED' CHECK (
        status IN (
            'REQUESTED', 'APPROVED', 'REJECTED', 'PICKUP_ASSIGNED', 
            'PICKED_UP', 'RECEIVED_AT_STORE', 'ACCEPTED', 'REJECTED_QC', 'CANCELLED'
        )
    ),
    reason_code VARCHAR(50) NOT NULL,
    customer_notes TEXT,
    qc_notes TEXT,
    pickup_trip_id UUID REFERENCES delivery_trips(id),
    refund_id UUID REFERENCES refunds(id),
    requested_at TIMESTAMPTZ DEFAULT NOW(),
    approved_at TIMESTAMPTZ,
    received_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_returns_order ON order_returns(order_id);
CREATE INDEX IF NOT EXISTS idx_returns_user ON order_returns(user_id);
CREATE INDEX IF NOT EXISTS idx_returns_merchant ON order_returns(merchant_id);
CREATE INDEX IF NOT EXISTS idx_returns_status ON order_returns(status);

-- 6. Create order_return_items table
CREATE TABLE IF NOT EXISTS order_return_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    return_id UUID NOT NULL REFERENCES order_returns(id) ON DELETE CASCADE,
    order_item_id UUID NOT NULL REFERENCES order_items(id),
    product_id UUID NOT NULL REFERENCES products(id),
    quantity INT NOT NULL CHECK (quantity > 0),
    qc_status VARCHAR(20) DEFAULT 'PENDING' CHECK (qc_status IN ('PENDING', 'PASSED', 'FAILED')),
    restocked BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_return_items_return ON order_return_items(return_id);
