import React from 'react';
import { Search } from 'lucide-react';
import { HardwareProduct } from '../types';

interface SearchSuggestionsProps {
  query: string;
  products: HardwareProduct[];
  onSelectSuggestion: (query: string) => void;
}

export const SearchSuggestions: React.FC<SearchSuggestionsProps> = ({ query, products, onSelectSuggestion }) => {
  if (!query || query.length < 2) return null;

  const lowerQuery = query.toLowerCase();
  
  // Find matching brands
  const matchingBrands = Array.from(new Set(
    products
      .filter(p => p.specs.brand && p.specs.brand.toLowerCase().includes(lowerQuery))
      .map(p => p.specs.brand)
  )).slice(0, 1);

  // Find matching products
  const matchingProducts = products
    .filter(p => p.name.toLowerCase().includes(lowerQuery))
    .slice(0, 3);
    
  // Find matching categories/subcategories
  const matchingCategories = Array.from(new Set(
    products
      .filter(p => p.subcategory.toLowerCase().includes(lowerQuery) || p.category.toLowerCase().includes(lowerQuery))
      .map(p => p.subcategory)
  )).slice(0, 1);

  const totalSuggestions = matchingBrands.length + matchingProducts.length + matchingCategories.length;
  if (totalSuggestions === 0) return null;

  return (
    <div className="bg-white rounded-2xl p-3 shadow-xs border border-slate-200/80 mb-4">
      <div className="space-y-2.5">
        {matchingBrands.map((brand: any) => (
          <div 
            key={`brand-${brand}`} 
            className="flex items-center gap-3 cursor-pointer group"
            onClick={() => onSelectSuggestion(brand)}
          >
            <div className="w-10 h-10 bg-white rounded-lg flex items-center justify-center border border-slate-200 shadow-sm overflow-hidden shrink-0">
               {/* generic brand icon / text if no logo */}
               <span className="text-[10px] font-black text-slate-700">{brand.substring(0, 4)}</span>
            </div>
            <span className="text-sm font-medium text-slate-800 group-hover:text-emerald-700 transition">{brand}</span>
          </div>
        ))}

        {matchingProducts.map(p => (
          <div 
            key={`prod-${p.id}`} 
            className="flex items-center gap-3 cursor-pointer group"
            onClick={() => onSelectSuggestion(p.name)}
          >
            <div className="w-10 h-10 bg-white rounded-lg flex items-center justify-center border border-slate-200 shadow-sm overflow-hidden shrink-0">
               {p.imageUrl ? (
                 <img src={p.imageUrl} alt={p.name} className="w-full h-full object-cover" />
               ) : (
                 <Search className="w-4 h-4 text-slate-400" />
               )}
            </div>
            <span className="text-sm font-medium text-slate-800 group-hover:text-emerald-700 transition line-clamp-1">{p.name}</span>
          </div>
        ))}
        
        {matchingCategories.map((cat: any) => (
          <div 
            key={`cat-${cat}`} 
            className="flex items-center gap-3 cursor-pointer group"
            onClick={() => onSelectSuggestion(cat)}
          >
            <div className="w-10 h-10 bg-white rounded-full flex items-center justify-center border border-slate-200 shadow-sm shrink-0">
               <Search className="w-4 h-4 text-slate-500" />
            </div>
            <span className="text-sm font-medium text-slate-800 group-hover:text-emerald-700 transition">{cat}</span>
          </div>
        ))}
      </div>
    </div>
  );
};
