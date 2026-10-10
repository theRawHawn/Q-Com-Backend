import React, { useState, useEffect, useRef } from 'react';
import { 
  ArrowLeft, 
  Trash2, 
  Plus, 
  Minus, 
  MapPin, 
  Building2, 
  CreditCard, 
  Zap, 
  ShieldCheck, 
  Clock, 
  Receipt, 
  ShoppingBag, 
  Check, 
  Tag, 
  Truck, 
  Sparkles, 
  Store, 
  Navigation, 
  ChevronLeft, 
  ChevronRight, 
  Percent, 
  X, 
  FileCheck2, 
  ChevronRight as ChevronRightIcon, 
  CheckCircle2, 
  FileText 
} from 'lucide-react';
import { CartItem, JobSiteLocation, HardwareProduct, CustomerProfile, SavedGstinRecord } from '../types';
import { calculateCartDispatchSummary } from '../utils/deliveryEta';
import { CustomerPricingService } from '../utils/customerPricingService';
import { feedback } from '../utils/feedback';
import { HandlingPlatformChargesModal } from './HandlingPlatformChargesModal';
import { 
  calculateOrderGstDistribution, 
  INDIAN_GST_STATES, 
  extractStateCodeFromGstin, 
  getStateNameByCode, 
  GST_STATE_MAP 
} from '../utils/gstEngine';

interface CartPageProps {
  items: CartItem[];
  allProducts: HardwareProduct[];
  jobSite: JobSiteLocation;
  customerProfile: CustomerProfile;
  onClose: () => void;
  onAddToCart: (product: HardwareProduct, qty?: number) => void;
  onUpdateQty: (productId: string, delta: number) => void;
  onRemoveItem: (productId: string) => void;
  onClearCart: () => void;
  onCheckout: (config: {
    paymentMethod: 'Instant UPI' | 'Corporate Card' | 'Pay on Jobsite' | 'Trade Credit (Net 30)';
    clientInvoiceNeeded: boolean;
    clientName?: string;
    isGstEnabled?: boolean;
    gstin?: string;
    businessName?: string;
    billingAddress?: string;
    state?: string;
    stateCode?: string;
    pincode?: string;
  }) => void;
  onOpenLocationModal: () => void;
  onOpenProfileModal: () => void;
  onOpenDetail?: (product: HardwareProduct | null) => void;
}

export const CartPage: React.FC<CartPageProps> = ({
  items,
  allProducts,
  jobSite,
  customerProfile,
  onClose,
  onAddToCart,
  onUpdateQty,
  onRemoveItem,
  onClearCart,
  onCheckout,
  onOpenLocationModal,
  onOpenProfileModal,
}) => {
  const [paymentMethod, setPaymentMethod] = useState<'Instant UPI' | 'Corporate Card' | 'Pay on Jobsite' | 'Trade Credit (Net 30)'>('Instant UPI');
  const [clientInvoiceNeeded, setClientInvoiceNeeded] = useState(true);
  const [clientName, setClientName] = useState(jobSite.jobTag || 'Flat 402 Renovation');
  const [promoCode, setPromoCode] = useState('');
  const [appliedPromo, setAppliedPromo] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  // GSTIN tick box & Multi-GSTIN selection state
  const savedGstinsList: SavedGstinRecord[] = customerProfile?.gstProfile?.savedGstins && customerProfile.gstProfile.savedGstins.length > 0
    ? customerProfile.gstProfile.savedGstins
    : (customerProfile?.gstProfile?.gstin 
        ? [{
            id: 'default_gst',
            gstin: customerProfile.gstProfile.gstin,
            legalBusinessName: customerProfile.gstProfile.legalBusinessName || 'Apex Infra & Renovations LLP',
            tradeName: customerProfile.gstProfile.tradeName,
            billingAddress: customerProfile.gstProfile.billingAddress || customerProfile.defaultAddress || 'Site 402, 100ft Road, Indiranagar',
            state: customerProfile.gstProfile.state || 'Karnataka',
            stateCode: customerProfile.gstProfile.stateCode || '29',
            pincode: customerProfile.gstProfile.pincode || '560038',
            isDefault: true
          }]
        : []);

  const defaultGstinItem = savedGstinsList.find(g => g.isDefault) || savedGstinsList[0];
  const savedGstin = defaultGstinItem?.gstin || customerProfile?.gstProfile?.gstin || '';
  const savedBusinessName = defaultGstinItem?.legalBusinessName || customerProfile?.gstProfile?.legalBusinessName || '';
  const savedAddress = defaultGstinItem?.billingAddress || customerProfile?.gstProfile?.billingAddress || customerProfile?.defaultAddress || 'Site 402, 100ft Road, Indiranagar';
  const savedStateCode = defaultGstinItem?.stateCode || customerProfile?.gstProfile?.stateCode || (savedGstin ? savedGstin.slice(0, 2) : '29');
  const savedState = defaultGstinItem?.state || customerProfile?.gstProfile?.state || getStateNameByCode(savedStateCode) || 'Karnataka';
  const savedPincode = defaultGstinItem?.pincode || customerProfile?.gstProfile?.pincode || '560038';

  const [isGstEnabled, setIsGstEnabled] = useState<boolean>(() => {
    return Boolean(customerProfile?.gstProfile?.isB2BEnabled && savedGstin);
  });
  
  const [selectedGstinId, setSelectedGstinId] = useState<string>(defaultGstinItem?.id || 'default_gst');
  const [gstinInput, setGstinInput] = useState<string>(savedGstin || '');
  const [businessNameInput, setBusinessNameInput] = useState<string>(savedBusinessName || '');
  const [billingAddressInput, setBillingAddressInput] = useState<string>(savedAddress || '');
  const [stateCodeInput, setStateCodeInput] = useState<string>(savedStateCode || '29');
  const [stateInput, setStateInput] = useState<string>(savedState || 'Karnataka');
  const [pincodeInput, setPincodeInput] = useState<string>(savedPincode || '560038');
  
  // Popup Modal states
  const [isGstModalOpen, setIsGstModalOpen] = useState(false);
  const [modalGstTab, setModalGstTab] = useState<'saved' | 'new'>(savedGstinsList.length > 0 ? 'saved' : 'new');
  const [modalGstinInput, setModalGstinInput] = useState(gstinInput || '');
  const [modalBusinessNameInput, setModalBusinessNameInput] = useState(businessNameInput || '');
  const [modalBillingAddressInput, setModalBillingAddressInput] = useState(billingAddressInput || '');
  const [modalStateCodeInput, setModalStateCodeInput] = useState(stateCodeInput || '29');
  const [modalPincodeInput, setModalPincodeInput] = useState(pincodeInput || '560038');
  const [modalSelectedId, setModalSelectedId] = useState(selectedGstinId);
  const [gstModalError, setGstModalError] = useState<string | null>(null);
  const [showChargesModal, setShowChargesModal] = useState(false);

  const [riderTip, setRiderTip] = useState<number>(0);

  const totalItemsCount = items.reduce((sum, i) => sum + i.quantity, 0);

  // Dynamic dispatch calculation across all sellers in the cart based on distance to jobsite
  const dispatchSummary = calculateCartDispatchSummary(items, jobSite.coordinates);

  const subtotal = items.reduce((sum, item) => sum + item.product.price * item.quantity, 0);
  const mrpTotal = items.reduce((sum, item) => sum + (item.product.originalPrice || item.product.price) * item.quantity, 0);

  // Delivery Pricing Engine Centralized Service Integration
  const eligibleCartValue = subtotal;
  const routeDistanceMeters = Math.max(1200, Math.round((dispatchSummary.farthestHubDistanceKm || 1.8) * 1000));
  const deliveryPricingResult = CustomerPricingService.calculateCustomerDeliveryCharge(
    eligibleCartValue,
    routeDistanceMeters
  );

  const isFreeDelivery = deliveryPricingResult.isFreeDelivery;
  const deliveryFee = subtotal === 0 ? 0 : deliveryPricingResult.deliveryCharge;
  const deliverySavings = isFreeDelivery ? 39 : 0;
  const handlingCharge = CustomerPricingService.calculateHandlingCharge(subtotal);
  const discount = appliedPromo ? Math.round(subtotal * 0.1) : 0;
  const totalSavings = Math.max(0, (mrpTotal - subtotal) + discount + deliverySavings);
  const total = Math.max(0, subtotal - discount + deliveryFee + handlingCharge + riderTip);

  // Track and trigger 'Free delivery availed' milestone celebration feedback
  const prevFreeDeliveryRef = useRef<boolean>(isFreeDelivery);
  useEffect(() => {
    if (isFreeDelivery && !prevFreeDeliveryRef.current && items.length > 0) {
      feedback.freeDeliveryAvailed();
    }
    prevFreeDeliveryRef.current = isFreeDelivery;
  }, [isFreeDelivery, items.length]);

  // Authoritative State-wise GST Distribution Engine
  const activeBuyerGstin = isGstEnabled ? (gstinInput.trim().toUpperCase() || savedGstin) : undefined;
  const activeBuyerStateCode = isGstEnabled ? stateCodeInput : '29';
  const activeBuyerState = isGstEnabled ? stateInput : 'Karnataka';

  const gstBreakdown = calculateOrderGstDistribution({
    items: items.map(item => ({
      product: {
        id: item.product.id,
        name: item.product.name,
        category: item.product.category,
        subcategory: item.product.subcategory,
        price: item.product.price,
        gstRatePercent: item.product.gstRatePercent ?? 18,
        sellerGstin: (item.product as any).sellerGstin || '29AABCS8812K1ZM',
        isGstRegistered: item.product.isGstRegistered !== false,
      },
      quantity: item.quantity,
    })),
    buyerGstin: activeBuyerGstin,
    buyerBusinessName: isGstEnabled ? (businessNameInput || savedBusinessName) : undefined,
    buyerAddress: isGstEnabled ? (billingAddressInput || savedAddress) : undefined,
    buyerStateCode: activeBuyerStateCode,
    buyerState: activeBuyerState,
    buyerPincode: isGstEnabled ? pincodeInput : undefined,
    sellerStateCode: '29', // Bangalore Seller Hub
    deliveryFee,
    handlingFee: handlingCharge,
    discount,
  });

  const isValidGstinFormat = (val: string) => {
    return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(val.trim().toUpperCase());
  };

  const openGstModal = () => {
    setModalGstinInput(gstinInput || savedGstin || '');
    setModalBusinessNameInput(businessNameInput || savedBusinessName || '');
    setModalBillingAddressInput(billingAddressInput || savedAddress || '');
    setModalStateCodeInput(stateCodeInput || savedStateCode || '29');
    setModalPincodeInput(pincodeInput || savedPincode || '560038');
    setModalSelectedId(selectedGstinId);
    setModalGstTab(savedGstinsList.length > 0 ? 'saved' : 'new');
    setGstModalError(null);
    setIsGstModalOpen(true);
  };

  const handleConfirmGstModal = () => {
    if (modalGstTab === 'saved') {
      const chosen = savedGstinsList.find(g => g.id === modalSelectedId);
      if (chosen) {
        setSelectedGstinId(chosen.id);
        setGstinInput(chosen.gstin);
        setBusinessNameInput(chosen.legalBusinessName);
        setBillingAddressInput(chosen.billingAddress || customerProfile.defaultAddress || 'Jobsite Address');
        setStateCodeInput(chosen.stateCode || chosen.gstin.slice(0, 2) || '29');
        setStateInput(chosen.state || getStateNameByCode(chosen.stateCode || chosen.gstin.slice(0, 2)));
        setPincodeInput(chosen.pincode || '560038');
        setIsGstEnabled(true);
        setIsGstModalOpen(false);
        setGstModalError(null);
        return;
      }
    }

    // New GST Tab Full Form Validation
    const cleanGstin = modalGstinInput.trim().toUpperCase();
    if (!cleanGstin) {
      setGstModalError('Please enter your 15-digit GSTIN number');
      return;
    }
    if (cleanGstin.length !== 15 || !isValidGstinFormat(cleanGstin)) {
      setGstModalError('GSTIN must be 15 alphanumeric characters (e.g. 29AABCP1429B1Z8)');
      return;
    }

    const businessName = modalBusinessNameInput.trim();
    if (!businessName) {
      setGstModalError('Please enter your Registered Legal Business / Company Name');
      return;
    }

    const address = modalBillingAddressInput.trim();
    if (!address) {
      setGstModalError('Please enter your Registered Billing Address');
      return;
    }

    const pincode = modalPincodeInput.trim();
    if (!pincode || !/^\d{6}$/.test(pincode)) {
      setGstModalError('Please enter a valid 6-digit Indian PIN code (e.g. 560038)');
      return;
    }

    const detectedStateCode = extractStateCodeFromGstin(cleanGstin) || modalStateCodeInput || '29';
    const stateName = getStateNameByCode(detectedStateCode);

    setGstinInput(cleanGstin);
    setBusinessNameInput(businessName);
    setBillingAddressInput(address);
    setStateCodeInput(detectedStateCode);
    setStateInput(stateName);
    setPincodeInput(pincode);
    setSelectedGstinId('custom');
    setIsGstEnabled(true);
    setIsGstModalOpen(false);
    setGstModalError(null);
  };

  const handleRemoveGst = () => {
    setIsGstEnabled(false);
  };

  // Cross-sell items for carousel
  const carouselRef = React.useRef<HTMLDivElement>(null);
  const cartProductIds = new Set(items.map(i => i.product.id));
  const suggestedCompanions = allProducts.filter(p => !cartProductIds.has(p.id)).slice(0, 10);

  const scrollCarousel = (direction: 'left' | 'right') => {
    if (carouselRef.current) {
      const scrollAmount = direction === 'left' ? -240 : 240;
      carouselRef.current.scrollBy({ left: scrollAmount, behavior: 'smooth' });
    }
  };

  const handlePlaceOrder = () => {
    if (isGstEnabled) {
      const activeGstin = (gstinInput || savedGstin).trim().toUpperCase();
      if (!activeGstin) {
        setGstModalError('Please enter a valid 15-digit GSTIN or disable GSTIN to order as an individual.');
        openGstModal();
        return;
      }
      if (!isValidGstinFormat(activeGstin)) {
        setGstModalError('Invalid GSTIN format (e.g. 29AABCP1429B1Z8). Please correct your GSTIN.');
        openGstModal();
        return;
      }
    }
    feedback.placeOrder();
    setIsProcessing(true);
    setTimeout(() => {
      const activeGstin = isGstEnabled ? (gstinInput.trim().toUpperCase() || savedGstin) : undefined;
      const activeBusiness = isGstEnabled ? (businessNameInput.trim() || savedBusinessName || 'Registered Enterprise') : undefined;
      const activeAddress = isGstEnabled ? (billingAddressInput.trim() || savedAddress) : undefined;
      const activeState = isGstEnabled ? (stateInput || savedState) : undefined;
      const activeStateCode = isGstEnabled ? (stateCodeInput || savedStateCode) : undefined;
      const activePincode = isGstEnabled ? (pincodeInput.trim() || savedPincode) : undefined;
      
      onCheckout({
        paymentMethod,
        clientInvoiceNeeded,
        clientName,
        isGstEnabled,
        gstin: activeGstin,
        businessName: activeBusiness,
        billingAddress: activeAddress,
        state: activeState,
        stateCode: activeStateCode,
        pincode: activePincode
      });
      setIsProcessing(false);
    }, 400);
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col">
      
      {/* Top Cart Navigation Bar */}
      <header className="sticky top-0 z-30 bg-white border-b border-slate-200/80 shadow-2xs">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={onClose}
              className="p-2 -ml-2 rounded-xl text-slate-700 hover:bg-slate-100 transition cursor-pointer flex items-center gap-1.5 font-bold text-xs shrink-0"
              title="Back to Catalog"
            >
              <ArrowLeft className="w-5 h-5 text-slate-900" />
              <span className="hidden sm:inline text-slate-800">Back to Store</span>
            </button>
            <div className="h-5 w-px bg-slate-200 hidden sm:block" />
            <h1 className="text-base sm:text-lg font-black text-slate-900 tracking-tight truncate">
              Checkout & Review
            </h1>
          </div>

          {/* Redesigned Item Count Badge (Right Side) */}
          <div className="flex items-center gap-2 bg-emerald-50 border border-emerald-200/80 text-emerald-900 px-3.5 py-1.5 rounded-full shadow-2xs shrink-0 ml-auto">
            <ShoppingBag className="w-4 h-4 text-emerald-700 shrink-0" />
            <span className="text-xs sm:text-sm font-black tracking-tight">
              {totalItemsCount} {totalItemsCount === 1 ? 'Item' : 'Items'}
            </span>
          </div>
        </div>
      </header>

      {/* Main Cart Content Area */}
      <main className="flex-1 max-w-6xl w-full mx-auto px-3 sm:px-6 py-4 sm:py-6 pb-32 sm:pb-24">
        
        {items.length === 0 ? (
          /* Empty Cart State */
          <div className="max-w-md mx-auto my-12 text-center bg-white rounded-3xl border border-slate-200 p-8 shadow-xs space-y-4">
            <div className="w-16 h-16 rounded-2xl bg-emerald-50 text-emerald-700 flex items-center justify-center mx-auto shadow-2xs">
              <ShoppingBag className="w-8 h-8" />
            </div>
            <div>
              <h2 className="text-lg font-black text-slate-900">Your Cart is Empty</h2>
              <p className="text-xs text-slate-500 mt-1 max-w-xs mx-auto">
                No hardware items added yet. Browse emergency repair parts, valves, breakers & screws for instant courier dispatch.
              </p>
            </div>
            <button
              onClick={onClose}
              className="w-full bg-emerald-700 hover:bg-emerald-800 text-white font-extrabold text-xs py-3 rounded-xl transition cursor-pointer shadow-sm"
            >
              Explore Catalog
            </button>
          </div>
        ) : (
          /* 2-Column Responsive Layout */
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 sm:gap-6 items-start">
            
            {/* Left Column (8 Cols on Desktop) */}
            <div className="lg:col-span-7 xl:col-span-8 space-y-4">
              
              {/* 1. Jobsite Delivery Address Card */}
              <section className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-5 shadow-2xs">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3 min-w-0">
                    <div className="w-9 h-9 rounded-xl bg-emerald-50 text-emerald-700 flex items-center justify-center shrink-0 mt-0.5">
                      <MapPin className="w-5 h-5" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-black text-sm text-slate-900 truncate">
                          {jobSite.jobTag || 'Jobsite Floor Drop'}
                        </span>
                      </div>
                      <div className="text-xs text-slate-700 font-semibold mt-1">
                        {jobSite.floorUnit} • {jobSite.address}
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        Landmark: {jobSite.landmark} • Gate: {jobSite.gateCode}
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        Site Contact: <strong>{jobSite.siteContactName}</strong> ({jobSite.sitePhone})
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-3 shrink-0">
                    {/* Plain ETA & distance - no card border */}
                    <div className="text-right leading-tight hidden sm:block">
                      <div className="text-sm font-black text-slate-900">
                        ⚡ {dispatchSummary.formattedEta}
                      </div>
                      <div className="text-[11px] font-bold text-slate-500">
                        {dispatchSummary.nearestHubDistanceKm.toFixed(1)} km away
                      </div>
                    </div>

                    <button
                      onClick={onOpenLocationModal}
                      className="text-xs font-bold text-emerald-700 hover:text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 px-3 py-1.5 rounded-xl transition cursor-pointer"
                    >
                      Change
                    </button>
                  </div>
                </div>
              </section>

              {/* 2. Cart Items List */}
              <section className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-5 shadow-2xs space-y-4">
                <div className="flex items-center justify-between pb-3 border-b border-slate-100">
                  <div>
                    <h2 className="text-sm sm:text-base font-black text-slate-900">
                      Order Items ({items.length})
                    </h2>
                  </div>
                  <button
                    onClick={onClearCart}
                    className="text-xs font-bold text-rose-600 hover:text-rose-700 hover:bg-rose-50 px-2.5 py-1 rounded-lg transition cursor-pointer"
                  >
                    Clear All
                  </button>
                </div>

                <div className="divide-y divide-slate-100">
                  {items.map(({ product, quantity }) => (
                    <div key={product.id} className="py-3.5 first:pt-0 last:pb-0 flex items-center justify-between gap-3">
                      
                      {/* Product Thumbnail & Details */}
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        <div className="w-14 h-14 sm:w-16 sm:h-16 rounded-xl overflow-hidden bg-slate-100 border border-slate-200 shrink-0">
                          {product.imageUrl ? (
                            <img
                              src={product.imageUrl}
                              alt={product.name}
                              referrerPolicy="no-referrer"
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-slate-400 font-bold text-xs">
                              {product.category}
                            </div>
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <span className="text-[10px] font-black text-slate-400 uppercase tracking-tight block">
                            {product.specs?.brand || 'PRO HARDWARE'} • SKU: {product.id}
                          </span>
                          <h3 className="text-xs sm:text-sm font-black text-slate-900 truncate leading-snug">
                            {product.name}
                          </h3>
                          <div className="text-[11px] text-slate-500 truncate mt-0.5">
                            {product.specs?.size || product.specs?.standard || 'Standard Size'}
                          </div>
                          <div className="text-xs font-black text-slate-900 mt-1">
                            <span>₹{product.price} <span className="text-[10px] font-medium text-slate-400">/ unit</span></span>
                          </div>
                        </div>
                      </div>

                      {/* Quantity Stepper & Subtotal */}
                      <div className="flex flex-col items-end gap-1.5 shrink-0">
                        <div className="bg-emerald-700 text-white rounded-lg px-2 py-1 flex items-center gap-2 shadow-2xs font-extrabold text-xs">
                          <button
                            onClick={() => onUpdateQty(product.id, -1)}
                            className="hover:bg-emerald-800 rounded p-0.5 transition cursor-pointer text-white"
                            title="Decrease quantity"
                          >
                            {quantity === 1 ? <Trash2 className="w-3.5 h-3.5 text-rose-200 hover:text-white" /> : <Minus className="w-3.5 h-3.5 stroke-[2.5]" />}
                          </button>
                          <span className="w-4 text-center font-mono text-xs font-black text-white">
                            {quantity}
                          </span>
                          <button
                            onClick={() => onUpdateQty(product.id, 1)}
                            className="hover:bg-emerald-800 rounded p-0.5 transition cursor-pointer text-white"
                            title="Increase quantity"
                          >
                            <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
                          </button>
                        </div>
                        <div className="text-right">
                          <span className="text-xs font-black text-slate-900">
                            ₹{product.price * quantity}
                          </span>
                          {(product.mrp || product.originalPrice) && ((product.mrp || product.originalPrice)! > product.price) && (
                            <div className="text-[10px] text-slate-400 line-through">
                              ₹{((product.mrp || product.originalPrice)!) * quantity}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              {/* 4. Frequently Bought Together Carousel */}
              {suggestedCompanions.length > 0 && (
                <section className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-5 shadow-2xs space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <Sparkles className="w-4 h-4 text-emerald-600" />
                      <h2 className="text-xs sm:text-sm font-black text-slate-900">
                        Frequently Bought Together
                      </h2>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => scrollCarousel('left')}
                        className="w-7 h-7 rounded-full bg-slate-100 hover:bg-slate-200 text-slate-700 flex items-center justify-center transition cursor-pointer"
                        aria-label="Scroll left"
                      >
                        <ChevronLeft className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => scrollCarousel('right')}
                        className="w-7 h-7 rounded-full bg-slate-100 hover:bg-slate-200 text-slate-700 flex items-center justify-center transition cursor-pointer"
                        aria-label="Scroll right"
                      >
                        <ChevronRight className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  <div
                    ref={carouselRef}
                    className="flex gap-3 overflow-x-auto pb-2 pt-1 scroll-smooth snap-x snap-mandatory"
                    style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
                  >
                    {suggestedCompanions.map((comp) => {
                      const compQty = items.find(i => i.product.id === comp.id)?.quantity || 0;
                      return (
                        <div
                          key={comp.id}
                          className="w-36 sm:w-40 shrink-0 bg-white hover:bg-slate-50/80 border border-slate-200/90 rounded-2xl p-2.5 flex flex-col justify-between snap-start transition shadow-2xs group"
                        >
                          <div>
                            {/* Product Image + Floating ADD / Stepper */}
                            <div className="relative mb-2.5 rounded-xl overflow-hidden bg-slate-50 border border-slate-200/70 aspect-square flex items-center justify-center">
                              <img
                                src={comp.imageUrl}
                                alt={comp.name}
                                referrerPolicy="no-referrer"
                                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                              />
                              
                              {comp.specs?.brand && (
                                <span className="absolute top-1.5 left-1.5 bg-slate-900/80 text-white text-[9px] font-bold px-1.5 py-0.5 rounded backdrop-blur-xs">
                                  {comp.specs.brand}
                                </span>
                              )}

                              {/* Floating ADD / Stepper Button */}
                              <div className="absolute bottom-1.5 right-1.5">
                                {compQty === 0 ? (
                                  <button
                                    type="button"
                                    onClick={() => onAddToCart(comp, 1)}
                                    className="bg-white hover:bg-emerald-50 text-emerald-700 border-2 border-emerald-600 font-black text-[11px] px-2.5 py-1 rounded-lg shadow-md transition-all cursor-pointer flex items-center gap-1 uppercase"
                                  >
                                    <span>ADD</span>
                                    <Plus className="w-3 h-3 stroke-[3]" />
                                  </button>
                                ) : (
                                  <div className="bg-emerald-700 text-white font-extrabold text-xs rounded-lg px-2 py-1 shadow-md flex items-center gap-1.5">
                                    <button
                                      type="button"
                                      onClick={() => onUpdateQty(comp.id, -1)}
                                      className="hover:bg-emerald-800 rounded p-0.5 transition cursor-pointer"
                                    >
                                      {compQty === 1 ? <Trash2 className="w-3 h-3 text-rose-200" /> : <Minus className="w-3 h-3 stroke-[3]" />}
                                    </button>
                                    <span className="font-mono text-xs w-3 text-center">{compQty}</span>
                                    <button
                                      type="button"
                                      onClick={() => onUpdateQty(comp.id, 1)}
                                      className="hover:bg-emerald-800 rounded p-0.5 transition cursor-pointer"
                                    >
                                      <Plus className="w-3 h-3 stroke-[3]" />
                                    </button>
                                  </div>
                                )}
                              </div>
                            </div>

                            {/* Pack Size / Unit Badge */}
                            <div className="text-[10px] text-slate-500 font-bold bg-slate-100 w-fit px-1.5 py-0.5 rounded mb-1">
                              {comp.specs?.size || comp.specs?.standard || '1 Unit'}
                            </div>

                            {/* Product Title */}
                            <h4 className="text-xs font-extrabold text-slate-900 line-clamp-2 leading-tight mb-1">
                              {comp.name}
                            </h4>
                          </div>

                          {/* Price Row */}
                          <div className="flex items-baseline gap-1.5 mt-2 pt-2 border-t border-slate-100">
                            <span className="text-xs font-black text-slate-900">₹{comp.price}</span>
                            {(comp.mrp || comp.originalPrice) && ((comp.mrp || comp.originalPrice)! > comp.price) && (
                              <span className="text-[10px] text-slate-400 line-through">₹{comp.mrp || comp.originalPrice}</span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

              {/* 5. B2B GSTIN Invoicing Card (Zepto / Blinkit Quick Commerce style) */}
              <section className="bg-white rounded-2xl border border-slate-200 p-3.5 sm:p-4 shadow-2xs">
                <div 
                  onClick={openGstModal}
                  className="flex items-center justify-between gap-3 cursor-pointer group select-none"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    {/* Blue percent badge icon matching reference */}
                    <div className="w-10 h-10 rounded-2xl bg-sky-50 border border-sky-100 flex items-center justify-center text-sky-600 shrink-0 group-hover:scale-105 transition">
                      <Percent className="w-5 h-5 stroke-[2.5]" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-extrabold text-sm sm:text-base text-slate-900">
                          {isGstEnabled && (gstinInput || savedGstin) ? 'B2B GST Details Added' : 'Add GST Details'}
                        </span>
                      </div>
                      <p className="text-xs text-slate-500 font-medium truncate mt-0.5">
                        {isGstEnabled && (gstinInput || savedGstin) ? (
                          <span className="text-slate-700">
                            <span className="font-mono font-bold text-slate-900">{gstinInput || savedGstin}</span>
                            {(businessNameInput || savedBusinessName) && (
                              <span> • {businessNameInput || savedBusinessName}</span>
                            )}
                            <span className="text-slate-400 font-normal"> ({stateInput || 'Karnataka'} • {pincodeInput || '560038'})</span>
                          </span>
                        ) : (
                          'Claim 100% input tax credit (CGST/SGST/UTGST/IGST) on your B2B invoice'
                        )}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {isGstEnabled && (gstinInput || savedGstin) ? (
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleRemoveGst();
                          }}
                          className="text-xs font-bold text-slate-400 hover:text-red-600 px-2 py-1 rounded-lg hover:bg-red-50 transition"
                        >
                          Remove
                        </button>
                        <ChevronRightIcon className="w-4 h-4 text-slate-400 group-hover:text-slate-700 transition group-hover:translate-x-0.5" />
                      </div>
                    ) : (
                      <ChevronRightIcon className="w-5 h-5 text-slate-400 group-hover:text-slate-700 transition group-hover:translate-x-0.5" />
                    )}
                  </div>
                </div>
              </section>

            </div>

            {/* Right Column (4-5 Cols on Desktop - Sticky Payment & Bill Summary) */}
            <div className="lg:col-span-5 xl:col-span-4 space-y-4 lg:sticky lg:top-20">
              
              {/* Payment Methods */}
              <section className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-5 shadow-2xs space-y-3">
                <h2 className="text-xs sm:text-sm font-black text-slate-900 flex items-center gap-1.5">
                  <CreditCard className="w-4 h-4 text-emerald-700" />
                  <span>Select Payment Method</span>
                </h2>

                <div className="space-y-2">
                  {[
                    { id: 'Instant UPI', label: 'Instant UPI / QR Code', sub: 'Google Pay, PhonePe, Paytm', icon: '⚡' },
                    { id: 'Corporate Card', label: 'Corporate Card / NetBanking', sub: 'Visa, Master, Rupay Corporate', icon: '💳' },
                    { id: 'Pay on Jobsite', label: 'Pay on Floor Drop (Cash / UPI)', sub: 'Pay rider after inspection', icon: '💵' },
                    { id: 'Trade Credit (Net 30)', label: 'Trade Credit (Net 30)', sub: 'Pre-approved contractor credit line', icon: '📋' },
                  ].map((method) => (
                    <label
                      key={method.id}
                      onClick={() => setPaymentMethod(method.id as any)}
                      className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition ${
                        paymentMethod === method.id
                          ? 'bg-emerald-50/80 border-emerald-500 shadow-2xs'
                          : 'bg-white hover:bg-slate-50 border-slate-200'
                      }`}
                    >
                      <input
                        type="radio"
                        name="paymentMethod"
                        checked={paymentMethod === method.id}
                        onChange={() => setPaymentMethod(method.id as any)}
                        className="mt-0.5 text-emerald-600 focus:ring-emerald-500"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="font-bold text-xs text-slate-900 flex items-center gap-1.5">
                          <span>{method.icon}</span>
                          <span>{method.label}</span>
                        </div>
                        <div className="text-[10px] text-slate-500 mt-0.5">{method.sub}</div>
                      </div>
                    </label>
                  ))}
                </div>
              </section>

              {/* Green Savings Banner */}
              {totalSavings > 0 && (
                <div className="bg-emerald-600 text-white font-extrabold text-xs px-4 py-2.5 rounded-2xl flex items-center justify-between shadow-2xs">
                  <div className="flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-emerald-200" />
                    <span>Saved <span className="bg-emerald-800 text-white px-2 py-0.5 rounded-md font-mono font-black">₹{totalSavings}</span> with this order!</span>
                  </div>
                </div>
              )}

              {/* Bill Details */}
              <section className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-5 shadow-2xs space-y-3.5">
                <h2 className="text-xs font-black text-slate-500 uppercase tracking-wider">
                  Bill Details
                </h2>

                {/* Promo Code Input */}
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Tag className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-2.5" />
                    <input
                      type="text"
                      value={promoCode}
                      onChange={(e) => setPromoCode(e.target.value.toUpperCase())}
                      placeholder="Enter Coupon Code"
                      className="w-full bg-slate-50 border border-slate-200 rounded-xl pl-8 pr-3 py-1.5 text-xs font-bold uppercase focus:bg-white focus:border-emerald-600 focus:outline-none"
                    />
                  </div>
                  <button
                    onClick={() => {
                      if (promoCode) {
                        setAppliedPromo(promoCode);
                        setPromoCode('');
                      }
                    }}
                    className="bg-slate-900 text-white font-bold text-xs px-3.5 py-1.5 rounded-xl hover:bg-slate-800 transition cursor-pointer"
                  >
                    Apply
                  </button>
                </div>

                {appliedPromo && (
                  <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-bold px-3 py-1.5 rounded-xl flex items-center justify-between">
                    <span className="flex items-center gap-1">
                      <Sparkles className="w-3.5 h-3.5 text-emerald-600" />
                      Coupon '{appliedPromo}' Applied (-10%)
                    </span>
                    <button
                      onClick={() => setAppliedPromo(null)}
                      className="text-emerald-900 font-black hover:underline cursor-pointer text-[11px]"
                    >
                      Remove
                    </button>
                  </div>
                )}

                {/* Free Delivery Target Banner (Admin Configurable Threshold) */}
                <div className={`p-3 rounded-xl border text-xs font-semibold ${
                  isFreeDelivery 
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                    : 'bg-amber-50/80 border-amber-200 text-amber-900'
                }`}>
                  <div className="flex items-center justify-between mb-1.5 font-bold">
                    <span>
                      {isFreeDelivery 
                        ? '🎉 FREE Delivery Unlocked!' 
                        : `Add ₹${deliveryPricingResult.amount_remaining_for_free_delivery} more to get FREE delivery`}
                    </span>
                    <span className="text-[11px] font-mono">
                      {isFreeDelivery ? 'FREE' : `₹${eligibleCartValue}/₹${deliveryPricingResult.free_delivery_threshold}`}
                    </span>
                  </div>
                  <div className="w-full bg-slate-200 h-1.5 rounded-full overflow-hidden">
                    <div 
                      className={`h-full transition-all duration-300 ${isFreeDelivery ? 'bg-emerald-600' : 'bg-amber-500'}`}
                      style={{ width: `${Math.min(100, (eligibleCartValue / deliveryPricingResult.free_delivery_threshold) * 100)}%` }}
                    />
                  </div>
                </div>

                {/* Price Breakdown */}
                <div className="space-y-2.5 text-xs text-slate-600 pt-1 border-t border-slate-100">
                  <div className="flex justify-between items-center">
                    <span>Item Total</span>
                    <div className="font-bold text-slate-900 flex items-center gap-1.5">
                      {mrpTotal > subtotal && (
                        <span className="text-slate-400 line-through text-[11px]">₹{mrpTotal}</span>
                      )}
                      <span>₹{subtotal}</span>
                    </div>
                  </div>

                  {discount > 0 && (
                    <div className="flex justify-between items-center text-emerald-700 font-bold">
                      <span>Pro Coupon Discount</span>
                      <span>-₹{discount}</span>
                    </div>
                  )}

                  <div className="flex justify-between items-center">
                    <span>Delivery Partner Fee</span>
                    <span className="font-bold text-slate-900">
                      {isFreeDelivery ? (
                        <span className="text-emerald-700 font-black">FREE</span>
                      ) : (
                        `₹${deliveryFee}`
                      )}
                    </span>
                  </div>

                  <div className="flex justify-between items-center py-1">
                    <button
                      type="button"
                      onClick={() => setShowChargesModal(true)}
                      className="flex items-center gap-1.5 text-left group cursor-pointer"
                      title="Click to view breakdown"
                    >
                      <span className="font-semibold text-slate-700 group-hover:text-emerald-700 border-b border-dashed border-slate-400 group-hover:border-emerald-600 transition">
                        Handling &amp; Platform Charges
                      </span>
                      <span className="text-[11px] text-slate-400 group-hover:text-emerald-600 font-bold">ⓘ</span>
                    </button>
                    <span className="font-bold text-slate-900 font-mono">₹{handlingCharge}</span>
                  </div>

                  {/* Delivery Partner Tip Section */}
                  <div className="pt-2 border-t border-slate-100 space-y-2">
                    <div className="flex justify-between items-center text-xs font-bold text-slate-800">
                      <span className="flex items-center gap-1">
                        <span>Delivery Partner Tip</span>
                        <span className="text-[10px] text-slate-400 font-normal">(100% to rider)</span>
                      </span>
                      {riderTip > 0 && (
                        <button
                          type="button"
                          onClick={() => setRiderTip(0)}
                          className="text-[10px] text-emerald-700 hover:underline font-bold"
                        >
                          Clear Tip
                        </button>
                      )}
                    </div>
                    <div className="grid grid-cols-4 gap-1.5">
                      {[
                        { amount: 10, label: '₹10' },
                        { amount: 20, label: '₹20', badge: 'Most tipped' },
                        { amount: 30, label: '₹30' },
                        { amount: 50, label: '₹50' },
                      ].map((tip) => (
                        <button
                          key={tip.amount}
                          type="button"
                          onClick={() => setRiderTip(riderTip === tip.amount ? 0 : tip.amount)}
                          className={`py-1.5 px-1 rounded-xl border text-xs font-black transition cursor-pointer flex flex-col items-center justify-center relative ${
                            riderTip === tip.amount
                              ? 'bg-emerald-700 text-white border-emerald-800 shadow-2xs'
                              : 'bg-slate-50 hover:bg-slate-100 border-slate-200 text-slate-800'
                          }`}
                        >
                          <span>{tip.label}</span>
                          {tip.badge && (
                            <span className={`text-[7.5px] font-extrabold tracking-tight ${riderTip === tip.amount ? 'text-emerald-200' : 'text-emerald-700'}`}>
                              {tip.badge}
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* To Pay Total */}
                  <div className="pt-3 border-t border-slate-200 flex justify-between items-baseline font-black text-sm sm:text-base text-slate-900">
                    <div>
                      <div>To Pay</div>
                      <div className="text-[10px] text-slate-400 font-medium">Inclusive of all taxes</div>
                    </div>
                    <div className="text-right flex items-baseline gap-1.5">
                      {(discount > 0 || mrpTotal > subtotal) && (
                        <span className="text-xs text-slate-400 line-through font-medium">
                          ₹{mrpTotal + deliveryFee + handlingCharge + riderTip}
                        </span>
                      )}
                      <span className="text-lg font-black text-emerald-900">₹{total}</span>
                    </div>
                  </div>
                </div>

              </section>

              {/* Order Cancellation & Dispatch Disclaimer Card */}
              <div className="bg-amber-50/90 border border-amber-200 rounded-2xl p-3.5 text-xs space-y-1">
                <div className="font-black text-amber-900 flex items-center gap-1.5">
                  <ShieldCheck className="w-4 h-4 text-amber-700 shrink-0" />
                  <span>NOTE: Instant Dispatch Policy</span>
                </div>
                <p className="text-[11px] text-amber-800 leading-relaxed font-medium">
                  Orders are packed and dispatched immediately to meet jobsite deadlines. Orders cannot be cancelled once packed.
                </p>
              </div>

            </div>

          </div>
        )}

      </main>

      {/* Universal Sticky Bottom Bar */}
      {items.length > 0 && (
        <div className="fixed bottom-0 inset-x-0 z-40 bg-white border-t border-slate-200 p-3 px-4 sm:px-6 shadow-xl">
          <div className="max-w-6xl mx-auto flex items-center justify-between gap-3">
            <div>
              <div className="text-[10px] text-slate-500 font-extrabold uppercase tracking-tight">
                Pay via {paymentMethod} • ⚡ {dispatchSummary.formattedEta}
              </div>
              <div className="text-lg font-black text-slate-900">
                ₹{total}
              </div>
            </div>

            <button
              id="confirm-place-order-btn"
              onClick={handlePlaceOrder}
              disabled={isProcessing}
              className="bg-emerald-700 hover:bg-emerald-800 active:bg-emerald-900 text-white font-black text-xs sm:text-sm uppercase px-6 sm:px-8 py-3 rounded-xl transition cursor-pointer shadow-md shadow-emerald-900/10 flex items-center gap-1 disabled:opacity-50"
            >
              <span>{isProcessing ? 'Dispatching...' : 'Place Order⚡'}</span>
            </button>
          </div>
        </div>
      )}

      {/* GST Details Popup Modal / Bottom Sheet (Matching Reference Screenshot) */}
      {isGstModalOpen && (
        <div 
          className="fixed inset-0 z-50 flex flex-col justify-end sm:justify-center items-center p-0 sm:p-4 bg-slate-950/65 backdrop-blur-xs transition-opacity animate-in fade-in duration-200"
          onClick={() => setIsGstModalOpen(false)}
        >
          <div 
            className="w-full max-w-lg flex flex-col items-center animate-in slide-in-from-bottom duration-300"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Top Floating Close Button positioned cleanly above the sheet */}
            <div className="w-full flex justify-center pb-3">
              <button
                type="button"
                onClick={() => setIsGstModalOpen(false)}
                className="w-10 h-10 rounded-full bg-slate-900 text-white flex items-center justify-center shadow-xl hover:bg-slate-800 transition cursor-pointer border border-white/20 active:scale-95 shrink-0"
                title="Close"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Bottom Sheet Modal Body */}
            <div className="relative w-full bg-white rounded-t-[32px] sm:rounded-3xl p-6 sm:p-7 shadow-2xl space-y-5 max-h-[85vh] overflow-y-auto">
              {/* Illustration Icon */}
              <div className="flex justify-center pt-1">
                <div className="relative w-28 h-24 flex items-center justify-center">
                  <div className="absolute inset-0 bg-sky-50 rounded-full filter blur-md opacity-60"></div>
                  {/* Clean invoice illustration */}
                  <div className="relative bg-white border border-slate-200 rounded-xl shadow-md w-20 h-24 p-2 flex flex-col justify-between transform -rotate-1">
                    <div className="space-y-1.5">
                      <div className="h-1.5 w-10 bg-slate-300 rounded"></div>
                      <div className="h-1 w-14 bg-slate-200 rounded"></div>
                      <div className="h-1.5 w-full bg-slate-800 rounded mt-2"></div>
                      <div className="grid grid-cols-2 gap-1 pt-1">
                        <div className="h-4 bg-slate-100 rounded border border-slate-200/60"></div>
                        <div className="h-4 bg-slate-100 rounded border border-slate-200/60"></div>
                      </div>
                    </div>
                    <div className="flex justify-end">
                      <div className="w-4 h-4 rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center">
                        <Check className="w-2.5 h-2.5" />
                      </div>
                    </div>
                  </div>
                </div>
              </div>

            {/* Title & Description matching reference */}
            <div className="text-center space-y-1.5">
              <h3 className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight">
                Add GST Details
              </h3>
              <p className="text-xs sm:text-sm text-slate-500 max-w-sm mx-auto leading-relaxed">
                If you're a business owner, add your GST details and get GST invoice on your orders
              </p>
            </div>

            {/* Saved vs Add New Tabs if saved GSTs exist */}
            {savedGstinsList.length > 0 && (
              <div className="flex bg-slate-100 p-1 rounded-2xl">
                <button
                  type="button"
                  onClick={() => {
                    setModalGstTab('saved');
                    setGstModalError(null);
                  }}
                  className={`flex-1 py-2 text-xs font-black rounded-xl transition cursor-pointer ${
                    modalGstTab === 'saved'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-500 hover:text-slate-900'
                  }`}
                >
                  Saved GSTINs ({savedGstinsList.length})
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setModalGstTab('new');
                    setGstModalError(null);
                  }}
                  className={`flex-1 py-2 text-xs font-black rounded-xl transition cursor-pointer ${
                    modalGstTab === 'new'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-500 hover:text-slate-900'
                  }`}
                >
                  + Add New GSTIN
                </button>
              </div>
            )}

            {/* Modal Body: Saved List */}
            {modalGstTab === 'saved' && savedGstinsList.length > 0 ? (
              <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                {savedGstinsList.map((g) => {
                  const isSelected = modalSelectedId === g.id;
                  return (
                    <div
                      key={g.id}
                      onClick={() => setModalSelectedId(g.id)}
                      className={`p-3.5 rounded-2xl border text-xs cursor-pointer transition flex items-start justify-between gap-3 ${
                        isSelected
                          ? 'bg-emerald-50/90 border-emerald-500 ring-2 ring-emerald-500/20'
                          : 'bg-white border-slate-200 hover:border-slate-300'
                      }`}
                    >
                      <div className="space-y-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono font-black text-slate-900 bg-white px-2 py-0.5 rounded-md border border-slate-200 text-xs">
                            {g.gstin}
                          </span>
                          {g.state && (
                            <span className="text-[10px] font-bold bg-slate-100 text-slate-700 px-1.5 py-0.5 rounded">
                              {g.stateCode ? `${g.stateCode} • ` : ''}{g.state}
                            </span>
                          )}
                          {g.isDefault && (
                            <span className="text-[9px] font-extrabold bg-emerald-100 text-emerald-900 px-1.5 py-0.5 rounded-full">
                              Default
                            </span>
                          )}
                        </div>
                        <div className="font-bold text-slate-900 text-xs truncate">{g.legalBusinessName}</div>
                        <div className="text-[11px] text-slate-500 truncate">{g.billingAddress}</div>
                      </div>

                      <div className="pt-1 shrink-0">
                        <div className={`w-5 h-5 rounded-full border flex items-center justify-center ${
                          isSelected
                            ? 'border-emerald-600 bg-emerald-600 text-white'
                            : 'border-slate-300 bg-white'
                        }`}>
                          {isSelected && <Check className="w-3 h-3" />}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              /* Modal Body: Full GST Form: GSTIN, Business Name, Address, State, Pincode */
              <div className="space-y-3">
                {/* 1. GST Number */}
                <div>
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">
                    GSTIN (15-digit Tax Identification Number) <span className="text-red-500">*</span>
                  </label>
                  <div className="relative">
                    <input
                      type="text"
                      maxLength={15}
                      value={modalGstinInput}
                      onChange={(e) => {
                        const val = e.target.value.toUpperCase();
                        setModalGstinInput(val);
                        setGstModalError(null);
                        if (val.length >= 2) {
                          const stateCode = val.slice(0, 2);
                          if (GST_STATE_MAP[stateCode]) {
                            setModalStateCodeInput(stateCode);
                          }
                        }
                      }}
                      placeholder="e.g. 29AABCP1429B1Z8"
                      className="w-full bg-white border border-slate-300 rounded-xl px-3.5 py-2.5 text-sm font-mono font-bold uppercase focus:border-slate-900 focus:outline-none placeholder:font-sans placeholder:normal-case placeholder:font-medium placeholder:text-slate-400"
                    />
                    {modalGstinInput.length >= 2 && GST_STATE_MAP[modalGstinInput.slice(0, 2)] && (
                      <div className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] font-extrabold bg-slate-100 text-slate-700 px-2 py-0.5 rounded border border-slate-200">
                        {GST_STATE_MAP[modalGstinInput.slice(0, 2)].code} - {GST_STATE_MAP[modalGstinInput.slice(0, 2)].name}
                      </div>
                    )}
                  </div>
                </div>

                {/* 2. Business / Company Name */}
                <div>
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">
                    Business / Company Legal Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={modalBusinessNameInput}
                    onChange={(e) => setModalBusinessNameInput(e.target.value)}
                    placeholder="e.g. Apex Infra & Renovations LLP"
                    className="w-full bg-white border border-slate-300 rounded-xl px-3.5 py-2.5 text-xs font-bold text-slate-900 focus:border-slate-900 focus:outline-none placeholder:font-medium placeholder:text-slate-400"
                  />
                </div>

                {/* 3. Registered Billing Address */}
                <div>
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">
                    Registered Billing Address <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={modalBillingAddressInput}
                    onChange={(e) => setModalBillingAddressInput(e.target.value)}
                    placeholder="e.g. Plot 402, Industrial Area, Phase 2"
                    className="w-full bg-white border border-slate-300 rounded-xl px-3.5 py-2.5 text-xs font-medium text-slate-900 focus:border-slate-900 focus:outline-none placeholder:text-slate-400"
                  />
                </div>

                {/* 4. State & Pincode in 2 columns */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <div>
                    <label className="block text-[11px] font-bold text-slate-700 mb-1">
                      Billing State / UT <span className="text-red-500">*</span>
                    </label>
                    <select
                      value={modalStateCodeInput}
                      onChange={(e) => {
                        const code = e.target.value;
                        setModalStateCodeInput(code);
                        // If user hasn't typed full GSTIN yet, update GSTIN prefix
                        if (!modalGstinInput || modalGstinInput.length <= 2) {
                          setModalGstinInput(code);
                        }
                      }}
                      className="w-full bg-white border border-slate-300 rounded-xl px-3 py-2.5 text-xs font-bold text-slate-900 focus:border-slate-900 focus:outline-none"
                    >
                      {INDIAN_GST_STATES.map((st) => (
                        <option key={st.code} value={st.code}>
                          {st.code} - {st.name} {st.isUnionTerritoryWithoutLegislature ? '(UT)' : ''}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-[11px] font-bold text-slate-700 mb-1">
                      PIN Code <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      maxLength={6}
                      value={modalPincodeInput}
                      onChange={(e) => setModalPincodeInput(e.target.value.replace(/\D/g, ''))}
                      placeholder="e.g. 560038"
                      className="w-full bg-white border border-slate-300 rounded-xl px-3.5 py-2.5 text-xs font-mono font-bold text-slate-900 focus:border-slate-900 focus:outline-none placeholder:font-sans placeholder:font-medium placeholder:text-slate-400"
                    />
                  </div>
                </div>

                {/* Quick Presets for easy testing across GST structures */}
                <div className="bg-slate-50 border border-slate-200/80 rounded-xl p-2.5 space-y-1.5">
                  <span className="text-[10px] font-extrabold text-slate-500 uppercase tracking-wider block">
                    Quick Sample State Presets:
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        setModalGstinInput('29AABCP1429B1Z8');
                        setModalBusinessNameInput('Apex Infra & Renovations LLP');
                        setModalBillingAddressInput('Site 402, 100ft Road, Indiranagar, Bengaluru');
                        setModalStateCodeInput('29');
                        setModalPincodeInput('560038');
                        setGstModalError(null);
                      }}
                      className="text-[11px] bg-white hover:bg-emerald-50 text-emerald-800 border border-emerald-300 font-bold px-2 py-1 rounded-lg cursor-pointer transition shadow-2xs"
                    >
                      Karnataka (Intra-state: CGST + SGST)
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setModalGstinInput('27AAACL1234M1Z5');
                        setModalBusinessNameInput('Larsen & Toubro Realty Ltd');
                        setModalBillingAddressInput('L&T House, Ballard Estate, Mumbai');
                        setModalStateCodeInput('27');
                        setModalPincodeInput('400001');
                        setGstModalError(null);
                      }}
                      className="text-[11px] bg-white hover:bg-sky-50 text-sky-800 border border-sky-300 font-bold px-2 py-1 rounded-lg cursor-pointer transition shadow-2xs"
                    >
                      Maharashtra (Inter-state: IGST)
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setModalGstinInput('04AAACF5678C1Z2');
                        setModalBusinessNameInput('Chandigarh City Infra Works');
                        setModalBillingAddressInput('Sector 17 Commercial Complex, Chandigarh');
                        setModalStateCodeInput('04');
                        setModalPincodeInput('160017');
                        setGstModalError(null);
                      }}
                      className="text-[11px] bg-white hover:bg-indigo-50 text-indigo-800 border border-indigo-300 font-bold px-2 py-1 rounded-lg cursor-pointer transition shadow-2xs"
                    >
                      Chandigarh (UT: CGST + UTGST)
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Error Message */}
            {gstModalError && (
              <p className="text-xs font-bold text-red-600 bg-red-50 border border-red-200 p-2.5 rounded-xl text-center">
                {gstModalError}
              </p>
            )}

            {/* Confirm Button matching reference screenshot */}
            <div className="pt-2">
              <button
                type="button"
                onClick={handleConfirmGstModal}
                className="w-full bg-slate-900 hover:bg-slate-800 text-white font-extrabold text-sm py-3.5 rounded-2xl transition cursor-pointer shadow-md active:scale-[0.99]"
              >
                Confirm
              </button>
            </div>

            {/* Footer Terms Note matching reference screenshot */}
            <div className="text-center text-[11px] text-slate-400">
              By continuing, you agree to our <span className="underline decoration-dotted text-slate-500 cursor-pointer">Terms & Conditions</span>
            </div>
          </div>
        </div>
      </div>
      )}

      {/* Handling & Platform Charges Breakdown Modal */}
      <HandlingPlatformChargesModal
        isOpen={showChargesModal}
        onClose={() => setShowChargesModal(false)}
        handlingCharge={12}
        platformFee={13}
      />

    </div>
  );
};
