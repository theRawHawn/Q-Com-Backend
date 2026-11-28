import crypto from 'crypto';
import pg from 'pg';
import BigNumber from 'bignumber.js';
import { getPool, transaction } from '../../database/connection.js';
import { env } from '../../config/env.js';
import { InvoiceData, CreditNoteData } from './invoiceTypes.js';
import { toDecimal, roundCurrency, add, divide, multiply, subtract } from '../pricing/money.js';
import { taxEngine } from '../pricing/taxEngine.js';

export function computeIndianFinancialYear(dateInput: Date | string = new Date()): string {
  const d = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth(); // 0 = Jan, 3 = Apr
  const fyStart = month >= 3 ? year : year - 1;
  const fyEndShort = String((fyStart + 1) % 100).padStart(2, '0');
  return `${fyStart}-${fyEndShort}`;
}

export class InvoiceService {
  /**
   * Computes honest e-Invoicing state: NEVER fabricates NIC IRP IRNs locally.
   * When EINVOICING_ENABLED=false, irn is null and eInvoicingStatus='NOT_APPLICABLE'.
   * When EINVOICING_ENABLED=true without IRP registration response, irn remains null with 'PENDING_IRP'.
   */
  public resolveEInvoicingState(): { irn: string | null; eInvoicingStatus: string } {
    return env.EINVOICING_ENABLED
      ? { irn: null, eInvoicingStatus: 'PENDING_IRP' }
      : { irn: null, eInvoicingStatus: 'NOT_APPLICABLE' };
  }

  /**
   * Generates or retrieves statutory GST invoices for an order
   */
  public async getOrCreateOrderInvoices(orderId: string, clientOverride?: pg.PoolClient): Promise<InvoiceData[]> {
    const runner: pg.Pool | pg.PoolClient = clientOverride || getPool();

    const existingRes = await runner.query(
      `SELECT * FROM invoices WHERE order_id = $1 ORDER BY created_at ASC`,
      [orderId]
    );

    if (existingRes.rows.length > 0) {
      const invoices: InvoiceData[] = [];
      for (const inv of existingRes.rows) {
        const lineItemsRes = await runner.query(
          `SELECT * FROM invoice_line_items WHERE invoice_id = $1`,
          [inv.id]
        );
        const posName = inv.place_of_supply_state_code
          ? await taxEngine.getStateName(inv.place_of_supply_state_code, runner)
          : null;

        invoices.push({
          id: inv.id,
          invoiceNumber: inv.invoice_number,
          orderId: inv.order_id,
          invoiceType: inv.invoice_type,
          irn: inv.irn ?? null,
          eInvoicingStatus: inv.e_invoicing_status || 'NOT_APPLICABLE',
          qrData: inv.qr_data,
          sellerGstin: inv.seller_gstin || undefined,
          sellerLegalName: inv.seller_legal_name || undefined,
          customerGstin: inv.customer_gstin || undefined,
          customerBusinessName: inv.customer_business_name || undefined,
          placeOfSupplyStateCode: inv.place_of_supply_state_code || undefined,
          placeOfSupplyStateName: posName || undefined,
          supplierStateCode: inv.supplier_state_code || undefined,
          isInterState: Boolean(inv.is_inter_state),
          financialYear: inv.financial_year || undefined,
          discountAmount: parseFloat(inv.discount_amount || '0'),
          taxableAmount: parseFloat(inv.taxable_amount),
          cgstAmount: parseFloat(inv.cgst_amount),
          sgstAmount: parseFloat(inv.sgst_amount),
          igstAmount: parseFloat(inv.igst_amount),
          cessAmount: parseFloat(inv.cess_amount || '0'),
          totalAmount: parseFloat(inv.total_amount),
          issuedAt: inv.issued_at?.toISOString() || new Date().toISOString(),
          items: lineItemsRes.rows.map(l => ({
            description: l.item_description,
            hsnSacCode: l.hsn_sac_code,
            quantity: l.quantity,
            unitPrice: parseFloat(l.unit_price),
            discountAmount: parseFloat(l.discount_amount || '0'),
            taxableValue: parseFloat(l.taxable_value),
            gstRatePercent: parseFloat(l.gst_rate_percent),
            cgstAmount: parseFloat(l.cgst_amount),
            sgstAmount: parseFloat(l.sgst_amount),
            igstAmount: parseFloat(l.igst_amount),
            cessAmount: parseFloat(l.cess_amount || '0'),
            taxInclusive: Boolean(l.tax_inclusive),
            totalAmount: parseFloat(l.total_line_amount),
          })),
        });
      }
      return invoices;
    }

    const orderRes = await runner.query(
      `SELECT o.*, m.name as merchant_name, m.business_name as merchant_business_name,
              m.gstin as merchant_gstin, m.state_code as merchant_state_code
         FROM orders o
         JOIN merchants m ON o.merchant_id = m.id
        WHERE o.id = $1
        LIMIT 1`,
      [orderId]
    );

    if (orderRes.rows.length === 0) {
      throw new Error(`Order ${orderId} not found.`);
    }

    const o = orderRes.rows[0];
    const itemsRes = await runner.query(`SELECT * FROM order_items WHERE order_id = $1`, [orderId]);
    const snapshot = typeof o.pricing_snapshot === 'string'
      ? JSON.parse(o.pricing_snapshot)
      : o.pricing_snapshot || {};

    const sellerGstin: string | null = o.merchant_gstin ? String(o.merchant_gstin).trim() : null;
    const sellerName: string = o.merchant_business_name || o.merchant_name || 'Authorized Trade Partner';
    const sellerStateCode: string | null = o.merchant_state_code || snapshot.merchantStateCode || null;
    const placeOfSupplyStateCode: string | null =
      o.place_of_supply_state_code || snapshot.placeOfSupplyStateCode || sellerStateCode;

    const qcomGstin: string | null = env.QCOM_GSTIN || null;
    const qcomLegalName: string = env.QCOM_LEGAL_NAME;
    const qcomStateCode: string | null = env.QCOM_STATE_CODE || sellerStateCode;

    const sellerInterState = Boolean(
      sellerStateCode && placeOfSupplyStateCode && sellerStateCode !== placeOfSupplyStateCode
    );
    const qcomInterState = Boolean(
      qcomStateCode && placeOfSupplyStateCode && qcomStateCode !== placeOfSupplyStateCode
    );

    const txnDate = o.placed_at || o.created_at || new Date();
    const financialYear = computeIndianFinancialYear(txnDate);
    const { irn, eInvoicingStatus } = this.resolveEInvoicingState();

    const invSellerNumber = `INV-SLR-${String(o.order_number || orderId).replace('QC-', '')}`;
    const invQcomNumber = `INV-QCOM-${String(o.order_number || orderId).replace('QC-', '')}`;

    // Bucket A: Seller Goods breakdown (use authoritative snapshot bucket if available)
    const sellerTaxableStr = roundCurrency(
      snapshot.sellerGoodsBreakdown?.taxableAmount ?? o.taxable_amount ?? '0.00'
    );
    const sellerCgstStr = roundCurrency(
      snapshot.sellerGoodsBreakdown?.cgstAmount ?? o.cgst_amount ?? '0.00'
    );
    const sellerSgstStr = roundCurrency(
      snapshot.sellerGoodsBreakdown?.sgstAmount ?? o.sgst_amount ?? '0.00'
    );
    const sellerIgstStr = roundCurrency(
      snapshot.sellerGoodsBreakdown?.igstAmount ?? o.igst_amount ?? '0.00'
    );
    const sellerCessStr = roundCurrency(
      snapshot.sellerGoodsBreakdown?.cessAmount ?? o.cess_amount ?? '0.00'
    );
    const sellerDiscountStr = roundCurrency(
      snapshot.sellerGoodsBreakdown?.discountAmount ?? o.discount_amount ?? '0.00'
    );
    const sellerTotalStr = roundCurrency(
      snapshot.sellerGoodsBreakdown?.totalSellerPayable ??
      add(sellerTaxableStr, sellerCgstStr, sellerSgstStr, sellerIgstStr, sellerCessStr)
    );

    const sellerQrData = [
      `SUPPLIER:${sellerName}`,
      sellerGstin ? `GSTIN:${sellerGstin}` : 'GSTIN:UNREGISTERED',
      `INV:${invSellerNumber}`,
      `FY:${financialYear}`,
      `POS:${placeOfSupplyStateCode || 'N/A'}`,
      `EINV:${eInvoicingStatus}`,
    ].join('|');

    const qcomQrData = [
      `SUPPLIER:${qcomLegalName}`,
      qcomGstin ? `GSTIN:${qcomGstin}` : 'GSTIN:NOT_CONFIGURED',
      `INV:${invQcomNumber}`,
      `FY:${financialYear}`,
      `POS:${placeOfSupplyStateCode || 'N/A'}`,
      `EINV:${eInvoicingStatus}`,
    ].join('|');

    // Bucket B: QCOM Platform Service Invoice (Read frozen pricing snapshot charges first; fail closed on missing tax rule)
    const deliveryFeeBn = toDecimal(o.delivery_fee || '0.00');
    const handlingFeeBn = toDecimal(o.handling_fee || '0.00');
    const qcomTaxableBn = add(deliveryFeeBn, handlingFeeBn);
    const snapshotCharges: any[] = Array.isArray(snapshot.charges) ? snapshot.charges : [];
    const snapDelivery = snapshotCharges.find((c) => c.chargeType === 'DELIVERY');
    const snapHandling = snapshotCharges.find((c) => c.chargeType === 'HANDLING');

    let deliveryLineCalc = {
      gstRatePercent: snapDelivery?.gstRatePercent ?? '0.00',
      cgstAmount: snapDelivery?.cgstAmount ?? '0.00',
      sgstAmount: snapDelivery?.sgstAmount ?? '0.00',
      igstAmount: snapDelivery?.igstAmount ?? '0.00',
      totalGstAmount: snapDelivery
        ? roundCurrency(
            snapDelivery.taxAmount ??
              snapDelivery.totalGstAmount ??
              add(snapDelivery.cgstAmount ?? '0', snapDelivery.sgstAmount ?? '0', snapDelivery.igstAmount ?? '0')
          )
        : '0.00',
      sacCode: snapDelivery?.sacCode ?? '996813',
    };
    let handlingLineCalc = {
      gstRatePercent: snapHandling?.gstRatePercent ?? '0.00',
      cgstAmount: snapHandling?.cgstAmount ?? '0.00',
      sgstAmount: snapHandling?.sgstAmount ?? '0.00',
      igstAmount: snapHandling?.igstAmount ?? '0.00',
      totalGstAmount: snapHandling
        ? roundCurrency(
            snapHandling.taxAmount ??
              snapHandling.totalGstAmount ??
              add(snapHandling.cgstAmount ?? '0', snapHandling.sgstAmount ?? '0', snapHandling.igstAmount ?? '0')
          )
        : '0.00',
      sacCode: snapHandling?.sacCode ?? '998319',
    };

    if (deliveryFeeBn.gt(0) && !snapDelivery) {
      if (!qcomStateCode || !placeOfSupplyStateCode) {
        throw new Error(`MISSING_TAX_JURISDICTION: Cannot compute delivery fee GST for order ${orderId} without supplier and place-of-supply state codes.`);
      }
      const rule = await taxEngine.resolveServiceTaxRule('DELIVERY_GST', new Date(txnDate), runner);
      const calc = taxEngine.calculateGst({
        taxableAmount: deliveryFeeBn,
        taxRule: rule,
        merchantStateCode: qcomStateCode,
        placeOfSupplyStateCode,
      });
      deliveryLineCalc = {
        gstRatePercent: calc.gstRatePercent,
        cgstAmount: calc.cgstAmount,
        sgstAmount: calc.sgstAmount,
        igstAmount: calc.igstAmount,
        totalGstAmount: calc.totalGstAmount,
        sacCode: rule.hsn_or_sac_code,
      };
    }

    if (handlingFeeBn.gt(0) && !snapHandling) {
      if (!qcomStateCode || !placeOfSupplyStateCode) {
        throw new Error(`MISSING_TAX_JURISDICTION: Cannot compute handling fee GST for order ${orderId} without supplier and place-of-supply state codes.`);
      }
      const rule = await taxEngine.resolveServiceTaxRule('HANDLING_GST', new Date(txnDate), runner);
      const calc = taxEngine.calculateGst({
        taxableAmount: handlingFeeBn,
        taxRule: rule,
        merchantStateCode: qcomStateCode,
        placeOfSupplyStateCode,
      });
      handlingLineCalc = {
        gstRatePercent: calc.gstRatePercent,
        cgstAmount: calc.cgstAmount,
        sgstAmount: calc.sgstAmount,
        igstAmount: calc.igstAmount,
        totalGstAmount: calc.totalGstAmount,
        sacCode: rule.hsn_or_sac_code,
      };
    }

    const qcomCgstStr = roundCurrency(add(deliveryLineCalc.cgstAmount, handlingLineCalc.cgstAmount));
    const qcomSgstStr = roundCurrency(add(deliveryLineCalc.sgstAmount, handlingLineCalc.sgstAmount));
    const qcomIgstStr = roundCurrency(add(deliveryLineCalc.igstAmount, handlingLineCalc.igstAmount));
    const qcomTotalStr = roundCurrency(add(qcomTaxableBn, qcomCgstStr, qcomSgstStr, qcomIgstStr));

    const writeInvoices = async (client: pg.PoolClient) => {
      // 1. Seller Goods Tax Invoice (Form GST INV-1)
      const insSellerInv = await client.query(
        `INSERT INTO invoices (
          invoice_number, order_id, invoice_type, irn, e_invoicing_status, qr_data,
          seller_gstin, seller_legal_name, customer_gstin, customer_business_name,
          place_of_supply_state_code, supplier_state_code, is_inter_state, financial_year,
          discount_amount, taxable_amount, cgst_amount, sgst_amount, igst_amount, cess_amount, total_amount
        )
        VALUES ($1, $2, 'SELLER_TAX_INVOICE', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
        RETURNING id`,
        [
          invSellerNumber,
          orderId,
          irn,
          eInvoicingStatus,
          sellerQrData,
          sellerGstin,
          sellerName,
          o.customer_gstin || null,
          o.customer_business_name || null,
          placeOfSupplyStateCode,
          sellerStateCode,
          sellerInterState,
          financialYear,
          sellerDiscountStr,
          sellerTaxableStr,
          sellerCgstStr,
          sellerSgstStr,
          sellerIgstStr,
          sellerCessStr,
          sellerTotalStr,
        ]
      );

      const sellerInvId = insSellerInv.rows[0].id;
      for (const it of itemsRes.rows) {
        const linePayable =
          it.line_total_payable !== null && it.line_total_payable !== undefined
            ? roundCurrency(it.line_total_payable)
            : roundCurrency(
                add(
                  it.taxable_amount || '0',
                  it.cgst_amount || '0',
                  it.sgst_amount || '0',
                  it.igst_amount || '0',
                  it.cess_amount || '0'
                )
              );

        await client.query(
          `INSERT INTO invoice_line_items (
            invoice_id, item_description, hsn_sac_code, quantity, unit_price,
            discount_amount, taxable_value, gst_rate_percent, cgst_amount, sgst_amount, igst_amount,
            cess_amount, tax_inclusive, total_line_amount
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [
            sellerInvId,
            it.product_name,
            it.hsn_code,
            it.quantity,
            it.unit_price,
            roundCurrency(it.discount_amount || '0.00'),
            roundCurrency(it.taxable_amount || '0.00'),
            it.gst_rate_percent,
            roundCurrency(it.cgst_amount || '0.00'),
            roundCurrency(it.sgst_amount || '0.00'),
            roundCurrency(it.igst_amount || '0.00'),
            roundCurrency(it.cess_amount || '0.00'),
            Boolean(it.tax_inclusive),
            linePayable,
          ]
        );
      }

      // 2. QCOM Platform & Delivery Tax Invoice
      const insQcomInv = await client.query(
        `INSERT INTO invoices (
          invoice_number, order_id, invoice_type, irn, e_invoicing_status, qr_data,
          seller_gstin, seller_legal_name, customer_gstin, customer_business_name,
          place_of_supply_state_code, supplier_state_code, is_inter_state, financial_year,
          discount_amount, taxable_amount, cgst_amount, sgst_amount, igst_amount, cess_amount, total_amount
        )
        VALUES ($1, $2, 'QCOM_PLATFORM_INVOICE', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 0.00, $14, $15, $16, $17, 0.00, $18)
        RETURNING id`,
        [
          invQcomNumber,
          orderId,
          irn,
          eInvoicingStatus,
          qcomQrData,
          qcomGstin,
          qcomLegalName,
          o.customer_gstin || null,
          o.customer_business_name || null,
          placeOfSupplyStateCode,
          qcomStateCode,
          qcomInterState,
          financialYear,
          roundCurrency(qcomTaxableBn),
          qcomCgstStr,
          qcomSgstStr,
          qcomIgstStr,
          qcomTotalStr,
        ]
      );

      const qcomInvId = insQcomInv.rows[0].id;
      if (deliveryFeeBn.gt(0)) {
        const delFeeStr = roundCurrency(deliveryFeeBn);
        const delTotal = roundCurrency(add(deliveryFeeBn, deliveryLineCalc.totalGstAmount));
        await client.query(
          `INSERT INTO invoice_line_items (
            invoice_id, item_description, hsn_sac_code, quantity, unit_price,
            discount_amount, taxable_value, gst_rate_percent, cgst_amount, sgst_amount, igst_amount,
            cess_amount, tax_inclusive, total_line_amount
          )
          VALUES ($1, 'Rapid Hyperlocal Dispatch & Courier Transport', $2, 1, $3, 0.00, $4, $5, $6, $7, $8, 0.00, FALSE, $9)`,
          [
            qcomInvId,
            deliveryLineCalc.sacCode,
            delFeeStr,
            delFeeStr,
            deliveryLineCalc.gstRatePercent,
            deliveryLineCalc.cgstAmount,
            deliveryLineCalc.sgstAmount,
            deliveryLineCalc.igstAmount,
            delTotal,
          ]
        );
      }

      if (handlingFeeBn.gt(0)) {
        const handFeeStr = roundCurrency(handlingFeeBn);
        const handTotal = roundCurrency(add(handlingFeeBn, handlingLineCalc.totalGstAmount));
        await client.query(
          `INSERT INTO invoice_line_items (
            invoice_id, item_description, hsn_sac_code, quantity, unit_price,
            discount_amount, taxable_value, gst_rate_percent, cgst_amount, sgst_amount, igst_amount,
            cess_amount, tax_inclusive, total_line_amount
          )
          VALUES ($1, 'Site Logistics Handling & Staging Charge', $2, 1, $3, 0.00, $4, $5, $6, $7, $8, 0.00, FALSE, $9)`,
          [
            qcomInvId,
            handlingLineCalc.sacCode,
            handFeeStr,
            handFeeStr,
            handlingLineCalc.gstRatePercent,
            handlingLineCalc.cgstAmount,
            handlingLineCalc.sgstAmount,
            handlingLineCalc.igstAmount,
            handTotal,
          ]
        );
      }
    };

    if (clientOverride) {
      await writeInvoices(clientOverride);
    } else {
      await transaction(writeInvoices);
    }

    return this.getOrCreateOrderInvoices(orderId, clientOverride);
  }

  /**
   * Issues a formal GST Credit Note (Section 34 CGST Act) for an accepted return.
   * Idempotent per returnId; safely links parent SELLER_TAX_INVOICE when already issued.
   */
  public async issueCreditNoteForReturn(params: {
    orderId: string;
    returnId: string;
    refundId?: string | null;
    reasonCode: string;
    clientOverride?: pg.PoolClient;
  }): Promise<CreditNoteData | null> {
    const execute = async (client: pg.PoolClient): Promise<CreditNoteData | null> => {
      // Idempotency check
      const existingCn = await client.query(
        `SELECT * FROM credit_notes WHERE return_id = $1 AND credit_note_type = 'SELLER_CREDIT_NOTE' LIMIT 1`,
        [params.returnId]
      );
      if (existingCn.rows.length > 0) {
        return this.mapCreditNoteRow(existingCn.rows[0], client);
      }

      const orderRes = await client.query(
        `SELECT o.*, m.name as merchant_name, m.business_name as merchant_business_name,
                m.gstin as merchant_gstin, m.state_code as merchant_state_code
           FROM orders o
           JOIN merchants m ON o.merchant_id = m.id
          WHERE o.id = $1
          LIMIT 1`,
        [params.orderId]
      );
      if (orderRes.rows.length === 0) return null;
      const o = orderRes.rows[0];

      const passedItemsRes = await client.query(
        `SELECT ori.id AS return_item_id, ori.order_item_id, ori.quantity AS return_qty,
                oi.product_name, oi.hsn_code, oi.quantity AS orig_qty,
                oi.taxable_amount, oi.gst_rate_percent, oi.cgst_amount, oi.sgst_amount,
                oi.igst_amount, COALESCE(oi.cess_amount, 0) AS cess_amount,
                oi.line_total_payable, oi.total_price
           FROM order_return_items ori
           JOIN order_items oi ON ori.order_item_id = oi.id
          WHERE ori.return_id = $1 AND ori.qc_status = 'PASSED'`,
        [params.returnId]
      );

      if (passedItemsRes.rows.length === 0) {
        return null;
      }

      let sellerInvRes = await client.query(
        `SELECT id FROM invoices WHERE order_id = $1 AND invoice_type = 'SELLER_TAX_INVOICE' LIMIT 1`,
        [params.orderId]
      );
      if (sellerInvRes.rows.length === 0) {
        await this.getOrCreateOrderInvoices(params.orderId, client);
        sellerInvRes = await client.query(
          `SELECT id FROM invoices WHERE order_id = $1 AND invoice_type = 'SELLER_TAX_INVOICE' LIMIT 1`,
          [params.orderId]
        );
      }
      const sellerInvId: string | null = sellerInvRes.rows[0]?.id || null;

      const sellerStateCode: string | null = o.merchant_state_code || null;
      const posStateCode: string | null = o.place_of_supply_state_code || sellerStateCode;
      const isInterState = Boolean(sellerStateCode && posStateCode && sellerStateCode !== posStateCode);
      const financialYear = computeIndianFinancialYear(new Date());
      const { irn, eInvoicingStatus } = this.resolveEInvoicingState();

      const cnSeq = crypto.randomBytes(3).toString('hex').toUpperCase();
      const creditNoteNumber = `CN-${financialYear}-${String(o.order_number || params.orderId).replace('QC-', '')}-${cnSeq}`;

      let sumTaxableBn = new BigNumber(0);
      let sumCgstBn = new BigNumber(0);
      let sumSgstBn = new BigNumber(0);
      let sumIgstBn = new BigNumber(0);
      let sumCessBn = new BigNumber(0);
      let sumTotalBn = new BigNumber(0);

      const linePayloads: {
        orderItemId: string;
        description: string;
        hsnSacCode: string;
        quantity: number;
        taxableValue: string;
        gstRatePercent: string;
        cgstAmount: string;
        sgstAmount: string;
        igstAmount: string;
        cessAmount: string;
        totalLineAmount: string;
      }[] = [];

      for (const row of passedItemsRes.rows) {
        const origQty = Math.max(1, parseInt(row.orig_qty, 10));
        const retQty = Math.max(1, parseInt(row.return_qty, 10));
        const ratio = divide(retQty, origQty);

        const baseTaxable =
          row.taxable_amount !== null && row.taxable_amount !== undefined
            ? toDecimal(row.taxable_amount)
            : toDecimal(row.line_total_payable ?? row.total_price ?? '0');
        const baseCgst = toDecimal(row.cgst_amount || '0');
        const baseSgst = toDecimal(row.sgst_amount || '0');
        const baseIgst = toDecimal(row.igst_amount || '0');
        const baseCess = toDecimal(row.cess_amount || '0');

        const priorCnRes = await client.query(
          `SELECT COALESCE(SUM(cnl.quantity), 0) AS prior_qty,
                  COALESCE(SUM(cnl.taxable_value), 0) AS prior_taxable,
                  COALESCE(SUM(cnl.cgst_amount), 0) AS prior_cgst,
                  COALESCE(SUM(cnl.sgst_amount), 0) AS prior_sgst,
                  COALESCE(SUM(cnl.igst_amount), 0) AS prior_igst,
                  COALESCE(SUM(cnl.cess_amount), 0) AS prior_cess
             FROM credit_note_line_items cnl
             JOIN credit_notes cn ON cnl.credit_note_id = cn.id
            WHERE cnl.order_item_id = $1
              AND cn.order_id = $2`,
          [row.order_item_id, params.orderId]
        );
        const prior = priorCnRes.rows[0] || {};
        const priorQty = parseInt(String(prior.prior_qty || '0'), 10);
        const isFinalItemReturn = priorQty + retQty >= origQty;

        const clampComponent = (totalBn: BigNumber, priorVal: any) => {
          const remainingBn = BigNumber.max(0, totalBn.minus(toDecimal(priorVal || '0')));
          if (isFinalItemReturn) {
            return roundCurrency(remainingBn);
          }
          return roundCurrency(BigNumber.min(remainingBn, toDecimal(roundCurrency(multiply(totalBn, ratio)))));
        };

        const lineTaxable = clampComponent(baseTaxable, prior.prior_taxable);
        const lineCgst = clampComponent(baseCgst, prior.prior_cgst);
        const lineSgst = clampComponent(baseSgst, prior.prior_sgst);
        const lineIgst = clampComponent(baseIgst, prior.prior_igst);
        const lineCess = clampComponent(baseCess, prior.prior_cess);
        const lineTotal = roundCurrency(add(lineTaxable, lineCgst, lineSgst, lineIgst, lineCess));

        sumTaxableBn = add(sumTaxableBn, lineTaxable);
        sumCgstBn = add(sumCgstBn, lineCgst);
        sumSgstBn = add(sumSgstBn, lineSgst);
        sumIgstBn = add(sumIgstBn, lineIgst);
        sumCessBn = add(sumCessBn, lineCess);
        sumTotalBn = add(sumTotalBn, lineTotal);

        linePayloads.push({
          orderItemId: row.order_item_id,
          description: row.product_name,
          hsnSacCode: row.hsn_code || '0000',
          quantity: retQty,
          taxableValue: lineTaxable,
          gstRatePercent: toDecimal(row.gst_rate_percent || '0').toFixed(2),
          cgstAmount: lineCgst,
          sgstAmount: lineSgst,
          igstAmount: lineIgst,
          cessAmount: lineCess,
          totalLineAmount: lineTotal,
        });
      }

      const insCnRes = await client.query(
        `INSERT INTO credit_notes (
          credit_note_number, invoice_id, order_id, return_id, refund_id,
          credit_note_type, reason_code, seller_gstin, seller_legal_name,
          customer_gstin, customer_business_name, place_of_supply_state_code,
          supplier_state_code, is_inter_state, financial_year, irn, e_invoicing_status,
          taxable_amount, cgst_amount, sgst_amount, igst_amount, cess_amount, total_amount
        )
        VALUES ($1, $2, $3, $4, $5, 'SELLER_CREDIT_NOTE', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
        RETURNING *`,
        [
          creditNoteNumber,
          sellerInvId,
          params.orderId,
          params.returnId,
          params.refundId || null,
          params.reasonCode,
          o.merchant_gstin ? String(o.merchant_gstin).trim() : null,
          o.merchant_business_name || o.merchant_name || 'Authorized Trade Partner',
          o.customer_gstin || null,
          o.customer_business_name || null,
          posStateCode,
          sellerStateCode,
          isInterState,
          financialYear,
          irn,
          eInvoicingStatus,
          roundCurrency(sumTaxableBn),
          roundCurrency(sumCgstBn),
          roundCurrency(sumSgstBn),
          roundCurrency(sumIgstBn),
          roundCurrency(sumCessBn),
          roundCurrency(sumTotalBn),
        ]
      );

      const cnRow = insCnRes.rows[0];
      for (const lp of linePayloads) {
        await client.query(
          `INSERT INTO credit_note_line_items (
            credit_note_id, order_item_id, item_description, hsn_sac_code, quantity,
            taxable_value, gst_rate_percent, cgst_amount, sgst_amount, igst_amount, cess_amount, total_line_amount
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            cnRow.id,
            lp.orderItemId,
            lp.description,
            lp.hsnSacCode,
            lp.quantity,
            lp.taxableValue,
            lp.gstRatePercent,
            lp.cgstAmount,
            lp.sgstAmount,
            lp.igstAmount,
            lp.cessAmount,
            lp.totalLineAmount,
          ]
        );
      }

      return this.mapCreditNoteRow(cnRow, client);
    };

    if (params.clientOverride) {
      return execute(params.clientOverride);
    }
    return transaction(execute);
  }

  private async mapCreditNoteRow(cn: any, runner: pg.Pool | pg.PoolClient): Promise<CreditNoteData> {
    const lineRes = await runner.query(
      `SELECT * FROM credit_note_line_items WHERE credit_note_id = $1`,
      [cn.id]
    );
    return {
      id: cn.id,
      creditNoteNumber: cn.credit_note_number,
      invoiceId: cn.invoice_id || null,
      orderId: cn.order_id,
      returnId: cn.return_id || null,
      refundId: cn.refund_id || null,
      creditNoteType: cn.credit_note_type,
      reasonCode: cn.reason_code,
      sellerGstin: cn.seller_gstin || undefined,
      sellerLegalName: cn.seller_legal_name || undefined,
      customerGstin: cn.customer_gstin || undefined,
      customerBusinessName: cn.customer_business_name || undefined,
      placeOfSupplyStateCode: cn.place_of_supply_state_code || undefined,
      supplierStateCode: cn.supplier_state_code || undefined,
      isInterState: Boolean(cn.is_inter_state),
      financialYear: cn.financial_year,
      irn: cn.irn ?? null,
      eInvoicingStatus: cn.e_invoicing_status || 'NOT_APPLICABLE',
      taxableAmount: parseFloat(cn.taxable_amount),
      cgstAmount: parseFloat(cn.cgst_amount),
      sgstAmount: parseFloat(cn.sgst_amount),
      igstAmount: parseFloat(cn.igst_amount),
      cessAmount: parseFloat(cn.cess_amount || '0'),
      totalAmount: parseFloat(cn.total_amount),
      issuedAt: cn.issued_at?.toISOString() || new Date().toISOString(),
      items: lineRes.rows.map((l: any) => ({
        orderItemId: l.order_item_id || null,
        description: l.item_description,
        hsnSacCode: l.hsn_sac_code,
        quantity: l.quantity,
        taxableValue: parseFloat(l.taxable_value),
        gstRatePercent: parseFloat(l.gst_rate_percent),
        cgstAmount: parseFloat(l.cgst_amount),
        sgstAmount: parseFloat(l.sgst_amount),
        igstAmount: parseFloat(l.igst_amount),
        cessAmount: parseFloat(l.cess_amount || '0'),
        totalAmount: parseFloat(l.total_line_amount),
      })),
    };
  }

  public async getOrderCreditNotes(orderId: string): Promise<CreditNoteData[]> {
    const pool = getPool();
    const res = await pool.query(
      `SELECT * FROM credit_notes WHERE order_id = $1 ORDER BY created_at ASC`,
      [orderId]
    );
    const notes: CreditNoteData[] = [];
    for (const row of res.rows) {
      notes.push(await this.mapCreditNoteRow(row, pool));
    }
    return notes;
  }
}

export const invoiceService = new InvoiceService();
