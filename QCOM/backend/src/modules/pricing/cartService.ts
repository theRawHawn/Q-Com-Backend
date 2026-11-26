import { getPool, transaction } from '../../database/connection.js';
import { pricingEngine, PricingEngineError } from './pricingEngine.js';
import { PricingQuote } from './pricingTypes.js';
import { roundCurrency } from './money.js';

export interface CartPriceChangeNotice {
  productId: string;
  productName: string;
  previousUnitPrice: string;
  currentUnitPrice: string;
}

export interface PersistentCartView {
  cartId: string;
  userId: string;
  merchantId: string;
  couponCode: string | null;
  placeOfSupplyStateCode: string | null;
  items: Array<{
    productId: string;
    quantity: number;
    unitPriceSnapshot: string;
    currentUnitPrice: string;
    taxRateSnapshot: string;
  }>;
  priceChanges: CartPriceChangeNotice[];
  quote: PricingQuote | null;
}

export class CartService {
  private async ensureCart(userId: string, merchantId: string) {
    const pool = getPool();
    const res = await pool.query(
      `INSERT INTO carts (user_id, merchant_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id, merchant_id)
       DO UPDATE SET updated_at = carts.updated_at
       RETURNING *`,
      [userId, merchantId]
    );
    return res.rows[0];
  }

  async getCart(params: {
    userId: string;
    merchantId: string;
    deliveryAddressId?: string;
    customerGstin?: string;
    distanceKm?: number;
  }): Promise<PersistentCartView> {
    const pool = getPool();
    const cart = await this.ensureCart(params.userId, params.merchantId);

    const itemsRes = await pool.query(
      `SELECT ci.product_id, ci.quantity, ci.unit_price_snapshot, ci.tax_rate_snapshot,
              p.name AS product_name, si.selling_price AS current_price
         FROM cart_items ci
         JOIN products p ON p.id = ci.product_id
         LEFT JOIN store_inventory si ON si.product_id = ci.product_id AND si.merchant_id = $2
        WHERE ci.cart_id = $1
        ORDER BY ci.created_at ASC`,
      [cart.id, params.merchantId]
    );

    const priceChanges: CartPriceChangeNotice[] = [];
    for (const row of itemsRes.rows) {
      if (row.current_price !== null && row.current_price !== undefined) {
        const snap = roundCurrency(row.unit_price_snapshot);
        const live = roundCurrency(row.current_price);
        if (snap !== live) {
          priceChanges.push({
            productId: row.product_id,
            productName: row.product_name,
            previousUnitPrice: snap,
            currentUnitPrice: live,
          });
        }
      }
    }

    let quote: PricingQuote | null = null;
    if (itemsRes.rows.length > 0) {
      quote = await pricingEngine.calculate(
        {
          merchantId: params.merchantId,
          userId: params.userId,
          items: itemsRes.rows.map((r) => ({
            productId: r.product_id,
            quantity: Number(r.quantity),
          })),
          couponCode: cart.coupon_code || undefined,
          placeOfSupplyStateCode: cart.place_of_supply_state_code || undefined,
          deliveryAddressId: params.deliveryAddressId,
          customerGstin: params.customerGstin,
          distanceKm: params.distanceKm,
        },
        pool
      );

      await pool.query(
        `UPDATE carts
            SET last_quote_id = $1, last_quoted_total = $2, last_quoted_at = NOW(), updated_at = NOW()
          WHERE id = $3`,
        [quote.quoteId, quote.grandTotal, cart.id]
      );
    }

    return {
      cartId: cart.id,
      userId: cart.user_id,
      merchantId: cart.merchant_id,
      couponCode: cart.coupon_code || null,
      placeOfSupplyStateCode: cart.place_of_supply_state_code || null,
      items: itemsRes.rows.map((r) => ({
        productId: r.product_id,
        quantity: Number(r.quantity),
        unitPriceSnapshot: roundCurrency(r.unit_price_snapshot),
        currentUnitPrice: r.current_price !== null ? roundCurrency(r.current_price) : roundCurrency(r.unit_price_snapshot),
        taxRateSnapshot: roundCurrency(r.tax_rate_snapshot || 0),
      })),
      priceChanges,
      quote,
    };
  }

  async upsertItem(params: {
    userId: string;
    merchantId: string;
    productId: string;
    quantity: number;
    placeOfSupplyStateCode?: string;
    distanceKm?: number;
  }): Promise<PersistentCartView> {
    if (!Number.isInteger(params.quantity) || params.quantity < 0) {
      throw new PricingEngineError('INVALID_QUANTITY', 'Quantity must be a non-negative integer.', 400);
    }

    if (params.quantity === 0) {
      return this.removeItem({
        userId: params.userId,
        merchantId: params.merchantId,
        productId: params.productId,
      });
    }

    await transaction(async (client) => {
      const cartRes = await client.query(
        `INSERT INTO carts (user_id, merchant_id, place_of_supply_state_code)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, merchant_id)
         DO UPDATE SET place_of_supply_state_code = COALESCE($3, carts.place_of_supply_state_code),
                       updated_at = NOW()
         RETURNING *`,
        [params.userId, params.merchantId, params.placeOfSupplyStateCode || null]
      );
      const cartId = cartRes.rows[0].id;

      const invRes = await client.query(
        `SELECT si.selling_price, p.gst_rate_percent, si.is_available
           FROM store_inventory si
           JOIN products p ON p.id = si.product_id
          WHERE si.merchant_id = $1 AND si.product_id = $2`,
        [params.merchantId, params.productId]
      );

      if (invRes.rows.length === 0 || !invRes.rows[0].is_available) {
        throw new PricingEngineError('PRODUCT_NOT_AVAILABLE', 'Product is not available in this merchant catalog.', 404);
      }

      const unitPrice = roundCurrency(invRes.rows[0].selling_price);
      const taxRate = roundCurrency(invRes.rows[0].gst_rate_percent || 0);

      await client.query(
        `INSERT INTO cart_items (cart_id, product_id, quantity, unit_price_snapshot, tax_rate_snapshot)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (cart_id, product_id)
         DO UPDATE SET quantity = EXCLUDED.quantity,
                       unit_price_snapshot = EXCLUDED.unit_price_snapshot,
                       tax_rate_snapshot = EXCLUDED.tax_rate_snapshot,
                       updated_at = NOW()`,
        [cartId, params.productId, params.quantity, unitPrice, taxRate]
      );
    });

    return this.getCart({
      userId: params.userId,
      merchantId: params.merchantId,
      distanceKm: params.distanceKm,
    });
  }

  async removeItem(params: {
    userId: string;
    merchantId: string;
    productId: string;
  }): Promise<PersistentCartView> {
    const pool = getPool();
    const cart = await this.ensureCart(params.userId, params.merchantId);
    await pool.query(
      `DELETE FROM cart_items WHERE cart_id = $1 AND product_id = $2`,
      [cart.id, params.productId]
    );
    return this.getCart({ userId: params.userId, merchantId: params.merchantId });
  }

  async applyCoupon(params: {
    userId: string;
    merchantId: string;
    couponCode: string | null;
    distanceKm?: number;
  }): Promise<PersistentCartView> {
    const pool = getPool();
    const cart = await this.ensureCart(params.userId, params.merchantId);
    const cleanCode = params.couponCode && params.couponCode.trim() !== ''
      ? params.couponCode.trim().toUpperCase()
      : null;

    // Validate before persisting coupon code if items exist
    const itemsRes = await pool.query(
      `SELECT product_id, quantity FROM cart_items WHERE cart_id = $1`,
      [cart.id]
    );

    if (itemsRes.rows.length > 0 && cleanCode) {
      await pricingEngine.calculate(
        {
          merchantId: params.merchantId,
          userId: params.userId,
          items: itemsRes.rows.map((r) => ({ productId: r.product_id, quantity: Number(r.quantity) })),
          couponCode: cleanCode,
          placeOfSupplyStateCode: cart.place_of_supply_state_code || undefined,
          distanceKm: params.distanceKm,
        },
        pool
      );
    }

    await pool.query(
      `UPDATE carts SET coupon_code = $1, updated_at = NOW() WHERE id = $2`,
      [cleanCode, cart.id]
    );

    return this.getCart({
      userId: params.userId,
      merchantId: params.merchantId,
      distanceKm: params.distanceKm,
    });
  }

  async clearCart(userId: string, merchantId: string): Promise<void> {
    const pool = getPool();
    const cartRes = await pool.query(
      `SELECT id FROM carts WHERE user_id = $1 AND merchant_id = $2 LIMIT 1`,
      [userId, merchantId]
    );
    if (cartRes.rows.length > 0) {
      const cartId = cartRes.rows[0].id;
      await pool.query(`DELETE FROM cart_items WHERE cart_id = $1`, [cartId]);
      await pool.query(
        `UPDATE carts SET coupon_code = NULL, last_quote_id = NULL, last_quoted_total = NULL, updated_at = NOW() WHERE id = $1`,
        [cartId]
      );
    }
  }
}

export const cartService = new CartService();
