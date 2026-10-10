import { getPool } from '../../database/connection.js';
import { NotificationPreferences } from './notificationTypes.js';

export class PreferenceService {
  /**
   * Retrieves notification preferences for a user.
   * If not yet set, creates and returns defaults:
   * - pushEnabled: true
   * - transactionalEnabled: true
   * - deliveryUpdatesEnabled: true
   * - promotionalEnabled: false (opt-in by default to respect user consent)
   */
  public async getPreferences(userId: string): Promise<NotificationPreferences> {
    const pool = getPool();
    const res = await pool.query(
      `SELECT user_id, push_enabled, transactional_enabled, delivery_updates_enabled, promotional_enabled, updated_at
       FROM notification_preferences
       WHERE user_id = $1`,
      [userId]
    );

    if (res.rows.length > 0) {
      const row = res.rows[0];
      return {
        userId: row.user_id,
        pushEnabled: row.push_enabled,
        transactionalEnabled: row.transactional_enabled,
        deliveryUpdatesEnabled: row.delivery_updates_enabled,
        promotionalEnabled: row.promotional_enabled,
        updatedAt: row.updated_at.toISOString(),
      };
    }

    // Insert and return default preferences
    const insRes = await pool.query(
      `INSERT INTO notification_preferences (
        user_id, push_enabled, transactional_enabled, delivery_updates_enabled, promotional_enabled, updated_at
      )
      VALUES ($1, TRUE, TRUE, TRUE, FALSE, NOW())
      ON CONFLICT (user_id) DO UPDATE SET updated_at = NOW()
      RETURNING user_id, push_enabled, transactional_enabled, delivery_updates_enabled, promotional_enabled, updated_at`,
      [userId]
    );

    const row = insRes.rows[0];
    return {
      userId: row.user_id,
      pushEnabled: row.push_enabled,
      transactionalEnabled: row.transactional_enabled,
      deliveryUpdatesEnabled: row.delivery_updates_enabled,
      promotionalEnabled: row.promotional_enabled,
      updatedAt: row.updated_at.toISOString(),
    };
  }

  /**
   * Updates notification preferences for an authenticated user.
   */
  public async updatePreferences(
    userId: string,
    updates: Partial<Omit<NotificationPreferences, 'userId' | 'updatedAt'>>
  ): Promise<NotificationPreferences> {
    const pool = getPool();
    const current = await this.getPreferences(userId);

    const pushEnabled = updates.pushEnabled ?? current.pushEnabled;
    const transactionalEnabled = updates.transactionalEnabled ?? current.transactionalEnabled;
    const deliveryUpdatesEnabled = updates.deliveryUpdatesEnabled ?? current.deliveryUpdatesEnabled;
    const promotionalEnabled = updates.promotionalEnabled ?? current.promotionalEnabled;

    const res = await pool.query(
      `INSERT INTO notification_preferences (
        user_id, push_enabled, transactional_enabled, delivery_updates_enabled, promotional_enabled, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (user_id) DO UPDATE
      SET push_enabled = EXCLUDED.push_enabled,
          transactional_enabled = EXCLUDED.transactional_enabled,
          delivery_updates_enabled = EXCLUDED.delivery_updates_enabled,
          promotional_enabled = EXCLUDED.promotional_enabled,
          updated_at = NOW()
      RETURNING user_id, push_enabled, transactional_enabled, delivery_updates_enabled, promotional_enabled, updated_at`,
      [userId, pushEnabled, transactionalEnabled, deliveryUpdatesEnabled, promotionalEnabled]
    );

    const row = res.rows[0];
    return {
      userId: row.user_id,
      pushEnabled: row.push_enabled,
      transactionalEnabled: row.transactional_enabled,
      deliveryUpdatesEnabled: row.delivery_updates_enabled,
      promotionalEnabled: row.promotional_enabled,
      updatedAt: row.updated_at.toISOString(),
    };
  }
}

export const preferenceService = new PreferenceService();
