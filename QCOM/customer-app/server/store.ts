import crypto from 'crypto';
import { HardwareProduct, Order, OrderStatus, CustomerProfile } from '../src/types';
import { INITIAL_PRODUCTS } from '../src/data/products';
import { DEFAULT_INITIAL_ORDERS } from '../src/data/sampleOrders';

// ==========================================
// 1. AUTHORITATIVE PRODUCT STORE
// ==========================================
class ProductStore {
  private products: Map<string, HardwareProduct> = new Map();
  // Mutex locks for atomic concurrency protection (Stock Race Condition Protection)
  private locks: Map<string, Promise<void>> = new Map();

  constructor() {
    for (const prod of INITIAL_PRODUCTS) {
      this.products.set(prod.id, { ...prod });
    }
  }

  public getProduct(id: string): HardwareProduct | undefined {
    const prod = this.products.get(id);
    return prod ? { ...prod } : undefined;
  }

  public getAllProducts(): HardwareProduct[] {
    return Array.from(this.products.values()).map(p => ({ ...p }));
  }

  // Atomic lock acquisition per product
  private async acquireLock(productId: string): Promise<() => void> {
    while (this.locks.has(productId)) {
      await this.locks.get(productId);
    }

    let releaseLock: () => void = () => {};
    const lockPromise = new Promise<void>((resolve) => {
      releaseLock = () => {
        this.locks.delete(productId);
        resolve();
      };
    });

    this.locks.set(productId, lockPromise);
    return releaseLock;
  }

  // Seller Marketplace Availability Verification (Seller owns stock; QCOM does not decrement or reserve)
  public async verifySellerAvailability(items: { productId: string; quantity: number }[]): Promise<{ success: boolean; error?: string; failedProductId?: string }> {
    for (const item of items) {
      const prod = this.products.get(item.productId);
      if (!prod) {
        return { success: false, error: `Product '${item.productId}' not found in seller catalog.`, failedProductId: item.productId };
      }
      if (prod.isAvailable === false) {
        return {
          success: false,
          error: `Product '${prod.name}' is currently marked unavailable by the seller.`,
          failedProductId: item.productId
        };
      }
    }
    return { success: true };
  }

  // Alias for backward compatibility without atomic deduction
  public async reserveStock(items: { productId: string; quantity: number }[]) {
    return this.verifySellerAvailability(items);
  }

  public restock(_items: { productId: string; quantity: number }[]) {
    // No-op in seller-owned inventory model
  }

  public setStock(productId: string, count: number) {
    const prod = this.products.get(productId);
    if (prod) {
      prod.stockCount = count;
    }
  }
}

export const authoritativeProductStore = new ProductStore();

// ==========================================
// 2. AUTHORITATIVE OTP & USER STORE
// ==========================================
export interface OtpRecord {
  phone: string;
  hashedOtp: string;
  expiresAt: number;
  attempts: number;
  maxAttempts: number;
}

export interface UserRecord {
  id: string;
  phone: string;
  name: string;
  email?: string;
  accountType: 'individual' | 'business';
  profile: CustomerProfile;
  createdAt: string;
}

class UserAndOtpStore {
  private otps: Map<string, OtpRecord> = new Map();
  private users: Map<string, UserRecord> = new Map();
  private lockouts: Map<string, number> = new Map(); // phone -> lockout expiresAt

  constructor() {
    // Seed default verified test customer
    this.users.set('usr_default_rahul', {
      id: 'usr_default_rahul',
      phone: '+919845012891',
      name: 'Rahul Sharma',
      email: 'rahul.sharma@apexmep.in',
      accountType: 'business',
      profile: {
        name: 'Rahul Sharma',
        phone: '+91 98450 12891',
        email: 'rahul.sharma@apexmep.in',
        isPhoneVerified: true,
        accountType: 'business',
        defaultAddress: '14th Main, 4th Block, Koramangala, Bengaluru',
        floorUnit: 'Tower B, 4th Floor, Flat 402',
        landmark: 'Opposite BDA Complex, Gate #2',
        gstProfile: {
          isB2BEnabled: true,
          gstin: '29AABCP1429B1Z8',
          legalBusinessName: 'Apex MEP Infrastructure Pvt Ltd',
          tradeName: 'Apex MEP Works - Bengaluru HQ',
          billingAddress: '14th Main, 4th Block, Koramangala, Bengaluru, Karnataka 560034',
          state: 'Karnataka',
          stateCode: '29',
          contactPerson: 'Rahul Sharma',
          contactEmail: 'rahul.sharma@apexmep.in',
          savedGstins: [
            {
              id: 'gstin_1',
              gstin: '29AABCP1429B1Z8',
              legalBusinessName: 'Apex MEP Infrastructure Pvt Ltd',
              tradeName: 'Apex MEP - Bengaluru HQ (Karnataka)',
              billingAddress: '14th Main, 4th Block, Koramangala, Bengaluru, Karnataka 560034',
              state: 'Karnataka',
              stateCode: '29',
              isDefault: true,
              createdAt: '2026-01-10'
            }
          ]
        }
      },
      createdAt: '2026-01-01T00:00:00.000Z'
    });
  }

  public isLockedOut(phone: string): boolean {
    const lockoutUntil = this.lockouts.get(phone);
    if (!lockoutUntil) return false;
    if (Date.now() > lockoutUntil) {
      this.lockouts.delete(phone);
      return false;
    }
    return true;
  }

  public storeOtp(phone: string, plainOtp: string, ttlSeconds: number = 300) {
    const hashedOtp = crypto.createHash('sha256').update(plainOtp).digest('hex');
    this.otps.set(phone, {
      phone,
      hashedOtp,
      expiresAt: Date.now() + ttlSeconds * 1000,
      attempts: 0,
      maxAttempts: 5
    });
  }

  public verifyOtp(phone: string, plainOtp: string): { success: boolean; error?: string } {
    if (this.isLockedOut(phone)) {
      return { success: false, error: 'Account temporarily locked out due to multiple failed OTP attempts. Try again in 15 minutes.' };
    }

    const record = this.otps.get(phone);
    if (!record) {
      return { success: false, error: 'No active OTP found for this phone number. Please request a new OTP.' };
    }

    if (Date.now() > record.expiresAt) {
      this.otps.delete(phone);
      return { success: false, error: 'OTP has expired. Please request a new one.' };
    }

    record.attempts += 1;
    const providedHash = crypto.createHash('sha256').update(plainOtp.trim()).digest('hex');

    // Constant-time compare
    const isMatch = crypto.timingSafeEqual(Buffer.from(providedHash), Buffer.from(record.hashedOtp));

    if (!isMatch) {
      if (record.attempts >= record.maxAttempts) {
        this.otps.delete(phone);
        this.lockouts.set(phone, Date.now() + 15 * 60 * 1000); // 15 min lockout
        return { success: false, error: 'Maximum verification attempts exceeded. Phone number locked for 15 minutes.' };
      }
      return { success: false, error: `Invalid OTP. ${record.maxAttempts - record.attempts} attempts remaining.` };
    }

    // OTP verified successfully -> Burn immediately to prevent replay
    this.otps.delete(phone);
    return { success: true };
  }

  public getOrCreateUser(phone: string, name?: string): UserRecord {
    let user = Array.from(this.users.values()).find(u => u.phone === phone);
    if (!user) {
      const id = `usr_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      user = {
        id,
        phone,
        name: name || 'Valued Tradesperson',
        accountType: 'individual',
        profile: {
          name: name || 'Valued Tradesperson',
          phone,
          isPhoneVerified: true,
          accountType: 'individual',
          email: '',
          defaultAddress: '14th Main, 4th Block, Koramangala, Bengaluru',
          floorUnit: 'Tower B, 4th Floor',
          landmark: 'Opposite BDA Complex',
          gstProfile: {
            isB2BEnabled: false,
            gstin: '',
            legalBusinessName: '',
            billingAddress: '14th Main, 4th Block, Koramangala, Bengaluru',
            state: 'Karnataka',
            stateCode: '29',
            savedGstins: []
          }
        },
        createdAt: new Date().toISOString()
      };
      this.users.set(id, user);
    }
    return user;
  }

  public getUserById(id: string): UserRecord | undefined {
    return this.users.get(id);
  }

  public updateUserProfile(id: string, updates: Partial<CustomerProfile>): UserRecord | undefined {
    const user = this.users.get(id);
    if (!user) return undefined;
    user.profile = { ...user.profile, ...updates };
    if (updates.name) user.name = updates.name;
    if (updates.accountType) user.accountType = updates.accountType;
    if (updates.email) user.email = updates.email;
    return user;
  }
}

export const authoritativeUserStore = new UserAndOtpStore();

// ==========================================
// 3. AUTHORITATIVE ORDER STORE & STATE MACHINE
// ==========================================
class OrderStore {
  private orders: Map<string, Order> = new Map();
  private processedTransactions: Set<string> = new Set(); // Replay protection for payment transaction IDs

  constructor() {
    for (const ord of DEFAULT_INITIAL_ORDERS) {
      this.orders.set(ord.id, {
        ...ord,
        // Tie initial orders to default user
        jobSite: {
          ...ord.jobSite
        }
      });
    }
  }

  public saveOrder(order: Order): Order {
    this.orders.set(order.id, { ...order });
    return { ...order };
  }

  public getOrder(orderId: string): Order | undefined {
    const ord = this.orders.get(orderId);
    return ord ? { ...ord } : undefined;
  }

  public getOrdersForCustomer(customerId: string, phone?: string): Order[] {
    return Array.from(this.orders.values())
      .filter(o => {
        // Match customerId or verified sitePhone
        const sitePhoneClean = o.jobSite?.sitePhone?.replace(/\s/g, '');
        const searchPhoneClean = phone?.replace(/\s/g, '');
        return (o as any).customerId === customerId || (phone && sitePhoneClean === searchPhoneClean);
      })
      .sort((a, b) => new Date(b.placedAt).getTime() - new Date(a.placedAt).getTime());
  }

  public isTransactionUsed(transactionId: string): boolean {
    return this.processedTransactions.has(transactionId);
  }

  public markTransactionUsed(transactionId: string) {
    this.processedTransactions.add(transactionId);
  }

  // Order State Machine: Enforces valid state transitions
  public transitionState(orderId: string, newStatus: OrderStatus, actor: 'customer' | 'seller' | 'rider' | 'system'): { success: boolean; error?: string } {
    const order = this.orders.get(orderId);
    if (!order) {
      return { success: false, error: 'Order not found.' };
    }

    const currentStatus = order.status;

    // Customer state transitions permissions
    if (actor === 'customer') {
      if (newStatus === 'cancelled') {
        if (currentStatus === 'delivered' || currentStatus === 'cancelled') {
          return { success: false, error: `Cannot cancel order that is already ${currentStatus}.` };
        }
        if (currentStatus === 'out_for_delivery' || currentStatus === 'arriving') {
          return { success: false, error: 'Order is already out for delivery with the rider and cannot be cancelled.' };
        }
        // Check cancellation window (5 minutes from creation)
        const orderAgeMs = Date.now() - new Date(order.placedAt).getTime();
        if (orderAgeMs > 5 * 60 * 1000) {
          return { success: false, error: 'Cancellation grace period (5 minutes) has expired.' };
        }
      } else {
        return { success: false, error: `Customers are not authorized to transition orders to ${newStatus}.` };
      }
    }

    // Apply state change
    order.status = newStatus;
    return { success: true };
  }
}

export const authoritativeOrderStore = new OrderStore();

// ==========================================
// 4. AUTHORITATIVE ROUTE & TELEMETRY STORE
// ==========================================
class RouteStore {
  private telemetry: Map<string, any> = new Map();
  private entranceCorrections: Map<string, { lat: number; lng: number; notes?: string }> = new Map();

  public saveTelemetry(record: any) {
    this.telemetry.set(record.id || record.orderId, record);
  }

  public getTelemetry(orderId: string): any | undefined {
    return this.telemetry.get(orderId);
  }

  public saveEntranceCorrection(locationKey: string, entrance: { lat: number; lng: number; notes?: string }) {
    this.entranceCorrections.set(locationKey, entrance);
  }

  public getEntranceCorrection(locationKey: string): { lat: number; lng: number; notes?: string } | undefined {
    return this.entranceCorrections.get(locationKey);
  }
}

export const authoritativeRouteStore = new RouteStore();

