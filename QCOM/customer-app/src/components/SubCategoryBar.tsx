import React from 'react';
import { getMainCategoryConfig } from '../data/categories';
import { TradeCategory, HardwareProduct } from '../types';

interface SubCategoryBarProps {
  selectedCategory: TradeCategory;
  selectedSubCategory: string;
  onSelectSubCategory: (subId: string) => void;
  products?: HardwareProduct[];
  className?: string;
}

export const SubCategoryBar: React.FC<SubCategoryBarProps> = ({
  selectedCategory,
  selectedSubCategory,
  onSelectSubCategory,
  products = [],
  className = ''
}) => {
  const config = getMainCategoryConfig(selectedCategory);

  // If "all" or no subcategories, do not render
  if (selectedCategory === 'all' || !config.subcategories || config.subcategories.length === 0) {
    return null;
  }

  return (
    <div className={`w-full overflow-hidden select-none ${className}`}>
      {/* Subcategory Pills Container */}
      <div className="flex items-center gap-1.5 sm:gap-2 overflow-x-auto pb-1 scrollbar-none pt-0.5">
        {config.subcategories.map((sub) => {
          const isSelected = selectedSubCategory === sub.id;
          const Icon = sub.icon;

          // Compute matching count
          const count = products.filter(p => {
            if (sub.filterFn) {
              return sub.filterFn(p);
            }
            return config.productCategories.includes(p.category);
          }).length;

          return (
            <button
              key={sub.id}
              onClick={() => onSelectSubCategory(sub.id)}
              className={`flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 sm:px-3.5 sm:py-2 rounded-xl text-xs sm:text-sm font-bold transition-all duration-150 cursor-pointer active:scale-95 border ${
                isSelected
                  ? 'bg-slate-950 text-white border-slate-950 shadow-xs'
                  : 'bg-white/90 hover:bg-white text-slate-700 hover:text-slate-950 border-slate-200/80 hover:border-slate-300'
              }`}
            >
              {Icon && (
                <Icon 
                  className={`w-3.5 h-3.5 sm:w-4 sm:h-4 stroke-[2.2] ${
                    isSelected ? 'text-amber-300' : 'text-slate-500'
                  }`} 
                />
              )}
              <span className="whitespace-nowrap leading-none">{sub.label}</span>
              {count > 0 && (
                <span 
                  className={`ml-0.5 text-[10px] sm:text-[11px] font-mono px-1.5 py-0.5 rounded-full ${
                    isSelected 
                      ? 'bg-white/20 text-white font-bold' 
                      : 'bg-slate-100 text-slate-500 font-semibold'
                  }`}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
};
