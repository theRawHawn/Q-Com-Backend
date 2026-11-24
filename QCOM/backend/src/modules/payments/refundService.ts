import crypto from 'crypto';
import pg from 'pg';
import BigNumber from 'bignumber.js';
import { getPool, transaction } from '../../database/connection.js';
import { env } from '../../config/env.js';
import { getPaymentProvider, PaymentProvider, paymentProviderRegistry } from './paymentProvider.js';
import { transitionPaymentIntentState, PaymentState } from './paymentStateMachine.js';
import { paymentLogger } from './paymentLogger.js';
import { outboxService } from '../outbox/outboxService.js';
import { ledgerService, isCodPaymentMethod } from '../ledger/ledgerService.js';
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
  status: 'REQUESTED' | 'PENDING' | 'PROCESSING' | 'UNKNOWN' | 'COMPLETED' | 'FAILED' | 'REQUIRES_REVIEW';
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
  paymentIntentId?: string;
  providerId?: string;
  isCod?: boolean;
  capturedCeiling: number;
  requestedAmount: number;
  durableIdempotencyKey: string;
  isFull: boolean;
  isDuplicate: boolean;
}

function computeNextRetryAt(attempts: number): Date {
  const exp = Math.min(Math.max(attempts, 1), 8);
  const delaySec = Math.min(1800, 15 * Math.pow(2, exp - 1));
  return new Date(Date.now() + delaySec * 1000);
}

export class RefundService {
  private provider: PaymentProvider | null = null;
  private circuitBreaker: CircuitBreaker;
  private mutex = new AsyncKeyedMutex();

  constructor() {
    this.circuitBreaker = new CircuitBreaker({ name: 'PaymentGatewayRefund' });
  }

  public setProvider(provider: PaymentProvider): void {
    this.provider = provider;
  }

  public resetProvider(): void {
    this.provider = null;
  }

  public getProvider(providerId?: string): PaymentProvider {
    const activeMode = process.env.PAYMENT_MODE || env.PAYMENT_MODE;
    if (providerId) {
      const normalized = providerId.toLowerCase().trim();
      if (normalized === 'none' || normalized === 'unselected') {
        return paymentProviderRegistry.getProvider('none');
      }
      if (this.provider && this.provider.providerId === providerId) {
        return this.provider;
      }
      return paymentProviderRegistry.getProvider(providerId);
    }
    if (this.provider && activeMode !== 'none') {
      return this.provider;
    }
    return getPaymentProvider();
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

  private async recordRefundTransaction(
    client: pg.PoolClient,
    params: {
      orderId: string;
      refundId: string;
      paymentIntentId?: string;
      status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';
      amount: number;
      providerId: string;
      externalReference?: string | null;
      idempotencyKey?: string;
    }
  ): Promise<void> {
    const useSavepoint = !(getPool() as any).__pgMemDb;
    if (useSavepoint) {
      await client.query(`SAVEPOINT sp_refund_tx`);
    } else {
      const tbl = await client.query(
        `SELECT 1 FROM information_schema.tables WHERE table_name = 'payment_transactions'`
      );
      if (tbl.rows.length === 0) {
        return;
      }
    }
    try {
      await client.query(
        `INSERT INTO payment_transactions (
           internal_reference, order_id, payment_intent_id, refund_id,
           transaction_type, status, amount, currency, provider_id,
           external_reference, idempotency_key
         )
         VALUES ($1, $2, $3, $4, 'REFUND', $5, $6, 'INR', $7, $8, $9)`,
        [
          `rtx_${Date.now()}_${crypto.randomBytes(5).toString('hex')}`,
          params.orderId,
          params.paymentIntentId || null,
          params.refundId,
          params.status,
          params.amount,
          params.providerId || 'UNSELECTED',
          params.externalReference || null,
          params.idempotencyKey || null,
        ]
      );
      if (useSavepoint) {
        await client.query(`RELEASE SAVEPOINT sp_refund_tx`);
      }
    } catch {
      if (useSavepoint) {
        await client.query(`ROLLBACK TO SAVEPOINT sp_refund_tx`);
      }
    }
  }

  /**
   * Synchronizes parent order payment_status and payment_intent status accurately
   * across single full refunds AND cumulative multiple partial refunds.
   */
  private async synchronizeCumulativeRefundStatus(
    client: pg.PoolClient,
    orderId: string,
    capturedCeiling: number
  ): Promise<boolean> {
    const sumRes = await client.query(
      `SELECT COALESCE(SUM(amount), 0) AS completed_total
       FROM refunds
       WHERE order_id = $1 AND status = 'COMPLETED'`,
      [orderId]
    );
    const completedTotalBn = toDecimal(sumRes.rows[0].completed_total);
    const isNowFullyRefunded = completedTotalBn.gte(toDecimal(capturedCeiling).minus('0.01'));
    const nextOrderPaymentStatus = isNowFullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED';

    await client.query(
      `UPDATE orders
       SET payment_status = $1, updated_at = NOW()
       WHERE id = $2`,
      [nextOrderPaymentStatus, orderId]
    );

    const intentRes = await client.query(
      `SELECT id, status
       FROM payment_intents
       WHERE order_id = $1
         AND status IN ('CAPTURED', 'REFUND_PENDING', 'PARTIALLY_REFUNDED')
       ORDER BY created_at DESC
       LIMIT 1
       FOR UPDATE`,
      [orderId]
    );

    if (intentRes.rows.length > 0) {
      const targetIntentState: PaymentState = isNowFullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
      try {
        await transitionPaymentIntentState(client, intentRes.rows[0].id, targetIntentState);
      } catch {
        // Ignore if already in terminal REFUNDED
      }
    }

    return isNowFullyRefunded;
  }

  /**
   * STEP A (Transactional Prep): Locks order, verifies captured payment & cumulative ceiling,
   * inserts durable PROCESSING refund intent. Safe inside a larger DB transaction without external calls.
   */
  public async prepareRefundIntent(
    params: CreateRefundParams,
    client: pg.PoolClient
  ): Promise<PreparedRefundIntent> {
    const explicitAmount = this.parseExplicitAmount(params.amount);

    if (params.idempotencyKey) {
      const existingLocked = await client.query(
        `SELECT * FROM refunds
         WHERE idempotency_key = $1
         LIMIT 1
         FOR UPDATE`,
        [params.idempotencyKey]
      );

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
          capturedCeiling: parseFloat(existingLocked.rows[0].amount),
          requestedAmount: parseFloat(existingLocked.rows[0].amount),
          durableIdempotencyKey: params.idempotencyKey,
          isFull: existingLocked.rows[0].refund_type === 'FULL',
          isDuplicate: true,
        };
      }
    }

    const orderRes = await client.query(
      `SELECT id, user_id, merchant_id, total_amount, payment_status, payment_method, status
       FROM orders
       WHERE id = $1
       FOR UPDATE`,
      [params.orderId]
    );

    if (orderRes.rows.length === 0) {
      throw new Error(`ORDER_NOT_FOUND: Order '${params.orderId}' does not exist.`);
    }

    const order = orderRes.rows[0];
    const isCodOrder = isCodPaymentMethod(order.payment_method);
    if (!['PAID', 'PARTIALLY_REFUNDED', 'REFUND_PENDING'].includes(order.payment_status)) {
      throw new Error(`ORDER_NOT_REFUNDABLE: Order payment status '${order.payment_status}' cannot be refunded.`);
    }

    const orderTotalBn = toDecimal(order.total_amount);

    let capturedCeilingBn: BigNumber;
    let paymentId: string;
    let paymentIntentId: string | undefined;
    let providerId: string | undefined;

    if (isCodOrder) {
      // COD refunds require verified customer cash collection (never refund cancelled/uncollected COD orders or synthesize online gateway payments)
      let collectedCodBn = new BigNumber(0);
      try {
        const codColRes = await client.query(
          `SELECT collected_amount FROM cod_collections WHERE order_id = $1 AND status <> 'REVERSED' LIMIT 1`,
          [params.orderId]
        );
        if (codColRes.rows.length > 0) {
          collectedCodBn = toDecimal(codColRes.rows[0].collected_amount || 0);
        }
      } catch {
        // Pre-030 schema fallback
      }
      if (collectedCodBn.lte(0)) {
        const tripCodRes = await client.query(
          `SELECT cod_collected_amount FROM delivery_trips WHERE order_id = $1 AND trip_type = 'FORWARD' AND COALESCE(cod_collected_amount, 0) > 0 LIMIT 1`,
          [params.orderId]
        );
        if (tripCodRes.rows.length > 0) {
          collectedCodBn = toDecimal(tripCodRes.rows[0].cod_collected_amount || 0);
        }
      }
      if (collectedCodBn.lte(0) || order.status === 'cancelled') {
        throw new Error('COD_REFUND_NO_COLLECTION: Cannot issue cash refund for an uncollected or pre-delivery cancelled COD order.');
      }
      capturedCeilingBn = BigNumber.min(orderTotalBn, collectedCodBn);
      paymentId = `cod_coll_${params.orderId.slice(0, 16)}`;
      providerId = 'COD_BANK_TRANSFER';
    } else {
      // Inspect authoritative captured online payment evidence
      const receiptRes = await client.query(
        `SELECT transaction_id, amount
         FROM payment_receipts
         WHERE order_id = $1 AND status = 'SUCCESS'
         LIMIT 1`,
        [params.orderId]
      );

      const intentRes = await client.query(
        `SELECT id, payment_order_id, provider_payment_id, active_provider, amount, status
         FROM payment_intents
         WHERE order_id = $1
         ORDER BY created_at DESC
         LIMIT 1`,
        [params.orderId]
      );

      const capturedIntent = intentRes.rows.find((r: any) =>
        ['CAPTURED', 'REFUND_PENDING', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(r.status)
      ) || intentRes.rows[0];

      const isProduction = (process.env.NODE_ENV || env.NODE_ENV) === 'production';
      if (isProduction && receiptRes.rows.length === 0 && !capturedIntent?.provider_payment_id) {
        throw new Error('NO_CAPTURED_PAYMENT_FOUND: Cannot issue refund without verified payment capture proof.');
      }

      const receiptAmount = receiptRes.rows.length > 0 ? parseFloat(receiptRes.rows[0].amount) : null;
      const intentAmount = capturedIntent?.amount ? parseFloat(capturedIntent.amount) : null;
      const capturedCeilingNum = receiptAmount ?? intentAmount ?? Number(roundCurrency(orderTotalBn));
      capturedCeilingBn = toDecimal(Math.min(Number(roundCurrency(orderTotalBn)), capturedCeilingNum));
      paymentId =
        receiptRes.rows[0]?.transaction_id ||
        capturedIntent?.provider_payment_id ||
        capturedIntent?.payment_order_id ||
        `pay_verified_${params.orderId.slice(0, 12)}`;
      paymentIntentId = capturedIntent?.id;
      providerId = capturedIntent?.active_provider;
    }

    // Reserve ceiling against all non-failed refunds (pending, processing, unknown, completed, review)
    const priorRefundsRes = await client.query(
      `SELECT COALESCE(SUM(amount), 0) AS total_refunded
       FROM refunds
       WHERE order_id = $1
         AND status IN ('REQUESTED', 'PENDING', 'PROCESSING', 'UNKNOWN', 'COMPLETED', 'REQUIRES_REVIEW')`,
      [params.orderId]
    );

    const priorRefundedBn = toDecimal(priorRefundsRes.rows[0].total_refunded);
    const remainingRefundableBn = subtract(capturedCeilingBn, priorRefundedBn);
    const remainingRefundable = Number(roundCurrency(remainingRefundableBn));

    const requestedAmount = explicitAmount !== undefined ? explicitAmount : remainingRefundable;
    const requestedAmountBn = toDecimal(requestedAmount);
    if (requestedAmountBn.lte(0)) {
      throw new Error('INVALID_REFUND_AMOUNT: Refund amount must be greater than zero.');
    }

    if (requestedAmountBn.gt(toDecimal(remainingRefundable))) {
      throw new Error(
        `REFUND_CEILING_EXCEEDED: Requested refund amount ₹${requestedAmount} exceeds remaining refundable balance ₹${remainingRefundable} (Captured Ceiling: ₹${roundCurrency(capturedCeilingBn)}, Prior Refunded: ₹${roundCurrency(priorRefundedBn)}).`
      );
    }

    const isFull = add(priorRefundedBn, requestedAmountBn).gte(capturedCeilingBn.minus('0.01'));
    const refundType = params.refundType || (isFull ? 'FULL' : 'PARTIAL');

    const refundNumber = `REF_${Date.now()}_${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const durableIdempotencyKey = params.idempotencyKey || `ref_op_${params.orderId}_${requestedAmount}_${refundNumber}`;

    const rawCreator = params.createdBy || params.requestedBy;
    const isUuid = rawCreator && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawCreator);
    const createdByUuid = isUuid ? rawCreator : (order.user_id || null);

    const insRes = await client.query(
      `INSERT INTO refunds (
         refund_number, order_id, payment_id, amount, currency,
         reason_code, reason_description, refund_type, status,
         idempotency_key, created_by
       )
       VALUES ($1, $2, $3, $4, 'INR', $5, $6, $7, 'PROCESSING', $8, $9)
       RETURNING *`,
      [
        refundNumber,
        params.orderId,
        paymentId,
        requestedAmount,
        params.reasonCode,
        params.reasonDescription || null,
        refundType,
        durableIdempotencyKey,
        createdByUuid,
      ]
    );

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

    paymentLogger.increment('refundInitiated');
    paymentLogger.log('info', 'REFUND_PREPARED', {
      orderId: params.orderId,
      refundId: refundRow.id,
      paymentIntentId,
      providerId,
    }, { amount: requestedAmount, refundType, isCod: isCodOrder });

    return {
      refundRow,
      paymentId,
      paymentIntentId,
      providerId,
      isCod: isCodOrder,
      capturedCeiling: Number(roundCurrency(capturedCeilingBn)),
      requestedAmount,
      durableIdempotencyKey,
      isFull,
      isDuplicate: false,
    };
  }

  /**
   * STEP B + STEP C: Executes external gateway call OUTSIDE DB transactions, then reconciles in a short DB TX.
   * For COD orders, skips online payment gateways and settles via internal COD bank/UPI refund accounting.
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

    const provider = prepared.isCod ? null : this.getProvider(prepared.providerId);
    const activeProviderId = prepared.isCod ? 'COD_BANK_TRANSFER' : provider!.providerId;

    let providerRefundId: string | undefined;
    let providerStatus: 'COMPLETED' | 'FAILED' | 'PROCESSING' = 'COMPLETED';
    let outcomeUnknown = false;

    if (prepared.isCod) {
      providerRefundId = `cod_bank_rfnd_${crypto.randomBytes(6).toString('hex')}`;
      providerStatus = 'COMPLETED';
    } else {
      try {
        const providerRes = await this.circuitBreaker.execute(async () => {
          return await executeWithRetry(
            async () => {
              return await provider!.createRefund({
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
    }

    const reconcileIntent = async (client: pg.PoolClient) => {
      const refCheck = await client.query(
        `SELECT * FROM refunds WHERE id = $1 FOR UPDATE`,
        [prepared.refundRow.id]
      );

      if (refCheck.rows.length === 0) {
        throw new Error(`REFUND_NOT_FOUND: Refund '${prepared.refundRow.id}' missing during reconciliation.`);
      }

      const currentRefund = refCheck.rows[0];
      if (currentRefund.status === 'COMPLETED' || currentRefund.status === 'FAILED') {
        return currentRefund;
      }

      const failureClass = outcomeUnknown ? 'AMBIGUOUS' : providerStatus === 'FAILED' ? 'PERMANENT' : null;
      const nextRetryAt = outcomeUnknown ? computeNextRetryAt(1) : null;

      const finalRes = await client.query(
        `UPDATE refunds
         SET status = $1::varchar,
             provider_refund_id = COALESCE($2, provider_refund_id),
             processed_at = CASE WHEN $1::varchar = 'COMPLETED' THEN NOW() ELSE processed_at END,
             failure_classification = COALESCE($3, failure_classification),
             next_retry_at = $4,
             recovery_lease_id = NULL,
             recovery_lease_expires_at = NULL,
             version = version + 1,
             updated_at = NOW()
         WHERE id = $5
         RETURNING *`,
        [providerStatus, providerRefundId || null, failureClass, nextRetryAt, prepared.refundRow.id]
      );

      if (providerStatus === 'COMPLETED') {
        const isFullyRefunded = await this.synchronizeCumulativeRefundStatus(
          client,
          orderId,
          prepared.capturedCeiling
        );

        await this.recordRefundTransaction(client, {
          orderId,
          refundId: prepared.refundRow.id,
          paymentIntentId: prepared.paymentIntentId,
          status: 'SUCCEEDED',
          amount: prepared.requestedAmount,
          providerId: activeProviderId,
          externalReference: providerRefundId || null,
          idempotencyKey: prepared.durableIdempotencyKey,
        });

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
            isFull: isFullyRefunded,
          },
        });

        paymentLogger.increment('refundCompleted');
        paymentLogger.log('info', 'REFUND_COMPLETED', {
          orderId,
          refundId: prepared.refundRow.id,
          providerId: activeProviderId,
        }, { amount: prepared.requestedAmount, isFullyRefunded });
      } else if (outcomeUnknown) {
        await this.recordRefundTransaction(client, {
          orderId,
          refundId: prepared.refundRow.id,
          paymentIntentId: prepared.paymentIntentId,
          status: 'UNKNOWN',
          amount: prepared.requestedAmount,
          providerId: activeProviderId,
          externalReference: providerRefundId || null,
          idempotencyKey: prepared.durableIdempotencyKey,
        });

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

        paymentLogger.increment('refundUnknown');
        paymentLogger.log('warn', 'REFUND_OUTCOME_UNKNOWN', {
          orderId,
          refundId: prepared.refundRow.id,
          providerId: activeProviderId,
        }, { amount: prepared.requestedAmount });
      } else {
        await this.recordRefundTransaction(client, {
          orderId,
          refundId: prepared.refundRow.id,
          paymentIntentId: prepared.paymentIntentId,
          status: 'FAILED',
          amount: prepared.requestedAmount,
          providerId: activeProviderId,
          externalReference: providerRefundId || null,
          idempotencyKey: prepared.durableIdempotencyKey,
        });
        paymentLogger.increment('refundFailed');
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
   * Initiates a refund for an order with idempotency and cumulative ceiling guarantees.
   * Decoupled into 3 phases: Prepare TX -> Gateway Call outside TX -> Reconcile TX.
   */
  public async createRefund(params: CreateRefundParams): Promise<{ refund: RefundRecord; isDuplicate: boolean }> {
    const explicitAmount = this.parseExplicitAmount(params.amount);

    if (params.idempotencyKey) {
      const pool = getPool();
      const existingRefund = await pool.query(
        `SELECT * FROM refunds
         WHERE idempotency_key = $1
         LIMIT 1`,
        [params.idempotencyKey]
      );

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
    if (!(await bloomFilterService.mightContainSafe('refunds', refundId))) {
      return null;
    }

    const pool = getPool();
    const res = await pool.query(
      `SELECT * FROM refunds
       WHERE id = $1
       LIMIT 1`,
      [refundId]
    );

    if (res.rows.length === 0) {
      bloomFilterService.recordFalsePositive();
      return null;
    }
    return this.mapRow(res.rows[0]);
  }

  /**
   * Reconciles a refund in PROCESSING/UNKNOWN outcome state by querying the provider.
   * Preserves stale-worker lease fencing and recalculates cumulative partial refund status.
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

    const intentRes = await pool.query(
      `SELECT id, active_provider FROM payment_intents WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [refund.order_id]
    );
    const provider = this.getProvider(intentRes.rows[0]?.active_provider);

    let providerRefundId = refund.provider_refund_id;
    let providerStatus: 'COMPLETED' | 'FAILED' | 'PROCESSING' = 'PROCESSING';

    if (!providerRefundId && refund.idempotency_key && provider.getRefundByIdempotencyKey) {
      let match = await provider.getRefundByIdempotencyKey(refund.idempotency_key);
      if (!match) {
        try {
          match = await provider.createRefund({
            paymentId: refund.payment_id,
            amount: parseFloat(refund.amount),
            currency: 'INR',
            reason: refund.reason_code,
            idempotencyKey: refund.idempotency_key,
          });
        } catch {
          // Gateway unavailable; retain PROCESSING
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
      const statusRes = await provider.getRefundStatus(providerRefundId);
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

      if (expectedLeaseOwner && current.recovery_lease_id && current.recovery_lease_id !== expectedLeaseOwner) {
        const leaseExpiry = current.recovery_lease_expires_at ? new Date(current.recovery_lease_expires_at).getTime() : 0;
        if (leaseExpiry > Date.now()) {
          paymentLogger.log('warn', 'REFUND_STALE_LEASE_ABORTED', {
            orderId: current.order_id,
            refundId,
          });
          return current;
        }
      }

      const nextRetryAt = updatedStatus === 'PROCESSING'
        ? computeNextRetryAt((current.reconciliation_attempts || 0) + 1)
        : null;

      const finalRes = await client.query(
        `UPDATE refunds
         SET status = $1::varchar,
             provider_refund_id = COALESCE($2, provider_refund_id),
             processed_at = CASE WHEN $1::varchar = 'COMPLETED' THEN NOW() ELSE processed_at END,
             next_retry_at = $3,
             recovery_lease_id = NULL,
             recovery_lease_expires_at = NULL,
             version = version + 1,
             updated_at = NOW()
         WHERE id = $4
         RETURNING *`,
        [updatedStatus, providerRefundId || null, nextRetryAt, refundId]
      );

      if (updatedStatus === 'COMPLETED') {
        const orderRes = await client.query(
          `SELECT total_amount FROM orders WHERE id = $1 FOR UPDATE`,
          [refund.order_id]
        );
        const orderTotal = parseFloat(orderRes.rows[0]?.total_amount || refund.amount);
        await this.synchronizeCumulativeRefundStatus(client, refund.order_id, orderTotal);

        await this.recordRefundTransaction(client, {
          orderId: refund.order_id,
          refundId: refund.id,
          paymentIntentId: intentRes.rows[0]?.id,
          status: 'SUCCEEDED',
          amount: parseFloat(refund.amount),
          providerId: provider.providerId,
          externalReference: providerRefundId || null,
          idempotencyKey: refund.idempotency_key,
        });

        if (refund.reason_code?.startsWith('ORDER_CANCELLED_') || refund.reason_code === 'CANCELLATION') {
          await ledgerService.recordPreFulfillmentCancellationRefund({
            orderId: refund.order_id,
            refundId: refund.id,
            refundNumber: refund.refund_number,
            amount: parseFloat(refund.amount),
            client,
          });
        }
        paymentLogger.increment('refundCompleted');
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
    const res = await pool.query(
      `SELECT * FROM refunds
       WHERE order_id = $1
       ORDER BY created_at DESC`,
      [orderId]
    );

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
