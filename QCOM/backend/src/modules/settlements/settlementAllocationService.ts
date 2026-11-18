import pg from 'pg';
import BigNumber from 'bignumber.js';
import { getPool, transaction } from '../../database/connection.js';
import { ledgerService } from '../ledger/ledgerService.js';
import { taxEngine } from '../pricing/taxEngine.js';
import { OrderSettlementAllocation } from './settlementTypes.js';
import { settlementEventPublisher, SettlementDomainEvent } from './settlementEvents.js';
import { toDecimal, roundCurrency, add, subtract, multiply, divide } from '../pricing/money.js';

export class SettlementAllocationService {
  /**
   * Performs atomic post-fulfillment financial allocation
   * Reconciles order escrow into seller payable, rider wallet, platform revenues, and statutory withholdings
   */
  public async allocateFulfilledOrder(
    orderId: string,
    clientOverride?: pg.PoolClient
  ): Promise<OrderSettlementAllocation> {
    const stagedEvents: SettlementDomainEvent[] = [];

    const execute = async (client: pg.PoolClient): Promise<OrderSettlementAllocation> => {
      // 1. Row-level lock on order
      const orderRes = await client.query(`
        SELECT * FROM orders
        WHERE id = $1
        FOR UPDATE
      `, [orderId]);

      if (orderRes.rows.length === 0) {
        throw new Error(`ORDER_NOT_FOUND: Order '${orderId}' does not exist.`);
      }

      const order = orderRes.rows[0];

      // 2. Concurrency & Idempotency: Check if already allocated
      const existingAllocRes = await client.query(`
        SELECT * FROM order_settlement_allocations
        WHERE order_id = $1
        LIMIT 1
        FOR UPDATE
      `, [orderId]);

      if (existingAllocRes.rows.length > 0) {
        const row = existingAllocRes.rows[0];
        return {
          id: row.id,
          orderId: row.order_id,
          merchantId: row.merchant_id,
          riderId: row.rider_id,
          tripId: row.trip_id,
          journalBatchId: row.journal_batch_id,
          orderTotal: parseFloat(row.order_total),
          grossGmv: parseFloat(row.gross_gmv),
          sellerGoodsTaxable: parseFloat(row.seller_goods_taxable),
          sellerGoodsGst: parseFloat(row.seller_goods_gst),
          platformCommission: parseFloat(row.platform_commission),
          commissionGst: parseFloat(row.commission_gst),
          gstTcsAmount: parseFloat(row.gst_tcs_amount),
          sellerTdsAmount: parseFloat(row.seller_tds_amount),
          storeDelayPenalty: parseFloat(row.store_delay_penalty),
          netSellerPayable: parseFloat(row.net_seller_payable),
          customerDeliveryFee: parseFloat(row.customer_delivery_fee),
          customerHandlingFee: parseFloat(row.customer_handling_fee),
          grossRiderFare: parseFloat(row.gross_rider_fare),
          customerTip: parseFloat(row.customer_tip),
          riderTdsAmount: parseFloat(row.rider_tds_amount),
          netRiderPayable: parseFloat(row.net_rider_payable),
          platformSubsidy: parseFloat(row.platform_subsidy),
          status: row.status,
          allocatedAt: row.allocated_at.toISOString(),
        };
      }

      const isCodOrder = ['pay on delivery', 'cod', 'cash on delivery'].includes(
        String(order.payment_method || '').trim().toLowerCase()
      );
      if (String(order.status || '').toLowerCase() !== 'delivered') {
        throw new Error(
          `ORDER_NOT_DELIVERED: Order '${orderId}' must be in 'delivered' status before settlement allocation (current: '${order.status}').`
        );
      }
      if (!isCodOrder && order.payment_status !== 'PAID') {
        throw new Error(
          `ORDER_NOT_PAID: Online order '${orderId}' must be in 'PAID' payment status before settlement allocation (current: '${order.payment_status}').`
        );
      }

      // 3. Row-level lock on delivery_trip (if assigned)
      const tripRes = await client.query(`
        SELECT * FROM delivery_trips
        WHERE order_id = $1
        LIMIT 1
        FOR UPDATE
      `, [orderId]);

      const trip = tripRes.rows[0];
      const riderId = trip?.rider_id;

      // 4. Lock merchant contract and tax configuration FOR UPDATE to serialize subledger reads/writes
      const merchRes = await client.query(`
        SELECT * FROM merchants
        WHERE id = $1
        LIMIT 1
        FOR UPDATE
      `, [order.merchant_id]);

      if (merchRes.rows.length === 0) {
        throw new Error(`MERCHANT_NOT_FOUND: Merchant '${order.merchant_id}' does not exist.`);
      }

      const merchant = merchRes.rows[0];
      const commissionRateBn = toDecimal(merchant.commission_rate_percent || '15.00');

      // 5. Derive authoritative financial values from frozen pricing snapshot using BigNumber
      const snapshot = typeof order.pricing_snapshot === 'string'
        ? JSON.parse(order.pricing_snapshot)
        : order.pricing_snapshot || {};

      const sellerGoodsTaxableBn = toDecimal(snapshot.sellerGoodsBreakdown?.taxableAmount ?? order.taxable_amount ?? '0.00');
      const fallbackGoodsGstBn = subtract(
        add(order.cgst_amount || '0', order.sgst_amount || '0', order.igst_amount || '0'),
        snapshot.qcomFeesBreakdown?.totalGst || '0'
      );
      const sellerGoodsGstBn = toDecimal(
        snapshot.sellerGoodsBreakdown?.totalGst ?? snapshot.sellerGst ?? roundCurrency(fallbackGoodsGstBn)
      );
      const sellerGoodsTaxable = Number(roundCurrency(sellerGoodsTaxableBn));
      const sellerGoodsGst = Number(roundCurrency(sellerGoodsGstBn));
      const grossGmvBn = toDecimal(
        snapshot.sellerGoodsBreakdown?.totalSellerPayable ?? roundCurrency(add(sellerGoodsTaxableBn, sellerGoodsGstBn))
      );
      const grossGmv = Number(roundCurrency(grossGmvBn));

      // Sourced from effective-dated rules
      const platformCommissionStr = roundCurrency(multiply(sellerGoodsTaxableBn, divide(commissionRateBn, 100)));
      const platformCommission = Number(platformCommissionStr);

      // Resolve statutory commission GST rule (SAC 9983 @ 18%)
      const commTaxRule = await taxEngine.resolveServiceTaxRule('COMMISSION_GST', order.created_at, client);
      const commGstRateBn = toDecimal(commTaxRule.gst_rate_percent || '18.00');
      const commissionGstStr = roundCurrency(multiply(platformCommissionStr, divide(commGstRateBn, 100)));
      const commissionGst = Number(commissionGstStr);

      // Resolve Section 52 GST-TCS (0.50% on Net Taxable Supplies)
      const gstTcs = await taxEngine.resolveGstTcs({
        netTaxableSupplies: roundCurrency(sellerGoodsTaxableBn),
        isInterState: false,
        transactionDate: order.created_at,
        poolOverride: client,
      });
      const gstTcsAmount = Number(roundCurrency(gstTcs.totalTcsAmount || '0.00'));

      // Resolve Section 393 / 194-O Income-Tax Withholding
      const withholding = await taxEngine.resolveWithholding({
        grossTaxableAmount: roundCurrency(grossGmvBn),
        merchantConstitution: merchant.constitution_type || 'INDIVIDUAL',
        merchantPanStatus: merchant.pan_status || 'VALID_PAN',
        transactionDate: order.created_at,
        poolOverride: client,
      });
      const sellerTdsAmount = Number(roundCurrency(withholding.withholdingAmount || '0.00'));

      // Store preparation delay penalty (if store prep exceeded 5 mins SLA)
      let storeDelayPenalty = 0.00;
      if (merchant.base_prep_mins && merchant.base_prep_mins > 5) {
        storeDelayPenalty = Number(roundCurrency(multiply(merchant.base_prep_mins - 5, '1.20')));
      }

      // Net Seller Payable calculation
      const netSellerPayable = Number(
        roundCurrency(
          subtract(
            grossGmv,
            platformCommission,
            commissionGst,
            gstTcsAmount,
            sellerTdsAmount,
            storeDelayPenalty
          )
        )
      );

      // Customer fees
      const customerDeliveryFee = Number(roundCurrency(snapshot.qcomFeesBreakdown?.deliveryTaxable ?? order.delivery_fee ?? '0.00'));
      const deliveryFeeGst = Number(
        roundCurrency(
          snapshot.qcomFeesBreakdown?.deliveryGst ??
            (toDecimal(customerDeliveryFee).gt(0) ? roundCurrency(multiply(customerDeliveryFee, '0.18')) : '0.00')
        )
      );
      const customerHandlingFee = Number(roundCurrency(snapshot.qcomFeesBreakdown?.handlingTaxable ?? order.handling_fee ?? '0.00'));
      const handlingFeeGst = Number(
        roundCurrency(
          snapshot.qcomFeesBreakdown?.handlingGst ??
            (toDecimal(customerHandlingFee).gt(0) ? roundCurrency(multiply(customerHandlingFee, '0.18')) : '0.00')
        )
      );

      // Rider economics
      let grossRiderFare = 0.00;
      let customerTip = 0.00;
      let riderTdsAmount = 0.00;
      let netRiderPayable = 0.00;

      if (trip) {
        const grossRiderFareBn = add(
          trip.base_fare || '35.00',
          trip.distance_fare || '0.00',
          trip.surge_fare || '0.00',
          trip.wait_time_compensation || '0.00'
        );
        grossRiderFare = Number(roundCurrency(grossRiderFareBn));

        // 100% tip pass-through with zero platform haircut
        customerTip = Number(roundCurrency(trip.tip_amount || '0.00'));

        // Rider logistics withholding (1% for PAN, 20% for Non-PAN)
        const riderRes = riderId
          ? await client.query(`SELECT * FROM riders WHERE id = $1 FOR UPDATE`, [riderId])
          : { rows: [] };
        const rider = riderRes.rows[0];
        const isRiderPanValid = rider?.pan_status === 'VALID_PAN';
        const riderTdsRate = isRiderPanValid ? '0.01' : '0.20';
        riderTdsAmount = Number(roundCurrency(multiply(grossRiderFare, riderTdsRate)));

        netRiderPayable = Number(roundCurrency(subtract(add(grossRiderFare, customerTip), riderTdsAmount)));
      }

      const platformSubsidy = Number(roundCurrency(BigNumber.max(0, subtract(grossRiderFare, customerDeliveryFee))));

      // Total customer escrow liability released upon fulfillment
      const orderTotal = Number(
        roundCurrency(
          add(
            grossGmv,
            customerDeliveryFee,
            deliveryFeeGst,
            customerHandlingFee,
            handlingFeeGst,
            customerTip
          )
        )
      );

      // 6. Post atomic double-entry general ledger batch
      const journalBatchId = await ledgerService.recordOrderFulfillmentAllocation({
        orderId,
        merchantId: order.merchant_id,
        riderId,
        orderTotal,
        netSellerPayable,
        grossRiderFare,
        netRiderPayable,
        riderTdsAmount,
        platformCommission,
        commissionGst,
        customerDeliveryFee,
        deliveryFeeGst,
        customerHandlingFee,
        handlingFeeGst,
        storeDelayPenalty,
        gstTcsAmount,
        sellerTdsAmount,
        client,
      });

      // 7. Post Subledger entries for Merchant (seller_ledgers) under merchant FOR UPDATE lock
      const prevMerchantBalRes = await client.query(`
        SELECT running_balance FROM seller_ledgers
        WHERE merchant_id = $1
        ORDER BY created_at DESC, seq_no DESC
        LIMIT 1
      `, [order.merchant_id]);
      const currentMerchBalBn = prevMerchantBalRes.rows.length > 0 ? toDecimal(prevMerchantBalRes.rows[0].running_balance) : new BigNumber(0);
      const updatedMerchBal = Number(roundCurrency(currentMerchBalBn.plus(toDecimal(netSellerPayable))));

      // Reconcile GL Account 1040 clawback receivable against Account 2020 payable if merchant had negative balance
      if (currentMerchBalBn.lt(0) && toDecimal(netSellerPayable).gt(0)) {
        const offsetAmount = Number(roundCurrency(BigNumber.min(currentMerchBalBn.abs(), toDecimal(netSellerPayable))));
        if (offsetAmount > 0) {
          await ledgerService.recordClawbackOffset({
            merchantId: order.merchant_id,
            orderId,
            amount: offsetAmount,
            reference: orderId,
            client,
          });
        }
      }

      await client.query(`
        INSERT INTO seller_ledgers (
          merchant_id, order_id, entry_type, category, amount, running_balance, description
        )
        VALUES ($1, $2, 'ORDER_CREDIT', 'CREDIT', $3, $4, $5)
      `, [
        order.merchant_id,
        orderId,
        netSellerPayable,
        updatedMerchBal,
        `Net payable credit for fulfilled order ${order.order_number || orderId}`,
      ]);

      // 8. Post Subledger entries for Rider (rider_ledgers) and update wallet balance
      if (riderId && trip) {
        const prevRiderBalRes = await client.query(`
          SELECT running_balance FROM rider_ledgers
          WHERE rider_id = $1
          ORDER BY created_at DESC, seq_no DESC
          LIMIT 1
        `, [riderId]);
        const currentRiderBalBn = prevRiderBalRes.rows.length > 0 ? toDecimal(prevRiderBalRes.rows[0].running_balance) : new BigNumber(0);
        const updatedRiderBal = Number(roundCurrency(currentRiderBalBn.plus(toDecimal(netRiderPayable))));

        await client.query(`
          INSERT INTO rider_ledgers (
            rider_id, trip_id, entry_type, category, amount, running_balance, description
          )
          VALUES ($1, $2, 'DELIVERY_FARE', 'CREDIT', $3, $4, $5)
        `, [
          riderId,
          trip.id,
          netRiderPayable,
          updatedRiderBal,
          `Logistics fare and tip credit for completed delivery of order ${order.order_number || orderId}`,
        ]);

        // Update rider's wallet balance
        const grossPlusTip = Number(roundCurrency(add(grossRiderFare, customerTip)));
        await client.query(`
          UPDATE riders
          SET wallet_balance = wallet_balance + $2,
              fy_gross_payout_inr = fy_gross_payout_inr + $3,
              updated_at = NOW()
          WHERE id = $1
        `, [riderId, netRiderPayable, grossPlusTip]);

        // Handle Cash on Delivery floating cash liability
        if (isCodOrder) {
          const codAmount = orderTotal;
          await client.query(`
            UPDATE riders
            SET floating_cash_balance = floating_cash_balance + $2,
                status = CASE WHEN (floating_cash_balance + $2) >= floating_cash_limit THEN 'SUSPENDED' ELSE status END,
                updated_at = NOW()
            WHERE id = $1
          `, [riderId, codAmount]);

          await client.query(`
            UPDATE delivery_trips
            SET cod_due_amount = $2,
                cod_collected_amount = $2,
                cod_reconciled = TRUE
            WHERE id = $1
          `, [trip.id, codAmount]);

          // Record COD collection in ledger
          await ledgerService.recordCodCollection({
            orderId,
            merchantId: order.merchant_id,
            riderId,
            amount: codAmount,
            client,
          });
        }
      }

      // 9. Persist authoritative settlement allocation snapshot
      const insRes = await client.query(`
        INSERT INTO order_settlement_allocations (
          order_id, merchant_id, rider_id, trip_id, journal_batch_id,
          order_total, gross_gmv, seller_goods_taxable, seller_goods_gst,
          platform_commission, commission_gst, gst_tcs_amount, seller_tds_amount,
          store_delay_penalty, net_seller_payable, customer_delivery_fee, customer_handling_fee,
          gross_rider_fare, customer_tip, rider_tds_amount, net_rider_payable, platform_subsidy, status
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, 'ALLOCATED')
        RETURNING *
      `, [
        orderId,
        order.merchant_id,
        riderId || null,
        trip?.id || null,
        journalBatchId,
        orderTotal,
        grossGmv,
        sellerGoodsTaxable,
        sellerGoodsGst,
        platformCommission,
        commissionGst,
        gstTcsAmount,
        sellerTdsAmount,
        storeDelayPenalty,
        netSellerPayable,
        customerDeliveryFee,
        customerHandlingFee,
        grossRiderFare,
        customerTip,
        riderTdsAmount,
        netRiderPayable,
        platformSubsidy,
      ]);

      const a = insRes.rows[0];

      // 10. Stage Post-Commit Domain Events
      stagedEvents.push(
        settlementEventPublisher.createEvent('OrderSettlementAllocated', {
          orderId,
          merchantId: order.merchant_id,
          riderId,
          netSellerPayable,
          netRiderPayable,
          journalBatchId,
        }),
        settlementEventPublisher.createEvent('SellerSettlementEligible', {
          merchantId: order.merchant_id,
          orderId,
          amount: netSellerPayable,
        })
      );

      if (riderId) {
        stagedEvents.push(
          settlementEventPublisher.createEvent('RiderEarningFrozen', {
            riderId,
            orderId,
            grossFare: grossRiderFare,
            tips: customerTip,
            tds: riderTdsAmount,
            netPayable: netRiderPayable,
          })
        );
      }

      return {
        id: a.id,
        orderId: a.order_id,
        merchantId: a.merchant_id,
        riderId: a.rider_id,
        tripId: a.trip_id,
        journalBatchId: a.journal_batch_id,
        orderTotal: parseFloat(a.order_total),
        grossGmv: parseFloat(a.gross_gmv),
        sellerGoodsTaxable: parseFloat(a.seller_goods_taxable),
        sellerGoodsGst: parseFloat(a.seller_goods_gst),
        platformCommission: parseFloat(a.platform_commission),
        commissionGst: parseFloat(a.commission_gst),
        gstTcsAmount: parseFloat(a.gst_tcs_amount),
        sellerTdsAmount: parseFloat(a.seller_tds_amount),
        storeDelayPenalty: parseFloat(a.store_delay_penalty),
        netSellerPayable: parseFloat(a.net_seller_payable),
        customerDeliveryFee: parseFloat(a.customer_delivery_fee),
        customerHandlingFee: parseFloat(a.customer_handling_fee),
        grossRiderFare: parseFloat(a.gross_rider_fare),
        customerTip: parseFloat(a.customer_tip),
        riderTdsAmount: parseFloat(a.rider_tds_amount),
        netRiderPayable: parseFloat(a.net_rider_payable),
        platformSubsidy: parseFloat(a.platform_subsidy),
        status: a.status,
        allocatedAt: a.allocated_at.toISOString(),
      };
    };

    const result = clientOverride ? await execute(clientOverride) : await transaction(execute);

    // Publish staged events strictly post-commit
    if (stagedEvents.length > 0) {
      settlementEventPublisher.publishAll(stagedEvents);
    }

    return result;
  }
}

export const settlementAllocationService = new SettlementAllocationService();
