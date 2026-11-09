import React from 'react';
import { 
  X
} from 'lucide-react';
import { MAIN_CATEGORIES } from '../data/categories';
import { TradeCategory } from '../types';

interface CategoryChipsProps {
  selectedCategory: TradeCategory;
  onSelectCategory: (category: TradeCategory) => void;
  onOpenRestock?: () => void;
  onOpenAiScanner?: () => void;
  isGstFilterActive?: boolean;
  onToggleGstFilter?: () => void;
}

export const CategoryChips: React.FC<CategoryChipsProps> = ({
  selectedCategory,
  onSelectCategory,
}) => {
  return (
    <div 
      className="relative w-full border-b border-amber-300/60 pb-1.5 pt-0.5 shadow-xs overflow-hidden select-none"
      style={{
        background: 'linear-gradient(180deg, #FBD050 0%, #FDE074 45%, #FEF1A9 80%, #FFF9D6 100%)',
      }}
    >
      {/* Soft Bokeh / Ambient Light Glow Highlights */}
      <div 
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{
          backgroundImage: `
            radial-gradient(circle at 12% 20%, rgba(255, 255, 255, 0.55) 0%, transparent 35%),
            radial-gradient(circle at 55% 85%, rgba(255, 255, 255, 0.4) 0%, transparent 40%),
            radial-gradient(circle at 88% 30%, rgba(255, 255, 255, 0.5) 0%, transparent 35%),
            radial-gradient(circle at 70% 10%, rgba(245, 158, 11, 0.2) 0%, transparent 45%)
          `
        }}
      />

      <div className="relative max-w-7xl mx-auto px-2 sm:px-4 md:px-6">
        {/* Compact Horizontal Category Carousel with reduced gaps & graphics-only */}
        <div className="flex items-center gap-1.5 sm:gap-2 md:gap-3 overflow-x-auto py-1 scrollbar-none">
          {MAIN_CATEGORIES.map((cat) => {
            const isSelected = selectedCategory === cat.id;
            const Icon = cat.icon;

            return (
              <button
                key={cat.id}
                onClick={() => {
                  if (isSelected && cat.id !== 'all') {
                    onSelectCategory('all');
                  } else {
                    onSelectCategory(cat.id);
                  }
                }}
                className="flex-shrink-0 flex flex-col items-center justify-between min-w-[56px] sm:min-w-[66px] px-1.5 py-0.5 cursor-pointer group focus:outline-none transition-transform active:scale-95 relative"
              >
                {/* Pure Graphic / Icon (No Background Box!) */}
                <div className="relative flex items-center justify-center h-8 sm:h-9 w-8 sm:w-9 mb-1">
                  <Icon 
                    className={`transition-all duration-150 ${
                      isSelected 
                        ? 'w-6 h-6 sm:w-7 sm:h-7 text-slate-950 stroke-[2.4] drop-shadow-xs' 
                        : 'w-5 h-5 sm:w-6 sm:h-6 text-slate-800/90 group-hover:text-slate-950 stroke-[1.9] group-hover:scale-105'
                    }`} 
                  />

                  {/* ✕ Clear Filter Badge on active item if specific category is filtered */}
                  {isSelected && cat.id !== 'all' && (
                    <div
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectCategory('all');
                      }}
                      className="absolute -top-1 -right-1.5 w-4 h-4 bg-slate-950 text-white hover:bg-rose-600 rounded-full flex items-center justify-center shadow-xs border border-white transition cursor-pointer"
                      title="Clear category filter"
                    >
                      <X className="w-2.5 h-2.5 stroke-[3]" />
                    </div>
                  )}
                </div>

                {/* Main Category Label */}
                <span 
                  className={`text-[11px] sm:text-[12px] leading-tight tracking-tight text-center whitespace-nowrap transition-colors ${
                    isSelected 
                      ? 'text-slate-950 font-black' 
                      : 'text-slate-800 font-semibold group-hover:text-slate-950'
                  }`}
                >
                  {cat.label}
                </span>

                {/* Bottom Indicator Bar under selected item */}
                <div 
                  className={`h-[3px] rounded-full transition-all duration-200 mt-1 ${
                    isSelected 
                      ? 'w-7 sm:w-9 bg-slate-950 shadow-xs' 
                      : 'w-0 bg-transparent'
                  }`}
                />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};
