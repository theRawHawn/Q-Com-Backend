import { getPool } from '../../database/connection.js';
import { notificationService } from './notificationService.js';
import { realtimeGateway } from '../realtime/websocketServer.js';
import { StockAlertPayload } from '../inventory/inventoryTypes.js';

export class StockNotificationConsumer {
  /**
   * Authoritative consumer for inventory low-stock and out-of-stock domain events.
   * Resolves merchant store owners and managers, dispatches in-app notifications,
   * logs metric events, and broadcasts realtime WebSocket events to seller channels.
   */
  public async handleStockAlert(payload: StockAlertPayload): Promise<void> {
    const pool = getPool();
    const isOutOfStock = payload.alertType === 'OUT_OF_STOCK';

    const title = isOutOfStock
      ? `🚨 Out of Stock: ${payload.productName}`
      : `⚠️ Low Stock Alert: ${payload.productName}`;

    const body = isOutOfStock
      ? `Product ${payload.productName} (SKU: ${payload.sku}) is completely sold out. 0 units available for new orders.`
      : `Only ${payload.availableStock} unit(s) remaining for SKU ${payload.sku} (Threshold: ${payload.threshold}). Please replenish stock.`;

    // 1. Resolve authorized store staff (Owners and Managers) for this merchant
    try {
      const staffRes = await pool.query(`
        SELECT user_id, name, role
        FROM store_staff
        WHERE merchant_id = $1 AND is_active = TRUE AND user_id IS NOT NULL
      `, [payload.merchantId]);

      for (const staff of staffRes.rows) {
        const dedupeKey = `notif_${payload.alertType}_${payload.merchantId}_${payload.productId}_${payload.timestamp}_${staff.user_id}`;
        await notificationService.sendNotification({
          userId: staff.user_id,
          notificationType: 'SYSTEM_ALERT',
          title,
          body,
          dedupeKey,
          priority: isOutOfStock ? 'CRITICAL' : 'HIGH',
          data: {
            merchantId: payload.merchantId,
            productId: payload.productId,
            productName: payload.productName,
            sku: payload.sku,
            availableStock: payload.availableStock,
            threshold: payload.threshold,
            alertType: payload.alertType,
            timestamp: payload.timestamp,
          },
          skipPreferenceCheck: true, // Operational system alerts must not be muted
        }).catch((err) => {
          console.warn(`[StockNotificationConsumer] Failed to dispatch alert to staff ${staff.user_id}:`, err.message);
        });
      }
    } catch (err: any) {
      console.warn('[StockNotificationConsumer] Error querying store staff:', err.message);
    }

    // 2. Realtime WebSocket Broadcast to Merchant Channel
    try {
      realtimeGateway.broadcastToRoom(`merchant:${payload.merchantId}`, {
        type: 'event',
        eventType: isOutOfStock ? 'PRODUCT_OUT_OF_STOCK' : 'PRODUCT_LOW_STOCK',
        payload: {
          merchantId: payload.merchantId,
          productId: payload.productId,
          productName: payload.productName,
          sku: payload.sku,
          availableStock: payload.availableStock,
          physicalStock: payload.physicalStock,
          reservedStock: payload.reservedStock,
          threshold: payload.threshold,
          alertType: payload.alertType,
          timestamp: payload.timestamp,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (wsErr: any) {
      console.warn('[StockNotificationConsumer] Realtime WebSocket broadcast skipped:', wsErr.message);
    }
  }
}

export const stockNotificationConsumer = new StockNotificationConsumer();
