import { getPool, transaction } from '../../database/connection.js';
import { CustomerProfile, SavedGstinRecord, SavedAddressRecord } from './customerTypes.js';

export class CustomerService {
  /**
   * Validates 15-character statutory GSTIN format
   */
  public validateGstinFormat(gstin: string): boolean {
    if (!gstin || typeof gstin !== 'string') return false;
    const clean = gstin.trim().toUpperCase();
    const gstinRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
    return gstinRegex.test(clean);
  }

  /**
   * Retrieves customer profile by user ID from PostgreSQL
   */
  public async getProfile(userId: string): Promise<CustomerProfile | null> {
    const pool = getPool();
    const userRes = await pool.query(`
      SELECT id, phone, name, email, account_type, pan_number, pan_status, created_at, updated_at
      FROM users
      WHERE id = $1
      LIMIT 1
    `, [userId]);

    if (!userRes.rows || userRes.rows.length === 0) {
      return null;
    }

    const u = userRes.rows[0];

    // Fetch saved GSTINs
    const gstinsRes = await pool.query(`
      SELECT id, user_id, gstin, legal_business_name, trade_name, billing_address, state, state_code, pincode, is_default, created_at
      FROM saved_gstins
      WHERE user_id = $1
      ORDER BY is_default DESC, created_at DESC
    `, [userId]);

    const savedGstins: SavedGstinRecord[] = gstinsRes.rows.map(g => ({
      id: g.id,
      userId: g.user_id,
      gstin: g.gstin,
      legalBusinessName: g.legal_business_name,
      tradeName: g.trade_name || undefined,
      billingAddress: g.billing_address,
      state: g.state,
      stateCode: g.state_code,
      pincode: g.pincode,
      isDefault: g.is_default,
      createdAt: g.created_at?.toISOString() || new Date().toISOString(),
    }));

    // Fetch primary address
    const addrRes = await pool.query(`
      SELECT address, landmark, floor_unit, job_tag
      FROM saved_addresses
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 1
    `, [userId]);

    const addr = addrRes.rows[0] || {};

    return {
      id: u.id,
      phone: u.phone,
      name: u.name || '',
      email: u.email || '',
      accountType: u.account_type || 'individual',
      panNumber: u.pan_number || undefined,
      panStatus: u.pan_status || undefined,
      defaultAddress: addr.address || undefined,
      floorUnit: addr.floor_unit || undefined,
      landmark: addr.landmark || undefined,
      jobTag: addr.job_tag || undefined,
      savedGstins,
      createdAt: u.created_at?.toISOString(),
      updatedAt: u.updated_at?.toISOString(),
    };
  }

  /**
   * Updates customer profile in PostgreSQL
   */
  public async updateProfile(
    userId: string,
    updates: {
      name?: string;
      email?: string;
      accountType?: 'individual' | 'business';
      defaultAddress?: string;
      floorUnit?: string;
      landmark?: string;
      jobTag?: string;
    }
  ): Promise<CustomerProfile> {
    const pool = getPool();

    await transaction(async (client) => {
      // Update users table
      const setParts: string[] = ['updated_at = NOW()'];
      const params: any[] = [userId];
      let paramIdx = 2;

      if (updates.name !== undefined) {
        setParts.push(`name = $${paramIdx++}`);
        params.push(updates.name);
      }
      if (updates.email !== undefined) {
        setParts.push(`email = $${paramIdx++}`);
        params.push(updates.email);
      }
      if (updates.accountType !== undefined) {
        setParts.push(`account_type = $${paramIdx++}`);
        params.push(updates.accountType);
      }

      await client.query(`
        UPDATE users
        SET ${setParts.join(', ')}
        WHERE id = $1
      `, params);

      // If address information provided, upsert saved_addresses
      if (updates.defaultAddress) {
        await client.query(`
          INSERT INTO saved_addresses (user_id, address, floor_unit, landmark, job_tag, site_contact_name, site_phone, latitude, longitude)
          VALUES ($1, $2, $3, $4, $5, COALESCE((SELECT name FROM users WHERE id = $1), 'Customer'), COALESCE((SELECT phone FROM users WHERE id = $1), ''), 12.9716, 77.5946)
        `, [
          userId,
          updates.defaultAddress,
          updates.floorUnit || null,
          updates.landmark || null,
          updates.jobTag || null,
        ]);
      }
    });

    const updated = await this.getProfile(userId);
    if (!updated) {
      throw new Error('Failed to load updated customer profile.');
    }
    return updated;
  }

  /**
   * Adds or updates a statutory GSTIN for the customer
   */
  public async addSavedGstin(
    userId: string,
    gstinData: {
      gstin: string;
      legalBusinessName: string;
      tradeName?: string;
      billingAddress: string;
      state: string;
      stateCode: string;
      pincode?: string;
      isDefault?: boolean;
    }
  ): Promise<{ savedGstin: SavedGstinRecord; allSavedGstins: SavedGstinRecord[] }> {
    if (!this.validateGstinFormat(gstinData.gstin)) {
      throw new Error(`Invalid statutory GSTIN format: ${gstinData.gstin}. Must be 15 alphanumeric characters.`);
    }

    const pool = getPool();
    const cleanGstin = gstinData.gstin.trim().toUpperCase();

    await transaction(async (client) => {
      // If marking as default, unset other defaults for this user
      if (gstinData.isDefault) {
        await client.query(`
          UPDATE saved_gstins
          SET is_default = FALSE
          WHERE user_id = $1
        `, [userId]);
      }

      // Check if this GSTIN already exists for this user
      const existing = await client.query(`
        SELECT id FROM saved_gstins
        WHERE user_id = $1 AND gstin = $2
        LIMIT 1
      `, [userId, cleanGstin]);

      if (existing.rows.length > 0) {
        await client.query(`
          UPDATE saved_gstins
          SET legal_business_name = $3,
              trade_name = $4,
              billing_address = $5,
              state = $6,
              state_code = $7,
              pincode = $8,
              is_default = $9
          WHERE id = $1 AND user_id = $2
        `, [
          existing.rows[0].id,
          userId,
          gstinData.legalBusinessName,
          gstinData.tradeName || null,
          gstinData.billingAddress,
          gstinData.state,
          gstinData.stateCode,
          gstinData.pincode || '560001',
          gstinData.isDefault ?? true,
        ]);
      } else {
        await client.query(`
          INSERT INTO saved_gstins (user_id, gstin, legal_business_name, trade_name, billing_address, state, state_code, pincode, is_default)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `, [
          userId,
          cleanGstin,
          gstinData.legalBusinessName,
          gstinData.tradeName || null,
          gstinData.billingAddress,
          gstinData.state,
          gstinData.stateCode,
          gstinData.pincode || '560001',
          gstinData.isDefault ?? true,
        ]);
      }

      // Ensure user account_type is set to business
      await client.query(`
        UPDATE users
        SET account_type = 'business', updated_at = NOW()
        WHERE id = $1
      `, [userId]);
    });

    const fullProfile = await this.getProfile(userId);
    const allGstins = fullProfile?.savedGstins || [];
    const saved = allGstins.find(g => g.gstin === cleanGstin) || allGstins[0];

    return {
      savedGstin: saved,
      allSavedGstins: allGstins,
    };
  }
}

export const customerService = new CustomerService();
