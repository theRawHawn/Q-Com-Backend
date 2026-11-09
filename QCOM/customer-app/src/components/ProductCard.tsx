import React from 'react';
import { 
  Plus, 
  Minus, 
  Clock, 
  Star, 
  ShieldCheck, 
  Droplet, 
  Zap, 
  Hammer, 
  Anchor, 
  Wrench, 
  TestTube, 
  Receipt,
  MapPin
} from 'lucide-react';
import { HardwareProduct } from '../types';
import { calculateProductDeliveryEstimate, Coordinates } from '../utils/deliveryEta';

interface ProductCardProps {
  product: HardwareProduct;
  quantityInCart: number;
  onAddToCart: (product: HardwareProduct, qty?: number) => void;
  onUpdateCartQty: (productId: string, delta: number) => void;
  onOpenDetail: (product: HardwareProduct) => void;
  deliveryEtaMins?: number;
  destinationCoords?: Coordinates;
}

export const ProductCard: React.FC<ProductCardProps> = ({
  product,
  quantityInCart,
  onAddToCart,
  onUpdateCartQty,
  onOpenDetail,
  destinationCoords,
}) => {
  // Category-specific visual icon & theme
  const getCategoryTheme = (cat: string) => {
    switch (cat) {
      case 'plumbing':
        return { icon: Droplet, bg: 'bg-blue-50/70', color: 'text-blue-600', border: 'border-blue-100' };
      case 'electrical':
        return { icon: Zap, bg: 'bg-amber-50/70', color: 'text-amber-600', border: 'border-amber-100' };
      case 'carpentry':
        return { icon: Hammer, bg: 'bg-orange-50/70', color: 'text-orange-600', border: 'border-orange-100' };
      case 'fasteners':
        return { icon: Anchor, bg: 'bg-slate-100/70', color: 'text-slate-700', border: 'border-slate-200' };
      case 'tools':
        return { icon: Wrench, bg: 'bg-emerald-50/70', color: 'text-emerald-700', border: 'border-emerald-100' };
      case 'adhesives':
        return { icon: TestTube, bg: 'bg-rose-50/70', color: 'text-rose-600', border: 'border-rose-100' };
      default:
        return { icon: ShieldCheck, bg: 'bg-teal-50/70', color: 'text-teal-700', border: 'border-teal-100' };
    }
  };

  const theme = getCategoryTheme(product.category);
  const Icon = theme.icon;

  const discountPercent = product.originalPrice 
    ? Math.round(((product.originalPrice - product.price) / product.originalPrice) * 100) 
    : null;

  // Real-time Swiggy/Zomato style distance & ETA calculated from this specific seller's location
  const estimate = calculateProductDeliveryEstimate(product, destinationCoords);

  return (
    <div 
      id={`product-card-${product.id}`}
      className="bg-white border border-slate-200/80 rounded-2xl p-2.5 sm:p-3 flex flex-col justify-between hover:shadow-md transition-all duration-200 group relative overflow-hidden"
    >
      
      <div>
        {/* Top Thumbnail Image Area */}
        <div 
          onClick={() => onOpenDetail(product)}
          className={`w-full aspect-[4/3] rounded-xl ${theme.bg} ${theme.border} border flex flex-col items-center justify-center relative cursor-pointer group-hover:scale-[1.02] transition-transform overflow-hidden`}
        >
          {/* Offer Badge on Top Right of Image Tile */}
          {discountPercent ? (
            <div className="absolute top-2 right-2 bg-rose-600 text-white text-[9px] font-black px-1.5 py-0.5 rounded-md uppercase tracking-wider shadow-2xs">
              {discountPercent}% OFF
            </div>
          ) : product.stockCount <= 5 ? (
            <div className="absolute top-2 right-2 bg-amber-600 text-white text-[8.5px] font-black px-1.5 py-0.5 rounded-md uppercase tracking-wider">
              Only {product.stockCount} left
            </div>
          ) : null}

          {/* Center Graphic / Real Product Photo */}
          {product.imageUrl ? (
            <img 
              src={product.imageUrl} 
              alt={product.name} 
              referrerPolicy="no-referrer"
              className="w-full h-full object-cover object-center group-hover:scale-105 transition-transform duration-300"
              onError={(e) => {
                (e.currentTarget as HTMLElement).style.display = 'none';
                const parent = (e.currentTarget as HTMLElement).parentElement;
                if (parent) {
                  const fallback = parent.querySelector('.fallback-icon');
                  if (fallback) fallback.classList.remove('hidden');
                }
              }}
            />
          ) : null}

          <div className={`fallback-icon ${product.imageUrl ? 'hidden' : ''} w-12 h-12 rounded-2xl bg-white shadow-2xs border border-black/5 flex items-center justify-center`}>
            <Icon className={`w-7 h-7 ${theme.color}`} />
          </div>
        </div>

        {/* Frameless Product Details Directly Below Image Tile on Card Background */}
        <div className="mt-2 space-y-1.5">
          
          {/* 1. Product Title */}
          <h3 
            onClick={() => onOpenDetail(product)}
            className="text-xs sm:text-sm font-bold text-slate-900 leading-snug line-clamp-2 cursor-pointer hover:text-emerald-700 transition"
            title={product.name}
          >
            {product.name}
          </h3>
          
          {/* Delivery ETA Tag */}
          <div className="flex items-center gap-1 mt-0.5 pt-0.5">
            <div 
              className="flex items-center gap-1 text-[10px] font-bold" 
              title={`Express Delivery by ${estimate.sellerName}`}
            >
              <div className="flex items-center gap-1 text-emerald-800 font-extrabold text-[10px] bg-emerald-100 px-2 py-0.5 rounded-full">
                <Zap className="w-2.5 h-2.5 fill-emerald-700 text-emerald-700" />
                <span>{estimate.etaMins} MINS</span>
              </div>
            </div>
          </div>

        </div>
      </div>

      {/* Price & Non-Overflowing ADD / Quantity Counter Button */}
      <div className="mt-2.5 pt-2 border-t border-slate-100 flex items-center justify-between gap-1.5 min-w-0">
        
        {/* Price Column */}
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1 truncate">
            <span className="text-xs sm:text-sm font-black text-slate-900 shrink-0">
              ₹{product.price}
            </span>
            {product.originalPrice && (
              <span className="text-[10px] text-slate-400 line-through shrink-0">
                ₹{product.originalPrice}
              </span>
            )}
          </div>
          <div className="text-[9px] text-emerald-700 font-bold truncate">
            {product.stockCount > 0 ? `${product.stockCount} in stock` : 'Out of stock'}
          </div>
        </div>

        {/* Bounded Non-Overflowing ADD / Quantity Counter Button */}
        <div className="shrink-0">
          {quantityInCart === 0 ? (
            <button
              id={`add-btn-${product.id}`}
              onClick={() => onAddToCart(product, 1)}
              className="bg-white border-2 border-emerald-600 hover:bg-emerald-50 active:bg-emerald-100 text-emerald-700 font-black text-xs uppercase px-3.5 py-1.5 rounded-lg shadow-2xs transition flex items-center justify-center cursor-pointer min-w-[64px] select-none"
            >
              <span>ADD</span>
            </button>
          ) : (
            <div className="bg-emerald-700 text-white rounded-lg px-1.5 py-1 flex items-center justify-between gap-1 shadow-2xs font-bold text-xs min-w-[74px] max-w-[80px] select-none">
              <button
                onClick={() => onUpdateCartQty(product.id, -1)}
                className="w-5 h-5 flex items-center justify-center hover:bg-emerald-800 active:bg-emerald-900 rounded transition cursor-pointer shrink-0"
                title="Decrease quantity"
              >
                <Minus className="w-3 h-3 stroke-[3]" />
              </button>
              <span className="font-mono text-xs font-black w-4 text-center shrink-0">{quantityInCart}</span>
              <button
                onClick={() => onUpdateCartQty(product.id, 1)}
                className="w-5 h-5 flex items-center justify-center hover:bg-emerald-800 active:bg-emerald-900 rounded transition cursor-pointer shrink-0"
                title="Increase quantity"
              >
                <Plus className="w-3 h-3 stroke-[3]" />
              </button>
            </div>
          )}
        </div>

      </div>

    </div>
  );
};
