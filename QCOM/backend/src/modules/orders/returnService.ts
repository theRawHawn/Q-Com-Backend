import crypto from 'crypto';
import pg from 'pg';
import { getPool, transaction } from '../../database/connection.js';
import { inventoryService } from '../inventory/inventoryService.js';
import { dispatchService } from '../dispatch/dispatchService.js';
import { refundService, RefundRecord } from '../payments/refundService.js';
import { sellerSettlementService } from '../settlements/sellerSettlementService.js';
import { outboxService } from '../outbox/outboxService.js';
import { bloomFilterService } from '../resilience/bloomFilterService.js';

export interface RequestReturnItemInput {
  orderItemId: string;
  quantity: number;
}

export interface RequestReturnParams {
  orderId: string;
  userId: string;
  items: RequestReturnItemInput[];
  reasonCode: string;
  customerNotes?: string;
  idempotencyKey?: string;
  clientOverride?: pg.PoolClient;
}

export interface ReturnRecord {
  id: string;
  returnNumber: string;
  orderId: string;
  userId: string;
  merchantId: string;
  status: string;
  reasonCode: string;
  customerNotes?: string;
  qcNotes?: string;
  pickupTripId?: string;
  refundId?: string;
  requestedAt: string;
  approvedAt?: string;
  receivedAt?: string;
  completedAt?: string;
  items: {
    id: string;
    orderItemId: string;
    productId: string;
    productName?: string;
    quantity: number;
    qcStatus: 'PENDING' | 'PASSED' | 'FAILED';
    restocked: boolean;
  }[];
}

export class ReturnService {
  /**
   * Customer initiates a return request for a delivered order
   */
  public async requestReturn(params: RequestReturnParams): Promise<{ returnRequest: ReturnRecord; isDuplicate: boolean }> {
    const execute = async (client: pg.PoolClient) => {
      // 1. Idempotency Check
      if (params.idempotencyKey) {
        const existingKey = await client.query(`
          SELECT status, response_body FROM idempotency_keys
          WHERE idempotency_key = $1
          LIMIT 1
        `, [params.idempotencyKey]);

        if (existingKey.rows.length > 0 && existingKey.rows[0].status === 'COMPLETED') {
          return {
            returnRequest: existingKey.rows[0].response_body,
            isDuplicate: true,
          };
        }
      }

      // 2. Lock and verify order
      const orderRes = await client.query(`
        SELECT * FROM orders
        WHERE id = $1
        FOR UPDATE
      `, [params.orderId]);

      if (orderRes.rows.length === 0) {
        throw new Error(`ORDER_NOT_FOUND: Order '${params.orderId}' does not exist.`);
      }

      const order = orderRes.rows[0];

      // Anti-IDOR check
      if (order.user_id !== params.userId) {
        throw new Error('UNAUTHORIZED_RETURN_REQUEST: Authenticated user does not own this order.');
      }

      // Must be delivered
      if (order.status !== 'delivered') {
        throw new Error(`ORDER_NOT_DELIVERED: Returns can only be requested for 'delivered' orders. Current status: '${order.status}'.`);
      }

      // Check 48-hour return window
      const deliveredTime = new Date(order.delivered_at || order.updated_at).getTime();
      const hoursSinceDelivery = (Date.now() - deliveredTime) / (1000 * 60 * 60);
      if (hoursSinceDelivery > 48) {
        throw new Error(
          `RETURN_WINDOW_EXPIRED: Return requests must be filed within 48 hours of delivery (elapsed: ${hoursSinceDelivery.toFixed(1)} hours).`
        );
      }

      if (!params.items || !Array.isArray(params.items) || params.items.length === 0) {
        throw new Error('EMPTY_RETURN_ITEMS: At least one item must be specified for return.');
      }

      // 3. Validate items and quantity ceilings
      const returnNumber = `RET_${Date.now()}_${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

      const insReturnRes = await client.query(`
        INSERT INTO order_returns (
          return_number, order_id, user_id, merchant_id, status,
          reason_code, customer_notes
        )
        VALUES ($1, $2, $3, $4, 'REQUESTED', $5, $6)
        RETURNING *
      `, [
        returnNumber,
        params.orderId,
        params.userId,
        order.merchant_id,
        params.reasonCode,
        params.customerNotes || null,
      ]);

      const returnRow = insReturnRes.rows[0];
      const returnItemsCreated: any[] = [];

      for (const itemInput of params.items) {
        if (!itemInput.quantity || itemInput.quantity <= 0) {
          throw new Error(`INVALID_RETURN_QUANTITY: Requested return quantity must be greater than zero.`);
        }

        // Fetch original order item
        const oiRes = await client.query(`
          SELECT * FROM order_items
          WHERE id = $1 AND order_id = $2
          LIMIT 1
        `, [itemInput.orderItemId, params.orderId]);

        if (oiRes.rows.length === 0) {
          throw new Error(`ORDER_ITEM_NOT_FOUND: Item '${itemInput.orderItemId}' does not belong to order '${params.orderId}'.`);
        }

        const oi = oiRes.rows[0];
        const purchasedQty = parseInt(oi.quantity, 10);

        // Check quantity ceiling across existing returns
        const priorReturnItemsRes = await client.query(`
          SELECT COALESCE(SUM(ori.quantity), 0) AS total_returned
          FROM order_return_items ori
          JOIN order_returns ord ON ori.return_id = ord.id
          WHERE ori.order_item_id = $1 AND ord.status NOT IN ('REJECTED', 'REJECTED_QC', 'CANCELLED')
            AND ord.id != $2
        `, [itemInput.orderItemId, returnRow.id]);

        const priorReturnedQty = parseInt(priorReturnItemsRes.rows[0].total_returned, 10);
        const remainingReturnableQty = purchasedQty - priorReturnedQty;

        if (itemInput.quantity > remainingReturnableQty) {
          throw new Error(
            `RETURN_QUANTITY_EXCEEDED: Requested return quantity (${itemInput.quantity}) exceeds remaining returnable units (${remainingReturnableQty}) for item '${oi.product_name}' (Purchased: ${purchasedQty}, Previously Returned: ${priorReturnedQty}).`
          );
        }

        // Insert return item
        const insItemRes = await client.query(`
          INSERT INTO order_return_items (
            return_id, order_item_id, product_id, quantity, qc_status, restocked
          )
          VALUES ($1, $2, $3, $4, 'PENDING', FALSE)
          RETURNING *
        `, [returnRow.id, itemInput.orderItemId, oi.product_id, itemInput.quantity]);

        const itemRow = insItemRes.rows[0];
        returnItemsCreated.push({
          id: itemRow.id,
          orderItemId: itemRow.order_item_id,
          productId: itemRow.product_id,
          productName: oi.product_name,
          quantity: itemRow.quantity,
          qcStatus: itemRow.qc_status,
          restocked: itemRow.restocked,
        });
      }

      // Update order status to return_requested
      await client.query(`
        UPDATE orders
        SET status = 'return_requested', updated_at = NOW()
        WHERE id = $1
      `, [params.orderId]);

      // Stage Outbox Event: ReturnRequested
      await outboxService.stageEvent(client, {
        eventType: 'ReturnRequested',
        aggregateType: 'RETURN',
        aggregateId: returnRow.id,
        payload: {
          returnId: returnRow.id,
          returnNumber,
          orderId: params.orderId,
          userId: params.userId,
          merchantId: order.merchant_id,
          itemCount: returnItemsCreated.length,
        },
      });

      const returnRecord: ReturnRecord = {
        id: returnRow.id,
        returnNumber,
        orderId: params.orderId,
        userId: params.userId,
        merchantId: order.merchant_id,
        status: 'REQUESTED',
        reasonCode: params.reasonCode,
        customerNotes: params.customerNotes,
        requestedAt: new Date(returnRow.requested_at).toISOString(),
        items: returnItemsCreated,
      };

      if (params.idempotencyKey) {
        await client.query(`
          INSERT INTO idempotency_keys (
            idempotency_key, actor_id, endpoint, status, status_code, response_body, expires_at
          )
          VALUES ($1, $2, '/api/v1/orders/returns', 'COMPLETED', 201, $3, NOW() + INTERVAL '24 hours')
          ON CONFLICT (idempotency_key) DO NOTHING
        `, [params.idempotencyKey, params.userId, JSON.stringify(returnRecord)]);
      }

      return {
        returnRequest: returnRecord,
        isDuplicate: false,
      };
    };

    let result: { returnRequest: ReturnRecord; isDuplicate: boolean };
    if (params.clientOverride) {
      result = await execute(params.clientOverride);
    } else {
      result = await transaction(execute);
    }

    if (result && result.returnRequest && result.returnRequest.id) {
      bloomFilterService.add('returns', result.returnRequest.id);
    }

    return result;
  }

  /**
   * Merchant or Admin reviews return request: APPROVE or REJECT
   */
  public async reviewReturn(params: {
    returnId: string;
    merchantId?: string;
    adminId?: string;
    action: 'APPROVE' | 'REJECT';
    reasonNotes?: string;
    clientOverride?: pg.PoolClient;
  }): Promise<ReturnRecord> {
    const execute = async (client: pg.PoolClient) => {
      const returnRes = await client.query(`
        SELECT * FROM order_returns
        WHERE id = $1
        FOR UPDATE
      `, [params.returnId]);

      if (returnRes.rows.length === 0) {
        throw new Error(`RETURN_NOT_FOUND: Return request '${params.returnId}' does not exist.`);
      }

      const ret = returnRes.rows[0];

      // Anti-IDOR check for merchant
      if (params.merchantId && ret.merchant_id !== params.merchantId) {
        throw new Error(`UNAUTHORIZED_MERCHANT_ACCESS: Return does not belong to merchant '${params.merchantId}'.`);
      }

      if (ret.status !== 'REQUESTED') {
        throw new Error(`INVALID_RETURN_STATE: Cannot review return in '${ret.status}' state.`);
      }

      if (params.action === 'APPROVE') {
        // Create reverse pickup trip via dispatchService
        const tripId = await dispatchService.createReversePickupTrip({
          returnId: ret.id,
          orderId: ret.order_id,
          merchantId: ret.merchant_id,
          clientOverride: client,
        });

        await client.query(`
          UPDATE order_returns
          SET status = 'PICKUP_ASSIGNED',
              pickup_trip_id = $1,
              approved_at = NOW(),
              qc_notes = $2
          WHERE id = $3
        `, [tripId, params.reasonNotes || null, ret.id]);

        await client.query(`
          UPDATE orders
          SET status = 'return_approved', updated_at = NOW()
          WHERE id = $1
        `, [ret.order_id]);

        await outboxService.stageEvent(client, {
          eventType: 'ReturnApproved',
          aggregateType: 'RETURN',
          aggregateId: ret.id,
          payload: {
            returnId: ret.id,
            orderId: ret.order_id,
            merchantId: ret.merchant_id,
            tripId,
          },
        });
      } else {
        await client.query(`
          UPDATE order_returns
          SET status = 'REJECTED',
              qc_notes = $1
          WHERE id = $2
        `, [params.reasonNotes || 'Rejected by merchant/admin', ret.id]);

        await client.query(`
          UPDATE orders
          SET status = 'return_rejected', updated_at = NOW()
          WHERE id = $1
        `, [ret.order_id]);

        await outboxService.stageEvent(client, {
          eventType: 'ReturnRejected',
          aggregateType: 'RETURN',
          aggregateId: ret.id,
          payload: {
            returnId: ret.id,
            orderId: ret.order_id,
            merchantId: ret.merchant_id,
            reason: params.reasonNotes || 'Rejected',
          },
        });
      }

      const updated = await this.getReturnById(ret.id, client);
      return updated!;
    };

    if (params.clientOverride) {
      return execute(params.clientOverride);
    }
    return transaction(execute);
  }

  /**
   * Store receives reverse pickup goods delivered by rider
   */
  public async receiveAtStore(params: {
    returnId: string;
    merchantId: string;
    clientOverride?: pg.PoolClient;
  }): Promise<ReturnRecord> {
    const execute = async (client: pg.PoolClient) => {
      const returnRes = await client.query(`
        SELECT * FROM order_returns
        WHERE id = $1 AND merchant_id = $2
        FOR UPDATE
      `, [params.returnId, params.merchantId]);

      if (returnRes.rows.length === 0) {
        throw new Error('RETURN_NOT_FOUND: Return not found or unauthorized.');
      }

      const ret = returnRes.rows[0];
      await client.query(`
        UPDATE order_returns
        SET status = 'RECEIVED_AT_STORE',
            received_at = NOW()
        WHERE id = $1
      `, [ret.id]);

      await outboxService.stageEvent(client, {
        eventType: 'ReturnReceivedAtStore',
        aggregateType: 'RETURN',
        aggregateId: ret.id,
        payload: {
          returnId: ret.id,
          orderId: ret.order_id,
          merchantId: ret.merchant_id,
        },
      });

      const updated = await this.getReturnById(ret.id, client);
      return updated!;
    };

    if (params.clientOverride) {
      return execute(params.clientOverride);
    }
    return transaction(execute);
  }

  /**
   * Merchant Store QC inspection: verifies item condition, selectively restocks,
   * calculates proportional refund, issues gateway refund, and executes seller clawback.
   */
  public async qcInspectAndResolve(params: {
    returnId: string;
    merchantId: string;
    itemDecisions: { returnItemId: string; qcPassed: boolean; notes?: string }[];
    qcNotes?: string;
    clientOverride?: pg.PoolClient;
  }): Promise<{ returnRecord: ReturnRecord; refund?: RefundRecord; clawback?: any }> {
    const execute = async (client: pg.PoolClient) => {
      const returnRes = await client.query(`
        SELECT * FROM order_returns
        WHERE id = $1 AND merchant_id = $2
        FOR UPDATE
      `, [params.returnId, params.merchantId]);

      if (returnRes.rows.length === 0) {
        throw new Error('RETURN_NOT_FOUND: Return not found or unauthorized for this merchant.');
      }

      const ret = returnRes.rows[0];
      let totalPassedUnits = 0;
      let totalRefundAmount = 0;

      // 1. Process each return item decision
      for (const d of params.itemDecisions) {
        const itemRes = await client.query(`
          SELECT ori.*, oi.unit_price, oi.taxable_amount, oi.cgst_amount, oi.sgst_amount, oi.igst_amount, oi.quantity as orig_qty
          FROM order_return_items ori
          JOIN order_items oi ON ori.order_item_id = oi.id
          WHERE ori.id = $1 AND ori.return_id = $2
          FOR UPDATE
        `, [d.returnItemId, ret.id]);

        if (itemRes.rows.length === 0) continue;
        const it = itemRes.rows[0];
        const qty = parseInt(it.quantity, 10);
        const qcStatus = d.qcPassed ? 'PASSED' : 'FAILED';

        if (d.qcPassed) {
          totalPassedUnits += qty;
          // Calculate proportional refund: unit_price * qty + GST
          const unitPrice = parseFloat(it.unit_price);
          const itemTotal = unitPrice * qty;
          totalRefundAmount += itemTotal;

          // Restock inventory directly into store_inventory
          await inventoryService.restockItem(ret.merchant_id, it.product_id, qty, client);

          await client.query(`
            UPDATE order_return_items
            SET qc_status = 'PASSED', restocked = TRUE
            WHERE id = $1
          `, [it.id]);

          await outboxService.stageEvent(client, {
            eventType: 'InventoryRestocked',
            aggregateType: 'INVENTORY',
            aggregateId: it.product_id,
            payload: {
              merchantId: ret.merchant_id,
              productId: it.product_id,
              quantityRestocked: qty,
              returnId: ret.id,
            },
          });
        } else {
          await client.query(`
            UPDATE order_return_items
            SET qc_status = 'FAILED', restocked = FALSE
            WHERE id = $1
          `, [it.id]);
        }
      }

      totalRefundAmount = +totalRefundAmount.toFixed(2);
      let refundRecord: RefundRecord | undefined;
      let clawbackResult: any;

      if (totalPassedUnits > 0 && totalRefundAmount > 0) {
        // 2. Issue Gateway Refund via refundService
        const refRes = await refundService.createRefund({
          orderId: ret.order_id,
          amount: totalRefundAmount,
          reasonCode: `RETURN_${ret.reason_code}`,
          reasonDescription: params.qcNotes || 'Return QC inspection passed.',
          clientOverride: client,
        });
        refundRecord = refRes.refund;

        // 3. Process Seller Clawback or Return Debit in seller_ledgers & General Ledger
        clawbackResult = await sellerSettlementService.processSellerClawback({
          orderId: ret.order_id,
          merchantId: ret.merchant_id,
          refundAmount: totalRefundAmount,
          clientOverride: client,
        });

        // 4. Update order_returns status to ACCEPTED
        await client.query(`
          UPDATE order_returns
          SET status = 'ACCEPTED',
              refund_id = $1,
              qc_notes = $2,
              completed_at = NOW()
          WHERE id = $3
        `, [refundRecord.id, params.qcNotes || null, ret.id]);

        await client.query(`
          UPDATE orders
          SET status = 'returned', updated_at = NOW()
          WHERE id = $1
        `, [ret.order_id]);

        await outboxService.stageEvent(client, {
          eventType: 'ReturnAccepted',
          aggregateType: 'RETURN',
          aggregateId: ret.id,
          payload: {
            returnId: ret.id,
            orderId: ret.order_id,
            refundId: refundRecord.id,
            refundAmount: totalRefundAmount,
          },
        });
      } else {
        // All items failed QC
        await client.query(`
          UPDATE order_returns
          SET status = 'REJECTED_QC',
              qc_notes = $1,
              completed_at = NOW()
          WHERE id = $2
        `, [params.qcNotes || 'All return items failed quality inspection.', ret.id]);

        await outboxService.stageEvent(client, {
          eventType: 'ReturnRejectedQC',
          aggregateType: 'RETURN',
          aggregateId: ret.id,
          payload: {
            returnId: ret.id,
            orderId: ret.order_id,
            reason: params.qcNotes || 'Failed QC',
          },
        });
      }

      const finalRecord = await this.getReturnById(ret.id, client);
      return {
        returnRecord: finalRecord!,
        refund: refundRecord,
        clawback: clawbackResult,
      };
    };

    if (params.clientOverride) {
      return execute(params.clientOverride);
    }
    return transaction(execute);
  }

  /**
   * Retrieve return request by ID
   * Protects PostgreSQL with Bloom Filter negative-lookup optimization
   */
  public async getReturnById(returnId: string, clientOverride?: pg.PoolClient): Promise<ReturnRecord | null> {
    // 1. Bloom Filter negative-lookup protection with cross-node propagation safety
    if (!(await bloomFilterService.mightContainSafe('returns', returnId))) {
      return null; // Definitely absent
    }

    const runner = clientOverride || getPool();
    const retRes = await runner.query(`
      SELECT * FROM order_returns
      WHERE id = $1
      LIMIT 1
    `, [returnId]);

    if (retRes.rows.length === 0) {
      bloomFilterService.recordFalsePositive();
      return null;
    }
    const r = retRes.rows[0];

    const itemsRes = await runner.query(`
      SELECT ori.*, p.name as product_name
      FROM order_return_items ori
      JOIN products p ON ori.product_id = p.id
      WHERE ori.return_id = $1
    `, [returnId]);

    return {
      id: r.id,
      returnNumber: r.return_number,
      orderId: r.order_id,
      userId: r.user_id,
      merchantId: r.merchant_id,
      status: r.status,
      reasonCode: r.reason_code,
      customerNotes: r.customer_notes || undefined,
      qcNotes: r.qc_notes || undefined,
      pickupTripId: r.pickup_trip_id || undefined,
      refundId: r.refund_id || undefined,
      requestedAt: new Date(r.requested_at).toISOString(),
      approvedAt: r.approved_at ? new Date(r.approved_at).toISOString() : undefined,
      receivedAt: r.received_at ? new Date(r.received_at).toISOString() : undefined,
      completedAt: r.completed_at ? new Date(r.completed_at).toISOString() : undefined,
      items: itemsRes.rows.map(it => ({
        id: it.id,
        orderItemId: it.order_item_id,
        productId: it.product_id,
        productName: it.product_name,
        quantity: parseInt(it.quantity, 10),
        qcStatus: it.qc_status,
        restocked: it.restocked,
      })),
    };
  }

  /**
   * Retrieve returns for an order
   */
  public async getReturnsForOrder(orderId: string): Promise<ReturnRecord[]> {
    const pool = getPool();
    const retRes = await pool.query(`
      SELECT id FROM order_returns
      WHERE order_id = $1
      ORDER BY requested_at DESC
    `, [orderId]);

    const results: ReturnRecord[] = [];
    for (const row of retRes.rows) {
      const rec = await this.getReturnById(row.id);
      if (rec) results.push(rec);
    }
    return results;
  }
}

export const returnService = new ReturnService();
