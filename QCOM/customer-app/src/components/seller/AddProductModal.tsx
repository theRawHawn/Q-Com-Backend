import React, { useState } from 'react';
import { X, Plus, Package, Layers, Tag, MapPin, Image as ImageIcon } from 'lucide-react';
import { HardwareProduct, TradeCategory } from '../../types';

interface AddProductModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAddProduct: (product: HardwareProduct) => void;
}

export const AddProductModal: React.FC<AddProductModalProps> = ({
  isOpen,
  onClose,
  onAddProduct,
}) => {
  const [formData, setFormData] = useState({
    name: '',
    category: 'plumbing' as TradeCategory,
    subcategory: 'Valves & Taps',
    price: 150,
    originalPrice: 199,
    brand: 'SupremeFit',
    size: '1/2" Standard',
    material: 'Forged Brass',
    binLocation: 'Aisle P1 • Bay 10',
    stockCount: 50,
    gstRatePercent: 18,
    deliveryTimeMins: 12,
    imageUrl: 'https://images.unsplash.com/photo-1585338107529-13afc5f02586?w=500&auto=format&fit=crop&q=80',
    description: 'High durability tradesperson grade hardware component with ISI certification for quick address replacements.',
    tags: 'hardware, fittings, replacement',
  });

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const newProduct: HardwareProduct = {
      id: `${formData.category.slice(0, 4)}-${Date.now().toString().slice(-4)}`,
      name: formData.name,
      category: formData.category,
      subcategory: formData.subcategory,
      price: Number(formData.price),
      originalPrice: Number(formData.originalPrice),
      rating: 4.9,
      reviewsCount: 1,
      specs: {
        size: formData.size,
        material: formData.material,
        brand: formData.brand,
        standard: 'ISI Certified Trade Grade',
      },
      description: formData.description,
      stockCount: Number(formData.stockCount),
      binLocation: formData.binLocation,
      gstRatePercent: Number(formData.gstRatePercent) || 18,
      isGstRegistered: true,
      itcEligible: true,
      deliveryTimeMins: Number(formData.deliveryTimeMins),
      imageUrl: formData.imageUrl || 'https://images.unsplash.com/photo-1581244277943-fe4a9c777189?w=500&auto=format&fit=crop&q=80',
      badge: 'Delivery Essential',
      tags: formData.tags.split(',').map(t => t.trim().toLowerCase()),
    };

    onAddProduct(newProduct);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs overflow-y-auto animate-in fade-in duration-200">
      <div className="bg-white border border-slate-200 rounded-3xl max-w-xl w-full p-5 sm:p-6 shadow-2xl text-slate-900 animate-in zoom-in-95 duration-200 space-y-4">
        
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-slate-100">
          <div className="flex items-center gap-2.5">
            <div className="w-10 h-10 rounded-2xl bg-emerald-100 text-emerald-800 flex items-center justify-center">
              <Package className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-black text-slate-900">
                Add New Hardware SKU
              </h2>
              <p className="text-xs text-slate-500 font-medium">
                List a new part in Koramangala Dark Store Hub #07
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-xl text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-3.5 text-xs">
          
          {/* Title */}
          <div className="space-y-1">
            <label className="font-bold text-slate-700">Product Title / Part Name:</label>
            <input
              type="text"
              required
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              placeholder="e.g. Finolex 4.0 sq mm Heavy Multi-strand Copper Wire (20m)"
              className="w-full bg-slate-50 border border-slate-200 rounded-xl p-2.5 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
            />
          </div>

          {/* Category & Subcategory */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="font-bold text-slate-700">Trade Category:</label>
              <select
                value={formData.category}
                onChange={(e) => setFormData({ ...formData, category: e.target.value as TradeCategory })}
                className="w-full bg-slate-50 border border-slate-200 rounded-xl p-2.5 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 font-medium"
              >
                <option value="lighting">Lighting & Bulbs (Tubelights, Bulbs)</option>
                <option value="fans">Fans & Regulators (Ceiling, Exhaust)</option>
                <option value="switches">Switches & Sockets (Buttons, Modular)</option>
                <option value="bathroom_fittings">Bathroom Fittings (Showers, Faucets)</option>
                <option value="kitchen_fittings">Kitchen Fittings (Sink Taps, Drainers)</option>
                <option value="plumbing">Plumbing & Pipes</option>
                <option value="electrical">Electrical & Wires</option>
                <option value="carpentry">Carpentry & Locks</option>
                <option value="screws">Screws & Anchors</option>
                <option value="cutting_discs">Cutting Discs</option>
                <option value="cutters">Cutters & Snips</option>
                <option value="adhesives">Adhesives & PU Foam</option>
                <option value="tools">Tools & Bits</option>
                <option value="safety">Safety Gear</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="font-bold text-slate-700">Subcategory / Shelf:</label>
              <input
                type="text"
                required
                value={formData.subcategory}
                onChange={(e) => setFormData({ ...formData, subcategory: e.target.value })}
                placeholder="e.g. Cables & Wires"
                className="w-full bg-slate-50 border border-slate-200 rounded-xl p-2.5 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
              />
            </div>
          </div>

          {/* Pricing & Stock & GST */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="space-y-1">
              <label className="font-bold text-slate-700 text-xs">Selling Price (₹):</label>
              <input
                type="number"
                required
                min={1}
                value={formData.price}
                onChange={(e) => setFormData({ ...formData, price: Number(e.target.value) })}
                className="w-full bg-slate-50 border border-slate-200 rounded-xl p-2.5 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 font-bold"
              />
            </div>
            <div className="space-y-1">
              <label className="font-bold text-slate-700 text-xs">MRP (₹):</label>
              <input
                type="number"
                required
                min={1}
                value={formData.originalPrice}
                onChange={(e) => setFormData({ ...formData, originalPrice: Number(e.target.value) })}
                className="w-full bg-slate-50 border border-slate-200 rounded-xl p-2.5 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
              />
            </div>
            <div className="space-y-1">
              <label className="font-bold text-slate-700 text-xs">GST Slab Rate:</label>
              <select
                value={formData.gstRatePercent}
                onChange={(e) => setFormData({ ...formData, gstRatePercent: Number(e.target.value) })}
                className="w-full bg-sky-50 border border-sky-200 rounded-xl p-2.5 text-xs text-sky-950 font-black focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500 cursor-pointer"
              >
                <option value={18}>18% GST (Standard)</option>
                <option value={5}>5% GST (Basic)</option>
                <option value={12}>12% GST (Parts)</option>
                <option value={28}>28% GST (Luxury)</option>
                <option value={0}>0% GST (Exempt)</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="font-bold text-slate-700 text-xs">Dark Store Stock:</label>
              <input
                type="number"
                required
                min={0}
                value={formData.stockCount}
                onChange={(e) => setFormData({ ...formData, stockCount: Number(e.target.value) })}
                className="w-full bg-slate-50 border border-slate-200 rounded-xl p-2.5 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 font-bold text-emerald-800"
              />
            </div>
          </div>

          {/* Brand & Bin Location */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="font-bold text-slate-700">Brand / Manufacturer:</label>
              <input
                type="text"
                required
                value={formData.brand}
                onChange={(e) => setFormData({ ...formData, brand: e.target.value })}
                placeholder="e.g. Havells / Astral / Bosch"
                className="w-full bg-slate-50 border border-slate-200 rounded-xl p-2.5 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
              />
            </div>
            <div className="space-y-1">
              <label className="font-bold text-slate-700">Aisle & Bay Location:</label>
              <input
                type="text"
                required
                value={formData.binLocation}
                onChange={(e) => setFormData({ ...formData, binLocation: e.target.value })}
                placeholder="e.g. Aisle E3 • Bay 04"
                className="w-full bg-slate-50 border border-slate-200 rounded-xl p-2.5 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 font-mono"
              />
            </div>
          </div>

          {/* Image URL */}
          <div className="space-y-1">
            <label className="font-bold text-slate-700 flex items-center gap-1">
              <ImageIcon className="w-3.5 h-3.5 text-emerald-700" />
              Product Image URL:
            </label>
            <input
              type="url"
              required
              value={formData.imageUrl}
              onChange={(e) => setFormData({ ...formData, imageUrl: e.target.value })}
              placeholder="https://images.unsplash.com/..."
              className="w-full bg-slate-50 border border-slate-200 rounded-xl p-2.5 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 font-mono"
            />
          </div>

          {/* Description */}
          <div className="space-y-1">
            <label className="font-bold text-slate-700">Description & Technical Details:</label>
            <textarea
              rows={2}
              required
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              placeholder="Describe sizes, compatibility, and jobsite usage..."
              className="w-full bg-slate-50 border border-slate-200 rounded-xl p-2.5 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 resize-none"
            />
          </div>

          {/* Submit */}
          <div className="pt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2.5 rounded-xl border border-slate-200 text-slate-600 font-bold hover:bg-slate-50 cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="bg-emerald-700 hover:bg-emerald-800 text-white font-black px-5 py-2.5 rounded-xl shadow-sm cursor-pointer flex items-center gap-1.5"
            >
              <Plus className="w-4 h-4" />
              <span>List SKU in Dark Store</span>
            </button>
          </div>

        </form>

      </div>
    </div>
  );
};
