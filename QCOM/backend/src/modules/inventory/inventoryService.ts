import pg from 'pg';
import { getPool, transaction } from '../../database/connection.js';
import { InventoryCheckResult, InventoryReservation } from './inventoryTypes.js';

export class InventoryService {
  /**
   * Concurrency-safe stock verification across store items
   */
  public async checkAvailability(
    merchantId: string,
    items: { productId: string; quantity: number }[],
    client?: pg.PoolClient | pg.Pool
  ): Promise<InventoryCheckResult> {
    const runner = client || getPool();
    const unavailableItems: { productId: string; requestedQuantity: number; availableStock: number }[] = [];

    for (const item of items) {
      const res = await runner.query(`
        SELECT stock_count, reserved_count
        FROM store_inventory
        WHERE merchant_id = $1 AND product_id = $2
        LIMIT 1
      `, [merchantId, item.productId]);

      const available = res.rows.length > 0 ? (Number(res.rows[0].stock_count) - Number(res.rows[0].reserved_count || 0)) : 0;
      if (available < item.quantity) {
        unavailableItems.push({
          productId: item.productId,
          requestedQuantity: item.quantity,
          availableStock: Math.max(0, available),
        });
      }
    }

    return {
      isAvailable: unavailableItems.length === 0,
      unavailableItems,
    };
  }

  /**
   * Transactional stock reservation with expiration window (e.g., 15 minutes)
   */
  public async reserveStock(
    orderId: string,
    merchantId: string,
    items: { productId: string; quantity: number }[],
    durationMinutes: number = 15,
    clientOverride?: pg.PoolClient
  ): Promise<InventoryReservation[]> {
    const execute = async (client: pg.PoolClient) => {
      const reservations: InventoryReservation[] = [];
      const expiresAt = new Date(Date.now() + durationMinutes * 60 * 1000);

      for (const item of items) {
        // Row-level lock on store_inventory
        const checkRes = await client.query(`
          SELECT id, stock_count, reserved_count
          FROM store_inventory
          WHERE merchant_id = $1 AND product_id = $2
          FOR UPDATE
        `, [merchantId, item.productId]);

        if (checkRes.rows.length === 0) {
          throw new Error(`INVENTORY_NOT_FOUND: Product '${item.productId}' does not exist in store inventory for merchant '${merchantId}'.`);
        }

        const stockCount = Number(checkRes.rows[0].stock_count);
        const reservedCount = Number(checkRes.rows[0].reserved_count || 0);
        const available = stockCount - reservedCount;

        if (available < item.quantity) {
          throw new Error(`INSUFFICIENT_STOCK: Requested ${item.quantity} units for product '${item.productId}', but only ${Math.max(0, available)} units available.`);
        }

        // Increment reserved count
        await client.query(`
          UPDATE store_inventory
          SET reserved_count = reserved_count + $3, updated_at = NOW()
          WHERE merchant_id = $1 AND product_id = $2
        `, [merchantId, item.productId, item.quantity]);

        // Insert reservation record
        const resIns = await client.query(`
          INSERT INTO inventory_reservations (order_id, merchant_id, product_id, quantity, status, expires_at)
          VALUES ($1, $2, $3, $4, 'RESERVED', $5)
          RETURNING id, order_id, merchant_id, product_id, quantity, status, expires_at, created_at
        `, [orderId, merchantId, item.productId, item.quantity, expiresAt]);

        const r = resIns.rows[0];
        reservations.push({
          id: r.id,
          orderId: r.order_id,
          merchantId: r.merchant_id,
          productId: r.product_id,
          quantity: r.quantity,
          status: r.status,
          expiresAt: r.expires_at.toISOString(),
          createdAt: r.created_at.toISOString(),
        });
      }

      return reservations;
    };

    if (clientOverride) {
      return execute(clientOverride);
    }
    return transaction(execute);
  }

  /**
   * Commits reserved stock upon successful payment / order placement
   */
  public async commitStock(orderId: string, clientOverride?: pg.PoolClient): Promise<void> {
    const execute = async (client: pg.PoolClient) => {
      const res = await client.query(`
        SELECT merchant_id, product_id, quantity
        FROM inventory_reservations
        WHERE order_id = $1 AND status = 'RESERVED'
      `, [orderId]);

      for (const row of res.rows) {
        const qty = Number(row.quantity);
        await client.query(`
          UPDATE store_inventory
          SET stock_count = GREATEST(0, stock_count - $3::int),
              reserved_count = GREATEST(0, reserved_count - $3::int),
              updated_at = NOW()
          WHERE merchant_id = $1 AND product_id = $2
        `, [row.merchant_id, row.product_id, qty]);
      }

      await client.query(`
        UPDATE inventory_reservations
        SET status = 'COMMITTED', updated_at = NOW()
        WHERE order_id = $1 AND status = 'RESERVED'
      `, [orderId]);
    };

    if (clientOverride) {
      return execute(clientOverride);
    }
    return transaction(execute);
  }

  /**
   * Releases reserved stock back to store inventory upon cancellation or timeout
   */
  public async releaseStock(orderId: string, clientOverride?: pg.PoolClient): Promise<void> {
    const execute = async (client: pg.PoolClient) => {
      const res = await client.query(`
        SELECT merchant_id, product_id, quantity
        FROM inventory_reservations
        WHERE order_id = $1 AND status = 'RESERVED'
      `, [orderId]);

      for (const row of res.rows) {
        const qty = Number(row.quantity);
        await client.query(`
          UPDATE store_inventory
          SET reserved_count = GREATEST(0, reserved_count - $3::int),
              updated_at = NOW()
          WHERE merchant_id = $1 AND product_id = $2
        `, [row.merchant_id, row.product_id, qty]);
      }

      await client.query(`
        UPDATE inventory_reservations
        SET status = 'RELEASED', updated_at = NOW()
        WHERE order_id = $1
      `, [orderId]);
    };

    if (clientOverride) {
      return execute(clientOverride);
    }
    return transaction(execute);
  }

  /**
   * Restocks committed stock back to store inventory upon post-payment order cancellation
   */
  public async restockCommittedStock(orderId: string, clientOverride?: pg.PoolClient): Promise<void> {
    const execute = async (client: pg.PoolClient) => {
      // Check if we have COMMITTED inventory reservations
      const res = await client.query(`
        SELECT merchant_id, product_id, quantity
        FROM inventory_reservations
        WHERE order_id = $1 AND status = 'COMMITTED'
      `, [orderId]);

      if (res.rows.length > 0) {
        for (const row of res.rows) {
          const qty = Number(row.quantity);
          await client.query(`
            UPDATE store_inventory
            SET stock_count = stock_count + $3::int,
                updated_at = NOW()
            WHERE merchant_id = $1 AND product_id = $2
          `, [row.merchant_id, row.product_id, qty]);
        }

        await client.query(`
          UPDATE inventory_reservations
          SET status = 'RELEASED', updated_at = NOW()
          WHERE order_id = $1 AND status = 'COMMITTED'
        `, [orderId]);
      } else {
        // Fallback: restock from order_items and orders.merchant_id if reservations were not tracked
        const itemRes = await client.query(`
          SELECT o.merchant_id, oi.product_id, oi.quantity
          FROM order_items oi
          JOIN orders o ON oi.order_id = o.id
          WHERE oi.order_id = $1
        `, [orderId]);

        for (const row of itemRes.rows) {
          const qty = Number(row.quantity);
          await client.query(`
            UPDATE store_inventory
            SET stock_count = stock_count + $3::int,
                updated_at = NOW()
            WHERE merchant_id = $1 AND product_id = $2
          `, [row.merchant_id, row.product_id, qty]);
        }
      }
    };

    if (clientOverride) {
      return execute(clientOverride);
    }
    return transaction(execute);
  }

  /**
   * Restores verified return quantity back into store inventory
   */
  public async restockItem(
    merchantId: string,
    productId: string,
    quantity: number,
    clientOverride?: pg.PoolClient
  ): Promise<void> {
    const execute = async (client: pg.PoolClient) => {
      await client.query(`
        UPDATE store_inventory
        SET stock_count = stock_count + $3::int,
            updated_at = NOW()
        WHERE merchant_id = $1 AND product_id = $2
      `, [merchantId, productId, quantity]);
    };

    if (clientOverride) {
      return execute(clientOverride);
    }
    return transaction(execute);
  }

  /**
   * Reaps expired inventory reservations in bounded batches.
   * Concurrently safe across multiple worker processes using FOR UPDATE SKIP LOCKED.
   * Only releases reservations whose associated order is NOT confirmed/paid.
   */
  public async reapExpiredReservations(
    batchSize: number = 50,
    clientOverride?: pg.PoolClient
  ): Promise<{ reapedOrdersCount: number; releasedItemsCount: number }> {
    const execute = async (client: pg.PoolClient) => {
      // Find candidate expired reservations that are still in 'RESERVED' state
      const candidates = await client.query(`
        SELECT id, order_id, merchant_id, product_id, quantity, expires_at
        FROM inventory_reservations
        WHERE status = 'RESERVED' AND expires_at < NOW()
        ORDER BY expires_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      `, [batchSize]);

      if (candidates.rows.length === 0) {
        return { reapedOrdersCount: 0, releasedItemsCount: 0 };
      }

      let releasedItemsCount = 0;
      const ordersProcessed = new Set<string>();

      for (const resRow of candidates.rows) {
        const orderId = resRow.order_id;
        ordersProcessed.add(orderId);

        // Verify that the order is not confirmed, paid, or fulfilled
        const orderCheck = await client.query(`
          SELECT id, status, payment_status
          FROM orders
          WHERE id = $1
        `, [orderId]);

        const order = orderCheck.rows[0];
        // If order exists and is confirmed/paid, commit reservation rather than release
        if (order && (order.status === 'CONFIRMED' || order.status === 'PAID' || order.payment_status === 'PAID')) {
          await client.query(`
            UPDATE inventory_reservations
            SET status = 'COMMITTED', updated_at = NOW()
            WHERE id = $1 AND status = 'RESERVED'
          `, [resRow.id]);
          continue;
        }

        // Release reserved stock back to store_inventory
        const qty = Number(resRow.quantity);
        await client.query(`
          UPDATE store_inventory
          SET reserved_count = GREATEST(0, reserved_count - $3::int),
              updated_at = NOW()
          WHERE merchant_id = $1 AND product_id = $2
        `, [resRow.merchant_id, resRow.product_id, qty]);

        // Mark reservation as RELEASED
        await client.query(`
          UPDATE inventory_reservations
          SET status = 'RELEASED', updated_at = NOW()
          WHERE id = $1 AND status = 'RESERVED'
        `, [resRow.id]);

        releasedItemsCount++;
      }

      return {
        reapedOrdersCount: ordersProcessed.size,
        releasedItemsCount,
      };
    };

    if (clientOverride) {
      return execute(clientOverride);
    }
    return transaction(execute);
  }
}

export const inventoryService = new InventoryService();
