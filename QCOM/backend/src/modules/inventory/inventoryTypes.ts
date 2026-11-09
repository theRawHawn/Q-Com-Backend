export interface InventoryReservation {
  id: string;
  orderId: string;
  merchantId: string;
  productId: string;
  quantity: number;
  status: 'RESERVED' | 'COMMITTED' | 'RELEASED';
  expiresAt: string;
  createdAt: string;
}

export interface InventoryCheckResult {
  isAvailable: boolean;
  unavailableItems: {
    productId: string;
    requestedQuantity: number;
    availableStock: number;
  }[];
}

export type StockAlertType = 'LOW_STOCK' | 'OUT_OF_STOCK';

export interface StockAlertPayload {
  merchantId: string;
  productId: string;
  productName: string;
  sku: string;
  availableStock: number;
  physicalStock: number;
  reservedStock: number;
  threshold: number;
  alertType: StockAlertType;
  timestamp: string;
}

export interface StoreInventoryItem {
  id: string;
  merchantId: string;
  productId: string;
  productName: string;
  sku: string;
  category: string;
  hsnCode: string;
  sellingPrice: number;
  stockCount: number;
  reservedCount: number;
  availableToSell: number;
  lowStockThreshold: number;
  scarceStockThreshold: number;
  effectiveLowStockThreshold?: number;
  effectiveScarceStockThreshold?: number;
  lowStockStatus: boolean;
  outOfStockStatus: boolean;
  isScarce?: boolean;
  lowStockAlertTriggered: boolean;
  outOfStockAlertTriggered: boolean;
  lastAlertAt?: string | null;
  updatedAt: string;
}

export interface ThresholdUpdateInput {
  lowStockThreshold?: number;
  scarceStockThreshold?: number;
}

export interface MerchantThresholdDefaults {
  defaultLowStockThreshold: number;
  defaultScarceStockThreshold: number;
}
