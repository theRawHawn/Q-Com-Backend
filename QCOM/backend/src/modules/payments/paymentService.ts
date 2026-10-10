import crypto from 'crypto';
import pg from 'pg';
import { getPool, transaction } from '../../database/connection.js';
import { env } from '../../config/env.js';
import { PaymentIntent, PaymentReceipt, WebhookProcessingResult, PaymentStatusSummary } from './paymentTypes.js';
import { validatePaymentTransition, PaymentState } from './paymentStateMachine.js';
import { paymentEventPublisher, PaymentDomainEvent } from './paymentEvents.js';
import { getPaymentProvider, PaymentProvider } from './paymentProvider.js';
import { inventoryService } from '../inventory/inventoryService.js';
import { ledgerService } from '../ledger/ledgerService.js';
import { bloomFilterService } from '../resilience/bloomFilterService.js';

export class PaymentService {
  private provider: PaymentProvider;

  constructor() {
    this.provider = getPaymentProvider();
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
      msg.includes('timeout')
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
   * Generates a cryptographic Payment Intent from the authoritative order record in PostgreSQL
   */
  public async createPaymentOrder(
    orderId: string,
    userId: string,
    clientOverride?: pg.PoolClient
  ): Promise<PaymentIntent> {
    const runner = clientOverride || getPool();

    const orderRes = await runner.query(`
      SELECT id, user_id, total_amount, payment_status, payment_method, status
      FROM orders
      WHERE id = $1
      LIMIT 1
    `, [orderId]);

    if (orderRes.rows.length === 0) {
      throw new Error('ORDER_NOT_FOUND: Order not found.');
    }

    const o = orderRes.rows[0];
    if (o.user_id !== userId) {
      throw new Error('UNAUTHORIZED_ORDER_ACCESS: Authenticated user does not own this order.');
    }

    if (o.payment_method === 'Pay on Delivery') {
      throw new Error('COD_ORDER_CANNOT_INITIATE_ONLINE_PAYMENT: Cash on Delivery orders cannot generate online payment intents.');
    }

    if (o.payment_status === 'PAID') {
      throw new Error('ORDER_ALREADY_PAID: Cannot initiate payment for an order that is already paid.');
    }

    if (o.status === 'CANCELLED') {
      throw new Error('ORDER_CANCELLED: Cannot initiate payment for a cancelled order.');
    }

    const authoritativeAmount = parseFloat(o.total_amount);
    const timestamp = Date.now();

    // Generate provider order and signature
    const providerResult = await this.provider.createOrder(orderId, authoritativeAmount, timestamp);
    const signature = providerResult.signature || this.generatePaymentSignature(orderId, authoritativeAmount, timestamp);
    const paymentOrderId = providerResult.providerOrderId;

    await runner.query(`
      INSERT INTO payment_intents (
        payment_order_id, order_id, amount, currency, status, signature,
        provider_order_id, created_at, updated_at
      )
      VALUES ($1, $2, $3, 'INR', 'CREATED', $4, $5, NOW(), NOW())
    `, [paymentOrderId, orderId, authoritativeAmount, signature, paymentOrderId]);

    // Emit PaymentCreated domain event post-insert
    paymentEventPublisher.emit('PaymentCreated', {
      orderId,
      paymentOrderId,
      amount: authoritativeAmount,
      currency: 'INR',
    });

    return {
      id: paymentOrderId,
      paymentOrderId,
      orderId,
      amount: authoritativeAmount,
      currency: 'INR',
      status: 'CREATED',
      signature,
      timestamp: new Date(timestamp).toISOString(),
      providerOrderId: paymentOrderId,
    };
  }

  /**
   * Verifies cryptographic signature and captures payment atomically
   * Enforces row-level locks, prevents duplicate side effects, checks amount tampering
   */
  public async verifyPayment(params: {
    orderId: string;
    transactionId: string;
    timestamp: number;
    signature: string;
    amount?: number;
    userId: string;
    razorpayOrderId?: string;
  }): Promise<{ receipt: PaymentReceipt; order: any; isDuplicate?: boolean }> {
    const { orderId, transactionId, timestamp, signature, amount, userId, razorpayOrderId } = params;

    const stagedEvents: PaymentDomainEvent[] = [];

    const result = await transaction(async (client) => {
      // 1. Fetch & lock authoritative order row
      const orderRes = await client.query(`
        SELECT * FROM orders
        WHERE id = $1
        FOR UPDATE
      `, [orderId]);

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

      // 2. Client Amount Tampering Protection:
      if (amount !== undefined && amount !== null) {
        const clientAmt = Number(amount);
        if (Math.abs(clientAmt - authoritativeAmount) > 0.001) {
          throw new Error('PAYMENT_AMOUNT_MISMATCH: Client-submitted amount does not match authoritative order total.');
        }
      }

      // 3. Row-level lock on latest payment_intent for this order
      const intentRes = await client.query(`
        SELECT * FROM payment_intents
        WHERE order_id = $1
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE
      `, [orderId]);

      const currentIntent = intentRes.rows[0];
      const currentIntentStatus = (currentIntent?.status || 'CREATED') as PaymentState;

      // 4. Duplicate / Concurrency Check: If order is already PAID (e.g. via webhook race)
      if (o.payment_status === 'PAID') {
        const receiptRes = await client.query(`
          SELECT id, order_id, transaction_id, amount, status, signature, verified_at
          FROM payment_receipts
          WHERE order_id = $1
          LIMIT 1
        `, [orderId]);

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

      // 5. Replay attack defense: Verify transactionId was never previously captured for any order
      const checkTx = await client.query(`
        SELECT id, order_id FROM payment_receipts
        WHERE transaction_id = $1
        LIMIT 1
      `, [transactionId]);

      if (checkTx.rows.length > 0) {
        if (checkTx.rows[0].order_id !== orderId) {
          throw new Error(`Replay attack detected: Transaction ID '${transactionId}' has already been processed for order '${checkTx.rows[0].order_id}'.`);
        }
      }

      // 6. Payment State Machine Transition Validation
      const transition = validatePaymentTransition(currentIntentStatus, 'CAPTURED');
      if (!transition.valid) {
        throw new Error(transition.error || 'INVALID_PAYMENT_STATE_TRANSITION');
      }

      // 7. Cryptographic Signature Validation
      const isSigValid = this.provider.verifyPaymentSignature({
        orderId,
        transactionId,
        amount: authoritativeAmount,
        timestamp,
        signature,
        razorpayOrderId: razorpayOrderId || currentIntent?.payment_order_id,
      });

      if (!isSigValid) {
        throw new Error('Cryptographic signature verification failed. Payment payload may have been tampered with.');
      }

      // 8. Atomically update order payment status
      await client.query(`
        UPDATE orders
        SET payment_status = 'PAID'
        WHERE id = $1
      `, [orderId]);

      // 9. Update payment_intents to CAPTURED
      if (currentIntent) {
        await client.query(`
          UPDATE payment_intents
          SET status = 'CAPTURED', provider_payment_id = $2, updated_at = NOW()
          WHERE id = $1
        `, [currentIntent.id, transactionId]);
      }

      // 10. Exactly-Once Inventory Commit
      await inventoryService.commitStock(orderId, client);

      // 11. Record payment receipt
      const insReceipt = await client.query(`
        INSERT INTO payment_receipts (order_id, transaction_id, amount, status, signature)
        VALUES ($1, $2, $3, 'SUCCESS', $4)
        RETURNING id, order_id, transaction_id, amount, status, signature, verified_at
      `, [orderId, transactionId, authoritativeAmount, signature]);

      const r = insReceipt.rows[0];
      const receipt: PaymentReceipt = {
        id: r.id,
        orderId: r.order_id,
        transactionId: r.transaction_id,
        amount: parseFloat(r.amount),
        status: r.status,
        signature: r.signature,
        verifiedAt: r.verified_at.toISOString(),
      };

      // 12. Double-entry financial ledger journal
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

      // 13. Stage PaymentCaptured Domain Event (Post-Commit Invariant)
      stagedEvents.push(
        paymentEventPublisher.createEvent('PaymentCaptured', {
          orderId,
          transactionId,
          amount: authoritativeAmount,
          currency: 'INR',
        })
      );

      const updatedOrderRes = await client.query(`SELECT * FROM orders WHERE id = $1`, [orderId]);
      return {
        receipt,
        order: updatedOrderRes.rows[0],
        isDuplicate: false,
      };
    });

    // 14. Emit staged domain events strictly post-commit
    if (stagedEvents.length > 0) {
      paymentEventPublisher.publishAll(stagedEvents);
    }

    return result;
  }

  /**
   * Authoritative Webhook Event Processing with raw body signature verification and transactional idempotency
   */
  public async processWebhook(params: {
    rawBody: Buffer | string;
    signature: string;
    gateway?: string;
  }): Promise<WebhookProcessingResult> {
    const { rawBody, signature, gateway = 'RAZORPAY' } = params;

    // 1. Signature Verification on EXACT raw body buffer
    const isValid = this.provider.verifyWebhookSignature({
      rawBody,
      signature,
    });

    if (!isValid) {
      throw new Error('INVALID_WEBHOOK_SIGNATURE: Webhook cryptographic signature verification failed.');
    }

    // 2. Parse payload from raw buffer
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

    const pool = getPool();

    // 3. Webhook Idempotency Check: check if eventId was already successfully processed
    const existingEvt = await pool.query(`
      SELECT status FROM webhook_events
      WHERE event_id = $1
      LIMIT 1
    `, [eventId]);

    if (existingEvt.rows.length > 0 && existingEvt.rows[0].status === 'PROCESSED') {
      return {
        success: true,
        duplicate: true,
        eventId,
        eventType,
        message: 'Webhook event already processed successfully.',
      };
    }

    // Insert or update webhook_events to RECEIVED
    await pool.query(`
      INSERT INTO webhook_events (event_id, gateway, event_type, payload, status, received_at)
      VALUES ($1, $2, $3, $4, 'RECEIVED', NOW())
      ON CONFLICT (event_id) DO NOTHING
    `, [eventId, gateway, eventType, JSON.stringify(body)]);

    const stagedEvents: PaymentDomainEvent[] = [];

    // 4. Extract payment details from Razorpay or generic provider payload
    const paymentEntity = body.payload?.payment?.entity || body.payment || {};
    const orderEntity = body.payload?.order?.entity || body.order || {};

    const providerPaymentId = paymentEntity.id || body.payment_id || `pay_${crypto.randomBytes(6).toString('hex')}`;
    const providerOrderId = paymentEntity.order_id || orderEntity.id || body.order_id;
    const notes = paymentEntity.notes || orderEntity.notes || {};
    const targetOrderId = notes.orderId || notes.order_id || body.orderId;

    // 5. Transactional Processing
    const processingResult = await transaction(async (client) => {
      // Find the authoritative order
      let orderId = targetOrderId;
      let order: any = null;

      if (orderId) {
        const oRes = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
        if (oRes.rows.length > 0) order = oRes.rows[0];
      }

      // If order not found directly by UUID, resolve via payment_intents
      if (!order && providerOrderId) {
        const intentRes = await client.query(`
          SELECT order_id FROM payment_intents
          WHERE payment_order_id = $1 OR provider_order_id = $1
          LIMIT 1
        `, [providerOrderId]);

        if (intentRes.rows.length > 0) {
          orderId = intentRes.rows[0].order_id;
          const oRes = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
          if (oRes.rows.length > 0) order = oRes.rows[0];
        }
      }

      if (!order) {
        // Record as IGNORED if no matching order found
        await client.query(`
          UPDATE webhook_events
          SET status = 'IGNORED', processed_at = NOW(), error_message = 'No matching order found for webhook payload.'
          WHERE event_id = $1
        `, [eventId]);

        return {
          success: true,
          ignored: true,
          eventId,
          eventType,
          message: 'Webhook processed with status IGNORED (unmatched order).',
        };
      }

      const authoritativeAmount = parseFloat(order.total_amount);

      // Check amount matching if provider supplies amount
      if (paymentEntity.amount !== undefined) {
        // Razorpay amounts are passed in paise (e.g. 50000 = 500.00 INR)
        const providerAmt = Number(paymentEntity.amount);
        const expectedPaise = Math.round(authoritativeAmount * 100);
        // Compare either directly or via paise
        if (providerAmt !== expectedPaise && Math.abs(providerAmt - authoritativeAmount) > 0.01) {
          await client.query(`
            UPDATE webhook_events
            SET status = 'FAILED', error_message = 'PAYMENT_AMOUNT_MISMATCH'
            WHERE event_id = $1
          `, [eventId]);
          throw new Error('PAYMENT_AMOUNT_MISMATCH: Webhook amount does not match authoritative order amount.');
        }
      }

      // Lock payment_intents
      const intentRes = await client.query(`
        SELECT * FROM payment_intents
        WHERE order_id = $1
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE
      `, [order.id]);

      const currentIntent = intentRes.rows[0];
      const currentIntentStatus = (currentIntent?.status || 'CREATED') as PaymentState;

      // Handle Event Types
      if (eventType === 'payment.captured' || eventType === 'order.paid') {
        // Concurrency / Duplicate check
        if (order.payment_status === 'PAID') {
          await client.query(`
            UPDATE webhook_events
            SET status = 'PROCESSED', processed_at = NOW()
            WHERE event_id = $1
          `, [eventId]);

          return {
            success: true,
            duplicate: true,
            eventId,
            eventType,
            orderId: order.id,
            paymentState: 'CAPTURED' as PaymentState,
          };
        }

        const transition = validatePaymentTransition(currentIntentStatus, 'CAPTURED');
        if (!transition.valid) {
          throw new Error(transition.error || 'INVALID_PAYMENT_STATE_TRANSITION');
        }

        // Update orders
        await client.query(`
          UPDATE orders
          SET payment_status = 'PAID'
          WHERE id = $1
        `, [order.id]);

        // Update payment_intents
        if (currentIntent) {
          await client.query(`
            UPDATE payment_intents
            SET status = 'CAPTURED', provider_payment_id = $2, updated_at = NOW()
            WHERE id = $1
          `, [currentIntent.id, providerPaymentId]);
        }

        // Exactly-once stock commit
        await inventoryService.commitStock(order.id, client);

        // Record payment receipt
        await client.query(`
          INSERT INTO payment_receipts (order_id, transaction_id, amount, status, signature)
          VALUES ($1, $2, $3, 'SUCCESS', $4)
          ON CONFLICT (transaction_id) DO NOTHING
        `, [order.id, providerPaymentId, authoritativeAmount, signature]);

        // Record ledger entry
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

        // Stage domain event
        stagedEvents.push(
          paymentEventPublisher.createEvent('PaymentCaptured', {
            orderId: order.id,
            transactionId: providerPaymentId,
            amount: authoritativeAmount,
            currency: 'INR',
          })
        );

        // Mark webhook_events PROCESSED
        await client.query(`
          UPDATE webhook_events
          SET status = 'PROCESSED', processed_at = NOW()
          WHERE event_id = $1
        `, [eventId]);

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
          if (currentIntent) {
            await client.query(`
              UPDATE payment_intents
              SET status = 'FAILED',
                  error_code = $2,
                  error_description = $3,
                  updated_at = NOW()
              WHERE id = $1
            `, [
              currentIntent.id,
              paymentEntity.error_code || 'PAYMENT_FAILED',
              paymentEntity.error_description || 'Payment capture failed at provider.',
            ]);
          }

          stagedEvents.push(
            paymentEventPublisher.createEvent('PaymentFailed', {
              orderId: order.id,
              providerPaymentId,
              errorCode: paymentEntity.error_code || 'PAYMENT_FAILED',
            })
          );
        }

        await client.query(`
          UPDATE webhook_events
          SET status = 'PROCESSED', processed_at = NOW()
          WHERE event_id = $1
        `, [eventId]);

        return {
          success: true,
          duplicate: false,
          eventId,
          eventType,
          orderId: order.id,
          paymentState: 'FAILED' as PaymentState,
        };
      } else {
        // Other events (e.g. payment.authorized)
        await client.query(`
          UPDATE webhook_events
          SET status = 'PROCESSED', processed_at = NOW()
          WHERE event_id = $1
        `, [eventId]);

        return {
          success: true,
          eventId,
          eventType,
          orderId: order.id,
        };
      }
    });

    // 6. Publish staged events strictly post-commit
    if (stagedEvents.length > 0) {
      paymentEventPublisher.publishAll(stagedEvents);
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

    const orderRes = await pool.query(`
      SELECT id, user_id, payment_status, payment_method, total_amount
      FROM orders
      WHERE id = $1
      LIMIT 1
    `, [orderId]);

    if (orderRes.rows.length === 0) {
      bloomFilterService.recordFalsePositive();
      throw new Error('ORDER_NOT_FOUND: Order not found.');
    }

    const o = orderRes.rows[0];
    if (o.user_id !== userId) {
      throw new Error('UNAUTHORIZED_PAYMENT_ACCESS: User is not authorized to view payment details for this order.');
    }

    const intentsRes = await pool.query(`
      SELECT id, payment_order_id, amount, currency, status, created_at
      FROM payment_intents
      WHERE order_id = $1
      ORDER BY created_at DESC
    `, [orderId]);

    const receiptRes = await pool.query(`
      SELECT transaction_id, amount, status, verified_at
      FROM payment_receipts
      WHERE order_id = $1
      LIMIT 1
    `, [orderId]);

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
      receipt: receiptRes.rows.length > 0 ? {
        transactionId: receiptRes.rows[0].transaction_id,
        amount: parseFloat(receiptRes.rows[0].amount),
        status: receiptRes.rows[0].status,
        verifiedAt: receiptRes.rows[0].verified_at.toISOString(),
      } : undefined,
    };
  }
}

export const paymentService = new PaymentService();
