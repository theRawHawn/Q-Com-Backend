import React from 'react';
import { ChevronRight } from 'lucide-react';
import { HardwareProduct, TradeCategory } from '../types';
import { ProductCard } from './ProductCard';
import { Coordinates } from '../utils/deliveryEta';

interface ProductShelfProps {
  title: string;
  subtitle?: string;
  badge?: string;
  category?: TradeCategory;
  products: HardwareProduct[];
  cart: { product: HardwareProduct; quantity: number }[];
  onAddToCart: (product: HardwareProduct, qty?: number) => void;
  onUpdateCartQty: (productId: string, delta: number) => void;
  onOpenDetail: (product: HardwareProduct) => void;
  onSeeAll?: (category: TradeCategory) => void;
  deliveryEtaMins?: number;
  destinationCoords?: Coordinates;
}

export const ProductShelf: React.FC<ProductShelfProps> = ({
  title,
  subtitle,
  badge,
  category,
  products,
  cart,
  onAddToCart,
  onUpdateCartQty,
  onOpenDetail,
  onSeeAll,
  deliveryEtaMins,
  destinationCoords,
}) => {
  if (products.length === 0) return null;

  return (
    <section className="bg-white rounded-2xl border border-slate-200/80 p-4 sm:p-5 shadow-2xs space-y-3.5">
      
      {/* Shelf Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base sm:text-lg font-black text-slate-900 tracking-tight">
              {title}
            </h2>
          </div>
          {subtitle && (
            <p className="text-xs text-slate-500 font-medium">
              {subtitle}
            </p>
          )}
        </div>

        {category && onSeeAll && (
          <button
            onClick={() => onSeeAll(category)}
            className="text-emerald-700 hover:text-emerald-800 text-xs font-bold flex items-center gap-0.5 cursor-pointer"
          >
            <span>see all</span>
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Grid of Product Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-4 xl:grid-cols-5 gap-3 sm:gap-4">
        {products.map((product) => {
          const inCart = cart.find(i => i.product.id === product.id)?.quantity || 0;
          return (
            <ProductCard
              key={product.id}
              product={product}
              quantityInCart={inCart}
              onAddToCart={onAddToCart}
              onUpdateCartQty={onUpdateCartQty}
              onOpenDetail={onOpenDetail}
              deliveryEtaMins={deliveryEtaMins}
              destinationCoords={destinationCoords}
            />
          );
        })}
      </div>

    </section>
  );
};
