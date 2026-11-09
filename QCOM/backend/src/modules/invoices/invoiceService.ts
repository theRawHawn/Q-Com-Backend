import crypto from 'crypto';
import { getPool, transaction } from '../../database/connection.js';
import { InvoiceData } from './invoiceTypes.js';

export class InvoiceService {
  /**
   * Computes statutory 64-character SHA-256 IRN hash
   */
  public generateIrn(sellerGstin: string, invoiceNumber: string, financialYear: string): string {
    const raw = `${sellerGstin}:${financialYear}:${invoiceNumber}`;
    return crypto.createHash('sha256').update(raw).digest('hex').toUpperCase();
  }

  /**
   * Generates or retrieves statutory GST invoices for an order
   */
  public async getOrCreateOrderInvoices(orderId: string): Promise<InvoiceData[]> {
    const pool = getPool();

    // Check if invoices already generated and persisted in PostgreSQL
    const existingRes = await pool.query(`
      SELECT * FROM invoices WHERE order_id = $1 ORDER BY created_at ASC
    `, [orderId]);

    if (existingRes.rows.length > 0) {
      const invoices: InvoiceData[] = [];
      for (const inv of existingRes.rows) {
        const lineItemsRes = await pool.query(`
          SELECT * FROM invoice_line_items WHERE invoice_id = $1
        `, [inv.id]);
        invoices.push({
          id: inv.id,
          invoiceNumber: inv.invoice_number,
          orderId: inv.order_id,
          invoiceType: inv.invoice_type,
          irn: inv.irn,
          qrData: inv.qr_data,
          sellerGstin: inv.seller_gstin || undefined,
          sellerLegalName: inv.seller_legal_name || undefined,
          customerGstin: inv.customer_gstin || undefined,
          customerBusinessName: inv.customer_business_name || undefined,
          taxableAmount: parseFloat(inv.taxable_amount),
          cgstAmount: parseFloat(inv.cgst_amount),
          sgstAmount: parseFloat(inv.sgst_amount),
          igstAmount: parseFloat(inv.igst_amount),
          totalAmount: parseFloat(inv.total_amount),
          issuedAt: inv.issued_at?.toISOString() || new Date().toISOString(),
          items: lineItemsRes.rows.map(l => ({
            description: l.item_description,
            hsnSacCode: l.hsn_sac_code,
            quantity: l.quantity,
            unitPrice: parseFloat(l.unit_price),
            taxableValue: parseFloat(l.taxable_value),
            gstRatePercent: parseFloat(l.gst_rate_percent),
            cgstAmount: parseFloat(l.cgst_amount),
            sgstAmount: parseFloat(l.sgst_amount),
            igstAmount: parseFloat(l.igst_amount),
            totalAmount: parseFloat(l.total_line_amount),
          })),
        });
      }
      return invoices;
    }

    // Otherwise generate from order record
    const orderRes = await pool.query(`
      SELECT o.*, m.name as merchant_name, m.gstin as merchant_gstin
      FROM orders o
      JOIN merchants m ON o.merchant_id = m.id
      WHERE o.id = $1
      LIMIT 1
    `, [orderId]);

    if (orderRes.rows.length === 0) {
      throw new Error(`Order ${orderId} not found.`);
    }

    const o = orderRes.rows[0];
    const itemsRes = await pool.query(`SELECT * FROM order_items WHERE order_id = $1`, [orderId]);
    const sellerGstin = o.merchant_gstin || '29AAAAA0000A1Z5';
    const sellerName = o.merchant_name || 'Authorized Trade Partner';
    const qcomGstin = '29AAACQ1928K1Z3';

    const invSellerNumber = `INV-SLR-${o.order_number.replace('QC-', '')}`;
    const invQcomNumber = `INV-QCOM-${o.order_number.replace('QC-', '')}`;

    const irnSeller = this.generateIrn(sellerGstin, invSellerNumber, '2026-27');
    const irnQcom = this.generateIrn(qcomGstin, invQcomNumber, '2026-27');

    return transaction(async (client) => {
      // 1. Form GST INV-1 (Seller Goods Tax Invoice)
      const insSellerInv = await client.query(`
        INSERT INTO invoices (
          invoice_number, order_id, invoice_type, irn, qr_data,
          seller_gstin, seller_legal_name, customer_gstin, customer_business_name,
          taxable_amount, cgst_amount, sgst_amount, igst_amount, total_amount
        )
        VALUES ($1, $2, 'SELLER_TAX_INVOICE', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING id
      `, [
        invSellerNumber,
        orderId,
        irnSeller,
        `GSTIN:${sellerGstin}|INV:${invSellerNumber}|IRN:${irnSeller}`,
        sellerGstin,
        sellerName,
        o.customer_gstin || null,
        o.customer_business_name || null,
        o.taxable_amount,
        o.cgst_amount,
        o.sgst_amount,
        o.igst_amount,
        parseFloat(o.taxable_amount) + parseFloat(o.cgst_amount) + parseFloat(o.sgst_amount) + parseFloat(o.igst_amount),
      ]);

      const sellerInvId = insSellerInv.rows[0].id;
      for (const it of itemsRes.rows) {
        await client.query(`
          INSERT INTO invoice_line_items (
            invoice_id, item_description, hsn_sac_code, quantity, unit_price,
            taxable_value, gst_rate_percent, cgst_amount, sgst_amount, igst_amount, total_line_amount
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `, [
          sellerInvId,
          it.product_name,
          it.hsn_code,
          it.quantity,
          it.unit_price,
          it.taxable_amount,
          it.gst_rate_percent,
          it.cgst_amount,
          it.sgst_amount,
          it.igst_amount,
          it.total_price,
        ]);
      }

      // 2. QCOM Platform & Delivery Tax Invoice
      const deliveryFee = parseFloat(o.delivery_fee);
      const handlingFee = parseFloat(o.handling_fee);
      const qcomTaxable = deliveryFee + handlingFee;
      const qcomGst = +(qcomTaxable * 0.18).toFixed(2);
      const qcomCgst = +(qcomGst / 2).toFixed(2);
      const qcomSgst = +(qcomGst / 2).toFixed(2);

      const insQcomInv = await client.query(`
        INSERT INTO invoices (
          invoice_number, order_id, invoice_type, irn, qr_data,
          seller_gstin, seller_legal_name, customer_gstin, customer_business_name,
          taxable_amount, cgst_amount, sgst_amount, igst_amount, total_amount
        )
        VALUES ($1, $2, 'QCOM_PLATFORM_INVOICE', $3, $4, $5, 'QCOM Logistics & Platform Services', $6, $7, $8, $9, $10, 0.00, $11)
        RETURNING id
      `, [
        invQcomNumber,
        orderId,
        irnQcom,
        `GSTIN:${qcomGstin}|INV:${invQcomNumber}|IRN:${irnQcom}`,
        qcomGstin,
        o.customer_gstin || null,
        o.customer_business_name || null,
        qcomTaxable,
        qcomCgst,
        qcomSgst,
        qcomTaxable + qcomGst,
      ]);

      const qcomInvId = insQcomInv.rows[0].id;
      if (deliveryFee > 0) {
        await client.query(`
          INSERT INTO invoice_line_items (
            invoice_id, item_description, hsn_sac_code, quantity, unit_price,
            taxable_value, gst_rate_percent, cgst_amount, sgst_amount, igst_amount, total_line_amount
          )
          VALUES ($1, 'Rapid Hyperlocal Dispatch & Courier Transport', '996813', 1, $2, $2, 18.00, $3, $4, 0.00, $5)
        `, [qcomInvId, deliveryFee, (deliveryFee * 0.09).toFixed(2), (deliveryFee * 0.09).toFixed(2), (deliveryFee * 1.18).toFixed(2)]);
      }

      if (handlingFee > 0) {
        await client.query(`
          INSERT INTO invoice_line_items (
            invoice_id, item_description, hsn_sac_code, quantity, unit_price,
            taxable_value, gst_rate_percent, cgst_amount, sgst_amount, igst_amount, total_line_amount
          )
          VALUES ($1, 'Site Logistics Handling & Staging Charge', '998319', 1, $2, $2, 18.00, $3, $4, 0.00, $5)
        `, [qcomInvId, handlingFee, (handlingFee * 0.09).toFixed(2), (handlingFee * 0.09).toFixed(2), (handlingFee * 1.18).toFixed(2)]);
      }

      return this.getOrCreateOrderInvoices(orderId);
    });
  }
}

export const invoiceService = new InvoiceService();
