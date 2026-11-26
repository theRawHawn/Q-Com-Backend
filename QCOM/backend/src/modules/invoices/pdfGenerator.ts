import { InvoiceData, CreditNoteData } from './invoiceTypes.js';

export class PdfGenerator {
  /**
   * Generates a text representation of Form GST INV-1 or Summary invoice
   */
  public generateInvoiceTextSummary(invoice: InvoiceData): string {
    const posDisplay = invoice.placeOfSupplyStateName
      ? `${invoice.placeOfSupplyStateName} (${invoice.placeOfSupplyStateCode})`
      : invoice.placeOfSupplyStateCode || 'N/A';

    const lines = [
      `================================================================================`,
      `                       GOVERNMENT OF INDIA - GST INVOICE                        `,
      `================================================================================`,
      `Invoice Type:      ${invoice.invoiceType}`,
      `Invoice Number:    ${invoice.invoiceNumber}`,
      `Financial Year:    ${invoice.financialYear || 'N/A'}`,
      `Date of Issue:     ${invoice.issuedAt}`,
      `IRN:               ${invoice.irn || 'NOT_APPLICABLE'}`,
      `E-Invoicing State: ${invoice.eInvoicingStatus || 'NOT_APPLICABLE'}`,
      `QR Code Data:      ${invoice.qrData}`,
      `--------------------------------------------------------------------------------`,
      `SUPPLIER DETAILS:`,
      `  Legal Name:      ${invoice.sellerLegalName || 'N/A'}`,
      `  GSTIN:           ${invoice.sellerGstin || 'UNREGISTERED / NOT_CONFIGURED'}`,
      `  Supplier State:  ${invoice.supplierStateCode || 'N/A'}`,
      `  Place of Supply: ${posDisplay}`,
      `--------------------------------------------------------------------------------`,
      `RECIPIENT DETAILS:`,
      `  Business Name:   ${invoice.customerBusinessName || 'Individual Customer'}`,
      `  GSTIN:           ${invoice.customerGstin || 'UNREGISTERED'}`,
      `--------------------------------------------------------------------------------`,
      `ITEMIZED SCHEDULE:`,
      `Item Description                 HSN/SAC   Qty   Rate(₹)   Taxable(₹)   GST(%)  Total(₹)`,
    ];

    for (const it of invoice.items) {
      lines.push(
        `${it.description.slice(0, 32).padEnd(32)} ${it.hsnSacCode.padEnd(9)} ${String(it.quantity).padEnd(5)} ${it.unitPrice.toFixed(2).padEnd(9)} ${it.taxableValue.toFixed(2).padEnd(12)} ${it.gstRatePercent.toFixed(1).padEnd(7)} ${it.totalAmount.toFixed(2)}`
      );
    }

    lines.push(
      `--------------------------------------------------------------------------------`,
      `Discount Applied:     ₹${(invoice.discountAmount || 0).toFixed(2)}`,
      `Total Taxable Value:  ₹${invoice.taxableAmount.toFixed(2)}`,
      `CGST Amount:          ₹${invoice.cgstAmount.toFixed(2)}`,
      `SGST Amount:          ₹${invoice.sgstAmount.toFixed(2)}`,
      `IGST Amount:          ₹${invoice.igstAmount.toFixed(2)}`,
      `Cess Amount:          ₹${(invoice.cessAmount || 0).toFixed(2)}`,
      `GRAND TOTAL PAYABLE:  ₹${invoice.totalAmount.toFixed(2)}`,
      `================================================================================`
    );

    return lines.join('\n');
  }

  public generateCreditNoteTextSummary(cn: CreditNoteData): string {
    const lines = [
      `================================================================================`,
      `                     GOVERNMENT OF INDIA - GST CREDIT NOTE                      `,
      `================================================================================`,
      `Credit Note Type:  ${cn.creditNoteType}`,
      `Credit Note No.:   ${cn.creditNoteNumber}`,
      `Reason Code:       ${cn.reasonCode}`,
      `Financial Year:    ${cn.financialYear}`,
      `Date of Issue:     ${cn.issuedAt}`,
      `IRN:               ${cn.irn || 'NOT_APPLICABLE'}`,
      `E-Invoicing State: ${cn.eInvoicingStatus}`,
      `--------------------------------------------------------------------------------`,
      `SUPPLIER DETAILS:`,
      `  Legal Name:      ${cn.sellerLegalName || 'N/A'}`,
      `  GSTIN:           ${cn.sellerGstin || 'UNREGISTERED'}`,
      `  Place of Supply: ${cn.placeOfSupplyStateCode || 'N/A'}`,
      `--------------------------------------------------------------------------------`,
      `RETURNED ITEMS:`,
      `Item Description                 HSN/SAC   Qty   Taxable(₹)   GST(%)  Total(₹)`,
    ];

    for (const it of cn.items) {
      lines.push(
        `${it.description.slice(0, 32).padEnd(32)} ${it.hsnSacCode.padEnd(9)} ${String(it.quantity).padEnd(5)} ${it.taxableValue.toFixed(2).padEnd(12)} ${it.gstRatePercent.toFixed(1).padEnd(7)} ${it.totalAmount.toFixed(2)}`
      );
    }

    lines.push(
      `--------------------------------------------------------------------------------`,
      `Total Taxable Value:  ₹${cn.taxableAmount.toFixed(2)}`,
      `CGST Reversal:        ₹${cn.cgstAmount.toFixed(2)}`,
      `SGST Reversal:        ₹${cn.sgstAmount.toFixed(2)}`,
      `IGST Reversal:        ₹${cn.igstAmount.toFixed(2)}`,
      `Cess Reversal:        ₹${cn.cessAmount.toFixed(2)}`,
      `TOTAL CREDIT VALUE:   ₹${cn.totalAmount.toFixed(2)}`,
      `================================================================================`
    );

    return lines.join('\n');
  }
}

export const pdfGenerator = new PdfGenerator();
