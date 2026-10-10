import React, { useState, useEffect, useRef } from 'react';
import { 
  X, 
  Trash2, 
  Plus, 
  Minus, 
  Zap, 
  MapPin, 
  Clock, 
  ShieldCheck, 
  FileText, 
  ArrowRight,
  Sparkles,
  CreditCard,
  Building2,
  AlertCircle,
  Tag,
  QrCode
} from 'lucide-react';
import { CartItem, JobSiteLocation, HardwareProduct, CustomerProfile } from '../types';
import { CustomerPricingService } from '../utils/customerPricingService';
import { feedback } from '../utils/feedback';
import { HandlingPlatformChargesModal } from './HandlingPlatformChargesModal';

interface CartDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  items: CartItem[];
  jobSite: JobSiteLocation;
  customerProfile?: CustomerProfile;
  onOpenProfile?: () => void;
  onUpdateQty: (productId: string, delta: number) => void;
  onRemoveItem: (productId: string) => void;
  onClearCart: () => void;
  onCheckout: (orderConfig: {
    paymentMethod: 'Instant UPI' | 'Corporate Card' | 'Pay on Jobsite' | 'Trade Credit (Net 30)';
    clientInvoiceNeeded: boolean;
    clientName?: string;
  }) => void;
  allProducts: HardwareProduct[];
  onAddToCart: (product: HardwareProduct, qty?: number) => void;
}

export const CartDrawer: React.FC<CartDrawerProps> = ({
  isOpen,
  onClose,
  items,
  jobSite,
  customerProfile,
  onOpenProfile,
  onUpdateQty,
  onRemoveItem,
  onClearCart,
  onCheckout,
  allProducts,
  onAddToCart,
}) => {
  const [paymentMethod, setPaymentMethod] = useState<'Instant UPI' | 'Corporate Card' | 'Pay on Jobsite' | 'Trade Credit (Net 30)'>('Instant UPI');
  const [clientInvoiceNeeded, setClientInvoiceNeeded] = useState(true);
  const [clientName, setClientName] = useState(jobSite.jobTag || 'Client Renovation Project');
  const [showChargesModal, setShowChargesModal] = useState(false);

  if (!isOpen) return null;

  const adminConfig = CustomerPricingService.getAdminConfig();
  const subtotal = items.reduce((sum, item) => sum + item.product.price * item.quantity, 0);

  // Delivery Pricing Engine Centralized Service Integration
  const eligibleCartValue = subtotal;
  const deliveryPricingResult = CustomerPricingService.calculateCustomerDeliveryCharge(
    eligibleCartValue,
    1800
  );

  const isFreeDelivery = deliveryPricingResult.isFreeDelivery;
  const deliveryFee = subtotal === 0 ? 0 : deliveryPricingResult.deliveryCharge;
  const handlingCharge = CustomerPricingService.calculateHandlingCharge(subtotal);
  const total = subtotal + deliveryFee + handlingCharge;

  // Track and trigger 'Free delivery availed' milestone celebration feedback
  const prevFreeDeliveryRef = useRef<boolean>(isFreeDelivery);
  useEffect(() => {
    if (isOpen && isFreeDelivery && !prevFreeDeliveryRef.current && items.length > 0) {
      feedback.freeDeliveryAvailed();
    }
    prevFreeDeliveryRef.current = isFreeDelivery;
  }, [isFreeDelivery, isOpen, items.length]);

  // Calculate Input Tax Credit (ITC) claimable
  const itcClaimable = items.reduce((acc, item) => {
    if (item.product.isGstRegistered !== false) {
      const rate = item.product.gstRatePercent || 18;
      const itemTax = Math.round((item.product.price * item.quantity * rate) / (100 + rate));
      return acc + itemTax;
    }
    return acc;
  }, 0);

  const isB2B = customerProfile?.gstProfile?.isB2BEnabled && customerProfile?.gstProfile?.gstin;

  // Cross-sell items
  const cartProductIds = new Set(items.map(i => i.product.id));
  const suggestedCompanions = allProducts.filter(p => 
    !cartProductIds.has(p.id) && 
    (p.badge === 'Jobsite Essential' || p.id === 'plumb-03' || p.id === 'elec-05' || p.id === 'fast-01' || p.id === 'adhes-01')
  ).slice(0, 3);

  return (
    <div className="fixed inset-0 z-50 overflow-hidden bg-slate-900/60 backdrop-blur-xs animate-in fade-in duration-200">
      <div className="absolute inset-y-0 right-0 max-w-full flex pl-10">
        <div className="w-screen max-w-md bg-slate-50 text-slate-900 flex flex-col shadow-2xl animate-in slide-in-from-right duration-200">
          
          {/* Drawer Header */}
          <div className="p-4 bg-white border-b border-slate-200 flex items-center justify-between shadow-2xs">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-emerald-700 text-white flex items-center justify-center font-black">
                <Zap className="w-4 h-4" />
              </div>
              <div>
                <h2 className="text-sm sm:text-base font-black text-slate-900">
                  My Cart ({items.reduce((s, i) => s + i.quantity, 0)} items)
                </h2>
                <div className="text-[11px] text-emerald-700 font-bold flex items-center gap-1">
                  <span>⚡ Delivery in 12-15 mins</span>
                </div>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Drawer Scrollable Content */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3.5 text-xs">
            
            {/* Jobsite Delivery Location Card */}
            <div className="bg-white p-3 rounded-2xl border border-slate-200 shadow-2xs flex items-start gap-2.5">
              <div className="w-7 h-7 rounded-lg bg-emerald-50 text-emerald-700 flex items-center justify-center shrink-0 mt-0.5">
                <MapPin className="w-4 h-4" />
              </div>
              <div className="flex-1 truncate">
                <div className="flex items-center justify-between">
                  <span className="font-extrabold text-slate-900 text-xs truncate">{jobSite.jobTag}</span>
                  <span className="text-[10px] text-emerald-700 font-bold bg-emerald-50 px-1.5 py-0.2 rounded">Floor Drop</span>
                </div>
                <div className="text-[11px] text-slate-600 truncate mt-0.5">{jobSite.floorUnit} • {jobSite.address}</div>
                <div className="text-[10px] text-slate-400 mt-0.5">Contact: {jobSite.siteContactName} ({jobSite.sitePhone})</div>
              </div>
            </div>

            {/* Empty State */}
            {items.length === 0 ? (
              <div className="text-center py-16 bg-white rounded-2xl border border-slate-200 p-6 space-y-3">
                <div className="w-16 h-16 rounded-2xl bg-amber-100/70 mx-auto flex items-center justify-center text-amber-600">
                  <Zap className="w-8 h-8" />
                </div>
                <div>
                  <h3 className="text-sm font-black text-slate-900">Your cart is empty</h3>
                  <p className="text-xs text-slate-500 mt-1 max-w-xs mx-auto">
                    Add angle valves, Havells MCBs, drill bits, or Teflon tape to receive delivery on your job site in 12 mins.
                  </p>
                </div>
                <button
                  onClick={onClose}
                  className="bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-xs px-4 py-2 rounded-xl transition cursor-pointer"
                >
                  Start Shopping
                </button>
              </div>
            ) : (
              <>
                {/* Cart Items List */}
                <div className="bg-white rounded-2xl border border-slate-200 divide-y divide-slate-100 shadow-2xs overflow-hidden">
                  <div className="p-3 bg-slate-50/70 flex justify-between items-center text-[10px] font-extrabold uppercase text-slate-500">
                    <span>Selected Hardware ({items.length})</span>
                    <button 
                      onClick={onClearCart}
                      className="text-red-600 hover:underline cursor-pointer lowercase font-medium"
                    >
                      clear all
                    </button>
                  </div>

                  {items.map(({ product, quantity }) => (
                    <div key={product.id} className="p-3 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2.5 truncate">
                        {product.imageUrl ? (
                          <img 
                            src={product.imageUrl} 
                            alt={product.name}
                            referrerPolicy="no-referrer"
                            className="w-10 h-10 rounded-lg object-cover border border-slate-200 shrink-0" 
                          />
                        ) : (
                          <div className="w-10 h-10 rounded-lg bg-slate-100 border border-slate-200 flex items-center justify-center shrink-0 text-slate-500 font-black text-xs">
                            {product.name[0]}
                          </div>
                        )}
                        <div className="truncate space-y-0.5">
                          <h4 className="font-bold text-slate-900 text-xs truncate">{product.name}</h4>
                          <div className="text-[10px] text-slate-400 flex items-center gap-1.5">
                            <span>{product.specs.size || product.specs.brand}</span>
                            <span>•</span>
                            <span className="font-mono text-emerald-700">{product.binLocation.split('•')[0]}</span>
                          </div>
                          <div className="text-xs font-black text-slate-900 pt-0.5">
                            ₹{product.price * quantity}
                          </div>
                        </div>
                      </div>

                      {/* Quantity Buttons (Green Counter) */}
                      <div className="bg-emerald-700 text-white rounded-lg px-2 py-1 flex items-center gap-2 font-bold text-xs shrink-0 shadow-2xs">
                        <button
                          onClick={() => onUpdateQty(product.id, -1)}
                          className="w-4 h-4 flex items-center justify-center hover:bg-emerald-800 rounded transition cursor-pointer"
                        >
                          <Minus className="w-3 h-3" />
                        </button>
                        <span className="font-mono text-xs w-3 text-center">{quantity}</span>
                        <button
                          onClick={() => onUpdateQty(product.id, 1)}
                          className="w-4 h-4 flex items-center justify-center hover:bg-emerald-800 rounded transition cursor-pointer"
                        >
                          <Plus className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Cross-Sell Suggestions */}
                {suggestedCompanions.length > 0 && (
                  <div className="bg-white rounded-2xl border border-slate-200 p-3 shadow-2xs space-y-2.5">
                    <div className="flex items-center gap-1.5 text-xs font-black text-slate-900">
                      <Sparkles className="w-3.5 h-3.5 text-amber-500" />
                      <span>Frequently bought together:</span>
                    </div>
                    <div className="space-y-2">
                      {suggestedCompanions.map(p => (
                        <div key={p.id} className="flex items-center justify-between gap-2 p-2 rounded-xl bg-slate-50 border border-slate-100">
                          <div className="truncate">
                            <div className="font-bold text-slate-800 text-[11px] truncate">{p.name}</div>
                            <div className="text-[10px] text-emerald-700 font-extrabold">₹{p.price}</div>
                          </div>
                          <button
                            onClick={() => onAddToCart(p, 1)}
                            className="bg-white border border-emerald-600 hover:bg-emerald-50 text-emerald-700 font-black text-[10px] uppercase px-2.5 py-1 rounded-lg transition cursor-pointer shrink-0"
                          >
                            + ADD
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* B2B GSTIN & ITC Invoicing Card */}
                <div className="bg-white rounded-2xl border border-slate-200 p-3 shadow-2xs space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 font-black text-slate-900 text-xs">
                      <Building2 className="w-4 h-4 text-emerald-700" />
                      <span>B2B GSTIN & Input Tax Credit (ITC)</span>
                    </div>
                    {isB2B ? (
                      <span className="text-[10px] bg-emerald-100 text-emerald-800 font-extrabold px-2 py-0.5 rounded-full border border-emerald-300">
                        ITC Enabled
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={onOpenProfile}
                        className="text-[10px] text-emerald-700 font-extrabold hover:underline cursor-pointer"
                      >
                        + Add GSTIN
                      </button>
                    )}
                  </div>

                  {isB2B ? (
                    <div className="bg-emerald-50/70 border border-emerald-200 rounded-xl p-2.5 space-y-1 text-[11px] text-slate-800">
                      <div className="flex justify-between">
                        <span className="text-slate-500">Billing GSTIN:</span>
                        <span className="font-mono font-bold text-slate-900">{customerProfile?.gstProfile?.gstin}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-500">Business Name:</span>
                        <span className="font-bold text-slate-900 truncate max-w-[200px]">{customerProfile?.gstProfile?.legalBusinessName}</span>
                      </div>
                      <div className="flex justify-between pt-1 border-t border-emerald-200/60 font-black text-emerald-800">
                        <span>Input Tax Credit (ITC) Claimable:</span>
                        <span className="font-mono text-emerald-800">+₹{itcClaimable} in GSTR-3B</span>
                      </div>
                    </div>
                  ) : (
                    <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-xl flex items-center justify-between text-[11px]">
                      <div className="text-slate-600">
                        Save <strong className="text-emerald-700">₹{itcClaimable}</strong> in GST Input Tax Credit
                      </div>
                      <button
                        type="button"
                        onClick={onOpenProfile}
                        className="bg-white border border-slate-300 hover:bg-slate-100 text-slate-800 font-bold px-2 py-1 rounded-lg text-[10px] transition cursor-pointer"
                      >
                        Enter GSTIN
                      </button>
                    </div>
                  )}
                </div>

                {/* Client Invoice Tagging for Reimbursement */}
                <div className="bg-white rounded-2xl border border-slate-200 p-3 shadow-2xs space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="font-bold text-slate-800 flex items-center gap-1.5 cursor-pointer text-xs">
                      <FileText className="w-3.5 h-3.5 text-amber-500" />
                      <span>Generate GST Invoice for Client Bill</span>
                    </label>
                    <input
                      type="checkbox"
                      checked={clientInvoiceNeeded}
                      onChange={(e) => setClientInvoiceNeeded(e.target.checked)}
                      className="accent-emerald-700 w-4 h-4 cursor-pointer"
                    />
                  </div>
                  {clientInvoiceNeeded && (
                    <input
                      type="text"
                      value={clientName}
                      onChange={(e) => setClientName(e.target.value)}
                      placeholder="Client / Project Name (e.g. Prestige Flat 402)"
                      className="w-full bg-slate-50 border border-slate-200 rounded-xl p-2 text-xs text-slate-900 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    />
                  )}
                </div>

                {/* Payment Option Selector (India-First: UPI, GPay, PhonePe, Paytm) */}
                <div className="bg-white rounded-2xl border border-slate-200 p-3 shadow-2xs space-y-2">
                  <span className="text-[10px] uppercase font-black tracking-wider text-slate-400 block">
                    Select Payment Method:
                  </span>
                  <div className="grid grid-cols-2 gap-1.5">
                    {[
                      { id: 'Instant UPI', label: '⚡ UPI (GPay/PhonePe/Paytm)' },
                      { id: 'Corporate Card', label: '💳 Credit / Debit Card' },
                      { id: 'Pay on Jobsite', label: '💵 Cash on Delivery' },
                      { id: 'Trade Credit (Net 30)', label: '📄 Trade Khata (Net 30)' },
                    ].map(method => (
                      <button
                        key={method.id}
                        onClick={() => setPaymentMethod(method.id as any)}
                        className={`p-2 rounded-xl text-[11px] font-bold border text-left transition cursor-pointer ${
                          paymentMethod === method.id
                            ? 'bg-emerald-50 border-emerald-600 text-emerald-900'
                            : 'bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100'
                        }`}
                      >
                        {method.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Free Delivery Target Banner (Admin Configurable Threshold) */}
                <div className={`p-3 rounded-2xl border text-xs font-semibold ${
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

                {/* Bill Details */}
                <div className="bg-white rounded-2xl border border-slate-200 p-3.5 shadow-2xs space-y-2 text-xs">
                  <div className="text-[10px] uppercase font-black tracking-wider text-slate-400">
                    Bill Details
                  </div>
                  <div className="space-y-1.5 text-slate-600">
                    <div className="flex justify-between">
                      <span>Items Total:</span>
                      <span className="font-mono text-slate-900 font-bold">₹{subtotal}</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span>12-Min Dedicated Courier:</span>
                      <span className="font-mono font-bold text-emerald-700">
                        {isFreeDelivery ? 'FREE' : `₹${deliveryFee}`}
                      </span>
                    </div>
                    <div className="flex justify-between items-center py-0.5">
                      <button
                        type="button"
                        onClick={() => setShowChargesModal(true)}
                        className="flex items-center gap-1 text-left group cursor-pointer"
                        title="Click to view breakdown"
                      >
                        <span className="font-semibold text-slate-700 group-hover:text-emerald-700 border-b border-dashed border-slate-400 group-hover:border-emerald-600 transition">
                          Handling &amp; Platform Charges
                        </span>
                        <span className="text-[10px] text-slate-400 group-hover:text-emerald-600 font-bold">ⓘ</span>
                      </button>
                      <span className="font-mono text-slate-900 font-bold">₹{handlingCharge}</span>
                    </div>
                    <div className="pt-2 border-t border-slate-200 flex justify-between text-sm font-black text-slate-900">
                      <span>To Pay:</span>
                      <span className="text-emerald-700 font-mono">₹{total}</span>
                    </div>
                  </div>
                </div>

                {/* Savings Note */}
                <div className="bg-emerald-50 border border-emerald-200/80 p-2.5 rounded-xl text-[11px] text-emerald-900 font-bold flex items-center justify-between">
                  <span>🚀 Saved 45 mins road traffic</span>
                  <span className="text-emerald-700">+₹350 billable gain</span>
                </div>
              </>
            )}

          </div>

          {/* Sticky Bottom Green Pay CTA */}
          {items.length > 0 && (
            <div className="p-4 bg-white border-t border-slate-200 space-y-2 shadow-lg">
              <button
                id="quick-checkout-btn"
                onClick={() => {
                  feedback.placeOrder();
                  onCheckout({
                    paymentMethod,
                    clientInvoiceNeeded,
                    clientName
                  });
                }}
                className="w-full bg-emerald-700 hover:bg-emerald-800 text-white font-black py-3.5 rounded-xl text-sm flex items-center justify-between px-4 transition shadow-md shadow-emerald-700/20 cursor-pointer"
              >
                <div className="text-left">
                  <div className="text-base leading-none">₹{total}</div>
                  <div className="text-[10px] text-emerald-200 font-medium">TOTAL (INCL. GST)</div>
                </div>
                <div className="flex items-center gap-1.5 font-black text-sm">
                  <span>Place 12-Min Order</span>
                  <ArrowRight className="w-4 h-4" />
                </div>
              </button>
              
              <div className="flex items-center justify-center gap-1.5 text-[10px] text-slate-400 font-medium">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
                <span>100% Genuine Fittings • Micro-Warehouse Sealed Pack</span>
              </div>
            </div>
          )}

        </div>
      </div>

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
