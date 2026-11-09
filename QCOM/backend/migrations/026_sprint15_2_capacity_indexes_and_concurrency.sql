-- Migration 026: Sprint 15.2 Backend Capacity, Concurrency & Operational Resilience Indexes

-- 0. Extend orders status CHECK constraint to support 'accepted' status
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (
    status IN (
        'placed', 'accepted', 'picking', 'packed', 'out_for_delivery', 'arriving', 'delivered', 
        'cancelled', 'return_requested', 'return_approved', 'return_rejected', 
        'return_picked_up', 'returned'
    )
);

-- 1. Orders lookup by customer with reverse chronological sorting
CREATE INDEX IF NOT EXISTS idx_orders_user_placed_at
    ON orders(user_id, placed_at DESC);

-- 2. Order items join by order_id
CREATE INDEX IF NOT EXISTS idx_order_items_order_id
    ON order_items(order_id);

-- 3. Merchant orders lookup filtered by status
CREATE INDEX IF NOT EXISTS idx_orders_merchant_status
    ON orders(merchant_id, status);

-- 4. Delivery trips lookup by order and trip status
CREATE INDEX IF NOT EXISTS idx_delivery_trips_order_status
    ON delivery_trips(order_id, status);

-- 5. Store inventory composite lookup for high-frequency checkout reservation
CREATE INDEX IF NOT EXISTS idx_store_inventory_lookup
    ON store_inventory(merchant_id, product_id);

-- 6. Catalog products search by category and name
CREATE INDEX IF NOT EXISTS idx_products_category_name
    ON products(category, name);

-- 7. Payment intents lookup by order_id and status
CREATE INDEX IF NOT EXISTS idx_payment_intents_order_status
    ON payment_intents(order_id, status);

-- 8. Refunds lookup by order_id and status
CREATE INDEX IF NOT EXISTS idx_refunds_order_status
    ON refunds(order_id, status);

-- 9. Outbox queue depth and backpressure monitoring index
CREATE INDEX IF NOT EXISTS idx_outbox_events_backpressure
    ON outbox_events(status, created_at)
    WHERE status = 'PENDING';
