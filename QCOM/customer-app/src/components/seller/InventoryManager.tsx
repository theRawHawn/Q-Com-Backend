import React, { useState } from 'react';
import { 
  Search, 
  Plus, 
  Minus, 
  Filter, 
  AlertTriangle, 
  Boxes, 
  Edit3, 
  Check, 
  Tag,
  Sparkles,
  ArrowUpDown
} from 'lucide-react';
import { HardwareProduct, TradeCategory } from '../../types';

interface InventoryManagerProps {
  products: HardwareProduct[];
  onUpdateStock: (productId: string, newStock: number) => void;
  onUpdatePrice: (productId: string, newPrice: number) => void;
  onUpdateGstRate?: (productId: string, newGstRate: number) => void;
  onOpenAddModal: () => void;
}

export const InventoryManager: React.FC<InventoryManagerProps> = ({
  products,
  onUpdateStock,
  onUpdatePrice,
  onUpdateGstRate,
  onOpenAddModal,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<TradeCategory | 'all'>('all');
  const [editingPriceId, setEditingPriceId] = useState<string | null>(null);
  const [tempPrice, setTempPrice] = useState<number>(0);

  // Filter products
  const filteredProducts = products.filter(product => {
    const matchesCategory = selectedCategory === 'all' || product.category === selectedCategory;
    const matchesQuery = searchQuery === '' || 
      product.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      product.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
      product.specs.brand.toLowerCase().includes(searchQuery.toLowerCase()) ||
      product.binLocation.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesCategory && matchesQuery;
  });

  const lowStockProducts = products.filter(p => p.stockCount < 25);

  return (
    <div className="space-y-4">
      
      {/* Top Banner & Quick Metrics */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-2xs flex items-center justify-between">
          <div>
            <div className="text-[11px] text-slate-500 font-bold uppercase">Total Catalog SKUs</div>
            <div className="text-xl font-black text-slate-900 mt-0.5">{products.length} Active Parts</div>
          </div>
          <div className="w-10 h-10 rounded-xl bg-emerald-50 text-emerald-700 flex items-center justify-center font-bold">
            <Boxes className="w-5 h-5" />
          </div>
        </div>

        <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-2xs flex items-center justify-between">
          <div>
            <div className="text-[11px] text-slate-500 font-bold uppercase">Low Stock Alerts</div>
            <div className="text-xl font-black text-amber-600 mt-0.5">{lowStockProducts.length} SKUs &lt; 25 units</div>
          </div>
          <div className="w-10 h-10 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center font-bold">
            <AlertTriangle className="w-5 h-5" />
          </div>
        </div>

        <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-2xs flex items-center justify-between">
          <div>
            <div className="text-[11px] text-slate-500 font-bold uppercase">Total Stock on Shelves</div>
            <div className="text-xl font-black text-slate-900 mt-0.5">
              {products.reduce((s, p) => s + p.stockCount, 0)} Units
            </div>
          </div>
          <button
            onClick={onOpenAddModal}
            className="bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-xs px-3 py-2 rounded-xl transition cursor-pointer flex items-center gap-1 shadow-2xs"
          >
            <Plus className="w-4 h-4" />
            <span>+ Add SKU</span>
          </button>
        </div>
      </div>

      {/* Search & Filters */}
      <div className="bg-white p-3.5 rounded-2xl border border-slate-200 shadow-2xs flex flex-wrap items-center justify-between gap-3">
        
        {/* Search */}
        <div className="relative flex-1 min-w-[240px]">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search SKU code, part title, brand, or aisle bin..."
            className="w-full bg-slate-50 border border-slate-200 rounded-xl pl-9 pr-3 py-2 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
          />
        </div>

        {/* Category Pills */}
        <div className="flex items-center gap-1.5 overflow-x-auto text-xs font-bold scrollbar-none">
          {(['all', 'plumbing', 'electrical', 'fasteners', 'adhesives', 'tools', 'carpentry', 'safety'] as const).map(cat => (
            <button
              key={cat}
              onClick={() => setSelectedCategory(cat)}
              className={`px-3 py-1.5 rounded-xl capitalize transition cursor-pointer whitespace-nowrap ${
                selectedCategory === cat
                  ? 'bg-slate-900 text-white'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              {cat}
            </button>
          ))}
        </div>

      </div>

      {/* Inventory Table */}
      <div className="bg-white rounded-3xl border border-slate-200 shadow-2xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs text-slate-700">
            <thead className="bg-slate-50 text-[10px] uppercase font-black tracking-wider text-slate-400 border-b border-slate-200">
              <tr>
                <th className="py-3 px-4">SKU / Item</th>
                <th className="py-3 px-4">Trade Category</th>
                <th className="py-3 px-4">Aisle & Bay</th>
                <th className="py-3 px-4">GST Slab</th>
                <th className="py-3 px-4">Selling Price (₹)</th>
                <th className="py-3 px-4">Dark Store Stock</th>
                <th className="py-3 px-4 text-right">Stock Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-medium">
              {filteredProducts.map((product) => {
                const isLow = product.stockCount < 25;
                const isOut = product.stockCount === 0;
                const currentGst = typeof product.gstRatePercent === 'number' ? product.gstRatePercent : 18;

                return (
                  <tr key={product.id} className="hover:bg-slate-50/70 transition">
                    
                    {/* Item */}
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-3">
                        {product.imageUrl ? (
                          <img 
                            src={product.imageUrl} 
                            alt={product.name}
                            referrerPolicy="no-referrer"
                            className="w-10 h-10 rounded-xl object-cover border border-slate-200 shrink-0" 
                          />
                        ) : (
                          <div className="w-10 h-10 rounded-xl bg-slate-100 border border-slate-200 flex items-center justify-center font-bold text-slate-500 shrink-0">
                            {product.name[0]}
                          </div>
                        )}
                        <div>
                          <div className="font-bold text-slate-900 leading-snug">{product.name}</div>
                          <div className="text-[10px] text-slate-400 font-mono mt-0.5 flex items-center gap-2">
                            <span>ID: {product.id}</span>
                            <span>•</span>
                            <span className="font-bold text-slate-600">{product.specs.brand}</span>
                            <span>•</span>
                            <span>{product.specs.size || product.specs.standard}</span>
                          </div>
                        </div>
                      </div>
                    </td>

                    {/* Category */}
                    <td className="py-3 px-4">
                      <span className="bg-slate-100 text-slate-700 text-[10px] font-bold px-2 py-0.5 rounded capitalize">
                        {product.category}
                      </span>
                    </td>

                    {/* Bin Location */}
                    <td className="py-3 px-4">
                      <span className="font-mono text-emerald-800 font-black bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded text-[11px]">
                        {product.binLocation}
                      </span>
                    </td>

                    {/* GST Rate Selector */}
                    <td className="py-3 px-4">
                      <select
                        value={currentGst}
                        onChange={(e) => {
                          const newRate = Number(e.target.value);
                          if (onUpdateGstRate) {
                            onUpdateGstRate(product.id, newRate);
                          }
                        }}
                        className={`text-[11px] font-black rounded-lg px-2 py-1 border transition cursor-pointer ${
                          currentGst === 18 
                            ? 'bg-sky-50 text-sky-800 border-sky-200' 
                            : currentGst === 5 
                            ? 'bg-emerald-50 text-emerald-800 border-emerald-200' 
                            : currentGst === 12 
                            ? 'bg-indigo-50 text-indigo-800 border-indigo-200'
                            : currentGst === 28 
                            ? 'bg-amber-50 text-amber-900 border-amber-200'
                            : 'bg-slate-100 text-slate-700 border-slate-200'
                        }`}
                        title="Change Product GST Tax Rate Slab"
                      >
                        <option value={18}>18% GST (Standard)</option>
                        <option value={5}>5% GST (Basic)</option>
                        <option value={12}>12% GST (Parts)</option>
                        <option value={28}>28% GST (Luxury)</option>
                        <option value={0}>0% GST (Exempt)</option>
                      </select>
                    </td>

                    {/* Price */}
                    <td className="py-3 px-4">
                      {editingPriceId === product.id ? (
                        <div className="flex items-center gap-1">
                          <span className="font-bold text-slate-900">₹</span>
                          <input 
                            type="number"
                            value={tempPrice}
                            onChange={(e) => setTempPrice(Number(e.target.value))}
                            className="w-16 bg-white border border-emerald-500 rounded p-1 text-xs font-bold"
                          />
                          <button
                            onClick={() => {
                              onUpdatePrice(product.id, tempPrice);
                              setEditingPriceId(null);
                            }}
                            className="p-1 bg-emerald-700 text-white rounded hover:bg-emerald-800 cursor-pointer"
                          >
                            <Check className="w-3 h-3" />
                          </button>
                        </div>
                      ) : (
                        <div 
                          onClick={() => {
                            setEditingPriceId(product.id);
                            setTempPrice(product.price);
                          }}
                          className="font-black text-slate-900 cursor-pointer hover:text-emerald-700 flex items-center gap-1 group"
                          title="Click to edit price"
                        >
                          <span>₹{product.price}</span>
                          <Edit3 className="w-3 h-3 text-slate-300 group-hover:text-emerald-700 opacity-0 group-hover:opacity-100 transition" />
                        </div>
                      )}
                    </td>

                    {/* Stock Count */}
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-2">
                        <span className={`font-black text-xs ${
                          isOut ? 'text-rose-600' : isLow ? 'text-amber-600' : 'text-slate-900'
                        }`}>
                          {product.stockCount} units
                        </span>
                        {isLow && !isOut && (
                          <span className="text-[9px] bg-amber-100 text-amber-800 font-black px-1.5 py-0.2 rounded">
                            LOW
                          </span>
                        )}
                        {isOut && (
                          <span className="text-[9px] bg-rose-100 text-rose-800 font-black px-1.5 py-0.2 rounded">
                            OUT OF STOCK
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Stock Adjustment Controls */}
                    <td className="py-3 px-4 text-right">
                      <div className="inline-flex items-center gap-1 bg-slate-100 p-1 rounded-xl">
                        <button
                          onClick={() => onUpdateStock(product.id, Math.max(0, product.stockCount - 10))}
                          title="Decrease 10 units"
                          className="px-2 py-1 bg-white hover:bg-slate-200 rounded-lg text-slate-700 font-bold text-[10px] cursor-pointer transition shadow-2xs"
                        >
                          -10
                        </button>
                        <button
                          onClick={() => onUpdateStock(product.id, Math.max(0, product.stockCount - 1))}
                          title="Decrease 1 unit"
                          className="w-6 h-6 flex items-center justify-center bg-white hover:bg-slate-200 rounded-lg text-slate-700 font-bold text-xs cursor-pointer transition shadow-2xs"
                        >
                          <Minus className="w-3 h-3" />
                        </button>
                        <button
                          onClick={() => onUpdateStock(product.id, product.stockCount + 1)}
                          title="Add 1 unit"
                          className="w-6 h-6 flex items-center justify-center bg-white hover:bg-slate-200 rounded-lg text-slate-700 font-bold text-xs cursor-pointer transition shadow-2xs"
                        >
                          <Plus className="w-3 h-3" />
                        </button>
                        <button
                          onClick={() => onUpdateStock(product.id, product.stockCount + 25)}
                          title="Restock 25 units"
                          className="px-2 py-1 bg-emerald-700 hover:bg-emerald-800 text-white rounded-lg font-bold text-[10px] cursor-pointer transition shadow-2xs"
                        >
                          +25
                        </button>
                      </div>
                    </td>

                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

    </div>
  );
};
