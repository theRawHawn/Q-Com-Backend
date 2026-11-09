import React, { useState, useEffect, useMemo, useRef } from 'react';
import { 
  X, 
  ArrowLeft,
  CheckCircle2, 
  Clock, 
  MapPin, 
  Phone, 
  ShieldCheck, 
  Zap, 
  Navigation, 
  PackageCheck, 
  Building, 
  FileText,
  Play,
  RotateCcw,
  Sparkles,
  ShieldAlert,
  BatteryCharging,
  PhoneCall,
  Share2,
  Check,
  MoreVertical,
  Volume2,
  VolumeX,
  Pause,
  Maximize2,
  Minimize2,
  ExternalLink,
  ChevronRight,
  Gift,
  CreditCard,
  Tag,
  AlertCircle,
  HelpCircle,
  MessageSquarePlus,
  Compass,
  KeyRound,
  Video,
  Image as ImageIcon,
  Download
} from 'lucide-react';
import { Order, OrderStatus } from '../types';
import { OpenStreetMap } from './OpenStreetMap';
import { calculateDynamicDeliveryEta, DEFAULT_STORE_PARTNER } from '../utils/deliveryEta';
import { generateInvoicePDF, computeOrderInvoices } from '../utils/invoiceGenerator';
import { InvoiceModal } from './InvoiceModal';

interface OrderTrackingModalProps {
  isOpen: boolean;
  order: Order | null;
  onClose: () => void;
  onUpdateOrderStatus: (status: OrderStatus) => void;
}

interface SponsoredAdItem {
  id: string;
  badge: string;
  badgeColor: string;
  title: string;
  subtitle: string;
  ctaText: string;
  ctaColor: string;
  bgGradient: string;
  code?: string;
  terms: string;
  type: 'card' | 'membership' | 'brand' | 'cashback';
}

const SPONSORED_ADS: SponsoredAdItem[] = [
  {
    id: 'hdfc-credit-card',
    badge: '₹500 ZERO JOINING FEES',
    badgeColor: 'bg-rose-50 text-rose-800 border-rose-200',
    title: 'Trade Pro HDFC Bank Credit Card',
    subtitle: 'Get 5% instant cashback on all hardware & materials + ₹500 welcome bonus',
    ctaText: 'APPLY NOW',
    ctaColor: 'bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 text-white',
    bgGradient: 'from-amber-50 via-rose-50 to-orange-50',
    code: 'HDFCTRADE',
    terms: 'Valid for verified contractors and registered businesses. T&C apply.',
    type: 'card',
  },
  {
    id: 'free-pro-pass',
    badge: 'ONE-TIME OFFER',
    badgeColor: 'bg-purple-100 text-purple-800 border-purple-200',
    title: 'FREE Pro Contractor Pass For 12 Months!',
    subtitle: 'Enjoy ₹0 delivery fee on unlimited address deliveries above ₹299 + VIP priority riders',
    ctaText: 'CLAIM OFFER',
    ctaColor: 'bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white',
    bgGradient: 'from-purple-50 via-indigo-50 to-pink-50',
    code: 'PROPASS12M',
    terms: 'Zero renewal cost for first 12 months. Cancel anytime.',
    type: 'membership',
  },
  {
    id: 'bosch-tools-deal',
    badge: 'FLASH BRAND DEAL',
    badgeColor: 'bg-sky-100 text-sky-800 border-sky-200',
    title: 'BOSCH Heavy-Duty Cordless Drills',
    subtitle: 'Flat 40% Off on Brushless 18V Hammer Drill & Grinder Combo Kits',
    ctaText: 'SHOP NOW',
    ctaColor: 'bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-700 hover:to-cyan-700 text-white',
    bgGradient: 'from-sky-50 via-blue-50 to-indigo-50',
    code: 'BOSCH40PRO',
    terms: 'Includes 1-Year Official Bosch India Onsite Warranty. Free Drill Bit Set.',
    type: 'brand',
  },
  {
    id: 'pidilite-fevicol',
    badge: 'SITE ESSENTIALS',
    badgeColor: 'bg-emerald-100 text-emerald-800 border-emerald-200',
    title: 'Pidilite Fevicol Pro High-Tack',
    subtitle: 'Buy 2 Get 1 Free on 500ml rapid sealants & heavy wood adhesive tubs',
    ctaText: 'REDEEM NOW',
    ctaColor: 'bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white',
    bgGradient: 'from-emerald-50 via-teal-50 to-cyan-50',
    code: 'FEVICOLB2G1',
    terms: 'Applicable automatically at checkout on all Pidilite construction adhesives.',
    type: 'brand',
  }
];

export const OrderTrackingModal: React.FC<OrderTrackingModalProps> = ({
  isOpen,
  order,
  onClose,
  onUpdateOrderStatus,
}) => {
  // Compute initial dynamic ETA in seconds based on distance
  const dynamicEta = useMemo(() => {
    if (!order) return { etaMins: 11, distanceKm: 1.2 };
    return calculateDynamicDeliveryEta(order.jobSite.coordinates);
  }, [order?.jobSite.coordinates]);

  const initialTotalSeconds = dynamicEta.etaMins * 60;
  const [etaSeconds, setEtaSeconds] = useState(initialTotalSeconds);
  const [simSpeed, setSimSpeed] = useState(1);
  const [showInvoice, setShowInvoice] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [copiedOtp, setCopiedOtp] = useState(false);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [courierSpeed, setCourierSpeed] = useState(28);

  // Instamart Hero View Mode: 'map' = full interactive map; 'ad' = ad takeover with floating mini MAP button
  const [heroMode, setHeroMode] = useState<'map' | 'ad'>('map');

  // Automatically minimize live map to Ad view after 5.5 seconds of opening
  useEffect(() => {
    if (!isOpen || !order) return;

    setHeroMode('map');

    const timer = setTimeout(() => {
      setHeroMode('ad');
    }, 5500);

    return () => clearTimeout(timer);
  }, [isOpen, order?.id]);

  // Delivery instructions state
  const [deliveryInstructions, setDeliveryInstructions] = useState<string>(
    'First house on the left at the entry gate. Call if security is closed.'
  );
  const [isEditingInstructions, setIsEditingInstructions] = useState(false);
  const [instructionInput, setInstructionInput] = useState(deliveryInstructions);

  // Selected Ad Modal for "While you wait" cards
  const [activeSponsoredAd, setActiveSponsoredAd] = useState<SponsoredAdItem | null>(null);

  // Call Partner Dialog
  const [showCallDialog, setShowCallDialog] = useState(false);

  // Invoice Preview & PDF Download State
  const [showFullInvoiceModal, setShowFullInvoiceModal] = useState(false);
  const [invoiceModalPageIndex, setInvoiceModalPageIndex] = useState<number>(0);
  const [isDownloadingPdf, setIsDownloadingPdf] = useState(false);
  const [pdfDownloaded, setPdfDownloaded] = useState(false);

  const handleDownloadPdf = async () => {
    if (!order) return;
    setIsDownloadingPdf(true);
    try {
      await generateInvoicePDF(order, { autoDownload: true });
      setPdfDownloaded(true);
      setTimeout(() => setPdfDownloaded(false), 3000);
    } catch (err) {
      console.error('Error generating PDF:', err);
    } finally {
      setIsDownloadingPdf(false);
    }
  };

  // Fullscreen map mode toggle
  const [isFullscreenMap, setIsFullscreenMap] = useState(false);

  // Ref for scroll container to smoothly scroll back to top map
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [showFloatingMapBtn, setShowFloatingMapBtn] = useState(false);

  const scrollToMap = () => {
    setHeroMode('map');
    scrollContainerRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleScroll = () => {
    if (scrollContainerRef.current) {
      setShowFloatingMapBtn(scrollContainerRef.current.scrollTop > 180);
    }
  };

  // Sync initial seconds when new order opens
  useEffect(() => {
    if (order && order.status === 'placed') {
      setEtaSeconds(initialTotalSeconds);
    }
  }, [order?.id, initialTotalSeconds]);

  // Real-time live countdown
  useEffect(() => {
    if (!isOpen || !order || order.status === 'delivered') return;

    const interval = setInterval(() => {
      setEtaSeconds((prev) => Math.max(0, prev - (1 * simSpeed)));
    }, 1000);

    return () => clearInterval(interval);
  }, [isOpen, order?.status, simSpeed]);

  // Sync order status progression & speed telemetry based on timer progress
  useEffect(() => {
    if (!isOpen || !order || order.status === 'delivered') return;

    const progressRatio = (initialTotalSeconds - etaSeconds) / Math.max(1, initialTotalSeconds);

    let nextStatus: OrderStatus = order.status;
    if (progressRatio < 0.15) {
      nextStatus = 'placed';
    } else if (progressRatio >= 0.15 && progressRatio < 0.35) {
      nextStatus = 'picking';
    } else if (progressRatio >= 0.35 && progressRatio < 0.50) {
      nextStatus = 'packed';
    } else if (progressRatio >= 0.50 && progressRatio < 0.90) {
      nextStatus = 'out_for_delivery';
    } else if (progressRatio >= 0.90 && etaSeconds > 0) {
      nextStatus = 'arriving';
    } else if (etaSeconds === 0) {
      nextStatus = 'delivered';
    }

    if (nextStatus !== order.status) {
      onUpdateOrderStatus(nextStatus);
    }

    // Realistic speed fluctuation while on route
    if (order.status === 'out_for_delivery') {
      setCourierSpeed(Math.floor(26 + Math.sin(etaSeconds / 5) * 6));
    } else if (order.status === 'arriving') {
      setCourierSpeed(12);
    } else {
      setCourierSpeed(0);
    }
  }, [isOpen, etaSeconds, initialTotalSeconds, order?.status, onUpdateOrderStatus]);

  if (!isOpen || !order) return null;

  const formatMins = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  const fastForward = () => {
    setEtaSeconds(prev => Math.max(0, prev - 120)); // skip 2 mins
  };

  const handleCopyOtp = () => {
    navigator.clipboard?.writeText(order.deliveryOtp);
    setCopiedOtp(true);
    setTimeout(() => setCopiedOtp(false), 2500);
  };

  const handleCopyAdCode = (code: string) => {
    navigator.clipboard?.writeText(code);
    setCopiedCode(code);
    setTimeout(() => setCopiedCode(null), 2500);
  };

  const handleSaveInstructions = () => {
    setDeliveryInstructions(instructionInput);
    setIsEditingInstructions(false);
  };

  const orderTime = new Date(order.placedAt || Date.now());
  const formatTimeOffset = (offsetMins: number) => {
    const d = new Date(orderTime.getTime() + offsetMins * 60 * 1000);
    return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  };

  // Live progress percentage calculation
  const progressRatio = Math.min(1, Math.max(0, (initialTotalSeconds - etaSeconds) / initialTotalSeconds));
  const remainingMeters = Math.max(0, Math.round(dynamicEta.distanceKm * 1000 * (1 - progressRatio)));

  // Dark store / seller partner coordinates
  const hubCoords: [number, number] = [
    order.sellerPartner?.coordinates?.lat || DEFAULT_STORE_PARTNER.coordinates.lat,
    order.sellerPartner?.coordinates?.lng || DEFAULT_STORE_PARTNER.coordinates.lng
  ];

  // Destination coordinates (ensures distinct realistic jobsite target ~760m away from pickup store)
  const rawDestLat = order.jobSite.coordinates?.lat;
  const rawDestLng = order.jobSite.coordinates?.lng;
  const isIdenticalToHub = !rawDestLat || !rawDestLng || (Math.abs(rawDestLat - hubCoords[0]) < 0.0002 && Math.abs(rawDestLng - hubCoords[1]) < 0.0002);

  const destCoords: [number, number] = isIdenticalToHub
    ? [hubCoords[0] + 0.0055, hubCoords[1] + 0.0042]
    : [rawDestLat!, rawDestLng!];

  // Dynamic destination tag from selected address (e.g. "Home", "Work", "Site Office", or first part of address)
  const dynamicDestinationLabel = order.jobSite.jobTag || order.jobSite.landmark || (order.jobSite.address ? order.jobSite.address.split(',')[0].trim() : 'Destination');

  // Dedicated Rider Starting Coordinates (~720m approach route to store)
  const riderStartCoords: [number, number] = [
    hubCoords[0] - 0.0048,
    hubCoords[1] - 0.0036
  ];

  // Dynamic rider position calculation for 2-phase Swiggy tracking
  let riderLat = hubCoords[0];
  let riderLng = hubCoords[1];
  let statusBadgeText = '⚡ ON TIME';
  let statusHeading = 'Out for delivery';
  let statusSubtitle = `${order.rider.name} is on the way to deliver your order`;

  if (order.status === 'placed' || order.status === 'picking') {
    // Phase 1: Rider driving to Store (pickup approach)
    const leg1Progress = Math.min(1, Math.max(0, progressRatio / 0.35));
    riderLat = riderStartCoords[0] + (hubCoords[0] - riderStartCoords[0]) * leg1Progress;
    riderLng = riderStartCoords[1] + (hubCoords[1] - riderStartCoords[1]) * leg1Progress;
    const distToStoreMeters = Math.max(30, Math.round(720 * (1 - leg1Progress)));
    
    statusBadgeText = '⚡ RIDER REACHING STORE';
    statusHeading = 'Store is preparing your order';
    statusSubtitle = `${order.rider.name} is driving to ${order.sellerPartner?.name || 'Sri Lakshmi Hardware'}`;
  } else if (order.status === 'packed') {
    // Rider arrived at store, picking up order
    riderLat = hubCoords[0];
    riderLng = hubCoords[1];
    
    statusBadgeText = '⚡ RIDER AT STORE';
    statusHeading = 'Order packed & sealed';
    statusSubtitle = `${order.rider.name} is picking up package from ${order.sellerPartner?.name || 'Sri Lakshmi Hardware'}`;
  } else if (order.status === 'out_for_delivery') {
    // Phase 2: Rider driving to Jobsite
    const leg2Progress = Math.min(1, Math.max(0, (progressRatio - 0.50) / 0.40));
    riderLat = hubCoords[0] + (destCoords[0] - hubCoords[0]) * leg2Progress;
    riderLng = hubCoords[1] + (destCoords[1] - hubCoords[1]) * leg2Progress;
    const distToCustomerMeters = Math.max(35, Math.round(dynamicEta.distanceKm * 1000 * (1 - leg2Progress)));
    
    statusBadgeText = '⚡ OUT FOR DELIVERY';
    statusHeading = 'Out for delivery';
    statusSubtitle = `${order.rider.name} is on the way to your delivery address (${distToCustomerMeters}m remaining)`;
  } else if (order.status === 'arriving') {
    riderLat = destCoords[0];
    riderLng = destCoords[1];
    
    statusBadgeText = '⚡ AT DELIVERY LOCATION';
    statusHeading = 'Arrived at your location';
    statusSubtitle = `${order.rider.name} is waiting at the entry gate / drop point`;
  } else if (order.status === 'delivered') {
    riderLat = destCoords[0];
    riderLng = destCoords[1];
    
    statusBadgeText = '✓ ORDER COMPLETED';
    statusHeading = 'Order Delivered';
    statusSubtitle = `Successfully verified and handed over with OTP ${order.deliveryOtp}`;
  }

  const riderCoords: [number, number] = [riderLat, riderLng];

  return (
    <div 
      ref={scrollContainerRef}
      onScroll={handleScroll}
      className="fixed inset-0 z-50 bg-[#f8fafc] w-full h-full overflow-y-auto flex justify-center animate-in slide-in-from-right duration-250 select-none"
    >
      
      {/* Full Page Mobile/Desktop Screen Container */}
      <div className="bg-[#f8fafc] w-full max-w-md min-h-screen flex flex-col relative pb-12">
        
        {/* ========================================================================= */}
        {/* HERO SECTION: Full Immersive Map or Ad Takeover (Video / Image)           */}
        {/* ========================================================================= */}
        <div className="relative w-full h-[470px] sm:h-[500px] bg-[#e5e9ec] overflow-hidden select-none shrink-0">
          
          {/* ========================================================================= */}
          {/* Floating Top Header Bar directly overlaying Hero Screen                   */}
          {/* ========================================================================= */}
          <header className="absolute top-0 inset-x-0 z-30 px-3.5 pt-3 pb-2 flex items-center justify-between pointer-events-none">
            <button
              id="close-tracking-screen"
              type="button"
              onClick={onClose}
              aria-label="Back to Store"
              className="w-10 h-10 rounded-full bg-white/95 hover:bg-white active:scale-95 flex items-center justify-center text-slate-800 shadow-md transition cursor-pointer pointer-events-auto border border-slate-200/60"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>

            {/* Seller Name visible on MAP VIEW ONLY, center aligned with reduced size and opacity */}
            {heroMode === 'map' && (
              <div className="text-center pointer-events-auto px-2 mx-auto flex-1">
                <div className="text-xs font-bold text-slate-700/80 tracking-tight leading-none drop-shadow-xs truncate max-w-[220px] mx-auto">
                  {order.sellerPartner?.name || 'Sri Lakshmi Hardware'}
                </div>
                <div className="text-[9px] font-medium text-slate-600/70 mt-0.5">
                  {formatTimeOffset(0)} • {order.items.length} {order.items.length === 1 ? 'item' : 'items'}
                </div>
              </div>
            )}

            <div className="flex items-center gap-1.5 pointer-events-auto ml-auto">
              <div className="relative">
                <button
                  id="tracking-menu-trigger"
                  type="button"
                  onClick={() => setShowMenu(!showMenu)}
                  aria-label="Order Options"
                  className="w-10 h-10 rounded-full bg-white/95 hover:bg-white active:scale-95 flex items-center justify-center text-slate-800 shadow-md transition cursor-pointer border border-slate-200/60"
                >
                  <MoreVertical className="w-5 h-5" />
                </button>

                {showMenu && (
                  <div className="absolute right-0 mt-2 w-56 bg-white rounded-2xl shadow-2xl border border-slate-100 py-2 z-50 text-xs font-semibold text-slate-700 animate-in fade-in zoom-in-95">
                    <div className="px-3.5 py-1 text-[10px] font-black uppercase tracking-wider text-slate-400">
                      Hero View Settings
                    </div>
                    <button
                      onClick={() => { setHeroMode(heroMode === 'map' ? 'ad' : 'map'); setShowMenu(false); }}
                      className="w-full px-3.5 py-2 text-left hover:bg-slate-50 flex items-center gap-2 text-amber-600 font-bold"
                    >
                      <Sparkles className="w-4 h-4" />
                      <span>{heroMode === 'map' ? 'Switch to Brand Ad View' : 'Switch to Live Map View'}</span>
                    </button>
                    <div className="h-px bg-slate-100 my-1" />
                    <button
                      onClick={() => { setShowInvoice(true); setShowMenu(false); }}
                      className="w-full px-3.5 py-2 text-left hover:bg-slate-50 flex items-center gap-2"
                    >
                      <FileText className="w-4 h-4 text-emerald-600" />
                      <span>Download Tax Invoice</span>
                    </button>
                    <button
                      onClick={() => { setShowCallDialog(true); setShowMenu(false); }}
                      className="w-full px-3.5 py-2 text-left hover:bg-slate-50 flex items-center gap-2"
                    >
                      <PhoneCall className="w-4 h-4 text-sky-600" />
                      <span>Call Store Partner</span>
                    </button>
                  </div>
                )}
              </div>
            </div>
          </header>

          {heroMode === 'map' ? (
            /* Mode 1: Full OpenStreetMap View with Switchable AD Round Island in bottom right */
            <div className="w-full h-full relative">
              <OpenStreetMap
                center={riderCoords}
                zoom={14}
                isRouteMode={true}
                hubLocation={hubCoords}
                destinationLocation={destCoords}
                destinationLabel={dynamicDestinationLabel}
                riderStartLocation={riderStartCoords}
                riderLocation={riderCoords}
                riderName={order.rider.name}
                riderSpeed={courierSpeed}
                orderStatus={order.status}
                onExpandFullscreen={() => setIsFullscreenMap(true)}
                className="h-full w-full"
              />

              {/* Floating Circular AD Banner Round Island Button */}
              <button
                id="switch-to-ad-circular-btn"
                type="button"
                onClick={() => setHeroMode('ad')}
                title="Tap to view Brand Offer Banner"
                className="absolute right-4 bottom-4 z-30 flex flex-col items-center group cursor-pointer active:scale-90 transition-transform pointer-events-auto"
              >
                <div className="w-16 h-16 rounded-full border-2 border-white shadow-2xl overflow-hidden relative bg-gradient-to-tr from-amber-500 via-amber-400 to-amber-300 flex items-center justify-center group-hover:border-amber-400 transition">
                  <Sparkles className="w-7 h-7 text-slate-950 fill-slate-950 animate-pulse" />
                </div>
                <span className="mt-1 bg-amber-400 text-slate-950 font-black text-[10px] px-2.5 py-0.5 rounded-full shadow-md uppercase tracking-wider group-hover:bg-amber-300">
                  AD
                </span>
              </button>
            </div>
          ) : (
            /* Mode 2: Brand Ad Takeover View matching Screenshot 2 (Foxtale Sunscreen on Yellow Canvas) */
            <div className="w-full h-full relative bg-[#FFCD00] flex flex-col items-center justify-between p-4 pt-16 text-slate-900 overflow-hidden select-none animate-in fade-in duration-200">
              
              {/* Product Bottle Container in Center (Realistic Foxtale Sunscreen Tube) */}
              <div className="relative z-10 my-auto flex flex-col items-center justify-center transform hover:scale-105 transition-transform duration-300">
                
                {/* Foxtale Sunscreen Tube Graphic */}
                <div className="w-36 sm:w-40 h-64 sm:h-72 bg-gradient-to-b from-[#FA7C17] via-[#FF8811] to-[#F97316] rounded-t-3xl rounded-b-xl shadow-2xl border-t-8 border-[#E06600] flex flex-col items-center justify-between p-4 text-center text-white relative overflow-hidden">
                  
                  {/* Crimp Top Line */}
                  <div className="w-full h-3 border-b border-white/30 flex items-center justify-center gap-1 -mt-2">
                    <div className="w-full h-0.5 bg-white/20" />
                  </div>

                  {/* Vertical Brand Logo */}
                  <div className="my-auto space-y-2">
                    <div className="font-serif text-2xl font-bold tracking-wider text-white rotate-0 font-medium">
                      foxtale
                    </div>

                    <div className="space-y-0.5 pt-2">
                      <div className="text-[10px] font-black tracking-widest uppercase text-amber-100">
                        GOLDEN HOUR
                      </div>
                      <div className="text-xs font-black tracking-tight text-white uppercase">
                        Glow Sunscreen
                      </div>
                      <div className="text-[9px] font-bold text-amber-100/90 pt-1">
                        SPF 50 PA++++
                      </div>
                      <div className="text-[8px] font-medium text-white/80">
                        Prevents tan & boosts glow
                      </div>
                    </div>

                    <div className="pt-2 text-[8px] font-semibold text-amber-50 space-y-0.5">
                      <div>Vitamin C + Niacinamide</div>
                      <div className="text-[7px] uppercase tracking-wider text-white/70">ALL SKIN TYPES • 50ml</div>
                    </div>
                  </div>

                  {/* Tube Cap Base */}
                  <div className="w-20 h-4 bg-[#E06600] rounded-b-md shadow-inner" />
                </div>

                {/* Soft Contact Drop Shadow on Yellow Surface */}
                <div className="w-32 h-4 bg-amber-600/30 rounded-full blur-xs mt-2" />
              </div>

              {/* Bottom Left Floating Offer Glassmorphic Card (Matches Screenshot 2) */}
              <div className="absolute left-4 bottom-12 z-20 max-w-[210px] space-y-1.5 pointer-events-auto">
                {/* Red Pill Tag */}
                <div className="inline-flex items-center gap-1 bg-[#E11D48] text-white font-black text-xs px-3 py-1 rounded-full shadow-md animate-pulse">
                  <Tag className="w-3.5 h-3.5" />
                  <span>BUY 2 GET 3 FREE</span>
                </div>

                {/* Translucent Glass CTA Button */}
                <button
                  type="button"
                  onClick={() => {
                    const storeUrl = order.sellerPartner?.website || 'https://foxtale.in';
                    window.open(storeUrl, '_blank');
                  }}
                  className="w-full bg-white/40 hover:bg-white/60 backdrop-blur-md text-slate-950 font-black text-xs px-4 py-2 rounded-2xl shadow-md border border-white/60 flex items-center justify-between transition active:scale-95 cursor-pointer"
                >
                  <span>SHOP NOW</span>
                  <ChevronRight className="w-4 h-4 text-slate-950" />
                </button>
              </div>

              {/* Floating Circular MAP View Round Island (Bottom Right - Matches Screenshot 2) */}
              <button
                id="expand-map-circular-btn"
                type="button"
                onClick={() => setHeroMode('map')}
                title="Tap to restore live interactive tracking map"
                className="absolute right-4 bottom-12 z-30 flex flex-col items-center group cursor-pointer active:scale-90 transition-transform pointer-events-auto"
              >
                {/* Circular Map Thumbnail */}
                <div className="w-16 h-16 rounded-full border-2 border-white shadow-2xl overflow-hidden relative bg-slate-100 group-hover:border-emerald-500 transition">
                  <div className="absolute inset-0 bg-[#e2e8f0] flex items-center justify-center">
                    <div className="w-full h-0.5 bg-orange-500 rotate-45 transform stroke-2" />
                    <div className="w-full h-0.5 bg-slate-400 -rotate-30 transform" />
                    <div className="absolute w-7 h-7 rounded-full bg-slate-900 border-2 border-white text-white flex items-center justify-center shadow-md">
                      <Navigation className="w-3.5 h-3.5 text-emerald-400 animate-pulse" />
                    </div>
                  </div>
                </div>
                <span className="mt-1 bg-white text-slate-950 font-black text-[10px] px-2.5 py-0.5 rounded-full shadow-md uppercase tracking-wider group-hover:bg-emerald-600 group-hover:text-white transition">
                  MAP
                </span>
              </button>
            </div>
          )}
        </div>

        {/* ========================================================================= */}
        {/* INSTAMART FLOATING BOTTOM SHEET: Out for delivery + ETA + Instructions     */}
        {/* ========================================================================= */}
        <div className="px-3 -mt-8 relative z-30 space-y-3">
          
          {/* Main Status & ETA Card */}
          <div className="bg-white rounded-3xl p-4 sm:p-5 border border-slate-100 shadow-xl space-y-3">
            
            {/* Top row: Status Heading + Green ETA Badge */}
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <span className="text-[10px] font-black tracking-wider uppercase text-emerald-600 block mb-0.5">
                  {statusBadgeText}
                </span>
                <h1 className="text-xl font-black text-slate-900 tracking-tight leading-tight">
                  {statusHeading}
                </h1>
                <p className="text-xs text-slate-600 font-medium mt-0.5">
                  {statusSubtitle}
                </p>
              </div>

              {/* Big Rounded Green ETA Badge (e.g. "23 mins" / "2 mins") - Hides when delivered */}
              {order.status !== 'delivered' && (
                <div className="bg-emerald-600 text-white rounded-2xl px-3.5 py-2 text-center shrink-0 shadow-md min-w-[72px]">
                  <div className="text-2xl font-black font-mono leading-none tracking-tight">
                    {Math.max(1, Math.ceil(etaSeconds / 60))}
                  </div>
                  <div className="text-[10px] font-bold tracking-tight uppercase mt-0.5">
                    mins
                  </div>
                </div>
              )}
            </div>

            <div className="h-px bg-slate-100" />

            {/* Bottom row: Add Delivery Instructions + Rider Call Avatar */}
            <div className="flex items-center justify-between gap-3 pt-0.5">
              
              {/* Delivery Instructions Clickable Row */}
              <div 
                onClick={() => setIsEditingInstructions(true)}
                className="flex items-center gap-2 min-w-0 flex-1 cursor-pointer group"
              >
                <div className="w-7 h-7 rounded-full bg-slate-100 group-hover:bg-slate-200 text-slate-700 flex items-center justify-center shrink-0 transition">
                  <MessageSquarePlus className="w-4 h-4" />
                </div>
                <div className="min-w-0">
                  <div className="text-xs font-bold text-slate-900 group-hover:text-emerald-700 transition truncate flex items-center gap-1">
                    <span>Add Delivery Instructions</span>
                    <span className="text-[10px] text-slate-400 font-normal">• Edit</span>
                  </div>
                  <div className="text-[11px] text-slate-500 truncate">
                    {deliveryInstructions}
                  </div>
                </div>
              </div>

              {/* Rider Avatar + Direct Call Button */}
              <div className="flex items-center gap-2 shrink-0">
                <div className="w-9 h-9 rounded-full bg-orange-100 border border-orange-200 overflow-hidden flex items-center justify-center text-xs font-black text-orange-700">
                  {order.rider.photo ? (
                    <img src={order.rider.photo} alt={order.rider.name} className="w-full h-full object-cover" />
                  ) : (
                    <span>{order.rider.name.charAt(0)}</span>
                  )}
                </div>

                <button
                  id="call-rider-btn"
                  type="button"
                  onClick={() => setShowCallDialog(true)}
                  aria-label="Call Rider"
                  className="w-9 h-9 rounded-full bg-orange-50 hover:bg-orange-100 active:scale-95 text-orange-600 border border-orange-200 flex items-center justify-center shadow-xs transition cursor-pointer"
                >
                  <Phone className="w-4 h-4 fill-orange-500 text-orange-500" />
                </button>
              </div>

            </div>

            {/* Small subtle OTP indicator without copy button or big box */}
            <div className="pt-2 border-t border-slate-100 flex items-center justify-between text-xs">
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">Delivery OTP:</span>
                <span className="font-mono text-sm font-black text-emerald-950 bg-emerald-100/90 border border-emerald-300 px-2 py-0.5 rounded-md tracking-wider">
                  {order.deliveryOtp || '4614'}
                </span>
              </div>
              <span className="text-[10px] text-slate-400 font-medium">Share with Rider</span>
            </div>

          </div>

          {/* ========================================================================= */}
          {/* "WHILE YOU WAIT" SPONSORED ADS CAROUSEL                                   */}
          {/* ========================================================================= */}
          <div className="pt-2 space-y-2.5">
            
            {/* Centered stylized heading with decorative underline */}
            <div className="text-center">
              <span className="text-xs font-black tracking-[0.25em] text-slate-900 uppercase">
                WHILE YOU WAIT
              </span>
              <div className="w-24 h-1 bg-rose-500 rounded-full mx-auto mt-0.5" />
            </div>

            {/* Single Sponsored Offer Card */}
            <div className="space-y-3">
              {SPONSORED_ADS.slice(0, 1).map((ad) => (
                <div
                  key={ad.id}
                  onClick={() => setActiveSponsoredAd(ad)}
                  className={`bg-gradient-to-br ${ad.bgGradient} rounded-2xl p-4 border border-slate-200/80 shadow-sm hover:shadow-md transition cursor-pointer relative overflow-hidden group`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1 space-y-1">
                      <span className={`inline-block text-[9px] font-black px-2 py-0.5 rounded-md border ${ad.badgeColor}`}>
                        {ad.badge}
                      </span>
                      <h4 className="text-sm font-black text-slate-900 leading-snug">
                        {ad.title}
                      </h4>
                      <p className="text-[11px] text-slate-600 font-medium line-clamp-2">
                        {ad.subtitle}
                      </p>
                    </div>

                    {/* Graphic Thumbnail */}
                    <div className="w-14 h-14 rounded-xl bg-white/80 border border-white shadow-xs flex items-center justify-center shrink-0">
                      {ad.type === 'card' ? (
                        <CreditCard className="w-7 h-7 text-amber-600" />
                      ) : ad.type === 'membership' ? (
                        <Gift className="w-7 h-7 text-purple-600" />
                      ) : (
                        <Sparkles className="w-7 h-7 text-blue-600" />
                      )}
                    </div>
                  </div>

                  <div className="mt-3 flex items-center justify-between gap-2 pt-2 border-t border-slate-200/50">
                    <span className="text-[10px] text-slate-500 font-semibold truncate">
                      {ad.code ? `Use Code: ${ad.code}` : 'Instant Approval'}
                    </span>
                    <button
                      type="button"
                      className={`text-[10px] font-black px-3.5 py-1.5 rounded-lg shadow-sm ${ad.ctaColor} transition active:scale-95`}
                    >
                      {ad.ctaText}
                    </button>
                  </div>
                </div>
              ))}
            </div>

          </div>

          {/* ========================================================================= */}
          {/* MINIMALIST ORDER ITEMS DETAILS SECTION                                   */}
          {/* ========================================================================= */}
          <div className="bg-white rounded-2xl p-4 border border-slate-100 shadow-sm space-y-3">
            <div className="flex items-center justify-between pb-2 border-b border-slate-100">
              <span className="text-[11px] font-black tracking-widest uppercase text-slate-400">
                Order Items ({order.items.reduce((acc, i) => acc + i.quantity, 0)} {order.items.reduce((acc, i) => acc + i.quantity, 0) === 1 ? 'item' : 'items'})
              </span>
              <span className="text-[10px] text-slate-400 font-mono font-medium">#{order.id}</span>
            </div>

            <div className="space-y-2 pt-0.5">
              {order.items.map(({ product, quantity }) => (
                <div key={product.id} className="flex items-center gap-2.5 text-xs">
                  <span className="w-6 h-6 rounded-md bg-slate-100 text-slate-800 font-mono font-bold flex items-center justify-center text-[11px] shrink-0 border border-slate-200/60">
                    {quantity}x
                  </span>
                  <span className="font-semibold text-slate-800 truncate">
                    {product.name}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* ========================================================================= */}
          {/* SIMULATION CONTROLS & ORDER DETAILS SECTION                               */}
          {/* ========================================================================= */}
          <div className="bg-white rounded-2xl p-4 border border-slate-100 shadow-sm space-y-3 text-xs">
            <div className="flex items-center justify-between font-bold text-slate-900">
              <span className="flex items-center gap-1.5">
                <Compass className="w-4 h-4 text-emerald-600" />
                <span>Simulation Controls</span>
              </span>
              <span className="text-[10px] text-slate-400 font-normal">Test Live Tracking</span>
            </div>

            <div className="flex items-center justify-between gap-2 bg-slate-50 p-2 rounded-xl">
              <div className="flex items-center gap-1 text-[11px] font-bold text-slate-600">
                <span>Speed:</span>
                <button
                  onClick={() => setSimSpeed(1)}
                  className={`px-2.5 py-1 rounded-lg text-[10px] font-black transition ${
                    simSpeed === 1 ? 'bg-emerald-600 text-white' : 'bg-slate-200 text-slate-700'
                  }`}
                >
                  1x
                </button>
                <button
                  onClick={() => setSimSpeed(5)}
                  className={`px-2.5 py-1 rounded-lg text-[10px] font-black transition ${
                    simSpeed === 5 ? 'bg-emerald-600 text-white' : 'bg-slate-200 text-slate-700'
                  }`}
                >
                  5x
                </button>
                <button
                  onClick={() => setSimSpeed(20)}
                  className={`px-2.5 py-1 rounded-lg text-[10px] font-black transition ${
                    simSpeed === 20 ? 'bg-emerald-600 text-white' : 'bg-slate-200 text-slate-700'
                  }`}
                >
                  20x
                </button>
              </div>

              <button
                onClick={fastForward}
                className="bg-white hover:bg-slate-100 text-slate-800 font-bold px-2.5 py-1 rounded-lg border border-slate-200 shadow-2xs flex items-center gap-1 text-[10px]"
              >
                <Play className="w-3 h-3" />
                <span>+2 Mins</span>
              </button>
            </div>

            {/* Invoice Quick Trigger */}
            <div className="flex items-center justify-between pt-1">
              <div>
                <div className="font-bold text-slate-900">Tax Invoice & Summary</div>
                <div className="text-[11px] text-slate-500">{order.items.length} items • ₹{order.total} total</div>
              </div>
              <button
                onClick={() => setShowInvoice(!showInvoice)}
                className="bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-bold px-3 py-1.5 rounded-xl transition cursor-pointer flex items-center gap-1"
              >
                <FileText className="w-3.5 h-3.5" />
                <span>{showInvoice ? 'Hide Details' : 'View Invoice'}</span>
              </button>
            </div>

            {/* Detailed Invoice & Tax Breakdown View */}
            {showInvoice && (
              <div className="mt-3 pt-3 border-t border-slate-100 space-y-3 bg-slate-50 p-3 rounded-xl">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="font-bold text-slate-700">Order ID:</span>
                  <span className="font-mono font-bold text-slate-900">#{order.id}</span>
                </div>

                {order.customerGstin && order.customerBusinessName ? (
                  <>
                    <div className="flex items-center justify-between text-[11px] bg-emerald-50 p-2 rounded-lg border border-emerald-200">
                      <div>
                        <span className="font-extrabold text-emerald-950 block">Bill To (GST): {order.customerBusinessName}</span>
                        <span className="text-[10px] text-emerald-800 font-mono block">GSTIN: {order.customerGstin}</span>
                        <span className="text-[10px] text-slate-600 block mt-0.5">{order.customerBillingAddress || `${order.jobSite.floorUnit}, ${order.jobSite.address}`}</span>
                      </div>
                    </div>

                    <div className="flex items-center justify-between text-[11px]">
                      <span className="font-bold text-slate-700">Ship To (Selected Address):</span>
                      <span className="text-right text-slate-600 max-w-[200px] truncate">{order.jobSite.floorUnit}, {order.jobSite.address}</span>
                    </div>
                  </>
                ) : (
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="font-bold text-slate-700">Delivery & Billing Address:</span>
                    <span className="text-right text-slate-600 max-w-[200px] truncate">{order.jobSite.floorUnit}, {order.jobSite.address}</span>
                  </div>
                )}

                <div className="space-y-1.5 border-t border-slate-200 pt-2">
                  {order.items.map(({ product, quantity }) => (
                    <div key={product.id} className="flex justify-between text-[11px]">
                      <span className="text-slate-700 font-medium truncate max-w-[180px]">
                        {quantity}x {product.name}
                      </span>
                      <span className="font-bold text-slate-900">₹{product.price * quantity}</span>
                    </div>
                  ))}

                  <div className="flex justify-between text-[11px] text-slate-500 pt-1">
                    <span>Delivery Fee</span>
                    <span className="font-bold text-slate-700">{order.deliveryFee === 0 ? 'FREE' : `₹${order.deliveryFee}`}</span>
                  </div>

                  <div className="flex justify-between text-[11px] text-slate-500">
                    <span>Handling &amp; Platform Charges</span>
                    <span className="font-bold text-slate-700">₹{order.handlingFee ?? order.urgencyFee ?? 25}</span>
                  </div>

                  <div className="flex justify-between text-xs font-black text-slate-900 pt-1 border-t border-slate-200">
                    <span>Grand Total</span>
                    <span>₹{order.total}</span>
                  </div>
                </div>

                {/* Multi-Seller Invoices Breakdown if multiple invoices exist */}
                {(() => {
                  const trackingBundle = computeOrderInvoices(order);
                  return trackingBundle.sellerDocs.length > 1 ? (
                    <div className="pt-2 border-t border-slate-200/60 flex items-center gap-1.5 flex-wrap text-[11px]">
                      <span className="font-bold text-slate-500 text-[10px] uppercase">Separate Invoices:</span>
                      {trackingBundle.sellerDocs.map((sDoc, sIdx) => (
                        <button
                          key={sDoc.invoiceNumber}
                          type="button"
                          onClick={() => {
                            setInvoiceModalPageIndex(sIdx + 1);
                            setShowFullInvoiceModal(true);
                          }}
                          className="bg-white hover:bg-emerald-50 hover:text-emerald-900 hover:border-emerald-300 border border-slate-200 px-2 py-0.5 rounded-md font-mono text-[10px] font-bold text-slate-700 transition cursor-pointer flex items-center gap-1 shadow-2xs"
                          title={`View ${sDoc.seller.name} Invoice`}
                        >
                          <FileText className="w-2.5 h-2.5 text-slate-400" />
                          <span>{sDoc.invoiceNumber}</span>
                          <span className="text-[9px] text-slate-400 font-sans">({sDoc.seller.name.split(' ')[0]})</span>
                        </button>
                      ))}
                    </div>
                  ) : null;
                })()}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => {
                      setInvoiceModalPageIndex(0);
                      setShowFullInvoiceModal(true);
                    }}
                    className="w-full bg-slate-200 hover:bg-slate-300 text-slate-800 font-bold py-2.5 px-3 rounded-xl text-center text-xs transition cursor-pointer flex items-center justify-center gap-1.5"
                  >
                    <FileText className="w-3.5 h-3.5 text-slate-700" />
                    <span>View & Print Preview</span>
                  </button>

                  <button
                    type="button"
                    onClick={handleDownloadPdf}
                    disabled={isDownloadingPdf}
                    className="w-full bg-emerald-700 hover:bg-emerald-800 text-white font-bold py-2.5 px-3 rounded-xl text-center text-xs transition shadow-xs cursor-pointer flex items-center justify-center gap-1.5 disabled:opacity-50"
                  >
                    {pdfDownloaded ? (
                      <>
                        <Check className="w-3.5 h-3.5 stroke-[3]" />
                        <span>PDF Downloaded!</span>
                      </>
                    ) : (
                      <>
                        <Download className="w-3.5 h-3.5" />
                        <span>{isDownloadingPdf ? 'Generating PDF...' : 'Download Complete Invoice (PDF)'}</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}

          </div>

        </div>

        {/* ========================================================================= */}
        {/* MODAL 1: Edit Delivery Instructions Modal                                  */}
        {/* ========================================================================= */}
        {isEditingInstructions && (
          <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-end sm:items-center justify-center p-4">
            <div className="bg-white rounded-3xl w-full max-w-sm p-5 space-y-4 shadow-2xl animate-in zoom-in-95">
              <div className="flex items-center justify-between">
                <h3 className="font-black text-slate-900 text-sm">Delivery Instructions</h3>
                <button
                  onClick={() => setIsEditingInstructions(false)}
                  className="p-1 text-slate-400 hover:text-slate-800 rounded-full"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="space-y-2">
                <label className="text-[11px] font-bold text-slate-600 block">
                  Instructions for Rider / Gate Security:
                </label>
                <textarea
                  value={instructionInput}
                  onChange={(e) => setInstructionInput(e.target.value)}
                  rows={3}
                  className="w-full text-xs p-3 rounded-xl border border-slate-200 focus:outline-emerald-600 focus:ring-1 focus:ring-emerald-600"
                  placeholder="e.g. Leave at security desk, call upon reaching entry gate..."
                />
              </div>

              {/* Preset quick pills */}
              <div className="flex flex-wrap gap-1.5 text-[10px]">
                <button
                  onClick={() => setInstructionInput('Leave with security guard')}
                  className="bg-slate-100 hover:bg-slate-200 px-2.5 py-1 rounded-full text-slate-700 font-semibold"
                >
                  Leave with guard
                </button>
                <button
                  onClick={() => setInstructionInput('Call before entering site')}
                  className="bg-slate-100 hover:bg-slate-200 px-2.5 py-1 rounded-full text-slate-700 font-semibold"
                >
                  Call before entering
                </button>
                <button
                  onClick={() => setInstructionInput('Doorstep delivery to floor')}
                  className="bg-slate-100 hover:bg-slate-200 px-2.5 py-1 rounded-full text-slate-700 font-semibold"
                >
                  Doorstep to floor
                </button>
              </div>

              <div className="flex items-center gap-2 pt-2">
                <button
                  onClick={() => setIsEditingInstructions(false)}
                  className="flex-1 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold py-2.5 rounded-xl text-xs"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveInstructions}
                  className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-2.5 rounded-xl text-xs shadow-md"
                >
                  Save Instructions
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ========================================================================= */}
        {/* MODAL 2: Sponsored Offer Details Modal (for While You Wait items)           */}
        {/* ========================================================================= */}
        {activeSponsoredAd && (
          <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-end sm:items-center justify-center p-4">
            <div className="bg-white rounded-3xl w-full max-w-sm p-5 space-y-4 shadow-2xl animate-in zoom-in-95">
              <div className="flex items-center justify-between">
                <span className={`text-[10px] font-black px-2.5 py-0.5 rounded-md border ${activeSponsoredAd.badgeColor}`}>
                  {activeSponsoredAd.badge}
                </span>
                <button
                  onClick={() => setActiveSponsoredAd(null)}
                  className="p-1 text-slate-400 hover:text-slate-800 rounded-full"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div>
                <h3 className="font-black text-slate-900 text-base">{activeSponsoredAd.title}</h3>
                <p className="text-xs text-slate-600 mt-1">{activeSponsoredAd.subtitle}</p>
              </div>

              {activeSponsoredAd.code && (
                <div className="bg-slate-50 border border-slate-200 p-3 rounded-2xl flex items-center justify-between">
                  <div>
                    <span className="text-[10px] text-slate-400 font-bold uppercase block">Promo Code</span>
                    <span className="font-mono font-black text-sm text-slate-900">{activeSponsoredAd.code}</span>
                  </div>
                  <button
                    onClick={() => handleCopyAdCode(activeSponsoredAd.code!)}
                    className="bg-emerald-600 text-white text-xs font-bold px-3 py-1.5 rounded-xl hover:bg-emerald-700 transition"
                  >
                    {copiedCode === activeSponsoredAd.code ? 'Copied!' : 'Copy Code'}
                  </button>
                </div>
              )}

              <p className="text-[10px] text-slate-400 font-medium">
                {activeSponsoredAd.terms}
              </p>

              <button
                onClick={() => {
                  alert(`Offer applied successfully: ${activeSponsoredAd.code || activeSponsoredAd.title}`);
                  setActiveSponsoredAd(null);
                }}
                className={`w-full py-3 rounded-xl font-black text-xs shadow-md transition active:scale-95 ${activeSponsoredAd.ctaColor}`}
              >
                {activeSponsoredAd.ctaText}
              </button>
            </div>
          </div>
        )}

        {/* ========================================================================= */}
        {/* MODAL 3: Call Delivery Partner / Store Partner Dialog                      */}
        {/* ========================================================================= */}
        {showCallDialog && (
          <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-end sm:items-center justify-center p-4">
            <div className="bg-white rounded-3xl w-full max-w-sm p-5 space-y-4 shadow-2xl animate-in zoom-in-95 text-center">
              <div className="w-14 h-14 rounded-full bg-orange-100 text-orange-600 flex items-center justify-center mx-auto shadow-inner">
                <PhoneCall className="w-7 h-7" />
              </div>

              <div>
                <h3 className="font-black text-slate-900 text-base">Contact Delivery Partner</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Calling <strong className="text-slate-800">{order.rider.name}</strong> ({order.rider.phone || '+91 98450 12891'})
                </p>
                <div className="mt-2 inline-flex items-center gap-1.5 bg-emerald-50 text-emerald-800 text-[10px] font-bold px-2.5 py-1 rounded-full border border-emerald-200">
                  <ShieldCheck className="w-3.5 h-3.5" />
                  <span>Number masked for privacy & safety</span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 pt-2">
                <button
                  onClick={() => setShowCallDialog(false)}
                  className="bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold py-2.5 rounded-xl text-xs"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    alert(`Initiating masked call to ${order.rider.name}... Please keep your phone nearby.`);
                    setShowCallDialog(false);
                  }}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-2.5 rounded-xl text-xs shadow-md"
                >
                  Call Now
                </button>
              </div>
            </div>
          </div>
        )}



        {/* ========================================================================= */}
        {/* MODAL 4: Fullscreen Interactive Live Map Navigation View                  */}
        {/* ========================================================================= */}
        {isFullscreenMap && (
          <div className="fixed inset-0 z-50 bg-slate-950 flex flex-col animate-in fade-in duration-200">
            {/* Top Fullscreen HUD Header */}
            <div className="bg-slate-900/95 backdrop-blur-md px-4 py-3 border-b border-slate-800 flex items-center justify-between text-white z-20">
              <div className="flex items-center gap-3">
                <button
                  id="close-fullscreen-map"
                  type="button"
                  onClick={() => setIsFullscreenMap(false)}
                  className="w-8 h-8 rounded-full bg-slate-800 hover:bg-slate-700 flex items-center justify-center text-white transition active:scale-95"
                >
                  <X className="w-4 h-4" />
                </button>
                <div>
                  <div className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                    <span className="text-xs font-black tracking-wide uppercase text-emerald-400">
                      Live Route Navigation
                    </span>
                  </div>
                  <div className="text-xs font-bold text-slate-300">
                    {order.sellerPartner?.name || 'Sri Lakshmi Hardware'} → {order.jobSite.jobTag || 'Jobsite Drop'}
                  </div>
                </div>
              </div>

              <div className="text-right">
                <div className="text-lg font-black font-mono leading-none text-white">
                  {Math.max(1, Math.ceil(etaSeconds / 60))} <span className="text-xs font-bold text-slate-400">mins</span>
                </div>
                <div className="text-[10px] text-slate-400 font-bold">
                  {remainingMeters < 1000 ? `${remainingMeters}m away` : `${(remainingMeters / 1000).toFixed(1)} km away`}
                </div>
              </div>
            </div>

            {/* Fullscreen Map Canvas */}
            <div className="flex-1 relative w-full h-full">
              <OpenStreetMap
                center={riderCoords}
                zoom={16}
                isRouteMode={true}
                hubLocation={hubCoords}
                destinationLocation={destCoords}
                destinationLabel={dynamicDestinationLabel}
                riderStartLocation={riderStartCoords}
                riderLocation={riderCoords}
                riderName={order.rider.name}
                riderSpeed={courierSpeed}
                orderStatus={order.status}
                className="h-full w-full"
              />

              {/* Bottom Fullscreen Telemetry HUD Bar */}
              <div className="absolute bottom-6 inset-x-4 max-w-md mx-auto z-30 bg-slate-900/95 backdrop-blur-md rounded-2xl p-3.5 border border-slate-700 text-white shadow-2xl flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400">
                    <Navigation className="w-5 h-5 animate-pulse" />
                  </div>
                  <div>
                    <div className="text-xs font-black text-white flex items-center gap-1.5">
                      <span>{order.rider.name}</span>
                      <span className="text-[10px] text-emerald-400 font-mono bg-emerald-950/60 px-1.5 py-0.2 rounded border border-emerald-800">
                        {courierSpeed} km/h
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-400 truncate max-w-[200px]">
                      {statusSubtitle}
                    </div>
                  </div>
                </div>

                <button
                  onClick={() => setIsFullscreenMap(false)}
                  className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs px-3.5 py-2 rounded-xl transition active:scale-95"
                >
                  Exit Map
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ========================================================================= */}
        {/* MODAL 5: Official Tax Invoice & PDF Viewer Modal                           */}
        {/* ========================================================================= */}
        <InvoiceModal
          order={order}
          isOpen={showFullInvoiceModal}
          onClose={() => setShowFullInvoiceModal(false)}
          initialPageIndex={invoiceModalPageIndex}
        />

      </div>
    </div>
  );
};
