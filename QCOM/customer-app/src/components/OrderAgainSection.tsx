import React from 'react';
import { ChevronRight, RotateCcw, Plus, Minus, Check, ShoppingBag } from 'lucide-react';
import { CustomerProfile, HardwareProduct, Order, CartItem } from '../types';

interface OrderAgainSectionProps {
  orders: Order[];
  cart: CartItem[];
  onAddToCart: (product: HardwareProduct, qty?: number) => void;
  onUpdateCartQty: (productId: string, delta: number) => void;
  onOpenDetail: (product: HardwareProduct) => void;
  customerProfile: CustomerProfile;
  deliveryEtaMins?: number;
}

export const OrderAgainSection: React.FC<OrderAgainSectionProps> = ({
  orders,
  cart,
  onAddToCart,
  onUpdateCartQty,
  onOpenDetail,
  customerProfile,
  deliveryEtaMins = 11,
}) => {
  const firstName = customerProfile.name ? customerProfile.name.split(' ')[0] : 'Trade Pro';

  // Extract unique products from all past orders (chronological order, most recent first)
  const previouslyOrderedProducts = React.useMemo(() => {
    const productsMap = new Map<string, HardwareProduct>();
    
    // Loop through orders from newest to oldest
    orders.forEach(order => {
      order.items.forEach(item => {
        if (!productsMap.has(item.product.id)) {
          productsMap.set(item.product.id, item.product);
        }
      });
    });

    return Array.from(productsMap.values()).slice(0, 8);
  }, [orders]);

  if (previouslyOrderedProducts.length === 0) {
    return null; // Don't render the section if there's no order history at all
  }

  return (
    <div className="w-full space-y-3.5 bg-white border border-slate-200/80 p-4 sm:p-5 rounded-3xl shadow-2xs">
      
      {/* Title block with sub-header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base sm:text-lg font-black text-slate-900 tracking-tight flex items-center gap-1.5">
            <span>{firstName}, order again</span>
          </h2>
          <p className="text-xs text-slate-400 font-semibold mt-0.5">
            Directly re-add materials from your past successful jobs
          </p>
        </div>
        <span className="text-[10px] font-black text-emerald-700 bg-emerald-50 border border-emerald-200/50 px-2.5 py-1 rounded-full uppercase tracking-wider">
          ⚡ {deliveryEtaMins}-Min Dispatch
        </span>
      </div>

      {/* Horizontal Sliding Shelf of actual past items */}
      <div className="flex items-stretch gap-3.5 overflow-x-auto pb-2 -mx-4 px-4 sm:mx-0 sm:px-0 no-scrollbar">
        {previouslyOrderedProducts.map((product) => {
          const cartItem = cart.find(i => i.product.id === product.id);
          const quantityInCart = cartItem?.quantity || 0;

          return (
            <div 
              key={product.id}
              className="w-[140px] sm:w-[160px] bg-slate-50 hover:bg-slate-50/80 border border-slate-200/60 hover:border-slate-300 rounded-2xl p-2.5 sm:p-3 flex flex-col justify-between shrink-0 transition shadow-2xs group"
            >
              {/* Image & Detail trigger */}
              <div 
                onClick={() => onOpenDetail(product)}
                className="cursor-pointer space-y-2"
              >
                {/* Product image with subtle zoom */}
                <div className="relative aspect-square w-full bg-white rounded-xl border border-slate-100 flex items-center justify-center overflow-hidden">
                  <img 
                    src={product.imageUrl} 
                    alt={product.name}
                    referrerPolicy="no-referrer"
                    className="w-10/12 h-10/12 object-contain group-hover:scale-105 transition duration-300"
                  />
                  {/* Category Pill Tag */}
                  <span className="absolute bottom-1 left-1 text-[8px] font-bold bg-slate-900/5 text-slate-600 px-1.5 py-0.5 rounded uppercase">
                    {product.brand || product.specs?.brand || 'Premium'}
                  </span>
                </div>

                {/* Name & specs */}
                <div className="space-y-0.5">
                  <h3 className="font-extrabold text-slate-900 text-[11px] sm:text-xs line-clamp-2 min-h-[32px] leading-tight">
                    {product.name}
                  </h3>
                  {product.specs?.size && (
                    <span className="text-[10px] text-slate-400 font-bold block">
                      Size: {product.specs.size}
                    </span>
                  )}
                </div>
              </div>

              {/* Price & Add to Cart button */}
              <div className="mt-2.5 pt-2 border-t border-slate-200/50 flex items-center justify-between gap-1">
                <span className="font-black text-slate-900 text-xs sm:text-sm shrink-0">
                  ₹{product.price}
                </span>

                {quantityInCart > 0 ? (
                  /* Standard Quantity Selector */
                  <div className="flex items-center bg-emerald-700 text-white rounded-lg p-0.5 shadow-2xs">
                    <button
                      onClick={() => onUpdateCartQty(product.id, -1)}
                      className="w-5 h-5 flex items-center justify-center hover:bg-emerald-800 rounded-md transition cursor-pointer text-xs font-black"
                    >
                      <Minus className="w-3 h-3 stroke-[3]" />
                    </button>
                    <span className="w-5 text-center text-[11px] font-black leading-none">
                      {quantityInCart}
                    </span>
                    <button
                      onClick={() => onUpdateCartQty(product.id, 1)}
                      className="w-5 h-5 flex items-center justify-center hover:bg-emerald-800 rounded-md transition cursor-pointer text-xs font-black"
                    >
                      <Plus className="w-3 h-3 stroke-[3]" />
                    </button>
                  </div>
                ) : (
                  /* Add Button */
                  <button
                    onClick={() => onAddToCart(product, 1)}
                    className="bg-white hover:bg-slate-100 text-emerald-800 border border-emerald-600/30 font-black text-[10px] sm:text-xs px-2.5 py-1 rounded-lg transition-all shadow-2xs shrink-0 cursor-pointer flex items-center gap-0.5 hover:scale-[1.02]"
                  >
                    <Plus className="w-3 h-3 text-emerald-700" />
                    <span>ADD</span>
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

    </div>
  );
};
