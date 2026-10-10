export interface GstStateInfo {
  code: string;
  name: string;
  isUnionTerritoryWithoutLegislature?: boolean;
}

export const INDIAN_GST_STATES: GstStateInfo[] = [
  { code: '01', name: 'Jammu and Kashmir' },
  { code: '02', name: 'Himachal Pradesh' },
  { code: '03', name: 'Punjab' },
  { code: '04', name: 'Chandigarh', isUnionTerritoryWithoutLegislature: true },
  { code: '05', name: 'Uttarakhand' },
  { code: '06', name: 'Haryana' },
  { code: '07', name: 'Delhi' },
  { code: '08', name: 'Rajasthan' },
  { code: '09', name: 'Uttar Pradesh' },
  { code: '10', name: 'Bihar' },
  { code: '11', name: 'Sikkim' },
  { code: '12', name: 'Arunachal Pradesh' },
  { code: '13', name: 'Nagaland' },
  { code: '14', name: 'Manipur' },
  { code: '15', name: 'Mizoram' },
  { code: '16', name: 'Tripura' },
  { code: '17', name: 'Meghalaya' },
  { code: '18', name: 'Assam' },
  { code: '19', name: 'West Bengal' },
  { code: '20', name: 'Jharkhand' },
  { code: '21', name: 'Odisha' },
  { code: '22', name: 'Chhattisgarh' },
  { code: '23', name: 'Madhya Pradesh' },
  { code: '24', name: 'Gujarat' },
  { code: '26', name: 'Dadra & Nagar Haveli and Daman & Diu', isUnionTerritoryWithoutLegislature: true },
  { code: '27', name: 'Maharashtra' },
  { code: '29', name: 'Karnataka' },
  { code: '30', name: 'Goa' },
  { code: '31', name: 'Lakshadweep', isUnionTerritoryWithoutLegislature: true },
  { code: '32', name: 'Kerala' },
  { code: '33', name: 'Tamil Nadu' },
  { code: '34', name: 'Puducherry' },
  { code: '35', name: 'Andaman and Nicobar Islands', isUnionTerritoryWithoutLegislature: true },
  { code: '36', name: 'Telangana' },
  { code: '37', name: 'Andhra Pradesh' },
  { code: '38', name: 'Ladakh', isUnionTerritoryWithoutLegislature: true },
  { code: '97', name: 'Other Territory', isUnionTerritoryWithoutLegislature: true },
];

export const GST_STATE_MAP: Record<string, GstStateInfo> = INDIAN_GST_STATES.reduce((acc, state) => {
  acc[state.code] = state;
  return acc;
}, {} as Record<string, GstStateInfo>);

// Extract 2-digit state code from 15-character GSTIN
export function extractStateCodeFromGstin(gstin: string): string | null {
  if (!gstin) return null;
  const clean = gstin.trim().toUpperCase();
  if (clean.length >= 2) {
    const prefix = clean.slice(0, 2);
    if (/^\d{2}$/.test(prefix) && GST_STATE_MAP[prefix]) {
      return prefix;
    }
  }
  return null;
}

export function getStateNameByCode(code: string): string {
  if (!code) return 'Karnataka';
  const clean = code.padStart(2, '0');
  return GST_STATE_MAP[clean]?.name || 'Karnataka';
}

export function isValidGstinFormat(gstin: string): boolean {
  if (!gstin) return false;
  return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(gstin.trim().toUpperCase());
}

export interface ItemGstCalculation {
  productId: string;
  name: string;
  hsnCode: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  gstRatePercent: number;
  taxableValue: number;
  totalTax: number;
  cgst: number;
  sgst: number;
  utgst: number;
  igst: number;
}

export interface GstSlabSummary {
  gstRatePercent: number;
  taxableValue: number;
  cgst: number;
  sgst: number;
  utgst: number;
  igst: number;
  totalTax: number;
}

export interface OrderGstCalculationResult {
  isB2B: boolean;
  buyerGstin?: string;
  buyerBusinessName?: string;
  buyerAddress?: string;
  buyerStateCode: string;
  buyerState: string;
  buyerPincode?: string;
  sellerGstin: string;
  sellerStateCode: string;
  sellerState: string;
  isInterState: boolean;
  isUnionTerritory: boolean;
  placeOfSupply: string;
  supplyType: 'INTRA-STATE (CGST + SGST)' | 'INTRA-STATE (CGST + UTGST)' | 'INTER-STATE (IGST)';
  totalTaxableValue: number;
  totalCgst: number;
  totalSgst: number;
  totalUtgst: number;
  totalIgst: number;
  totalGst: number;
  totalInvoiceAmount: number;
  items: ItemGstCalculation[];
  slabSummaries: GstSlabSummary[];
}

export function getProductHsnCode(category: string, subcategory?: string): string {
  const cat = (category || '').toLowerCase();
  if (cat.includes('plumb') || cat.includes('valve')) return '8481';
  if (cat.includes('elec') || cat.includes('wire') || cat.includes('switch')) return '8536';
  if (cat.includes('fast') || cat.includes('screw') || cat.includes('anchor')) return '7318';
  if (cat.includes('tool') || cat.includes('cutter') || cat.includes('disc')) return '8207';
  if (cat.includes('adhes') || cat.includes('foam')) return '3506';
  if (cat.includes('safety')) return '6506';
  if (cat.includes('fan')) return '8414';
  if (cat.includes('light')) return '9405';
  if (cat.includes('bath') || cat.includes('kitchen')) return '8481';
  return '8481';
}

/**
 * Calculates complete state-wise GST distribution (CGST/SGST/UTGST/IGST)
 * according to Indian GST Law with dynamic per-product rates.
 */
export function calculateOrderGstDistribution(params: {
  items: {
    product: {
      id: string;
      name: string;
      category?: string;
      subcategory?: string;
      price: number;
      gstRatePercent?: number;
      sellerGstin?: string;
      isGstRegistered?: boolean;
    };
    quantity: number;
  }[];
  buyerGstin?: string;
  buyerBusinessName?: string;
  buyerAddress?: string;
  buyerStateCode?: string;
  buyerState?: string;
  buyerPincode?: string;
  sellerGstin?: string;
  sellerStateCode?: string;
  deliveryFee?: number;
  handlingFee?: number;
  discount?: number;
}): OrderGstCalculationResult {
  const {
    items,
    buyerGstin,
    buyerBusinessName,
    buyerAddress,
    buyerPincode,
    deliveryFee = 0,
    handlingFee = 0,
    discount = 0
  } = params;

  // 1. Determine Seller State Code (Default Karnataka '29' if not provided)
  const defaultSellerGstin = params.sellerGstin || items[0]?.product?.sellerGstin || '29AABCS8812K1ZM';
  const sellerStateCode = params.sellerStateCode || extractStateCodeFromGstin(defaultSellerGstin) || '29';
  const sellerState = getStateNameByCode(sellerStateCode);

  // 2. Determine Buyer State Code (From GSTIN or explicitly provided state code)
  let buyerStateCode = params.buyerStateCode;
  if (!buyerStateCode && buyerGstin) {
    buyerStateCode = extractStateCodeFromGstin(buyerGstin) || '29';
  }
  if (!buyerStateCode) {
    buyerStateCode = '29'; // Default Karnataka
  }
  const buyerState = params.buyerState || getStateNameByCode(buyerStateCode);

  // 3. Compare Origin (Seller) vs Destination (Buyer / POS)
  const isInterState = sellerStateCode !== buyerStateCode;
  const buyerStateObj = GST_STATE_MAP[buyerStateCode];
  const isUnionTerritory = !isInterState && Boolean(buyerStateObj?.isUnionTerritoryWithoutLegislature);

  let supplyType: OrderGstCalculationResult['supplyType'];
  if (isInterState) {
    supplyType = 'INTER-STATE (IGST)';
  } else if (isUnionTerritory) {
    supplyType = 'INTRA-STATE (CGST + UTGST)';
  } else {
    supplyType = 'INTRA-STATE (CGST + SGST)';
  }

  const placeOfSupply = `${buyerStateCode} - ${buyerState.toUpperCase()}`;

  // 4. Calculate item-by-item GST based on dynamic product rates
  const calculatedItems: ItemGstCalculation[] = [];
  const slabMap: Record<number, { taxable: number; totalTax: number; cgst: number; sgst: number; utgst: number; igst: number }> = {};

  let totalTaxableValue = 0;
  let totalCgst = 0;
  let totalSgst = 0;
  let totalUtgst = 0;
  let totalIgst = 0;
  let totalGst = 0;
  let totalItemsGross = 0;

  for (const item of items) {
    const qty = Math.max(1, item.quantity);
    const unitPrice = item.product.price;
    const lineGross = unitPrice * qty;
    totalItemsGross += lineGross;

    // Dynamic rate from product listing (default 18 if undefined)
    const rate = typeof item.product.gstRatePercent === 'number' ? item.product.gstRatePercent : 18;
    const hsnCode = getProductHsnCode(item.product.category || '', item.product.subcategory);

    // In retail pricing, prices are inclusive of GST
    const taxableValue = Math.round((lineGross / (1 + rate / 100)) * 100) / 100;
    const lineTax = Math.round((lineGross - taxableValue) * 100) / 100;

    let itemCgst = 0;
    let itemSgst = 0;
    let itemUtgst = 0;
    let itemIgst = 0;

    if (isInterState) {
      itemIgst = lineTax;
    } else if (isUnionTerritory) {
      itemCgst = Math.round((lineTax / 2) * 100) / 100;
      itemUtgst = Math.round((lineTax - itemCgst) * 100) / 100;
    } else {
      itemCgst = Math.round((lineTax / 2) * 100) / 100;
      itemSgst = Math.round((lineTax - itemCgst) * 100) / 100;
    }

    totalTaxableValue += taxableValue;
    totalCgst += itemCgst;
    totalSgst += itemSgst;
    totalUtgst += itemUtgst;
    totalIgst += itemIgst;
    totalGst += lineTax;

    // Aggregate by tax slab
    if (!slabMap[rate]) {
      slabMap[rate] = { taxable: 0, totalTax: 0, cgst: 0, sgst: 0, utgst: 0, igst: 0 };
    }
    slabMap[rate].taxable += taxableValue;
    slabMap[rate].totalTax += lineTax;
    slabMap[rate].cgst += itemCgst;
    slabMap[rate].sgst += itemSgst;
    slabMap[rate].utgst += itemUtgst;
    slabMap[rate].igst += itemIgst;

    calculatedItems.push({
      productId: item.product.id,
      name: item.product.name,
      hsnCode,
      quantity: qty,
      unitPrice,
      lineTotal: lineGross,
      gstRatePercent: rate,
      taxableValue,
      totalTax: lineTax,
      cgst: itemCgst,
      sgst: itemSgst,
      utgst: itemUtgst,
      igst: itemIgst,
    });
  }

  // Build slab summary array sorted by rate
  const slabSummaries: GstSlabSummary[] = Object.keys(slabMap)
    .map(Number)
    .sort((a, b) => a - b)
    .map((rate) => {
      const slab = slabMap[rate];
      return {
        gstRatePercent: rate,
        taxableValue: Math.round(slab.taxable * 100) / 100,
        cgst: Math.round(slab.cgst * 100) / 100,
        sgst: Math.round(slab.sgst * 100) / 100,
        utgst: Math.round(slab.utgst * 100) / 100,
        igst: Math.round(slab.igst * 100) / 100,
        totalTax: Math.round(slab.totalTax * 100) / 100,
      };
    });

  const totalInvoiceAmount = Math.max(0, totalItemsGross - discount + deliveryFee + handlingFee);

  return {
    isB2B: Boolean(buyerGstin),
    buyerGstin,
    buyerBusinessName,
    buyerAddress,
    buyerStateCode,
    buyerState,
    buyerPincode,
    sellerGstin: defaultSellerGstin,
    sellerStateCode,
    sellerState,
    isInterState,
    isUnionTerritory,
    placeOfSupply,
    supplyType,
    totalTaxableValue: Math.round(totalTaxableValue * 100) / 100,
    totalCgst: Math.round(totalCgst * 100) / 100,
    totalSgst: Math.round(totalSgst * 100) / 100,
    totalUtgst: Math.round(totalUtgst * 100) / 100,
    totalIgst: Math.round(totalIgst * 100) / 100,
    totalGst: Math.round(totalGst * 100) / 100,
    totalInvoiceAmount: Math.round(totalInvoiceAmount * 100) / 100,
    items: calculatedItems,
    slabSummaries,
  };
}
