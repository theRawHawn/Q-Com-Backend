import crypto from 'crypto';
import pg from 'pg';
import { getPool, transaction } from '../../database/connection.js';
import { inventoryService } from '../inventory/inventoryService.js';
import { dispatchService } from '../dispatch/dispatchService.js';
import { ledgerService } from '../ledger/ledgerService.js';
import { refundService, RefundRecord } from '../payments/refundService.js';
import { outboxService } from '../outbox/outboxService.js';
import { OrderRecord } from './orderTypes.js';

export interface CancellationResult {
  order: any;
  refund?: RefundRecord | any;
  isDuplicate: boolean;
  cancelledBy: 'CUSTOMER' | 'SELLER' | 'ADMIN';
  reason: string;
}

export class CancellationService {
  /**
   * Customer-initiated cancellation with 5-minute grace period guard
   */
  public async cancelByCustomer(params: {
    orderId: string;
    userId: string;
    reason?: string;
    idempotencyKey?: string;
    clientOverride?: pg.PoolClient;
  }): Promise<CancellationResult> {
    const execute = async (client: pg.PoolClient) => {
      // 1. Idempotency check
      if (params.idempotencyKey) {
        const keyRes = await client.query(`
          SELECT status, response_body FROM idempotency_keys
          WHERE idempotency_key = $1
          LIMIT 1
        `, [params.idempotencyKey]);

        if (keyRes.rows.length > 0 && keyRes.rows[0].status === 'COMPLETED') {
          return {
            ...keyRes.rows[0].response_body,
            isDuplicate: true,
          };
        }
      }

      // 2. Lock order FOR UPDATE
      const orderRes = await client.query(`
        SELECT * FROM orders
        WHERE id = $1 AND user_id = $2
        FOR UPDATE
      `, [params.orderId, params.userId]);

      if (orderRes.rows.length === 0) {
        throw new Error('ORDER_NOT_FOUND: Order not found or unauthorized.');
      }

      const o = orderRes.rows[0];
      if (o.status === 'cancelled') {
        throw new Error('ORDER_ALREADY_CANCELLED: Order is already cancelled.');
      }
      if (['out_for_delivery', 'delivered'].includes(o.status)) {
        throw new Error(`ORDER_NON_CANCELLABLE: Order cannot be cancelled in '${o.status}' status. Out for delivery / delivered orders are non-cancellable.`);
      }

      // Check 5-minute cancellation window
      const placedTime = new Date(o.placed_at || o.created_at).getTime();
      const elapsedMinutes = (Date.now() - placedTime) / (1000 * 60);
      if (elapsedMinutes > 5) {
        throw new Error(`CANCELLATION_WINDOW_EXPIRED: Orders can only be cancelled within 5 minutes of placement (elapsed: ${elapsedMinutes.toFixed(1)} mins).`);
      }

      return this.executeCancellation({
        orderRow: o,
        cancelledBy: 'CUSTOMER',
        actorId: params.userId,
        reason: params.reason || 'Customer requested cancellation within grace period.',
        idempotencyKey: params.idempotencyKey,
        client,
      });
    };

    if (params.clientOverride) {
      return execute(params.clientOverride);
    }
    return transaction(execute);
  }

  /**
   * Seller-initiated cancellation (e.g. out of stock or store operational issue)
   */
  public async cancelBySeller(params: {
    orderId: string;
    merchantId: string;
    reason: string;
    idempotencyKey?: string;
    clientOverride?: pg.PoolClient;
  }): Promise<CancellationResult> {
    const execute = async (client: pg.PoolClient) => {
      // 1. Idempotency check
      if (params.idempotencyKey) {
        const keyRes = await client.query(`
          SELECT status, response_body FROM idempotency_keys
          WHERE idempotency_key = $1
          LIMIT 1
        `, [params.idempotencyKey]);

        if (keyRes.rows.length > 0 && keyRes.rows[0].status === 'COMPLETED') {
          return {
            ...keyRes.rows[0].response_body,
            isDuplicate: true,
          };
        }
      }

      // 2. Lock order FOR UPDATE
      const orderRes = await client.query(`
        SELECT * FROM orders
        WHERE id = $1 AND merchant_id = $2
        FOR UPDATE
      `, [params.orderId, params.merchantId]);

      if (orderRes.rows.length === 0) {
        throw new Error(`ORDER_NOT_FOUND: Order not found or not owned by merchant '${params.merchantId}'.`);
      }

      const o = orderRes.rows[0];
      if (o.status === 'cancelled') {
        throw new Error('ORDER_ALREADY_CANCELLED: Order is already cancelled.');
      }
      if (['out_for_delivery', 'delivered'].includes(o.status)) {
        throw new Error(`ORDER_NON_CANCELLABLE: Cannot cancel order in '${o.status}' status. Goods already dispatched.`);
      }

      return this.executeCancellation({
        orderRow: o,
        cancelledBy: 'SELLER',
        actorId: params.merchantId,
        reason: params.reason,
        idempotencyKey: params.idempotencyKey,
        client,
      });
    };

    if (params.clientOverride) {
      return execute(params.clientOverride);
    }
    return transaction(execute);
  }

  /**
   * Admin-initiated cancellation override
   */
  public async cancelByAdmin(params: {
    orderId: string;
    adminUserId: string;
    reason: string;
    idempotencyKey?: string;
    clientOverride?: pg.PoolClient;
  }): Promise<CancellationResult> {
    const execute = async (client: pg.PoolClient) => {
      if (params.idempotencyKey) {
        const keyRes = await client.query(`
          SELECT status, response_body FROM idempotency_keys
          WHERE idempotency_key = $1
          LIMIT 1
        `, [params.idempotencyKey]);

        if (keyRes.rows.length > 0 && keyRes.rows[0].status === 'COMPLETED') {
          return {
            ...keyRes.rows[0].response_body,
            isDuplicate: true,
          };
        }
      }

      const orderRes = await client.query(`
        SELECT * FROM orders
        WHERE id = $1
        FOR UPDATE
      `, [params.orderId]);

      if (orderRes.rows.length === 0) {
        throw new Error(`ORDER_NOT_FOUND: Order '${params.orderId}' does not exist.`);
      }

      const o = orderRes.rows[0];
      if (o.status === 'cancelled') {
        throw new Error('ORDER_ALREADY_CANCELLED: Order is already cancelled.');
      }
      if (o.status === 'delivered') {
        throw new Error('ORDER_ALREADY_DELIVERED: Delivered orders cannot be cancelled. Use Returns workflow instead.');
      }

      return this.executeCancellation({
        orderRow: o,
        cancelledBy: 'ADMIN',
        actorId: params.adminUserId,
        reason: params.reason,
        idempotencyKey: params.idempotencyKey,
        client,
      });
    };

    if (params.clientOverride) {
      return execute(params.clientOverride);
    }
    return transaction(execute);
  }

  /**
   * Internal core atomic cancellation executor
   */
  private async executeCancellation(opts: {
    orderRow: any;
    cancelledBy: 'CUSTOMER' | 'SELLER' | 'ADMIN';
    actorId: string;
    reason: string;
    idempotencyKey?: string;
    client: pg.PoolClient;
  }): Promise<CancellationResult> {
    const { orderRow: o, cancelledBy, actorId, reason, idempotencyKey, client } = opts;
    const orderId = o.id;
    const totalAmount = parseFloat(o.total_amount);

    // 1. Decouple Dispatch: cancel active assignments, offers, trips, and reset rider to AVAILABLE
    await dispatchService.cancelOrderDispatch(orderId, client);

    // 2. Inventory Restoration: Check reservation state and restore accurately
    const resCheck = await client.query(`
      SELECT status FROM inventory_reservations WHERE order_id = $1
      FOR UPDATE
    `, [orderId]);

    if (resCheck.rows.length > 0) {
      const hasCommitted = resCheck.rows.some((r: any) => r.status === 'COMMITTED');
      const hasReserved = resCheck.rows.some((r: any) => r.status === 'RESERVED');

      if (hasCommitted) {
        await inventoryService.restockCommittedStock(orderId, client);
      }
      if (hasReserved) {
        await inventoryService.releaseStock(orderId, client);
      }
      // If all rows are already 'RELEASED', no-op to prevent duplicate stock restoration
    } else {
      // Fallback for legacy untracked orders only if order was paid or COD placed
      if (o.payment_status === 'PAID' || o.payment_method === 'Pay on Delivery') {
        await inventoryService.restockCommittedStock(orderId, client);
      }
    }

    // 3. Process Refund & General Ledger Entry if paid
    let refundRecord: RefundRecord | undefined;
    if (o.payment_status === 'PAID') {
      const refundRes = await refundService.createRefund({
        orderId,
        amount: totalAmount,
        reasonCode: `ORDER_CANCELLED_${cancelledBy}`,
        reasonDescription: reason,
        refundType: 'FULL',
        idempotencyKey: idempotencyKey ? `ref_${idempotencyKey}` : undefined,
        createdBy: actorId,
        clientOverride: client,
      });
      refundRecord = refundRes.refund;
    }

    // 3b. Invalidate active payment intents to prevent delayed charges
    await client.query(`
      UPDATE payment_intents
      SET status = 'CANCELLED', updated_at = NOW()
      WHERE order_id = $1 AND status IN ('CREATED', 'PENDING', 'AUTHORIZED')
    `, [orderId]);

    // 4. Update order status in PostgreSQL
    const finalReason = `[${cancelledBy}] ${reason}`;
    const updRes = await client.query(`
      UPDATE orders
      SET status = 'cancelled',
          cancellation_reason = $2,
          payment_status = CASE WHEN payment_status = 'PAID' THEN 'REFUNDED' ELSE payment_status END,
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [orderId, finalReason]);

    const updatedOrder = updRes.rows[0];

    // 5. Stage Outbox Event: OrderCancelled
    await outboxService.stageEvent(client, {
      eventType: 'OrderCancelled',
      aggregateType: 'ORDER',
      aggregateId: orderId,
      payload: {
        orderId,
        cancelledBy,
        actorId,
        merchantId: o.merchant_id,
        userId: o.user_id,
        reason: finalReason,
        refundAmount: refundRecord ? refundRecord.amount : 0,
      },
    });

    const result: CancellationResult = {
      order: updatedOrder,
      refund: refundRecord || {
        orderId,
        amount: 0,
        status: 'NO_PAYMENT_CAPTURED',
      },
      isDuplicate: false,
      cancelledBy,
      reason: finalReason,
    };

    // 6. Record in idempotency_keys if key provided
    if (idempotencyKey) {
      await client.query(`
        INSERT INTO idempotency_keys (
          idempotency_key, actor_id, endpoint, status, status_code, response_body, expires_at
        )
        VALUES ($1, $2, '/api/v1/orders/cancel', 'COMPLETED', 200, $3, NOW() + INTERVAL '24 hours')
        ON CONFLICT (idempotency_key) DO NOTHING
      `, [idempotencyKey, actorId, JSON.stringify(result)]);
    }

    return result;
  }
}

export const cancellationService = new CancellationService();
