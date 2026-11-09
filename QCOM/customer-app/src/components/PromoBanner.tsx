import React from 'react';
import { 
  ChevronRight
} from 'lucide-react';
import { TradeCategory } from '../types';

interface PromoBannerProps {
  onOpenAiScanner: () => void;
  onOpenRoiCalc: () => void;
  onSelectCategory: (cat: TradeCategory) => void;
  onOpenProfileModal?: () => void;
  deliveryEtaMins?: number;
}

export const PromoBanner: React.FC<PromoBannerProps> = ({
  onOpenAiScanner,
  onOpenRoiCalc,
  onSelectCategory,
  onOpenProfileModal,
  deliveryEtaMins = 11,
}) => {
  return (
    <div className="w-full space-y-4">
      
      {/* ================= BENTO 1: MIX, FIX & REPAIR (Direct match to Reference Image 3) ================= */}
      <div className="relative overflow-hidden rounded-2xl sm:rounded-3xl bg-gradient-to-br from-[#e0effe] via-[#eaf4ff] to-[#d6ebff] border border-sky-200 p-3.5 sm:p-5 md:p-6 shadow-xs">
        
        {/* Banner Top Header with floating collage */}
        <div className="flex items-center justify-between mb-3">
          <div className="space-y-0.5 max-w-lg">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="bg-sky-900 text-white text-[9px] sm:text-[10px] font-black uppercase tracking-wider px-2 sm:px-2.5 py-0.5 rounded-full">
                ⚡ DYNAMIC ETA DISPATCH ({deliveryEtaMins} MINS)
              </span>
            </div>
            <h2 className="text-lg sm:text-xl md:text-2xl font-black text-slate-900 tracking-tight">
              MIX, FIX & REPAIR 🛠️
            </h2>
            <p className="text-[11px] sm:text-xs text-slate-600 font-semibold leading-relaxed">
              Emergency valves, MCBs, solvents & drill bits directly to your delivery address.
            </p>
          </div>

          {/* Decorative Floating Hardware Collage Icon Badge */}
          <div className="hidden sm:flex items-center gap-1.5 bg-white/80 backdrop-blur-xs p-1.5 sm:p-2 rounded-2xl border border-sky-200/80 shadow-2xs shrink-0">
            <img 
              src="https://images.unsplash.com/photo-1585338107529-13afc5f02586?w=100&auto=format&fit=crop&q=80" 
              alt="Valve"
              className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg object-cover"
            />
            <img 
              src="https://images.unsplash.com/photo-1558494949-ef010cbdcc31?w=100&auto=format&fit=crop&q=80" 
              alt="MCB"
              className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg object-cover"
            />
          </div>
        </div>

        {/* 4 Quadrant Visual Product Tiles (Exact Match to Image 3) */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
          
          {/* Tile 1: Angle Valves */}
          <div 
            onClick={() => onSelectCategory('plumbing')}
            className="bg-white rounded-xl sm:rounded-2xl p-2.5 sm:p-3 shadow-2xs border border-sky-100 flex flex-col justify-between hover:shadow-md hover:border-sky-300 transition cursor-pointer group"
          >
            <div>
              <div className="text-[11px] sm:text-xs font-black text-slate-900 leading-tight truncate">Fast Angle Valves</div>
              <div className="text-[9px] sm:text-[10px] font-bold text-slate-400 uppercase tracking-tight truncate">Supreme / Jaquar</div>
            </div>
            <div className="my-1.5 sm:my-2 h-16 sm:h-20 w-full rounded-lg sm:rounded-xl overflow-hidden bg-slate-50 flex items-center justify-center">
              <img 
                src="https://images.unsplash.com/photo-1585338107529-13afc5f02586?w=400&auto=format&fit=crop&q=80" 
                alt="Angle Valve"
                referrerPolicy="no-referrer"
                className="h-full w-full object-cover group-hover:scale-108 transition duration-300"
              />
            </div>
            <div className="bg-sky-50 text-sky-800 text-[9px] sm:text-[10px] font-black px-1.5 py-0.5 sm:py-1 rounded-md sm:rounded-lg text-center truncate">
              Starts at ₹185
            </div>
          </div>

          {/* Tile 2: MCBs & Wires */}
          <div 
            onClick={() => onSelectCategory('electrical')}
            className="bg-white rounded-xl sm:rounded-2xl p-2.5 sm:p-3 shadow-2xs border border-sky-100 flex flex-col justify-between hover:shadow-md hover:border-sky-300 transition cursor-pointer group"
          >
            <div>
              <div className="text-[11px] sm:text-xs font-black text-slate-900 leading-tight truncate">C-Curve MCBs</div>
              <div className="text-[9px] sm:text-[10px] font-bold text-slate-400 uppercase tracking-tight truncate">Havells / Polycab</div>
            </div>
            <div className="my-1.5 sm:my-2 h-16 sm:h-20 w-full rounded-lg sm:rounded-xl overflow-hidden bg-slate-50 flex items-center justify-center">
              <img 
                src="https://images.unsplash.com/photo-1558494949-ef010cbdcc31?w=400&auto=format&fit=crop&q=80" 
                alt="MCB"
                referrerPolicy="no-referrer"
                className="h-full w-full object-cover group-hover:scale-108 transition duration-300"
              />
            </div>
            <div className="bg-amber-50 text-amber-900 text-[9px] sm:text-[10px] font-black px-1.5 py-0.5 sm:py-1 rounded-md sm:rounded-lg text-center truncate">
              Starts at ₹195
            </div>
          </div>

          {/* Tile 3: Fasteners */}
          <div 
            onClick={() => onSelectCategory('fasteners')}
            className="bg-white rounded-xl sm:rounded-2xl p-2.5 sm:p-3 shadow-2xs border border-sky-100 flex flex-col justify-between hover:shadow-md hover:border-sky-300 transition cursor-pointer group"
          >
            <div>
              <div className="text-[11px] sm:text-xs font-black text-slate-900 leading-tight truncate">Wall Plugs & Screws</div>
              <div className="text-[9px] sm:text-[10px] font-bold text-slate-400 uppercase tracking-tight truncate">Fischer / Drywall</div>
            </div>
            <div className="my-1.5 sm:my-2 h-16 sm:h-20 w-full rounded-lg sm:rounded-xl overflow-hidden bg-slate-50 flex items-center justify-center">
              <img 
                src="https://images.unsplash.com/photo-1530124566582-a618bc2615dc?w=400&auto=format&fit=crop&q=80" 
                alt="Fasteners"
                referrerPolicy="no-referrer"
                className="h-full w-full object-cover group-hover:scale-108 transition duration-300"
              />
            </div>
            <div className="bg-emerald-50 text-emerald-800 text-[9px] sm:text-[10px] font-black px-1.5 py-0.5 sm:py-1 rounded-md sm:rounded-lg text-center truncate">
              Up to 35% OFF
            </div>
          </div>

          {/* Tile 4: Solvents & Glue */}
          <div 
            onClick={() => onSelectCategory('adhesives')}
            className="bg-white rounded-xl sm:rounded-2xl p-2.5 sm:p-3 shadow-2xs border border-sky-100 flex flex-col justify-between hover:shadow-md hover:border-sky-300 transition cursor-pointer group"
          >
            <div>
              <div className="text-[11px] sm:text-xs font-black text-slate-900 leading-tight truncate">Solvents & M-Seal</div>
              <div className="text-[9px] sm:text-[10px] font-bold text-slate-400 uppercase tracking-tight truncate">Astral / Pidilite</div>
            </div>
            <div className="my-1.5 sm:my-2 h-16 sm:h-20 w-full rounded-lg sm:rounded-xl overflow-hidden bg-slate-50 flex items-center justify-center">
              <img 
                src="https://images.unsplash.com/photo-1616401784845-180882ba9ba8?w=400&auto=format&fit=crop&q=80" 
                alt="Adhesives"
                referrerPolicy="no-referrer"
                className="h-full w-full object-cover group-hover:scale-108 transition duration-300"
              />
            </div>
            <div className="bg-rose-50 text-rose-800 text-[9px] sm:text-[10px] font-black px-1.5 py-0.5 sm:py-1 rounded-md sm:rounded-lg text-center truncate">
              Starts at ₹35
            </div>
          </div>

        </div>

        {/* Footer Link (Image 3) */}
        <div className="mt-3 pt-2 flex items-center justify-between border-t border-sky-200/60 text-xs">
          <button
            onClick={() => onSelectCategory('all')}
            className="font-black text-sky-900 hover:text-sky-950 flex items-center gap-1 cursor-pointer group text-[11px] sm:text-xs"
          >
            <span>See all 500+ rescue parts</span>
            <ChevronRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition" />
          </button>

          <span className="text-[10px] sm:text-[11px] font-bold text-sky-800">
            ⚡ Avg delivery time: {deliveryEtaMins} mins
          </span>
        </div>

      </div>

    </div>
  );
};
