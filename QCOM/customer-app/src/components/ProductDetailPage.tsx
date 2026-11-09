import React, { useMemo } from 'react';
import { 
  X, 
  MapPin, 
  Boxes, 
  Clock, 
  Star, 
  Receipt, 
  Building2, 
  Plus, 
  Minus,
  Navigation,
  CheckCircle2,
  Store,
  ArrowLeft,
  ChevronRight,
  ShoppingBag,
  ArrowRight,
  Zap
} from 'lucide-react';
import { HardwareProduct } from '../types';
import { calculateProductDeliveryEstimate, Coordinates } from '../utils/deliveryEta';
import { ProductCard } from './ProductCard';

interface ProductDetailPageProps {
  product: HardwareProduct | null;
  onClose: () => void;
  onAddToCart: (product: HardwareProduct, qty?: number) => void;
  onUpdateCartQty: (productId: string, delta: number) => void;
  cart: { product: HardwareProduct; quantity: number }[];
  allProducts: HardwareProduct[];
  destinationCoords?: Coordinates;
  onOpenDetail: (product: HardwareProduct) => void;
  onOpenCart: () => void;
}

export const ProductDetailPage: React.FC<ProductDetailPageProps> = ({
  product,
  onClose,
  onAddToCart,
  onUpdateCartQty,
  cart,
  allProducts,
  destinationCoords,
  onOpenDetail,
  onOpenCart
}) => {
  if (!product) return null;

  const companionItems = useMemo(() => {
    return (product.frequentlyBoughtWith || [])
      .map(id => allProducts.find(p => p.id === id))
      .filter((p): p is HardwareProduct => Boolean(p));
  }, [product, allProducts]);

  const relatedProducts = useMemo(() => {
    return allProducts
      .filter(p => p.category === product.category && p.id !== product.id)
      .slice(0, 8);
  }, [product, allProducts]);

  const isGst = product.isGstRegistered !== false;
  const gstRate = product.gstRatePercent || 18;
  const estimatedTax = Math.round((product.price * gstRate) / (100 + gstRate));
  
  // Dynamic estimate calculated from this specific seller's location
  const estimate = calculateProductDeliveryEstimate(product, destinationCoords);


  const quantityInCart = cart.find(i => i.product.id === product.id)?.quantity || 0;

  const totalCartCount = cart.reduce((sum, item) => sum + item.quantity, 0);
  const cartTotal = cart.reduce((sum, item) => sum + (item.product.price * item.quantity), 0);


  return (
    <div className="fixed inset-0 z-50 bg-[#F4F6F8] overflow-y-auto flex flex-col w-full h-full animate-in slide-in-from-bottom-2 md:slide-in-from-right-8 duration-300 pb-20">
      
      {/* Sticky Header */}
      <div className="sticky top-0 z-10 bg-white border-b border-slate-200/80 px-3 py-3 flex items-center justify-between shadow-xs">
        <button 
          onClick={onClose}
          className="p-2 rounded-full hover:bg-slate-100 text-slate-800 transition cursor-pointer"
        >
          <ArrowLeft className="w-6 h-6" />
        </button>
        <div className="text-sm font-black text-slate-900 truncate px-2">{product.category.toUpperCase()}</div>
        <div className="w-10"></div> {/* Spacer for alignment */}
      </div>

      <div className="flex-1 w-full max-w-3xl mx-auto md:py-4 md:px-4 space-y-2 md:space-y-4">
        
        {/* Main Product Info Card */}
        <div className="bg-white md:rounded-2xl border-b md:border border-slate-200 shadow-2xs overflow-hidden">
          {/* Large Image */}
          <div className="w-full aspect-[4/3] sm:aspect-[16/9] md:aspect-[2/1] bg-slate-100 relative flex items-center justify-center p-0 overflow-hidden">
            {product.imageUrl ? (
              <img 
                src={product.imageUrl} 
                alt={product.name} 
                referrerPolicy="no-referrer"
                className="w-full h-full object-cover object-center"
              />
            ) : (
              <Boxes className="w-20 h-20 text-slate-300" />
            )}
            <div className={`absolute bottom-3 left-3 text-[10px] font-black px-2.5 py-1 rounded-md uppercase tracking-wider ${estimate.badgeColor} shadow-sm border border-black/5`}>
              {estimate.badge}
            </div>
          </div>
          
          <div className="p-4 sm:p-5">
            <h1 className="text-lg sm:text-xl md:text-2xl font-black text-slate-900 leading-tight">
              {product.name}
            </h1>
            
            <div className="flex items-center gap-1 mt-2 text-[11px] font-bold">
              <div className="flex items-center gap-1 text-emerald-800 font-extrabold text-[11px] bg-emerald-100 px-2 py-0.5 rounded-full">
                <Zap className="w-3 h-3 fill-emerald-700 text-emerald-700" />
                <span>{estimate.etaMins} MINS</span>
              </div>
            </div>

            <div className="flex items-center justify-between mt-4">
              <div>
                <div className="flex items-baseline gap-1.5">
                  <span className="text-xl font-black text-slate-900">₹{product.price}</span>
                  {product.originalPrice && (
                    <span className="text-xs text-slate-400 line-through">₹{product.originalPrice}</span>
                  )}
                </div>
                <div className="text-[10px] text-slate-500 mt-0.5">Inclusive of all taxes</div>
              </div>

              {/* Add to Cart Control */}
              <div className="shrink-0">
                {quantityInCart === 0 ? (
                  <button
                    onClick={() => onAddToCart(product, 1)}
                    className="bg-emerald-50 border border-emerald-600 hover:bg-emerald-100 text-emerald-700 font-black text-sm uppercase px-8 py-2.5 rounded-xl shadow-2xs transition cursor-pointer"
                  >
                    ADD
                  </button>
                ) : (
                  <div className="bg-emerald-700 text-white rounded-xl px-2 py-1.5 flex items-center justify-between gap-3 shadow-2xs font-bold text-sm min-w-[100px]">
                    <button
                      onClick={() => onUpdateCartQty(product.id, -1)}
                      className="w-7 h-7 flex items-center justify-center hover:bg-emerald-800 rounded transition cursor-pointer"
                    >
                      <Minus className="w-4 h-4 stroke-[3]" />
                    </button>
                    <span className="font-mono">{quantityInCart}</span>
                    <button
                      onClick={() => onUpdateCartQty(product.id, 1)}
                      className="w-7 h-7 flex items-center justify-center hover:bg-emerald-800 rounded transition cursor-pointer"
                    >
                      <Plus className="w-4 h-4 stroke-[3]" />
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Product Details & Specs */}
        <div className="bg-white md:rounded-2xl border-y md:border border-slate-200 shadow-2xs p-4 sm:p-5 space-y-4">
          <h3 className="font-black text-slate-900 text-sm">Product Details</h3>
          
          <div className="text-xs text-slate-600 leading-relaxed">
            {product.description}
          </div>

          <div className="space-y-1.5 pt-2">
            <span className="font-black text-slate-400 uppercase tracking-wider block text-[10px]">
              Verified Trade Specifications
            </span>
            <div className="bg-slate-50 rounded-xl border border-slate-200/80 overflow-hidden divide-y divide-slate-200/60 text-xs">
              {Object.entries(product.specs).map(([key, val]) => (
                <div key={key} className="flex justify-between px-3 py-2">
                  <span className="text-slate-500 capitalize">{key.replace(/([A-Z])/g, ' $1')}:</span>
                  <span className="font-bold text-slate-900 text-right">{val}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* B2B GSTIN Info */}
        <div className="bg-white md:rounded-2xl border-y md:border border-slate-200 shadow-2xs p-4 sm:p-5">
           <div className={`p-3.5 rounded-xl border ${isGst ? 'bg-sky-50/70 border-sky-200' : 'bg-slate-50 border-slate-200'} space-y-2 text-xs`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 font-black text-slate-900">
                <Receipt className="w-4 h-4 text-sky-700" />
                <span>Seller GSTIN & ITC</span>
              </div>
              {isGst ? (
                <span className="text-[10px] bg-emerald-100 text-emerald-800 font-extrabold px-2 py-0.5 rounded-full border border-emerald-300">
                  100% ITC
                </span>
              ) : (
                <span className="text-[10px] bg-slate-200 text-slate-600 font-bold px-2 py-0.5 rounded-full">
                  No ITC
                </span>
              )}
            </div>
            {isGst ? (
              <div className="space-y-1.5 text-slate-700 text-[11px] mt-2">
                <div className="flex justify-between">
                  <span className="text-slate-500">Seller GSTIN:</span>
                  <span className="font-mono font-bold text-slate-900">{product.sellerGstin || estimate.sellerId}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Tax Slab:</span>
                  <span className="font-bold text-slate-900">{gstRate}% (CGST {gstRate/2}% + SGST {gstRate/2}%)</span>
                </div>
                <div className="flex justify-between pt-2 border-t border-sky-200/60 font-bold">
                  <span className="text-emerald-800">ITC Claim:</span>
                  <span className="text-emerald-800 font-mono font-black">+₹{estimatedTax}</span>
                </div>
              </div>
            ) : (
              <p className="text-slate-500 text-[11px] mt-1">
                Sold by an unregistered vendor. No B2B GST tax credit.
              </p>
            )}
          </div>
        </div>

        
        {/* Companion Items Carousel */}
        {companionItems.length > 0 && (
          <div className="bg-white md:rounded-2xl border-y md:border border-slate-200 shadow-2xs py-4 sm:py-5 space-y-3">
            <div className="px-4 flex items-center justify-between">
              <h3 className="font-black text-slate-900 text-sm">Frequently Bought Together</h3>
            </div>
            <div className="flex overflow-x-auto gap-3 px-4 pb-2 no-scrollbar snap-x">
              {companionItems.map(rel => {
                const qty = cart.find(i => i.product.id === rel.id)?.quantity || 0;
                return (
                  <div key={rel.id} className="w-[150px] sm:w-[170px] shrink-0 snap-start">
                    <ProductCard
                      product={rel}
                      quantityInCart={qty}
                      onAddToCart={onAddToCart}
                      onUpdateCartQty={onUpdateCartQty}
                      onOpenDetail={onOpenDetail}
                      destinationCoords={destinationCoords}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Similar Products Carousel */}
        {relatedProducts.length > 0 && (
          <div className="bg-white md:rounded-2xl border-y md:border border-slate-200 shadow-2xs py-4 sm:py-5 space-y-3">
            <div className="px-4 flex items-center justify-between">
              <h3 className="font-black text-slate-900 text-sm">Similar Products</h3>
            </div>
            <div className="flex overflow-x-auto gap-3 px-4 pb-2 no-scrollbar snap-x">
              {relatedProducts.map(rel => {
                const qty = cart.find(i => i.product.id === rel.id)?.quantity || 0;
                return (
                  <div key={rel.id} className="w-[150px] sm:w-[170px] shrink-0 snap-start">
                    <ProductCard
                      product={rel}
                      quantityInCart={qty}
                      onAddToCart={onAddToCart}
                      onUpdateCartQty={onUpdateCartQty}
                      onOpenDetail={onOpenDetail}
                      destinationCoords={destinationCoords}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        )}

      </div>

      {/* Signature Sticky Floating Bottom Cart Bar */}
      {totalCartCount > 0 && (
        <div className="fixed bottom-[68px] md:bottom-6 inset-x-0 z-40 max-w-lg mx-auto px-3 sm:px-4 animate-in slide-in-from-bottom-3">
          <div 
            onClick={() => {
              onClose();
              onOpenCart();
            }}
            className="bg-emerald-800 hover:bg-emerald-900 text-white rounded-2xl p-3 sm:p-3.5 px-4 sm:px-5 shadow-xl shadow-emerald-950/20 flex items-center justify-between cursor-pointer transition-transform active:scale-[0.99] border border-emerald-700/50"
          >
            <div className="flex items-center gap-2.5 sm:gap-3 min-w-0">
              <div className="w-8 h-8 rounded-xl bg-white/20 flex items-center justify-center font-black shrink-0">
                <ShoppingBag className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <div className="font-black text-sm sm:text-base">{totalCartCount} item{totalCartCount > 1 ? 's' : ''}</div>
                <div className="text-[10px] sm:text-xs text-emerald-200 font-bold truncate">
                  Total ₹{cartTotal}
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
    </div>
  );
};
