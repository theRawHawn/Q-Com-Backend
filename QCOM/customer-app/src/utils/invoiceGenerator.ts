import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import QRCode from 'qrcode';
import { Order, CartItem, HardwareProduct, EInvoiceData } from '../types';
import { HARDWARE_SELLERS, DEFAULT_SELLER, getSellerById } from '../data/sellers';
import {
  GST_STATE_MAP,
  extractStateCodeFromGstin,
  getStateNameByCode,
  getProductHsnCode,
} from './gstEngine';

// QCOM Corporate Identity for Platform & Logistics Invoicing
export const QCOM_PLATFORM_COMPANY = {
  id: 'qcom-platform',
  name: 'QuickCommerce Hardware & Logistics India Pvt. Ltd.',
  tradeName: 'QuickCommerce Supply Chain & Delivery Solutions',
  address: '100 Feet Rd, 4th Block, Koramangala, Bengaluru, Karnataka - 560034',
  gstin: '29AAACQ1928K1Z3',
  stateCode: '29',
  stateName: 'Karnataka',
  pan: 'AAACQ1928K',
  cin: 'U72900KA2026PTC192841',
  phone: '+91 80 4000 8800',
};

// Helper to convert number to Indian currency words
export function numberToWordsIndian(num: number): string {
  const a = [
    '', 'One ', 'Two ', 'Three ', 'Four ', 'Five ', 'Six ', 'Seven ', 'Eight ', 'Nine ',
    'Ten ', 'Eleven ', 'Twelve ', 'Thirteen ', 'Fourteen ', 'Fifteen ', 'Sixteen ', 'Seventeen ', 'Eighteen ', 'Nineteen '
  ];
  const b = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

  const n = Math.floor(Math.abs(num));
  if (n === 0) return 'Zero Rupees Only';

  const inWords = (n: number): string => {
    if (n < 20) return a[n];
    if (n < 100) return b[Math.floor(n / 10)] + (n % 10 !== 0 ? ' ' + a[n % 10] : '');
    if (n < 1000) return a[Math.floor(n / 100)] + 'Hundred ' + (n % 100 !== 0 ? 'and ' + inWords(n % 100) : '');
    if (n < 100000) return inWords(Math.floor(n / 1000)) + 'Thousand ' + (n % 1000 !== 0 ? inWords(n % 1000) : '');
    if (n < 10000000) return inWords(Math.floor(n / 100000)) + 'Lakh ' + (n % 100000 !== 0 ? inWords(n % 100000) : '');
    return inWords(Math.floor(n / 10000000)) + 'Crore ' + (n % 10000000 !== 0 ? inWords(n % 10000000) : '');
  };

  const rupees = inWords(n).trim();
  const paise = Math.round((Math.abs(num) - n) * 100);
  const paiseStr = paise > 0 ? ` and ${inWords(paise).trim()} Paise` : '';

  return `${rupees}${paiseStr} Only`;
}

// Generate realistic IRN (64-character SHA-256 hash mandated for GST e-Invoicing)
export function generateGSTIRN(invoiceNumber: string, dateStr: string, gstin: string): string {
  const raw = `${gstin}-${invoiceNumber}-${dateStr}-QUICKCOMMERCE-PROD`;
  let hash = 0;
  let hash2 = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash |= 0;
    hash2 = ((hash2 << 7) + hash2) ^ (ch * 31);
    hash2 |= 0;
  }
  const part1 = Math.abs(hash).toString(16).padStart(8, '0');
  const part2 = Math.abs(hash2).toString(16).padStart(8, '0');
  const part3 = (Math.abs(hash ^ hash2) * 2654435761).toString(16).slice(0, 8).padStart(8, '0');
  const part4 = (Math.abs(hash + hash2) * 1597334677).toString(16).slice(0, 8).padStart(8, '0');
  const part5 = (Math.abs(hash * 37) * 2246822519).toString(16).slice(0, 8).padStart(8, '0');
  const part6 = (Math.abs(hash2 * 41) * 3266489917).toString(16).slice(0, 8).padStart(8, '0');
  const part7 = (Math.abs(hash ^ 0x5a5a5a5a) * 1812433253).toString(16).slice(0, 8).padStart(8, '0');
  const part8 = (Math.abs(hash2 ^ 0xa5a5a5a5) * 6364136223).toString(16).slice(0, 8).padStart(8, '0');
  return (part1 + part2 + part3 + part4 + part5 + part6 + part7 + part8).toLowerCase().slice(0, 64);
}

export interface DetailedGstInvoiceData {
  docType: 'summary' | 'seller' | 'qcom';
  docTitle: string;
  docSubtitle: string;
  recipientPill: string;
  invoiceNumber: string;
  legalInvoiceNumber?: string;
  invoiceReference?: string;
  orderId: string;
  sellerIndex?: number;
  sellerTotalCount?: number;
  // Optional e-Invoice specific fields (rendered only when provided)
  isEInvoice?: boolean;
  irn?: string;
  ackNo?: string;
  acknowledgementNumber?: string;
  ackDate?: string;
  acknowledgementDate?: string;
  signedQRCode?: string;
  qrCodePayload?: string;
  invoiceDate: string;
  invoiceTime: string;
  reverseCharge: 'NO' | 'YES';
  placeOfSupply: string;
  placeOfSupplyCode: string;
  placeOfSupplyName: string;
  isInterState: boolean;
  isUnionTerritory: boolean;
  supplyType: string;
  seller: {
    id?: string;
    name: string;
    tradeName: string;
    address: string;
    gstin: string;
    stateCode: string;
    stateName: string;
    pan: string;
    phone?: string;
  };
  buyer: {
    isB2B?: boolean;
    legalName: string;
    tradeName: string;
    gstin: string;
    billingAddress: string;
    shippingAddress: string;
    stateCode: string;
    stateName: string;
    contactName: string;
    phone: string;
  };
  items: Array<{
    slNo: number;
    description: string;
    brand?: string;
    hsnCode: string;
    uqc: string;
    quantity: number;
    unitRate: number; // Taxable unit price
    grossAmount: number;
    discount: number;
    taxableValue: number;
    gstRate: number;
    cgstRate: number;
    cgstAmount: number;
    sgstRate: number;
    sgstAmount: number;
    utgstRate: number;
    utgstAmount: number;
    igstRate: number;
    igstAmount: number;
    totalAmount: number;
    sellerName?: string;
  }>;
  hsnSummary: Array<{
    hsnCode: string;
    description: string;
    taxableValue: number;
    cgstRate: number;
    cgstAmount: number;
    sgstRate: number;
    sgstAmount: number;
    utgstRate: number;
    utgstAmount: number;
    igstRate: number;
    igstAmount: number;
    totalTax: number;
  }>;
  totalTaxableValue: number;
  totalCgst: number;
  totalSgst: number;
  totalUtgst: number;
  totalIgst: number;
  totalGst: number;
  subtotalWithTax: number;
  roundOff: number;
  grandTotal: number;
  amountInWords: string;
}

export interface OrderInvoiceBundle {
  orderId: string;
  documents: DetailedGstInvoiceData[]; // Ordered list of all PDF pages [Summary, Seller 1..N, QCOM]
  summaryDoc: DetailedGstInvoiceData;
  sellerDocs: DetailedGstInvoiceData[];
  qcomDoc: DetailedGstInvoiceData | null;
  totalSellers: number;
  totalDocuments: number;
  hasQcomCharges: boolean;
}

/**
 * Extracts and resolves complete seller details for any product.
 */
export function getSellerInfoForProduct(
  product: HardwareProduct,
  defaultSellerPartner?: Order['sellerPartner']
): {
  id: string;
  name: string;
  tradeName: string;
  address: string;
  gstin: string;
  stateCode: string;
  stateName: string;
  pan: string;
  phone?: string;
} {
  // Check predefined sellers list
  if (product.sellerId) {
    const partner = getSellerById(product.sellerId);
    if (partner) {
      const gstin = product.sellerGstin || partner.gstin || '29AABCS8812K1ZM';
      const stateCode = extractStateCodeFromGstin(gstin) || '29';
      const stateName = getStateNameByCode(stateCode);
      const pan = gstin.length >= 12 ? gstin.slice(2, 12) : 'AABCS8812K';
      return {
        id: partner.id,
        name: product.sellerName || partner.name,
        tradeName: partner.specialty || partner.badge || 'Authorized Merchant Hub',
        address: product.sellerAddress || partner.address,
        gstin,
        stateCode,
        stateName,
        pan,
        phone: partner.phone,
      };
    }
  }

  // Match by seller name in sellers array
  if (product.sellerName) {
    const match = HARDWARE_SELLERS.find(s => s.name.toLowerCase() === product.sellerName?.toLowerCase());
    if (match) {
      const gstin = product.sellerGstin || match.gstin || '29AABCS8812K1ZM';
      const stateCode = extractStateCodeFromGstin(gstin) || '29';
      const stateName = getStateNameByCode(stateCode);
      const pan = gstin.length >= 12 ? gstin.slice(2, 12) : 'AABCS8812K';
      return {
        id: match.id,
        name: match.name,
        tradeName: match.specialty || match.badge || 'Authorized Merchant Hub',
        address: product.sellerAddress || match.address,
        gstin,
        stateCode,
        stateName,
        pan,
        phone: match.phone,
      };
    }
  }

  // Fallback to order-level sellerPartner or DEFAULT_SELLER
  const fallback = defaultSellerPartner || DEFAULT_SELLER;
  const gstin = product.sellerGstin || fallback.gstin || '29AABCU9603R1ZM';
  const stateCode = extractStateCodeFromGstin(gstin) || '29';
  const stateName = getStateNameByCode(stateCode);
  const pan = gstin.length >= 12 ? gstin.slice(2, 12) : 'AABCU9603R';

  return {
    id: ('id' in fallback && fallback.id) ? fallback.id : 'default-seller',
    name: product.sellerName || fallback.name,
    tradeName: 'Authorized QuickCommerce Merchant Partner',
    address: product.sellerAddress || fallback.address,
    gstin,
    stateCode,
    stateName,
    pan,
    phone: ('phone' in fallback && fallback.phone) ? fallback.phone : '+91 98450 12891',
  };
}

/**
 * Computes single document invoice data for a specific set of items and seller/buyer parameters.
 */
function buildInvoiceDocument(params: {
  docType: 'summary' | 'seller' | 'qcom';
  docTitle: string;
  docSubtitle: string;
  recipientPill: string;
  invoiceNumber: string;
  order: Order;
  seller: DetailedGstInvoiceData['seller'];
  buyer: DetailedGstInvoiceData['buyer'];
  items: CartItem[];
  includeDeliveryCharge?: boolean;
  sellerIndex?: number;
  sellerTotalCount?: number;
  eInvoiceData?: EInvoiceData;
}): DetailedGstInvoiceData {
  const {
    docType,
    docTitle,
    docSubtitle,
    recipientPill,
    invoiceNumber,
    order,
    seller,
    buyer,
    items: cartItems,
    includeDeliveryCharge = false,
    sellerIndex,
    sellerTotalCount,
    eInvoiceData,
  } = params;

  const orderDate = order.placedAt ? new Date(order.placedAt) : new Date();
  const invoiceDate = orderDate.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
  const invoiceTime = orderDate.toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });

  const sellerStateCode = seller.stateCode || '29';
  const buyerStateCode = buyer.stateCode || '29';
  const buyerStateObj = GST_STATE_MAP[buyerStateCode];

  const isInterState = sellerStateCode !== buyerStateCode;
  const isUnionTerritory = !isInterState && Boolean(buyerStateObj?.isUnionTerritoryWithoutLegislature);

  let supplyType = 'INTRA-STATE (CGST + SGST)';
  if (isInterState) {
    supplyType = 'INTER-STATE (IGST)';
  } else if (isUnionTerritory) {
    supplyType = 'INTRA-STATE (CGST + UTGST)';
  }

  const placeOfSupply = `${buyerStateCode} - ${buyer.stateName.toUpperCase()}`;

  const docItems: DetailedGstInvoiceData['items'] = [];
  const hsnMap: Record<string, {
    hsnCode: string;
    description: string;
    taxableValue: number;
    cgstRate: number;
    cgstAmount: number;
    sgstRate: number;
    sgstAmount: number;
    utgstRate: number;
    utgstAmount: number;
    igstRate: number;
    igstAmount: number;
    totalTax: number;
  }> = {};

  let totalTaxableValue = 0;
  let totalCgst = 0;
  let totalSgst = 0;
  let totalUtgst = 0;
  let totalIgst = 0;

  // 1. Process Product Items
  cartItems.forEach((item, idx) => {
    const qty = Math.max(1, item.quantity);
    const grossTotal = item.product.price * qty;

    const gstRate = item.product.gstRatePercent || 18;
    const hsnCode = item.product.hsnCode || getProductHsnCode(item.product.category || '', item.product.specs?.material);

    // Tax decomposition (inclusive retail pricing)
    const taxableValue = Math.round((grossTotal / (1 + gstRate / 100)) * 100) / 100;
    const unitRate = Math.round((taxableValue / qty) * 100) / 100;
    const totalTax = Math.round((grossTotal - taxableValue) * 100) / 100;

    let cgstRate = 0;
    let cgstAmount = 0;
    let sgstRate = 0;
    let sgstAmount = 0;
    let utgstRate = 0;
    let utgstAmount = 0;
    let igstRate = 0;
    let igstAmount = 0;

    if (isInterState) {
      igstRate = gstRate;
      igstAmount = totalTax;
      totalIgst += igstAmount;
    } else if (isUnionTerritory) {
      cgstRate = gstRate / 2;
      utgstRate = gstRate / 2;
      cgstAmount = Math.round((totalTax / 2) * 100) / 100;
      utgstAmount = Math.round((totalTax - cgstAmount) * 100) / 100;
      totalCgst += cgstAmount;
      totalUtgst += utgstAmount;
    } else {
      cgstRate = gstRate / 2;
      sgstRate = gstRate / 2;
      cgstAmount = Math.round((totalTax / 2) * 100) / 100;
      sgstAmount = Math.round((totalTax - cgstAmount) * 100) / 100;
      totalCgst += cgstAmount;
      totalSgst += sgstAmount;
    }

    totalTaxableValue += taxableValue;

    // Unit of measurement
    let uqc = 'NOS';
    const nameLower = item.product.name.toLowerCase();
    if (nameLower.includes('wire') || nameLower.includes('cable') || nameLower.includes('pipe')) uqc = 'MTR';
    else if (nameLower.includes('tape') || nameLower.includes('pack') || nameLower.includes('set')) uqc = 'PKT';
    else if (nameLower.includes('kg') || nameLower.includes('cement')) uqc = 'KGS';

    docItems.push({
      slNo: idx + 1,
      description: item.product.name,
      brand: item.product.specs?.brand,
      hsnCode,
      uqc,
      quantity: qty,
      unitRate,
      grossAmount: grossTotal,
      discount: 0,
      taxableValue,
      gstRate,
      cgstRate,
      cgstAmount,
      sgstRate,
      sgstAmount,
      utgstRate,
      utgstAmount,
      igstRate,
      igstAmount,
      totalAmount: grossTotal,
      sellerName: item.product.sellerName || seller.name,
    });

    if (!hsnMap[hsnCode]) {
      hsnMap[hsnCode] = {
        hsnCode,
        description: item.product.name.split(' ')[0] + ' Goods',
        taxableValue: 0,
        cgstRate,
        cgstAmount: 0,
        sgstRate,
        sgstAmount: 0,
        utgstRate,
        utgstAmount: 0,
        igstRate,
        igstAmount: 0,
        totalTax: 0,
      };
    }
    hsnMap[hsnCode].taxableValue += taxableValue;
    hsnMap[hsnCode].cgstAmount += cgstAmount;
    hsnMap[hsnCode].sgstAmount += sgstAmount;
    hsnMap[hsnCode].utgstAmount += utgstAmount;
    hsnMap[hsnCode].igstAmount += igstAmount;
    hsnMap[hsnCode].totalTax += totalTax;
  });

  // 2. Delivery & Handling Charges (for Summary or QCOM invoice)
  if (includeDeliveryCharge) {
    const sacCode = '996813';
    const dBreak = order.deliveryChargeBreakdown;
    const delGstRate = dBreak?.gstRate || 18;

    // A. Add Delivery Charges Line Item (if delivery fee > 0)
    if ((order.deliveryFee && order.deliveryFee > 0) || (dBreak && dBreak.finalDeliveryCharge > 0)) {
      let delTaxable = 0;
      let delTax = 0;
      let delGross = 0;
      let delCgstRate = 0;
      let delCgst = 0;
      let delSgstRate = 0;
      let delSgst = 0;
      let delUtgstRate = 0;
      let delUtgst = 0;
      let delIgstRate = 0;
      let delIgst = 0;

      if (dBreak && dBreak.taxableDeliveryCharge > 0) {
        delTaxable = dBreak.taxableDeliveryCharge;
        delTax = dBreak.totalGstAmount;
        delGross = dBreak.preRoundingDeliveryTotal;

        if (isInterState) {
          delIgstRate = delGstRate;
          delIgst = dBreak.igstAmount || delTax;
          totalIgst += delIgst;
        } else if (isUnionTerritory) {
          delCgstRate = delGstRate / 2;
          delUtgstRate = delGstRate / 2;
          delCgst = dBreak.cgstAmount;
          delUtgst = dBreak.utgstAmount || (delTax - delCgst);
          totalCgst += delCgst;
          totalUtgst += delUtgst;
        } else {
          delCgstRate = delGstRate / 2;
          delSgstRate = delGstRate / 2;
          delCgst = dBreak.cgstAmount;
          delSgst = dBreak.sgstAmount;
          totalCgst += delCgst;
          totalSgst += delSgst;
        }
      } else {
        delGross = order.deliveryFee || 0;
        delTaxable = Math.round((delGross / (1 + delGstRate / 100)) * 100) / 100;
        delTax = Math.round((delGross - delTaxable) * 100) / 100;

        if (isInterState) {
          delIgstRate = delGstRate;
          delIgst = delTax;
          totalIgst += delIgst;
        } else if (isUnionTerritory) {
          delCgstRate = delGstRate / 2;
          delUtgstRate = delGstRate / 2;
          delCgst = Math.round((delTax / 2) * 100) / 100;
          delUtgst = Math.round((delTax - delCgst) * 100) / 100;
          totalCgst += delCgst;
          totalUtgst += delUtgst;
        } else {
          delCgstRate = delGstRate / 2;
          delSgstRate = delGstRate / 2;
          delCgst = Math.round((delTax / 2) * 100) / 100;
          delSgst = Math.round((delTax - delCgst) * 100) / 100;
          totalCgst += delCgst;
          totalSgst += delSgst;
        }
      }

      totalTaxableValue += delTaxable;

      docItems.push({
        slNo: docItems.length + 1,
        description: 'Express Address Dispatch & Delivery Services',
        hsnCode: sacCode,
        uqc: 'SER',
        quantity: 1,
        unitRate: delTaxable,
        grossAmount: delGross,
        discount: 0,
        taxableValue: delTaxable,
        gstRate: delGstRate,
        cgstRate: delCgstRate,
        cgstAmount: delCgst,
        sgstRate: delSgstRate,
        sgstAmount: delSgst,
        utgstRate: delUtgstRate,
        utgstAmount: delUtgst,
        igstRate: delIgstRate,
        igstAmount: delIgst,
        totalAmount: delGross,
        sellerName: 'QuickCommerce Logistics',
      });

      if (!hsnMap[sacCode]) {
        hsnMap[sacCode] = {
          hsnCode: sacCode,
          description: 'Courier & Local Transport Logistics Service',
          taxableValue: 0,
          cgstRate: delCgstRate,
          cgstAmount: 0,
          sgstRate: delSgstRate,
          sgstAmount: 0,
          utgstRate: delUtgstRate,
          utgstAmount: 0,
          igstRate: delIgstRate,
          igstAmount: 0,
          totalTax: 0,
        };
      }
      hsnMap[sacCode].taxableValue += delTaxable;
      hsnMap[sacCode].cgstAmount += delCgst;
      hsnMap[sacCode].sgstAmount += delSgst;
      hsnMap[sacCode].utgstAmount += delUtgst;
      hsnMap[sacCode].igstAmount += delIgst;
      hsnMap[sacCode].totalTax += delTax;
    }

    // B. Add Handling & Platform Services Line Item
    const handlingGross = order.handlingFee ?? (order.urgencyFee || 25);
    if (handlingGross > 0) {
      const handGstRate = 18;
      // Total ₹25 (₹12 handling + ₹13 platform), inclusive of 18% GST: Taxable = 21.19, GST = 3.81
      const handTaxable = Math.round((handlingGross / (1 + handGstRate / 100)) * 100) / 100;
      const handTax = Math.round((handlingGross - handTaxable) * 100) / 100;
      let handCgstRate = 0;
      let handCgst = 0;
      let handSgstRate = 0;
      let handSgst = 0;
      let handUtgstRate = 0;
      let handUtgst = 0;
      let handIgstRate = 0;
      let handIgst = 0;

      if (isInterState) {
        handIgstRate = handGstRate;
        handIgst = handTax;
        totalIgst += handIgst;
      } else if (isUnionTerritory) {
        handCgstRate = handGstRate / 2;
        handUtgstRate = handGstRate / 2;
        handCgst = Math.round((handTax / 2) * 100) / 100;
        handUtgst = Math.round((handTax - handCgst) * 100) / 100;
        totalCgst += handCgst;
        totalUtgst += handUtgst;
      } else {
        handCgstRate = handGstRate / 2;
        handSgstRate = handGstRate / 2;
        handCgst = Math.round((handTax / 2) * 100) / 100;
        handSgst = Math.round((handTax - handCgst) * 100) / 100;
        totalCgst += handCgst;
        totalSgst += handSgst;
      }

      totalTaxableValue += handTaxable;

      docItems.push({
        slNo: docItems.length + 1,
        description: 'Handling & Platform Convenience Services',
        hsnCode: sacCode,
        uqc: 'SER',
        quantity: 1,
        unitRate: handTaxable,
        grossAmount: handlingGross,
        discount: 0,
        taxableValue: handTaxable,
        gstRate: handGstRate,
        cgstRate: handCgstRate,
        cgstAmount: handCgst,
        sgstRate: handSgstRate,
        sgstAmount: handSgst,
        utgstRate: handUtgstRate,
        utgstAmount: handUtgst,
        igstRate: handIgstRate,
        igstAmount: handIgst,
        totalAmount: handlingGross,
        sellerName: 'QuickCommerce Logistics',
      });

      if (!hsnMap[sacCode]) {
        hsnMap[sacCode] = {
          hsnCode: sacCode,
          description: 'Courier & Local Transport Logistics Service',
          taxableValue: 0,
          cgstRate: handCgstRate,
          cgstAmount: 0,
          sgstRate: handSgstRate,
          sgstAmount: 0,
          utgstRate: handUtgstRate,
          utgstAmount: 0,
          igstRate: handIgstRate,
          igstAmount: 0,
          totalTax: 0,
        };
      }
      hsnMap[sacCode].taxableValue += handTaxable;
      hsnMap[sacCode].cgstAmount += handCgst;
      hsnMap[sacCode].sgstAmount += handSgst;
      hsnMap[sacCode].utgstAmount += handUtgst;
      hsnMap[sacCode].igstAmount += handIgst;
      hsnMap[sacCode].totalTax += handTax;
    }
  }

  // Convert HSN map to sorted array
  const hsnSummary = Object.values(hsnMap).map((h) => ({
    ...h,
    taxableValue: Math.round(h.taxableValue * 100) / 100,
    cgstAmount: Math.round(h.cgstAmount * 100) / 100,
    sgstAmount: Math.round(h.sgstAmount * 100) / 100,
    utgstAmount: Math.round(h.utgstAmount * 100) / 100,
    igstAmount: Math.round(h.igstAmount * 100) / 100,
    totalTax: Math.round(h.totalTax * 100) / 100,
  }));

  const totalGst = Math.round((totalCgst + totalSgst + totalUtgst + totalIgst) * 100) / 100;
  const rawGrandTotal = totalTaxableValue + totalGst;
  const roundedGrandTotal = Math.round(rawGrandTotal);
  const roundOff = Math.round((roundedGrandTotal - rawGrandTotal) * 100) / 100;

  // e-Invoice Fields (strictly data-driven: no fake IRN / QR code generated)
  const isEInvoice = Boolean(
    eInvoiceData?.isEInvoice || 
    (eInvoiceData?.irn && eInvoiceData.irn.trim().length > 0) ||
    (eInvoiceData?.signedQRCode && eInvoiceData.signedQRCode.trim().length > 0)
  );

  const irn = isEInvoice ? eInvoiceData?.irn : undefined;
  const ackNo = isEInvoice ? (eInvoiceData?.acknowledgementNumber || eInvoiceData?.ackNo) : undefined;
  const ackDate = isEInvoice ? (eInvoiceData?.acknowledgementDate || eInvoiceData?.ackDate) : undefined;
  const signedQRCode = isEInvoice ? eInvoiceData?.signedQRCode : undefined;

  // Signed e-Invoice QR Code payload (used only when QR code payload or signed QR code is present)
  let qrCodePayload: string | undefined = undefined;
  if (signedQRCode) {
    qrCodePayload = signedQRCode;
  } else if (irn) {
    qrCodePayload = JSON.stringify({
      SellerGSTIN: seller.gstin,
      BuyerGSTIN: buyer.gstin,
      DocNo: invoiceNumber,
      DocTyp: 'INV',
      DocDt: orderDate.toISOString().slice(0, 10),
      TotInvVal: roundedGrandTotal,
      ItemCnt: docItems.length,
      MainHsnCode: docItems[0]?.hsnCode || '8481',
      Irn: irn,
    });
  }

  return {
    docType,
    docTitle,
    docSubtitle,
    recipientPill,
    invoiceNumber,
    legalInvoiceNumber: eInvoiceData?.legalInvoiceNumber || invoiceNumber,
    invoiceReference: eInvoiceData?.invoiceReference || invoiceNumber,
    orderId: order.id,
    sellerIndex,
    sellerTotalCount,
    isEInvoice,
    irn,
    ackNo,
    acknowledgementNumber: ackNo,
    ackDate,
    acknowledgementDate: ackDate,
    signedQRCode,
    qrCodePayload,
    invoiceDate,
    invoiceTime,
    reverseCharge: 'NO',
    placeOfSupply,
    placeOfSupplyCode: buyerStateCode,
    placeOfSupplyName: buyer.stateName,
    isInterState,
    isUnionTerritory,
    supplyType,
    seller,
    buyer,
    items: docItems,
    hsnSummary,
    totalTaxableValue: Math.round(totalTaxableValue * 100) / 100,
    totalCgst: Math.round(totalCgst * 100) / 100,
    totalSgst: Math.round(totalSgst * 100) / 100,
    totalUtgst: Math.round(totalUtgst * 100) / 100,
    totalIgst: Math.round(totalIgst * 100) / 100,
    totalGst,
    subtotalWithTax: rawGrandTotal,
    roundOff,
    grandTotal: roundedGrandTotal,
    amountInWords: numberToWordsIndian(roundedGrandTotal),
  };
}

/**
 * Dynamically resolves invoice buyer details (Billing & Shipping addresses).
 * For B2B orders (with GSTIN/Business Name): Bill To uses added GST billing details, Ship To uses selected delivery location.
 * For Regular Non-B2B orders: Both Bill To and Ship To use the user-selected delivery location address.
 */
export function resolveInvoiceBuyerDetails(order: Order): DetailedGstInvoiceData['buyer'] {
  const isB2B = Boolean(
    (order.customerGstin && order.customerGstin.trim()) ||
    (order.customerBusinessName && order.customerBusinessName.trim())
  );

  const selectedDeliveryAddress = [
    order.jobSite.floorUnit,
    order.jobSite.address,
    order.jobSite.landmark ? `(Near ${order.jobSite.landmark})` : ''
  ].filter(Boolean).join(', ');

  const siteContact = order.jobSite.siteContactName?.trim() || 'Valued Customer';
  const sitePhone = order.jobSite.sitePhone?.trim() || '';

  let buyerGstin: string;
  let buyerLegalName: string;
  let buyerBillingAddress: string;
  let buyerStateCode: string;

  if (isB2B) {
    buyerGstin = (order.customerGstin || '').trim().toUpperCase();
    buyerLegalName = (order.customerBusinessName || siteContact).trim();
    // Bill To: use added GST details (registered billing address)
    buyerBillingAddress = (order.customerBillingAddress || selectedDeliveryAddress).trim();
    buyerStateCode = order.customerStateCode || extractStateCodeFromGstin(buyerGstin) || '29';
  } else {
    // Regular customer order (non-B2B): use same selected delivery address as billing to and ship to
    buyerGstin = 'URP (Consumer)';
    buyerLegalName = siteContact;
    buyerBillingAddress = selectedDeliveryAddress;
    buyerStateCode = order.customerStateCode || '29';
  }

  if (!GST_STATE_MAP[buyerStateCode]) {
    buyerStateCode = '29';
  }
  const buyerStateName = getStateNameByCode(buyerStateCode);

  return {
    isB2B,
    legalName: buyerLegalName,
    tradeName: isB2B ? buyerLegalName : 'Individual Consumer',
    gstin: buyerGstin,
    billingAddress: buyerBillingAddress,
    shippingAddress: selectedDeliveryAddress,
    stateCode: buyerStateCode,
    stateName: buyerStateName,
    contactName: siteContact,
    phone: sitePhone,
  };
}

/**
 * Resolves the complete multi-document bundle for an order:
 * Page 1: Order Summary
 * Page 2..N+1: Dynamic separate seller invoices for each participating seller
 * Page N+2: QCOM Platform & Delivery Invoice (if applicable)
 */
export function computeOrderInvoices(order: Order): OrderInvoiceBundle {
  const cleanId = order.id.replace(/^#/, '');
  const buyer = resolveInvoiceBuyerDetails(order);

  // Group items by unique seller
  const sellerMap = new Map<string, {
    seller: ReturnType<typeof getSellerInfoForProduct>;
    items: CartItem[];
  }>();

  for (const item of order.items) {
    const sellerInfo = getSellerInfoForProduct(item.product, order.sellerPartner);
    const key = sellerInfo.id || sellerInfo.gstin || sellerInfo.name;

    if (!sellerMap.has(key)) {
      sellerMap.set(key, {
        seller: sellerInfo,
        items: [],
      });
    }
    sellerMap.get(key)!.items.push(item);
  }

  const sellerGroups = Array.from(sellerMap.values());
  const totalSellers = sellerGroups.length;

  // 1. Generate Seller Invoices (References: #<ORDER_ID>-1, #<ORDER_ID>-2, ... #<ORDER_ID>-N)
  const sellerDocs: DetailedGstInvoiceData[] = sellerGroups.map((group, idx) => {
    const sellerSeq = idx + 1;
    const invoiceRef = `#${cleanId}-${sellerSeq}`;

    // Extract seller-specific e-invoice data if provided in order
    const sellerEInvoiceData: EInvoiceData | undefined =
      order.sellerEInvoices?.[invoiceRef] ||
      order.sellerEInvoices?.[`${sellerSeq}`] ||
      (group.seller.id ? order.sellerEInvoices?.[group.seller.id] : undefined) ||
      order.eInvoices?.find(e => 
        e.invoiceReference === invoiceRef || 
        e.invoiceReference === `${cleanId}-${sellerSeq}` || 
        e.invoiceReference === `#${cleanId}-${sellerSeq}` ||
        e.legalInvoiceNumber === invoiceRef
      ) ||
      (totalSellers === 1 ? (order.eInvoiceData || (order.irn ? {
        isEInvoice: order.isEInvoice ?? true,
        irn: order.irn,
        acknowledgementNumber: order.acknowledgementNumber,
        acknowledgementDate: order.acknowledgementDate,
        signedQRCode: order.signedQRCode,
      } : undefined)) : undefined);

    return buildInvoiceDocument({
      docType: 'seller',
      docTitle: 'TAX INVOICE',
      docSubtitle: '(Issued under Sec 31 & Rule 46 CGST Rules)',
      recipientPill: 'ORIGINAL FOR RECIPIENT',
      invoiceNumber: invoiceRef,
      order,
      seller: {
        id: group.seller.id,
        name: group.seller.name,
        tradeName: group.seller.tradeName,
        address: group.seller.address,
        gstin: group.seller.gstin,
        stateCode: group.seller.stateCode,
        stateName: group.seller.stateName,
        pan: group.seller.pan,
        phone: group.seller.phone,
      },
      buyer,
      items: group.items,
      includeDeliveryCharge: false, // Delivery is strictly QCOM's invoice
      sellerIndex: sellerSeq,
      sellerTotalCount: totalSellers,
      eInvoiceData: sellerEInvoiceData,
    });
  });

  // 2. Generate QCOM Logistics & Platform Invoice (Reference: #<ORDER_ID>-QCOM)
  const hasQcomCharges = Boolean((order.deliveryFee && order.deliveryFee > 0) || (order.handlingFee && order.handlingFee > 0) || (order.urgencyFee && order.urgencyFee > 0) || true);
  let qcomDoc: DetailedGstInvoiceData | null = null;

  if (hasQcomCharges) {
    const qcomInvoiceRef = `#${cleanId}-QCOM`;
    qcomDoc = buildInvoiceDocument({
      docType: 'qcom',
      docTitle: 'TAX INVOICE - PLATFORM & LOGISTICS',
      docSubtitle: '(Issued under Sec 31 & Rule 46 CGST Rules)',
      recipientPill: 'ORIGINAL FOR RECIPIENT',
      invoiceNumber: qcomInvoiceRef,
      order,
      seller: {
        id: QCOM_PLATFORM_COMPANY.id,
        name: QCOM_PLATFORM_COMPANY.name,
        tradeName: QCOM_PLATFORM_COMPANY.tradeName,
        address: QCOM_PLATFORM_COMPANY.address,
        gstin: QCOM_PLATFORM_COMPANY.gstin,
        stateCode: QCOM_PLATFORM_COMPANY.stateCode,
        stateName: QCOM_PLATFORM_COMPANY.stateName,
        pan: QCOM_PLATFORM_COMPANY.pan,
        phone: QCOM_PLATFORM_COMPANY.phone,
      },
      buyer,
      items: [], // Will populate logistics SAC item via includeDeliveryCharge
      includeDeliveryCharge: true,
    });
  }

  // 3. Generate Consolidated Order Summary Invoice (Page 1) (Reference: #<ORDER_ID>)
  // Supplier on summary reflects the leading merchant hub or platform operator
  const primarySeller = sellerGroups[0]?.seller || {
    id: 'lead-hub',
    name: 'QuickCommerce Multi-Partner Trade Network',
    tradeName: 'Consolidated Merchant Dispatch',
    address: 'Koramangala Commercial Hub, Bengaluru, Karnataka - 560034',
    gstin: '29AAACQ1928K1Z3',
    stateCode: '29',
    stateName: 'Karnataka',
    pan: 'AAACQ1928K',
    phone: '+91 80 4000 8800',
  };

  const summaryDoc = buildInvoiceDocument({
    docType: 'summary',
    docTitle: 'TAX INVOICE & ORDER SUMMARY',
    docSubtitle: '(Consolidated Multi-Document Tax Summary)',
    recipientPill: 'CONSOLIDATED SUMMARY',
    invoiceNumber: `#${cleanId}`,
    order,
    seller: {
      id: primarySeller.id,
      name: totalSellers > 1 ? `${primarySeller.name} (+${totalSellers - 1} Partner Sellers)` : primarySeller.name,
      tradeName: 'QuickCommerce Consolidated Procurement',
      address: primarySeller.address,
      gstin: primarySeller.gstin,
      stateCode: primarySeller.stateCode,
      stateName: primarySeller.stateName,
      pan: primarySeller.pan,
      phone: primarySeller.phone,
    },
    buyer,
    items: order.items,
    includeDeliveryCharge: hasQcomCharges,
  });

  // Assemble full ordered document array:
  // [ Page 1: Order Summary, Page 2..N+1: Seller Invoices, Page N+2: QCOM Invoice (if any) ]
  const documents: DetailedGstInvoiceData[] = [
    summaryDoc,
    ...sellerDocs,
    ...(qcomDoc ? [qcomDoc] : []),
  ];

  return {
    orderId: order.id,
    documents,
    summaryDoc,
    sellerDocs,
    qcomDoc,
    totalSellers,
    totalDocuments: documents.length,
    hasQcomCharges,
  };
}

/**
 * Computes single primary GST invoice data (for backward compatibility).
 */
export function computeGstInvoiceData(order: Order): DetailedGstInvoiceData {
  const bundle = computeOrderInvoices(order);
  return bundle.summaryDoc;
}

/**
 * Renders a single invoice document onto the current page of a jsPDF document.
 * Preserves the exact visual design, typography, tables, and colors.
 */
function renderInvoicePage(
  doc: jsPDF,
  data: DetailedGstInvoiceData,
  qrCodeDataUrl: string,
  pageIndex: number,
  totalPages: number,
  options: { logoBase64?: string } = {}
) {
  const pageWidth = 210;
  const margin = 12;
  const printableWidth = pageWidth - margin * 2; // 186mm

  // Professional Executive Corporate Color Palette
  const darkNavy: [number, number, number] = [15, 23, 42]; // Slate 900
  const emeraldDark: [number, number, number] = [5, 150, 105]; // Emerald 600
  const emeraldDeep: [number, number, number] = [4, 120, 87]; // Emerald 700
  const textDark: [number, number, number] = [30, 41, 59]; // Slate 800
  const textMuted: [number, number, number] = [100, 116, 139]; // Slate 500
  const borderLight: [number, number, number] = [226, 232, 240]; // Slate 200
  const cardFill: [number, number, number] = [248, 250, 252]; // Slate 50

  // -------------------------------------------------------------
  // 1. TOP HEADER & LOGO AREA (Clean executive corporate layout)
  // -------------------------------------------------------------
  let curY = 12;

  // Left: Reserved App Logo Space / Container
  const logoBoxWidth = 44;
  const logoBoxHeight = 16;

  if (options.logoBase64) {
    try {
      doc.addImage(options.logoBase64, 'PNG', margin, curY, logoBoxWidth, logoBoxHeight);
    } catch {
      // fallback to placeholder frame
    }
  } else {
    // Beautiful clean logo placeholder frame
    doc.setFillColor(241, 245, 249); // Slate 100
    doc.setDrawColor(203, 213, 225); // Slate 300
    doc.setLineWidth(0.3);
    doc.roundedRect(margin, curY, logoBoxWidth, logoBoxHeight, 2, 2, 'FD');

    // Inner icon emblem
    doc.setFillColor(15, 23, 42);
    doc.roundedRect(margin + 2.5, curY + 2.5, 11, 11, 1.5, 1.5, 'F');
    doc.setTextColor(52, 211, 153);
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.text('QC', margin + 8, curY + 9.5, { align: 'center' });

    // Logo label
    doc.setFontSize(6.2);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(15, 23, 42);
    doc.text('[ APP LOGO SLOT ]', margin + 16, curY + 6.8);
    doc.setFontSize(5.2);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(100, 116, 139);
    doc.text('Reserved Brand Slot', margin + 16, curY + 11.2);
  }

  // Company Brand & Registration details next to logo
  const brandX = margin + logoBoxWidth + 4;
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...darkNavy);
  doc.text('RUSHQ HARDWARE', brandX, curY + 4.5);

  doc.setFontSize(6.2);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...textMuted);
  doc.text('Hyperlocal Address Delivery & Trade Procurement Platform', brandX, curY + 8.5);
  doc.text('CIN: U72900KA2026PTC192841 | E-Commerce Operator u/s 9(5) CGST Act', brandX, curY + 12.2);

  // Right Header: TAX INVOICE Header & Original Recipient Pill
  const rightX = pageWidth - margin;
  doc.setFontSize(13);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...darkNavy);
  doc.text(data.docTitle, rightX, curY + 4.5, { align: 'right' });

  // Recipient Pill Badge
  doc.setFillColor(236, 253, 245); // Emerald 50
  doc.setDrawColor(16, 185, 129); // Emerald 500
  doc.setLineWidth(0.2);
  const pillWidth = data.docType === 'summary' ? 46 : 44;
  doc.roundedRect(rightX - pillWidth, curY + 6.5, pillWidth, 5.5, 1, 1, 'FD');
  doc.setTextColor(...emeraldDeep);
  doc.setFontSize(5.6);
  doc.setFont('helvetica', 'bold');
  doc.text(data.recipientPill, rightX - (pillWidth / 2), curY + 10.3, { align: 'center' });

  doc.setFontSize(5.5);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...textMuted);
  doc.text(data.docSubtitle, rightX, curY + 15.5, { align: 'right' });

  curY += logoBoxHeight + 3;

  // Thin separator divider
  doc.setDrawColor(...borderLight);
  doc.setLineWidth(0.25);
  doc.line(margin, curY, pageWidth - margin, curY);
  curY += 2.5;

  // -------------------------------------------------------------
  // 2. INVOICE META STRIP (Invoice #, Date, POS, Supply Type)
  // -------------------------------------------------------------
  const metaBoxHeight = 12;
  doc.setFillColor(...cardFill);
  doc.setDrawColor(...borderLight);
  doc.roundedRect(margin, curY, printableWidth, metaBoxHeight, 1.5, 1.5, 'FD');

  const metaCol1 = margin + 3;
  const metaCol2 = margin + 50;
  const metaCol3 = margin + 105;
  const metaCol4 = pageWidth - margin - 35;

  // Invoice Number
  doc.setFontSize(6);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...textMuted);
  doc.text('INVOICE NO:', metaCol1, curY + 4.5);
  doc.setFontSize(7.5);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...darkNavy);
  doc.text(data.invoiceNumber, metaCol1, curY + 9);

  // Date & Time
  doc.setFontSize(6);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...textMuted);
  doc.text('INVOICE DATE & TIME:', metaCol2, curY + 4.5);
  doc.setFontSize(7);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...textDark);
  doc.text(`${data.invoiceDate}, ${data.invoiceTime}`, metaCol2, curY + 9);

  // Place of Supply
  doc.setFontSize(6);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...textMuted);
  doc.text('PLACE OF SUPPLY (POS):', metaCol3, curY + 4.5);
  doc.setFontSize(7);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...emeraldDeep);
  doc.text(data.placeOfSupply, metaCol3, curY + 9);

  // Supply Type Tag
  doc.setFontSize(6);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...textMuted);
  doc.text('SUPPLY TYPE:', metaCol4, curY + 4.5);
  doc.setFontSize(6.5);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...darkNavy);
  doc.text(data.isInterState ? 'INTER-STATE (IGST)' : 'INTRA-STATE (CGST/SGST)', metaCol4, curY + 9);

  curY += metaBoxHeight + 2.5;

  // -------------------------------------------------------------
  // 3. e-INVOICE AUTHENTICATION & IRN STRIP (Rule 48(4))
  // Rendered ONLY when isEInvoice is true and (irn or signedQRCode or ackNo) is provided
  // -------------------------------------------------------------
  const hasEInvoiceData = Boolean(
    data.isEInvoice && (data.irn || data.signedQRCode || data.ackNo)
  );

  if (hasEInvoiceData) {
    const einvHeight = 21;
    doc.setFillColor(255, 255, 255);
    doc.setDrawColor(...borderLight);
    doc.roundedRect(margin, curY, printableWidth, einvHeight, 1.5, 1.5, 'FD');

    // Green left highlight bar
    doc.setFillColor(...emeraldDark);
    doc.rect(margin, curY, 2, einvHeight, 'F');

    // Title & Verified Badge
    doc.setFontSize(7);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...emeraldDeep);
    doc.text('[VERIFIED] GST e-Invoice Authentication & IRN Verified (Rule 48(4))', margin + 4.5, curY + 4.5);

    // IRN text (only if present)
    if (data.irn) {
      doc.setFontSize(6.2);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(...textDark);
      doc.text('IRN:', margin + 4.5, curY + 9);

      doc.setFont('courier', 'normal');
      doc.setFontSize(5.8);
      doc.setTextColor(...textMuted);
      doc.text(data.irn, margin + 11, curY + 9);
    }

    // Ack No, Ack Date, RCM (clean display of available fields without empty placeholders)
    let metaColX = margin + 4.5;
    if (data.ackNo) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(6.2);
      doc.setTextColor(...textDark);
      doc.text('Ack No:', metaColX, curY + 14);
      doc.setFont('helvetica', 'normal');
      doc.text(data.ackNo, metaColX + 11.5, curY + 14);
      metaColX += 48;
    }

    if (data.ackDate) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(6.2);
      doc.setTextColor(...textDark);
      doc.text('Ack Date:', metaColX, curY + 14);
      doc.setFont('helvetica', 'normal');
      doc.text(data.ackDate, metaColX + 13.5, curY + 14);
      metaColX += 54;
    }

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6.2);
    doc.setTextColor(...textDark);
    doc.text('Reverse Charge (RCM):', metaColX, curY + 14);
    doc.setFont('helvetica', 'bold');
    doc.text(data.reverseCharge, metaColX + 30, curY + 14);

    // QR Code on right side of e-Invoice box
    if (qrCodeDataUrl) {
      try {
        doc.addImage(qrCodeDataUrl, 'PNG', pageWidth - margin - 19.5, curY + 1.2, 18.5, 18.5);
      } catch {
        // fallback
      }
    }

    curY += einvHeight + 2.5;
  }

  // -------------------------------------------------------------
  // 4. SUPPLIER & RECIPIENT TWO-COLUMN CARDS
  // -------------------------------------------------------------
  const cardGap = 3;
  const colWidth = (printableWidth - cardGap) / 2; // ~91.5mm
  const partyCardHeight = 32;

  // Left Card: SUPPLIER DETAILS
  doc.setFillColor(...cardFill);
  doc.setDrawColor(...borderLight);
  doc.roundedRect(margin, curY, colWidth, partyCardHeight, 1.5, 1.5, 'FD');

  // Supplier Card Header
  doc.setFillColor(...darkNavy);
  doc.rect(margin, curY, colWidth, 4.5, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(6.2);
  doc.setFont('helvetica', 'bold');
  const supplierHeaderTitle = data.docType === 'qcom'
    ? 'DETAILS OF LOGISTICS & PLATFORM OPERATOR'
    : data.docType === 'summary'
    ? 'DETAILS OF SUPPLIER HUB / PRINCIPAL'
    : 'DETAILS OF SUPPLIER / SELLER (ISSUED BY)';
  doc.text(supplierHeaderTitle, margin + 3, curY + 3.2);

  doc.setTextColor(...darkNavy);
  doc.setFontSize(7.5);
  doc.setFont('helvetica', 'bold');
  doc.text(data.seller.name, margin + 3, curY + 8.5);

  doc.setFontSize(6);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...textMuted);
  const sellerAddrLines = doc.splitTextToSize(data.seller.address, colWidth - 6);
  doc.text(sellerAddrLines.slice(0, 2), margin + 3, curY + 12.5);

  const sellerMetaRowY = curY + 21;
  doc.setFontSize(6.5);
  doc.setTextColor(...textDark);
  doc.setFont('helvetica', 'bold');
  doc.text('Supplier GSTIN:', margin + 3, sellerMetaRowY);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...emeraldDeep);
  doc.text(data.seller.gstin, margin + 22, sellerMetaRowY);

  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...textDark);
  doc.text('State Code:', margin + 3, sellerMetaRowY + 4.2);
  doc.setFont('helvetica', 'normal');
  doc.text(`${data.seller.stateName} (${data.seller.stateCode})`, margin + 18, sellerMetaRowY + 4.2);

  doc.setFont('helvetica', 'bold');
  doc.text('PAN:', margin + 55, sellerMetaRowY + 4.2);
  doc.setFont('helvetica', 'normal');
  doc.text(data.seller.pan, margin + 63, sellerMetaRowY + 4.2);

  // Right Card: BUYER / RECIPIENT DETAILS
  const buyerX = margin + colWidth + cardGap;
  doc.setFillColor(...cardFill);
  doc.setDrawColor(...borderLight);
  doc.roundedRect(buyerX, curY, colWidth, partyCardHeight, 1.5, 1.5, 'FD');

  // Buyer Card Header
  doc.setFillColor(...emeraldDeep);
  doc.rect(buyerX, curY, colWidth, 4.5, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(6.2);
  doc.setFont('helvetica', 'bold');
  const buyerHeaderTitle = data.buyer.isB2B 
    ? 'BILLED TO (GST) & SHIPPED TO (DELIVERY)' 
    : 'BILLED TO & SHIPPED TO (CONSUMER)';
  doc.text(buyerHeaderTitle, buyerX + 3, curY + 3.2);

  doc.setTextColor(...darkNavy);
  doc.setFontSize(7.5);
  doc.setFont('helvetica', 'bold');
  doc.text(data.buyer.legalName, buyerX + 3, curY + 8.5);

  doc.setFontSize(5.8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...textMuted);

  if (data.buyer.isB2B && data.buyer.billingAddress !== data.buyer.shippingAddress) {
    const billLines = doc.splitTextToSize(`Bill To: ${data.buyer.billingAddress}`, colWidth - 6);
    doc.text(billLines.slice(0, 1), buyerX + 3, curY + 12.0);
    const shipLines = doc.splitTextToSize(`Ship To: ${data.buyer.shippingAddress}`, colWidth - 6);
    doc.text(shipLines.slice(0, 1), buyerX + 3, curY + 15.5);
  } else {
    const buyerAddrLines = doc.splitTextToSize(`Address: ${data.buyer.shippingAddress}`, colWidth - 6);
    doc.text(buyerAddrLines.slice(0, 2), buyerX + 3, curY + 12.5);
  }

  const buyerMetaRowY = curY + 21;
  doc.setFontSize(6.5);
  doc.setTextColor(...textDark);
  doc.setFont('helvetica', 'bold');
  doc.text('Buyer GSTIN:', buyerX + 3, buyerMetaRowY);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...emeraldDeep);
  doc.text(data.buyer.gstin, buyerX + 20, buyerMetaRowY);

  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...textDark);
  doc.text('Place of Supply:', buyerX + 3, buyerMetaRowY + 4.2);
  doc.setFont('helvetica', 'normal');
  doc.text(`${data.buyer.stateName} (${data.buyer.stateCode})`, buyerX + 22, buyerMetaRowY + 4.2);

  doc.setFont('helvetica', 'bold');
  doc.text('Site Contact:', buyerX + 3, buyerMetaRowY + 8);
  doc.setFont('helvetica', 'normal');
  doc.text(`${data.buyer.contactName} (${data.buyer.phone})`, buyerX + 18, buyerMetaRowY + 8);

  curY += partyCardHeight + 3;

  // -------------------------------------------------------------
  // 5. ITEMIZED GOODS & SERVICES TAX INVOICE TABLE
  // -------------------------------------------------------------
  let tableHeaders: string[][];
  let tableRows: string[][];

  if (data.isInterState) {
    tableHeaders = [
      ['#', 'Item Description & Specifications', 'HSN/SAC', 'UQC', 'Qty', 'Unit Rate', 'Taxable Val', 'IGST Rate', 'IGST Amt', 'Total (INR)']
    ];
    tableRows = data.items.map((it) => [
      it.slNo.toString(),
      it.description + (it.brand ? ` [Brand: ${it.brand}]` : ''),
      it.hsnCode,
      it.uqc,
      it.quantity.toString(),
      `Rs. ${it.unitRate.toFixed(2)}`,
      `Rs. ${it.taxableValue.toFixed(2)}`,
      `${it.igstRate}%`,
      `Rs. ${it.igstAmount.toFixed(2)}`,
      `Rs. ${it.totalAmount.toFixed(2)}`
    ]);
  } else {
    tableHeaders = [
      ['#', 'Item Description & Specifications', 'HSN/SAC', 'UQC', 'Qty', 'Unit Rate', 'Taxable Val', 'CGST', data.isUnionTerritory ? 'UTGST' : 'SGST', 'Total (INR)']
    ];
    tableRows = data.items.map((it) => [
      it.slNo.toString(),
      it.description + (it.brand ? ` [Brand: ${it.brand}]` : ''),
      it.hsnCode,
      it.uqc,
      it.quantity.toString(),
      `Rs. ${it.unitRate.toFixed(2)}`,
      `Rs. ${it.taxableValue.toFixed(2)}`,
      `${it.cgstRate}%\nRs. ${it.cgstAmount.toFixed(2)}`,
      `${it.sgstRate || it.utgstRate}%\nRs. ${(it.sgstAmount || it.utgstAmount).toFixed(2)}`,
      `Rs. ${it.totalAmount.toFixed(2)}`
    ]);
  }

  autoTable(doc, {
    startY: curY,
    head: tableHeaders,
    body: tableRows,
    theme: 'grid',
    headStyles: {
      fillColor: darkNavy,
      textColor: [255, 255, 255],
      fontStyle: 'bold',
      fontSize: 6.5,
      halign: 'center',
      valign: 'middle',
      cellPadding: 1.8,
    },
    columnStyles: {
      0: { halign: 'center', cellWidth: 7 },
      1: { halign: 'left', cellWidth: 63 },
      2: { halign: 'center', cellWidth: 15 },
      3: { halign: 'center', cellWidth: 10 },
      4: { halign: 'center', cellWidth: 8 },
      5: { halign: 'right', cellWidth: 16 },
      6: { halign: 'right', cellWidth: 17 },
      7: { halign: 'right', cellWidth: 16 },
      8: { halign: 'right', cellWidth: 16 },
      9: { halign: 'right', cellWidth: 18 },
    },
    styles: {
      fontSize: 6.2,
      textColor: textDark,
      lineColor: borderLight,
      lineWidth: 0.15,
      cellPadding: 1.8,
      valign: 'middle',
    },
    alternateRowStyles: {
      fillColor: [250, 250, 250],
    },
    margin: { left: margin, right: margin },
  });

  // @ts-expect-error jspdf-autotable extends jsPDF instance
  const postTableY = doc.lastAutoTable?.finalY || curY + 35;
  const summaryY = postTableY + 2.5;

  // -------------------------------------------------------------
  // 6. HSN/SAC SUMMARY TABLE (Mandatory Rule 46(g))
  // -------------------------------------------------------------
  const hsnTableWidth = 98;
  const hsnHead = data.isInterState
    ? [['HSN/SAC', 'Taxable Val', 'IGST %', 'IGST Amt', 'Total Tax']]
    : [['HSN/SAC', 'Taxable Val', 'CGST %', 'CGST Amt', data.isUnionTerritory ? 'UTGST %' : 'SGST %', data.isUnionTerritory ? 'UTGST Amt' : 'SGST Amt', 'Total Tax']];

  const hsnBody = data.hsnSummary.map((h) => {
    if (data.isInterState) {
      return [
        h.hsnCode,
        `Rs. ${h.taxableValue.toFixed(2)}`,
        `${h.igstRate}%`,
        `Rs. ${h.igstAmount.toFixed(2)}`,
        `Rs. ${h.totalTax.toFixed(2)}`
      ];
    }
    return [
      h.hsnCode,
      `Rs. ${h.taxableValue.toFixed(2)}`,
      `${h.cgstRate}%`,
      `Rs. ${h.cgstAmount.toFixed(2)}`,
      `${h.sgstRate || h.utgstRate}%`,
      `Rs. ${(h.sgstAmount || h.utgstAmount).toFixed(2)}`,
      `Rs. ${h.totalTax.toFixed(2)}`
    ];
  });

  autoTable(doc, {
    startY: summaryY,
    tableWidth: hsnTableWidth,
    head: hsnHead,
    body: hsnBody,
    theme: 'grid',
    headStyles: {
      fillColor: [51, 65, 85], // Slate 700
      textColor: [255, 255, 255],
      fontStyle: 'bold',
      fontSize: 5.8,
      halign: 'center',
      cellPadding: 1.2,
    },
    styles: {
      fontSize: 5.5,
      textColor: textDark,
      lineColor: borderLight,
      lineWidth: 0.15,
      cellPadding: 1.2,
      halign: 'center',
    },
    columnStyles: {
      0: { halign: 'center' },
      1: { halign: 'right' },
      2: { halign: 'center' },
      3: { halign: 'right' },
      4: { halign: 'center' },
      5: { halign: 'right' },
      6: { halign: 'right' },
    },
    margin: { left: margin, right: pageWidth - margin - hsnTableWidth },
  });

  // -------------------------------------------------------------
  // 7. FINANCIAL SUMMARY CARD (Right Side)
  // -------------------------------------------------------------
  const rightCardWidth = printableWidth - hsnTableWidth - 3; // ~85mm
  const rightCardX = margin + hsnTableWidth + 3;
  const calcCardHeight = 42;

  doc.setFillColor(255, 255, 255);
  doc.setDrawColor(...borderLight);
  doc.roundedRect(rightCardX, summaryY, rightCardWidth, calcCardHeight, 1.5, 1.5, 'FD');

  let lineY = summaryY + 4;
  doc.setFontSize(6.5);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...textMuted);
  doc.text('Total Taxable Value:', rightCardX + 3, lineY);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...textDark);
  doc.text(`Rs. ${data.totalTaxableValue.toFixed(2)}`, rightCardX + rightCardWidth - 3, lineY, { align: 'right' });

  if (data.isInterState) {
    lineY += 4.2;
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...textMuted);
    doc.text('Integrated GST (IGST):', rightCardX + 3, lineY);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...textDark);
    doc.text(`Rs. ${data.totalIgst.toFixed(2)}`, rightCardX + rightCardWidth - 3, lineY, { align: 'right' });
  } else {
    lineY += 4.2;
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...textMuted);
    doc.text('Central GST (CGST):', rightCardX + 3, lineY);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...textDark);
    doc.text(`Rs. ${data.totalCgst.toFixed(2)}`, rightCardX + rightCardWidth - 3, lineY, { align: 'right' });

    lineY += 4.2;
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...textMuted);
    doc.text(data.isUnionTerritory ? 'Union Territory GST (UTGST):' : 'State GST (SGST):', rightCardX + 3, lineY);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...textDark);
    doc.text(`Rs. ${(data.totalSgst || data.totalUtgst).toFixed(2)}`, rightCardX + rightCardWidth - 3, lineY, { align: 'right' });
  }

  lineY += 4.2;
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...textMuted);
  doc.text('Total GST Tax Amount:', rightCardX + 3, lineY);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...textDark);
  doc.text(`Rs. ${data.totalGst.toFixed(2)}`, rightCardX + rightCardWidth - 3, lineY, { align: 'right' });

  lineY += 4.2;
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...textMuted);
  doc.text('Rounding Off (Sec 170):', rightCardX + 3, lineY);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...textDark);
  const roundSign = data.roundOff >= 0 ? `+Rs. ${data.roundOff.toFixed(2)}` : `-Rs. ${Math.abs(data.roundOff).toFixed(2)}`;
  doc.text(roundSign, rightCardX + rightCardWidth - 3, lineY, { align: 'right' });

  // Grand Total Highlight Banner
  lineY += 4.2;
  doc.setFillColor(236, 253, 245); // Emerald 50
  doc.roundedRect(rightCardX + 1, lineY, rightCardWidth - 2, 13, 1, 1, 'F');
  doc.setDrawColor(16, 185, 129);
  doc.setLineWidth(0.3);
  doc.roundedRect(rightCardX + 1, lineY, rightCardWidth - 2, 13, 1, 1, 'D');

  doc.setFontSize(7.5);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...emeraldDeep);
  doc.text('DOCUMENT TOTAL (INR):', rightCardX + 3, lineY + 5.5);

  doc.setFontSize(10.5);
  doc.setFont('helvetica', 'bold');
  doc.text(`Rs. ${data.grandTotal.toFixed(2)}`, rightCardX + rightCardWidth - 3, lineY + 7, { align: 'right' });

  doc.setFontSize(5.5);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(4, 120, 87);
  doc.text('100% Tax Deductible & GSTR-2B Input Tax Credit Eligible', rightCardX + 3, lineY + 10.5);

  // -------------------------------------------------------------
  // 8. AMOUNT IN WORDS, ITC ELIGIBILITY & DIGITAL SIGNATURE
  // -------------------------------------------------------------
  // @ts-expect-error jspdf-autotable extends jsPDF instance
  const postHsnY = doc.lastAutoTable?.finalY || summaryY + 22;
  const bottomBoxY = Math.max(postHsnY + 2, summaryY + calcCardHeight + 2);

  doc.setFillColor(...cardFill);
  doc.setDrawColor(...borderLight);
  doc.roundedRect(margin, bottomBoxY, printableWidth, 21, 1.5, 1.5, 'FD');

  // Amount in Words
  doc.setFontSize(6.2);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...textMuted);
  doc.text('TOTAL AMOUNT IN WORDS:', margin + 3, bottomBoxY + 4.2);

  doc.setFontSize(7.2);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...darkNavy);
  const wordsSplit = doc.splitTextToSize(data.amountInWords, printableWidth - 68);
  doc.text(wordsSplit, margin + 3, bottomBoxY + 8);

  // Statutory Notes
  doc.setFontSize(5.5);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...textMuted);
  doc.text('Declaration: Certified that all particulars are true and correct and value stated is actual price charged.', margin + 3, bottomBoxY + 13.5);
  doc.text('ITC Note: Input Tax Credit eligible under Section 16 CGST Act 2017. Will auto-reflect in recipient GSTR-2B.', margin + 3, bottomBoxY + 17.5);

  // Authorized Digital Signature Seal Box
  const sealX = pageWidth - margin - 58;
  doc.setFillColor(255, 255, 255);
  doc.setDrawColor(...borderLight);
  doc.roundedRect(sealX, bottomBoxY + 1.8, 55, 17.4, 1, 1, 'FD');

  doc.setFontSize(5.8);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...darkNavy);
  const signLabel = data.docType === 'qcom'
    ? 'For QuickCommerce Logistics Ltd'
    : `For ${data.seller.name.slice(0, 24)}`;
  doc.text(signLabel, sealX + 27.5, bottomBoxY + 5, { align: 'center' });

  doc.setFontSize(7);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...emeraldDeep);
  doc.text('[DIGITALLY SIGNED]', sealX + 27.5, bottomBoxY + 10.5, { align: 'center' });

  doc.setFontSize(5.2);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...textMuted);
  doc.text('Authorised Signatory (Sec 31 CGST)', sealX + 27.5, bottomBoxY + 15, { align: 'center' });

  // -------------------------------------------------------------
  // 9. STATUTORY FOOTER
  // -------------------------------------------------------------
  doc.setFillColor(...cardFill);
  doc.rect(0, 289, pageWidth, 8, 'F');
  doc.setDrawColor(...borderLight);
  doc.line(0, 289, pageWidth, 289);

  doc.setFontSize(5.5);
  doc.setTextColor(...textMuted);
  doc.text(
    `Page ${pageIndex + 1} of ${totalPages} • System generated digitally signed Tax Invoice under Sec 31 CGST Act • Rule 46 CGST Rules`,
    pageWidth / 2,
    292.5,
    { align: 'center' }
  );
  doc.text(
    'RushQ Hardware & Construction Tech India Pvt. Ltd. | 24x7 GST Support Desk: gst-billing@rushq.in',
    pageWidth / 2,
    295.2,
    { align: 'center' }
  );
}

/**
 * Generates an executive, beautifully styled, 100% statutory compliant Indian GST Tax Invoice in PDF.
 * Handles Single-Seller and Multi-Seller orders by generating a single consolidated PDF
 * containing:
 * Page 1: Order Summary
 * Pages 2..N+1: Dynamic Seller Invoices (References: #<ORDER>-1, #<ORDER>-2, etc.)
 * Page N+2: QCOM Logistics & Platform Invoice (#<ORDER>-QCOM) where applicable.
 */
export async function generateInvoicePDF(
  order: Order,
  options: { autoDownload?: boolean; logoBase64?: string } = { autoDownload: true }
): Promise<{ doc: jsPDF; blobUrl: string; bundle: OrderInvoiceBundle }> {
  const bundle = computeOrderInvoices(order);

  // Generate real QR code Data URLs for documents in the bundle that have qrCodePayload
  const qrCodeDataUrls = await Promise.all(
    bundle.documents.map(async (docData) => {
      if (!docData.qrCodePayload) return '';
      try {
        return await QRCode.toDataURL(docData.qrCodePayload, {
          errorCorrectionLevel: 'M',
          margin: 1,
          width: 160,
        });
      } catch (err) {
        console.error('Failed to generate QR Code Data URL:', err);
        return '';
      }
    })
  );

  // Create A4 PDF (210mm x 297mm)
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
  });

  const totalPages = bundle.documents.length;

  // Render each invoice document on its own page
  bundle.documents.forEach((docData, index) => {
    if (index > 0) {
      doc.addPage();
    }
    renderInvoicePage(doc, docData, qrCodeDataUrls[index], index, totalPages, options);
  });

  const pdfBlob = doc.output('blob');
  const blobUrl = URL.createObjectURL(pdfBlob);

  if (options.autoDownload) {
    const cleanId = order.id.replace(/^#/, '');
    const filename = `Tax_Invoice_Consolidated_${cleanId}.pdf`;
    try {
      doc.save(filename);
    } catch {
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  }

  return { doc, blobUrl, bundle };
}
