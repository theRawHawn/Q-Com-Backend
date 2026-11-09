export interface CustomerProfile {
  id: string;
  phone: string;
  name: string;
  email: string;
  accountType: 'individual' | 'business';
  panNumber?: string;
  panStatus?: string;
  defaultAddress?: string;
  floorUnit?: string;
  landmark?: string;
  jobTag?: string;
  savedGstins?: SavedGstinRecord[];
  createdAt?: string;
  updatedAt?: string;
}

export interface SavedGstinRecord {
  id: string;
  userId: string;
  gstin: string;
  legalBusinessName: string;
  tradeName?: string;
  billingAddress: string;
  state: string;
  stateCode: string;
  pincode: string;
  isDefault: boolean;
  createdAt: string;
}

export interface SavedAddressRecord {
  id: string;
  userId: string;
  address: string;
  landmark?: string;
  floorUnit?: string;
  gateCode?: string;
  siteContactName: string;
  sitePhone: string;
  tradeType?: string;
  jobTag?: string;
  latitude: number;
  longitude: number;
  accessibleEntranceLatitude?: number;
  accessibleEntranceLongitude?: number;
  dropoffInstructions?: string;
  createdAt: string;
}
