import pg from 'pg';
import { transaction } from '../../database/connection.js';
import { inventoryService } from '../inventory/inventoryService.js';
import { dispatchService } from '../dispatch/dispatchService.js';
import { refundService, PreparedRefundIntent, RefundRecord } from '../payments/refundService.js';
import { outboxService } from '../outbox/outboxService.js';
import { transitionPaymentIntentState, transitionPaymentAttemptState } from '../payments/paymentStateMachine.js';

export interface CancellationResult {
  order: any;
  refund?: RefundRecord | any;
  isDuplicate: boolean;
  cancelledBy: 'CUSTOMER' | 'SELLER' | 'ADMIN';
  reason: string;
}

interface PreparedCancellationState {
  earlyReturn?: CancellationResult;
  updatedOrder?: any;
  preparedRefund?: PreparedRefundIntent;
  cancelledBy?: 'CUSTOMER' | 'SELLER' | 'ADMIN';
  reasonCode?: string;
  finalReason?: string;
  actorId?: string;
  idempotencyKey?: string;
}

export class CancellationService {
  private async checkAndClaimIdempotencyKey(
    client: pg.PoolClient,
    idempotencyKey: string,
    actorId: string
  ): Promise<CancellationResult | null> {
    await client.query(
      `INSERT INTO idempotency_keys (
         idempotency_key, actor_id, endpoint, status, status_code, response_body, expires_at
       )
       VALUES ($1, $2, '/api/v1/orders/cancel', 'PROCESSING', 202, '{}'::jsonb, NOW() + INTERVAL '24 hours')
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [idempotencyKey, actorId]
    );

    const keyRes = await client.query(
      `SELECT actor_id, status, response_body FROM idempotency_keys
       WHERE idempotency_key = $1
       LIMIT 1
       FOR UPDATE`,
      [idempotencyKey]
    );

    if (keyRes.rows.length > 0) {
      const row = keyRes.rows[0];
      if (row.actor_id && row.actor_id !== actorId) {
        throw new Error(
          `IDEMPOTENCY_KEY_ACTOR_MISMATCH: Idempotency key '${idempotencyKey}' is bound to a different actor.`
        );
      }
      if (row.status === 'COMPLETED' && row.response_body && Object.keys(row.response_body).length > 0) {
        return {
          ...row.response_body,
          isDuplicate: true,
        };
      }
      // Note: if row was inserted right now in this TX, caller holds this lock and proceeds;
      // if another committed TX left status = 'PROCESSING' while awaiting gateway, block concurrent duplicate:
      const isFreshSelfInsert =
        row.status === 'PROCESSING' &&
        (!row.response_body || Object.keys(row.response_body).length === 0) &&
        row.actor_id === actorId;
      // Distinguish fresh insert inside this TX vs committed in-flight via response_body marker `_phase`:
      if (row.status === 'PROCESSING' && row.response_body && row.response_body._inProgress === true) {
        throw new Error(
          `CANCELLATION_IN_PROGRESS: Cancellation for idempotency key '${idempotencyKey}' is currently processing.`
        );
      }
      void isFreshSelfInsert;
    }

    return null;
  }

  private async runDecoupledCancellation(opts: {
    cancelledBy: 'CUSTOMER' | 'SELLER' | 'ADMIN';
    actorId: string;
    reason: string;
    idempotencyKey?: string;
    clientOverride?: pg.PoolClient;
    loadAndValidateOrder: (client: pg.PoolClient) => Promise<any>;
  }): Promise<CancellationResult> {
    const { cancelledBy, actorId, reason, idempotencyKey, clientOverride, loadAndValidateOrder } = opts;

    // Compatible single-transaction path only when caller supplies an explicit clientOverride
    if (clientOverride) {
      if (idempotencyKey) {
        const cached = await this.checkAndClaimIdempotencyKey(clientOverride, idempotencyKey, actorId);
        if (cached) return cached;
      }
      const orderRow = await loadAndValidateOrder(clientOverride);
      return this.executeCancellationSingleTx({
        orderRow,
        cancelledBy,
        actorId,
        reason,
        idempotencyKey,
        client: clientOverride,
      });
    }

    // Production decoupled 3-phase flow:
    // Phase 1 TX: locks order, cancels dispatch, restores inventory, prepares PROCESSING refund intent,
    // cancels order & payment_intents, updates idempotency_keys, COMMITS & RELEASES ALL ROW LOCKS.
    const preparedState = await transaction(async (client): Promise<PreparedCancellationState> => {
      if (idempotencyKey) {
        const cached = await this.checkAndClaimIdempotencyKey(client, idempotencyKey, actorId);
        if (cached) {
          return { earlyReturn: cached };
        }
      }

      const o = await loadAndValidateOrder(client);
      const orderId = o.id;
      const totalAmount = parseFloat(o.total_amount);

      await dispatchService.cancelOrderDispatch(orderId, client);
      await this.restoreOrderInventory(o, client);

      let preparedRefund: PreparedRefundIntent | undefined;
      const reasonCode = `ORDER_CANCELLED_${cancelledBy}`;
      if (o.payment_status === 'PAID') {
        preparedRefund = await refundService.prepareRefundIntent(
          {
            orderId,
            amount: totalAmount,
            reasonCode,
            reasonDescription: reason,
            refundType: 'FULL',
            idempotencyKey: idempotencyKey ? `ref_${idempotencyKey}` : undefined,
            createdBy: actorId,
          },
          client
        );
      }

      const intentRes = await client.query(
        `SELECT id FROM payment_intents
         WHERE order_id = $1 AND status IN ('CREATED', 'INITIATED', 'PENDING', 'PROCESSING', 'AUTHORIZED', 'UNKNOWN', 'RECONCILIATION_REQUIRED')
         FOR UPDATE`,
        [orderId]
      );
      for (const row of intentRes.rows) {
        await transitionPaymentIntentState(client, row.id, 'CANCELLED', {
          errorCode: reasonCode,
          errorDescription: reason,
          failureClassification: 'POLICY',
        });
      }
      try {
        const attRes = await client.query(
          `SELECT id FROM payment_attempts
           WHERE order_id = $1 AND status IN ('INITIATED', 'PENDING', 'PROCESSING', 'UNKNOWN', 'RECONCILIATION_REQUIRED')
           FOR UPDATE`,
          [orderId]
        );
        for (const att of attRes.rows) {
          await transitionPaymentAttemptState(client, att.id, 'CANCELLED', {
            errorCode: reasonCode,
            errorMessage: reason,
            failureClassification: 'POLICY',
            retryEligible: false,
          });
        }
      } catch {}

      const finalReason = `[${cancelledBy}] ${reason}`;
      const updRes = await client.query(
        `UPDATE orders
         SET status = 'cancelled',
             cancellation_reason = $2,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [orderId, finalReason]
      );
      const updatedOrder = updRes.rows[0];

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
          refundAmount: preparedRefund ? preparedRefund.requestedAmount : 0,
        },
      });

      if (idempotencyKey && !preparedRefund) {
        const syncResult: CancellationResult = {
          order: updatedOrder,
          refund: { orderId, amount: 0, status: 'NO_PAYMENT_CAPTURED' },
          isDuplicate: false,
          cancelledBy,
          reason: finalReason,
        };
        await client.query(
          `UPDATE idempotency_keys
           SET status = 'COMPLETED', status_code = 200, response_body = $2
           WHERE idempotency_key = $1`,
          [idempotencyKey, JSON.stringify(syncResult)]
        );
      } else if (idempotencyKey && preparedRefund) {
        await client.query(
          `UPDATE idempotency_keys
           SET status = 'PROCESSING', response_body = $2
           WHERE idempotency_key = $1`,
          [idempotencyKey, JSON.stringify({ _inProgress: true, orderId })]
        );
      }

      return {
        updatedOrder,
        preparedRefund,
        cancelledBy,
        reasonCode,
        finalReason,
        actorId,
        idempotencyKey,
      };
    });

    if (preparedState.earlyReturn) {
      return preparedState.earlyReturn;
    }

    const updatedOrder = preparedState.updatedOrder!;
    const finalReason = preparedState.finalReason!;

    if (!preparedState.preparedRefund) {
      return {
        order: updatedOrder,
        refund: {
          orderId: updatedOrder.id,
          amount: 0,
          status: 'NO_PAYMENT_CAPTURED',
        },
        isDuplicate: false,
        cancelledBy,
        reason: finalReason,
      };
    }

    // Phase 2 + Phase 3 (OUTSIDE DB locks): external gateway call -> short reconcile TX
    const refundExec = await refundService.executePreparedRefund({
      prepared: preparedState.preparedRefund,
      orderId: updatedOrder.id,
      reasonCode: preparedState.reasonCode!,
    });

    // Phase 4 (short TX): refresh order snapshot (payment_status may now be REFUNDED) & finalize idempotency key
    const finalOrder = await transaction(async (client) => {
      const refRes = await client.query(`SELECT * FROM orders WHERE id = $1 LIMIT 1`, [updatedOrder.id]);
      const refreshedOrder = refRes.rows[0] || updatedOrder;

      const finalResult: CancellationResult = {
        order: refreshedOrder,
        refund: refundExec.refund,
        isDuplicate: false,
        cancelledBy,
        reason: finalReason,
      };

      if (idempotencyKey) {
        await client.query(
          `UPDATE idempotency_keys
           SET status = 'COMPLETED', status_code = 200, response_body = $2
           WHERE idempotency_key = $1`,
          [idempotencyKey, JSON.stringify(finalResult)]
        );
      }

      return refreshedOrder;
    });

    return {
      order: finalOrder,
      refund: refundExec.refund,
      isDuplicate: false,
      cancelledBy,
      reason: finalReason,
    };
  }

  private async restoreOrderInventory(o: any, client: pg.PoolClient): Promise<void> {
    const orderId = o.id;
    const resCheck = await client.query(
      `SELECT status FROM inventory_reservations WHERE order_id = $1 FOR UPDATE`,
      [orderId]
    );

    if (resCheck.rows.length > 0) {
      const hasCommitted = resCheck.rows.some((r: any) => r.status === 'COMMITTED');
      const hasReserved = resCheck.rows.some((r: any) => r.status === 'RESERVED');

      if (hasCommitted) {
        await inventoryService.restockCommittedStock(orderId, client);
      }
      if (hasReserved) {
        await inventoryService.releaseStock(orderId, client);
      }
    } else if (o.payment_status === 'PAID' || o.payment_method === 'Pay on Delivery') {
      await inventoryService.restockCommittedStock(orderId, client);
    }
  }

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
    return this.runDecoupledCancellation({
      cancelledBy: 'CUSTOMER',
      actorId: params.userId,
      reason: params.reason || 'Customer requested cancellation within grace period.',
      idempotencyKey: params.idempotencyKey,
      clientOverride: params.clientOverride,
      loadAndValidateOrder: async (client) => {
        const orderRes = await client.query(
          `SELECT * FROM orders
           WHERE id = $1 AND user_id = $2
           FOR UPDATE`,
          [params.orderId, params.userId]
        );

        if (orderRes.rows.length === 0) {
          throw new Error('ORDER_NOT_FOUND: Order not found or unauthorized.');
        }

        const o = orderRes.rows[0];
        if (o.status === 'cancelled') {
          throw new Error('ORDER_ALREADY_CANCELLED: Order is already cancelled.');
        }
        if (['out_for_delivery', 'delivered'].includes(o.status)) {
          throw new Error(
            `ORDER_NON_CANCELLABLE: Order cannot be cancelled in '${o.status}' status. Out for delivery / delivered orders are non-cancellable.`
          );
        }

        const placedTime = new Date(o.placed_at || o.created_at).getTime();
        const elapsedMinutes = (Date.now() - placedTime) / (1000 * 60);
        if (elapsedMinutes > 5) {
          throw new Error(
            `CANCELLATION_WINDOW_EXPIRED: Orders can only be cancelled within 5 minutes of placement (elapsed: ${elapsedMinutes.toFixed(1)} mins).`
          );
        }
        return o;
      },
    });
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
    return this.runDecoupledCancellation({
      cancelledBy: 'SELLER',
      actorId: params.merchantId,
      reason: params.reason,
      idempotencyKey: params.idempotencyKey,
      clientOverride: params.clientOverride,
      loadAndValidateOrder: async (client) => {
        const orderRes = await client.query(
          `SELECT * FROM orders
           WHERE id = $1 AND merchant_id = $2
           FOR UPDATE`,
          [params.orderId, params.merchantId]
        );

        if (orderRes.rows.length === 0) {
          throw new Error(`ORDER_NOT_FOUND: Order not found or not owned by merchant '${params.merchantId}'.`);
        }

        const o = orderRes.rows[0];
        if (o.status === 'cancelled') {
          throw new Error('ORDER_ALREADY_CANCELLED: Order is already cancelled.');
        }
        if (['out_for_delivery', 'delivered'].includes(o.status)) {
          throw new Error(
            `ORDER_NON_CANCELLABLE: Cannot cancel order in '${o.status}' status. Goods already dispatched.`
          );
        }
        return o;
      },
    });
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
    return this.runDecoupledCancellation({
      cancelledBy: 'ADMIN',
      actorId: params.adminUserId,
      reason: params.reason,
      idempotencyKey: params.idempotencyKey,
      clientOverride: params.clientOverride,
      loadAndValidateOrder: async (client) => {
        const orderRes = await client.query(
          `SELECT * FROM orders
           WHERE id = $1
           FOR UPDATE`,
          [params.orderId]
        );

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
        return o;
      },
    });
  }

  /**
   * Single-transaction executor preserved strictly for callers passing an explicit clientOverride.
   */
  private async executeCancellationSingleTx(opts: {
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

    await dispatchService.cancelOrderDispatch(orderId, client);
    await this.restoreOrderInventory(o, client);

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

    const singleIntentRes = await client.query(
      `SELECT id FROM payment_intents
       WHERE order_id = $1 AND status IN ('CREATED', 'INITIATED', 'PENDING', 'PROCESSING', 'AUTHORIZED', 'UNKNOWN', 'RECONCILIATION_REQUIRED')
       FOR UPDATE`,
      [orderId]
    );
    for (const row of singleIntentRes.rows) {
      await transitionPaymentIntentState(client, row.id, 'CANCELLED', {
        errorCode: `ORDER_CANCELLED_${cancelledBy}`,
        errorDescription: reason,
        failureClassification: 'POLICY',
      });
    }
    try {
      const singleAttRes = await client.query(
        `SELECT id FROM payment_attempts
         WHERE order_id = $1 AND status IN ('INITIATED', 'PENDING', 'PROCESSING', 'UNKNOWN', 'RECONCILIATION_REQUIRED')
         FOR UPDATE`,
        [orderId]
      );
      for (const att of singleAttRes.rows) {
        await transitionPaymentAttemptState(client, att.id, 'CANCELLED', {
          errorCode: `ORDER_CANCELLED_${cancelledBy}`,
          errorMessage: reason,
          failureClassification: 'POLICY',
          retryEligible: false,
        });
      }
    } catch {}

    const finalReason = `[${cancelledBy}] ${reason}`;
    const markRefunded = refundRecord?.status === 'COMPLETED';
    const updRes = await client.query(`
      UPDATE orders
      SET status = 'cancelled',
          cancellation_reason = $2,
          payment_status = CASE WHEN $3 = TRUE AND payment_status = 'PAID' THEN 'REFUNDED' ELSE payment_status END,
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [orderId, finalReason, markRefunded]);

    const updatedOrder = updRes.rows[0];

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

    if (idempotencyKey) {
      await client.query(`
        UPDATE idempotency_keys
        SET status = 'COMPLETED', status_code = 200, response_body = $2
        WHERE idempotency_key = $1
      `, [idempotencyKey, JSON.stringify(result)]);
    }

    return result;
  }
}

export const cancellationService = new CancellationService();
