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
