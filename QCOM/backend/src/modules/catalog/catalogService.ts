import { getPool } from '../../database/connection.js';
import { cacheProtectionService } from '../resilience/cacheProtection.js';

export interface CatalogProduct {
  id: string;
  name: string;
  category: string;
  subcategory: string;
  hsnCode: string;
  gstRate: number;
  unitWeightKg: number;
  imageUrl?: string;
  description?: string;
}

export class CatalogService {
  /**
   * Returns all active master products with cache stampede & thundering herd protection.
   */
  public async getProducts(): Promise<CatalogProduct[]> {
    return cacheProtectionService.fetchThroughCache(
      'catalog:products:all',
      { ttlSec: 300, lockTtlMs: 3000, jitterPercent: 10 },
      async () => {
        const pool = getPool();
        const res = await pool.query(`
          SELECT p.id, p.name, p.category, p.subcategory, p.hsn_code, p.gst_rate_percent, p.unit_weight_kg, p.image_url, p.description
          FROM products p
          WHERE p.is_active = TRUE
          ORDER BY p.name ASC
        `);

        return res.rows.map(r => ({
          id: r.id,
          name: r.name,
          category: r.category || 'General Hardware',
          subcategory: r.subcategory || '',
          hsnCode: r.hsn_code,
          gstRate: parseFloat(r.gst_rate_percent || '18.00'),
          unitWeightKg: parseFloat(r.unit_weight_kg || '0.250'),
          imageUrl: r.image_url || undefined,
          description: r.description || undefined,
        }));
      }
    );
  }

  /**
   * Returns all categories with cache stampede protection.
   */
  public async getCategories(): Promise<{ id: string; name: string }[]> {
    return cacheProtectionService.fetchThroughCache(
      'catalog:categories:all',
      { ttlSec: 600, lockTtlMs: 3000, jitterPercent: 10 },
      async () => {
        const pool = getPool();
        const res = await pool.query(`
          SELECT DISTINCT category as name
          FROM products
          WHERE is_active = TRUE
          ORDER BY category ASC
        `);
        return res.rows.map((r, idx) => ({ id: `cat-${idx + 1}`, name: r.name }));
      }
    );
  }

  /**
   * Invalidates catalog cache upon product/category mutations.
   */
  public async invalidateCache(): Promise<void> {
    await cacheProtectionService.invalidate('catalog:products:all');
    await cacheProtectionService.invalidate('catalog:categories:all');
  }
}

export const catalogService = new CatalogService();
