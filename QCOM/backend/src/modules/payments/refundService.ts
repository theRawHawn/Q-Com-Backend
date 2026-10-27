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

export class AsyncKeyedMutex {
  private queues = new Map<string, Promise<void>>();

  public async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const current = this.queues.get(key) || Promise.resolve();
    let release: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.queues.set(key, current.then(() => next));

    await current;
    try {
      return await fn();
    } finally {
      release!();
      if (this.queues.get(key) === next) {
        this.queues.delete(key);
      }
    }
  }
}

export class RefundService {
  private provider: PaymentProvider;
  private circuitBreaker: CircuitBreaker;
  private mutex = new AsyncKeyedMutex();

  constructor() {
    this.provider = getPaymentProvider();
    this.circuitBreaker = new CircuitBreaker({ name: 'PaymentGatewayRefund' });
  }

  /**
   * Initiates a refund for an order with idempotency and ceiling guarantees.
   * Completely decoupled into 3 phases:
   *   STEP A (Prepare): Short transaction to lock order, verify ceiling, insert durable PROCESSING intent, and commit.
   *   STEP B (Execute): External payment provider call completely outside of database transactions.
   *   STEP C (Reconcile): Short transaction to update refund record, order status, and stage outbox events.
   */
  public async createRefund(params: CreateRefundParams): Promise<{ refund: RefundRecord; isDuplicate: boolean }> {
    // -----------------------------------------------------------------
    // STEP 0: Fast Idempotency Check
    // -----------------------------------------------------------------
    if (params.idempotencyKey) {
      const pool = getPool();
      const existingRefund = await pool.query(`
        SELECT * FROM refunds
        WHERE idempotency_key = $1
        LIMIT 1
      `, [params.idempotencyKey]);

      if (existingRefund.rows.length > 0) {
        return {
          refund: this.mapRow(existingRefund.rows[0]),
          isDuplicate: true,
        };
      }
    }

    // -----------------------------------------------------------------
    // STEP A: PREPARE INTENT (Short Database Transaction)
    // -----------------------------------------------------------------
    interface PreparedRefundIntent {
      refundRow: any;
      paymentId: string;
      requestedAmount: number;
      durableIdempotencyKey: string;
      isFull: boolean;
      isDuplicate: boolean;
    }

    const prepareIntent = async (client: pg.PoolClient): Promise<PreparedRefundIntent> => {
      // Re-verify idempotency with row lock
      if (params.idempotencyKey) {
        const existingLocked = await client.query(`
          SELECT * FROM refunds
          WHERE idempotency_key = $1
          LIMIT 1
          FOR UPDATE
        `, [params.idempotencyKey]);

        if (existingLocked.rows.length > 0) {
          return {
            refundRow: existingLocked.rows[0],
            paymentId: existingLocked.rows[0].payment_id,
            requestedAmount: parseFloat(existingLocked.rows[0].amount),
            durableIdempotencyKey: params.idempotencyKey,
            isFull: existingLocked.rows[0].refund_type === 'FULL',
            isDuplicate: true,
          };
        }
      }

      // Lock and retrieve order for atomic ceiling calculation
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

      // Check sum of prior refunds that are completed or in-flight (PROCESSING / PENDING)
      const priorRefundsRes = await client.query(`
        SELECT COALESCE(SUM(amount), 0) AS total_refunded
        FROM refunds
        WHERE order_id = $1 AND status IN ('PENDING', 'PROCESSING', 'COMPLETED')
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

      const isFull = (priorRefunded + requestedAmount) >= (orderTotal - 0.01);
      const refundType = params.refundType || (isFull ? 'FULL' : 'PARTIAL');

      // Find payment intent / transaction ID
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
      const durableIdempotencyKey = params.idempotencyKey || `ref_op_${params.orderId}_${requestedAmount}_${refundNumber}`;

        const rawCreator = params.createdBy || params.requestedBy;
        const isUuid = rawCreator && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawCreator);
        const createdByUuid = isUuid ? rawCreator : (order.user_id || null);

        // Insert durable refund intent in 'PROCESSING' state
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
          createdByUuid,
        ]);

      const refundRow = insRes.rows[0];

      // Stage Outbox Event: RefundInitiated
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

      return {
        refundRow,
        paymentId,
        requestedAmount,
        durableIdempotencyKey,
        isFull,
        isDuplicate: false,
      };
    };

    let prepared: PreparedRefundIntent;
    if (params.clientOverride) {
      prepared = await prepareIntent(params.clientOverride);
    } else {
      prepared = await this.mutex.runExclusive(params.orderId, () => transaction(prepareIntent));
    }

    if (prepared.isDuplicate) {
      return {
        refund: this.mapRow(prepared.refundRow),
        isDuplicate: true,
      };
    }

    // -----------------------------------------------------------------
    // STEP B: EXECUTE (External Payment Provider - OUTSIDE ANY TRANSACTION)
    // -----------------------------------------------------------------
    // No database connection or row locks are held during gateway I/O.
    let providerRefundId: string | undefined;
    let providerStatus: 'COMPLETED' | 'FAILED' | 'PROCESSING' = 'COMPLETED';
    let outcomeUnknown = false;

    try {
      const providerRes = await this.circuitBreaker.execute(async () => {
        return await executeWithRetry(
          async () => {
            return await this.provider.createRefund({
              paymentId: prepared.paymentId,
              amount: prepared.requestedAmount,
              reason: params.reasonCode,
              idempotencyKey: prepared.durableIdempotencyKey,
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
      providerStatus = providerRes.status === 'FAILED' ? 'FAILED' : 'COMPLETED';
    } catch (provErr: any) {
      // Critical Ambiguous Outcome Rule:
      // If the gateway timed out or failed with a transient error after dispatch,
      // we DO NOT assume failure and DO NOT allow duplicate attempts.
      // We preserve status as PROCESSING (unknown outcome) for status reconciliation.
      if (isTransientFailure(provErr) || (provErr.message && provErr.message.toLowerCase().includes('timeout'))) {
        providerStatus = 'PROCESSING';
        outcomeUnknown = true;
      } else {
        providerStatus = 'FAILED';
      }
    }

    // -----------------------------------------------------------------
    // STEP C: RECONCILE (Short Database Transaction)
    // -----------------------------------------------------------------
    const reconcileIntent = async (client: pg.PoolClient) => {
      // Lock refund row against concurrent webhook reconciliation
      const refCheck = await client.query(`
        SELECT * FROM refunds WHERE id = $1 FOR UPDATE
      `, [prepared.refundRow.id]);

      if (refCheck.rows.length === 0) {
        throw new Error(`REFUND_NOT_FOUND: Refund '${prepared.refundRow.id}' missing during reconciliation.`);
      }

      const currentRefund = refCheck.rows[0];
      // If already finalized (e.g. by concurrent webhook), return current record
      if (currentRefund.status === 'COMPLETED' || currentRefund.status === 'FAILED') {
        return currentRefund;
      }

      // Update refund status in PostgreSQL
      const finalRes = await client.query(`
        UPDATE refunds
        SET status = $1,
            provider_refund_id = COALESCE($2, provider_refund_id),
            processed_at = CASE WHEN $1 = 'COMPLETED' THEN NOW() ELSE processed_at END,
            recovery_lease_id = NULL,
            recovery_lease_expires_at = NULL,
            updated_at = NOW()
        WHERE id = $3
        RETURNING *
      `, [providerStatus, providerRefundId || null, prepared.refundRow.id]);

      // If completed, update order payment status & stage RefundCompleted outbox event
      if (providerStatus === 'COMPLETED') {
        const newPaymentStatus = prepared.isFull ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
        await client.query(`
          UPDATE orders
          SET payment_status = $1, updated_at = NOW()
          WHERE id = $2
        `, [newPaymentStatus, params.orderId]);

        // Post General Ledger Batch Q if pre-fulfillment cancellation
        if (params.reasonCode?.startsWith('ORDER_CANCELLED_') || params.reasonCode === 'CANCELLATION') {
          await ledgerService.recordPreFulfillmentCancellationRefund({
            orderId: params.orderId,
            refundId: prepared.refundRow.id,
            refundNumber: prepared.refundRow.refund_number,
            amount: prepared.requestedAmount,
            client,
          });
        }

        await outboxService.stageEvent(client, {
          eventType: 'RefundCompleted',
          aggregateType: 'REFUND',
          aggregateId: prepared.refundRow.id,
          payload: {
            refundId: prepared.refundRow.id,
            orderId: params.orderId,
            amount: prepared.requestedAmount,
            providerRefundId,
            isFull: prepared.isFull,
          },
        });
      } else if (outcomeUnknown) {
        await outboxService.stageEvent(client, {
          eventType: 'RefundInitiated',
          aggregateType: 'REFUND',
          aggregateId: prepared.refundRow.id,
          payload: {
            refundId: prepared.refundRow.id,
            orderId: params.orderId,
            amount: prepared.requestedAmount,
            note: 'PROVIDER_OUTCOME_UNKNOWN: Awaiting gateway status reconciliation.',
          },
        });
      }

      return finalRes.rows[0];
    };

    let reconciledRow: any;
    if (params.clientOverride) {
      reconciledRow = await reconcileIntent(params.clientOverride);
    } else {
      reconciledRow = await transaction(reconcileIntent);
    }

    // Register committed refund ID into Bloom Filter post-commit
    if (reconciledRow && reconciledRow.id) {
      bloomFilterService.add('refunds', reconciledRow.id);
    }

    return {
      refund: this.mapRow(reconciledRow),
      isDuplicate: false,
    };
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
  public async reconcileRefund(refundId: string, expectedLeaseOwner?: string): Promise<RefundRecord> {
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
      let match = await this.provider.getRefundByIdempotencyKey(refund.idempotency_key);
      if (!match) {
        // Ambiguous outcome safe recovery: re-present with exact same idempotency key
        try {
          match = await this.provider.createRefund({
            paymentId: refund.payment_id,
            amount: parseFloat(refund.amount),
            reason: refund.reason_code,
            idempotencyKey: refund.idempotency_key,
          });
        } catch {
          // If gateway still unavailable, retain PROCESSING
        }
      }
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

    const finalRow = await transaction(async (client) => {
      const lockRes = await client.query(`SELECT * FROM refunds WHERE id = $1 FOR UPDATE`, [refundId]);
      if (lockRes.rows.length === 0) return refund;
      const current = lockRes.rows[0];
      if (current.status === 'COMPLETED' || current.status === 'FAILED') {
        return current;
      }

      // Stale-worker fencing check: If an expected lease owner was specified, verify that the lease
      // hasn't expired and been claimed by another active worker.
      if (expectedLeaseOwner && current.recovery_lease_id && current.recovery_lease_id !== expectedLeaseOwner) {
        const leaseExpiry = current.recovery_lease_expires_at ? new Date(current.recovery_lease_expires_at).getTime() : 0;
        if (leaseExpiry > Date.now()) {
          console.warn(`[refundService.reconcileRefund] Stale worker commit aborted: Worker '${expectedLeaseOwner}' lost lease to '${current.recovery_lease_id}'.`);
          return current;
        }
      }

      const finalRes = await client.query(`
        UPDATE refunds
        SET status = $1,
            provider_refund_id = COALESCE($2, provider_refund_id),
            processed_at = CASE WHEN $1 = 'COMPLETED' THEN NOW() ELSE processed_at END,
            recovery_lease_id = NULL,
            recovery_lease_expires_at = NULL,
            updated_at = NOW()
        WHERE id = $3
        RETURNING *
      `, [updatedStatus, providerRefundId || null, refundId]);

      if (updatedStatus === 'COMPLETED') {
        await client.query(`
          UPDATE orders
          SET payment_status = CASE WHEN $1 = 'FULL' THEN 'REFUNDED' ELSE 'PARTIALLY_REFUNDED' END,
              updated_at = NOW()
          WHERE id = $2
        `, [refund.refund_type, refund.order_id]);

        if (refund.reason_code?.startsWith('ORDER_CANCELLED_') || refund.reason_code === 'CANCELLATION') {
          await ledgerService.recordPreFulfillmentCancellationRefund({
            orderId: refund.order_id,
            refundId: refund.id,
            refundNumber: refund.refund_number,
            amount: parseFloat(refund.amount),
            client,
          });
        }
      }

      return finalRes.rows[0];
    });

    return this.mapRow(finalRow);
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
