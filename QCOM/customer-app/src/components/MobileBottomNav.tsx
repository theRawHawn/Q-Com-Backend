import React from 'react';
import { Home, Grid, RotateCcw, ShoppingBag } from 'lucide-react';
import { TradeCategory } from '../types';

interface MobileBottomNavProps {
  currentCategory: TradeCategory;
  onSelectCategory: (cat: TradeCategory) => void;
  onOpenRestock?: () => void;
  onOpenProfile?: () => void;
  onOpenCart: () => void;
  cartCount: number;
}

export const MobileBottomNav: React.FC<MobileBottomNavProps> = ({
  currentCategory,
  onSelectCategory,
  onOpenRestock,
  onOpenCart,
  cartCount
}) => {
  return (
    <div className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-white border-t border-slate-200/90 py-1.5 sm:py-2 px-2 sm:px-3 shadow-[0_-4px_20px_rgba(0,0,0,0.08)] select-none">
      <div className="flex items-center justify-around max-w-md mx-auto">
        
        {/* Home */}
        <button
          onClick={() => onSelectCategory('all')}
          className={`flex flex-col items-center gap-0.5 px-3 py-1 text-center cursor-pointer transition ${
            currentCategory === 'all' ? 'text-emerald-700 font-extrabold' : 'text-slate-500 hover:text-slate-900 font-medium'
          }`}
        >
          <Home className="w-5 h-5" />
          <span className="text-[10px]">Home</span>
        </button>

        {/* Categories */}
        <button
          onClick={() => onSelectCategory('plumbing')}
          className={`flex flex-col items-center gap-0.5 px-3 py-1 text-center cursor-pointer transition ${
            currentCategory !== 'all' ? 'text-emerald-700 font-extrabold' : 'text-slate-500 hover:text-slate-900 font-medium'
          }`}
        >
          <Grid className="w-5 h-5" />
          <span className="text-[10px]">Categories</span>
        </button>

        {/* Reorder */}
        <button
          onClick={onOpenRestock}
          className="flex flex-col items-center gap-0.5 px-3 py-1 text-center text-slate-500 hover:text-slate-900 font-medium cursor-pointer transition"
        >
          <RotateCcw className="w-5 h-5" />
          <span className="text-[10px]">Reorder</span>
        </button>

        {/* Cart */}
        <button
          onClick={onOpenCart}
          className="relative flex flex-col items-center gap-0.5 px-3 py-1 text-center text-emerald-700 hover:text-emerald-800 font-black cursor-pointer transition"
        >
          <div className="relative">
            <ShoppingBag className="w-5 h-5" />
            {cartCount > 0 && (
              <span className="absolute -top-1.5 -right-2 bg-emerald-700 text-white text-[9px] font-black w-4.5 h-4.5 rounded-full flex items-center justify-center border-2 border-white shadow-2xs">
                {cartCount}
              </span>
            )}
          </div>
          <span className="text-[10px]">Cart</span>
        </button>

      </div>
    </div>
  );
};
