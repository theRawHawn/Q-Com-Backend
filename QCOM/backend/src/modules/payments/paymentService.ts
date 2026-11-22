import crypto from 'crypto';
import pg from 'pg';
import { getPool, transaction } from '../../database/connection.js';
import { env } from '../../config/env.js';
import {
  PaymentIntent,
  PaymentReceipt,
  WebhookProcessingResult,
  PaymentStatusSummary,
  PaymentAttempt,
  ReconciliationResult,
} from './paymentTypes.js';
import {
  validatePaymentTransition,
  transitionPaymentIntentState,
  transitionPaymentAttemptState,
  PaymentState,
  FailureClassification,
} from './paymentStateMachine.js';
import { paymentEventPublisher, PaymentDomainEvent } from './paymentEvents.js';
import { getPaymentProvider, PaymentProvider, paymentProviderRegistry } from './paymentProvider.js';
import { paymentLogger } from './paymentLogger.js';
import { inventoryService } from '../inventory/inventoryService.js';
import { ledgerService } from '../ledger/ledgerService.js';
import { bloomFilterService } from '../resilience/bloomFilterService.js';
import { financialWebhookService } from './financialWebhookService.js';
import { refundService } from './refundService.js';

const DEFAULT_INTENT_EXPIRY_MINUTES = 15;

function computeNextRetryAt(attempts: number): Date {
  const cappedExponent = Math.min(Math.max(attempts, 1), 8);
  const delaySec = Math.min(1800, 15 * Math.pow(2, cappedExponent - 1));
  return new Date(Date.now() + delaySec * 1000);
}

export class PaymentService {
  private providerOverride: PaymentProvider | null = null;

  public setProvider(provider: PaymentProvider): void {
    this.providerOverride = provider;
    paymentProviderRegistry.registerProvider(provider, true);
  }

  public resetProvider(): void {
    this.providerOverride = null;
    const isProduction = env.NODE_ENV === 'production' || process.env.NODE_ENV === 'production';
    if (!isProduction && paymentProviderRegistry.hasProvider('mock')) {
      paymentProviderRegistry.setDefaultProvider('mock');
    }
  }

  public getProvider(providerId?: string, strictRegistryLookup: boolean = false): PaymentProvider {
    const activeMode = process.env.PAYMENT_MODE || env.PAYMENT_MODE;
    if (activeMode === 'none' && !this.providerOverride) {
      return paymentProviderRegistry.getProvider('none');
    }
    if (providerId) {
      const normalized = providerId.toLowerCase().trim();
      if (normalized === 'none' || normalized === 'unselected') {
        return paymentProviderRegistry.getProvider('none');
      }
      if (!strictRegistryLookup && this.providerOverride && activeMode !== 'none') {
        return this.providerOverride;
      }
      if (this.providerOverride && this.providerOverride.providerId === providerId) {
        return this.providerOverride;
      }
      return paymentProviderRegistry.getProvider(providerId);
    }
    if (activeMode === 'none') {
      if (this.providerOverride && (process.env.NODE_ENV || env.NODE_ENV) === 'test') {
        return this.providerOverride;
      }
      return paymentProviderRegistry.getProvider('none');
    }
    if (this.providerOverride) {
      return this.providerOverride;
    }
    return getPaymentProvider();
  }

  /**
   * Helper to identify PostgreSQL database connectivity failures
   */
  public isDatabaseUnavailable(err: any): boolean {
    if (!err) return false;
    const msg = (err.message || '').toLowerCase();
    const code = (err.code || '').toLowerCase();
    return (
      err.isDatabaseUnavailable === true ||
      code === '57p01' ||
      code === '57p02' ||
      code === '57p03' ||
      code === '57p04' ||
      code === '57p05' ||
      code === '40001' ||
      code === '40p01' ||
      code === '55p03' ||
      code === '53300' ||
      code === '08006' ||
      code === '08001' ||
      code === '08004' ||
      code === 'econnrefused' ||
      code === 'etimedout' ||
      code === 'econnreset' ||
      msg.includes('connection terminated') ||
      msg.includes('database is closed') ||
      msg.includes('connection refused') ||
      msg.includes('cannot connect') ||
      msg.includes('timeout') ||
      msg.includes('deadlock') ||
      msg.includes('serialization failure') ||
      msg.includes('could not obtain lock') ||
      msg.includes('lock timeout')
    );
  }

  /**
   * Generates a tamper-proof HMAC-SHA256 signature for payment orders
   * Uses isolated PAYMENT_SECRET (never JWT_SECRET)
   */
  public generatePaymentSignature(orderId: string, amount: number, timestamp: number): string {
    const payload = `${orderId}:${amount.toFixed(2)}:${timestamp}`;
    return crypto.createHmac('sha256', env.PAYMENT_SECRET).update(payload).digest('hex');
  }

  /**
   * Records a normalized immutable payment transaction ledger row in payment_transactions.
   * For CAPTURE, enforces PostgreSQL partial unique index uq_payment_tx_single_capture_per_order.
   */
  public async recordPaymentTransaction(
    client: pg.PoolClient,
    params: {
      internalReference?: string;
      orderId: string;
      paymentIntentId?: string | null;
      paymentAttemptId?: string | null;
      refundId?: string | null;
      transactionType: 'AUTHORIZATION' | 'CAPTURE' | 'REFUND' | 'REVERSAL' | 'VOID' | 'CHARGEBACK' | 'STATUS_CHECK';
      status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN' | 'CANCELLED';
      amount: number;
      currency?: string;
      paymentMode?: string | null;
      providerId?: string | null;
      externalReference?: string | null;
      idempotencyKey?: string | null;
      ledgerTransactionReference?: string | null;
      metadata?: Record<string, unknown>;
    }
  ): Promise<string | null> {
    const internalReference =
      params.internalReference ||
      `ptx_${params.transactionType.toLowerCase()}_${Date.now()}_${crypto.randomBytes(5).toString('hex')}`;

    const useSavepoint = !(getPool() as any).__pgMemDb;
    if (useSavepoint) {
      await client.query(`SAVEPOINT sp_payment_tx_insert`);
    } else {
      const tbl = await client.query(
        `SELECT 1 FROM information_schema.tables WHERE table_name = 'payment_transactions'`
      );
      if (tbl.rows.length === 0) {
        return null;
      }
    }
    try {
      const insRes = await client.query(
        `INSERT INTO payment_transactions (
           internal_reference, order_id, payment_intent_id, payment_attempt_id, refund_id,
           transaction_type, status, amount, currency, payment_mode, provider_id,
           external_reference, idempotency_key, ledger_transaction_reference, metadata
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         RETURNING id`,
        [
          internalReference,
          params.orderId,
          params.paymentIntentId || null,
          params.paymentAttemptId || null,
          params.refundId || null,
          params.transactionType,
          params.status,
          params.amount,
          params.currency || 'INR',
          params.paymentMode || null,
          params.providerId || 'UNSELECTED',
          params.externalReference || null,
          params.idempotencyKey || null,
          params.ledgerTransactionReference || null,
          JSON.stringify(params.metadata || {}),
        ]
      );
      if (useSavepoint) {
        await client.query(`RELEASE SAVEPOINT sp_payment_tx_insert`);
      }
      return insRes.rows[0]?.id || null;
    } catch (err: any) {
      if (useSavepoint) {
        await client.query(`ROLLBACK TO SAVEPOINT sp_payment_tx_insert`);
      }
      const msg = (err.message || '').toLowerCase();
      // If CAPTURE uniqueness violation occurs, rethrow so caller never allows double capture!
      if (params.transactionType === 'CAPTURE' && params.status === 'SUCCEEDED' && (err.code === '23505' || msg.includes('unique'))) {
        throw new Error('DUPLICATE_PAYMENT_CAPTURE: A successful CAPTURE transaction already exists for this order.');
      }
      // Graceful fallback only if payment_transactions table has not been migrated in legacy harness
      if (msg.includes('relation "payment_transactions" does not exist')) {
        return null;
      }
      if (err.code === '23505') {
        return null;
      }
      throw err;
    }
  }

  /**
   * Generates or safely reuses an authoritative Payment Intent from the authoritative order record in PostgreSQL.
   * Enforces consistent lock ordering: orders -> inventory_reservations -> payment_intents -> payment_attempts.
   */
  public async createPaymentOrder(
    orderId: string,
    userId: string,
    clientOverride?: pg.PoolClient,
    clientValidation?: { clientAmount?: number | string; clientCurrency?: string }
  ): Promise<PaymentIntent> {
    const executeCreate = async (client: pg.PoolClient): Promise<PaymentIntent> => {
      // Lock Order Row First
      const orderRes = await client.query(
        `SELECT id, user_id, total_amount, payment_status, payment_method, status
         FROM orders
         WHERE id = $1
         FOR UPDATE`,
        [orderId]
      );

      if (orderRes.rows.length === 0) {
        throw new Error('ORDER_NOT_FOUND: Order not found.');
      }

      const o = orderRes.rows[0];
      if (o.user_id !== userId) {
        throw new Error('UNAUTHORIZED_ORDER_ACCESS: Authenticated user does not own this order.');
      }

      if (clientValidation?.clientCurrency !== undefined && clientValidation?.clientCurrency !== null) {
        const normalizedCur = String(clientValidation.clientCurrency).trim().toUpperCase();
        if (normalizedCur !== 'INR') {
          throw new Error(
            `UNSUPPORTED_CURRENCY: Currency '${normalizedCur}' is not supported. Only 'INR' is currently accepted.`
          );
        }
      }

      if (o.payment_method === 'Pay on Delivery') {
        throw new Error('COD_ORDER_CANNOT_INITIATE_ONLINE_PAYMENT: Cash on Delivery orders cannot generate online payment intents.');
      }

      if (o.payment_status === 'PAID' || o.payment_status === 'REFUNDED' || o.payment_status === 'PARTIALLY_REFUNDED') {
        throw new Error('ORDER_ALREADY_PAID: Cannot initiate payment for an order that is already paid.');
      }

      const authoritativeAmount = parseFloat(o.total_amount);
      if (!Number.isFinite(authoritativeAmount) || authoritativeAmount <= 0) {
        throw new Error('INVALID_PAYMENT_AMOUNT: Authoritative order total must be greater than zero.');
      }

      if (clientValidation?.clientAmount !== undefined && clientValidation?.clientAmount !== null) {
        const submittedAmt = Number(clientValidation.clientAmount);
        if (
          !Number.isFinite(submittedAmt) ||
          submittedAmt <= 0 ||
          Math.abs(submittedAmt - authoritativeAmount) > 0.01
        ) {
          throw new Error(
            `PAYMENT_AMOUNT_TAMPERED: Client amount (${clientValidation.clientAmount}) does not match authoritative order total (${authoritativeAmount.toFixed(2)}).`
          );
        }
      }

      const orderStatus = (o.status || '').toLowerCase();
      if (orderStatus === 'cancelled') {
        throw new Error('ORDER_CANCELLED: Cannot initiate payment for a cancelled order.');
      }

      if (orderStatus !== 'placed' && orderStatus !== 'pending') {
        throw new Error(`ORDER_INELIGIBLE_FOR_PAYMENT: Cannot initiate payment for an order in '${o.status}' status.`);
      }

      // Lock inventory reservations Second
      const resCheck = await client.query(
        `SELECT id, status, expires_at
         FROM inventory_reservations
         WHERE order_id = $1
         FOR UPDATE`,
        [orderId]
      );

      if (resCheck.rows.length === 0) {
        throw new Error('NO_INVENTORY_RESERVATION: Cannot initiate payment. No inventory allocation found for this order.');
      }

      const allReserved = resCheck.rows.every((r: any) => r.status === 'RESERVED');
      const anyExpired = resCheck.rows.some((r: any) => new Date(r.expires_at).getTime() <= Date.now());

      if (!allReserved || anyExpired) {
        throw new Error('RESERVATION_EXPIRED: Cannot initiate payment. Inventory reservation has expired or been released. Please place a new order.');
      }

      // Lock Payment Intents Third
      const existingIntentsRes = await client.query(
        `SELECT * FROM payment_intents
         WHERE order_id = $1
         ORDER BY created_at DESC
         FOR UPDATE`,
        [orderId]
      );

      for (const existing of existingIntentsRes.rows) {
        if (['CAPTURED', 'REFUND_PENDING', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(existing.status)) {
          paymentLogger.increment('duplicateBlocks');
          throw new Error('ORDER_ALREADY_PAID: Payment has already been captured for this order.');
        }

        if (['UNKNOWN', 'RECONCILIATION_REQUIRED', 'REQUIRES_REVIEW'].includes(existing.status)) {
          paymentLogger.increment('duplicateBlocks');
          throw new Error(
            `PAYMENT_RECONCILIATION_PENDING: An existing payment intent (${existing.id}) is in '${existing.status}' state and must be reconciled before initiating a new payment.`
          );
        }

        if (['CREATED', 'INITIATED', 'PENDING', 'PROCESSING', 'AUTHORIZED'].includes(existing.status)) {
          const expiresAtMs = existing.expires_at ? new Date(existing.expires_at).getTime() : null;
          if (expiresAtMs !== null && expiresAtMs <= Date.now()) {
            await transitionPaymentIntentState(client, existing.id, 'EXPIRED', {
              failureClassification: 'POLICY',
              errorCode: 'INTENT_EXPIRED',
              errorDescription: 'Payment intent expired prior to capture.',
            });
            try {
              const attRes = await client.query(
                `SELECT id FROM payment_attempts
                 WHERE payment_intent_id = $1 AND status IN ('INITIATED', 'PENDING', 'PROCESSING')
                 FOR UPDATE`,
                [existing.id]
              );
              for (const att of attRes.rows) {
                await transitionPaymentAttemptState(client, att.id, 'EXPIRED', {
                  errorCode: 'INTENT_EXPIRED',
                  errorMessage: 'Parent payment intent expired.',
                  failureClassification: 'POLICY',
                  retryEligible: true,
                });
              }
            } catch {}
            continue;
          }

          // Reuse active unexpired intent for idempotent concurrent/retry safety
          if (Math.abs(parseFloat(existing.amount) - authoritativeAmount) <= 0.01) {
            return {
              id: existing.id,
              paymentOrderId: existing.payment_order_id,
              orderId: existing.order_id,
              amount: parseFloat(existing.amount),
              currency: existing.currency || 'INR',
              status: existing.status as PaymentState,
              signature: existing.signature,
              timestamp: new Date(existing.created_at || Date.now()).toISOString(),
              providerOrderId: existing.provider_order_id || existing.payment_order_id,
              activeProvider: existing.active_provider || 'UNSELECTED',
              expiresAt: existing.expires_at ? new Date(existing.expires_at).toISOString() : undefined,
              internalTransactionReference: existing.internal_transaction_reference || undefined,
            } as PaymentIntent;
          }
        }
      }

      const provider = this.getProvider();
      const timestamp = Date.now();
      const attemptId = crypto.randomUUID();
      const internalTxRef = `ptx_${crypto.randomBytes(8).toString('hex')}`;
      const expiresAt = new Date(timestamp + DEFAULT_INTENT_EXPIRY_MINUTES * 60 * 1000);

      const session = await provider.createPaymentSession({
        orderId,
        attemptId,
        amount: authoritativeAmount,
        currency: 'INR',
        customer: { id: userId },
        idempotencyKey: `payment_${orderId}_${timestamp}`,
      });
      const signature = session.signature || this.generatePaymentSignature(orderId, authoritativeAmount, timestamp);
      const paymentOrderId = session.providerReference;

      const intentRes = await client.query(
        `INSERT INTO payment_intents (
           payment_order_id, order_id, user_id, payment_method, internal_transaction_reference,
           expires_at, amount, currency, status, signature,
           provider_order_id, active_provider, created_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'INR', 'CREATED', $8, $9, $10, NOW(), NOW())
         RETURNING id`,
        [
          paymentOrderId,
          orderId,
          userId,
          o.payment_method,
          internalTxRef,
          expiresAt,
          authoritativeAmount,
          signature,
          paymentOrderId,
          provider.providerId,
        ]
      );

      const intentId = intentRes.rows[0]?.id || paymentOrderId;

      try {
        const attNumRes = await client.query(
          `SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next_num
           FROM payment_attempts
           WHERE order_id = $1`,
          [orderId]
        );
        const nextNum = parseInt(attNumRes.rows[0]?.next_num || '1', 10);

        await client.query(
          `INSERT INTO payment_attempts (
             id, order_id, payment_intent_id, attempt_number, provider_id, provider_reference,
             internal_reference, expires_at, status, amount, currency, initiated_at, updated_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'INITIATED', $9, 'INR', NOW(), NOW())
           ON CONFLICT (order_id, attempt_number) DO NOTHING`,
          [
            attemptId,
            orderId,
            intentId,
            nextNum,
            provider.providerId,
            paymentOrderId,
            `att_ref_${crypto.randomBytes(8).toString('hex')}`,
            expiresAt,
            authoritativeAmount,
          ]
        );
      } catch {
        // Fallback if optional columns not in test harness
      }

      paymentLogger.increment('initiations');
      paymentLogger.log('info', 'PAYMENT_INTENT_CREATED', {
        orderId,
        paymentIntentId: intentId,
        attemptId,
        userId,
        providerId: provider.providerId,
        internalReference: internalTxRef,
      }, { amount: authoritativeAmount, currency: 'INR' });

      paymentEventPublisher.emit('PaymentCreated', {
        orderId,
        paymentOrderId,
        amount: authoritativeAmount,
        currency: 'INR',
      });

      return {
        id: intentId,
        paymentOrderId,
        orderId,
        amount: authoritativeAmount,
        currency: 'INR',
        status: 'CREATED',
        signature,
        timestamp: new Date(timestamp).toISOString(),
        providerOrderId: paymentOrderId,
        activeProvider: provider.providerId,
      };
    };

    if (clientOverride) {
      return executeCreate(clientOverride);
    }
    return transaction(executeCreate);
  }

  /**
   * Sprint 12.0 & 15.8: Provider-Agnostic Payment Session & Attempt Initiation
   * Enforces single active attempt per order, row locking, and expires stale attempts cleanly.
   */
  public async createPaymentAttempt(params: {
    orderId: string;
    userId: string;
    providerId?: string;
    idempotencyKey?: string;
    clientAmount?: number | string;
    clientCurrency?: string;
  }): Promise<{ intent: PaymentIntent; session: any; attemptNumber: number }> {
    const { orderId, userId, providerId, idempotencyKey, clientAmount, clientCurrency } = params;
    const provider = this.getProvider(providerId);

    return await transaction(async (client) => {
      // 1. Lock order
      const orderRes = await client.query(
        `SELECT id, user_id, total_amount, payment_status, payment_method, status
         FROM orders
         WHERE id = $1
         FOR UPDATE`,
        [orderId]
      );

      if (orderRes.rows.length === 0) {
        throw new Error('ORDER_NOT_FOUND: Order not found.');
      }
      const o = orderRes.rows[0];
      if (o.user_id !== userId) {
        throw new Error('UNAUTHORIZED_ORDER_ACCESS: Authenticated user does not own this order.');
      }
      if (clientCurrency !== undefined && clientCurrency !== null) {
        const normalizedCur = String(clientCurrency).trim().toUpperCase();
        if (normalizedCur !== 'INR') {
          throw new Error(
            `UNSUPPORTED_CURRENCY: Currency '${normalizedCur}' is not supported. Only 'INR' is currently accepted.`
          );
        }
      }
      if (o.payment_method === 'Pay on Delivery') {
        throw new Error('COD_ORDER_CANNOT_INITIATE_ONLINE_PAYMENT: Cash on Delivery orders cannot generate online payment intents.');
      }
      if (o.payment_status === 'PAID' || o.payment_status === 'REFUNDED' || o.payment_status === 'PARTIALLY_REFUNDED') {
        throw new Error('ORDER_ALREADY_PAID: Cannot initiate payment for an order that is already paid.');
      }
      const orderStatus = (o.status || '').toLowerCase();
      if (orderStatus === 'cancelled') {
        throw new Error('ORDER_CANCELLED: Cannot initiate payment for a cancelled order.');
      }
      if (orderStatus !== 'placed' && orderStatus !== 'pending') {
        throw new Error(`ORDER_INELIGIBLE_FOR_PAYMENT: Cannot initiate payment for an order in '${o.status}' status.`);
      }

      const authoritativeAmount = parseFloat(o.total_amount);
      if (!Number.isFinite(authoritativeAmount) || authoritativeAmount <= 0) {
        throw new Error('INVALID_PAYMENT_AMOUNT: Order total amount must be positive.');
      }
      if (clientAmount !== undefined && clientAmount !== null) {
        const submittedAmt = Number(clientAmount);
        if (
          !Number.isFinite(submittedAmt) ||
          submittedAmt <= 0 ||
          Math.abs(submittedAmt - authoritativeAmount) > 0.01
        ) {
          throw new Error(
            `PAYMENT_AMOUNT_TAMPERED: Client amount (${clientAmount}) does not match authoritative order total (${authoritativeAmount.toFixed(2)}).`
          );
        }
      }

      // 2. Lock reservations
      const resCheck = await client.query(
        `SELECT id, status, expires_at FROM inventory_reservations WHERE order_id = $1 FOR UPDATE`,
        [orderId]
      );

      if (resCheck.rows.length === 0) {
        throw new Error('NO_INVENTORY_RESERVATION: Cannot initiate payment. No inventory allocation found for this order.');
      }
      const allReserved = resCheck.rows.every((r: any) => r.status === 'RESERVED');
      const anyExpired = resCheck.rows.some((r: any) => new Date(r.expires_at).getTime() <= Date.now());
      if (!allReserved || anyExpired) {
        throw new Error('RESERVATION_EXPIRED: Cannot initiate payment. Inventory reservation has expired or been released. Please place a new order.');
      }

      // 3. Lock intents
      const intentRowsRes = await client.query(
        `SELECT * FROM payment_intents WHERE order_id = $1 ORDER BY created_at DESC FOR UPDATE`,
        [orderId]
      );

      let reusableIntent: any = null;
      for (const existing of intentRowsRes.rows) {
        if (['CAPTURED', 'REFUND_PENDING', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(existing.status)) {
          throw new Error('ORDER_ALREADY_PAID: Order payment has already been captured.');
        }
        if (['UNKNOWN', 'RECONCILIATION_REQUIRED', 'REQUIRES_REVIEW'].includes(existing.status)) {
          throw new Error(`PAYMENT_RECONCILIATION_PENDING: Cannot initiate a new attempt while intent is '${existing.status}'.`);
        }
        if (['CREATED', 'INITIATED', 'PENDING', 'PROCESSING', 'AUTHORIZED'].includes(existing.status)) {
          const expMs = existing.expires_at ? new Date(existing.expires_at).getTime() : null;
          if (expMs !== null && expMs <= Date.now()) {
            await transitionPaymentIntentState(client, existing.id, 'EXPIRED', {
              errorCode: 'INTENT_EXPIRED',
              errorDescription: 'Payment intent expired prior to capture.',
              failureClassification: 'POLICY',
            });
          } else if (!reusableIntent) {
            reusableIntent = existing;
          }
        }
      }

      // 4. Lock existing attempts & check active attempt exclusivity / idempotency
      const existingAttRes = await client.query(
        `SELECT * FROM payment_attempts WHERE order_id = $1 ORDER BY attempt_number DESC FOR UPDATE`,
        [orderId]
      );

      if (idempotencyKey) {
        const matchedAttempt = existingAttRes.rows.find((a: any) => a.idempotency_key === idempotencyKey);
        if (matchedAttempt) {
          const intentRow = reusableIntent || intentRowsRes.rows[0];
          return {
            intent: {
              id: matchedAttempt.payment_intent_id || intentRow?.id,
              paymentOrderId: matchedAttempt.provider_reference,
              orderId,
              amount: parseFloat(matchedAttempt.amount),
              currency: matchedAttempt.currency || 'INR',
              status: (intentRow?.status || 'CREATED') as PaymentState,
              signature: intentRow?.signature || '',
              timestamp: new Date(matchedAttempt.initiated_at || Date.now()).toISOString(),
              providerOrderId: matchedAttempt.provider_reference,
              activeProvider: matchedAttempt.provider_id,
              idempotencyKey,
            },
            session: {
              providerId: matchedAttempt.provider_id,
              providerReference: matchedAttempt.provider_reference,
              amount: parseFloat(matchedAttempt.amount),
              currency: matchedAttempt.currency || 'INR',
              signature: intentRow?.signature,
              metadata: { attemptId: matchedAttempt.id, replayed: true },
            },
            attemptNumber: matchedAttempt.attempt_number,
          };
        }
      }

      for (const att of existingAttRes.rows) {
        if (att.status === 'SUCCEEDED') {
          throw new Error('ORDER_ALREADY_PAID: A payment attempt has already succeeded for this order.');
        }
        if (['UNKNOWN', 'RECONCILIATION_REQUIRED', 'REQUIRES_REVIEW'].includes(att.status)) {
          throw new Error(`PAYMENT_RECONCILIATION_PENDING: Previous attempt #${att.attempt_number} is in '${att.status}' state and must be reconciled first.`);
        }
        if (['INITIATED', 'PENDING', 'PROCESSING'].includes(att.status)) {
          const expMs = att.expires_at ? new Date(att.expires_at).getTime() : null;
          if (expMs !== null && expMs <= Date.now()) {
            await transitionPaymentAttemptState(client, att.id, 'EXPIRED', {
              errorCode: 'ATTEMPT_EXPIRED',
              errorMessage: 'Previous attempt expired.',
              failureClassification: 'POLICY',
              retryEligible: true,
            });
          } else {
            paymentLogger.increment('duplicateBlocks');
            throw new Error(
              `PAYMENT_ATTEMPT_ALREADY_IN_PROGRESS: Active payment attempt #${att.attempt_number} (${att.status}) is still open for order '${orderId}'.`
            );
          }
        }
      }

      const maxAttempt = existingAttRes.rows.reduce(
        (max: number, r: any) => Math.max(max, parseInt(r.attempt_number || '0', 10)),
        0
      );
      const attemptNumber = maxAttempt + 1;
      const attemptId = crypto.randomUUID();
      const internalTxRef = `ptx_${crypto.randomBytes(8).toString('hex')}`;
      const attemptInternalRef = `att_${crypto.randomBytes(8).toString('hex')}`;
      const expiresAt = new Date(Date.now() + DEFAULT_INTENT_EXPIRY_MINUTES * 60 * 1000);

      // Create provider session
      const session = await provider.createPaymentSession({
        orderId,
        attemptId,
        amount: authoritativeAmount,
        currency: 'INR',
        customer: { id: userId },
        idempotencyKey: idempotencyKey || `att_${orderId}_${attemptNumber}`,
      });

      const paymentOrderId = session.providerReference;
      const signature = session.signature || this.generatePaymentSignature(orderId, authoritativeAmount, Date.now());

      let intentId: string;
      let intentStatus: PaymentState = 'CREATED';
      if (reusableIntent) {
        intentId = reusableIntent.id;
        intentStatus = reusableIntent.status as PaymentState;
        await client.query(
          `UPDATE payment_intents
           SET payment_order_id = $1,
               provider_order_id = $1,
               active_provider = $2,
               signature = $3,
               idempotency_key = COALESCE($4, idempotency_key),
               expires_at = $5,
               user_id = COALESCE(user_id, $6),
               payment_method = COALESCE(payment_method, $7),
               updated_at = NOW(),
               version = version + 1
           WHERE id = $8`,
          [paymentOrderId, provider.providerId, signature, idempotencyKey || null, expiresAt, userId, o.payment_method, intentId]
        );
      } else {
        const intentRes = await client.query(
          `INSERT INTO payment_intents (
             payment_order_id, order_id, user_id, payment_method, internal_transaction_reference,
             expires_at, amount, currency, status, signature,
             provider_order_id, active_provider, idempotency_key, created_at, updated_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'INR', 'CREATED', $8, $9, $10, $11, NOW(), NOW())
           RETURNING id`,
          [
            paymentOrderId,
            orderId,
            userId,
            o.payment_method,
            internalTxRef,
            expiresAt,
            authoritativeAmount,
            signature,
            paymentOrderId,
            provider.providerId,
            idempotencyKey || null,
          ]
        );
        intentId = intentRes.rows[0]?.id || paymentOrderId;
      }

      await client.query(
        `INSERT INTO payment_attempts (
           id, order_id, payment_intent_id, attempt_number, provider_id, provider_reference,
           internal_reference, expires_at, status, amount, currency, idempotency_key, initiated_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'INITIATED', $9, 'INR', $10, NOW(), NOW())`,
        [
          attemptId,
          orderId,
          intentId,
          attemptNumber,
          provider.providerId,
          paymentOrderId,
          attemptInternalRef,
          expiresAt,
          authoritativeAmount,
          idempotencyKey || null,
        ]
      );

      paymentLogger.increment('initiations');
      paymentLogger.log('info', 'PAYMENT_ATTEMPT_CREATED', {
        orderId,
        paymentIntentId: intentId,
        attemptId,
        userId,
        providerId: provider.providerId,
        internalReference: attemptInternalRef,
      }, { attemptNumber, amount: authoritativeAmount, currency: 'INR' });

      paymentEventPublisher.emit('PaymentCreated', {
        orderId,
        paymentOrderId,
        amount: authoritativeAmount,
        currency: 'INR',
      });

      const intent: PaymentIntent = {
        id: intentId,
        paymentOrderId,
        orderId,
        amount: authoritativeAmount,
        currency: 'INR',
        status: intentStatus,
        signature,
        timestamp: new Date().toISOString(),
        providerOrderId: paymentOrderId,
        activeProvider: provider.providerId,
        idempotencyKey,
      };

      return {
        intent,
        session,
        attemptNumber,
      };
    });
  }

  /**
   * Verifies cryptographic signature and captures payment atomically.
   * Enforces row-level locks, prevents duplicate side effects, checks amount & currency tampering,
   * and routes all status mutations through centralized state transitions.
   */
  public async verifyPayment(params: {
    orderId: string;
    transactionId: string;
    timestamp: number;
    signature: string;
    amount?: number;
    currency?: string;
    userId: string;
    razorpayOrderId?: string;
    evidence?: any;
  }): Promise<{
    receipt: PaymentReceipt;
    order: any;
    isDuplicate?: boolean;
    isReconciliationRequired?: boolean;
    status?: string;
    needsRefund?: boolean;
    authoritativeAmount?: number;
  }> {
    const { orderId, transactionId, timestamp, signature, amount, currency, userId, razorpayOrderId, evidence } = params;

    if (currency && currency.toUpperCase() !== 'INR') {
      throw new Error(`CURRENCY_MISMATCH: Currency '${currency}' does not match authoritative currency 'INR'.`);
    }

    const stagedEvents: PaymentDomainEvent[] = [];

    const result = await transaction<{
      receipt: PaymentReceipt;
      order: any;
      isDuplicate?: boolean;
      isReconciliationRequired?: boolean;
      status?: string;
      needsRefund?: boolean;
      authoritativeAmount?: number;
    }>(async (client) => {
      // 1. Lock authoritative order row
      const orderRes = await client.query(
        `SELECT * FROM orders
         WHERE id = $1
         FOR UPDATE`,
        [orderId]
      );

      if (orderRes.rows.length === 0) {
        throw new Error('ORDER_NOT_FOUND: Order not found.');
      }

      const o = orderRes.rows[0];
      if (o.user_id !== userId) {
        throw new Error('UNAUTHORIZED_PAYMENT_ACCESS: User is not authorized to verify payment for this order.');
      }

      if (o.payment_method === 'Pay on Delivery') {
        throw new Error('COD_ORDER_CANNOT_INITIATE_ONLINE_PAYMENT: Cash on Delivery orders cannot be captured through online verification.');
      }

      const authoritativeAmount = parseFloat(o.total_amount);

      // 2. Client Amount Tampering Protection
      if (amount !== undefined && amount !== null) {
        const clientAmt = Number(amount);
        if (!Number.isFinite(clientAmt) || Math.abs(clientAmt - authoritativeAmount) > 0.001) {
          throw new Error('PAYMENT_AMOUNT_MISMATCH: Client-submitted amount does not match authoritative order total.');
        }
      }

      // 3. Lock reservations Second (consistent lock ordering)
      const resCheck = await client.query(
        `SELECT id, status, expires_at
         FROM inventory_reservations
         WHERE order_id = $1
         FOR UPDATE`,
        [orderId]
      );

      // 4. Lock latest payment_intent Third
      const intentRes = await client.query(
        `SELECT * FROM payment_intents
         WHERE order_id = $1
         ORDER BY created_at DESC
         LIMIT 1
         FOR UPDATE`,
        [orderId]
      );

      const currentIntent = intentRes.rows[0];
      const currentIntentStatus = (currentIntent?.status || 'CREATED') as PaymentState;

      // 5. Duplicate / Concurrency Check
      if (o.payment_status === 'PAID' || o.payment_status === 'REFUNDED' || o.payment_status === 'REFUND_PENDING' || o.payment_status === 'PARTIALLY_REFUNDED') {
        paymentLogger.increment('duplicateBlocks');
        const receiptRes = await client.query(
          `SELECT id, order_id, transaction_id, amount, status, signature, verified_at
           FROM payment_receipts
           WHERE order_id = $1
           LIMIT 1`,
          [orderId]
        );

        const r = receiptRes.rows[0];
        const verifiedAtStr = r?.verified_at instanceof Date
          ? r.verified_at.toISOString()
          : (r?.verified_at ? String(r.verified_at) : new Date().toISOString());

        return {
          receipt: {
            id: r?.id || crypto.randomUUID(),
            orderId: r?.order_id || orderId,
            transactionId: r?.transaction_id || transactionId,
            amount: r?.amount ? parseFloat(r.amount) : authoritativeAmount,
            status: r?.status || 'SUCCESS',
            signature: r?.signature || signature,
            verifiedAt: verifiedAtStr,
          },
          order: o,
          isDuplicate: true,
        };
      }

      // 6. Replay attack defense
      const checkTx = await client.query(
        `SELECT id, order_id FROM payment_receipts
         WHERE transaction_id = $1
         LIMIT 1`,
        [transactionId]
      );

      if (checkTx.rows.length > 0) {
        if (checkTx.rows[0].order_id !== orderId) {
          paymentLogger.increment('duplicateBlocks');
          throw new Error(`Replay attack detected: Transaction ID '${transactionId}' has already been processed for order '${checkTx.rows[0].order_id}'.`);
        }
        const existingReceipt = await client.query(
          `SELECT id, order_id, transaction_id, amount, status, signature, verified_at
           FROM payment_receipts
           WHERE transaction_id = $1
           LIMIT 1`,
          [transactionId]
        );
        const r = existingReceipt.rows[0];
        return {
          receipt: {
            id: r.id,
            orderId: r.order_id,
            transactionId: r.transaction_id,
            amount: parseFloat(r.amount),
            status: r.status,
            signature: r.signature,
            verifiedAt: r.verified_at instanceof Date ? r.verified_at.toISOString() : (r.verified_at ? String(r.verified_at) : new Date().toISOString()),
          },
          order: o,
          isDuplicate: true,
        };
      }

      // Lock active attempt if any
      let activeAttempt: any = null;
      try {
        const attRes = await client.query(
          `SELECT * FROM payment_attempts
           WHERE order_id = $1 AND status IN ('INITIATED', 'PENDING', 'PROCESSING', 'UNKNOWN', 'RECONCILIATION_REQUIRED')
           ORDER BY attempt_number DESC
           LIMIT 1
           FOR UPDATE`,
          [orderId]
        );
        activeAttempt = attRes.rows[0] || null;
      } catch {}

      // 7. Provider Verification & Cryptographic Signature Validation
      const provider = this.getProvider(currentIntent?.active_provider);
      let isReconciliationRequired = false;
      let isSigValid = false;
      let verificationFailureCode: string | undefined;
      let verificationFailureMsg: string | undefined;

      try {
        const provRes = await provider.verifyPayment({
          orderId,
          amount: authoritativeAmount,
          currency: 'INR',
          providerReference: razorpayOrderId || currentIntent?.payment_order_id || transactionId,
          providerPaymentId: transactionId,
          evidence: evidence || {
            signature,
            timestamp,
            transactionId,
            razorpayOrderId: razorpayOrderId || currentIntent?.payment_order_id,
          },
        });
        if (provRes.status === 'RECONCILIATION_REQUIRED' || provRes.status === 'UNKNOWN' || provRes.status === 'PENDING') {
          isReconciliationRequired = true;
          verificationFailureCode = provRes.errorCode || 'GATEWAY_TIMEOUT';
          verificationFailureMsg = provRes.errorMessage || 'Provider verification outcome ambiguous.';
        } else {
          isSigValid = provRes.verified;
          verificationFailureCode = provRes.errorCode;
          verificationFailureMsg = provRes.errorMessage;
        }
      } catch (err: any) {
        const normErr = typeof provider.normalizeError === 'function' ? provider.normalizeError(err) : null;
        if (normErr && !normErr.retryable && normErr.code === 'PAYMENT_GATEWAY_NOT_CONFIGURED') {
          throw err;
        }
        isReconciliationRequired = true;
        verificationFailureCode = normErr?.code || 'GATEWAY_COMMUNICATION_ERROR';
        verificationFailureMsg = err.message;
      }

      if (isReconciliationRequired) {
        const nextRetryAt = computeNextRetryAt((currentIntent?.reconciliation_attempts || 0) + 1);
        if (currentIntent) {
          await transitionPaymentIntentState(client, currentIntent.id, 'RECONCILIATION_REQUIRED', {
            failureClassification: 'AMBIGUOUS',
            errorCode: verificationFailureCode || 'GATEWAY_TIMEOUT',
            errorDescription: verificationFailureMsg || 'Payment verification timed out or returned ambiguous state.',
            nextRetryAt,
          });
        }
        if (activeAttempt) {
          await transitionPaymentAttemptState(client, activeAttempt.id, 'UNKNOWN', {
            failureClassification: 'AMBIGUOUS',
            errorCode: verificationFailureCode || 'GATEWAY_TIMEOUT',
            errorMessage: verificationFailureMsg || 'Ambiguous outcome during verification.',
            retryEligible: true,
            nextRetryAt,
          });
        }
        await this.recordPaymentTransaction(client, {
          orderId,
          paymentIntentId: currentIntent?.id,
          paymentAttemptId: activeAttempt?.id,
          transactionType: 'STATUS_CHECK',
          status: 'UNKNOWN',
          amount: authoritativeAmount,
          currency: 'INR',
          paymentMode: o.payment_method,
          providerId: provider.providerId,
          externalReference: transactionId,
          metadata: { errorCode: verificationFailureCode || 'GATEWAY_TIMEOUT' },
        });
        paymentLogger.increment('unknownOutcomes');
        paymentLogger.log('warn', 'PAYMENT_OUTCOME_UNKNOWN', {
          orderId,
          paymentIntentId: currentIntent?.id,
          attemptId: activeAttempt?.id,
          providerId: provider.providerId,
        }, { errorCode: verificationFailureCode });

        return {
          receipt: {
            id: crypto.randomUUID(),
            orderId,
            transactionId,
            amount: authoritativeAmount,
            status: 'FAILED',
            signature,
            verifiedAt: new Date().toISOString(),
          },
          order: o,
          isReconciliationRequired: true,
          status: 'RECONCILIATION_REQUIRED',
        };
      }

      if (!isSigValid) {
        paymentLogger.increment('failures');
        throw new Error('Cryptographic signature verification failed. Payment payload may have been tampered with.');
      }

      // 8. Check reservation status and order status under row lock (late payment detection)
      const isOrderCancelled = (o.status || '').toLowerCase() === 'cancelled';
      const hasReservedInventory = resCheck.rows.length > 0 && resCheck.rows.every((r: any) => r.status === 'RESERVED');
      const isReservationExpired = resCheck.rows.some((r: any) => new Date(r.expires_at).getTime() <= Date.now());
      const isIntentExpired = currentIntent?.expires_at && new Date(currentIntent.expires_at).getTime() <= Date.now();
      const isIntentCancelled = ['CANCELLED', 'FAILED', 'EXPIRED'].includes(currentIntentStatus);
      const isLateOrCancelled = isOrderCancelled || !hasReservedInventory || isReservationExpired || isIntentExpired || isIntentCancelled;

      if (isLateOrCancelled) {
        const insReceipt = await client.query(
          `INSERT INTO payment_receipts (order_id, transaction_id, amount, status, signature)
           VALUES ($1, $2, $3, 'SUCCESS', $4)
           ON CONFLICT (transaction_id) DO NOTHING
           RETURNING id, order_id, transaction_id, amount, status, signature, verified_at`,
          [orderId, transactionId, authoritativeAmount, signature]
        );

        let r = insReceipt.rows[0];
        if (!r) {
          const fetchReceipt = await client.query(
            `SELECT id, order_id, transaction_id, amount, status, signature, verified_at
             FROM payment_receipts
             WHERE transaction_id = $1
             LIMIT 1`,
            [transactionId]
          );
          r = fetchReceipt.rows[0];
        }

        const receipt: PaymentReceipt = {
          id: r?.id || crypto.randomUUID(),
          orderId: r?.order_id || orderId,
          transactionId: r?.transaction_id || transactionId,
          amount: r?.amount ? parseFloat(r.amount) : authoritativeAmount,
          status: 'SUCCESS',
          signature: r?.signature || signature,
          verifiedAt: r?.verified_at instanceof Date ? r.verified_at.toISOString() : (r?.verified_at ? String(r.verified_at) : new Date().toISOString()),
        };

        if (currentIntent) {
          await transitionPaymentIntentState(client, currentIntent.id, 'REFUND_PENDING', {
            providerPaymentId: transactionId,
            allowLateCaptureCompensation: true,
            failureClassification: 'POLICY',
            errorCode: 'LATE_CAPTURE_ON_CANCELLED_OR_EXPIRED',
            errorDescription: 'Authoritative payment capture arrived after order cancellation or expiration; routed to refund compensation.',
          });
        }

        if (activeAttempt) {
          await transitionPaymentAttemptState(client, activeAttempt.id, 'SUCCEEDED', {
            providerReference: transactionId,
          });
        }

        const cancelReason = o.cancellation_reason || 'Payment received after reservation expired or order was cancelled';
        await client.query(
          `UPDATE orders
           SET payment_status = 'REFUND_PENDING',
               status = 'cancelled',
               cancellation_reason = $2,
               updated_at = NOW()
           WHERE id = $1`,
          [orderId, cancelReason]
        );

        await this.recordPaymentTransaction(client, {
          orderId,
          paymentIntentId: currentIntent?.id,
          paymentAttemptId: activeAttempt?.id,
          transactionType: 'CAPTURE',
          status: 'SUCCEEDED',
          amount: authoritativeAmount,
          currency: 'INR',
          paymentMode: o.payment_method,
          providerId: provider.providerId,
          externalReference: transactionId,
          metadata: { lateCapture: true },
        });

        await ledgerService.recordOrderPayment({
          orderId,
          merchantId: o.merchant_id,
          grossAmount: authoritativeAmount,
          taxableAmount: parseFloat(o.taxable_amount || '0'),
          cgstAmount: parseFloat(o.cgst_amount || '0'),
          sgstAmount: parseFloat(o.sgst_amount || '0'),
          deliveryFee: parseFloat(o.delivery_fee || '0'),
          handlingFee: parseFloat(o.handling_fee || '0'),
          client,
        });

        await inventoryService.releaseStock(orderId, client);

        paymentLogger.increment('captures');
        paymentLogger.log('warn', 'LATE_PAYMENT_CAPTURED_ROUTED_TO_REFUND', {
          orderId,
          paymentIntentId: currentIntent?.id,
          providerId: provider.providerId,
        }, { amount: authoritativeAmount });

        const updatedOrderRes = await client.query(`SELECT * FROM orders WHERE id = $1`, [orderId]);
        return {
          receipt,
          order: updatedOrderRes.rows[0],
          isDuplicate: false,
          needsRefund: true,
          authoritativeAmount,
        };
      }

      // 9. Active Order Normal Capture through centralized state machine
      const transition = validatePaymentTransition(currentIntentStatus, 'CAPTURED');
      if (!transition.valid) {
        throw new Error(transition.error || 'INVALID_PAYMENT_STATE_TRANSITION');
      }

      await client.query(
        `UPDATE orders
         SET payment_status = 'PAID', updated_at = NOW()
         WHERE id = $1`,
        [orderId]
      );

      if (currentIntent) {
        await transitionPaymentIntentState(client, currentIntent.id, 'CAPTURED', {
          providerPaymentId: transactionId,
        });
      }

      if (activeAttempt) {
        await transitionPaymentAttemptState(client, activeAttempt.id, 'SUCCEEDED', {
          providerReference: transactionId,
        });
      }

      await inventoryService.commitStock(orderId, client);

      const insReceipt = await client.query(
        `INSERT INTO payment_receipts (order_id, transaction_id, amount, status, signature)
         VALUES ($1, $2, $3, 'SUCCESS', $4)
         ON CONFLICT (transaction_id) DO NOTHING
         RETURNING id, order_id, transaction_id, amount, status, signature, verified_at`,
        [orderId, transactionId, authoritativeAmount, signature]
      );

      let r = insReceipt.rows[0];
      if (!r) {
        const fetchReceipt = await client.query(
          `SELECT id, order_id, transaction_id, amount, status, signature, verified_at
           FROM payment_receipts
           WHERE transaction_id = $1
           LIMIT 1`,
          [transactionId]
        );
        r = fetchReceipt.rows[0];
      }
      const receipt: PaymentReceipt = {
        id: r?.id || crypto.randomUUID(),
        orderId: r?.order_id || orderId,
        transactionId: r?.transaction_id || transactionId,
        amount: r?.amount ? parseFloat(r.amount) : authoritativeAmount,
        status: r?.status || 'SUCCESS',
        signature: r?.signature || signature,
        verifiedAt: r?.verified_at instanceof Date ? r.verified_at.toISOString() : (r?.verified_at ? String(r.verified_at) : new Date().toISOString()),
      };

      await this.recordPaymentTransaction(client, {
        orderId,
        paymentIntentId: currentIntent?.id,
        paymentAttemptId: activeAttempt?.id,
        transactionType: 'CAPTURE',
        status: 'SUCCEEDED',
        amount: authoritativeAmount,
        currency: 'INR',
        paymentMode: o.payment_method,
        providerId: provider.providerId,
        externalReference: transactionId,
      });

      await ledgerService.recordOrderPayment({
        orderId,
        merchantId: o.merchant_id,
        grossAmount: authoritativeAmount,
        taxableAmount: parseFloat(o.taxable_amount || '0'),
        cgstAmount: parseFloat(o.cgst_amount || '0'),
        sgstAmount: parseFloat(o.sgst_amount || '0'),
        deliveryFee: parseFloat(o.delivery_fee || '0'),
        handlingFee: parseFloat(o.handling_fee || '0'),
        client,
      });

      stagedEvents.push(
        paymentEventPublisher.createEvent('PaymentCaptured', {
          orderId,
          transactionId,
          amount: authoritativeAmount,
          currency: 'INR',
        })
      );

      paymentLogger.increment('captures');
      paymentLogger.log('info', 'PAYMENT_CAPTURED', {
        orderId,
        paymentIntentId: currentIntent?.id,
        attemptId: activeAttempt?.id,
        userId,
        providerId: provider.providerId,
      }, { amount: authoritativeAmount, currency: 'INR' });

      const updatedOrderRes = await client.query(`SELECT * FROM orders WHERE id = $1`, [orderId]);
      return {
        receipt,
        order: updatedOrderRes.rows[0],
        isDuplicate: false,
      };
    });

    if (stagedEvents.length > 0) {
      paymentEventPublisher.publishAll(stagedEvents);
    }

    if ((result as any)?.needsRefund) {
      try {
        await refundService.createRefund({
          orderId,
          amount: (result as any).authoritativeAmount,
          reasonCode: 'ORDER_CANCELLED_LATE_PAYMENT',
          reasonDescription: 'Automated refund for late payment on expired or cancelled order',
          refundType: 'FULL',
          idempotencyKey: `ref_late_${orderId}_${transactionId}`,
          createdBy: 'SYSTEM_LATE_PAYMENT_RECOVERY',
        });
      } catch (err: any) {
        paymentLogger.log('error', 'LATE_PAYMENT_REFUND_TRIGGER_FAILED', { orderId }, { error: err.message });
      }
    }

    return result;
  }

  /**
   * Authoritative Webhook Event Processing with raw body signature verification and transactional idempotency
   */
  public async processWebhook(params: {
    rawBody: Buffer | string;
    signature?: string;
    gateway?: string;
    headers?: Record<string, string | string[] | undefined>;
  }): Promise<WebhookProcessingResult> {
    const { rawBody, signature, gateway, headers } = params;
    const provider = this.getProvider(gateway);
    if (provider.providerId === 'none') {
      throw new Error(
        'PAYMENT_GATEWAY_NOT_CONFIGURED: No payment gateway is configured to verify or process webhooks.'
      );
    }
    const resolvedGateway = gateway || provider.providerId || 'UNSELECTED';

    const effectiveSignature = signature
      || (typeof headers?.['x-webhook-signature'] === 'string' ? headers['x-webhook-signature'] : undefined)
      || (typeof headers?.['x-signature'] === 'string' ? headers['x-signature'] : undefined)
      || (typeof headers?.['x-provider-signature'] === 'string' ? headers['x-provider-signature'] : undefined)
      || (typeof headers?.['x-razorpay-signature'] === 'string' ? headers['x-razorpay-signature'] : undefined)
      || (typeof (provider as any).extractSignature === 'function' ? (provider as any).extractSignature(headers || {}) : undefined)
      || '';

    const isValid = provider.verifyWebhookSignature({
      rawBody,
      headers: headers || (effectiveSignature ? { 'x-signature': effectiveSignature, 'x-razorpay-signature': effectiveSignature } : {}),
      signature: effectiveSignature,
    } as any);

    if (!isValid) {
      throw new Error('INVALID_WEBHOOK_SIGNATURE: Webhook cryptographic signature verification failed.');
    }

    let body: any;
    try {
      body = typeof rawBody === 'string' ? JSON.parse(rawBody) : JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new Error('INVALID_WEBHOOK_PAYLOAD: Failed to parse raw body JSON.');
    }

    const eventId = body.id || body.event_id;
    const eventType = body.event || body.event_type;

    if (!eventId || !eventType) {
      throw new Error('MISSING_EVENT_METADATA: Webhook payload missing eventId or eventType.');
    }

    if (eventType.startsWith('refund.') || eventType.startsWith('payout.')) {
      const finRes = await financialWebhookService.processFinancialWebhook({
        rawBody,
        signature: effectiveSignature,
        gateway: resolvedGateway,
      });
      return {
        success: finRes.success,
        duplicate: finRes.duplicate,
        eventId: finRes.eventId,
        eventType: finRes.eventType,
        message: finRes.message,
      };
    }

    const pool = getPool();

    const insertRes = await pool.query(
      `INSERT INTO webhook_events (event_id, gateway, event_type, payload, status, received_at)
       VALUES ($1, $2, $3, $4, 'RECEIVED', NOW())
       ON CONFLICT (event_id) DO NOTHING
       RETURNING id, status`,
      [eventId, resolvedGateway, eventType, JSON.stringify(body)]
    );

    if (insertRes.rows.length === 0) {
      const existingEvt = await pool.query(
        `SELECT status FROM webhook_events
         WHERE event_id = $1
         LIMIT 1`,
        [eventId]
      );

      if (existingEvt.rows.length > 0 && existingEvt.rows[0].status === 'PROCESSED') {
        paymentLogger.increment('duplicateBlocks');
        return {
          success: true,
          duplicate: true,
          eventId,
          eventType,
          message: 'Webhook event already processed successfully.',
        };
      }
    }

    const stagedEvents: PaymentDomainEvent[] = [];

    const paymentEntity = body.payload?.payment?.entity || body.payment || {};
    const orderEntity = body.payload?.order?.entity || body.order || {};

    const providerPaymentId = paymentEntity.id || body.payment_id || `evt_pay_${eventId}`;
    const providerOrderId = paymentEntity.order_id || orderEntity.id || body.order_id;
    const notes = paymentEntity.notes || orderEntity.notes || {};
    const targetOrderId = notes.orderId || notes.order_id || body.orderId;
    const webhookCurrency = paymentEntity.currency || orderEntity.currency || body.currency;

    let processingResult: any;
    try {
      processingResult = await transaction(async (client) => {
        const evtLock = await client.query(
          `SELECT status FROM webhook_events
           WHERE event_id = $1
           FOR UPDATE`,
          [eventId]
        );

        if (evtLock.rows.length > 0 && evtLock.rows[0].status === 'PROCESSED') {
          return {
            success: true,
            duplicate: true,
            eventId,
            eventType,
            orderId: targetOrderId,
            paymentState: 'CAPTURED' as PaymentState,
          };
        }

        let orderId = targetOrderId;
        let order: any = null;

        if (orderId) {
          const oRes = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
          if (oRes.rows.length > 0) order = oRes.rows[0];
        }

        if (!order && providerOrderId) {
          const intentRes = await client.query(
            `SELECT order_id FROM payment_intents
             WHERE payment_order_id = $1 OR provider_order_id = $1
             LIMIT 1`,
            [providerOrderId]
          );

          if (intentRes.rows.length > 0) {
            orderId = intentRes.rows[0].order_id;
            const oRes = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
            if (oRes.rows.length > 0) order = oRes.rows[0];
          }
        }

        if (!order) {
          await client.query(
            `UPDATE webhook_events
             SET status = 'IGNORED', processed_at = NOW(), error_message = 'No matching order found for webhook payload.'
             WHERE event_id = $1`,
            [eventId]
          );

          return {
            success: true,
            ignored: true,
            eventId,
            eventType,
            message: 'Webhook processed with status IGNORED (unmatched order).',
          };
        }

        if (webhookCurrency && String(webhookCurrency).toUpperCase() !== 'INR') {
          await client.query(
            `UPDATE webhook_events
             SET status = 'FAILED', error_message = 'CURRENCY_MISMATCH'
             WHERE event_id = $1`,
            [eventId]
          );
          throw new Error(`CURRENCY_MISMATCH: Webhook currency '${webhookCurrency}' does not match INR.`);
        }

        const authoritativeAmount = parseFloat(order.total_amount);

        if (paymentEntity.amount !== undefined) {
          const providerAmt = Number(paymentEntity.amount);
          const factor = (typeof provider.getCapabilities === 'function' ? provider.getCapabilities().currencySubunitFactor : 100) || 100;
          const expectedSubunit = Math.round(authoritativeAmount * factor);
          if (providerAmt !== expectedSubunit && Math.abs(providerAmt - authoritativeAmount) > 0.01) {
            await client.query(
              `UPDATE webhook_events
               SET status = 'FAILED', error_message = 'PAYMENT_AMOUNT_MISMATCH'
               WHERE event_id = $1`,
              [eventId]
            );
            throw new Error('PAYMENT_AMOUNT_MISMATCH: Webhook amount does not match authoritative order amount.');
          }
        }

        // Lock inventory reservations in consistent lock order BEFORE intents
        const resCheck = await client.query(
          `SELECT id, status, expires_at
           FROM inventory_reservations
           WHERE order_id = $1
           FOR UPDATE`,
          [order.id]
        );

        const intentRes = await client.query(
          `SELECT * FROM payment_intents
           WHERE order_id = $1
           ORDER BY created_at DESC
           LIMIT 1
           FOR UPDATE`,
          [order.id]
        );

        const currentIntent = intentRes.rows[0];
        const currentIntentStatus = (currentIntent?.status || 'CREATED') as PaymentState;

        let activeAttempt: any = null;
        try {
          const attRes = await client.query(
            `SELECT * FROM payment_attempts
             WHERE order_id = $1 AND status IN ('INITIATED', 'PENDING', 'PROCESSING', 'UNKNOWN', 'RECONCILIATION_REQUIRED')
             ORDER BY attempt_number DESC
             LIMIT 1
             FOR UPDATE`,
            [order.id]
          );
          activeAttempt = attRes.rows[0] || null;
        } catch {}

        const isSuccessEvent =
          eventType === 'payment.captured' ||
          eventType === 'order.paid' ||
          eventType === 'payment_success' ||
          eventType === 'payment.succeeded' ||
          eventType === 'PAYMENT_SUCCESS';

        if (isSuccessEvent) {
          if (order.payment_status === 'PAID') {
            paymentLogger.increment('duplicateBlocks');
            await client.query(
              `UPDATE webhook_events
               SET status = 'PROCESSED', processed_at = NOW()
               WHERE event_id = $1`,
              [eventId]
            );

            return {
              success: true,
              duplicate: true,
              eventId,
              eventType,
              orderId: order.id,
              paymentState: 'CAPTURED' as PaymentState,
            };
          }

          if (order.payment_status === 'REFUNDED' || order.payment_status === 'REFUND_PENDING' || order.payment_status === 'PARTIALLY_REFUNDED') {
            paymentLogger.increment('duplicateBlocks');
            await client.query(
              `UPDATE webhook_events
               SET status = 'PROCESSED', processed_at = NOW()
               WHERE event_id = $1`,
              [eventId]
            );

            return {
              success: true,
              duplicate: true,
              eventId,
              eventType,
              orderId: order.id,
              paymentState: 'REFUNDED' as PaymentState,
            };
          }

          const isOrderCancelled = (order.status || '').toLowerCase() === 'cancelled';
          const hasReservedInventory = resCheck.rows.length > 0 && resCheck.rows.every((r: any) => r.status === 'RESERVED');
          const isExpired = resCheck.rows.some((r: any) => new Date(r.expires_at).getTime() <= Date.now());
          const isIntentCancelled = ['CANCELLED', 'FAILED', 'EXPIRED'].includes(currentIntentStatus);
          const isLateOrCancelled = isOrderCancelled || !hasReservedInventory || isExpired || isIntentCancelled;

          if (isLateOrCancelled) {
            if (currentIntent) {
              await transitionPaymentIntentState(client, currentIntent.id, 'REFUND_PENDING', {
                providerPaymentId,
                allowLateCaptureCompensation: true,
                failureClassification: 'POLICY',
                errorCode: 'LATE_WEBHOOK_CAPTURE',
                errorDescription: 'Late webhook capture received for cancelled or expired order.',
              });
            }
            if (activeAttempt) {
              await transitionPaymentAttemptState(client, activeAttempt.id, 'SUCCEEDED', {
                providerReference: providerPaymentId,
              });
            }

            await client.query(
              `INSERT INTO payment_receipts (order_id, transaction_id, amount, status, signature)
               VALUES ($1, $2, $3, 'SUCCESS', $4)
               ON CONFLICT (transaction_id) DO NOTHING`,
              [order.id, providerPaymentId, authoritativeAmount, effectiveSignature]
            );

            const cancelReason = order.cancellation_reason || 'Payment received after reservation expired or order was cancelled';
            await client.query(
              `UPDATE orders
               SET payment_status = 'REFUND_PENDING',
                   status = 'cancelled',
                   cancellation_reason = $2,
                   updated_at = NOW()
               WHERE id = $1`,
              [order.id, cancelReason]
            );

            await this.recordPaymentTransaction(client, {
              orderId: order.id,
              paymentIntentId: currentIntent?.id,
              paymentAttemptId: activeAttempt?.id,
              transactionType: 'CAPTURE',
              status: 'SUCCEEDED',
              amount: authoritativeAmount,
              currency: 'INR',
              paymentMode: order.payment_method,
              providerId: resolvedGateway,
              externalReference: providerPaymentId,
              metadata: { lateWebhook: true, eventId },
            });

            await ledgerService.recordOrderPayment({
              orderId: order.id,
              merchantId: order.merchant_id,
              grossAmount: authoritativeAmount,
              taxableAmount: parseFloat(order.taxable_amount || '0'),
              cgstAmount: parseFloat(order.cgst_amount || '0'),
              sgstAmount: parseFloat(order.sgst_amount || '0'),
              deliveryFee: parseFloat(order.delivery_fee || '0'),
              handlingFee: parseFloat(order.handling_fee || '0'),
              client,
            });

            await inventoryService.releaseStock(order.id, client);

            await client.query(
              `UPDATE webhook_events
               SET status = 'PROCESSED', processed_at = NOW()
               WHERE event_id = $1`,
              [eventId]
            );

            return {
              success: true,
              duplicate: false,
              eventId,
              eventType,
              orderId: order.id,
              paymentState: 'CAPTURED' as PaymentState,
              needsRefund: true,
              authoritativeAmount,
              providerPaymentId,
            };
          }

          const transition = validatePaymentTransition(currentIntentStatus, 'CAPTURED');
          if (!transition.valid) {
            throw new Error(transition.error || 'INVALID_PAYMENT_STATE_TRANSITION');
          }

          await client.query(
            `UPDATE orders
             SET payment_status = 'PAID', updated_at = NOW()
             WHERE id = $1`,
            [order.id]
          );

          if (currentIntent) {
            await transitionPaymentIntentState(client, currentIntent.id, 'CAPTURED', {
              providerPaymentId,
            });
          }

          if (activeAttempt) {
            await transitionPaymentAttemptState(client, activeAttempt.id, 'SUCCEEDED', {
              providerReference: providerPaymentId,
            });
          }

          await inventoryService.commitStock(order.id, client);

          await client.query(
            `INSERT INTO payment_receipts (order_id, transaction_id, amount, status, signature)
             VALUES ($1, $2, $3, 'SUCCESS', $4)
             ON CONFLICT (transaction_id) DO NOTHING`,
            [order.id, providerPaymentId, authoritativeAmount, effectiveSignature]
          );

          await this.recordPaymentTransaction(client, {
            orderId: order.id,
            paymentIntentId: currentIntent?.id,
            paymentAttemptId: activeAttempt?.id,
            transactionType: 'CAPTURE',
            status: 'SUCCEEDED',
            amount: authoritativeAmount,
            currency: 'INR',
            paymentMode: order.payment_method,
            providerId: resolvedGateway,
            externalReference: providerPaymentId,
            metadata: { webhookEventId: eventId },
          });

          await ledgerService.recordOrderPayment({
            orderId: order.id,
            merchantId: order.merchant_id,
            grossAmount: authoritativeAmount,
            taxableAmount: parseFloat(order.taxable_amount || '0'),
            cgstAmount: parseFloat(order.cgst_amount || '0'),
            sgstAmount: parseFloat(order.sgst_amount || '0'),
            deliveryFee: parseFloat(order.delivery_fee || '0'),
            handlingFee: parseFloat(order.handling_fee || '0'),
            client,
          });

          stagedEvents.push(
            paymentEventPublisher.createEvent('PaymentCaptured', {
              orderId: order.id,
              transactionId: providerPaymentId,
              amount: authoritativeAmount,
              currency: 'INR',
            })
          );

          paymentLogger.increment('captures');
          paymentLogger.log('info', 'PAYMENT_WEBHOOK_CAPTURED', {
            orderId: order.id,
            paymentIntentId: currentIntent?.id,
            eventId,
            providerId: resolvedGateway,
          }, { amount: authoritativeAmount });

          await client.query(
            `UPDATE webhook_events
             SET status = 'PROCESSED', processed_at = NOW()
             WHERE event_id = $1`,
            [eventId]
          );

          return {
            success: true,
            duplicate: false,
            eventId,
            eventType,
            orderId: order.id,
            paymentState: 'CAPTURED' as PaymentState,
          };
        } else if (eventType === 'payment.failed') {
          if (order.payment_status !== 'PAID') {
            if (currentIntent && !['FAILED', 'CANCELLED', 'EXPIRED', 'CAPTURED', 'REFUNDED', 'REFUND_PENDING'].includes(currentIntentStatus)) {
              await transitionPaymentIntentState(client, currentIntent.id, 'FAILED', {
                errorCode: paymentEntity.error_code || 'PAYMENT_FAILED',
                errorDescription: paymentEntity.error_description || 'Payment capture failed at provider.',
                failureClassification: 'PERMANENT',
              });
            }
            if (activeAttempt) {
              await transitionPaymentAttemptState(client, activeAttempt.id, 'FAILED', {
                errorCode: paymentEntity.error_code || 'PAYMENT_FAILED',
                errorMessage: paymentEntity.error_description || 'Payment capture failed at provider.',
                failureClassification: 'PERMANENT',
                retryEligible: true,
              });
            }

            await this.recordPaymentTransaction(client, {
              orderId: order.id,
              paymentIntentId: currentIntent?.id,
              paymentAttemptId: activeAttempt?.id,
              transactionType: 'CAPTURE',
              status: 'FAILED',
              amount: authoritativeAmount,
              currency: 'INR',
              paymentMode: order.payment_method,
              providerId: resolvedGateway,
              externalReference: providerPaymentId,
              metadata: { errorCode: paymentEntity.error_code || 'PAYMENT_FAILED', eventId },
            });

            await inventoryService.releaseStock(order.id, client);
            await client.query(
              `UPDATE orders
               SET status = 'cancelled',
                   cancellation_reason = 'Payment failed at provider',
                   updated_at = NOW()
               WHERE id = $1 AND payment_status != 'PAID'`,
              [order.id]
            );

            stagedEvents.push(
              paymentEventPublisher.createEvent('PaymentFailed', {
                orderId: order.id,
                providerPaymentId,
                errorCode: paymentEntity.error_code || 'PAYMENT_FAILED',
              })
            );
            paymentLogger.increment('failures');
          }

          await client.query(
            `UPDATE webhook_events
             SET status = 'PROCESSED', processed_at = NOW()
             WHERE event_id = $1`,
            [eventId]
          );

          return {
            success: true,
            duplicate: false,
            eventId,
            eventType,
            orderId: order.id,
            paymentState: 'FAILED' as PaymentState,
          };
        } else {
          await client.query(
            `UPDATE webhook_events
             SET status = 'PROCESSED', processed_at = NOW()
             WHERE event_id = $1`,
            [eventId]
          );

          return {
            success: true,
            eventId,
            eventType,
            orderId: order.id,
          };
        }
      });
    } catch (err: any) {
      if (err.message?.includes('PAYMENT_AMOUNT_MISMATCH') || err.message?.includes('CURRENCY_MISMATCH')) {
        try {
          const errorCode = err.message.includes('CURRENCY_MISMATCH')
            ? 'CURRENCY_MISMATCH'
            : 'PAYMENT_AMOUNT_MISMATCH';
          await pool.query(
            `UPDATE webhook_events
             SET status = 'FAILED', error_message = $2
             WHERE event_id = $1`,
            [eventId, errorCode]
          );
        } catch {}
      }
      throw err;
    }

    if (stagedEvents.length > 0) {
      paymentEventPublisher.publishAll(stagedEvents);
    }

    if ((processingResult as any)?.needsRefund) {
      try {
        await refundService.createRefund({
          orderId: (processingResult as any).orderId,
          amount: (processingResult as any).authoritativeAmount,
          reasonCode: 'ORDER_CANCELLED_LATE_PAYMENT',
          reasonDescription: 'Automated refund for late payment webhook on expired or cancelled order',
          refundType: 'FULL',
          idempotencyKey: `ref_late_wh_${(processingResult as any).orderId}_${(processingResult as any).providerPaymentId}`,
          createdBy: 'SYSTEM_LATE_WEBHOOK_RECOVERY',
        });
      } catch (err: any) {
        paymentLogger.log('error', 'LATE_WEBHOOK_REFUND_FAILED', { orderId: (processingResult as any).orderId }, { error: err.message });
      }
    }

    return processingResult;
  }

  /**
   * Retrieves safe payment status summary for authenticated order owner
   * Protected with Bloom Filter negative lookup
   */
  public async getPaymentStatus(orderId: string, userId: string): Promise<PaymentStatusSummary> {
    if (!(await bloomFilterService.mightContainSafe('orders', orderId))) {
      throw new Error('ORDER_NOT_FOUND: Order not found.');
    }

    const pool = getPool();

    const orderRes = await pool.query(
      `SELECT id, user_id, payment_status, payment_method, total_amount
       FROM orders
       WHERE id = $1
       LIMIT 1`,
      [orderId]
    );

    if (orderRes.rows.length === 0) {
      bloomFilterService.recordFalsePositive();
      throw new Error('ORDER_NOT_FOUND: Order not found.');
    }

    const o = orderRes.rows[0];
    if (o.user_id !== userId) {
      throw new Error('UNAUTHORIZED_PAYMENT_ACCESS: User is not authorized to view payment details for this order.');
    }

    const intentsRes = await pool.query(
      `SELECT id, payment_order_id, amount, currency, status, created_at
       FROM payment_intents
       WHERE order_id = $1
       ORDER BY created_at DESC`,
      [orderId]
    );

    const receiptRes = await pool.query(
      `SELECT transaction_id, amount, status, verified_at
       FROM payment_receipts
       WHERE order_id = $1
       LIMIT 1`,
      [orderId]
    );

    let attempts: PaymentAttempt[] = [];
    try {
      const attRes = await pool.query(
        `SELECT id, order_id, payment_intent_id, attempt_number, provider_id, provider_reference,
                status, amount, currency, idempotency_key, error_code, error_message, initiated_at, completed_at
         FROM payment_attempts
         WHERE order_id = $1
         ORDER BY attempt_number ASC`,
        [orderId]
      );
      attempts = attRes.rows.map((r) => ({
        id: r.id,
        orderId: r.order_id,
        paymentIntentId: r.payment_intent_id,
        attemptNumber: r.attempt_number,
        providerId: r.provider_id,
        providerReference: r.provider_reference,
        status: r.status,
        amount: parseFloat(r.amount),
        currency: r.currency,
        idempotencyKey: r.idempotency_key,
        errorCode: r.error_code,
        errorMessage: r.error_message,
        initiatedAt: r.initiated_at instanceof Date ? r.initiated_at.toISOString() : String(r.initiated_at),
        completedAt: r.completed_at ? (r.completed_at instanceof Date ? r.completed_at.toISOString() : String(r.completed_at)) : undefined,
      }));
    } catch {
      // Optional in legacy harness
    }

    return {
      orderId: o.id,
      paymentStatus: o.payment_status,
      paymentMethod: o.payment_method,
      totalAmount: parseFloat(o.total_amount),
      intents: intentsRes.rows.map((row) => ({
        id: row.id,
        paymentOrderId: row.payment_order_id,
        amount: parseFloat(row.amount),
        currency: row.currency,
        status: row.status as PaymentState,
        createdAt: row.created_at.toISOString(),
      })),
      attempts: attempts.length > 0 ? attempts : undefined,
      receipt: receiptRes.rows.length > 0 ? {
        transactionId: receiptRes.rows[0].transaction_id,
        amount: parseFloat(receiptRes.rows[0].amount),
        status: receiptRes.rows[0].status,
        verifiedAt: receiptRes.rows[0].verified_at.toISOString(),
      } : undefined,
    };
  }

  /**
   * Authoritative Single-Order Provider Reconciliation
   * Queries provider status without guessing outcomes and updates state via centralized transition guards.
   */
  public async reconcilePayment(orderId: string): Promise<ReconciliationResult> {
    return await transaction(async (client) => {
      // Lock order -> inventory_reservations -> payment_intents -> payment_attempts
      const orderRes = await client.query(
        `SELECT * FROM orders WHERE id = $1 FOR UPDATE`,
        [orderId]
      );

      if (orderRes.rows.length === 0) {
        throw new Error('ORDER_NOT_FOUND: Order not found.');
      }

      const o = orderRes.rows[0];
      if (o.payment_status === 'PAID') {
        return {
          orderId,
          status: 'CAPTURED',
          reconciled: true,
          action: 'ALREADY_FINAL',
          message: 'Order is already marked PAID. No reconciliation needed.',
        };
      }

      if (o.payment_status === 'REFUNDED') {
        return {
          orderId,
          status: 'REFUNDED',
          reconciled: true,
          action: 'ALREADY_FINAL',
          message: 'Order is already marked REFUNDED. No reconciliation needed.',
        };
      }

      const resCheck = await client.query(
        `SELECT id, status, expires_at FROM inventory_reservations WHERE order_id = $1 FOR UPDATE`,
        [orderId]
      );

      const intentRes = await client.query(
        `SELECT * FROM payment_intents
         WHERE order_id = $1
         ORDER BY created_at DESC
         LIMIT 1
         FOR UPDATE`,
        [orderId]
      );

      if (intentRes.rows.length === 0) {
        return {
          orderId,
          status: (o.payment_status || 'CREATED') as PaymentState,
          reconciled: false,
          action: 'ALREADY_FINAL',
          message: 'No payment intent found to reconcile.',
        };
      }

      const intent = intentRes.rows[0];
      const providerId = intent.active_provider;
      const provider = this.getProvider(providerId);

      const providerRef = intent.provider_order_id || intent.payment_order_id;
      const providerPaymentId = intent.provider_payment_id;

      let activeAttempt: any = null;
      try {
        const attRes = await client.query(
          `SELECT * FROM payment_attempts
           WHERE order_id = $1 AND status IN ('INITIATED', 'PENDING', 'PROCESSING', 'UNKNOWN', 'RECONCILIATION_REQUIRED')
           ORDER BY attempt_number DESC
           LIMIT 1
           FOR UPDATE`,
          [orderId]
        );
        activeAttempt = attRes.rows[0] || null;
      } catch {}

      let providerStatus;
      try {
        providerStatus = await provider.getPaymentStatus(providerRef, providerPaymentId);
      } catch (err: any) {
        const nextRetry = computeNextRetryAt((intent.reconciliation_attempts || 0) + 1);
        if (!['CAPTURED', 'REFUNDED', 'PARTIALLY_REFUNDED'].includes(intent.status)) {
          await transitionPaymentIntentState(client, intent.id, 'RECONCILIATION_REQUIRED', {
            failureClassification: 'TRANSIENT' as FailureClassification,
            errorCode: 'PROVIDER_STATUS_INQUIRY_FAILED',
            errorDescription: err.message,
            nextRetryAt: nextRetry,
          });
        }
        paymentLogger.increment('unknownOutcomes');
        return {
          orderId,
          status: 'RECONCILIATION_REQUIRED',
          reconciled: false,
          action: 'RECONCILIATION_REQUIRED',
          message: `Provider status inquiry failed (${err.message}). Marked RECONCILIATION_REQUIRED.`,
        };
      }

      const authoritativeAmount = parseFloat(o.total_amount);

      if (providerStatus.status === 'SUCCEEDED') {
        const resolvedPaymentId = providerStatus.providerPaymentId || `pay_rec_${intent.id.slice(0, 8)}`;

        const isCancelled = (o.status || '').toLowerCase() === 'cancelled';
        const hasReserved = resCheck.rows.length > 0 && resCheck.rows.every((r: any) => r.status === 'RESERVED');
        const isExpired = resCheck.rows.some((r: any) => new Date(r.expires_at).getTime() <= Date.now());

        if (isCancelled || !hasReserved || isExpired) {
          await transitionPaymentIntentState(client, intent.id, 'REFUND_PENDING', {
            providerPaymentId: resolvedPaymentId,
            allowLateCaptureCompensation: true,
            failureClassification: 'POLICY',
            errorCode: 'LATE_RECONCILED_CAPTURE',
          });
          if (activeAttempt) {
            await transitionPaymentAttemptState(client, activeAttempt.id, 'SUCCEEDED', {
              providerReference: resolvedPaymentId,
            });
          }

          await client.query(
            `INSERT INTO payment_receipts (order_id, transaction_id, amount, status, signature)
             VALUES ($1, $2, $3, 'SUCCESS', 'reconciled_sig')
             ON CONFLICT (transaction_id) DO NOTHING`,
            [orderId, resolvedPaymentId, authoritativeAmount]
          );

          await client.query(
            `UPDATE orders
             SET payment_status = 'REFUND_PENDING', status = 'cancelled', updated_at = NOW()
             WHERE id = $1`,
            [orderId]
          );

          await this.recordPaymentTransaction(client, {
            orderId,
            paymentIntentId: intent.id,
            paymentAttemptId: activeAttempt?.id,
            transactionType: 'CAPTURE',
            status: 'SUCCEEDED',
            amount: authoritativeAmount,
            currency: 'INR',
            paymentMode: o.payment_method,
            providerId: provider.providerId,
            externalReference: resolvedPaymentId,
            metadata: { reconciledLate: true },
          });

          await ledgerService.recordOrderPayment({
            orderId,
            merchantId: o.merchant_id,
            grossAmount: authoritativeAmount,
            taxableAmount: parseFloat(o.taxable_amount || '0'),
            cgstAmount: parseFloat(o.cgst_amount || '0'),
            sgstAmount: parseFloat(o.sgst_amount || '0'),
            deliveryFee: parseFloat(o.delivery_fee || '0'),
            handlingFee: parseFloat(o.handling_fee || '0'),
            client,
          });

          await inventoryService.releaseStock(orderId, client);

          paymentLogger.increment('captures');
          return {
            orderId,
            status: 'REFUND_PENDING',
            reconciled: true,
            action: 'CAPTURED',
            message: 'Payment confirmed captured by provider for expired/cancelled order. Routed to REFUND_PENDING.',
            providerPaymentId: resolvedPaymentId,
          };
        }

        await client.query(`UPDATE orders SET payment_status = 'PAID', updated_at = NOW() WHERE id = $1`, [orderId]);

        await transitionPaymentIntentState(client, intent.id, 'CAPTURED', {
          providerPaymentId: resolvedPaymentId,
        });

        await inventoryService.commitStock(orderId, client);

        await client.query(
          `INSERT INTO payment_receipts (order_id, transaction_id, amount, status, signature)
           VALUES ($1, $2, $3, 'SUCCESS', 'reconciled_sig')
           ON CONFLICT (transaction_id) DO NOTHING`,
          [orderId, resolvedPaymentId, authoritativeAmount]
        );

        await this.recordPaymentTransaction(client, {
          orderId,
          paymentIntentId: intent.id,
          paymentAttemptId: activeAttempt?.id,
          transactionType: 'CAPTURE',
          status: 'SUCCEEDED',
          amount: authoritativeAmount,
          currency: 'INR',
          paymentMode: o.payment_method,
          providerId: provider.providerId,
          externalReference: resolvedPaymentId,
          metadata: { reconciled: true },
        });

        await ledgerService.recordOrderPayment({
          orderId,
          merchantId: o.merchant_id,
          grossAmount: authoritativeAmount,
          taxableAmount: parseFloat(o.taxable_amount || '0'),
          cgstAmount: parseFloat(o.cgst_amount || '0'),
          sgstAmount: parseFloat(o.sgst_amount || '0'),
          deliveryFee: parseFloat(o.delivery_fee || '0'),
          handlingFee: parseFloat(o.handling_fee || '0'),
          client,
        });

        if (activeAttempt) {
          await transitionPaymentAttemptState(client, activeAttempt.id, 'SUCCEEDED', {
            providerReference: resolvedPaymentId,
          });
        }

        paymentLogger.increment('captures');
        return {
          orderId,
          status: 'CAPTURED',
          reconciled: true,
          action: 'CAPTURED',
          message: 'Payment successfully captured and reconciled. Stock committed and ledger journalized.',
          providerPaymentId: resolvedPaymentId,
        };
      }

      if (providerStatus.status === 'FAILED') {
        if (!['FAILED', 'CANCELLED', 'EXPIRED'].includes(intent.status)) {
          await transitionPaymentIntentState(client, intent.id, 'FAILED', {
            errorCode: 'PROVIDER_FAILED',
            errorDescription: providerStatus.failureReason || 'Payment confirmed failed at provider.',
            failureClassification: 'PERMANENT',
          });
        }

        await inventoryService.releaseStock(orderId, client);

        await client.query(
          `UPDATE orders
           SET status = 'cancelled', cancellation_reason = 'Payment failed at provider', updated_at = NOW()
           WHERE id = $1 AND payment_status != 'PAID'`,
          [orderId]
        );

        if (activeAttempt) {
          await transitionPaymentAttemptState(client, activeAttempt.id, 'FAILED', {
            errorCode: 'PROVIDER_FAILED',
            errorMessage: providerStatus.failureReason || 'Payment failed at provider.',
            failureClassification: 'PERMANENT',
            retryEligible: true,
          });
        }

        paymentLogger.increment('failures');
        return {
          orderId,
          status: 'FAILED',
          reconciled: true,
          action: 'FAILED',
          message: 'Payment confirmed failed by provider. Stock released and order cancelled.',
        };
      }

      // Ambiguous / UNKNOWN / still PENDING
      const nextRetry = computeNextRetryAt((intent.reconciliation_attempts || 0) + 1);
      if (intent.status !== 'RECONCILIATION_REQUIRED' && !['CAPTURED', 'FAILED', 'CANCELLED', 'EXPIRED', 'REFUNDED'].includes(intent.status)) {
        await transitionPaymentIntentState(client, intent.id, 'RECONCILIATION_REQUIRED', {
          failureClassification: 'AMBIGUOUS',
          errorCode: 'PROVIDER_STATUS_AMBIGUOUS',
          errorDescription: `Provider reported status '${providerStatus.status}'. Requires further reconciliation.`,
          nextRetryAt: nextRetry,
        });
      }
      if (activeAttempt && ['INITIATED', 'PENDING', 'PROCESSING'].includes(activeAttempt.status)) {
        await transitionPaymentAttemptState(client, activeAttempt.id, 'UNKNOWN', {
          failureClassification: 'AMBIGUOUS',
          errorCode: 'PROVIDER_STATUS_AMBIGUOUS',
          retryEligible: true,
          nextRetryAt: nextRetry,
        });
      }

      paymentLogger.increment('unknownOutcomes');
      return {
        orderId,
        status: 'RECONCILIATION_REQUIRED',
        reconciled: false,
        action: 'RECONCILIATION_REQUIRED',
        message: 'Provider reports payment status as UNKNOWN/PENDING. Marked RECONCILIATION_REQUIRED.',
      };
    });
  }

  /**
   * Transitions expired, uncaptured payment intents and open attempts cleanly to EXPIRED.
   */
  public async expireStalePaymentIntents(limit: number = 50): Promise<{ expiredIntents: number }> {
    return await transaction(async (client) => {
      const staleRes = await client.query(
        `SELECT id, order_id
         FROM payment_intents
         WHERE status IN ('CREATED', 'INITIATED', 'PENDING', 'PROCESSING')
           AND expires_at <= NOW()
         ORDER BY expires_at ASC
         LIMIT $1
         FOR UPDATE`,
        [limit]
      );

      let expiredIntents = 0;
      for (const row of staleRes.rows) {
        await transitionPaymentIntentState(client, row.id, 'EXPIRED', {
          errorCode: 'INTENT_EXPIRED',
          errorDescription: 'Payment intent validity window lapsed without capture.',
          failureClassification: 'POLICY',
        });

        try {
          const attRes = await client.query(
            `SELECT id FROM payment_attempts
             WHERE payment_intent_id = $1 AND status IN ('INITIATED', 'PENDING', 'PROCESSING')
             FOR UPDATE`,
            [row.id]
          );
          for (const att of attRes.rows) {
            await transitionPaymentAttemptState(client, att.id, 'EXPIRED', {
              errorCode: 'ATTEMPT_EXPIRED',
              errorMessage: 'Parent payment intent expired.',
              failureClassification: 'POLICY',
              retryEligible: true,
            });
          }
        } catch {}

        paymentEventPublisher.emit('PaymentExpired', {
          orderId: row.order_id,
          paymentIntentId: row.id,
        });
        expiredIntents++;
      }

      return { expiredIntents };
    });
  }
}

export const paymentService = new PaymentService();
