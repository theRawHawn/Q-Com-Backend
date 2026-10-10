import { getPool } from '../../database/connection.js';

export interface SellerGeofenceConfig {
  id: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  geofenceRadiusMeters: number;
  isOpen: boolean;
  preparationTimeMinutes: number;
  tradeCategories: string[];
}

export class SellerService {
  /**
   * Retrieves all store geofences and operating statuses
   */
  public async getSellerGeofences(): Promise<SellerGeofenceConfig[]> {
    const pool = getPool();
    const res = await pool.query(`
      SELECT m.id, m.name, m.address, m.latitude, m.longitude, m.service_radius_meters, m.is_online, m.base_prep_mins
      FROM merchants m
      WHERE m.status = 'ACTIVE' OR m.status = 'PENDING'
      ORDER BY m.name ASC
    `);

    return res.rows.map(row => ({
      id: row.id,
      name: row.name,
      address: row.address,
      latitude: parseFloat(row.latitude),
      longitude: parseFloat(row.longitude),
      geofenceRadiusMeters: row.service_radius_meters || 6500,
      isOpen: row.is_online ?? true,
      preparationTimeMinutes: row.base_prep_mins || 8,
      tradeCategories: ['Electrical', 'Plumbing', 'Fasteners', 'Hardware Tools'],
    }));
  }

  /**
   * Updates store geofence or operational status
   */
  public async updateSellerGeofence(
    sellerId: string,
    updates: {
      isOpen?: boolean;
      geofenceRadiusMeters?: number;
      preparationTimeMinutes?: number;
    }
  ): Promise<SellerGeofenceConfig | null> {
    const pool = getPool();
    const setParts: string[] = [];
    const params: any[] = [sellerId];
    let idx = 2;

    if (updates.isOpen !== undefined) {
      setParts.push(`is_online = $${idx++}`);
      params.push(updates.isOpen);
    }
    if (updates.geofenceRadiusMeters !== undefined) {
      setParts.push(`service_radius_meters = $${idx++}`);
      params.push(updates.geofenceRadiusMeters);
    }
    if (updates.preparationTimeMinutes !== undefined) {
      setParts.push(`base_prep_mins = $${idx++}`);
      params.push(updates.preparationTimeMinutes);
    }

    if (setParts.length > 0) {
      await pool.query(`
        UPDATE merchants
        SET ${setParts.join(', ')}
        WHERE id = $1
      `, params);
    }

    const all = await this.getSellerGeofences();
    return all.find(s => s.id === sellerId) || null;
  }
}

export const sellerService = new SellerService();
