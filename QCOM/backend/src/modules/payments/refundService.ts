import crypto from 'crypto';
import pg from 'pg';
import { getPool, transaction } from '../../database/connection.js';
import { getPaymentProvider, PaymentProvider } from './paymentProvider.js';
import { outboxService } from '../outbox/outboxService.js';
import { ledgerService } from '../ledger/ledgerService.js';
import { bloomFilterService } from '../resilience/bloomFilterService.js';
import { CircuitBreaker } from '../resilience/circuitBreaker.js';
import { executeWithRetry, isTransientFailure } from '../resilience/retryPolicy.js';
import { toDecimal, roundCurrency, subtract, add } from '../pricing/money.js';

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

export interface PreparedRefundIntent {
  refundRow: any;
  paymentId: string;
  requestedAmount: number;
  durableIdempotencyKey: string;
  isFull: boolean;
  isDuplicate: boolean;
}

export class RefundService {
  private provider: PaymentProvider;
  private circuitBreaker: CircuitBreaker;
  private mutex = new AsyncKeyedMutex();

  constructor() {
    this.provider = getPaymentProvider();
    this.circuitBreaker = new CircuitBreaker({ name: 'PaymentGatewayRefund' });
  }

  public setProvider(provider: PaymentProvider): void {
    this.provider = provider;
  }

  public getProvider(): PaymentProvider {
    return this.provider;
  }

  private parseExplicitAmount(amount?: number): number | undefined {
    if (amount === undefined) return undefined;
    let bn;
    try {
      bn = toDecimal(amount);
    } catch {
      throw new Error('INVALID_REFUND_AMOUNT: Refund amount must be a valid finite number.');
    }
    if (bn.lte(0)) {
      throw new Error('INVALID_REFUND_AMOUNT: Refund amount must be greater than zero.');
    }
    return Number(roundCurrency(bn));
  }

  private assertIdempotencyCompatibility(
    existingRow: any,
    orderId: string,
    explicitAmount: number | undefined,
    idempotencyKey: string
  ): void {
    if (existingRow.order_id !== orderId) {
      throw new Error(
        `IDEMPOTENCY_KEY_CONFLICT: Idempotency key '${idempotencyKey}' was already used for another order.`
      );
    }
    if (explicitAmount !== undefined) {
      const existingAmt = Number(roundCurrency(existingRow.amount));
      if (existingAmt !== explicitAmount) {
        throw new Error(
          `IDEMPOTENCY_KEY_CONFLICT: Idempotency key '${idempotencyKey}' was already used for ₹${existingAmt.toFixed(2)}, cannot reuse for ₹${explicitAmount.toFixed(2)}.`
        );
      }
    }
  }

  /**
   * STEP A (Transactional Prep): Locks order, verifies ceiling, inserts durable PROCESSING refund intent.
   * Safe to run inside a larger DB transaction without performing any external HTTP calls.
   */
  public async prepareRefundIntent(
    params: CreateRefundParams,
    client: pg.PoolClient
  ): Promise<PreparedRefundIntent> {
    const explicitAmount = this.parseExplicitAmount(params.amount);

    if (params.idempotencyKey) {
      const existingLocked = await client.query(`
        SELECT * FROM refunds
        WHERE idempotency_key = $1
        LIMIT 1
        FOR UPDATE
      `, [params.idempotencyKey]);

      if (existingLocked.rows.length > 0) {
        this.assertIdempotencyCompatibility(
          existingLocked.rows[0],
          params.orderId,
          explicitAmount,
          params.idempotencyKey
        );
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
    if (order.payment_status === 'FAILED' || order.payment_status === 'REFUNDED') {
      throw new Error(`ORDER_NOT_REFUNDABLE: Order payment status '${order.payment_status}' cannot be refunded.`);
    }
    const orderTotalBn = toDecimal(order.total_amount);

    const priorRefundsRes = await client.query(`
      SELECT COALESCE(SUM(amount), 0) AS total_refunded
      FROM refunds
      WHERE order_id = $1 AND status IN ('REQUESTED', 'PENDING', 'PROCESSING', 'COMPLETED')
    `, [params.orderId]);

    const priorRefundedBn = toDecimal(priorRefundsRes.rows[0].total_refunded);
    const remainingRefundableBn = subtract(orderTotalBn, priorRefundedBn);
    const remainingRefundable = Number(roundCurrency(remainingRefundableBn));

    const requestedAmount = explicitAmount !== undefined ? explicitAmount : remainingRefundable;
    const requestedAmountBn = toDecimal(requestedAmount);
    if (requestedAmountBn.lte(0)) {
      throw new Error('INVALID_REFUND_AMOUNT: Refund amount must be greater than zero.');
    }

    if (requestedAmountBn.gt(toDecimal(remainingRefundable))) {
      throw new Error(
        `REFUND_CEILING_EXCEEDED: Requested refund amount ₹${requestedAmount} exceeds remaining refundable balance ₹${remainingRefundable} (Order Total: ₹${roundCurrency(orderTotalBn)}, Prior Refunded: ₹${roundCurrency(priorRefundedBn)}).`
      );
    }

    const isFull = add(priorRefundedBn, requestedAmountBn).gte(orderTotalBn.minus('0.01'));
    const refundType = params.refundType || (isFull ? 'FULL' : 'PARTIAL');

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
  }

  /**
   * STEP B + STEP C: Executes external gateway call OUTSIDE DB transactions, then reconciles in a short DB TX.
   */
  public async executePreparedRefund(opts: {
    prepared: PreparedRefundIntent;
    orderId: string;
    reasonCode: string;
    clientOverride?: pg.PoolClient;
  }): Promise<{ refund: RefundRecord; isDuplicate: boolean }> {
    const { prepared, orderId, reasonCode, clientOverride } = opts;

    if (prepared.isDuplicate) {
      if (prepared.refundRow?.id) {
        bloomFilterService.add('refunds', prepared.refundRow.id);
      }
      return {
        refund: this.mapRow(prepared.refundRow),
        isDuplicate: true,
      };
    }

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
              currency: 'INR',
              reason: reasonCode,
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
      if (providerRes.status === 'PROCESSED') {
        providerStatus = 'COMPLETED';
      } else if (providerRes.status === 'FAILED') {
        providerStatus = 'FAILED';
      } else {
        providerStatus = 'PROCESSING';
        outcomeUnknown = true;
      }
    } catch (provErr: any) {
      if (isTransientFailure(provErr) || (provErr.message && provErr.message.toLowerCase().includes('timeout'))) {
        providerStatus = 'PROCESSING';
        outcomeUnknown = true;
      } else {
        providerStatus = 'FAILED';
      }
    }

    const reconcileIntent = async (client: pg.PoolClient) => {
      const refCheck = await client.query(`
        SELECT * FROM refunds WHERE id = $1 FOR UPDATE
      `, [prepared.refundRow.id]);

      if (refCheck.rows.length === 0) {
        throw new Error(`REFUND_NOT_FOUND: Refund '${prepared.refundRow.id}' missing during reconciliation.`);
      }

      const currentRefund = refCheck.rows[0];
      if (currentRefund.status === 'COMPLETED' || currentRefund.status === 'FAILED') {
        return currentRefund;
      }

      const finalRes = await client.query(`
        UPDATE refunds
        SET status = $1::varchar,
            provider_refund_id = COALESCE($2, provider_refund_id),
            processed_at = CASE WHEN $1::varchar = 'COMPLETED' THEN NOW() ELSE processed_at END,
            recovery_lease_id = NULL,
            recovery_lease_expires_at = NULL,
            updated_at = NOW()
        WHERE id = $3
        RETURNING *
      `, [providerStatus, providerRefundId || null, prepared.refundRow.id]);

      if (providerStatus === 'COMPLETED') {
        const newPaymentStatus = prepared.isFull ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
        await client.query(`
          UPDATE orders
          SET payment_status = $1, updated_at = NOW()
          WHERE id = $2
        `, [newPaymentStatus, orderId]);

        if (reasonCode?.startsWith('ORDER_CANCELLED_') || reasonCode === 'CANCELLATION') {
          await ledgerService.recordPreFulfillmentCancellationRefund({
            orderId,
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
            orderId,
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
            orderId,
            amount: prepared.requestedAmount,
            note: 'PROVIDER_OUTCOME_UNKNOWN: Awaiting gateway status reconciliation.',
          },
        });
      }

      return finalRes.rows[0];
    };

    const reconciledRow = clientOverride
      ? await reconcileIntent(clientOverride)
      : await transaction(reconcileIntent);

    if (reconciledRow && reconciledRow.id) {
      bloomFilterService.add('refunds', reconciledRow.id);
    }

    return {
      refund: this.mapRow(reconciledRow),
      isDuplicate: false,
    };
  }

  /**
   * Initiates a refund for an order with idempotency and ceiling guarantees.
   * Completely decoupled into 3 phases:
   *   STEP A (Prepare): Short transaction to lock order, verify ceiling, insert durable PROCESSING intent, and commit.
   *   STEP B (Execute): External payment provider call completely outside of database transactions.
   *   STEP C (Reconcile): Short transaction to update refund record, order status, and stage outbox events.
   */
  public async createRefund(params: CreateRefundParams): Promise<{ refund: RefundRecord; isDuplicate: boolean }> {
    const explicitAmount = this.parseExplicitAmount(params.amount);

    if (params.idempotencyKey) {
      const pool = getPool();
      const existingRefund = await pool.query(`
        SELECT * FROM refunds
        WHERE idempotency_key = $1
        LIMIT 1
      `, [params.idempotencyKey]);

      if (existingRefund.rows.length > 0) {
        this.assertIdempotencyCompatibility(
          existingRefund.rows[0],
          params.orderId,
          explicitAmount,
          params.idempotencyKey
        );
        return {
          refund: this.mapRow(existingRefund.rows[0]),
          isDuplicate: true,
        };
      }
    }

    const prepared = params.clientOverride
      ? await this.prepareRefundIntent(params, params.clientOverride)
      : await this.mutex.runExclusive(params.orderId, () =>
          transaction((client) => this.prepareRefundIntent(params, client))
        );

    return this.executePreparedRefund({
      prepared,
      orderId: params.orderId,
      reasonCode: params.reasonCode,
      clientOverride: params.clientOverride,
    });
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
    const refRes = await pool.query(`SELECT * FROM refunds WHERE id = $1`, [refundId]);
    if (refRes.rows.length === 0) {
      throw new Error(`REFUND_NOT_FOUND: Refund '${refundId}' does not exist.`);
    }

    const refund = refRes.rows[0];
    if (refund.status === 'COMPLETED' || refund.status === 'FAILED') {
      return this.mapRow(refund);
    }

    let providerRefundId = refund.provider_refund_id;
    let providerStatus: 'COMPLETED' | 'FAILED' | 'PROCESSING' = 'PROCESSING';

    if (!providerRefundId && refund.idempotency_key && this.provider.getRefundByIdempotencyKey) {
      let match = await this.provider.getRefundByIdempotencyKey(refund.idempotency_key);
      if (!match) {
        // Ambiguous outcome safe recovery: re-present with exact same idempotency key
        try {
          match = await this.provider.createRefund({
            paymentId: refund.payment_id,
            amount: parseFloat(refund.amount),
            currency: 'INR',
            reason: refund.reason_code,
            idempotencyKey: refund.idempotency_key,
          });
        } catch {
          // If gateway still unavailable, retain PROCESSING
        }
      }
      if (match) {
        providerRefundId = match.providerRefundId;
        providerStatus = match.status === 'PROCESSED'
          ? 'COMPLETED'
          : match.status === 'FAILED'
            ? 'FAILED'
            : 'PROCESSING';
      } else {
        return this.mapRow(refund);
      }
    } else if (providerRefundId) {
      const statusRes = await this.provider.getRefundStatus(providerRefundId);
      providerStatus = statusRes.status === 'PROCESSED'
        ? 'COMPLETED'
        : statusRes.status === 'FAILED'
          ? 'FAILED'
          : 'PROCESSING';
    } else {
      return this.mapRow(refund);
    }

    const updatedStatus = providerStatus;

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
        SET status = $1::varchar,
            provider_refund_id = COALESCE($2, provider_refund_id),
            processed_at = CASE WHEN $1::varchar = 'COMPLETED' THEN NOW() ELSE processed_at END,
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
