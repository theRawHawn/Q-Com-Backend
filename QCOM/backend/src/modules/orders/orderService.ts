import pg from 'pg';
import crypto from 'crypto';
import { getPool, transaction } from '../../database/connection.js';
import { CreateOrderInput, OrderRecord, OrderStatus } from './orderTypes.js';
import { pricingEngine } from '../pricing/pricingEngine.js';
import { inventoryService } from '../inventory/inventoryService.js';
import { outboxService } from '../outbox/outboxService.js';
import { cancellationService } from './cancellationService.js';
import { bloomFilterService } from '../resilience/bloomFilterService.js';

export class OrderService {
  /**
   * Generates human-readable order number (e.g. QC-2026-98124)
   */
  private generateOrderNumber(): string {
    const randomSuffix = Math.floor(10000 + Math.random() * 90000);
    return `QC-${new Date().getFullYear()}-${randomSuffix}`;
  }

  /**
   * Generates a secure 6-digit delivery verification OTP
   */
  private generateDeliveryOtp(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  /**
   * Creates a new authoritative order within a PostgreSQL transaction
   */
  public async createOrder(input: CreateOrderInput): Promise<{ order: OrderRecord; pricingSnapshot: any }> {
    const pool = getPool();

    // 1. Resolve merchant
    let merchantId = input.merchantId;

    if (!merchantId) {
      const firstProductId = input.items[0]?.productId;
      if (firstProductId) {
        const itemMerchantRes = await pool.query(`
          SELECT m.id as merchant_id
          FROM merchants m
          JOIN store_inventory si ON m.id = si.merchant_id
          WHERE (m.status = 'ACTIVE' OR m.is_online = TRUE)
            AND si.product_id = $1
            AND (si.stock_count - COALESCE(si.reserved_count, 0)) >= $2
          ORDER BY (si.stock_count - COALESCE(si.reserved_count, 0)) DESC
          LIMIT 1
        `, [firstProductId, input.items[0]?.quantity || 1]);

        if (itemMerchantRes.rows.length > 0) {
          merchantId = itemMerchantRes.rows[0].merchant_id;
        }
      }

      if (!merchantId) {
        const merchantRes = await pool.query(`
          SELECT m.id as merchant_id
          FROM merchants m
          WHERE m.status = 'ACTIVE' OR m.is_online = TRUE
          ORDER BY m.created_at ASC
          LIMIT 1
        `);
        if (merchantRes.rows.length === 0) {
          throw new Error('No active open merchants available for order fulfillment.');
        }
        merchantId = merchantRes.rows[0].merchant_id;
      }
    }

    // 2. Authoritative pricing & statutory tax calculation
    const pricingQuote = await pricingEngine.calculate({
      merchantId: merchantId!,
      items: input.items.map(i => ({ productId: i.productId, quantity: i.quantity })),
      customerLocation: {
        latitude: input.jobSite.latitude,
        longitude: input.jobSite.longitude,
      },
      customerGstin: input.gstin,
      placeOfSupplyStateCode: '29',
      couponCode: input.couponCode,
      userId: input.userId,
      idempotencyKey: input.idempotencyKey,
    });

    const orderId = crypto.randomUUID();
    const orderNumber = this.generateOrderNumber();
    const deliveryOtp = this.generateDeliveryOtp();
    const handoverToken = crypto.randomBytes(6).toString('hex').toUpperCase();
    const estimatedDeliveryAt = new Date(Date.now() + 25 * 60 * 1000); // 25 min ETA

    // 3. Persist inside PostgreSQL transaction
    const result = await transaction(async (client: pg.PoolClient) => {
      // Reserve stock with transactional locking
      await inventoryService.reserveStock(
        orderId,
        merchantId!,
        input.items,
        15,
        client
      );

      // Insert Order row
      const insOrderRes = await client.query(`
        INSERT INTO orders (
          id, order_number, user_id, merchant_id, status,
          items_subtotal, delivery_fee, handling_fee, urgency_fee, discount_amount,
          taxable_amount, cgst_amount, sgst_amount, igst_amount, total_amount,
          withholding_amount, gst_tcs_amount,
          payment_method, payment_status, delivery_otp, handover_token,
          jobsite_address, customer_gstin, customer_business_name,
          place_of_supply_state_code, pricing_snapshot, estimated_delivery_at
        )
        VALUES (
          $1, $2, $3, $4, 'placed',
          $5, $6, $7, $8, $9,
          $10, $11, $12, $13, $14,
          $15, $16,
          $17, 'PENDING', $18, $19,
          $20, $21, $22,
          $23, $24, $25
        )
        RETURNING id, order_number, user_id, merchant_id, status,
                  items_subtotal, delivery_fee, handling_fee, urgency_fee, discount_amount,
                  taxable_amount, cgst_amount, sgst_amount, igst_amount, total_amount,
                  withholding_amount, gst_tcs_amount, payment_method, payment_status,
                  delivery_otp, handover_token, jobsite_address, customer_gstin, customer_business_name,
                  place_of_supply_state_code, pricing_snapshot, placed_at, estimated_delivery_at, created_at
      `, [
        orderId,
        orderNumber,
        input.userId,
        merchantId,
        pricingQuote.itemsSubtotal,
        pricingQuote.qcomFeesBreakdown?.deliveryTaxable || '0.00',
        pricingQuote.qcomFeesBreakdown?.handlingTaxable || '0.00',
        0.00,
        pricingQuote.discountAmount || '0.00',
        pricingQuote.taxableAmount || '0.00',
        pricingQuote.totalCgst || '0.00',
        pricingQuote.totalSgst || '0.00',
        pricingQuote.totalIgst || '0.00',
        pricingQuote.grandTotal,
        pricingQuote.withholding?.withholdingAmount || 0.00,
        pricingQuote.gstTcs?.totalTcsAmount || 0.00,
        input.paymentMethod || 'Instant UPI',
        deliveryOtp,
        handoverToken,
        JSON.stringify(input.jobSite),
        input.gstin || null,
        input.businessName || null,
        '29',
        JSON.stringify(pricingQuote),
        estimatedDeliveryAt,
      ]);

      const orderRow = insOrderRes.rows[0];

      // Insert Order Items
      const orderItems: any[] = [];
      for (const line of pricingQuote.items) {
        const insItem = await client.query(`
          INSERT INTO order_items (
            order_id, product_id, product_name, unit_price, quantity,
            total_price, hsn_code, taxable_amount, gst_rate_percent,
            cgst_amount, sgst_amount, igst_amount, bin_location
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'A1')
          RETURNING id, product_id, product_name, unit_price, quantity, total_price, hsn_code, taxable_amount, gst_rate_percent, cgst_amount, sgst_amount, igst_amount
        `, [
          orderId,
          line.productId,
          line.productName,
          line.unitPrice,
          line.quantity,
          line.grossAmount || line.lineTotal,
          line.hsnCode,
          line.taxableAmount,
          line.gstRatePercent,
          line.cgstAmount,
          line.sgstAmount,
          line.igstAmount,
        ]);
        orderItems.push(insItem.rows[0]);
      }

      const orderRecord: OrderRecord = {
        id: orderRow.id,
        orderNumber: orderRow.order_number,
        userId: orderRow.user_id,
        merchantId: orderRow.merchant_id,
        status: orderRow.status as OrderStatus,
        itemsSubtotal: parseFloat(orderRow.items_subtotal),
        deliveryFee: parseFloat(orderRow.delivery_fee),
        handlingFee: parseFloat(orderRow.handling_fee),
        urgencyFee: parseFloat(orderRow.urgency_fee),
        discountAmount: parseFloat(orderRow.discount_amount),
        taxableAmount: parseFloat(orderRow.taxable_amount),
        cgstAmount: parseFloat(orderRow.cgst_amount),
        sgstAmount: parseFloat(orderRow.sgst_amount),
        igstAmount: parseFloat(orderRow.igst_amount),
        totalAmount: parseFloat(orderRow.total_amount),
        withholdingAmount: parseFloat(orderRow.withholding_amount),
        gstTcsAmount: parseFloat(orderRow.gst_tcs_amount),
        paymentMethod: orderRow.payment_method,
        paymentStatus: orderRow.payment_status,
        deliveryOtp: orderRow.delivery_otp,
        handoverToken: orderRow.handover_token,
        jobsiteAddress: orderRow.jobsite_address,
        customerGstin: orderRow.customer_gstin || undefined,
        customerBusinessName: orderRow.customer_business_name || undefined,
        placeOfSupplyStateCode: orderRow.place_of_supply_state_code,
        pricingSnapshot: orderRow.pricing_snapshot,
        placedAt: orderRow.placed_at?.toISOString() || new Date().toISOString(),
        estimatedDeliveryAt: orderRow.estimated_delivery_at?.toISOString(),
        createdAt: orderRow.created_at?.toISOString() || new Date().toISOString(),
        items: orderItems.map(item => ({
          id: item.id,
          productId: item.product_id,
          productName: item.product_name,
          unitPrice: parseFloat(item.unit_price),
          quantity: item.quantity,
          totalPrice: parseFloat(item.total_price),
          hsnCode: item.hsn_code,
          taxableAmount: parseFloat(item.taxable_amount),
          gstRatePercent: parseFloat(item.gst_rate_percent),
          cgstAmount: parseFloat(item.cgst_amount),
          sgstAmount: parseFloat(item.sgst_amount),
          igstAmount: parseFloat(item.igst_amount),
        })),
      };

      // Stage transactional outbox event for atomic publication
      await outboxService.stageEvent(client, {
        eventType: 'ORDER_CREATED',
        aggregateType: 'ORDER',
        aggregateId: orderId,
        payload: {
          orderId,
          orderNumber: orderRow.order_number,
          userId: orderRow.user_id,
          merchantId: orderRow.merchant_id,
          totalAmount: orderRecord.totalAmount,
          status: orderRecord.status,
        },
      });

      return {
        order: orderRecord,
        pricingSnapshot: pricingQuote,
      };
    });

    // Register committed orderId into Bloom Filter post-commit
    if (result && result.order && result.order.id) {
      bloomFilterService.add('orders', result.order.id);
    }

    return result;
  }

  /**
   * Retrieves orders for a customer
   */
  public async getOrders(userId: string): Promise<OrderRecord[]> {
    const pool = getPool();
    const res = await pool.query(`
      SELECT o.*
      FROM orders o
      WHERE o.user_id = $1
      ORDER BY o.created_at DESC
    `, [userId]);

    const orders: OrderRecord[] = [];
    for (const r of res.rows) {
      const itemsRes = await pool.query(`
        SELECT * FROM order_items WHERE order_id = $1
      `, [r.id]);

      orders.push({
        id: r.id,
        orderNumber: r.order_number,
        userId: r.user_id,
        merchantId: r.merchant_id,
        status: r.status as OrderStatus,
        itemsSubtotal: parseFloat(r.items_subtotal),
        deliveryFee: parseFloat(r.delivery_fee),
        handlingFee: parseFloat(r.handling_fee),
        urgencyFee: parseFloat(r.urgency_fee),
        discountAmount: parseFloat(r.discount_amount),
        taxableAmount: parseFloat(r.taxable_amount),
        cgstAmount: parseFloat(r.cgst_amount),
        sgstAmount: parseFloat(r.sgst_amount),
        igstAmount: parseFloat(r.igst_amount),
        totalAmount: parseFloat(r.total_amount),
        withholdingAmount: parseFloat(r.withholding_amount),
        gstTcsAmount: parseFloat(r.gst_tcs_amount),
        paymentMethod: r.payment_method,
        paymentStatus: r.payment_status,
        deliveryOtp: r.delivery_otp,
        handoverToken: r.handover_token,
        jobsiteAddress: r.jobsite_address,
        customerGstin: r.customer_gstin || undefined,
        customerBusinessName: r.customer_business_name || undefined,
        placeOfSupplyStateCode: r.place_of_supply_state_code,
        pricingSnapshot: r.pricing_snapshot,
        cancellationReason: r.cancellation_reason || undefined,
        placedAt: r.placed_at?.toISOString() || r.created_at?.toISOString(),
        estimatedDeliveryAt: r.estimated_delivery_at?.toISOString(),
        deliveredAt: r.delivered_at?.toISOString() || undefined,
        createdAt: r.created_at?.toISOString(),
        items: itemsRes.rows.map(item => ({
          id: item.id,
          productId: item.product_id,
          productName: item.product_name,
          unitPrice: parseFloat(item.unit_price),
          quantity: item.quantity,
          totalPrice: parseFloat(item.total_price),
          hsnCode: item.hsn_code,
          taxableAmount: parseFloat(item.taxable_amount),
          gstRatePercent: parseFloat(item.gst_rate_percent),
          cgstAmount: parseFloat(item.cgst_amount),
          sgstAmount: parseFloat(item.sgst_amount),
          igstAmount: parseFloat(item.igst_amount),
        })),
      });
    }

    return orders;
  }

  /**
   * Retrieves single order by ID with tenant & customer isolation check
   * Protects PostgreSQL with Bloom Filter negative-lookup optimization
   */
  public async getOrderById(orderId: string, userId: string, isStaff: boolean = false): Promise<OrderRecord | null> {
    // 1. Bloom Filter negative-lookup protection with cross-instance propagation safety
    if (!(await bloomFilterService.mightContainSafe('orders', orderId))) {
      return null; // Definitely absent, avoid database query
    }

    const pool = getPool();
    const query = isStaff
      ? `SELECT * FROM orders WHERE id = $1 LIMIT 1`
      : `SELECT * FROM orders WHERE id = $1 AND user_id = $2 LIMIT 1`;
    const params = isStaff ? [orderId] : [orderId, userId];

    const res = await pool.query(query, params);
    if (res.rows.length === 0) {
      if (isStaff) {
        bloomFilterService.recordFalsePositive();
      }
      return null;
    }

    const r = res.rows[0];
    const itemsRes = await pool.query(`SELECT * FROM order_items WHERE order_id = $1`, [r.id]);

    return {
      id: r.id,
      orderNumber: r.order_number,
      userId: r.user_id,
      merchantId: r.merchant_id,
      status: r.status as OrderStatus,
      itemsSubtotal: parseFloat(r.items_subtotal),
      deliveryFee: parseFloat(r.delivery_fee),
      handlingFee: parseFloat(r.handling_fee),
      urgencyFee: parseFloat(r.urgency_fee),
      discountAmount: parseFloat(r.discount_amount),
      taxableAmount: parseFloat(r.taxable_amount),
      cgstAmount: parseFloat(r.cgst_amount),
      sgstAmount: parseFloat(r.sgst_amount),
      igstAmount: parseFloat(r.igst_amount),
      totalAmount: parseFloat(r.total_amount),
      withholdingAmount: parseFloat(r.withholding_amount),
      gstTcsAmount: parseFloat(r.gst_tcs_amount),
      paymentMethod: r.payment_method,
      paymentStatus: r.payment_status,
      deliveryOtp: r.delivery_otp,
      handoverToken: r.handover_token,
      jobsiteAddress: r.jobsite_address,
      customerGstin: r.customer_gstin || undefined,
      customerBusinessName: r.customer_business_name || undefined,
      placeOfSupplyStateCode: r.place_of_supply_state_code,
      pricingSnapshot: r.pricing_snapshot,
      cancellationReason: r.cancellation_reason || undefined,
      placedAt: r.placed_at?.toISOString() || r.created_at?.toISOString(),
      estimatedDeliveryAt: r.estimated_delivery_at?.toISOString(),
      deliveredAt: r.delivered_at?.toISOString() || undefined,
      createdAt: r.created_at?.toISOString(),
      items: itemsRes.rows.map(item => ({
        id: item.id,
        productId: item.product_id,
        productName: item.product_name,
        unitPrice: parseFloat(item.unit_price),
        quantity: item.quantity,
        totalPrice: parseFloat(item.total_price),
        hsnCode: item.hsn_code,
        taxableAmount: parseFloat(item.taxable_amount),
        gstRatePercent: parseFloat(item.gst_rate_percent),
        cgstAmount: parseFloat(item.cgst_amount),
        sgstAmount: parseFloat(item.sgst_amount),
        igstAmount: parseFloat(item.igst_amount),
      })),
    };
  }

  /**
   * Cancels order if within the 5-minute grace window and not yet dispatched
   */
  public async cancelOrder(
    orderId: string,
    userId: string,
    reason?: string,
    idempotencyKey?: string
  ): Promise<{ order: OrderRecord; refund: any }> {
    const result = await cancellationService.cancelByCustomer({
      orderId,
      userId,
      reason,
      idempotencyKey,
    });
    return {
      order: result.order,
      refund: result.refund,
    };
  }
}

export const orderService = new OrderService();
