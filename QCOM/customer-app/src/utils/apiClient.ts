import { CartItem, CustomerProfile, Order, SavedGstinRecord } from '../types';

const TOKEN_KEY = 'qcom_auth_token';

export function getStoredAuthToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setStoredAuthToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function removeStoredAuthToken() {
  localStorage.removeItem(TOKEN_KEY);
}

async function fetchWithAuth(url: string, options: RequestInit = {}) {
  const token = getStoredAuthToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {})
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(url, {
    ...options,
    headers
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || data.error || `HTTP error ${response.status}`);
  }
  return data;
}

// 1. Auth API
export async function apiRequestOtp(phone: string): Promise<{ success: boolean; message: string; expiresInSec: number; _devTestOtp?: string }> {
  return fetchWithAuth('/api/auth/request-otp', {
    method: 'POST',
    body: JSON.stringify({ phone })
  });
}

export async function apiVerifyOtp(phone: string, otp: string, name?: string): Promise<{ success: boolean; token: string; user: any }> {
  const result = await fetchWithAuth('/api/auth/verify-otp', {
    method: 'POST',
    body: JSON.stringify({ phone, otp, name })
  });
  if (result.token) {
    setStoredAuthToken(result.token);
  }
  return result;
}

export async function apiLogout(): Promise<void> {
  try {
    await fetchWithAuth('/api/auth/logout', { method: 'POST' });
  } finally {
    removeStoredAuthToken();
  }
}

// 2. Profile API
export async function apiFetchProfile(): Promise<CustomerProfile | null> {
  try {
    const data = await fetchWithAuth('/api/profile');
    return data.profile || null;
  } catch {
    return null;
  }
}

export async function apiUpdateProfile(updates: Partial<CustomerProfile>): Promise<CustomerProfile> {
  const data = await fetchWithAuth('/api/profile', {
    method: 'PUT',
    body: JSON.stringify(updates)
  });
  return data.profile;
}

export async function apiSaveGstin(gstinRecord: Omit<SavedGstinRecord, 'id' | 'createdAt'>): Promise<{ savedGstin: SavedGstinRecord; allSavedGstins: SavedGstinRecord[] }> {
  return fetchWithAuth('/api/profile/saved-gstin', {
    method: 'POST',
    body: JSON.stringify(gstinRecord)
  });
}

// 3. Authoritative Pricing & Quote API (QCOM Part 1)
export async function apiCalculateAuthoritativePricing(payload: {
  items: { productId: string; quantity: number }[];
  couponCode?: string | null;
  isGstEnabled?: boolean;
  riderTip?: number;
  deliveryCoordinates?: { lat: number; lng: number };
  sellerFundedDiscounts?: number;
}): Promise<any> {
  return fetchWithAuth('/api/checkout/quote', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

export async function apiGenerateCheckoutQuote(payload: {
  customer_id?: string;
  delivery_coordinates?: { lat: number; lng: number };
  cart_items: { productId: string; quantity: number; sellerId?: string }[];
  coupon_code?: string | null;
  is_gst_enabled?: boolean;
  buyer_gstin?: string | null;
  rider_tip?: number;
}): Promise<any> {
  return fetchWithAuth('/api/checkout/quote', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

export async function apiGetPricingConfig(): Promise<any> {
  return fetchWithAuth('/api/checkout/pricing-config', { method: 'GET' });
}

export async function apiUpdatePricingConfig(updates: any): Promise<any> {
  return fetchWithAuth('/api/checkout/pricing-config', {
    method: 'POST',
    body: JSON.stringify(updates)
  });
}

export async function apiGetSellerGeofences(): Promise<any> {
  return fetchWithAuth('/api/checkout/sellers-geofence', { method: 'GET' });
}

export async function apiUpdateSellerGeofence(sellerId: string, updates: any): Promise<any> {
  return fetchWithAuth(`/api/checkout/sellers-geofence/${sellerId}`, {
    method: 'POST',
    body: JSON.stringify(updates)
  });
}

// 4. Authoritative Order Placement
export async function apiPlaceOrder(payload: {
  items: { productId: string; quantity: number }[];
  couponCode?: string | null;
  isGstEnabled?: boolean;
  gstin?: string;
  businessName?: string;
  jobSite: any;
  paymentMethod: 'online' | 'cash_on_delivery';
  riderTip?: number;
  idempotencyKey?: string;
}): Promise<{ success: boolean; order: Order; breakdown: any }> {
  const idempotencyKey = payload.idempotencyKey || `idem_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
  
  return fetchWithAuth('/api/orders/create', {
    method: 'POST',
    headers: {
      'Idempotency-Key': idempotencyKey
    },
    body: JSON.stringify(payload)
  });
}

// 5. Payment API
export async function apiCreatePaymentOrder(orderId: string): Promise<any> {
  return fetchWithAuth('/api/payment/create-order', {
    method: 'POST',
    body: JSON.stringify({ orderId })
  });
}

export async function apiVerifyPayment(payload: {
  orderId: string;
  transactionId: string;
  timestamp: number;
  signature: string;
  amount: number;
}): Promise<any> {
  return fetchWithAuth('/api/payment/verify', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

// 6. Orders API
export async function apiFetchOrders(): Promise<Order[]> {
  try {
    const data = await fetchWithAuth('/api/orders');
    return data.orders || [];
  } catch {
    return [];
  }
}

export async function apiCancelOrder(orderId: string): Promise<any> {
  return fetchWithAuth(`/api/orders/${orderId}/cancel`, {
    method: 'POST'
  });
}

// 7. QCOM Routing API
export async function apiCalculateRoute(
  sellerLocation: { lat: number; lng: number; accessibleEntranceCoords?: { lat: number; lng: number }; pickupNotes?: string },
  customerLocation: { lat: number; lng: number; accessibleEntranceCoords?: { lat: number; lng: number }; dropoffInstructions?: string },
  vehicleType: string = 'electric_scooter'
): Promise<any> {
  return fetchWithAuth('/api/routing/calculate', {
    method: 'POST',
    body: JSON.stringify({ sellerLocation, customerLocation, vehicleType })
  });
}

export async function apiRerouteRider(
  orderId: string,
  currentRiderLocation: { lat: number; lng: number },
  destinationLocation: { lat: number; lng: number }
): Promise<any> {
  return fetchWithAuth('/api/routing/reroute', {
    method: 'POST',
    body: JSON.stringify({ orderId, currentRiderLocation, destinationLocation })
  });
}

export async function apiSaveEntranceCorrection(
  locationType: 'seller' | 'customer',
  originalCoords: { lat: number; lng: number },
  accessibleEntranceCoords: { lat: number; lng: number },
  notes?: string
): Promise<any> {
  return fetchWithAuth('/api/routing/entrance-correction', {
    method: 'POST',
    body: JSON.stringify({ locationType, originalCoords, accessibleEntranceCoords, notes })
  });
}

export async function apiLogRouteTelemetry(telemetryData: any): Promise<any> {
  return fetchWithAuth('/api/routing/telemetry', {
    method: 'POST',
    body: JSON.stringify(telemetryData)
  });
}

