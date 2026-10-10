export interface InvoiceData {
  id: string;
  invoiceNumber: string;
  orderId: string;
  invoiceType: 'SUMMARY' | 'SELLER_TAX_INVOICE' | 'QCOM_PLATFORM_INVOICE';
  irn: string;
  qrData: string;
  sellerGstin?: string;
  sellerLegalName?: string;
  customerGstin?: string;
  customerBusinessName?: string;
  taxableAmount: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  totalAmount: number;
  issuedAt: string;
  items: {
    description: string;
    hsnSacCode: string;
    quantity: number;
    unitPrice: number;
    taxableValue: number;
    gstRatePercent: number;
    cgstAmount: number;
    sgstAmount: number;
    igstAmount: number;
    totalAmount: number;
  }[];
}
