import React from 'react';
import { NON_FOOD_GROCERY_CATEGORIES } from '../../types/admin';
import { Check } from 'lucide-react';

interface StoreCategorySelectorProps {
  selectedCategories: string[];
  onChange: (categories: string[]) => void;
}

export const StoreCategorySelector: React.FC<StoreCategorySelectorProps> = ({
  selectedCategories = [],
  onChange,
}) => {
  const toggleCategory = (cat: string) => {
    if (selectedCategories.includes(cat)) {
      onChange(selectedCategories.filter((c) => c !== cat));
    } else {
      onChange([...selectedCategories, cat]);
    }
  };

  const selectAll = () => {
    onChange([...NON_FOOD_GROCERY_CATEGORIES]);
  };

  const clearAll = () => {
    onChange([]);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>Select all product domains this merchant is authorized to retail:</span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={selectAll}
            className="text-primary hover:underline font-medium"
          >
            Select All
          </button>
          <span>•</span>
          <button
            type="button"
            onClick={clearAll}
            className="text-slate-500 hover:underline font-medium"
          >
            Clear All
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-48 overflow-y-auto p-2 bg-slate-50 rounded-lg border border-slate-200">
        {NON_FOOD_GROCERY_CATEGORIES.map((cat) => {
          const isSelected = selectedCategories.includes(cat);
          return (
            <label
              key={cat}
              onClick={() => toggleCategory(cat)}
              className={`flex items-center gap-2.5 p-2 rounded-md cursor-pointer text-xs font-medium transition-all ${
                isSelected
                  ? 'bg-primary/10 text-primary border border-primary/30 font-semibold'
                  : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-100'
              }`}
            >
              <div
                className={`w-4 h-4 rounded flex items-center justify-center border transition-colors ${
                  isSelected
                    ? 'bg-primary border-primary text-white'
                    : 'border-slate-300 bg-white'
                }`}
              >
                {isSelected && <Check className="w-3 h-3 stroke-[3]" />}
              </div>
              <span className="truncate">{cat}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
};
