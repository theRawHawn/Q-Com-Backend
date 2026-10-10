import React, { useState, useMemo } from 'react';
import { 
  ArrowLeft, 
  RotateCcw, 
  Package, 
  CheckCircle2, 
  Truck, 
  Search, 
  MapPin, 
  Plus, 
  ShoppingBag, 
  ChevronRight,
  ExternalLink,
  Check,
  ShieldCheck,
  TrendingUp,
  Receipt,
  Clock,
  FileText,
  Download
} from 'lucide-react';
import { Order, HardwareProduct, CartItem } from '../types';
import { InvoiceModal } from './InvoiceModal';
import { generateInvoicePDF, computeOrderInvoices } from '../utils/invoiceGenerator';

interface OrderHistoryPageProps {
  orders: Order[];
  onClose: () => void;
  onAddToCart: (product: HardwareProduct, qty?: number) => void;
  onUpdateCartQty: (productId: string, delta: number) => void;
  onAddMultipleToCart: (items: { product: HardwareProduct; qty: number }[]) => void;
  onOpenOrderTracking?: (orderId: string) => void;
  onOpenCart: () => void;
  cart: CartItem[];
  deliveryEtaMins?: number;
}

export const OrderHistoryPage: React.FC<OrderHistoryPageProps> = ({
  orders,
  onClose,
  onAddToCart,
  onUpdateCartQty,
  onAddMultipleToCart,
  onOpenOrderTracking,
  onOpenCart,
  cart,
  deliveryEtaMins = 11,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [filterTab, setFilterTab] = useState<'all' | 'delivered' | 'active'>('all');
  const [reorderedOrderId, setReorderedOrderId] = useState<string | null>(null);
  const [addedItemIds, setAddedItemIds] = useState<Record<string, boolean>>({});
  const [selectedInvoiceOrder, setSelectedInvoiceOrder] = useState<Order | null>(null);
  const [selectedInvoicePageIndex, setSelectedInvoicePageIndex] = useState<number>(0);
  const [downloadingOrderId, setDownloadingOrderId] = useState<string | null>(null);

  const handleDownloadInvoicePdf = async (order: Order, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setDownloadingOrderId(order.id);
    try {
      await generateInvoicePDF(order, { autoDownload: true });
    } catch (err) {
      console.error('Error generating PDF:', err);
    } finally {
      setTimeout(() => setDownloadingOrderId(null), 1500);
    }
  };

  // Calculations for Right Column Analytics
  const totalOrdersCount = orders.length;
  const totalDeliveredOrders = orders.filter(o => o.status === 'delivered').length;
  const totalActiveOrders = orders.filter(o => o.status !== 'delivered').length;
  
  const totalMoneySpent = useMemo(() => {
    return orders.reduce((sum, o) => sum + o.total, 0);
  }, [orders]);

  const totalTimeSaved = useMemo(() => {
    return orders.reduce((sum, o) => sum + (o.timeSavedMinutes || 45), 0);
  }, [orders]);

  const totalItcClaimed = useMemo(() => {
    return orders.reduce((sum, o) => sum + (o.itcAmount || 0), 0);
  }, [orders]);

  // Filter orders
  const filteredOrders = useMemo(() => {
    return orders.filter(order => {
      const matchesTab = 
        filterTab === 'all' ? true :
        filterTab === 'delivered' ? order.status === 'delivered' :
        order.status !== 'delivered';

      if (!matchesTab) return false;

      if (!searchQuery.trim()) return true;

      const query = searchQuery.toLowerCase();
      const matchesId = order.id.toLowerCase().includes(query);
      const matchesItem = order.items.some(item => 
        item.product.name.toLowerCase().includes(query) ||
        item.product.specs.brand.toLowerCase().includes(query) ||
        item.product.category.toLowerCase().includes(query)
      );
      const matchesAddress = order.jobSite.address.toLowerCase().includes(query) ||
        (order.jobSite.landmark && order.jobSite.landmark.toLowerCase().includes(query));

      return matchesId || matchesItem || matchesAddress;
    });
  }, [orders, filterTab, searchQuery]);

  const handleReorderWholeOrder = (order: Order) => {
    const itemsToAdd = order.items.map(item => ({
      product: item.product,
      qty: item.quantity
    }));
    onAddMultipleToCart(itemsToAdd);

    setReorderedOrderId(order.id);
    setTimeout(() => {
      setReorderedOrderId(null);
    }, 2000);
  };

  const handleReorderSingleItem = (product: HardwareProduct, qty: number) => {
    onAddToCart(product, qty);
    setAddedItemIds(prev => ({ ...prev, [product.id]: true }));
    setTimeout(() => {
      setAddedItemIds(prev => ({ ...prev, [product.id]: false }));
    }, 1500);
  };

  const formatDate = (date: Date | string) => {
    const d = new Date(date);
    if (isNaN(d.getTime())) return 'Recently';
    
    return d.toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const cartTotal = cart.reduce((sum, item) => sum + item.product.price * item.quantity, 0);
  const totalCartCount = cart.reduce((sum, item) => sum + item.quantity, 0);

  return (
    <div className="flex-1 bg-[#F4F6F8] min-h-screen flex flex-col font-sans">
      
      {/* Top Header Navigation (styled like checkout page back header) */}
      <div className="sticky top-0 z-40 bg-[#FAD845] border-b border-amber-400/60 shadow-sm px-3 sm:px-6 py-3 sm:py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="p-2 bg-slate-900/10 hover:bg-slate-900/15 text-slate-900 rounded-full transition cursor-pointer"
            >
              <ArrowLeft className="w-5 h-5 stroke-[2.5]" />
            </button>
            <div>
              <h1 className="text-lg sm:text-xl font-extrabold text-slate-900 tracking-tight">
                Order History
              </h1>
            </div>
          </div>

          <button
            onClick={onOpenCart}
            className="bg-slate-900 hover:bg-slate-800 text-white px-3 sm:px-4 py-2 rounded-2xl text-xs font-black flex items-center gap-2 shadow-sm cursor-pointer transition"
          >
            <ShoppingBag className="w-4 h-4 text-[#FAD845]" />
            <span className="hidden sm:inline">Active Cart</span>
            <span className="bg-emerald-500 text-white text-[10px] px-1.5 py-0.5 rounded-full font-black">
              {totalCartCount}
            </span>
          </button>
        </div>
      </div>

      {/* Main Two-Column Content Grid */}
      <div className="flex-1 max-w-7xl w-full mx-auto px-3 sm:px-4 md:px-6 lg:px-8 py-5 sm:py-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Left 2 Columns: Past Orders List */}
        <div className="lg:col-span-2 space-y-5">
          
          {/* Filters & Search Control */}
          <div className="bg-white border border-slate-200 rounded-3xl p-4 shadow-xs space-y-4">
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
              <div className="relative flex-1">
                <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search orders by item name, brand, category or ID..."
                  className="w-full pl-10 pr-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs sm:text-sm focus:bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500 transition font-medium"
                />
                {searchQuery && (
                  <button 
                    onClick={() => setSearchQuery('')}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 font-bold text-xs"
                  >
                    Clear
                  </button>
                )}
              </div>

              {/* Status Filter Tabs */}
              <div className="flex items-center bg-slate-100 p-1 rounded-xl gap-1 shrink-0 self-start sm:self-center">
                <button
                  onClick={() => setFilterTab('all')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer whitespace-nowrap ${
                    filterTab === 'all' 
                      ? 'bg-white text-slate-900 shadow-2xs' 
                      : 'text-slate-500 hover:text-slate-900'
                  }`}
                >
                  All ({orders.length})
                </button>
                <button
                  onClick={() => setFilterTab('delivered')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer whitespace-nowrap ${
                    filterTab === 'delivered' 
                      ? 'bg-white text-emerald-800 shadow-2xs' 
                      : 'text-slate-500 hover:text-slate-900'
                  }`}
                >
                  Delivered
                </button>
                <button
                  onClick={() => setFilterTab('active')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer whitespace-nowrap ${
                    filterTab === 'active' 
                      ? 'bg-white text-blue-800 shadow-2xs' 
                      : 'text-slate-500 hover:text-slate-900'
                  }`}
                >
                  Active ({totalActiveOrders})
                </button>
              </div>
            </div>
          </div>

          {/* Orders Stream */}
          <div className="space-y-4">
            {filteredOrders.length === 0 ? (
              <div className="text-center py-16 px-6 bg-white border border-slate-200 rounded-3xl space-y-4">
                <div className="w-16 h-16 rounded-full bg-slate-50 border border-slate-100 text-slate-400 flex items-center justify-center mx-auto">
                  <Package className="w-8 h-8" />
                </div>
                <div className="space-y-1">
                  <h3 className="text-base font-black text-slate-800">No matching orders found</h3>
                  <p className="text-xs text-slate-500 max-w-sm mx-auto">
                    {searchQuery 
                      ? `No orders matching "${searchQuery}" in your history.`
                      : 'Your trade order details and items will appear here after placing an order.'}
                  </p>
                </div>
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery('')}
                    className="bg-slate-950 text-white text-xs font-bold px-4 py-2 rounded-xl"
                  >
                    Reset Search
                  </button>
                )}
              </div>
            ) : (
              filteredOrders.map((order) => {
                const isDelivered = order.status === 'delivered';
                const isJustReordered = reorderedOrderId === order.id;

                return (
                  <div 
                    key={order.id}
                    className="bg-white border border-slate-200 rounded-3xl p-5 shadow-xs hover:border-slate-300 transition-all space-y-4 animate-in fade-in duration-200"
                  >
                    {/* Order Meta Bar */}
                    <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-100">
                      <div className="flex items-center gap-2.5">
                        <span className="font-black text-xs text-slate-900 bg-slate-100 px-3 py-1.5 rounded-xl border border-slate-200/50">
                          #{order.id}
                        </span>
                        <span className="text-xs text-slate-500 font-semibold">
                          {formatDate(order.placedAt)}
                        </span>
                      </div>

                      <div className="flex items-center gap-2">
                        {isDelivered ? (
                          <span className="bg-emerald-50 text-emerald-800 border border-emerald-200/50 text-[11px] font-black px-3 py-1 rounded-full flex items-center gap-1">
                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                            <span>Delivered Successfully</span>
                          </span>
                        ) : (
                          <span className="bg-blue-50 text-blue-800 border border-blue-200/50 text-[11px] font-black px-3 py-1 rounded-full flex items-center gap-1.5 animate-pulse">
                            <Truck className="w-3.5 h-3.5 text-blue-500" />
                            <span className="capitalize">{order.status.replace(/_/g, ' ')}</span>
                          </span>
                        )}

                        {!isDelivered && onOpenOrderTracking && (
                          <button
                            onClick={() => onOpenOrderTracking(order.id)}
                            className="text-xs font-black text-sky-800 bg-sky-50 hover:bg-sky-100 px-3 py-1 rounded-full border border-sky-200 transition cursor-pointer flex items-center gap-1"
                          >
                            <span>Live Track</span>
                            <ExternalLink className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Ordered Items Layout */}
                    <div className="space-y-2.5">
                      <div className="text-[11px] font-black text-slate-400 uppercase tracking-wider">
                        Ordered Items ({order.items.reduce((s, i) => s + i.quantity, 0)})
                      </div>

                      <div className="divide-y divide-slate-100 rounded-2xl bg-slate-50/50 border border-slate-200/60 px-4 py-2 space-y-2">
                        {order.items.map((item, idx) => {
                          const isItemAdded = addedItemIds[item.product.id];

                          return (
                            <div 
                              key={`${order.id}-${item.product.id}-${idx}`}
                              className="py-3 first:pt-1.5 last:pb-1.5 flex items-center justify-between gap-4 text-xs"
                            >
                              <div className="flex items-center gap-3 min-w-0">
                                <img
                                  src={item.product.imageUrl}
                                  alt={item.product.name}
                                  referrerPolicy="no-referrer"
                                  className="w-12 h-12 object-cover rounded-xl border border-slate-200 bg-white shrink-0 shadow-2xs"
                                />
                                <div className="min-w-0">
                                  <div className="font-extrabold text-slate-900 text-sm truncate">
                                    {item.product.name}
                                  </div>
                                  <div className="text-xs text-slate-500 font-bold mt-0.5 flex items-center gap-1.5">
                                    <span className="text-slate-800">{item.product.specs.brand}</span>
                                    <span>•</span>
                                    <span>{item.quantity} Unit{item.quantity > 1 ? 's' : ''} × ₹{item.product.price}</span>
                                  </div>
                                </div>
                              </div>

                              <button
                                onClick={() => handleReorderSingleItem(item.product, item.quantity)}
                                className={`px-3 py-2 rounded-xl text-xs font-extrabold flex items-center gap-1.5 shrink-0 transition-all cursor-pointer shadow-2xs ${
                                  isItemAdded
                                    ? 'bg-emerald-700 text-white border border-emerald-700'
                                    : 'bg-white hover:bg-slate-50 text-emerald-800 border border-slate-200'
                                }`}
                              >
                                {isItemAdded ? (
                                  <>
                                    <Check className="w-3.5 h-3.5 stroke-[3]" />
                                    <span>Added!</span>
                                  </>
                                ) : (
                                  <>
                                    <Plus className="w-3.5 h-3.5" />
                                    <span>Reorder Item</span>
                                  </>
                                )}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* Address & Actions */}
                    <div className="pt-3 border-t border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div className="text-xs text-slate-600 flex items-center gap-2.5 flex-wrap">
                        <div className="flex items-center gap-1.5 font-bold">
                          <MapPin className="w-4 h-4 text-slate-400 shrink-0" />
                          <span className="truncate max-w-[220px] sm:max-w-[320px]">
                            {order.jobSite.floorUnit ? `${order.jobSite.floorUnit}, ` : ''}{order.jobSite.address}
                          </span>
                        </div>
                        <span className="text-slate-300">•</span>
                        <span className="font-black text-slate-900 text-sm">
                          Paid ₹{order.total} via {order.paymentMethod}
                        </span>
                      </div>

                      <div className="flex items-center gap-2 flex-wrap">
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedInvoiceOrder(order);
                            setSelectedInvoicePageIndex(0);
                          }}
                          className="px-3 py-2 rounded-xl text-xs font-bold bg-slate-100 hover:bg-slate-200 text-slate-700 flex items-center gap-1.5 transition cursor-pointer"
                        >
                          <FileText className="w-3.5 h-3.5 text-slate-500" />
                          <span>View Invoice</span>
                        </button>

                        <button
                          type="button"
                          onClick={(e) => handleDownloadInvoicePdf(order, e)}
                          disabled={downloadingOrderId === order.id}
                          className="px-3 py-2 rounded-xl text-xs font-bold bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-200 flex items-center gap-1.5 transition cursor-pointer disabled:opacity-50"
                        >
                          <Download className="w-3.5 h-3.5 text-emerald-600" />
                          <span>{downloadingOrderId === order.id ? 'Generating...' : 'Download Complete Invoice'}</span>
                        </button>

                        <button
                          onClick={() => handleReorderWholeOrder(order)}
                          className={`px-4 py-2.5 rounded-xl text-xs font-black flex items-center gap-2 transition-all cursor-pointer shadow-xs ${
                            isJustReordered
                              ? 'bg-emerald-800 text-white'
                              : 'bg-emerald-700 hover:bg-emerald-800 text-white'
                          }`}
                        >
                          {isJustReordered ? (
                            <>
                              <Check className="w-4 h-4 stroke-[3]" />
                              <span>Entire Order Added to Cart!</span>
                            </>
                          ) : (
                            <>
                              <RotateCcw className="w-4 h-4" />
                              <span>Reorder Entire Order</span>
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Right 1 Column: Checkout-Style Analytics, B2B summary, and Active Cart Shortcut */}
        <div className="space-y-6">
          
          {/* Box 1: B2B Trade & Address Analytics */}
          <div className="bg-white border border-slate-200 rounded-3xl p-5 shadow-xs space-y-4">
            <h2 className="text-sm font-black text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
              <TrendingUp className="w-4 h-4 text-slate-500" />
              <span>Trade Performance</span>
            </h2>

            <div className="grid grid-cols-2 gap-3">
              <div className="bg-slate-50 p-3 rounded-2xl border border-slate-100">
                <span className="text-[10px] text-slate-400 font-bold block uppercase">Time Saved</span>
                <span className="text-xl font-black text-slate-900">{totalTimeSaved} mins</span>
                <span className="text-[9px] text-slate-500 block mt-0.5">VS manual store visits</span>
              </div>
              <div className="bg-slate-50 p-3 rounded-2xl border border-slate-100">
                <span className="text-[10px] text-slate-400 font-bold block uppercase">GST Saved</span>
                <span className="text-xl font-black text-emerald-700">₹{totalItcClaimed}</span>
                <span className="text-[9px] text-slate-500 block mt-0.5">Input Tax Credit</span>
              </div>
            </div>

            <div className="bg-amber-50 border border-amber-200/50 rounded-2xl p-3.5 flex items-start gap-2.5 text-xs text-amber-950">
              <ShieldCheck className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
              <div>
                <span className="font-extrabold block">B2B Verified Profile</span>
                <span className="font-medium text-[11px] text-amber-900/90 mt-0.5 block leading-normal">
                  All tax invoices generated automatically and synced with GSTIN. Save 18% on materials across every reorder.
                </span>
              </div>
            </div>
          </div>

          {/* Box 2: Verified Local Merchant Partners */}
          <div className="bg-white border border-slate-200 rounded-3xl p-5 shadow-xs space-y-3">
            <h2 className="text-sm font-black text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
              <Receipt className="w-4 h-4 text-slate-500" />
              <span>Past Local Sellers</span>
            </h2>
            <div className="space-y-2 text-xs">
              <div className="flex items-center justify-between p-2.5 rounded-xl hover:bg-slate-50 border border-slate-100">
                <div>
                  <span className="font-bold text-slate-800 block">Sri Lakshmi Hardware & Electricals</span>
                  <span className="text-[10px] text-slate-400">Koramangala • 4.9 ★ Verified</span>
                </div>
                <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
              </div>
              <div className="flex items-center justify-between p-2.5 rounded-xl hover:bg-slate-50 border border-slate-100">
                <div>
                  <span className="font-bold text-slate-800 block">Koramangala Pipe & Cable Co.</span>
                  <span className="text-[10px] text-slate-400">BDA Layout • 4.8 ★ Verified</span>
                </div>
                <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
              </div>
            </div>
          </div>

          {/* Box 3: Checkout-themed Active Cart Shortcut */}
          {totalCartCount > 0 && (
            <div className="bg-gradient-to-br from-emerald-800 to-emerald-950 text-white rounded-3xl p-5 shadow-lg border border-emerald-700/60 space-y-4">
              <div>
                <div className="flex items-center gap-1.5">
                  <ShoppingBag className="w-5 h-5 text-[#FAD845]" />
                  <span className="text-xs font-black uppercase tracking-wider text-emerald-200">
                    Active Shopping Cart
                  </span>
                </div>
                <h3 className="text-lg font-black mt-1 leading-tight">
                  You have {totalCartCount} item{totalCartCount > 1 ? 's' : ''} in cart
                </h3>
                <p className="text-xs text-emerald-100/80 mt-1">
                  Ready to place? Reordered items have been appended successfully.
                </p>
              </div>

              <div className="bg-emerald-900/60 p-3 rounded-2xl border border-emerald-800/40 flex items-center justify-between text-xs font-black">
                <span>Current Cart Total:</span>
                <span className="text-base text-[#FAD845]">₹{cartTotal}</span>
              </div>

              <button
                onClick={onOpenCart}
                className="w-full bg-[#FAD845] hover:bg-[#fae273] text-emerald-950 font-black text-xs py-3 rounded-2xl shadow-md transition-all active:scale-[0.98] flex items-center justify-center gap-1 cursor-pointer"
              >
                <span>Proceed to Checkout</span>
                <ChevronRight className="w-4 h-4 stroke-[2.5]" />
              </button>
            </div>
          )}

          {/* Info Badge */}
          <div className="text-slate-400 text-[11px] text-center font-semibold leading-normal max-w-xs mx-auto">
            ⚡ RushQ Express guarantees fast location-calculated dispatch from verified local partners for all reordered materials.
          </div>

        </div>

      </div>

      {/* Official Tax Invoice & PDF Viewer Modal */}
      <InvoiceModal
        order={selectedInvoiceOrder}
        isOpen={Boolean(selectedInvoiceOrder)}
        onClose={() => setSelectedInvoiceOrder(null)}
        initialPageIndex={selectedInvoicePageIndex}
      />

    </div>
  );
};
