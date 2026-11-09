import pg from 'pg';
import crypto from 'crypto';
import { getPool, transaction } from '../../database/connection.js';
import { env } from '../../config/env.js';
import {
  InventoryCheckResult,
  InventoryReservation,
  StoreInventoryItem,
  ThresholdUpdateInput,
  MerchantThresholdDefaults,
  StockAlertPayload,
} from './inventoryTypes.js';
import { outboxService } from '../outbox/outboxService.js';

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
   * Evaluates stock alerts and handles episode transitions (low stock and out of stock).
   * Runs strictly within the active PostgreSQL transaction under row-level lock.
   */
  public async evaluateAndTriggerStockAlerts(
    merchantId: string,
    productId: string,
    client: pg.PoolClient
  ): Promise<void> {
    // 1. Lock store_inventory row FOR UPDATE
    const invRes = await client.query(`
      SELECT stock_count, reserved_count, low_stock_threshold, scarce_stock_threshold,
             low_stock_alert_triggered, out_of_stock_alert_triggered
      FROM store_inventory
      WHERE merchant_id = $1 AND product_id = $2
      FOR UPDATE
    `, [merchantId, productId]);

    if (invRes.rows.length === 0) return;
    const invRow = invRes.rows[0];

    // 2. Fetch merchant defaults
    let defaultLow = 5;
    let defaultScarce = 3;
    try {
      const merchRes = await client.query(`
        SELECT default_low_stock_threshold, default_scarce_stock_threshold
        FROM merchants
        WHERE id = $1
      `, [merchantId]);
      if (merchRes.rows.length > 0) {
        if (merchRes.rows[0].default_low_stock_threshold !== undefined && merchRes.rows[0].default_low_stock_threshold !== null) {
          defaultLow = Number(merchRes.rows[0].default_low_stock_threshold);
        }
        if (merchRes.rows[0].default_scarce_stock_threshold !== undefined && merchRes.rows[0].default_scarce_stock_threshold !== null) {
          defaultScarce = Number(merchRes.rows[0].default_scarce_stock_threshold);
        }
      }
    } catch {}

    // 3. Fetch product details
    let productName = 'Hardware Item';
    let sku = 'SKU';
    try {
      const prodRes = await client.query(`
        SELECT name, sku FROM products WHERE id = $1
      `, [productId]);
      if (prodRes.rows.length > 0) {
        productName = prodRes.rows[0].name;
        sku = prodRes.rows[0].sku;
      }
    } catch {}

    const physicalStock = Number(invRow.stock_count);
    const reservedStock = Number(invRow.reserved_count || 0);
    const availableStock = Math.max(0, physicalStock - reservedStock);

    const effectiveLowThreshold = invRow.low_stock_threshold !== undefined && invRow.low_stock_threshold !== null
      ? Number(invRow.low_stock_threshold)
      : defaultLow;
    const effectiveScarceThreshold = invRow.scarce_stock_threshold !== undefined && invRow.scarce_stock_threshold !== null
      ? Number(invRow.scarce_stock_threshold)
      : defaultScarce;

    const isLowAlertTriggered = Boolean(invRow.low_stock_alert_triggered);
    const isOosAlertTriggered = Boolean(invRow.out_of_stock_alert_triggered);

    // Episode Reset Rule 1:
    // If available stock is restored/replenished strictly above the low stock threshold,
    // reset both low-stock and out-of-stock alert states so future episodes will trigger new notifications.
    if (availableStock > effectiveLowThreshold) {
      if (isLowAlertTriggered || isOosAlertTriggered) {
        await client.query(`
          UPDATE store_inventory
          SET low_stock_alert_triggered = FALSE,
              out_of_stock_alert_triggered = FALSE,
              updated_at = NOW()
          WHERE merchant_id = $1 AND product_id = $2
        `, [merchantId, productId]);
      }
      return;
    }

    // Episode Reset Rule 2:
    // If available stock is restored above 0 (e.g. 0 -> 2) but remains <= effectiveLowThreshold,
    // reset out_of_stock_alert_triggered so a future drop back to 0 will re-notify out of stock,
    // while keeping low_stock_alert_triggered as TRUE to prevent duplicate low-stock alerts.
    if (availableStock > 0 && isOosAlertTriggered) {
      await client.query(`
        UPDATE store_inventory
        SET out_of_stock_alert_triggered = FALSE,
            updated_at = NOW()
        WHERE merchant_id = $1 AND product_id = $2
      `, [merchantId, productId]);
    }

    // Downward transition 1: Out of Stock (availableStock == 0)
    if (availableStock === 0) {
      if (!isOosAlertTriggered) {
        const timestamp = new Date().toISOString();
        const dedupeKey = `alert_OOS_${merchantId}_${productId}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

        await client.query(`
          UPDATE store_inventory
          SET out_of_stock_alert_triggered = TRUE,
              low_stock_alert_triggered = TRUE,
              last_alert_at = NOW(),
              updated_at = NOW()
          WHERE merchant_id = $1 AND product_id = $2
        `, [merchantId, productId]);

        try {
          await client.query(`
            INSERT INTO seller_stock_alerts (
              merchant_id, product_id, alert_type, available_stock, physical_stock,
              reserved_stock, threshold_value, dedupe_key, metadata, created_at
            ) VALUES ($1, $2, 'OUT_OF_STOCK', $3, $4, $5, $6, $7, $8, NOW())
          `, [
            merchantId,
            productId,
            0,
            physicalStock,
            reservedStock,
            effectiveLowThreshold,
            dedupeKey,
            JSON.stringify({ sku, productName, effectiveLowThreshold, effectiveScarceThreshold })
          ]);
        } catch {}

        const payload: StockAlertPayload = {
          merchantId,
          productId,
          productName,
          sku,
          availableStock: 0,
          physicalStock,
          reservedStock,
          threshold: effectiveLowThreshold,
          alertType: 'OUT_OF_STOCK',
          timestamp,
        };

        await outboxService.stageEvent(client, {
          eventType: 'INVENTORY_OUT_OF_STOCK',
          aggregateType: 'INVENTORY',
          aggregateId: productId,
          payload,
        });
      }
      return;
    }

    // Downward transition 2: Low Stock (0 < availableStock <= effectiveLowThreshold)
    if (availableStock <= effectiveLowThreshold && availableStock > 0) {
      if (!isLowAlertTriggered) {
        const timestamp = new Date().toISOString();
        const dedupeKey = `alert_LOW_${merchantId}_${productId}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

        await client.query(`
          UPDATE store_inventory
          SET low_stock_alert_triggered = TRUE,
              last_alert_at = NOW(),
              updated_at = NOW()
          WHERE merchant_id = $1 AND product_id = $2
        `, [merchantId, productId]);

        try {
          await client.query(`
            INSERT INTO seller_stock_alerts (
              merchant_id, product_id, alert_type, available_stock, physical_stock,
              reserved_stock, threshold_value, dedupe_key, metadata, created_at
            ) VALUES ($1, $2, 'LOW_STOCK', $3, $4, $5, $6, $7, $8, NOW())
          `, [
            merchantId,
            productId,
            availableStock,
            physicalStock,
            reservedStock,
            effectiveLowThreshold,
            dedupeKey,
            JSON.stringify({ sku, productName, effectiveLowThreshold, effectiveScarceThreshold })
          ]);
        } catch {}

        const payload: StockAlertPayload = {
          merchantId,
          productId,
          productName,
          sku,
          availableStock,
          physicalStock,
          reservedStock,
          threshold: effectiveLowThreshold,
          alertType: 'LOW_STOCK',
          timestamp,
        };

        await outboxService.stageEvent(client, {
          eventType: 'INVENTORY_LOW_STOCK',
          aggregateType: 'INVENTORY',
          aggregateId: productId,
          payload,
        });
      }
    }
  }

  /**
   * Transactional stock reservation with expiration window (e.g., 15 minutes)
   */
  public async reserveStock(
    orderId: string,
    merchantId: string,
    items: { productId: string; quantity: number }[],
    durationMinutes: number = env.RESERVATION_TTL_MINUTES,
    clientOverride?: pg.PoolClient
  ): Promise<InventoryReservation[]> {
    const execute = async (client: pg.PoolClient) => {
      const reservations: InventoryReservation[] = [];
      const expiresAt = new Date(Date.now() + durationMinutes * 60 * 1000);

      // Deterministically sort items by productId ASC to eliminate PostgreSQL deadlock (40P01)
      const sortedItems = [...items].sort((a, b) => a.productId.localeCompare(b.productId));

      for (const item of sortedItems) {
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
          throw new Error(`INSUFFICIENT_STOCK: Requested ${item.quantity} units for product '${item.productId}', but only ${Math.max(0, available)} units available. Please reduce quantity or remove item.`);
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

        // Trigger stock alert evaluation on reservation
        await this.evaluateAndTriggerStockAlerts(merchantId, item.productId, client);
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
        FOR UPDATE
      `, [orderId]);

      if (res.rows.length === 0) {
        return;
      }

      const sortedRows = [...res.rows].sort((a, b) => a.product_id.localeCompare(b.product_id));
      for (const row of sortedRows) {
        const qty = Number(row.quantity);
        await client.query(`
          UPDATE store_inventory
          SET stock_count = GREATEST(0, stock_count - $3::int),
              reserved_count = GREATEST(0, reserved_count - $3::int),
              updated_at = NOW()
          WHERE merchant_id = $1 AND product_id = $2
        `, [row.merchant_id, row.product_id, qty]);

        await this.evaluateAndTriggerStockAlerts(row.merchant_id, row.product_id, client);
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
        FOR UPDATE
      `, [orderId]);

      if (res.rows.length === 0) {
        return;
      }

      const sortedRows = [...res.rows].sort((a, b) => a.product_id.localeCompare(b.product_id));
      for (const row of sortedRows) {
        const qty = Number(row.quantity);
        await client.query(`
          UPDATE store_inventory
          SET reserved_count = GREATEST(0, reserved_count - $3::int),
              updated_at = NOW()
          WHERE merchant_id = $1 AND product_id = $2
        `, [row.merchant_id, row.product_id, qty]);

        await this.evaluateAndTriggerStockAlerts(row.merchant_id, row.product_id, client);
      }

      await client.query(`
        UPDATE inventory_reservations
        SET status = 'RELEASED', updated_at = NOW()
        WHERE order_id = $1 AND status = 'RESERVED'
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
        FOR UPDATE
      `, [orderId]);

      if (res.rows.length > 0) {
        const sortedRows = [...res.rows].sort((a, b) => a.product_id.localeCompare(b.product_id));
        for (const row of sortedRows) {
          const qty = Number(row.quantity);
          await client.query(`
            UPDATE store_inventory
            SET stock_count = stock_count + $3::int,
                updated_at = NOW()
            WHERE merchant_id = $1 AND product_id = $2
          `, [row.merchant_id, row.product_id, qty]);

          await this.evaluateAndTriggerStockAlerts(row.merchant_id, row.product_id, client);
        }

        await client.query(`
          UPDATE inventory_reservations
          SET status = 'RELEASED', updated_at = NOW()
          WHERE order_id = $1 AND status = 'COMMITTED'
        `, [orderId]);
      } else {
        // Fallback: ONLY restock from order_items if:
        // 1. No reservation records exist at all (untracked legacy orders)
        // 2. Order was actually paid or COD placed
        // 3. Order is not already cancelled (prevents duplicate restocking)
        const checkAnyRes = await client.query(
          `SELECT id FROM inventory_reservations WHERE order_id = $1 LIMIT 1`,
          [orderId]
        );
        if (checkAnyRes.rows.length === 0) {
          const orderCheck = await client.query(
            `SELECT payment_status, payment_method, status FROM orders WHERE id = $1`,
            [orderId]
          );
          const ord = orderCheck.rows[0];
          if (ord && ord.status !== 'cancelled' && (ord.payment_status === 'PAID' || ord.payment_method === 'Pay on Delivery')) {
            const itemRes = await client.query(`
              SELECT o.merchant_id, oi.product_id, oi.quantity
              FROM order_items oi
              JOIN orders o ON oi.order_id = o.id
              WHERE oi.order_id = $1
            `, [orderId]);

            const sortedItems = [...itemRes.rows].sort((a, b) => a.product_id.localeCompare(b.product_id));
            for (const row of sortedItems) {
              const qty = Number(row.quantity);
              await client.query(`
                UPDATE store_inventory
                SET stock_count = stock_count + $3::int,
                    updated_at = NOW()
                WHERE merchant_id = $1 AND product_id = $2
              `, [row.merchant_id, row.product_id, qty]);

              await this.evaluateAndTriggerStockAlerts(row.merchant_id, row.product_id, client);
            }
          }
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

      await this.evaluateAndTriggerStockAlerts(merchantId, productId, client);
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
      let candidates;
      try {
        candidates = await client.query(`
          SELECT id, order_id, merchant_id, product_id, quantity, expires_at
          FROM inventory_reservations
          WHERE status = 'RESERVED' AND expires_at < NOW()
          ORDER BY expires_at ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED
        `, [batchSize]);
      } catch {
        candidates = await client.query(`
          SELECT id, order_id, merchant_id, product_id, quantity, expires_at
          FROM inventory_reservations
          WHERE status = 'RESERVED' AND expires_at < NOW()
          ORDER BY expires_at ASC
          LIMIT $1
          FOR UPDATE
        `, [batchSize]);
      }

      if (candidates.rows.length === 0) {
        return { reapedOrdersCount: 0, releasedItemsCount: 0 };
      }

      let releasedItemsCount = 0;
      const ordersProcessed = new Set<string>();

      for (const resRow of candidates.rows) {
        const orderId = resRow.order_id;
        ordersProcessed.add(orderId);

        // Verify order status
        const orderCheck = await client.query(`
          SELECT id, status, payment_status, payment_method
          FROM orders
          WHERE id = $1
        `, [orderId]);
        const order = orderCheck.rows[0];

        // If order exists and is confirmed/paid, commit reservation rather than release
        if (order && (order.status === 'CONFIRMED' || order.status === 'PAID' || order.payment_status === 'PAID' || order.payment_method === 'Pay on Delivery')) {
          await client.query(`
            UPDATE store_inventory
            SET stock_count = GREATEST(0, stock_count - $3::int),
                reserved_count = GREATEST(0, reserved_count - $3::int),
                updated_at = NOW()
            WHERE merchant_id = $1 AND product_id = $2
          `, [resRow.merchant_id, resRow.product_id, Number(resRow.quantity)]);

          await client.query(`
            UPDATE inventory_reservations
            SET status = 'COMMITTED', updated_at = NOW()
            WHERE id = $1 AND status = 'RESERVED'
          `, [resRow.id]);

          await this.evaluateAndTriggerStockAlerts(resRow.merchant_id, resRow.product_id, client);
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

        // If order was in 'placed' or 'pending' status and payment pending, cancel order and invalidate active payment intents
        const orderStatusLower = (order?.status || '').toLowerCase();
        if (order && orderStatusLower !== 'cancelled' && order.payment_status === 'PENDING') {
          await client.query(`
            UPDATE orders
            SET status = 'cancelled',
                cancellation_reason = 'Payment reservation window expired',
                updated_at = NOW()
            WHERE id = $1 AND payment_status = 'PENDING'
          `, [orderId]);

          await client.query(`
            UPDATE payment_intents
            SET status = 'CANCELLED', updated_at = NOW()
            WHERE order_id = $1 AND status IN ('CREATED', 'PENDING', 'AUTHORIZED')
          `, [orderId]);
        }

        await this.evaluateAndTriggerStockAlerts(resRow.merchant_id, resRow.product_id, client);
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

  /**
   * Fetches store inventory with calculated available_to_sell, thresholds, and alert flags.
   */
  public async getStoreInventory(
    merchantId: string,
    clientOverride?: pg.PoolClient
  ): Promise<StoreInventoryItem[]> {
    const runner = clientOverride || getPool();
    const res = await runner.query(`
      SELECT si.id, si.merchant_id, si.product_id, si.selling_price,
             si.stock_count, si.reserved_count,
             GREATEST(0, si.stock_count - si.reserved_count) as available_to_sell,
             si.low_stock_threshold, si.scarce_stock_threshold,
             COALESCE(si.low_stock_threshold, m.default_low_stock_threshold, 5) as effective_low_stock_threshold,
             COALESCE(si.scarce_stock_threshold, m.default_scarce_stock_threshold, 3) as effective_scarce_stock_threshold,
             si.low_stock_alert_triggered, si.out_of_stock_alert_triggered,
             si.last_alert_at, si.updated_at,
             p.name as product_name, p.sku, p.category, p.hsn_code
      FROM store_inventory si
      JOIN merchants m ON m.id = si.merchant_id
      JOIN products p ON p.id = si.product_id
      WHERE si.merchant_id = $1
      ORDER BY p.name ASC
    `, [merchantId]);

    return res.rows.map(row => {
      const stockCount = Number(row.stock_count);
      const reservedCount = Number(row.reserved_count || 0);
      const availableToSell = Math.max(0, stockCount - reservedCount);
      const effectiveLow = Number(row.effective_low_stock_threshold);
      const effectiveScarce = Number(row.effective_scarce_stock_threshold);

      return {
        id: row.id,
        merchantId: row.merchant_id,
        productId: row.product_id,
        productName: row.product_name,
        sku: row.sku,
        category: row.category,
        hsnCode: row.hsn_code,
        sellingPrice: parseFloat(row.selling_price),
        stockCount,
        reservedCount,
        availableToSell,
        lowStockThreshold: Number(row.low_stock_threshold),
        scarceStockThreshold: Number(row.scarce_stock_threshold || 3),
        effectiveLowStockThreshold: effectiveLow,
        effectiveScarceStockThreshold: effectiveScarce,
        lowStockStatus: availableToSell <= effectiveLow && availableToSell > 0,
        outOfStockStatus: availableToSell === 0,
        isScarce: availableToSell <= effectiveScarce,
        lowStockAlertTriggered: Boolean(row.low_stock_alert_triggered),
        outOfStockAlertTriggered: Boolean(row.out_of_stock_alert_triggered),
        lastAlertAt: row.last_alert_at ? (row.last_alert_at instanceof Date ? row.last_alert_at.toISOString() : row.last_alert_at) : null,
        updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
      };
    });
  }

  /**
   * Updates product-level threshold configurations (non-negative integers only).
   */
  public async updateProductThresholds(
    merchantId: string,
    productId: string,
    input: ThresholdUpdateInput,
    clientOverride?: pg.PoolClient
  ): Promise<StoreInventoryItem> {
    const execute = async (client: pg.PoolClient) => {
      if (input.lowStockThreshold !== undefined) {
        if (!Number.isInteger(input.lowStockThreshold) || input.lowStockThreshold < 0) {
          throw new Error('VALIDATION_ERROR: lowStockThreshold must be a non-negative integer.');
        }
      }
      if (input.scarceStockThreshold !== undefined) {
        if (!Number.isInteger(input.scarceStockThreshold) || input.scarceStockThreshold < 0) {
          throw new Error('VALIDATION_ERROR: scarceStockThreshold must be a non-negative integer.');
        }
      }

      const checkRes = await client.query(`
        SELECT id FROM store_inventory WHERE merchant_id = $1 AND product_id = $2 FOR UPDATE
      `, [merchantId, productId]);

      if (checkRes.rows.length === 0) {
        throw new Error(`NOT_FOUND: Product '${productId}' does not exist in store inventory for merchant '${merchantId}'.`);
      }

      const updates: string[] = ['updated_at = NOW()'];
      const params: any[] = [merchantId, productId];
      let pIdx = 3;

      if (input.lowStockThreshold !== undefined) {
        updates.push(`low_stock_threshold = $${pIdx++}`);
        params.push(input.lowStockThreshold);
      }
      if (input.scarceStockThreshold !== undefined) {
        updates.push(`scarce_stock_threshold = $${pIdx++}`);
        params.push(input.scarceStockThreshold);
      }

      await client.query(`
        UPDATE store_inventory
        SET ${updates.join(', ')}
        WHERE merchant_id = $1 AND product_id = $2
      `, params);

      // Re-evaluate stock alerts under new threshold
      await this.evaluateAndTriggerStockAlerts(merchantId, productId, client);

      const items = await this.getStoreInventory(merchantId, client);
      const found = items.find(i => i.productId === productId);
      if (!found) {
        throw new Error('Failed to retrieve updated inventory item.');
      }
      return found;
    };

    if (clientOverride) return execute(clientOverride);
    return transaction(execute);
  }

  /**
   * Updates merchant-level default stock thresholds (non-negative integers only).
   */
  public async updateMerchantThresholdDefaults(
    merchantId: string,
    input: MerchantThresholdDefaults,
    clientOverride?: pg.PoolClient
  ): Promise<MerchantThresholdDefaults> {
    const execute = async (client: pg.PoolClient) => {
      if (input.defaultLowStockThreshold !== undefined) {
        if (!Number.isInteger(input.defaultLowStockThreshold) || input.defaultLowStockThreshold < 0) {
          throw new Error('VALIDATION_ERROR: defaultLowStockThreshold must be a non-negative integer.');
        }
      }
      if (input.defaultScarceStockThreshold !== undefined) {
        if (!Number.isInteger(input.defaultScarceStockThreshold) || input.defaultScarceStockThreshold < 0) {
          throw new Error('VALIDATION_ERROR: defaultScarceStockThreshold must be a non-negative integer.');
        }
      }

      const updates: string[] = ['updated_at = NOW()'];
      const params: any[] = [merchantId];
      let pIdx = 2;

      if (input.defaultLowStockThreshold !== undefined) {
        updates.push(`default_low_stock_threshold = $${pIdx++}`);
        params.push(input.defaultLowStockThreshold);
      }
      if (input.defaultScarceStockThreshold !== undefined) {
        updates.push(`default_scarce_stock_threshold = $${pIdx++}`);
        params.push(input.defaultScarceStockThreshold);
      }

      const res = await client.query(`
        UPDATE merchants
        SET ${updates.join(', ')}
        WHERE id = $1
        RETURNING default_low_stock_threshold, default_scarce_stock_threshold
      `, params);

      if (res.rows.length === 0) {
        throw new Error(`NOT_FOUND: Merchant '${merchantId}' not found.`);
      }

      return {
        defaultLowStockThreshold: Number(res.rows[0].default_low_stock_threshold),
        defaultScarceStockThreshold: Number(res.rows[0].default_scarce_stock_threshold),
      };
    };

    if (clientOverride) return execute(clientOverride);
    return transaction(execute);
  }

  /**
   * Adds stock to store inventory (restock) and triggers alert reset evaluation.
   */
  public async restockInventory(
    merchantId: string,
    productId: string,
    additionalStock: number,
    clientOverride?: pg.PoolClient
  ): Promise<void> {
    if (!Number.isInteger(additionalStock) || additionalStock <= 0) {
      throw new Error('VALIDATION_ERROR: additionalStock must be a positive integer.');
    }
    const execute = async (client: pg.PoolClient) => {
      const checkRes = await client.query(`
        SELECT id FROM store_inventory WHERE merchant_id = $1 AND product_id = $2 FOR UPDATE
      `, [merchantId, productId]);

      if (checkRes.rows.length === 0) {
        throw new Error(`NOT_FOUND: Product '${productId}' does not exist in store inventory for merchant '${merchantId}'.`);
      }

      await client.query(`
        UPDATE store_inventory
        SET stock_count = stock_count + $3::int,
            updated_at = NOW()
        WHERE merchant_id = $1 AND product_id = $2
      `, [merchantId, productId, additionalStock]);

      // Re-evaluate stock alerts (will reset alert flags if above thresholds)
      await this.evaluateAndTriggerStockAlerts(merchantId, productId, client);
    };

    if (clientOverride) return execute(clientOverride);
    return transaction(execute);
  }

  /**
   * Retrieves seller stock alerts history / in-app alert log
   */
  public async getSellerStockAlerts(
    merchantId: string,
    options?: { limit?: number; offset?: number; isRead?: boolean },
    clientOverride?: pg.PoolClient
  ): Promise<any[]> {
    const runner = clientOverride || getPool();
    const limit = options?.limit || 50;
    const offset = options?.offset || 0;
    let query = `
      SELECT a.*, p.name as product_name, p.sku
      FROM seller_stock_alerts a
      JOIN products p ON p.id = a.product_id
      WHERE a.merchant_id = $1
    `;
    const params: any[] = [merchantId];
    if (options?.isRead !== undefined) {
      params.push(options.isRead);
      query += ` AND a.is_read = $${params.length}`;
    }
    query += ` ORDER BY a.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const res = await runner.query(query, params);
    return res.rows.map(row => ({
      id: row.id,
      merchantId: row.merchant_id,
      productId: row.product_id,
      productName: row.product_name,
      sku: row.sku,
      alertType: row.alert_type,
      availableStock: Number(row.available_stock),
      physicalStock: Number(row.physical_stock),
      reservedStock: Number(row.reserved_stock),
      thresholdValue: Number(row.threshold_value),
      dedupeKey: row.dedupe_key,
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
      isRead: Boolean(row.is_read),
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    }));
  }

  /**
   * Marks a seller stock alert as read
   */
  public async markStockAlertRead(
    merchantId: string,
    alertId: string,
    clientOverride?: pg.PoolClient
  ): Promise<boolean> {
    const runner = clientOverride || getPool();
    const res = await runner.query(`
      UPDATE seller_stock_alerts
      SET is_read = TRUE
      WHERE id = $1 AND merchant_id = $2
      RETURNING id
    `, [alertId, merchantId]);
    return res.rows.length > 0;
  }

  /**
   * Resolves effective thresholds and stock scarcity status
   */
  public async getEffectiveThresholds(
    merchantId: string,
    productId: string,
    clientOverride?: pg.PoolClient
  ): Promise<{
    effectiveLowStockThreshold: number;
    effectiveScarceStockThreshold: number;
    isScarce: boolean;
    isLowStock: boolean;
    isOutOfStock: boolean;
    availableToSell: number;
  }> {
    const runner = clientOverride || getPool();
    const res = await runner.query(`
      SELECT si.stock_count, si.reserved_count, si.low_stock_threshold, si.scarce_stock_threshold,
             m.default_low_stock_threshold, m.default_scarce_stock_threshold
      FROM store_inventory si
      JOIN merchants m ON m.id = si.merchant_id
      WHERE si.merchant_id = $1 AND si.product_id = $2
    `, [merchantId, productId]);

    if (res.rows.length === 0) {
      throw new Error(`NOT_FOUND: Product '${productId}' not found in inventory.`);
    }

    const row = res.rows[0];
    const available = Math.max(0, Number(row.stock_count) - Number(row.reserved_count || 0));
    const effectiveLow = Number(row.low_stock_threshold ?? row.default_low_stock_threshold ?? 5);
    const effectiveScarce = Number(row.scarce_stock_threshold ?? row.default_scarce_stock_threshold ?? 3);

    return {
      effectiveLowStockThreshold: effectiveLow,
      effectiveScarceStockThreshold: effectiveScarce,
      isScarce: available <= effectiveScarce,
      isLowStock: available <= effectiveLow && available > 0,
      isOutOfStock: available === 0,
      availableToSell: available,
    };
  }

  /**
   * Checks if an inventory item has scarce stock based on effective threshold
   */
  public async isStockScarce(
    merchantId: string,
    productId: string,
    clientOverride?: pg.PoolClient
  ): Promise<boolean> {
    const result = await this.getEffectiveThresholds(merchantId, productId, clientOverride);
    return result.isScarce;
  }
}

export const inventoryService = new InventoryService();
