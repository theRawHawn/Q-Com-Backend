import crypto from 'crypto';
import { getPool } from '../../database/connection.js';
import { notificationService } from './notificationService.js';
import {
  CampaignAnalytics,
  CampaignRecord,
  CampaignStatus,
  CreateCampaignInput,
} from './campaignTypes.js';

export class CampaignService {
  /**
   * Validates image URL security: strictly requires HTTPS and rejects dangerous protocols.
   */
  public validateImageUrl(url?: string): void {
    if (!url) return;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('Invalid image URL format.');
    }
    if (parsed.protocol !== 'https:') {
      throw new Error('Image URL must use secure HTTPS protocol.');
    }
  }

  /**
   * Validates deep-link security: restricts to allowlisted customer application route patterns
   * and blocks arbitrary external redirect attacks.
   */
  public validateDeepLink(link?: string): void {
    if (!link) return;
    if (link.startsWith('http://') || link.startsWith('https://') || link.includes('://')) {
      throw new Error('Deep links must be internal relative application routes (e.g. /orders/123), not external web URLs.');
    }
    if (!link.startsWith('/')) {
      throw new Error('Deep links must start with a forward slash (/).');
    }

    const allowlistPattern = /^\/(orders|store|category|products|deals|cart|profile)(\/[a-zA-Z0-9_-]+)*$/;
    if (!allowlistPattern.test(link)) {
      throw new Error(`Deep link '${link}' does not match permitted customer app route patterns.`);
    }
  }

  /**
   * Creates a new draft campaign by an authorized Administrator.
   */
  public async createCampaign(
    createdBy: string,
    input: CreateCampaignInput
  ): Promise<CampaignRecord> {
    this.validateImageUrl(input.imageUrl);
    this.validateDeepLink(input.deepLink);

    if (!input.title || input.title.trim().length === 0) {
      throw new Error('Campaign title is required.');
    }
    if (!input.body || input.body.trim().length === 0) {
      throw new Error('Campaign body is required.');
    }

    const pool = getPool();
    const id = crypto.randomUUID();

    const res = await pool.query(
      `INSERT INTO notification_campaigns (
        id, created_by, name, status, title, body, image_url, deep_link,
        audience_type, audience_definition, scheduled_at, expires_at,
        priority, frequency_policy, dedupe_key, campaign_type, algorithm_metadata,
        created_at, updated_at
      )
      VALUES ($1, $2, $3, 'DRAFT', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW(), NOW())
      RETURNING *`,
      [
        id,
        createdBy,
        input.name,
        input.title.trim(),
        input.body.trim(),
        input.imageUrl || null,
        input.deepLink || null,
        input.audienceType,
        JSON.stringify(input.audienceDefinition || {}),
        input.scheduledAt ? new Date(input.scheduledAt) : null,
        input.expiresAt ? new Date(input.expiresAt) : null,
        input.priority || 'NORMAL',
        JSON.stringify(input.frequencyPolicy || { cooldownHours: 24, maxPerUserPerDay: 1 }),
        input.dedupeKey || `camp_${id}`,
        input.campaignType || 'ADMIN_CAMPAIGN',
        JSON.stringify(input.algorithmMetadata || {}),
      ]
    );

    return this.mapRowToCampaign(res.rows[0]);
  }

  /**
   * Updates an existing campaign (only allowed while in DRAFT status).
   */
  public async updateCampaign(
    campaignId: string,
    updates: Partial<CreateCampaignInput>
  ): Promise<CampaignRecord> {
    if (updates.imageUrl) this.validateImageUrl(updates.imageUrl);
    if (updates.deepLink) this.validateDeepLink(updates.deepLink);

    const pool = getPool();
    const current = await this.getCampaignById(campaignId);
    if (!current) {
      throw new Error(`Campaign '${campaignId}' not found.`);
    }

    if (current.status !== 'DRAFT') {
      throw new Error(`Cannot edit campaign in '${current.status}' status. Only DRAFT campaigns can be modified.`);
    }

    const res = await pool.query(
      `UPDATE notification_campaigns
       SET name = COALESCE($1, name),
           title = COALESCE($2, title),
           body = COALESCE($3, body),
           image_url = COALESCE($4, image_url),
           deep_link = COALESCE($5, deep_link),
           audience_type = COALESCE($6, audience_type),
           audience_definition = COALESCE($7, audience_definition),
           scheduled_at = COALESCE($8, scheduled_at),
           expires_at = COALESCE($9, expires_at),
           priority = COALESCE($10, priority),
           updated_at = NOW()
       WHERE id = $11
       RETURNING *`,
      [
        updates.name || null,
        updates.title || null,
        updates.body || null,
        updates.imageUrl || null,
        updates.deepLink || null,
        updates.audienceType || null,
        updates.audienceDefinition ? JSON.stringify(updates.audienceDefinition) : null,
        updates.scheduledAt ? new Date(updates.scheduledAt) : null,
        updates.expiresAt ? new Date(updates.expiresAt) : null,
        updates.priority || null,
        campaignId,
      ]
    );

    return this.mapRowToCampaign(res.rows[0]);
  }

  /**
   * Retrieves campaign by ID.
   */
  public async getCampaignById(campaignId: string): Promise<CampaignRecord | null> {
    const pool = getPool();
    const res = await pool.query(`SELECT * FROM notification_campaigns WHERE id = $1`, [campaignId]);
    if (res.rows.length === 0) return null;
    return this.mapRowToCampaign(res.rows[0]);
  }

  /**
   * Lists campaigns with optional status filtering.
   */
  public async listCampaigns(status?: CampaignStatus): Promise<CampaignRecord[]> {
    const pool = getPool();
    let query = `SELECT * FROM notification_campaigns`;
    const params: any[] = [];
    if (status) {
      query += ` WHERE status = $1`;
      params.push(status);
    }
    query += ` ORDER BY created_at DESC LIMIT 100`;

    const res = await pool.query(query, params);
    return res.rows.map(r => this.mapRowToCampaign(r));
  }

  /**
   * Sends a controlled test push notification to a specified test user's devices.
   */
  public async testSend(
    campaignId: string,
    testUserId: string
  ): Promise<{ success: boolean; deliveryResult: any }> {
    const campaign = await this.getCampaignById(campaignId);
    if (!campaign) {
      throw new Error(`Campaign '${campaignId}' not found.`);
    }

    const deliveryResult = await notificationService.sendNotification({
      userId: testUserId,
      notificationType: 'PROMOTIONAL',
      title: `[TEST] ${campaign.title}`,
      body: campaign.body,
      imageUrl: campaign.imageUrl,
      deepLink: campaign.deepLink,
      campaignId: campaign.id,
      dedupeKey: `test_${campaign.id}_${Date.now()}`,
      priority: 'HIGH',
      skipPreferenceCheck: true, // Test notifications override promo opt-in for verified testers
    });

    return { success: true, deliveryResult };
  }

  /**
   * Schedules campaign for future delivery.
   */
  public async scheduleCampaign(campaignId: string, scheduledAt: Date): Promise<CampaignRecord> {
    const pool = getPool();
    const current = await this.getCampaignById(campaignId);
    if (!current) throw new Error(`Campaign '${campaignId}' not found.`);

    if (current.status !== 'DRAFT') {
      throw new Error(`Cannot schedule campaign in '${current.status}' status. Must be DRAFT.`);
    }

    const res = await pool.query(
      `UPDATE notification_campaigns
       SET status = 'SCHEDULED', scheduled_at = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [scheduledAt, campaignId]
    );

    return this.mapRowToCampaign(res.rows[0]);
  }

  /**
   * Cancels scheduled or draft campaign.
   */
  public async cancelCampaign(campaignId: string): Promise<CampaignRecord> {
    const pool = getPool();
    const current = await this.getCampaignById(campaignId);
    if (!current) throw new Error(`Campaign '${campaignId}' not found.`);

    if (!['DRAFT', 'SCHEDULED'].includes(current.status)) {
      throw new Error(`Cannot cancel campaign in '${current.status}' status.`);
    }

    const res = await pool.query(
      `UPDATE notification_campaigns
       SET status = 'CANCELLED', updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [campaignId]
    );

    return this.mapRowToCampaign(res.rows[0]);
  }

  /**
   * Executes campaign delivery in bounded audience batches.
   * Enforces promotional preference filtering and frequency cooldowns.
   */
  public async executeCampaign(campaignId: string): Promise<CampaignAnalytics> {
    const pool = getPool();
    const campaign = await this.getCampaignById(campaignId);
    if (!campaign) throw new Error(`Campaign '${campaignId}' not found.`);

    if (!['DRAFT', 'SCHEDULED'].includes(campaign.status)) {
      throw new Error(`Cannot execute campaign in '${campaign.status}' status.`);
    }

    // Set to PROCESSING
    await pool.query(
      `UPDATE notification_campaigns SET status = 'PROCESSING', updated_at = NOW() WHERE id = $1`,
      [campaignId]
    );

    try {
      // Resolve audience user IDs in bounded stream/batch
      const eligibleUserIds = await this.resolveAudienceUserIds(campaign);

      for (const userId of eligibleUserIds) {
        // Enforce dedupe key per user per campaign
        const dedupeKey = `camp_${campaign.id}_${userId}`;

        await notificationService.sendNotification({
          userId,
          notificationType: 'PROMOTIONAL',
          title: campaign.title,
          body: campaign.body,
          imageUrl: campaign.imageUrl,
          deepLink: campaign.deepLink,
          campaignId: campaign.id,
          dedupeKey,
          priority: campaign.priority,
          data: {
            campaignId: campaign.id,
            campaignType: campaign.campaignType,
          },
        });
      }

      // Mark COMPLETED
      await pool.query(
        `UPDATE notification_campaigns SET status = 'COMPLETED', updated_at = NOW() WHERE id = $1`,
        [campaignId]
      );

      return this.getCampaignAnalytics(campaignId);
    } catch (err: any) {
      await pool.query(
        `UPDATE notification_campaigns SET status = 'FAILED', updated_at = NOW() WHERE id = $1`,
        [campaignId]
      );
      throw err;
    }
  }

  /**
   * Resolves target recipient user IDs based on audience definition without loading
   * excessive records in memory.
   */
  private async resolveAudienceUserIds(campaign: CampaignRecord): Promise<string[]> {
    const pool = getPool();

    switch (campaign.audienceType) {
      case 'ALL_ACTIVE_CUSTOMERS': {
        const res = await pool.query(
          `SELECT u.id
           FROM users u
           JOIN user_roles ur ON ur.user_id = u.id
           JOIN roles r ON r.id = ur.role_id
           WHERE (r.code = 'CUSTOMER' OR r.name = 'CUSTOMER') AND u.is_suspended = FALSE
           LIMIT 500`
        );
        return res.rows.map(r => r.id);
      }

      case 'NEW_CUSTOMERS': {
        const res = await pool.query(
          `SELECT u.id
           FROM users u
           LEFT JOIN orders o ON o.user_id = u.id
           WHERE o.id IS NULL AND u.is_suspended = FALSE
           LIMIT 500`
        );
        return res.rows.map(r => r.id);
      }

      default: {
        // Default safe bounded selection of active customers
        const res = await pool.query(
          `SELECT id FROM users WHERE is_suspended = FALSE LIMIT 500`
        );
        return res.rows.map(r => r.id);
      }
    }
  }

  /**
   * Returns delivery, open, click, and failure analytics for a campaign.
   */
  public async getCampaignAnalytics(campaignId: string): Promise<CampaignAnalytics> {
    const pool = getPool();
    const campaign = await this.getCampaignById(campaignId);
    if (!campaign) throw new Error(`Campaign '${campaignId}' not found.`);

    const deliveryRes = await pool.query(
      `SELECT status, COUNT(*) as count
       FROM notification_deliveries
       WHERE notification_id_or_campaign_id = $1
       GROUP BY status`,
      [campaignId]
    );

    const counts: Record<string, number> = {};
    for (const r of deliveryRes.rows) {
      counts[r.status] = Number(r.count);
    }

    const metricsRes = await pool.query(
      `SELECT event_type, COUNT(*) as count
       FROM notification_event_metrics
       WHERE campaign_id_nullable = $1
       GROUP BY event_type`,
      [campaignId]
    );

    const metricCounts: Record<string, number> = {};
    for (const r of metricsRes.rows) {
      metricCounts[r.event_type] = Number(r.count);
    }

    const sentCount = counts['SENT'] || 0;
    const failedCount = counts['FAILED'] || 0;
    const skippedPref = counts['SKIPPED_PREFERENCE'] || 0;

    return {
      campaignId,
      status: campaign.status,
      totalRecipientsTargeted: sentCount + failedCount + skippedPref,
      sentCount,
      deliveredCount: metricCounts['DELIVERED'] || sentCount,
      openedCount: metricCounts['OPENED'] || 0,
      clickedCount: metricCounts['CLICKED'] || 0,
      failedCount,
      skippedPreferenceCount: skippedPref,
    };
  }

  private mapRowToCampaign(row: any): CampaignRecord {
    return {
      id: row.id,
      createdBy: row.created_by,
      name: row.name,
      status: row.status,
      title: row.title,
      body: row.body,
      imageUrl: row.image_url || undefined,
      deepLink: row.deep_link || undefined,
      audienceType: row.audience_type,
      audienceDefinition: typeof row.audience_definition === 'string' ? JSON.parse(row.audience_definition) : row.audience_definition,
      scheduledAt: row.scheduled_at ? (row.scheduled_at instanceof Date ? row.scheduled_at.toISOString() : row.scheduled_at) : undefined,
      expiresAt: row.expires_at ? (row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at) : undefined,
      priority: row.priority,
      frequencyPolicy: typeof row.frequency_policy === 'string' ? JSON.parse(row.frequency_policy) : row.frequency_policy,
      dedupeKey: row.dedupe_key || undefined,
      campaignType: row.campaign_type,
      algorithmMetadata: typeof row.algorithm_metadata === 'string' ? JSON.parse(row.algorithm_metadata) : row.algorithm_metadata,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    };
  }
}

export const campaignService = new CampaignService();
