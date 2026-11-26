import pg from 'pg';
import crypto from 'crypto';
import { getPool, transaction } from '../../database/connection.js';
import { CreateOrderInput, OrderRecord, OrderStatus } from './orderTypes.js';
import { pricingEngine, PricingEngineError } from '../pricing/pricingEngine.js';
import { couponPromotionService } from '../pricing/couponPromotionService.js';
import { toDecimal, roundCurrency } from '../pricing/money.js';
import { inventoryService } from '../inventory/inventoryService.js';
import { outboxService } from '../outbox/outboxService.js';
import { cancellationService } from './cancellationService.js';
import { bloomFilterService } from '../resilience/bloomFilterService.js';
import { isCodPaymentMethod } from '../ledger/ledgerService.js';
import { env } from '../../config/env.js';

export class OrderService {
  private static orderSequence: number = Math.floor(Math.random() * 10000);

  /**
   * Generates a collision-resistant unique order tracking number
   */
  private generateOrderNumber(): string {
    OrderService.orderSequence = (OrderService.orderSequence + 1) % 900000;
    const seq = (100000 + OrderService.orderSequence).toString();
    const rand = Math.floor(10 + Math.random() * 90);
    return `QC-${new Date().getFullYear()}-${seq}${rand}`;
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

    const deliveryDest = input.deliveryLocation || input.deliveryAddress || input.jobSite;
    if (!deliveryDest) {
      throw new Error('DELIVERY_LOCATION_REQUIRED: A delivery location is required to place this order.');
    }

    const orderId = crypto.randomUUID();
    const orderNumber = this.generateOrderNumber();
    const deliveryOtp = this.generateDeliveryOtp();
    const handoverToken = crypto.randomBytes(6).toString('hex').toUpperCase();
    const estimatedDeliveryAt = new Date(Date.now() + 25 * 60 * 1000); // 25 min ETA

    // 2. Authoritative calculation + reservation + persistence inside single PostgreSQL transaction
    const result = await transaction(async (client: pg.PoolClient) => {
      // If caller passed a quoteId, verify it has not expired
      if (input.quoteId) {
        const quoteRowRes = await client.query(
          `SELECT id, grand_total, expires_at, user_id, merchant_id
             FROM pricing_calculation_snapshots
            WHERE id = $1
            FOR UPDATE`,
          [input.quoteId]
        );
        if (quoteRowRes.rows.length === 0) {
          throw new PricingEngineError('QUOTE_NOT_FOUND', `Pricing quote '${input.quoteId}' does not exist.`, 404);
        }
        const qRow = quoteRowRes.rows[0];
        if (qRow.expires_at && new Date(qRow.expires_at).getTime() <= Date.now()) {
          throw new PricingEngineError(
            'QUOTE_EXPIRED',
            'Your checkout pricing quote has expired. Please recalculate totals before placing order.',
            409
          );
        }
      }

      // Compute fresh authoritative pricing inside this transaction BEFORE stock reservation
      const pricingQuote = await pricingEngine.calculate(
        {
          merchantId: merchantId!,
          storeId: input.storeId,
          items: input.items.map(i => ({ productId: i.productId, quantity: i.quantity })),
          customerLocation: {
            latitude: deliveryDest.latitude,
            longitude: deliveryDest.longitude,
          },
          customerGstin: input.gstin,
          placeOfSupplyStateCode: input.placeOfSupplyStateCode,
          deliveryAddressId: input.deliveryAddressId,
          couponCode: input.couponCode,
          userId: input.userId,
          idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:order_calc` : undefined,
        },
        client
      );

      if (input.expectedTotal !== undefined && input.expectedTotal !== null) {
        const expectedStr = roundCurrency(input.expectedTotal);
        if (!toDecimal(expectedStr).eq(toDecimal(pricingQuote.grandTotal))) {
          throw new PricingEngineError(
            'PRICE_CHANGED',
            `Checkout total changed from ₹${expectedStr} to ₹${pricingQuote.grandTotal}. Please review the updated pricing before confirming.`,
            409
          );
        }
      }

      // Reserve stock with transactional locking
      await inventoryService.reserveStock(
        orderId,
        merchantId!,
        input.items,
        env.RESERVATION_TTL_MINUTES,
        client
      );

      // Only immediately commit stock upon order placement for Cash on Delivery (Pay on Delivery) orders.
      // Online payment orders retain RESERVED status until payment verification / capture confirms payment.
      const isCod = isCodPaymentMethod(input.paymentMethod);
      if (isCod) {
        await inventoryService.commitStock(orderId, client);
      }

      // Insert Order row with dynamic POS, cess, coupons & promotion funding split
      const insOrderRes = await client.query(`
        INSERT INTO orders (
          id, order_number, user_id, merchant_id, status,
          items_subtotal, delivery_fee, handling_fee, urgency_fee, discount_amount,
          taxable_amount, cgst_amount, sgst_amount, igst_amount, cess_amount, total_amount,
          withholding_amount, gst_tcs_amount,
          coupon_id, coupon_code, applied_promotions, quote_id,
          platform_discount_subsidy, seller_discount_amount,
          payment_method, payment_status, delivery_otp, handover_token,
          jobsite_address, customer_gstin, customer_business_name,
          place_of_supply_state_code, pricing_snapshot, estimated_delivery_at
        )
        VALUES (
          $1, $2, $3, $4, 'placed',
          $5, $6, $7, $8, $9,
          $10, $11, $12, $13, $14, $15,
          $16, $17,
          $18, $19, $20::jsonb, $21,
          $22, $23,
          $24, 'PENDING', $25, $26,
          $27, $28, $29,
          $30, $31, $32
        )
        RETURNING id, order_number, user_id, merchant_id, status,
                  items_subtotal, delivery_fee, handling_fee, urgency_fee, discount_amount,
                  taxable_amount, cgst_amount, sgst_amount, igst_amount, cess_amount, total_amount,
                  withholding_amount, gst_tcs_amount,
                  coupon_id, coupon_code, applied_promotions, quote_id,
                  platform_discount_subsidy, seller_discount_amount,
                  payment_method, payment_status,
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
        pricingQuote.totalCess || '0.00',
        pricingQuote.grandTotal,
        pricingQuote.withholding?.withholdingAmount || 0.00,
        pricingQuote.gstTcs?.totalTcsAmount || 0.00,
        pricingQuote.appliedCoupon?.couponId || null,
        pricingQuote.appliedCoupon?.code || null,
        JSON.stringify(pricingQuote.appliedPromotions || []),
        pricingQuote.quoteId,
        pricingQuote.platformDiscountSubsidy || '0.00',
        pricingQuote.sellerDiscountAmount || '0.00',
        input.paymentMethod || 'Instant UPI',
        deliveryOtp,
        handoverToken,
        JSON.stringify(deliveryDest),
        input.gstin || null,
        input.businessName || null,
        pricingQuote.placeOfSupplyStateCode,
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
            total_price, discount_amount, hsn_code, taxable_amount, gst_rate_percent,
            cgst_amount, sgst_amount, igst_amount, cess_amount,
            tax_inclusive, tax_category, line_total_payable, applied_discounts, bin_location
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, 'A1')
          RETURNING id, product_id, product_name, unit_price, quantity, total_price, discount_amount,
                    hsn_code, taxable_amount, gst_rate_percent, cgst_amount, sgst_amount, igst_amount,
                    cess_amount, tax_inclusive, tax_category, line_total_payable
        `, [
          orderId,
          line.productId,
          line.productName,
          line.unitPrice,
          line.quantity,
          line.grossAmount || line.lineTotal,
          line.discountAmount || '0.00',
          line.hsnCode,
          line.taxableAmount,
          line.gstRatePercent,
          line.cgstAmount,
          line.sgstAmount,
          line.igstAmount,
          line.cessAmount || '0.00',
          Boolean(line.taxInclusive),
          line.taxCategory || 'TAXABLE',
          line.lineTotal,
          JSON.stringify(line.appliedDiscounts || []),
        ]);
        orderItems.push(insItem.rows[0]);
      }

      // Atomically lock and reserve coupon & promotion usage counts (FOR UPDATE)
      await couponPromotionService.lockAndReserveForOrder({
        client,
        orderId,
        userId: input.userId,
        merchantId: merchantId!,
        appliedCoupon: pricingQuote.appliedCoupon,
        appliedPromotions: pricingQuote.appliedPromotions,
        initialStatus: isCod ? 'REDEEMED' : 'RESERVED',
      });

      // Mark pricing snapshot(s) converted
      await client.query(
        `UPDATE pricing_calculation_snapshots SET is_converted_to_order = TRUE, order_id = $1 WHERE id = $2`,
        [orderId, pricingQuote.quoteId]
      );
      if (input.quoteId && input.quoteId !== pricingQuote.quoteId) {
        await client.query(
          `UPDATE pricing_calculation_snapshots SET is_converted_to_order = TRUE, order_id = $1 WHERE id = $2`,
          [orderId, input.quoteId]
        );
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
        cessAmount: parseFloat(orderRow.cess_amount || '0'),
        totalAmount: parseFloat(orderRow.total_amount),
        withholdingAmount: parseFloat(orderRow.withholding_amount),
        gstTcsAmount: parseFloat(orderRow.gst_tcs_amount),
        couponId: orderRow.coupon_id || undefined,
        couponCode: orderRow.coupon_code || undefined,
        appliedPromotions: orderRow.applied_promotions || [],
        quoteId: orderRow.quote_id || undefined,
        platformDiscountSubsidy: parseFloat(orderRow.platform_discount_subsidy || '0'),
        sellerDiscountAmount: parseFloat(orderRow.seller_discount_amount || '0'),
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
          discountAmount: parseFloat(item.discount_amount || '0'),
          hsnCode: item.hsn_code,
          taxableAmount: parseFloat(item.taxable_amount),
          gstRatePercent: parseFloat(item.gst_rate_percent),
          cgstAmount: parseFloat(item.cgst_amount),
          sgstAmount: parseFloat(item.sgst_amount),
          igstAmount: parseFloat(item.igst_amount),
          cessAmount: parseFloat(item.cess_amount || '0'),
          taxInclusive: Boolean(item.tax_inclusive),
          taxCategory: item.tax_category || 'TAXABLE',
          lineTotalPayable: item.line_total_payable ? parseFloat(item.line_total_payable) : undefined,
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

    if (res.rows.length === 0) {
      return [];
    }

    // Resolve N+1 query bottleneck with chunked bulk fetching to prevent SQL parameter overflow
    const orderIds = res.rows.map(r => r.id);
    const itemsByOrderId = new Map<string, any[]>();
    const CHUNK_SIZE = 200;
    for (let i = 0; i < orderIds.length; i += CHUNK_SIZE) {
      const chunk = orderIds.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map((_, idx) => `$${idx + 1}`).join(', ');
      const itemsRes = await pool.query(
        `SELECT * FROM order_items WHERE order_id IN (${placeholders})`,
        chunk
      );
      for (const item of itemsRes.rows) {
        const list = itemsByOrderId.get(item.order_id) || [];
        list.push(item);
        itemsByOrderId.set(item.order_id, list);
      }
    }

    const orders: OrderRecord[] = [];
    for (const r of res.rows) {
      const orderItems = itemsByOrderId.get(r.id) || [];

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
        cessAmount: parseFloat(r.cess_amount || '0'),
        totalAmount: parseFloat(r.total_amount),
        withholdingAmount: parseFloat(r.withholding_amount),
        gstTcsAmount: parseFloat(r.gst_tcs_amount),
        couponId: r.coupon_id || undefined,
        couponCode: r.coupon_code || undefined,
        appliedPromotions: r.applied_promotions || [],
        quoteId: r.quote_id || undefined,
        platformDiscountSubsidy: parseFloat(r.platform_discount_subsidy || '0'),
        sellerDiscountAmount: parseFloat(r.seller_discount_amount || '0'),
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
        items: orderItems.map((item: any) => ({
          id: item.id,
          productId: item.product_id,
          productName: item.product_name,
          unitPrice: parseFloat(item.unit_price),
          quantity: item.quantity,
          totalPrice: parseFloat(item.total_price),
          discountAmount: parseFloat(item.discount_amount || '0'),
          hsnCode: item.hsn_code,
          taxableAmount: parseFloat(item.taxable_amount),
          gstRatePercent: parseFloat(item.gst_rate_percent),
          cgstAmount: parseFloat(item.cgst_amount),
          sgstAmount: parseFloat(item.sgst_amount),
          igstAmount: parseFloat(item.igst_amount),
          cessAmount: parseFloat(item.cess_amount || '0'),
          taxInclusive: Boolean(item.tax_inclusive),
          taxCategory: item.tax_category || 'TAXABLE',
          lineTotalPayable: item.line_total_payable ? parseFloat(item.line_total_payable) : undefined,
          refundedQuantity: item.refunded_quantity ?? 0,
          refundedAmount: parseFloat(item.refunded_amount || '0'),
        })),
      });
    }

    return orders;
  }

  /**
   * Retrieves single order by ID with tenant & customer isolation check
   * Protects PostgreSQL with Bloom Filter negative-lookup optimization
   */
  public async getOrderById(
    orderId: string,
    userId: string,
    isGlobalAdmin: boolean = false,
    merchantIds: string[] = [],
    riderId?: string
  ): Promise<OrderRecord | null> {
    // 1. Bloom Filter negative-lookup protection with cross-instance propagation safety
    if (!(await bloomFilterService.mightContainSafe('orders', orderId))) {
      return null; // Definitely absent, avoid database query
    }

    const pool = getPool();
    const res = await pool.query(
      `SELECT o.*, dt.rider_id
       FROM orders o
       LEFT JOIN delivery_trips dt ON dt.order_id = o.id
       WHERE o.id = $1`,
      [orderId]
    );
    if (res.rows.length === 0) {
      if (isGlobalAdmin) {
        bloomFilterService.recordFalsePositive();
      }
      return null;
    }

    const r = res.rows[0];
    if (!isGlobalAdmin) {
      const isCustomerOwner = r.user_id === userId;
      const isMerchantOwner = merchantIds.length > 0 && merchantIds.includes(r.merchant_id);
      const isAssignedRider = Boolean(riderId && res.rows.some((row) => row.rider_id === riderId));
      if (!isCustomerOwner && !isMerchantOwner && !isAssignedRider) {
        return null;
      }
    }

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
      cessAmount: parseFloat(r.cess_amount || '0'),
      totalAmount: parseFloat(r.total_amount),
      withholdingAmount: parseFloat(r.withholding_amount),
      gstTcsAmount: parseFloat(r.gst_tcs_amount),
      couponId: r.coupon_id || undefined,
      couponCode: r.coupon_code || undefined,
      appliedPromotions: r.applied_promotions || [],
      quoteId: r.quote_id || undefined,
      platformDiscountSubsidy: parseFloat(r.platform_discount_subsidy || '0'),
      sellerDiscountAmount: parseFloat(r.seller_discount_amount || '0'),
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
        discountAmount: parseFloat(item.discount_amount || '0'),
        hsnCode: item.hsn_code,
        taxableAmount: parseFloat(item.taxable_amount),
        gstRatePercent: parseFloat(item.gst_rate_percent),
        cgstAmount: parseFloat(item.cgst_amount),
        sgstAmount: parseFloat(item.sgst_amount),
        igstAmount: parseFloat(item.igst_amount),
        cessAmount: parseFloat(item.cess_amount || '0'),
        taxInclusive: Boolean(item.tax_inclusive),
        taxCategory: item.tax_category || 'TAXABLE',
        lineTotalPayable: item.line_total_payable ? parseFloat(item.line_total_payable) : undefined,
        refundedQuantity: item.refunded_quantity ?? 0,
        refundedAmount: parseFloat(item.refunded_amount || '0'),
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
