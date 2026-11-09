import crypto from 'crypto';
import { getPool } from '../../database/connection.js';
import { preferenceService } from './preferenceService.js';
import { deviceTokenService } from './deviceTokenService.js';
import { defaultPushProvider, IPushProvider } from './pushProvider.js';
import { realtimeGateway } from '../realtime/websocketServer.js';
import {
  MetricEventType,
  NotificationDeliveryResult,
  SendNotificationInput,
} from './notificationTypes.js';

export class NotificationService {
  private pushProvider: IPushProvider = defaultPushProvider;

  public setPushProvider(provider: IPushProvider): void {
    this.pushProvider = provider;
  }

  public getPushProvider(): IPushProvider {
    return this.pushProvider;
  }

  /**
   * Dispatches a notification to an authenticated user with:
   * 1. Preference & consent validation (transactional vs promotional)
   * 2. Idempotent delivery deduplication via unique dedupe_key
   * 3. Device token resolution & push dispatch
   * 4. Automatic invalid-token deactivation
   * 5. Realtime WebSocket in-app notification
   * 6. Audit & metrics logging
   */
  public async sendNotification(
    input: SendNotificationInput
  ): Promise<NotificationDeliveryResult> {
    const pool = getPool();
    const notificationId = crypto.randomUUID();

    // 1. Check Deduplication
    const dedupeCheck = await pool.query(
      `SELECT id, status, sent_at FROM notification_deliveries WHERE dedupe_key = $1`,
      [input.dedupeKey]
    );

    if (dedupeCheck.rows.length > 0) {
      const existing = dedupeCheck.rows[0];
      return {
        notificationId: existing.id,
        status: existing.status,
        sentCount: 0,
        deduped: true,
        reason: 'Notification with this dedupe_key has already been processed.',
      };
    }

    // 2. Validate User Preferences & Consent
    if (!input.skipPreferenceCheck) {
      const prefs = await preferenceService.getPreferences(input.userId);

      if (!prefs.pushEnabled) {
        await this.recordDeliveryRecord({
          id: notificationId,
          campaignId: input.campaignId,
          userId: input.userId,
          notificationType: input.notificationType,
          dedupeKey: input.dedupeKey,
          status: 'SKIPPED_PREFERENCE',
          failureReason: 'User has disabled all push notifications.',
        });
        return {
          notificationId,
          status: 'SKIPPED_PREFERENCE',
          sentCount: 0,
          deduped: false,
          reason: 'User has disabled push notifications.',
        };
      }

      if (input.notificationType === 'PROMOTIONAL' && !prefs.promotionalEnabled) {
        await this.recordDeliveryRecord({
          id: notificationId,
          campaignId: input.campaignId,
          userId: input.userId,
          notificationType: input.notificationType,
          dedupeKey: input.dedupeKey,
          status: 'SKIPPED_PREFERENCE',
          failureReason: 'User has not opted into promotional campaigns.',
        });
        return {
          notificationId,
          status: 'SKIPPED_PREFERENCE',
          sentCount: 0,
          deduped: false,
          reason: 'User has not opted into promotional campaigns.',
        };
      }

      if (input.notificationType === 'DELIVERY_UPDATE' && !prefs.deliveryUpdatesEnabled) {
        await this.recordDeliveryRecord({
          id: notificationId,
          campaignId: input.campaignId,
          userId: input.userId,
          notificationType: input.notificationType,
          dedupeKey: input.dedupeKey,
          status: 'SKIPPED_PREFERENCE',
          failureReason: 'User disabled delivery updates.',
        });
        return {
          notificationId,
          status: 'SKIPPED_PREFERENCE',
          sentCount: 0,
          deduped: false,
          reason: 'User disabled delivery updates.',
        };
      }

      if (input.notificationType === 'TRANSACTIONAL' && !prefs.transactionalEnabled) {
        await this.recordDeliveryRecord({
          id: notificationId,
          campaignId: input.campaignId,
          userId: input.userId,
          notificationType: input.notificationType,
          dedupeKey: input.dedupeKey,
          status: 'SKIPPED_PREFERENCE',
          failureReason: 'User disabled transactional alerts.',
        });
        return {
          notificationId,
          status: 'SKIPPED_PREFERENCE',
          sentCount: 0,
          deduped: false,
          reason: 'User disabled transactional alerts.',
        };
      }
    }

    // 3. Resolve Registered Device Tokens
    const activeTokens = await deviceTokenService.getActiveTokensForUser(input.userId);

    // 4. Also broadcast to active WebSocket session (in-app realtime toast)
    realtimeGateway.broadcastToUser(input.userId, {
      type: 'event',
      channel: `user:${input.userId}`,
      eventType: 'notification:received',
      payload: {
        notificationId,
        title: input.title,
        body: input.body,
        imageUrl: input.imageUrl,
        deepLink: input.deepLink,
        notificationType: input.notificationType,
        data: input.data,
      },
      timestamp: new Date().toISOString(),
    });

    let sentCount = 0;
    let lastProviderMessageId: string | undefined;
    let lastFailureReason: string | undefined;

    // 5. Send via Push Provider to each active registered device
    for (const token of activeTokens) {
      try {
        const pushResult = await this.pushProvider.sendPush(
          {
            tokenHash: token.tokenHash,
            rawTokenPreview: token.rawTokenPreview,
            platform: token.platform,
          },
          {
            title: input.title,
            body: input.body,
            imageUrl: input.imageUrl,
            deepLink: input.deepLink,
            data: input.data,
            priority: input.priority || 'NORMAL',
          }
        );

        if (pushResult.success) {
          sentCount++;
          lastProviderMessageId = pushResult.messageId;
        } else {
          lastFailureReason = pushResult.error;

          // If provider flagged token as unregistered / invalid, deactivate it immediately
          if (pushResult.isInvalidToken) {
            await deviceTokenService.deactivateByTokenHash(token.tokenHash);
          }
        }
      } catch (err: any) {
        lastFailureReason = err.message;
      }
    }

    const finalStatus = activeTokens.length === 0 || sentCount > 0 ? 'SENT' : 'FAILED';

    // 6. Record in notification_deliveries table
    await this.recordDeliveryRecord({
      id: notificationId,
      campaignId: input.campaignId,
      userId: input.userId,
      deviceTokenId: activeTokens[0]?.id,
      notificationType: input.notificationType,
      dedupeKey: input.dedupeKey,
      status: finalStatus,
      provider: this.pushProvider.name,
      providerMessageId: lastProviderMessageId,
      failureReason: finalStatus === 'FAILED' ? lastFailureReason : undefined,
    });

    // 7. Record Analytics Metric
    await this.recordInteractionMetric(
      input.userId,
      notificationId,
      finalStatus === 'SENT' ? 'SENT' : 'FAILED',
      input.campaignId,
      { sentCount, deviceCount: activeTokens.length }
    );

    return {
      notificationId,
      status: finalStatus,
      sentCount,
      deduped: false,
    };
  }

  /**
   * Records user interaction metric (OPENED, CLICKED, DISMISSED) for analytics and future algorithms.
   */
  public async recordInteractionMetric(
    userId: string,
    notificationId: string,
    eventType: MetricEventType,
    campaignId?: string,
    metadata?: Record<string, any>
  ): Promise<string> {
    const pool = getPool();
    const metricId = crypto.randomUUID();

    await pool.query(
      `INSERT INTO notification_event_metrics (
        id, user_id, notification_id, campaign_id_nullable, event_type, occurred_at, metadata_minimal
      )
      VALUES ($1, $2, $3, $4, $5, NOW(), $6)`,
      [
        metricId,
        userId,
        notificationId,
        campaignId || null,
        eventType,
        JSON.stringify(metadata || {}),
      ]
    );

    // If opened or clicked, update notification_deliveries
    if (eventType === 'OPENED') {
      await pool.query(
        `UPDATE notification_deliveries SET opened_at_if_available = NOW() WHERE id = $1`,
        [notificationId]
      );
    } else if (eventType === 'CLICKED') {
      await pool.query(
        `UPDATE notification_deliveries SET clicked_at_if_available = NOW() WHERE id = $1`,
        [notificationId]
      );
    }

    return metricId;
  }

  private async recordDeliveryRecord(params: {
    id: string;
    campaignId?: string;
    userId: string;
    deviceTokenId?: string;
    notificationType: string;
    dedupeKey: string;
    status: string;
    provider?: string;
    providerMessageId?: string;
    failureReason?: string;
  }): Promise<void> {
    const pool = getPool();
    await pool.query(
      `INSERT INTO notification_deliveries (
        id, notification_id_or_campaign_id, user_id, device_token_reference,
        notification_type, dedupe_key, status, provider, provider_message_id,
        sent_at, failure_reason, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
      ON CONFLICT (dedupe_key) DO NOTHING`,
      [
        params.id,
        params.campaignId || params.id,
        params.userId,
        params.deviceTokenId || null,
        params.notificationType,
        params.dedupeKey,
        params.status,
        params.provider || 'MOCK',
        params.providerMessageId || null,
        params.status === 'SENT' ? new Date() : null,
        params.failureReason || null,
      ]
    );
  }
}

export const notificationService = new NotificationService();
