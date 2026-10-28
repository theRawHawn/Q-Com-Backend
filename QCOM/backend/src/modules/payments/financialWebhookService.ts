import crypto from 'crypto';
import pg from 'pg';
import { getPool, transaction } from '../../database/connection.js';
import { env } from '../../config/env.js';
import { getPaymentProvider } from './paymentProvider.js';
import { getPayoutProvider } from '../settlements/payoutProvider.js';
import { ledgerService } from '../ledger/ledgerService.js';
import { outboxService } from '../outbox/outboxService.js';
import { settlementEventPublisher } from '../settlements/settlementEvents.js';
import { bloomFilterService } from '../resilience/bloomFilterService.js';

export interface WebhookResult {
  success: boolean;
  duplicate?: boolean;
  ignored?: boolean;
  eventId: string;
  eventType: string;
  aggregateId?: string;
  status?: string;
  message?: string;
}

export class FinancialWebhookService {
  private paymentProvider = getPaymentProvider();
  private payoutProvider = getPayoutProvider();

  /**
   * Verifies HMAC SHA256 webhook signature across standard payment and payout webhook secrets.
   */
  public verifySignature(rawBody: Buffer | string, signature: string): boolean {
    if (!signature || !rawBody) return false;

    // Check against Payment Provider verification
    if (this.paymentProvider.verifyWebhookSignature({ rawBody, signature })) {
      return true;
    }

    // Check against Payout Provider verification
    if (this.payoutProvider.verifyWebhookSignature && this.payoutProvider.verifyWebhookSignature({ rawBody, signature })) {
      return true;
    }

    return false;
  }

  /**
   * Authoritative processing for refund and payout webhook events with durable deduplication.
   */
  public async processFinancialWebhook(params: {
    rawBody: Buffer | string;
    signature: string;
    gateway?: string;
  }): Promise<WebhookResult> {
    const { rawBody, signature, gateway = 'RAZORPAY' } = params;

    // 1. Authenticate signature
    const isValid = this.verifySignature(rawBody, signature);
    if (!isValid) {
      throw new Error('INVALID_WEBHOOK_SIGNATURE: Webhook cryptographic signature verification failed.');
    }

    // 2. Parse payload JSON
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

    // 3. Durable deduplication check
    const existingEvt = await pool.query(`
      SELECT status FROM webhook_events
      WHERE event_id = $1
      LIMIT 1
    `, [eventId]);

    if (existingEvt.rows.length > 0) {
      return {
        success: true,
        duplicate: true,
        eventId,
        eventType,
        status: existingEvt.rows[0].status,
        message: 'Webhook event already processed (durable replay detected).',
      };
    }

    // Record RECEIVED in webhook_events atomically
    const insertRes = await pool.query(`
      INSERT INTO webhook_events (event_id, gateway, event_type, payload, status, received_at)
      VALUES ($1, $2, $3, $4, 'RECEIVED', NOW())
      ON CONFLICT (event_id) DO NOTHING
      RETURNING id
    `, [eventId, gateway, eventType, JSON.stringify(body)]);

    if (insertRes.rows.length === 0) {
      // Event was concurrently inserted by another instance/worker
      return {
        success: true,
        duplicate: true,
        eventId,
        eventType,
        message: 'Concurrent duplicate webhook event detected and handled idempotently.',
      };
    }

    // Route event family
    if (eventType.startsWith('refund.')) {
      return await this.handleRefundEvent(eventId, eventType, body);
    } else if (eventType.startsWith('payout.')) {
      return await this.handlePayoutEvent(eventId, eventType, body);
    } else {
      // Unrecognized financial event type -> acknowledge safely as IGNORED
      await pool.query(`
        UPDATE webhook_events
        SET status = 'IGNORED', processed_at = NOW(), error_message = 'Unrecognized financial webhook event type.'
        WHERE event_id = $1
      `, [eventId]);

      return {
        success: true,
        ignored: true,
        eventId,
        eventType,
        message: `Event type '${eventType}' safely acknowledged but ignored.`,
      };
    }
  }

  /**
   * Handles refund webhook events (refund.processed, refund.failed, refund.created, refund.speed_changed).
   */
  private async handleRefundEvent(eventId: string, eventType: string, body: any): Promise<WebhookResult> {
    const refundEntity = body.payload?.refund?.entity || body.refund || body;
    const providerRefundId = refundEntity.id || body.refund_id;
    const paymentId = refundEntity.payment_id || body.payment_id;
    const notes = refundEntity.notes || {};
    const targetRefundId = notes.refundId || notes.refund_id || (body.refundId && typeof body.refundId === 'string' ? body.refundId : undefined);
    const targetRefundNumber = notes.refundNumber || notes.refund_number;
    const targetOrderId = notes.orderId || notes.order_id || body.orderId;

    return await transaction(async (client) => {
      // Correlate to persisted refund record
      let refund: any = null;

      if (targetRefundId) {
        const res = await client.query(`SELECT * FROM refunds WHERE id::text = $1 LIMIT 1 FOR UPDATE`, [targetRefundId]);
        if (res.rows.length > 0) refund = res.rows[0];
      }

      if (!refund && providerRefundId) {
        const res = await client.query(`SELECT * FROM refunds WHERE provider_refund_id = $1 LIMIT 1 FOR UPDATE`, [providerRefundId]);
        if (res.rows.length > 0) refund = res.rows[0];
      }

      if (!refund && targetRefundNumber) {
        const res = await client.query(`SELECT * FROM refunds WHERE refund_number = $1 LIMIT 1 FOR UPDATE`, [targetRefundNumber]);
        if (res.rows.length > 0) refund = res.rows[0];
      }

      if (!refund && targetOrderId) {
        const res = await client.query(`
          SELECT * FROM refunds
          WHERE order_id::text = $1 AND status = 'PROCESSING'
          ORDER BY created_at DESC
          LIMIT 1
          FOR UPDATE
        `, [targetOrderId]);
        if (res.rows.length > 0) refund = res.rows[0];
      }

      // If no matching persisted refund found
      if (!refund) {
        await client.query(`
          UPDATE webhook_events
          SET status = 'IGNORED', processed_at = NOW(), error_message = 'No matching persisted refund found for webhook.'
          WHERE event_id = $1
        `, [eventId]);

        return {
          success: true,
          ignored: true,
          eventId,
          eventType,
          message: 'Webhook acknowledged with status IGNORED (unmatched refund operation).',
        };
      }

      // Terminal state protection: Never regress terminal financial status
      if (refund.status === 'COMPLETED' || refund.status === 'FAILED') {
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
          aggregateId: refund.id,
          status: refund.status,
          message: `Refund '${refund.id}' is already in terminal status '${refund.status}'. Duplicate event acknowledged safely without re-posting.`,
        };
      }

      // Handle specific refund event types
      if (eventType === 'refund.processed' || eventType === 'refund.created') {
        // Transition to COMPLETED
        await client.query(`
          UPDATE refunds
          SET status = 'COMPLETED',
              provider_refund_id = COALESCE($1, provider_refund_id),
              processed_at = NOW(),
              recovery_lease_id = NULL,
              recovery_lease_expires_at = NULL,
              updated_at = NOW()
          WHERE id = $2
        `, [providerRefundId || null, refund.id]);

        // Update parent order payment status
        const isFull = refund.refund_type === 'FULL';
        const newPaymentStatus = isFull ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
        await client.query(`
          UPDATE orders
          SET payment_status = $1, updated_at = NOW()
          WHERE id = $2
        `, [newPaymentStatus, refund.order_id]);

        // Post General Ledger cancellation entry if pre-fulfillment cancellation
        if (refund.reason_code?.startsWith('ORDER_CANCELLED_') || refund.reason_code === 'CANCELLATION') {
          await ledgerService.recordPreFulfillmentCancellationRefund({
            orderId: refund.order_id,
            refundId: refund.id,
            refundNumber: refund.refund_number,
            amount: parseFloat(refund.amount),
            client,
          });
        }

        // Stage domain event
        await outboxService.stageEvent(client, {
          eventType: 'RefundCompleted',
          aggregateType: 'REFUND',
          aggregateId: refund.id,
          payload: {
            refundId: refund.id,
            orderId: refund.order_id,
            amount: parseFloat(refund.amount),
            providerRefundId: providerRefundId || refund.provider_refund_id,
            source: 'WEBHOOK',
          },
        });

        await client.query(`
          UPDATE webhook_events
          SET status = 'PROCESSED', processed_at = NOW()
          WHERE event_id = $1
        `, [eventId]);

        return {
          success: true,
          eventId,
          eventType,
          aggregateId: refund.id,
          status: 'COMPLETED',
          message: `Refund '${refund.id}' transitioned to COMPLETED via webhook.`,
        };
      } else if (eventType === 'refund.failed') {
        // Transition to FAILED
        await client.query(`
          UPDATE refunds
          SET status = 'FAILED',
              recovery_lease_id = NULL,
              recovery_lease_expires_at = NULL,
              updated_at = NOW()
          WHERE id = $1
        `, [refund.id]);

        await outboxService.stageEvent(client, {
          eventType: 'RefundFailed',
          aggregateType: 'REFUND',
          aggregateId: refund.id,
          payload: {
            refundId: refund.id,
            orderId: refund.order_id,
            reason: refundEntity.error_description || 'Refund failed at provider.',
            source: 'WEBHOOK',
          },
        });

        await client.query(`
          UPDATE webhook_events
          SET status = 'PROCESSED', processed_at = NOW()
          WHERE event_id = $1
        `, [eventId]);

        return {
          success: true,
          eventId,
          eventType,
          aggregateId: refund.id,
          status: 'FAILED',
          message: `Refund '${refund.id}' transitioned to FAILED via webhook.`,
        };
      } else {
        // Informational refund events (e.g. speed_changed)
        await client.query(`
          UPDATE webhook_events
          SET status = 'PROCESSED', processed_at = NOW()
          WHERE event_id = $1
        `, [eventId]);

        return {
          success: true,
          eventId,
          eventType,
          aggregateId: refund.id,
          status: refund.status,
          message: `Informational refund event '${eventType}' acknowledged safely.`,
        };
      }
    });
  }

  /**
   * Handles payout webhook events (payout.processed, payout.reversed, payout.rejected, payout.failed, payout.queued).
   */
  private async handlePayoutEvent(eventId: string, eventType: string, body: any): Promise<WebhookResult> {
    const payoutEntity = body.payload?.payout?.entity || body.payout || body;
    const providerPayoutId = payoutEntity.id || body.payout_id;
    const referenceId = payoutEntity.reference_id || body.reference_id || payoutEntity.reference;
    const utr = payoutEntity.utr || body.utr;
    const failureReason = payoutEntity.failure_reason || payoutEntity.status_details?.description || body.failure_reason;

    const stagedEvents: any[] = [];

    const result = await transaction(async (client) => {
      // 1. Correlate with seller_payouts
      let sellerPayout: any = null;
      if (referenceId) {
        const sRes = await client.query(`
          SELECT * FROM seller_payouts
          WHERE payout_reference = $1 OR idempotency_key = $1
          LIMIT 1
          FOR UPDATE
        `, [referenceId]);
        if (sRes.rows.length > 0) sellerPayout = sRes.rows[0];
      }

      if (!sellerPayout && providerPayoutId) {
        const sRes = await client.query(`
          SELECT * FROM seller_payouts
          WHERE provider_payout_id = $1
          LIMIT 1
          FOR UPDATE
        `, [providerPayoutId]);
        if (sRes.rows.length > 0) sellerPayout = sRes.rows[0];
      }

      if (sellerPayout) {
        return await this.reconcileSellerPayoutFromWebhook({
          client,
          eventId,
          eventType,
          sellerPayout,
          providerPayoutId,
          utr,
          failureReason,
          stagedEvents,
        });
      }

      // 2. Correlate with rider_payouts
      let riderPayout: any = null;
      if (referenceId) {
        const rRes = await client.query(`
          SELECT * FROM rider_payouts
          WHERE payout_reference = $1 OR idempotency_key = $1
          LIMIT 1
          FOR UPDATE
        `, [referenceId]);
        if (rRes.rows.length > 0) riderPayout = rRes.rows[0];
      }

      if (!riderPayout && providerPayoutId) {
        const rRes = await client.query(`
          SELECT * FROM rider_payouts
          WHERE provider_payout_id = $1
          LIMIT 1
          FOR UPDATE
        `, [providerPayoutId]);
        if (rRes.rows.length > 0) riderPayout = rRes.rows[0];
      }

      if (riderPayout) {
        return await this.reconcileRiderPayoutFromWebhook({
          client,
          eventId,
          eventType,
          riderPayout,
          providerPayoutId,
          utr,
          failureReason,
          stagedEvents,
        });
      }

      // Unmatched payout operation -> IGNORED
      await client.query(`
        UPDATE webhook_events
        SET status = 'IGNORED', processed_at = NOW(), error_message = 'No matching seller or rider payout found for webhook reference.'
        WHERE event_id = $1
      `, [eventId]);

      return {
        success: true,
        ignored: true,
        eventId,
        eventType,
        message: 'Payout webhook acknowledged with status IGNORED (unmatched reference).',
      };
    });

    if (stagedEvents.length > 0) {
      settlementEventPublisher.publishAll(stagedEvents);
    }

    return result;
  }

  /**
   * Reconciles seller payout inside transaction from webhook payload.
   */
  private async reconcileSellerPayoutFromWebhook(params: {
    client: pg.PoolClient;
    eventId: string;
    eventType: string;
    sellerPayout: any;
    providerPayoutId?: string;
    utr?: string;
    failureReason?: string;
    stagedEvents: any[];
  }): Promise<WebhookResult> {
    const { client, eventId, eventType, sellerPayout, providerPayoutId, utr, failureReason, stagedEvents } = params;

    // Terminal state protection: If already PAID or FAILED, avoid re-processing
    if (sellerPayout.status === 'PAID' && (eventType === 'payout.processed' || eventType === 'payout.queued' || eventType === 'payout.initiated')) {
      await client.query(`
        UPDATE webhook_events SET status = 'PROCESSED', processed_at = NOW() WHERE event_id = $1
      `, [eventId]);

      return {
        success: true,
        duplicate: true,
        eventId,
        eventType,
        aggregateId: sellerPayout.id,
        status: sellerPayout.status,
        message: `Seller payout '${sellerPayout.id}' is already PAID. Webhook acknowledged without duplicate ledger lines.`,
      };
    }

    if (sellerPayout.status === 'FAILED' && eventType !== 'payout.processed') {
      await client.query(`
        UPDATE webhook_events SET status = 'PROCESSED', processed_at = NOW() WHERE event_id = $1
      `, [eventId]);

      return {
        success: true,
        duplicate: true,
        eventId,
        eventType,
        aggregateId: sellerPayout.id,
        status: sellerPayout.status,
        message: `Seller payout '${sellerPayout.id}' is already in terminal status '${sellerPayout.status}'.`,
      };
    }

    const payoutAmount = parseFloat(sellerPayout.amount);
    const merchantId = sellerPayout.merchant_id;
    const payoutReference = sellerPayout.payout_reference;

    if (eventType === 'payout.processed') {
      const confirmedUtr = utr || sellerPayout.utr_number || `UTR_MERCH_${Date.now()}_${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

      // Post General Ledger Batch
      const journalBatchId = await ledgerService.recordMerchantSettlementPayout({
        merchantId,
        amount: payoutAmount,
        payoutReference,
        utrNumber: confirmedUtr,
        client,
      });

      // Update seller_ledgers
      await client.query(`
        UPDATE seller_ledgers
        SET utr_number = $1,
            description = $2
        WHERE merchant_id = $3 AND description = $4
      `, [
        confirmedUtr,
        `Bank payout disbursement settled (Ref: ${payoutReference}, UTR: ${confirmedUtr})`,
        merchantId,
        `Bank payout disbursement reserved (Ref: ${payoutReference})`,
      ]);

      // Update seller_payouts
      await client.query(`
        UPDATE seller_payouts
        SET status = 'PAID',
            utr_number = $1,
            provider_payout_id = COALESCE($2, provider_payout_id),
            journal_batch_id = $3,
            processed_at = NOW(),
            recovery_lease_id = NULL,
            recovery_lease_expires_at = NULL,
            updated_at = NOW()
        WHERE id = $4
      `, [confirmedUtr, providerPayoutId || null, journalBatchId, sellerPayout.id]);

      // Mark order allocations SETTLED
      await client.query(`
        UPDATE order_settlement_allocations
        SET status = 'SETTLED'
        WHERE merchant_id = $1 AND status = 'ALLOCATED'
      `, [merchantId]);

      stagedEvents.push(
        settlementEventPublisher.createEvent('SellerPayoutCompleted', {
          payoutId: sellerPayout.id,
          payoutReference,
          merchantId,
          amount: payoutAmount,
          utrNumber: confirmedUtr,
          journalBatchId,
          source: 'WEBHOOK',
        })
      );

      await client.query(`
        UPDATE webhook_events SET status = 'PROCESSED', processed_at = NOW() WHERE event_id = $1
      `, [eventId]);

      return {
        success: true,
        eventId,
        eventType,
        aggregateId: sellerPayout.id,
        status: 'PAID',
        message: `Seller payout '${sellerPayout.id}' transitioned to PAID via webhook.`,
      };
    } else if (eventType === 'payout.reversed' || eventType === 'payout.rejected' || eventType === 'payout.failed') {
      // Lock merchant row to prevent balance corruption under horizontal scaling
      await client.query(`SELECT id FROM merchants WHERE id = $1 FOR UPDATE`, [merchantId]);

      await client.query(`
        UPDATE seller_payouts
        SET status = 'FAILED',
            failure_reason = $1,
            recovery_lease_id = NULL,
            recovery_lease_expires_at = NULL,
            updated_at = NOW()
        WHERE id = $2
      `, [failureReason || 'Disbursement rejected or reversed by banking rail.', sellerPayout.id]);

      // Restore running balance with CREDIT ADJUSTMENT in seller_ledgers
      const curBalRes = await client.query(`
        SELECT running_balance FROM seller_ledgers
        WHERE merchant_id = $1
        ORDER BY created_at DESC
        LIMIT 1
      `, [merchantId]);

      const currentRunning = curBalRes.rows.length > 0 ? parseFloat(curBalRes.rows[0].running_balance) : 0;
      const restoredRunning = +(currentRunning + payoutAmount).toFixed(2);

      await client.query(`
        INSERT INTO seller_ledgers (
          merchant_id, entry_type, category, amount, running_balance, description
        )
        VALUES ($1, 'ADJUSTMENT', 'CREDIT', $2, $3, $4)
      `, [
        merchantId,
        payoutAmount,
        restoredRunning,
        `Restoration of payable balance due to failed bank disbursement (Ref: ${payoutReference}, Reason: ${failureReason || 'Bank Rejection'})`,
      ]);

      await client.query(`
        UPDATE webhook_events SET status = 'PROCESSED', processed_at = NOW() WHERE event_id = $1
      `, [eventId]);

      return {
        success: true,
        eventId,
        eventType,
        aggregateId: sellerPayout.id,
        status: 'FAILED',
        message: `Seller payout '${sellerPayout.id}' marked FAILED and balance restored via webhook.`,
      };
    } else {
      // Intermediate state (queued, initiated, pending)
      await client.query(`
        UPDATE webhook_events SET status = 'PROCESSED', processed_at = NOW() WHERE event_id = $1
      `, [eventId]);

      return {
        success: true,
        eventId,
        eventType,
        aggregateId: sellerPayout.id,
        status: sellerPayout.status,
        message: `Intermediate payout event '${eventType}' acknowledged safely.`,
      };
    }
  }

  /**
   * Reconciles rider payout inside transaction from webhook payload.
   */
  private async reconcileRiderPayoutFromWebhook(params: {
    client: pg.PoolClient;
    eventId: string;
    eventType: string;
    riderPayout: any;
    providerPayoutId?: string;
    utr?: string;
    failureReason?: string;
    stagedEvents: any[];
  }): Promise<WebhookResult> {
    const { client, eventId, eventType, riderPayout, providerPayoutId, utr, failureReason, stagedEvents } = params;

    // Terminal state protection
    if (riderPayout.status === 'PAID' && (eventType === 'payout.processed' || eventType === 'payout.queued' || eventType === 'payout.initiated')) {
      await client.query(`
        UPDATE webhook_events SET status = 'PROCESSED', processed_at = NOW() WHERE event_id = $1
      `, [eventId]);

      return {
        success: true,
        duplicate: true,
        eventId,
        eventType,
        aggregateId: riderPayout.id,
        status: riderPayout.status,
        message: `Rider payout '${riderPayout.id}' is already PAID. Webhook acknowledged without duplicate ledger lines.`,
      };
    }

    if (riderPayout.status === 'FAILED' && eventType !== 'payout.processed') {
      await client.query(`
        UPDATE webhook_events SET status = 'PROCESSED', processed_at = NOW() WHERE event_id = $1
      `, [eventId]);

      return {
        success: true,
        duplicate: true,
        eventId,
        eventType,
        aggregateId: riderPayout.id,
        status: riderPayout.status,
        message: `Rider payout '${riderPayout.id}' is already in terminal status '${riderPayout.status}'.`,
      };
    }

    const payoutAmount = parseFloat(riderPayout.amount);
    const riderId = riderPayout.rider_id;
    const payoutReference = riderPayout.payout_reference;

    if (eventType === 'payout.processed') {
      const confirmedUtr = utr || riderPayout.utr_number || `UTR_RIDER_${Date.now()}_${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

      // Post General Ledger Batch
      const journalBatchId = await ledgerService.recordRiderPayout({
        riderId,
        amount: payoutAmount,
        payoutReference,
        utrNumber: confirmedUtr,
        client,
      });

      // Update rider_payouts
      await client.query(`
        UPDATE rider_payouts
        SET status = 'PAID',
            utr_number = $1,
            provider_payout_id = COALESCE($2, provider_payout_id),
            journal_batch_id = $3,
            processed_at = NOW(),
            recovery_lease_id = NULL,
            recovery_lease_expires_at = NULL,
            updated_at = NOW()
        WHERE id = $4
      `, [confirmedUtr, providerPayoutId || null, journalBatchId, riderPayout.id]);

      stagedEvents.push(
        settlementEventPublisher.createEvent('RiderPayoutCompleted', {
          payoutId: riderPayout.id,
          payoutReference,
          riderId,
          amount: payoutAmount,
          method: riderPayout.payout_method,
          utrNumber: confirmedUtr,
          journalBatchId,
          source: 'WEBHOOK',
        })
      );

      await client.query(`
        UPDATE webhook_events SET status = 'PROCESSED', processed_at = NOW() WHERE event_id = $1
      `, [eventId]);

      return {
        success: true,
        eventId,
        eventType,
        aggregateId: riderPayout.id,
        status: 'PAID',
        message: `Rider payout '${riderPayout.id}' transitioned to PAID via webhook.`,
      };
    } else if (eventType === 'payout.reversed' || eventType === 'payout.rejected' || eventType === 'payout.failed') {
      const terminalStatus = eventType === 'payout.reversed' ? 'REVERSED' : 'FAILED';

      // Lock rider row
      await client.query(`SELECT id FROM riders WHERE id = $1 FOR UPDATE`, [riderId]);

      // Restore wallet balance on riders
      await client.query(`
        UPDATE riders
        SET wallet_balance = wallet_balance + $1,
            updated_at = NOW()
        WHERE id = $2
      `, [payoutAmount, riderId]);

      // Update rider_payouts
      await client.query(`
        UPDATE rider_payouts
        SET status = $1,
            failure_reason = $2,
            recovery_lease_id = NULL,
            recovery_lease_expires_at = NULL,
            updated_at = NOW()
        WHERE id = $3
      `, [terminalStatus, failureReason || 'Disbursement rejected or reversed by banking rail.', riderPayout.id]);

      await client.query(`
        UPDATE webhook_events SET status = 'PROCESSED', processed_at = NOW() WHERE event_id = $1
      `, [eventId]);

      return {
        success: true,
        eventId,
        eventType,
        aggregateId: riderPayout.id,
        status: terminalStatus,
        message: `Rider payout '${riderPayout.id}' marked ${terminalStatus} and wallet restored via webhook.`,
      };
    } else {
      // Intermediate state (queued, initiated, pending)
      await client.query(`
        UPDATE webhook_events SET status = 'PROCESSED', processed_at = NOW() WHERE event_id = $1
      `, [eventId]);

      return {
        success: true,
        eventId,
        eventType,
        aggregateId: riderPayout.id,
        status: riderPayout.status,
        message: `Intermediate rider payout event '${eventType}' acknowledged safely.`,
      };
    }
  }
}

export const financialWebhookService = new FinancialWebhookService();
