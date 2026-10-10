import { InvoiceData } from './invoiceTypes.js';

export class PdfGenerator {
  /**
   * Generates a text/binary representation of Form GST INV-1 or Summary invoice
   */
  public generateInvoiceTextSummary(invoice: InvoiceData): string {
    const lines = [
      `================================================================================`,
      `                       GOVERNMENT OF INDIA - GST INVOICE                        `,
      `================================================================================`,
      `Invoice Type:      ${invoice.invoiceType}`,
      `Invoice Number:    ${invoice.invoiceNumber}`,
      `Date of Issue:     ${invoice.issuedAt}`,
      `IRN:               ${invoice.irn}`,
      `QR Code Data:      ${invoice.qrData}`,
      `--------------------------------------------------------------------------------`,
      `SUPPLIER DETAILS:`,
      `  Legal Name:      ${invoice.sellerLegalName || 'N/A'}`,
      `  GSTIN:           ${invoice.sellerGstin || 'N/A'}`,
      `  Place of Supply: Karnataka (29)`,
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
        `${it.description.padEnd(32)} ${it.hsnSacCode.padEnd(9)} ${String(it.quantity).padEnd(5)} ${it.unitPrice.toFixed(2).padEnd(9)} ${it.taxableValue.toFixed(2).padEnd(12)} ${it.gstRatePercent.toFixed(1).padEnd(7)} ${it.totalAmount.toFixed(2)}`
      );
    }

    lines.push(
      `--------------------------------------------------------------------------------`,
      `Total Taxable Value:  ₹${invoice.taxableAmount.toFixed(2)}`,
      `CGST Amount:          ₹${invoice.cgstAmount.toFixed(2)}`,
      `SGST Amount:          ₹${invoice.sgstAmount.toFixed(2)}`,
      `IGST Amount:          ₹${invoice.igstAmount.toFixed(2)}`,
      `GRAND TOTAL PAYABLE:  ₹${invoice.totalAmount.toFixed(2)}`,
      `================================================================================`
    );

    return lines.join('\n');
  }
}

export const pdfGenerator = new PdfGenerator();
