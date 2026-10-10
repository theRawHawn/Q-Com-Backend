import crypto from 'crypto';
import { getPool } from '../../database/connection.js';
import { DeviceTokenRecord } from './notificationTypes.js';

export class DeviceTokenService {
  /**
   * Hashes a raw push token using SHA-256 for secure, non-reversible storage and index lookup.
   */
  public hashToken(rawToken: string): string {
    return crypto.createHash('sha256').update(rawToken.trim()).digest('hex');
  }

  /**
   * Masks a raw token for safe preview in admin dashboards/logs without leaking full secret.
   */
  public maskTokenPreview(rawToken: string): string {
    const trimmed = rawToken.trim();
    if (trimmed.length <= 8) return '****';
    return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
  }

  /**
   * Registers or refreshes a device token for an authenticated user.
   */
  public async registerToken(params: {
    userId: string;
    rawToken: string;
    platform: 'ANDROID' | 'IOS' | 'WEB';
    provider?: string;
    appVersion?: string;
    deviceMetadataMinimal?: any;
  }): Promise<{ id: string; tokenId: string; tokenHash: string; rawTokenPreview: string; isNew: boolean }> {
    const pool = getPool();
    const tokenHash = this.hashToken(params.rawToken);
    const rawTokenPreview = this.maskTokenPreview(params.rawToken);
    const provider = params.provider || 'FCM';

    const existing = await pool.query(
      `SELECT id FROM user_device_tokens WHERE user_id = $1 AND token_hash = $2`,
      [params.userId, tokenHash]
    );
    const isNew = existing.rows.length === 0;

    const res = await pool.query(
      `INSERT INTO user_device_tokens (
        user_id, token_hash, raw_token_preview, provider, platform,
        app_version, device_metadata_minimal, is_active, last_seen_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, NOW())
      ON CONFLICT (user_id, token_hash) DO UPDATE
      SET is_active = TRUE,
          last_seen_at = NOW(),
          app_version = COALESCE(EXCLUDED.app_version, user_device_tokens.app_version),
          updated_at = NOW()
      RETURNING id`,
      [
        params.userId,
        tokenHash,
        rawTokenPreview,
        provider,
        params.platform,
        params.appVersion || null,
        JSON.stringify(params.deviceMetadataMinimal || {}),
      ]
    );

    const row = res.rows[0];
    return {
      id: row.id,
      tokenId: row.id,
      tokenHash,
      rawTokenPreview,
      isNew,
    };
  }

  /**
   * Deactivates a device token by ID (e.g. user manually removes device).
   */
  public async deactivateToken(id: string, userId: string): Promise<boolean> {
    const pool = getPool();
    const res = await pool.query(
      `UPDATE user_device_tokens
       SET is_active = FALSE, updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND is_active = TRUE`,
      [id, userId]
    );
    return (res.rowCount || 0) > 0;
  }

  /**
   * Deactivates a device token by token hash (e.g. push provider reported UNREGISTERED).
   */
  public async deactivateByTokenHash(tokenHash: string): Promise<boolean> {
    const pool = getPool();
    const res = await pool.query(
      `UPDATE user_device_tokens
       SET is_active = FALSE, updated_at = NOW()
       WHERE token_hash = $1 AND is_active = TRUE`,
      [tokenHash]
    );
    return (res.rowCount || 0) > 0;
  }

  /**
   * Retrieves all active device tokens for a given user.
   */
  public async getActiveTokensForUser(userId: string): Promise<DeviceTokenRecord[]> {
    const pool = getPool();
    const res = await pool.query(
      `SELECT id, user_id, token_hash, raw_token_preview, provider, platform,
              app_version, device_metadata_minimal, is_active, last_seen_at, created_at
       FROM user_device_tokens
       WHERE user_id = $1 AND is_active = TRUE
       ORDER BY last_seen_at DESC`,
      [userId]
    );

    return res.rows.map(row => ({
      id: row.id,
      userId: row.user_id,
      tokenHash: row.token_hash,
      rawTokenPreview: row.raw_token_preview,
      provider: row.provider,
      platform: row.platform,
      appVersion: row.app_version,
      deviceMetadataMinimal: row.device_metadata_minimal,
      isActive: row.is_active,
      lastSeenAt: row.last_seen_at.toISOString(),
      createdAt: row.created_at.toISOString(),
    }));
  }
}

export const deviceTokenService = new DeviceTokenService();
