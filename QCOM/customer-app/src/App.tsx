import React, { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Wrench, 
  Zap, 
  Search, 
  MapPin, 
  Clock, 
  Sparkles, 
  ShoppingBag, 
  ShieldCheck, 
  Calculator, 
  Boxes, 
  Filter, SlidersHorizontal, ArrowUpDown, ChevronDown, 
  Camera, 
  TrendingUp, 
  Droplet, 
  Hammer, 
  Anchor, 
  Layers, 
  ChevronRight,
  ArrowRight,
  ShieldAlert,
  TestTube,
  Store,
  Receipt
} from 'lucide-react';

import { HardwareProduct, TradeCategory, CartItem, AddressLocation, Order, OrderStatus, CustomerProfile, AppMode, EVRider, DarkStoreStats, DeliveryChargeBreakdown } from './types';
import { calculateOrderGstDistribution, getStateNameByCode, extractStateCodeFromGstin } from './utils/gstEngine';
import { CustomerPricingService } from './utils/customerPricingService';
import { INITIAL_PRODUCTS } from './data/products';
import { Navbar } from './components/Navbar';
import { CategoryChips } from './components/CategoryChips';
import { SubCategoryBar } from './components/SubCategoryBar';
import { getMainCategoryConfig } from './data/categories';
import { PromoBanner } from './components/PromoBanner';
import { SearchSuggestions } from './components/SearchSuggestions';
import { ProductCard } from './components/ProductCard';
import { ProductShelf } from './components/ProductShelf';
import { ProductDetailPage } from './components/ProductDetailPage';
import { PartFinderModal } from './components/PartFinderModal';
import { RoiCalculatorModal } from './components/RoiCalculatorModal';
import { OrderHistoryPage } from './components/OrderHistoryPage';
import { AddressModal } from './components/JobsiteAddressModal';
import { LocationPage } from './components/LocationPage';
import { DEFAULT_INITIAL_ORDERS } from './data/sampleOrders';
import { CartPage } from './components/CartPage';
import { OrderTrackingModal } from './components/OrderTrackingModal';
import { CustomerProfileModal } from './components/CustomerProfileModal';
import { ProfilePage } from './components/ProfilePage';
import { EmptySearchResults } from './components/EmptySearchResults';
import { OrderAgainSection } from './components/OrderAgainSection';
import { VisualCategoriesGrid } from './components/VisualCategoriesGrid';
import { MobileBottomNav } from './components/MobileBottomNav';
import { calculateDynamicDeliveryEta, calculateCartDispatchSummary } from './utils/deliveryEta';
import { getLiveUserLocation, reverseGeocodeCoordinates } from './utils/geolocation';
import { SellerDashboard } from './components/seller/SellerDashboard';
import { INITIAL_RIDERS, INITIAL_STATS } from './data/sellerData';
import { apiPlaceOrder } from './utils/apiClient';
import { feedback } from './utils/feedback';

const DEFAULT_JOBSITE: AddressLocation = {
  address: '14th Main, 4th Block, Koramangala, Bengaluru',
  landmark: 'Opposite BDA Complex',
  floorUnit: 'Tower B, 4th Floor, Flat 402',
  gateCode: 'Gate #2 (Tell Guard Flat 402)',
  siteContactName: 'Rahul Sharma',
  sitePhone: '+91 98450 12891',
  jobTag: 'Flat 402 Delivery',
  coordinates: {
    lat: 12.9352,
    lng: 77.6245
  }
};

const DEFAULT_CUSTOMER_PROFILE: CustomerProfile = {
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
      },
      {
        id: 'gstin_2',
        gstin: '27AABCP1429B1Z5',
        legalBusinessName: 'Apex MEP Infrastructure Pvt Ltd',
        tradeName: 'Apex MEP - Pune Site Office (Maharashtra)',
        billingAddress: 'Plot #18, Hinjewadi Phase 1, Pune, Maharashtra - 411057',
        state: 'Maharashtra',
        stateCode: '27',
        isDefault: false,
        createdAt: '2026-03-15'
      }
    ]
  }
};

export default function App() {
  // Dynamic Catalog State (Sync latest images and definitions from INITIAL_PRODUCTS)
  const [products, setProducts] = useState<HardwareProduct[]>(() => {
    try {
      const CATALOG_VERSION = 'v2_updated_photos_2026';
      const storedVersion = localStorage.getItem('quick_hardware_catalog_version');
      const saved = localStorage.getItem('quick_hardware_products');
      
      const initialMap = new Map(INITIAL_PRODUCTS.map(p => [p.id, p]));

      if (saved && storedVersion === CATALOG_VERSION) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const merged = parsed.map((p: HardwareProduct) => {
            const initial = initialMap.get(p.id);
            if (initial) {
              return {
                ...initial,
                ...p,
                imageUrl: initial.imageUrl, // Always enforce the latest accurate photo
                name: initial.name,
                category: initial.category,
                subcategory: initial.subcategory,
                description: initial.description,
                specs: initial.specs
              };
            }
            return p;
          });
          const existingIds = new Set(parsed.map((p: HardwareProduct) => p.id));
          const missing = INITIAL_PRODUCTS.filter(p => !existingIds.has(p.id));
          return missing.length > 0 ? [...merged, ...missing] : merged;
        }
      }
      
      // If version is missing or old, reset catalog from INITIAL_PRODUCTS
      localStorage.setItem('quick_hardware_catalog_version', CATALOG_VERSION);
      localStorage.setItem('quick_hardware_products', JSON.stringify(INITIAL_PRODUCTS));
      return INITIAL_PRODUCTS;
    } catch {
      return INITIAL_PRODUCTS;
    }
  });

  // Store Orders for Live Tracking
  const [orders, setOrders] = useState<Order[]>(() => {
    try {
      const saved = localStorage.getItem('quick_hardware_orders');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      }
      return DEFAULT_INITIAL_ORDERS;
    } catch {
      return DEFAULT_INITIAL_ORDERS;
    }
  });

  const [appMode, setAppMode] = useState<AppMode>('customer');
  const [riders, setRiders] = useState<EVRider[]>(INITIAL_RIDERS);
  const [sellerStats, setSellerStats] = useState<DarkStoreStats>(INITIAL_STATS);

  const [selectedCategory, setSelectedCategory] = useState<TradeCategory>('all');
  const [selectedSubCategory, setSelectedSubCategory] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [sizeFilter, setSizeFilter] = useState<string>('all');
  const [isGstFilterActive, setIsGstFilterActive] = useState(false);
  const [showAllProducts, setShowAllProducts] = useState(false);

  // Hierarchical category selection handler
  const handleSelectCategory = (cat: TradeCategory, subCat: string = 'all') => {
    setShowAllProducts(false);
    if (['lighting', 'fans', 'switches', 'electrical'].includes(cat)) {
      setSelectedCategory('electrical');
      setSelectedSubCategory(cat === 'electrical' ? subCat : cat);
    } else if (['bathroom_fittings', 'plumbing'].includes(cat)) {
      setSelectedCategory('plumbing');
      setSelectedSubCategory(cat === 'plumbing' ? subCat : cat);
    } else if (cat === 'kitchen_fittings') {
      setSelectedCategory('kitchen_fittings');
      setSelectedSubCategory(subCat);
    } else if (['screws', 'fasteners'].includes(cat)) {
      setSelectedCategory('screws');
      setSelectedSubCategory(subCat !== 'all' ? subCat : (cat === 'fasteners' ? 'fasteners' : 'all'));
    } else if (['tools', 'cutting_discs', 'cutters'].includes(cat)) {
      setSelectedCategory('tools');
      setSelectedSubCategory(subCat !== 'all' ? subCat : (cat !== 'tools' ? cat : 'all'));
    } else {
      setSelectedCategory(cat);
      setSelectedSubCategory(subCat);
    }
    setSearchQuery('');
  };
  
  // Cart state
  const [cart, setCart] = useState<CartItem[]>(() => {
    try {
      const saved = localStorage.getItem('quickhardware_cart');
      return saved ? JSON.parse(saved) : [
        { product: INITIAL_PRODUCTS[0], quantity: 1 },
        { product: INITIAL_PRODUCTS[1], quantity: 2 }
      ];
    } catch {
      return [];
    }
  });

  // Jobsite location state
  const [jobSite, setJobSite] = useState<AddressLocation>(() => {
    try {
      const saved = localStorage.getItem('rushq_saved_address') || localStorage.getItem('quickhardware_jobsite');
      return saved ? JSON.parse(saved) : DEFAULT_JOBSITE;
    } catch {
      return DEFAULT_JOBSITE;
    }
  });

  // Customer Profile & B2B GSTIN state
  const [customerProfile, setCustomerProfile] = useState<CustomerProfile>(() => {
    try {
      const saved = localStorage.getItem('quickhardware_customer_profile');
      return saved ? JSON.parse(saved) : DEFAULT_CUSTOMER_PROFILE;
    } catch {
      return DEFAULT_CUSTOMER_PROFILE;
    }
  });

  // Active Order state for customer tracking
  const [activeOrderId, setActiveOrderId] = useState<string | null>(() => {
    return orders[0]?.id || null;
  });

  const activeOrder = useMemo(() => {
    return orders.find(o => o.id === activeOrderId) || null;
  }, [orders, activeOrderId]);

  // Real-time location-aware dynamic delivery calculation
  const liveEta = useMemo(() => {
    return calculateDynamicDeliveryEta(jobSite.coordinates);
  }, [jobSite.coordinates]);

  // Modal visibility states
  const [isPartFinderOpen, setIsPartFinderOpen] = useState(false);
  const [isRoiCalcOpen, setIsRoiCalcOpen] = useState(false);
  const [isRestockOpen, setIsRestockOpen] = useState(false);
  const [isJobsiteModalOpen, setIsJobsiteModalOpen] = useState(false);
  const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);
  const [isCartOpen, setIsCartOpen] = useState(false);
  const [isTrackingOpen, setIsTrackingOpen] = useState(false);
  const [selectedProductDetail, setSelectedProductDetail] = useState<HardwareProduct | null>(null);

  // Live GPS geolocation detection states
  const [isLocatingGps, setIsLocatingGps] = useState(false);
  const [locationToast, setLocationToast] = useState<string | null>(null);

  // GPS Resolver for live mobile position
  const handleDetectGpsLocation = async (isAuto = false) => {
    setIsLocatingGps(true);
    if (!isAuto) {
      setLocationToast('Detecting your live GPS position...');
    }

    try {
      const liveLoc = await getLiveUserLocation({ timeoutMs: 15000 });
      const geocoded = await reverseGeocodeCoordinates(liveLoc.lat, liveLoc.lng);

      const resolvedAreaName = geocoded.suburb || geocoded.city || geocoded.state || 'Current Location';
      const resolvedAddress = geocoded.formattedAddress;

      const newLocation: AddressLocation = {
        address: resolvedAddress,
        floorUnit: geocoded.road || 'Doorstep Location',
        landmark: geocoded.landmark || `Near ${resolvedAreaName}`,
        siteContactName: customerProfile.name || 'Site Manager',
        sitePhone: customerProfile.phone || '+91 98450 12891',
        jobTag: liveLoc.isIpFallback ? 'Nearby Location' : 'Live GPS Pin',
        coordinates: {
          lat: liveLoc.lat,
          lng: liveLoc.lng,
        },
      };

      setJobSite(newLocation);
      localStorage.setItem('rushq_saved_address', JSON.stringify(newLocation));
      localStorage.setItem('quickhardware_location_detected', 'true');

      setLocationToast(`📍 Set to ${resolvedAreaName}`);
      setTimeout(() => setLocationToast(null), 3500);
    } catch (err: any) {
      console.warn('GPS auto-detection failed:', err?.message || err);
      if (!isAuto) {
        setLocationToast('Could not access GPS. Please allow location permissions in your browser.');
        setTimeout(() => setLocationToast(null), 4000);
      }
    } finally {
      setIsLocatingGps(false);
    }
  };

  // Auto-detect mobile location on startup if still using default Bangalore tech hub address
  useEffect(() => {
    const isDefaultBangalore = 
      Math.abs(jobSite.coordinates.lat - 12.9352) < 0.001 && 
      Math.abs(jobSite.coordinates.lng - 77.6245) < 0.001;

    const hasUserManuallyLockedAddress = localStorage.getItem('quickhardware_manual_pinned') === 'true';

    if (isDefaultBangalore && !hasUserManuallyLockedAddress) {
      handleDetectGpsLocation(true);
    }
  }, []);

  // Sync state to local storage
  useEffect(() => {
    localStorage.setItem('quickhardware_cart', JSON.stringify(cart));
  }, [cart]);

  useEffect(() => {
    localStorage.setItem('rushq_saved_address', JSON.stringify(jobSite));
  }, [jobSite]);

  useEffect(() => {
    localStorage.setItem('quickhardware_customer_profile', JSON.stringify(customerProfile));
  }, [customerProfile]);

  useEffect(() => {
    localStorage.setItem('quick_hardware_orders', JSON.stringify(orders));
  }, [orders]);

  useEffect(() => {
    localStorage.setItem('quick_hardware_products', JSON.stringify(products));
  }, [products]);

  // Cart operations
  const handleAddToCart = (product: HardwareProduct, qty = 1) => {
    setCart(prev => {
      const existing = prev.find(item => item.product.id === product.id);
      if (existing) {
        return prev.map(item =>
          item.product.id === product.id
            ? { ...item, quantity: item.quantity + qty }
            : item
        );
      }
      return [...prev, { product, quantity: qty }];
    });
  };

  const handleUpdateCartQty = (productId: string, delta: number) => {
    setCart(prev => {
      return prev
        .map(item => {
          if (item.product.id === productId) {
            const newQty = item.quantity + delta;
            return newQty > 0 ? { ...item, quantity: newQty } : null;
          }
          return item;
        })
        .filter((item): item is CartItem => Boolean(item));
    });
  };

  const handleRemoveFromCart = (productId: string) => {
    setCart(prev => prev.filter(i => i.product.id !== productId));
  };

  const handleClearCart = () => {
    setCart([]);
  };

  const handleAddMultipleToCart = (itemsToAdd: { product: HardwareProduct; qty: number }[]) => {
    itemsToAdd.forEach(({ product, qty }) => {
      handleAddToCart(product, qty);
    });
    setIsCartOpen(true);
  };

  const handleAddKitToCart = (productIds: string[]) => {
    productIds.forEach(id => {
      const prod = products.find(p => p.id === id);
      if (prod) handleAddToCart(prod, 1);
    });
    setIsCartOpen(true);
  };

  // Checkout and place order (Shared with Seller)
  const handleCheckout = (config: {
    paymentMethod: 'Instant UPI' | 'Corporate Card' | 'Pay on Jobsite' | 'Trade Credit (Net 30)';
    clientInvoiceNeeded: boolean;
    clientName?: string;
    isGstEnabled?: boolean;
    gstin?: string;
    businessName?: string;
    billingAddress?: string;
    stateCode?: string;
    state?: string;
    pincode?: string;
  }) => {
    const subtotal = cart.reduce((sum, item) => sum + item.product.price * item.quantity, 0);
    const isB2B = config.isGstEnabled !== undefined 
      ? config.isGstEnabled 
      : Boolean(customerProfile.gstProfile?.isB2BEnabled && customerProfile.gstProfile?.gstin);

    const finalGstin = isB2B ? (config.gstin || customerProfile.gstProfile?.gstin) : undefined;
    const finalBusinessName = isB2B ? (config.businessName || customerProfile.gstProfile?.legalBusinessName) : undefined;
    const finalBillingAddress = isB2B ? (config.billingAddress || customerProfile.gstProfile?.billingAddress || customerProfile.defaultAddress) : undefined;
    const finalStateCode = isB2B ? (config.stateCode || customerProfile.gstProfile?.stateCode || (finalGstin ? finalGstin.slice(0, 2) : '29')) : '29';
    const finalState = isB2B ? (config.state || customerProfile.gstProfile?.state || getStateNameByCode(finalStateCode)) : 'Karnataka';
    const finalPincode = isB2B ? (config.pincode || customerProfile.gstProfile?.pincode || '560038') : undefined;

    const dispatchSummary = calculateCartDispatchSummary(cart, jobSite.coordinates);
    const primaryHub = dispatchSummary.hubs[0];
    const actualRouteDistanceMeters = Math.max(1200, Math.round((primaryHub?.distanceKm || liveEta.distanceKm) * 1000));

    // Authoritative 6-step customer delivery charge calculation:
    // Base Delivery Charge -> QCOM Markup -> Taxable Delivery -> GST (18%) -> GST-Inclusive -> Existing Rounding
    const deliveryCalcResult = CustomerPricingService.calculateCustomerDeliveryCharge(
      subtotal,
      actualRouteDistanceMeters,
      finalStateCode
    );

    const deliveryFee = deliveryCalcResult.finalDeliveryCharge;
    const deliveryChargeBreakdown = deliveryCalcResult.deliveryBreakdown;
    const handlingCharge = CustomerPricingService.calculateHandlingCharge(subtotal);

    // Calculate dynamic state-wise GST distribution (CGST/SGST/UTGST/IGST)
    const gstBreakdown = calculateOrderGstDistribution({
      items: cart.map(item => ({
        product: {
          id: item.product.id,
          name: item.product.name,
          category: item.product.category,
          subcategory: item.product.subcategory,
          price: item.product.price,
          gstRatePercent: item.product.gstRatePercent ?? 18,
          sellerGstin: item.product.sellerGstin || '29AABCS8812K1ZM',
          isGstRegistered: item.product.isGstRegistered !== false,
        },
        quantity: item.quantity,
      })),
      buyerGstin: finalGstin,
      buyerBusinessName: finalBusinessName,
      buyerAddress: finalBillingAddress,
      buyerStateCode: finalStateCode,
      buyerState: finalState,
      buyerPincode: finalPincode,
      sellerStateCode: '29', // Bangalore Seller Hub
      deliveryFee,
      handlingFee: handlingCharge,
      discount: 0,
    });

    const tax = gstBreakdown.totalGst;
    const total = subtotal + deliveryFee + handlingCharge;
    
    const timeSavedMinutes = 45;
    const savingsVsLeavingSite = 350;

    // Sync profile if updated during checkout
    if (config.isGstEnabled !== undefined) {
      setCustomerProfile(prev => {
        let updatedSaved = prev.gstProfile?.savedGstins || [];
        if (finalGstin && !updatedSaved.some(g => g.gstin === finalGstin)) {
          updatedSaved = [
            ...updatedSaved,
            {
              id: `gst_${Date.now()}`,
              gstin: finalGstin,
              legalBusinessName: finalBusinessName || 'Registered Enterprise',
              tradeName: finalBusinessName || 'Registered Enterprise',
              billingAddress: finalBillingAddress || prev.defaultAddress || 'Jobsite Address',
              state: finalState,
              stateCode: finalStateCode,
              pincode: finalPincode,
              isDefault: updatedSaved.length === 0
            }
          ];
        }

        return {
          ...prev,
          accountType: config.isGstEnabled ? 'business' : 'individual',
          gstProfile: {
            ...prev.gstProfile,
            isB2BEnabled: Boolean(config.isGstEnabled),
            gstin: finalGstin || prev.gstProfile?.gstin || '',
            legalBusinessName: finalBusinessName || prev.gstProfile?.legalBusinessName || '',
            billingAddress: finalBillingAddress || prev.gstProfile?.billingAddress,
            state: finalState,
            stateCode: finalStateCode,
            pincode: finalPincode,
            savedGstins: updatedSaved
          }
        };
      });
    }

    const newOrder: Order = {
      id: `BH-${Math.floor(100000 + Math.random() * 900000)}`,
      items: [...cart],
      subtotal,
      deliveryFee,
      deliveryChargeBreakdown,
      calculatedDeliveryCharge: deliveryChargeBreakdown.calculatedDeliveryCharge,
      qcomDeliveryMarkup: deliveryChargeBreakdown.qcomDeliveryMarkup,
      taxableDeliveryCharge: deliveryChargeBreakdown.taxableDeliveryCharge,
      deliveryGstAmount: deliveryChargeBreakdown.totalGstAmount,
      deliveryRoundingAdjustment: deliveryChargeBreakdown.roundingAdjustment,
      urgencyFee: handlingCharge,
      tax,
      total,
      savingsVsLeavingSite,
      timeSavedMinutes,
      status: 'placed',
      placedAt: new Date(),
      estimatedDeliveryAt: new Date(Date.now() + dispatchSummary.maxEtaMins * 60 * 1000),
      jobSite: { ...jobSite, jobTag: config.clientName || jobSite.jobTag },
      customerGstin: finalGstin,
      customerBusinessName: finalBusinessName,
      customerBillingAddress: finalBillingAddress,
      customerState: finalState,
      customerStateCode: finalStateCode,
      customerPincode: finalPincode,
      placeOfSupply: gstBreakdown.placeOfSupply,
      isInterState: gstBreakdown.isInterState,
      isUnionTerritory: gstBreakdown.isUnionTerritory,
      taxableAmount: gstBreakdown.totalTaxableValue,
      cgstAmount: gstBreakdown.totalCgst,
      sgstAmount: gstBreakdown.totalSgst,
      utgstAmount: gstBreakdown.totalUtgst,
      igstAmount: gstBreakdown.totalIgst,
      supplyType: gstBreakdown.supplyType,
      itcAmount: isB2B ? gstBreakdown.totalGst : undefined,
      itcAmountClaimable: isB2B ? gstBreakdown.totalGst : undefined,
      sellerPartner: primaryHub ? {
        name: primaryHub.seller.name,
        shopType: primaryHub.seller.specialty,
        address: `${primaryHub.seller.address} (${primaryHub.formattedDist})`,
        distanceKm: primaryHub.distanceKm,
        rating: primaryHub.seller.rating,
        phone: primaryHub.seller.phone,
        gstin: primaryHub.seller.gstin,
        coordinates: primaryHub.seller.coordinates
      } : {
        name: 'Sri Lakshmi Hardware & Electricals',
        shopType: 'Verified Local Hardware Seller',
        address: `5th Block, Koramangala (${liveEta.formattedDist})`,
        distanceKm: liveEta.distanceKm,
        rating: 4.9,
        phone: '+91 80 2553 4912',
        gstin: '29AABCS8812K1ZM'
      },
      darkStore: {
        name: primaryHub ? primaryHub.seller.name : 'Sri Lakshmi Hardware & Electricals (Local Seller)',
        code: primaryHub ? `SELLER-${primaryHub.seller.id.toUpperCase()}` : 'SHOP-BLR-07',
        distanceKm: primaryHub ? primaryHub.distanceKm : liveEta.distanceKm,
        pickerName: 'Store Partner Fulfillment'
      },
      rider: {
        name: 'Vikas Kumar',
        phone: '+91 98860 41239',
        vehicle: 'Bajaj Chetak EV (KA-01-EQ-9812)',
        rating: 4.9,
        photo: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=120&auto=format&fit=crop&q=80',
        currentLocation: {
          lat: 12.9352,
          lng: 77.6245,
          distanceMeters: Math.round((primaryHub?.distanceKm || liveEta.distanceKm) * 1000)
        }
      },
      deliveryOtp: `${Math.floor(1000 + Math.random() * 9000)}`,
      paymentMethod: config.paymentMethod,
      clientInvoiceNeeded: config.clientInvoiceNeeded,
      clientName: config.clientName
    };

    setOrders(prev => [newOrder, ...prev]);
    setActiveOrderId(newOrder.id);
    
    // Decrement stock for purchased items
    setProducts(prevProds => {
      return prevProds.map(p => {
        const orderedItem = cart.find(ci => ci.product.id === p.id);
        if (orderedItem) {
          return { ...p, stockCount: Math.max(0, p.stockCount - orderedItem.quantity) };
        }
        return p;
      });
    });

    setCart([]);
    setIsCartOpen(false);
    setIsTrackingOpen(true);

    // Synchronize authoritatively with backend
    apiPlaceOrder({
      items: cart.map(i => ({ productId: i.product.id, quantity: i.quantity })),
      isGstEnabled: isB2B,
      gstin: finalGstin,
      businessName: finalBusinessName,
      jobSite: {
        address: jobSite.address,
        landmark: jobSite.landmark,
        floorUnit: jobSite.floorUnit,
        gateCode: jobSite.gateCode,
        siteContactName: jobSite.siteContactName,
        sitePhone: jobSite.sitePhone,
        jobTag: config.clientName || jobSite.jobTag,
        coordinates: jobSite.coordinates
      },
      paymentMethod: config.paymentMethod === 'Pay on Jobsite' ? 'cash_on_delivery' : 'online'
    }).catch(err => {
      console.warn('[SERVER_ORDER_SYNC]', err?.message || err);
    });
  };

  // Synchronized Status Updates for Live Tracking Modal
  const handleUpdateOrderStatus = React.useCallback((orderId: string, newStatus: OrderStatus) => {
    setOrders(prev => {
      const current = prev.find(o => o.id === orderId);
      if (current && current.status === newStatus) return prev;
      return prev.map(order => {
        if (order.id === orderId) {
          return { ...order, status: newStatus };
        }
        return order;
      });
    });
  }, []);

  // Filter products by category, subcategory, search, size, and GSTIN
  const filteredProducts = useMemo(() => {
    const mainConfig = getMainCategoryConfig(selectedCategory);

    return products.filter(p => {
      // Main category and Subcategory matching
      let matchCat = selectedCategory === 'all';
      if (!matchCat) {
        if (selectedSubCategory !== 'all') {
          const subItem = mainConfig.subcategories.find(s => s.id === selectedSubCategory);
          if (subItem && subItem.filterFn) {
            matchCat = subItem.filterFn(p);
          } else {
            matchCat = p.category === selectedSubCategory || mainConfig.productCategories.includes(p.category);
          }
        } else {
          matchCat = mainConfig.productCategories.includes(p.category);
        }
      }

      const query = searchQuery.toLowerCase().trim();
      const matchSearch = !query || 
        p.name.toLowerCase().includes(query) ||
        p.specs.brand.toLowerCase().includes(query) ||
        p.subcategory.toLowerCase().includes(query) ||
        p.description.toLowerCase().includes(query) ||
        p.tags.some(t => t.toLowerCase().includes(query));

      const matchSize = sizeFilter === 'all' || 
        (p.specs.size && p.specs.size.toLowerCase().includes(sizeFilter.toLowerCase()));

      const matchGst = !isGstFilterActive || p.isGstRegistered !== false;

      return matchCat && matchSearch && matchSize && matchGst;
    });
  }, [products, selectedCategory, selectedSubCategory, searchQuery, sizeFilter, isGstFilterActive]);

  // Shelf group products
  const emergencyRescueProducts = useMemo(() => {
    return products.filter(p => p.badge === 'High Demand' || p.id === 'plumb-01' || p.id === 'plumb-03' || p.id === 'elec-01' || p.id === 'adhes-04' || p.id === 'fast-01');
  }, [products]);

  const lightingProducts = useMemo(() => {
    return products.filter(p => p.category === 'lighting');
  }, [products]);

  const fanProducts = useMemo(() => {
    return products.filter(p => p.category === 'fans');
  }, [products]);

  const switchProducts = useMemo(() => {
    return products.filter(p => p.category === 'switches');
  }, [products]);

  const bathroomProducts = useMemo(() => {
    return products.filter(p => p.category === 'bathroom_fittings');
  }, [products]);

  const kitchenProducts = useMemo(() => {
    return products.filter(p => p.category === 'kitchen_fittings');
  }, [products]);

  const plumbingProducts = useMemo(() => {
    return products.filter(p => p.category === 'plumbing');
  }, [products]);

  const electricalProducts = useMemo(() => {
    return products.filter(p => p.category === 'electrical');
  }, [products]);

  const fastenerProducts = useMemo(() => {
    return products.filter(p => p.category === 'fasteners' || p.category === 'screws');
  }, [products]);

  const adhesiveProducts = useMemo(() => {
    return products.filter(p => p.category === 'adhesives');
  }, [products]);

  const toolProducts = useMemo(() => {
    return products.filter(p => p.category === 'tools' || p.category === 'safety' || p.category === 'carpentry' || p.category === 'cutting_discs' || p.category === 'cutters');
  }, [products]);

  const totalCartCount = cart.reduce((sum, item) => sum + item.quantity, 0);
  const cartTotal = cart.reduce((sum, item) => sum + item.product.price * item.quantity, 0);

  // Dedicated Full-Page Delivery Location View
  if (isJobsiteModalOpen) {
    return (
      <LocationPage
        currentLocation={jobSite}
        onSaveLocation={(newLoc) => {
          setJobSite(newLoc);
          setIsJobsiteModalOpen(false);
        }}
        onClose={() => setIsJobsiteModalOpen(false)}
      />
    );
  }

  // Dedicated Full-Page Profile View
  if (isProfileModalOpen) {
    return (
      <ProfilePage
        profile={customerProfile}
        onSaveProfile={setCustomerProfile}
        orders={orders}
        onClose={() => setIsProfileModalOpen(false)}
        onOpenOrderTracking={(orderId) => {
          setIsProfileModalOpen(false);
          setActiveOrderId(orderId);
          setIsTrackingOpen(true);
        }}
        onOpenRestock={() => {
          setIsProfileModalOpen(false);
          setIsRestockOpen(true);
        }}
        onUpdateJobSite={setJobSite}
        onOpenLocationModal={() => {
          setIsProfileModalOpen(false);
          setIsJobsiteModalOpen(true);
        }}
      />
    );
  }

  // Dedicated Full-Page Order History & Reorder View
  if (isRestockOpen) {
    return (
      <OrderHistoryPage
        orders={orders}
        onClose={() => setIsRestockOpen(false)}
        onAddToCart={handleAddToCart}
        onUpdateCartQty={handleUpdateCartQty}
        onAddMultipleToCart={handleAddMultipleToCart}
        onOpenOrderTracking={(orderId) => {
          setActiveOrderId(orderId);
          setIsTrackingOpen(true);
        }}
        onOpenCart={() => setIsCartOpen(true)}
        cart={cart}
        deliveryEtaMins={liveEta.etaMins}
      />
    );
  }

  // Dedicated Full-Page Cart & Checkout View
  if (isCartOpen) {
    return (
      <div className="min-h-screen bg-[#F4F6F8] text-slate-900 flex flex-col font-sans antialiased selection:bg-emerald-600 selection:text-white">
        <CartPage
          items={cart}
          allProducts={products}
          onOpenDetail={setSelectedProductDetail}
          jobSite={jobSite}
          customerProfile={customerProfile}
          onClose={() => setIsCartOpen(false)}
          onAddToCart={handleAddToCart}
          onUpdateQty={handleUpdateCartQty}
          onRemoveItem={handleRemoveFromCart}
          onClearCart={handleClearCart}
          onCheckout={handleCheckout}
          onOpenLocationModal={() => setIsJobsiteModalOpen(true)}
          onOpenProfileModal={() => setIsProfileModalOpen(true)}
        />

        <AddressModal
          isOpen={isJobsiteModalOpen}
          onClose={() => setIsJobsiteModalOpen(false)}
          currentLocation={jobSite}
          onSaveLocation={setJobSite}
        />
      </div>
    );
  }

  // Seller Dashboard helper handlers
  const handleUpdateStock = (productId: string, newStock: number) => {
    setProducts(prev => prev.map(p => p.id === productId ? { ...p, stockCount: newStock } : p));
  };

  const handleUpdatePrice = (productId: string, newPrice: number) => {
    setProducts(prev => prev.map(p => p.id === productId ? { ...p, price: newPrice } : p));
  };

  const handleAddProduct = (newProduct: HardwareProduct) => {
    setProducts(prev => [newProduct, ...prev]);
  };

  const handleUpdateGstRate = (productId: string, newRate: number) => {
    setProducts(prev => prev.map(p => p.id === productId ? { ...p, gstRatePercent: newRate } : p));
  };

  const handleAssignRider = (orderId: string, riderId: string) => {
    const selectedRider = riders.find(r => r.id === riderId);
    if (!selectedRider) return;

    // ponytail: using hardcoded starting coordinates for simulated active rider tracking
    setOrders(prev => prev.map(order => {
      if (order.id === orderId) {
        return {
          ...order,
          status: 'out_for_delivery' as OrderStatus,
          rider: {
            name: selectedRider.name,
            phone: selectedRider.phone,
            vehicle: selectedRider.vehicle,
            rating: selectedRider.rating,
            photo: selectedRider.photo,
            currentLocation: { lat: 12.9352, lng: 77.6245, distanceMeters: 1000 }
          }
        };
      }
      return order;
    }));

    setRiders(prev => prev.map(r => {
      if (r.id === riderId) {
        return { ...r, status: 'in_transit', activeOrderId: orderId };
      }
      return r;
    }));
  };

  const handleSimulateOrder = () => {
    // ponytail: using uniform distribution random selection for simulating active incoming dark-store client orders
    const randomProduct = products[Math.floor(Math.random() * products.length)];
    const newOrder: Order = {
      id: `BH-${Math.floor(100000 + Math.random() * 900000)}`,
      items: [{ product: randomProduct, quantity: 1 }],
      subtotal: randomProduct.price,
      deliveryFee: 0,
      urgencyFee: 5,
      tax: Math.round((randomProduct.price * 18) / 118),
      total: randomProduct.price + 5,
      savingsVsLeavingSite: 350,
      timeSavedMinutes: 45,
      status: 'placed',
      placedAt: new Date(),
      estimatedDeliveryAt: new Date(Date.now() + 12 * 60 * 1000),
      jobSite: { ...DEFAULT_JOBSITE, siteContactName: 'Simulated Buyer' },
      darkStore: { name: 'Simulated Shop Hub', code: 'SIM-07', distanceKm: 1.5, pickerName: 'AI Agent' },
      rider: {
        name: riders[0].name,
        phone: riders[0].phone,
        vehicle: riders[0].vehicle,
        rating: riders[0].rating,
        photo: riders[0].photo,
        currentLocation: { lat: 12.9352, lng: 77.6245, distanceMeters: 1000 }
      },
      deliveryOtp: `${Math.floor(1000 + Math.random() * 9000)}`,
      paymentMethod: 'Instant UPI',
      clientInvoiceNeeded: true
    };
    setOrders(prev => [newOrder, ...prev]);
    setSellerStats(prev => ({
      ...prev,
      todayGmv: prev.todayGmv + newOrder.total,
      totalOrders: prev.totalOrders + 1
    }));
  };

  if (appMode === 'seller') {
    return (
      <SellerDashboard
        orders={orders}
        onUpdateOrderStatus={handleUpdateOrderStatus}
        products={products}
        onUpdateStock={handleUpdateStock}
        onUpdatePrice={handleUpdatePrice}
        onUpdateGstRate={handleUpdateGstRate}
        onAddProduct={handleAddProduct}
        riders={riders}
        onAssignRider={handleAssignRider}
        onSwitchToCustomer={() => setAppMode('customer')}
        onSimulateOrder={handleSimulateOrder}
        stats={sellerStats}
      />
    );
  }

  return (
    <div className="min-h-screen bg-[#F4F6F8] bg-[linear-gradient(180deg,rgba(247,211,54,0.65)_0%,rgba(253,224,71,0.45)_120px,rgba(252,230,126,0.25)_280px,rgba(252,230,126,0.10)_480px,rgba(244,246,248,0)_700px)] text-slate-900 flex flex-col font-sans antialiased selection:bg-emerald-600 selection:text-white rounded-none">
      
      {/* Location Toast Notification */}
      {locationToast && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 z-50 bg-slate-950/95 text-white backdrop-blur-md px-4 py-2.5 rounded-full text-xs font-bold shadow-2xl flex items-center gap-2 border border-slate-700/80 animate-in slide-in-from-top-4 duration-200">
          <Sparkles className="w-4 h-4 text-amber-400 animate-pulse" />
          <span>{locationToast}</span>
        </div>
      )}

      {/* Signature Unified Sticky Navbar & Category Header */}
      <Navbar
        jobSite={jobSite}
        customerProfile={customerProfile}
        onOpenLocationModal={() => setIsJobsiteModalOpen(true)}
        onOpenProfileModal={() => setIsProfileModalOpen(true)}
        onOpenAiPartFinder={() => setIsPartFinderOpen(true)}
        onOpenRoiCalculator={() => setIsRoiCalcOpen(true)}
        onOpenToolboxRestock={() => setIsRestockOpen(true)}
        onOpenCart={() => setIsCartOpen(true)}
        cartCount={totalCartCount}
        cartTotal={cartTotal}
        searchQuery={searchQuery}
        onSearchChange={(q) => {
          setSearchQuery(q);
          if (q) {
            setShowAllProducts(false);
          }
        }}
        selectedCategory={selectedCategory}
        onSelectCategory={handleSelectCategory}
        isGstFilterActive={isGstFilterActive}
        onToggleGstFilter={() => setIsGstFilterActive(!isGstFilterActive)}
      />

      {/* Main Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-3 sm:px-4 md:px-6 lg:px-8 py-3 sm:py-5 space-y-4 sm:space-y-6 pb-32 sm:pb-28 md:pb-20">
        
        {/* Active Order Dispatch Banner (if order in flight) */}
        {activeOrder && activeOrder.status !== 'delivered' && (
          <div 
            onClick={() => setIsTrackingOpen(true)}
            className="bg-gradient-to-r from-emerald-900 via-emerald-800 to-slate-900 text-white border border-emerald-500/80 rounded-2xl p-3.5 sm:p-4 shadow-lg cursor-pointer hover:shadow-xl transition-all flex flex-col sm:flex-row sm:items-center justify-between gap-3 animate-in fade-in"
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-emerald-500 text-emerald-950 flex items-center justify-center font-black animate-pulse shrink-0 shadow-md">
                <Zap className="w-5 h-5 fill-emerald-950" />
              </div>
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-black text-sm text-white">
                    Order #{activeOrder.id}
                  </span>
                  <span className="bg-emerald-500/30 text-emerald-200 border border-emerald-400/40 text-[10px] font-black px-2 py-0.5 rounded-full uppercase tracking-wider">
                    ⚡ {activeOrder.status === 'out_for_delivery' ? 'Partner On Route' : activeOrder.status.replace('_', ' ').toUpperCase()}
                  </span>
                  <span className="bg-amber-400 text-amber-950 font-mono font-black px-2 py-0.5 rounded text-[11px]">
                    OTP: {activeOrder.deliveryOtp}
                  </span>
                </div>
                <div className="text-emerald-100/90 text-xs mt-0.5 flex items-center gap-1.5 flex-wrap">
                  <span>Delivery Partner: <strong>{activeOrder.rider.name}</strong></span>
                  <span>•</span>
                  <span>Delivering to <strong>{activeOrder.jobSite.floorUnit}</strong></span>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 self-end sm:self-center bg-white/10 hover:bg-white/20 px-3 py-1.5 rounded-xl border border-white/20 transition">
              <span className="text-xs font-black text-white uppercase tracking-wider flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
                Track Live Map
              </span>
              <ChevronRight className="w-4 h-4 text-emerald-300" />
            </div>
          </div>
        )}

        {/* Hero Promo Carousel Banner (only on 'all' and no active search) */}
        {selectedCategory === 'all' && !searchQuery && !showAllProducts && (
          <PromoBanner
            onOpenAiScanner={() => setIsPartFinderOpen(true)}
            onOpenRoiCalc={() => setIsRoiCalcOpen(true)}
            onSelectCategory={(cat) => {
              if (cat === 'all') {
                setShowAllProducts(true);
              } else {
                handleSelectCategory(cat);
              }
            }}
            onOpenProfileModal={() => setIsProfileModalOpen(true)}
            deliveryEtaMins={liveEta.etaMins}
          />
        )}

        {/* Dynamic 'Order Again' Visual Grid Section */}
        {selectedCategory === 'all' && !searchQuery && !showAllProducts && (
          <OrderAgainSection
            orders={orders}
            cart={cart}
            onAddToCart={handleAddToCart}
            onUpdateCartQty={handleUpdateCartQty}
            onOpenDetail={setSelectedProductDetail}
            customerProfile={customerProfile}
            deliveryEtaMins={liveEta.etaMins}
          />
        )}

        {/* Visual Categories Grid matching reference layout */}
        {selectedCategory === 'all' && !searchQuery && !showAllProducts && (
          <VisualCategoriesGrid onSelectCategory={handleSelectCategory} />
        )}

        {/* Shelf Layout or Filtered Search Layout */}
        {searchQuery || selectedCategory !== 'all' || isGstFilterActive || showAllProducts ? (
          /* Filtered View */
          <>
          <SearchSuggestions query={searchQuery} products={products} onSelectSuggestion={setSearchQuery} />
          <div className="space-y-4">
            {/* Filter Bar (Reference Image Style) */}
            <div className="flex items-center gap-2 overflow-x-auto pb-2 -mx-3 px-3 sm:-mx-4 sm:px-4 md:-mx-6 md:px-6 lg:-mx-8 lg:px-8 no-scrollbar border-b border-slate-200/60 mb-2">
              <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-700 font-medium text-[13px] hover:bg-slate-50 whitespace-nowrap shadow-2xs cursor-pointer">
                <SlidersHorizontal className="w-3.5 h-3.5 text-slate-500" />
                Filters
                <ChevronDown className="w-3.5 h-3.5 text-slate-400 ml-0.5" />
              </button>
              <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-700 font-medium text-[13px] hover:bg-slate-50 whitespace-nowrap shadow-2xs cursor-pointer">
                <ArrowUpDown className="w-3.5 h-3.5 text-slate-500" />
                Sort
                <ChevronDown className="w-3.5 h-3.5 text-slate-400 ml-0.5" />
              </button>
              <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-700 font-medium text-[13px] hover:bg-slate-50 whitespace-nowrap shadow-2xs cursor-pointer">
                Price
                <ChevronDown className="w-3.5 h-3.5 text-slate-400 ml-0.5" />
              </button>
              <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-700 font-medium text-[13px] hover:bg-slate-50 whitespace-nowrap shadow-2xs cursor-pointer">
                Type
                <ChevronDown className="w-3.5 h-3.5 text-slate-400 ml-0.5" />
              </button>
              <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-700 font-medium text-[13px] hover:bg-slate-50 whitespace-nowrap shadow-2xs cursor-pointer">
                Properties
                <ChevronDown className="w-3.5 h-3.5 text-slate-400 ml-0.5" />
              </button>
            </div>

            {filteredProducts.length === 0 ? (
              <EmptySearchResults
                searchQuery={searchQuery}
                onClearFilters={() => {
                  setSelectedCategory('all');
                  setSelectedSubCategory('all');
                  setSearchQuery('');
                  setSizeFilter('all');
                  setIsGstFilterActive(false);
                  setShowAllProducts(false);
                }}
                onSelectSuggestion={(term) => {
                  setSearchQuery(term);
                  setShowAllProducts(true);
                }}
                onSelectCategory={(category) => {
                  handleSelectCategory(category);
                }}
              />
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-4 xl:grid-cols-5 gap-3 sm:gap-4">
                {filteredProducts.map((product) => {
                  const inCart = cart.find(i => i.product.id === product.id)?.quantity || 0;
                  return (
                    <ProductCard
                      key={product.id}
                      product={product}
                      quantityInCart={inCart}
                      onAddToCart={handleAddToCart}
                      onUpdateCartQty={handleUpdateCartQty}
                      onOpenDetail={setSelectedProductDetail}
                      destinationCoords={jobSite.coordinates}
                    />
                  );
                })}
              </div>
            )}

          </div>
          </>
        ) : (
          /* Standard Shelves Grid */
          <div className="space-y-6">
            
            {/* Shelf 1: Rescues */}
            <ProductShelf
              title={`⚡ Express ${liveEta.etaMins}-Minute Rescues`}
              subtitle="Most ordered items when work gets halted unexpectedly"
              badge="Fast Dispatch"
              products={emergencyRescueProducts}
              cart={cart}
              onAddToCart={handleAddToCart}
              onUpdateCartQty={handleUpdateCartQty}
              onOpenDetail={setSelectedProductDetail}
              deliveryEtaMins={liveEta.etaMins}
              destinationCoords={jobSite.coordinates}
            />

            {/* Shelf 2: Lighting & Bulbs */}
            <ProductShelf
              title="💡 LED Tubelights, Bulbs & Panel Lights"
              subtitle="Philips 20W battens, Wipro 9W B22 bulbs, Havells ceiling panels & T-bulbs"
              category="lighting"
              products={lightingProducts}
              cart={cart}
              onAddToCart={handleAddToCart}
              onUpdateCartQty={handleUpdateCartQty}
              onOpenDetail={setSelectedProductDetail}
              onSeeAll={handleSelectCategory}
              deliveryEtaMins={liveEta.etaMins}
              destinationCoords={jobSite.coordinates}
            />

            {/* Shelf 3: Ceiling & Exhaust Fans */}
            <ProductShelf
              title="🌀 Ceiling Fans, Regulators & Exhausts"
              subtitle="Atomberg BLDC energy saver fans, Crompton 380 RPM, Havells exhausts & Roma regulators"
              category="fans"
              products={fanProducts}
              cart={cart}
              onAddToCart={handleAddToCart}
              onUpdateCartQty={handleUpdateCartQty}
              onOpenDetail={setSelectedProductDetail}
              onSeeAll={handleSelectCategory}
              deliveryEtaMins={liveEta.etaMins}
              destinationCoords={jobSite.coordinates}
            />

            {/* Shelf 4: Switches, Buttons & Sockets */}
            <ProductShelf
              title="🔘 Modular Switches, Buttons & 16A Sockets"
              subtitle="Anchor Roma switch buttons, 16A heavy power sockets, bell pushes & 32A DP isolators"
              category="switches"
              products={switchProducts}
              cart={cart}
              onAddToCart={handleAddToCart}
              onUpdateCartQty={handleUpdateCartQty}
              onOpenDetail={setSelectedProductDetail}
              onSeeAll={handleSelectCategory}
              deliveryEtaMins={liveEta.etaMins}
              destinationCoords={jobSite.coordinates}
            />

            {/* Shelf 5: Bathroom Fittings */}
            <ProductShelf
              title="🚿 Bathroom Fittings & Jet Sprays"
              subtitle="Brass health faucets, Hindware overhead rain showers, 2-in-1 dual valves & towel rods"
              category="bathroom_fittings"
              products={bathroomProducts}
              cart={cart}
              onAddToCart={handleAddToCart}
              onUpdateCartQty={handleUpdateCartQty}
              onOpenDetail={setSelectedProductDetail}
              onSeeAll={handleSelectCategory}
              deliveryEtaMins={liveEta.etaMins}
              destinationCoords={jobSite.coordinates}
            />

            {/* Shelf 6: Kitchen Fittings */}
            <ProductShelf
              title="🚰 Kitchen Fittings, Taps & Couplings"
              subtitle="360° flexible swivel sink taps, SS 304 waste couplings, expandable drain pipes & RO valves"
              category="kitchen_fittings"
              products={kitchenProducts}
              cart={cart}
              onAddToCart={handleAddToCart}
              onUpdateCartQty={handleUpdateCartQty}
              onOpenDetail={setSelectedProductDetail}
              onSeeAll={handleSelectCategory}
              deliveryEtaMins={liveEta.etaMins}
              destinationCoords={jobSite.coordinates}
            />

            {/* Shelf 7: Plumbing */}
            <ProductShelf
              title="🚰 Plumbing & Sanitary Essentials"
              subtitle="Quarter-turn angle valves, Teflon tape, CPVC brass FTAs & SS braided pipes"
              category="plumbing"
              products={plumbingProducts}
              cart={cart}
              onAddToCart={handleAddToCart}
              onUpdateCartQty={handleUpdateCartQty}
              onOpenDetail={setSelectedProductDetail}
              onSeeAll={handleSelectCategory}
              deliveryEtaMins={liveEta.etaMins}
              destinationCoords={jobSite.coordinates}
            />

            {/* Shelf 8: Electrical */}
            <ProductShelf
              title="⚡ Electrical & Power Protection"
              subtitle="Havells C-Curve MCBs, Wago lever clamps, insulation tape & copper wires"
              category="electrical"
              products={electricalProducts}
              cart={cart}
              onAddToCart={handleAddToCart}
              onUpdateCartQty={handleUpdateCartQty}
              onOpenDetail={setSelectedProductDetail}
              onSeeAll={handleSelectCategory}
              deliveryEtaMins={liveEta.etaMins}
              destinationCoords={jobSite.coordinates}
            />

            {/* Shelf 9: Fasteners */}
            <ProductShelf
              title="🔩 Screws, Anchors & Rawl Plugs"
              subtitle="Fischer nylon wall plugs, countersunk yellow zinc screws & concrete wedge bolts"
              category="fasteners"
              products={fastenerProducts}
              cart={cart}
              onAddToCart={handleAddToCart}
              onUpdateCartQty={handleUpdateCartQty}
              onOpenDetail={setSelectedProductDetail}
              onSeeAll={handleSelectCategory}
              deliveryEtaMins={liveEta.etaMins}
              destinationCoords={jobSite.coordinates}
            />

            {/* Shelf 10: Adhesives & Putty */}
            <ProductShelf
              title="🧪 Adhesives, M-Seal & WD-40"
              subtitle="CPVC solvent cement, Araldite steel epoxy, silicone caulk & rust sprays"
              category="adhesives"
              products={adhesiveProducts}
              cart={cart}
              onAddToCart={handleAddToCart}
              onUpdateCartQty={handleUpdateCartQty}
              onOpenDetail={setSelectedProductDetail}
              onSeeAll={handleSelectCategory}
              deliveryEtaMins={liveEta.etaMins}
              destinationCoords={jobSite.coordinates}
            />

            {/* Shelf 11: Tools & Safety */}
            <ProductShelf
              title="🧰 Tools, SDS Drill Bits & Safety Gear"
              subtitle="Bosch SDS-Plus 4-cutters, pipe pliers, Olfa blades & 3M safety goggles"
              category="tools"
              products={toolProducts}
              cart={cart}
              onAddToCart={handleAddToCart}
              onUpdateCartQty={handleUpdateCartQty}
              onOpenDetail={setSelectedProductDetail}
              onSeeAll={handleSelectCategory}
              deliveryEtaMins={liveEta.etaMins}
              destinationCoords={jobSite.coordinates}
            />

          </div>
        )}

        {/* Signature End-of-Feed Watermark Footer */}
        <div id="footer-watermark" className="pt-12 pb-20 sm:pt-16 sm:pb-24 w-full flex flex-col items-center justify-center text-center select-none space-y-2 px-4 mx-auto">
          {/* Subtle Pulse Lightning Bolt Icon above text */}
          <span className="text-amber-500 inline-block text-3xl sm:text-5xl md:text-6xl leading-none animate-pulse">⚡</span>

          {/* Subtle Watermark Headline (Hardware in Minutes) */}
          <h2 className="text-2xl min-[380px]:text-3xl sm:text-5xl md:text-6xl font-black tracking-tight text-slate-300/80 leading-normal sm:leading-none inline-flex items-center justify-center text-center select-none">
            <span>Hardware in Minutes</span>
          </h2>
          <p className="text-xs sm:text-sm text-slate-400 font-medium tracking-wide">
            Crafted with <span className="text-blue-500 font-bold">💙</span> in Bengaluru, India
          </p>
        </div>

      </main>

      {/* Signature Sticky Floating Bottom Cart Bar */}
      {totalCartCount > 0 && !isCartOpen && (
        <div className="fixed bottom-[68px] md:bottom-6 inset-x-0 z-40 max-w-lg mx-auto px-3 sm:px-4 animate-in slide-in-from-bottom-3">
          <div 
            id="floating-quick-cart-bar"
            onClick={() => setIsCartOpen(true)}
            className="bg-emerald-800 hover:bg-emerald-900 text-white rounded-2xl p-3 sm:p-3.5 px-4 sm:px-5 shadow-xl shadow-emerald-950/20 flex items-center justify-between cursor-pointer transition-transform active:scale-[0.99] border border-emerald-700/50"
          >
            <div className="flex items-center gap-2.5 sm:gap-3 min-w-0">
              <div className="w-8 h-8 rounded-xl bg-white/20 flex items-center justify-center font-black shrink-0">
                <ShoppingBag className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <div className="font-black text-xs sm:text-sm leading-none truncate">
                  {totalCartCount} {totalCartCount === 1 ? 'ITEM' : 'ITEMS'}
                </div>
                <div className="text-[10px] text-emerald-200 font-bold mt-0.5 flex items-center gap-1 truncate">
                  <span>⚡ {liveEta.formattedEta} Express Delivery</span>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-1 font-black text-[11px] sm:text-xs uppercase bg-white text-emerald-900 px-3 sm:px-3.5 py-1.5 sm:py-2 rounded-xl shadow-xs shrink-0 ml-2">
              <span>View Cart</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </div>
          </div>
        </div>
      )}

      {/* Mobile Bottom Tab Navigation (matching Reference Screenshots) */}
      <MobileBottomNav
        currentCategory={selectedCategory}
        onSelectCategory={handleSelectCategory}
        onOpenRestock={() => setIsRestockOpen(true)}
        onOpenProfile={() => setIsProfileModalOpen(true)}
        onOpenCart={() => setIsCartOpen(true)}
        cartCount={totalCartCount}
      />

      {/* Modals & Slide-over Drawers */}
      <PartFinderModal
        isOpen={isPartFinderOpen}
        onClose={() => setIsPartFinderOpen(false)}
        products={products}
        onAddToCart={handleAddToCart}
      />

      <RoiCalculatorModal
        isOpen={isRoiCalcOpen}
        onClose={() => setIsRoiCalcOpen(false)}
      />

      <AddressModal
        isOpen={isJobsiteModalOpen}
        onClose={() => setIsJobsiteModalOpen(false)}
        currentLocation={jobSite}
        onSaveLocation={setJobSite}
      />

      <CustomerProfileModal
        isOpen={isProfileModalOpen}
        onClose={() => setIsProfileModalOpen(false)}
        profile={customerProfile}
        onSaveProfile={setCustomerProfile}
        orders={orders}
        onOpenOrderTracking={(orderId) => {
          setActiveOrderId(orderId);
          setIsTrackingOpen(true);
        }}
        onUpdateJobSite={setJobSite}
      />

      <ProductDetailPage
        onOpenCart={() => setIsCartOpen(true)}
        product={selectedProductDetail}
        onClose={() => setSelectedProductDetail(null)}
        onAddToCart={handleAddToCart}
        allProducts={products}
        cart={cart}
        onUpdateCartQty={handleUpdateCartQty}
        onOpenDetail={setSelectedProductDetail}
        destinationCoords={jobSite.coordinates}
      />

      <OrderTrackingModal
        isOpen={isTrackingOpen}
        order={activeOrder}
        onClose={() => setIsTrackingOpen(false)}
        onUpdateOrderStatus={(newStatus) => {
          if (activeOrder) {
            handleUpdateOrderStatus(activeOrder.id, newStatus);
          }
        }}
      />

    </div>
  );
}


