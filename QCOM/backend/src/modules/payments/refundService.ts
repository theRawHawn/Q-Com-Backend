import crypto from 'crypto';
import pg from 'pg';
import { getPool, transaction } from '../../database/connection.js';
import { getPaymentProvider, PaymentProvider } from './paymentProvider.js';
import { outboxService } from '../outbox/outboxService.js';
import { ledgerService } from '../ledger/ledgerService.js';
import { bloomFilterService } from '../resilience/bloomFilterService.js';
import { CircuitBreaker } from '../resilience/circuitBreaker.js';
import { executeWithRetry, isTransientFailure } from '../resilience/retryPolicy.js';

export interface CreateRefundParams {
  orderId: string;
  amount?: number;
  reasonCode: string;
  reasonDescription?: string;
  refundType?: 'FULL' | 'PARTIAL';
  idempotencyKey?: string;
  createdBy?: string;
  requestedBy?: string;
  clientOverride?: pg.PoolClient;
}

export interface RefundRecord {
  id: string;
  refundNumber: string;
  orderId: string;
  paymentId?: string;
  amount: number;
  currency: string;
  reasonCode: string;
  reasonDescription?: string;
  refundType: 'FULL' | 'PARTIAL';
  status: 'REQUESTED' | 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'REVERSED';
  providerRefundId?: string;
  idempotencyKey?: string;
  createdBy?: string;
  processedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export class RefundService {
  private provider: PaymentProvider;
  private circuitBreaker: CircuitBreaker;

  constructor() {
    this.provider = getPaymentProvider();
    this.circuitBreaker = new CircuitBreaker({ name: 'PaymentGatewayRefund' });
  }

  /**
   * Initiates a refund for an order with idempotency and ceiling guarantees
   */
  public async createRefund(params: CreateRefundParams): Promise<{ refund: RefundRecord; isDuplicate: boolean }> {
    const execute = async (client: pg.PoolClient) => {
      // 1. Idempotency Check
      if (params.idempotencyKey) {
        const existingRefund = await client.query(`
          SELECT * FROM refunds
          WHERE idempotency_key = $1
          LIMIT 1
        `, [params.idempotencyKey]);

        if (existingRefund.rows.length > 0) {
          const r = existingRefund.rows[0];
          return {
            refund: this.mapRow(r),
            isDuplicate: true,
          };
        }
      }

      // 2. Lock and retrieve order
      const orderRes = await client.query(`
        SELECT id, user_id, merchant_id, total_amount, payment_status, status
        FROM orders
        WHERE id = $1
        FOR UPDATE
      `, [params.orderId]);

      if (orderRes.rows.length === 0) {
        throw new Error(`ORDER_NOT_FOUND: Order '${params.orderId}' does not exist.`);
      }

      const order = orderRes.rows[0];
      const orderTotal = parseFloat(order.total_amount);

      // Check sum of prior successful refunds
      const priorRefundsRes = await client.query(`
        SELECT COALESCE(SUM(amount), 0) AS total_refunded
        FROM refunds
        WHERE order_id = $1 AND status IN ('PROCESSING', 'COMPLETED')
      `, [params.orderId]);

      const priorRefunded = parseFloat(priorRefundsRes.rows[0].total_refunded);
      const remainingRefundable = +(orderTotal - priorRefunded).toFixed(2);

      const requestedAmount = params.amount !== undefined ? +params.amount.toFixed(2) : remainingRefundable;
      if (requestedAmount <= 0) {
        throw new Error('INVALID_REFUND_AMOUNT: Refund amount must be greater than zero.');
      }

      if (requestedAmount > remainingRefundable) {
        throw new Error(
          `REFUND_CEILING_EXCEEDED: Requested refund amount ₹${requestedAmount} exceeds remaining refundable balance ₹${remainingRefundable} (Order Total: ₹${orderTotal}, Prior Refunded: ₹${priorRefunded}).`
        );
      }

      // Determine refund type
      const isFull = (priorRefunded + requestedAmount) >= (orderTotal - 0.01);
      const refundType = params.refundType || (isFull ? 'FULL' : 'PARTIAL');

      // 3. Find payment intent / transaction ID if paid
      const intentRes = await client.query(`
        SELECT id, payment_order_id, provider_payment_id
        FROM payment_intents
        WHERE order_id = $1
        ORDER BY created_at DESC
        LIMIT 1
      `, [params.orderId]);

      const paymentId = intentRes.rows.length > 0
        ? (intentRes.rows[0].provider_payment_id || intentRes.rows[0].payment_order_id)
        : `pay_${crypto.randomBytes(6).toString('hex')}`;

      const refundNumber = `REF_${Date.now()}_${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
      // Phase 4: Enforce durable refund identity & stable provider idempotency key across all attempts
      const durableIdempotencyKey = params.idempotencyKey || `ref_op_${params.orderId}_${requestedAmount}_${refundNumber}`;

      // 4. Insert refund record into database
      const insRes = await client.query(`
        INSERT INTO refunds (
          refund_number, order_id, payment_id, amount, currency,
          reason_code, reason_description, refund_type, status,
          idempotency_key, created_by
        )
        VALUES ($1, $2, $3, $4, 'INR', $5, $6, $7, 'PROCESSING', $8, $9)
        RETURNING *
      `, [
        refundNumber,
        params.orderId,
        paymentId,
        requestedAmount,
        params.reasonCode,
        params.reasonDescription || null,
        refundType,
        durableIdempotencyKey,
        params.createdBy || params.requestedBy || null,
      ]);

      const refundRow = insRes.rows[0];

      // 5. Stage Outbox Event: RefundInitiated
      await outboxService.stageEvent(client, {
        eventType: 'RefundInitiated',
        aggregateType: 'REFUND',
        aggregateId: refundRow.id,
        payload: {
          refundId: refundRow.id,
          refundNumber,
          orderId: params.orderId,
          amount: requestedAmount,
          refundType,
          idempotencyKey: durableIdempotencyKey,
        },
      });

      // 6. Call Payment Provider Refund Adapter with Circuit Breaker & Safe Transient Retry
      let providerRefundId: string | undefined;
      let refundStatus: 'COMPLETED' | 'FAILED' | 'PROCESSING' = 'COMPLETED';
      let outcomeUnknown = false;

      try {
        const providerRes = await this.circuitBreaker.execute(async () => {
          return await executeWithRetry(
            async () => {
              return await this.provider.createRefund({
                paymentId,
                amount: requestedAmount,
                reason: params.reasonCode,
                idempotencyKey: durableIdempotencyKey,
              });
            },
            {
              maxAttempts: 3,
              baseDelayMs: 500,
              maxDelayMs: 3000,
              shouldRetry: (err) => isTransientFailure(err),
            }
          );
        });

        providerRefundId = providerRes.providerRefundId;
        refundStatus = providerRes.status === 'FAILED' ? 'FAILED' : 'COMPLETED';
      } catch (provErr: any) {
        // NON-NEGOTIABLE FINANCIAL SAFETY:
        // If external provider call timed out or failed with a transient error after dispatch,
        // we DO NOT assume it failed and DO NOT allow duplicate refund attempts.
        // Instead, we mark as PROCESSING (unknown outcome) requiring status reconciliation.
        if (isTransientFailure(provErr) || (provErr.message && provErr.message.toLowerCase().includes('timeout'))) {
          refundStatus = 'PROCESSING';
          outcomeUnknown = true;
        } else {
          refundStatus = 'FAILED';
        }
      }

      // 7. Update refund status in PostgreSQL
      const finalRes = await client.query(`
        UPDATE refunds
        SET status = $1,
            provider_refund_id = $2,
            processed_at = CASE WHEN $1 = 'COMPLETED' THEN NOW() ELSE processed_at END,
            updated_at = NOW()
        WHERE id = $3
        RETURNING *
      `, [refundStatus, providerRefundId || null, refundRow.id]);

      // 8. Update Order Payment Status if successful
      if (refundStatus === 'COMPLETED') {
        const newPaymentStatus = isFull ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
        await client.query(`
          UPDATE orders
          SET payment_status = $1, updated_at = NOW()
          WHERE id = $2
        `, [newPaymentStatus, params.orderId]);

        // Stage Outbox Event: RefundCompleted
        await outboxService.stageEvent(client, {
          eventType: 'RefundCompleted',
          aggregateType: 'REFUND',
          aggregateId: refundRow.id,
          payload: {
            refundId: refundRow.id,
            orderId: params.orderId,
            amount: requestedAmount,
            providerRefundId,
            isFull,
          },
        });
      } else if (outcomeUnknown) {
        // Stage Outbox Event: RefundPendingReconciliation
        await outboxService.stageEvent(client, {
          eventType: 'RefundInitiated',
          aggregateType: 'REFUND',
          aggregateId: refundRow.id,
          payload: {
            refundId: refundRow.id,
            orderId: params.orderId,
            amount: requestedAmount,
            note: 'PROVIDER_OUTCOME_UNKNOWN: Awaiting gateway status reconciliation.',
          },
        });
      }

      const mappedRefund = this.mapRow(finalRes.rows[0]);
      return {
        refund: mappedRefund,
        isDuplicate: false,
      };
    };

    let result: { refund: RefundRecord; isDuplicate: boolean };
    if (params.clientOverride) {
      result = await execute(params.clientOverride);
    } else {
      result = await transaction(execute);
    }

    // Register committed refund ID into Bloom Filter post-commit
    if (result && result.refund && result.refund.id) {
      bloomFilterService.add('refunds', result.refund.id);
    }

    return result;
  }

  /**
   * Fetch refund by ID with Bloom Filter negative lookup optimization
   */
  public async getRefundById(refundId: string): Promise<RefundRecord | null> {
    // 1. Bloom Filter negative-lookup protection with cross-node propagation safety
    if (!(await bloomFilterService.mightContainSafe('refunds', refundId))) {
      return null; // Definitely does not exist
    }

    const pool = getPool();
    const res = await pool.query(`
      SELECT * FROM refunds
      WHERE id = $1
      LIMIT 1
    `, [refundId]);

    if (res.rows.length === 0) {
      bloomFilterService.recordFalsePositive();
      return null;
    }
    return this.mapRow(res.rows[0]);
  }

  /**
   * Reconciles a refund in PROCESSING (unknown outcome) state by querying the provider.
   * Protects against duplicate refunds after transient network timeouts.
   */
  public async reconcileRefund(refundId: string): Promise<RefundRecord> {
    const pool = getPool();
    const refRes = await pool.query(`SELECT * FROM refunds WHERE id = $1 FOR UPDATE`, [refundId]);
    if (refRes.rows.length === 0) {
      throw new Error(`REFUND_NOT_FOUND: Refund '${refundId}' does not exist.`);
    }

    const refund = refRes.rows[0];
    if (refund.status === 'COMPLETED' || refund.status === 'FAILED') {
      return this.mapRow(refund);
    }

    let providerRefundId = refund.provider_refund_id;
    let providerStatus: 'PROCESSED' | 'PENDING' | 'FAILED' = 'PROCESSED';

    if (!providerRefundId && refund.idempotency_key && this.provider.getRefundByIdempotencyKey) {
      const match = await this.provider.getRefundByIdempotencyKey(refund.idempotency_key);
      if (match) {
        providerRefundId = match.providerRefundId;
        providerStatus = match.status;
      } else {
        return this.mapRow(refund);
      }
    } else if (providerRefundId) {
      const statusRes = await this.provider.getRefundStatus(providerRefundId);
      providerStatus = statusRes.status;
    } else {
      return this.mapRow(refund);
    }

    const updatedStatus = providerStatus === 'PROCESSED' ? 'COMPLETED' : providerStatus;

    const finalRes = await pool.query(`
      UPDATE refunds
      SET status = $1,
          provider_refund_id = COALESCE($2, provider_refund_id),
          processed_at = CASE WHEN $1 = 'COMPLETED' THEN NOW() ELSE processed_at END,
          updated_at = NOW()
      WHERE id = $3
      RETURNING *
    `, [updatedStatus, providerRefundId || null, refundId]);

    if (updatedStatus === 'COMPLETED') {
      await pool.query(`
        UPDATE orders
        SET payment_status = CASE WHEN $1 = 'FULL' THEN 'REFUNDED' ELSE 'PARTIALLY_REFUNDED' END,
            updated_at = NOW()
        WHERE id = $2
      `, [refund.refund_type, refund.order_id]);
    }

    return this.mapRow(finalRes.rows[0]);
  }

  /**
   * Fetch all refunds for an order
   */
  public async getRefundsForOrder(orderId: string): Promise<RefundRecord[]> {
    const pool = getPool();
    const res = await pool.query(`
      SELECT * FROM refunds
      WHERE order_id = $1
      ORDER BY created_at DESC
    `, [orderId]);

    return res.rows.map(r => this.mapRow(r));
  }

  private mapRow(r: any): RefundRecord {
    return {
      id: r.id,
      refundNumber: r.refund_number,
      orderId: r.order_id,
      paymentId: r.payment_id || undefined,
      amount: parseFloat(r.amount),
      currency: r.currency || 'INR',
      reasonCode: r.reason_code,
      reasonDescription: r.reason_description || undefined,
      refundType: r.refund_type,
      status: r.status,
      providerRefundId: r.provider_refund_id || undefined,
      idempotencyKey: r.idempotency_key || undefined,
      createdBy: r.created_by || undefined,
      processedAt: r.processed_at ? new Date(r.processed_at).toISOString() : undefined,
      createdAt: new Date(r.created_at).toISOString(),
      updatedAt: new Date(r.updated_at).toISOString(),
    };
  }
}

export const refundService = new RefundService();
