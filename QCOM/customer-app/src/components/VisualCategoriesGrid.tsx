import React from 'react';
import { TradeCategory } from '../types';

interface VisualCategoryTile {
  id: string;
  name: string;
  image: string;
  mainCategory: TradeCategory;
  subCategory: string;
  bgTint: string;
}

interface VisualCategoriesGridProps {
  onSelectCategory: (cat: TradeCategory, subCat: string) => void;
}

export const VisualCategoriesGrid: React.FC<VisualCategoriesGridProps> = ({
  onSelectCategory,
}) => {
  const plumbingAndElectrical: VisualCategoryTile[] = [
    {
      id: 'led-lighting',
      name: 'Lighting & Bulbs',
      image: 'https://images.unsplash.com/photo-1550985616-10810253b84d?w=200&auto=format&fit=crop&q=80',
      mainCategory: 'electrical',
      subCategory: 'lighting',
      bgTint: 'bg-[#EBF7FF] border-[#D6EDFF]'
    },
    {
      id: 'ceiling-fans',
      name: 'Fans & Regulators',
      image: 'https://images.unsplash.com/photo-1618944847023-38aa001235f0?w=200&auto=format&fit=crop&q=80',
      mainCategory: 'electrical',
      subCategory: 'fans',
      bgTint: 'bg-[#FDF9E2] border-[#FBEFBE]'
    },
    {
      id: 'modular-switches',
      name: 'Switches & Sockets',
      image: 'https://images.unsplash.com/photo-1558494949-ef010cbdcc31?w=200&auto=format&fit=crop&q=80',
      mainCategory: 'electrical',
      subCategory: 'switches',
      bgTint: 'bg-[#FFF0F5] border-[#FFD2E5]'
    },
    {
      id: 'wires-mcbs',
      name: 'Wires & Cables',
      image: 'https://images.unsplash.com/photo-1617791160536-598cf32026fb?w=200&auto=format&fit=crop&q=80',
      mainCategory: 'electrical',
      subCategory: 'wires_mcbs',
      bgTint: 'bg-[#F0FFF4] border-[#DCFCE7]'
    },
    {
      id: 'bath-fittings',
      name: 'Bathroom Fittings',
      image: 'https://images.unsplash.com/photo-1584622650111-993a426fbf0a?w=200&auto=format&fit=crop&q=80',
      mainCategory: 'plumbing',
      subCategory: 'bathroom_fittings',
      bgTint: 'bg-[#EBF7FF] border-[#D6EDFF]'
    },
    {
      id: 'valves-pipes',
      name: 'Valves & Teflon Tape',
      image: 'https://images.unsplash.com/photo-1585338107529-13afc5f02586?w=200&auto=format&fit=crop&q=80',
      mainCategory: 'plumbing',
      subCategory: 'pipes_valves',
      bgTint: 'bg-[#F4F1FE] border-[#E5DBFE]'
    },
    {
      id: 'cpvc-pipes',
      name: 'Pipes & CPVC Fittings',
      image: 'https://images.unsplash.com/photo-1541888946425-d0fbb18fe2b7?w=200&auto=format&fit=crop&q=80',
      mainCategory: 'plumbing',
      subCategory: 'pipes_valves',
      bgTint: 'bg-[#F5F5F5] border-[#E5E5E5]'
    },
    {
      id: 'switchgear',
      name: 'MCBs & Distribution',
      image: 'https://images.unsplash.com/photo-1617791160536-598cf32026fb?w=200&auto=format&fit=crop&q=80',
      mainCategory: 'electrical',
      subCategory: 'wires_mcbs',
      bgTint: 'bg-[#FFF2EB] border-[#FFE1D2]'
    }
  ];

  const kitchenFittings: VisualCategoryTile[] = [
    {
      id: 'sink-taps',
      name: 'Flexible Sink Taps',
      image: 'https://images.unsplash.com/photo-1601924582970-9238bcb495d9?w=200&auto=format&fit=crop&q=80',
      mainCategory: 'kitchen_fittings',
      subCategory: 'sink_taps',
      bgTint: 'bg-[#FFF2EB] border-[#FFE1D2]'
    },
    {
      id: 'waste-drain',
      name: 'Sink Waste Pipes',
      image: 'https://images.unsplash.com/photo-1541888946425-d0fbb18fe2b7?w=200&auto=format&fit=crop&q=80',
      mainCategory: 'kitchen_fittings',
      subCategory: 'waste_drain',
      bgTint: 'bg-[#F5F5F5] border-[#E5E5E5]'
    },
    {
      id: 'waste-couplings',
      name: 'Waste Couplings',
      image: 'https://images.unsplash.com/photo-1584622650111-993a426fbf0a?w=200&auto=format&fit=crop&q=80',
      mainCategory: 'kitchen_fittings',
      subCategory: 'waste_drain',
      bgTint: 'bg-[#EBF7FF] border-[#D6EDFF]'
    },
    {
      id: 'ro-valves',
      name: 'RO Valves & Filters',
      image: 'https://images.unsplash.com/photo-1585338107529-13afc5f02586?w=200&auto=format&fit=crop&q=80',
      mainCategory: 'kitchen_fittings',
      subCategory: 'ro_valves',
      bgTint: 'bg-[#FDF9E2] border-[#FBEFBE]'
    }
  ];

  const carpentryFittings: VisualCategoryTile[] = [
    {
      id: 'locks-handles',
      name: 'Door Locks & Handles',
      image: 'https://images.unsplash.com/photo-1507089947368-19c1da9775ae?w=200&auto=format&fit=crop&q=80',
      mainCategory: 'carpentry',
      subCategory: 'locks',
      bgTint: 'bg-[#FFF2EB] border-[#FFE1D2]'
    },
    {
      id: 'hinges-slides',
      name: 'Concealed Hinges',
      image: 'https://images.unsplash.com/photo-1513694203232-719a280e022f?w=200&auto=format&fit=crop&q=80',
      mainCategory: 'carpentry',
      subCategory: 'hinges',
      bgTint: 'bg-[#F4F1FE] border-[#E5DBFE]'
    },
    {
      id: 'drawer-telescopic',
      name: 'Telescopic Channels',
      image: 'https://images.unsplash.com/photo-1581244277943-fe4a9c777189?w=200&auto=format&fit=crop&q=80',
      mainCategory: 'carpentry',
      subCategory: 'hinges',
      bgTint: 'bg-[#EBF7FF] border-[#D6EDFF]'
    },
    {
      id: 'wood-adhesives',
      name: 'Wood Glues & Fevicol',
      image: 'https://images.unsplash.com/photo-1616401784845-180882ba9ba8?w=200&auto=format&fit=crop&q=80',
      mainCategory: 'carpentry',
      subCategory: 'all',
      bgTint: 'bg-[#FDF9E2] border-[#FBEFBE]'
    }
  ];

  const toolsAndMaterials: VisualCategoryTile[] = [
    {
      id: 'screws-bolts',
      name: 'Screws & Bolts',
      image: 'https://images.unsplash.com/photo-1530124566582-a618bc2615dc?w=200&auto=format&fit=crop&q=80',
      mainCategory: 'screws',
      subCategory: 'screws',
      bgTint: 'bg-[#FDF9E2] border-[#FBEFBE]'
    },
    {
      id: 'wall-plugs',
      name: 'Wall Plugs & Anchors',
      image: 'https://images.unsplash.com/photo-1586864387967-d02ef85d93e8?w=200&auto=format&fit=crop&q=80',
      mainCategory: 'screws',
      subCategory: 'fasteners',
      bgTint: 'bg-[#F5F5F5] border-[#E5E5E5]'
    },
    {
      id: 'cutters-discs',
      name: 'Cutters & Discs',
      image: 'https://images.unsplash.com/photo-1504148455328-c376907d081c?w=200&auto=format&fit=crop&q=80',
      mainCategory: 'tools',
      subCategory: 'cutting_discs',
      bgTint: 'bg-[#FFF0F5] border-[#FFD2E5]'
    },
    {
      id: 'power-tools',
      name: 'Power Tools & Bits',
      image: 'https://images.unsplash.com/photo-1572981779307-38b8cabb2407?w=200&auto=format&fit=crop&q=80',
      mainCategory: 'tools',
      subCategory: 'hand_tools',
      bgTint: 'bg-[#EBF7FF] border-[#D6EDFF]'
    },
    {
      id: 'snips-cutters',
      name: 'Snips & Hand Cutters',
      image: 'https://images.unsplash.com/photo-1504148455328-c376907d081c?w=200&auto=format&fit=crop&q=80',
      mainCategory: 'tools',
      subCategory: 'cutters',
      bgTint: 'bg-[#FFF2EB] border-[#FFE1D2]'
    },
    {
      id: 'safety-protection',
      name: 'Safety & Work Gear',
      image: 'https://images.unsplash.com/photo-1586864387967-d02ef85d93e8?w=200&auto=format&fit=crop&q=80',
      mainCategory: 'safety',
      subCategory: 'all',
      bgTint: 'bg-[#F4F1FE] border-[#E5DBFE]'
    },
    {
      id: 'solvent-epoxy',
      name: 'Solvents & Epoxies',
      image: 'https://images.unsplash.com/photo-1616401784845-180882ba9ba8?w=200&auto=format&fit=crop&q=80',
      mainCategory: 'adhesives',
      subCategory: 'solvent_epoxy',
      bgTint: 'bg-[#F0FFF4] border-[#DCFCE7]'
    },
    {
      id: 'silicone-foam',
      name: 'Silicone & PU Foam',
      image: 'https://images.unsplash.com/photo-1581244277943-fe4a9c777189?w=200&auto=format&fit=crop&q=80',
      mainCategory: 'adhesives',
      subCategory: 'sealant_foam',
      bgTint: 'bg-[#EBF7FF] border-[#D6EDFF]'
    }
  ];

  return (
    <div className="w-full space-y-6 bg-white border border-slate-200/80 p-4 sm:p-5 rounded-3xl shadow-2xs">
      {/* Category Group 1 */}
      <div className="space-y-3.5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base sm:text-lg font-black text-slate-900 tracking-tight">
              Electrical & Plumbing Rescues
            </h2>
            <p className="text-xs text-slate-400 font-semibold mt-0.5">
              Direct modular fittings, ceiling parts & pipeline adapters
            </p>
          </div>
        </div>

        <div className="grid grid-cols-4 gap-2 sm:gap-3.5">
          {plumbingAndElectrical.map((tile) => (
            <div
              key={tile.id}
              onClick={() => onSelectCategory(tile.mainCategory, tile.subCategory)}
              className="flex flex-col items-center justify-between text-center cursor-pointer group focus:outline-none"
            >
              {/* Colored/tinted rounded rectangle cell exactly like the reference image */}
              <div className={`w-full aspect-square ${tile.bgTint} border rounded-2xl sm:rounded-3xl flex items-center justify-center overflow-hidden p-2.5 transition duration-200 group-hover:scale-103 group-hover:shadow-xs`}>
                <img
                  src={tile.image}
                  alt={tile.name}
                  referrerPolicy="no-referrer"
                  className="w-full h-full object-contain mix-blend-multiply group-hover:scale-106 transition duration-300"
                />
              </div>

              {/* Title label beneath with neat padding & size */}
              <span className="text-[11px] sm:text-xs font-bold text-slate-700 group-hover:text-slate-900 mt-2 line-clamp-2 min-h-[32px] sm:min-h-[36px] leading-tight px-1 select-none">
                {tile.name}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Category Group 2: Kitchen Fittings */}
      <div className="space-y-3.5 pt-2 border-t border-slate-100">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base sm:text-lg font-black text-slate-900 tracking-tight">
              Kitchen Fittings & Accessories
            </h2>
            <p className="text-xs text-slate-400 font-semibold mt-0.5">
              High-pressure sink faucets, flexible drain pipes & water purification valves
            </p>
          </div>
        </div>

        <div className="grid grid-cols-4 gap-2 sm:gap-3.5">
          {kitchenFittings.map((tile) => (
            <div
              key={tile.id}
              onClick={() => onSelectCategory(tile.mainCategory, tile.subCategory)}
              className="flex flex-col items-center justify-between text-center cursor-pointer group focus:outline-none"
            >
              {/* Colored/tinted rounded rectangle cell exactly like the reference image */}
              <div className={`w-full aspect-square ${tile.bgTint} border rounded-2xl sm:rounded-3xl flex items-center justify-center overflow-hidden p-2.5 transition duration-200 group-hover:scale-103 group-hover:shadow-xs`}>
                <img
                  src={tile.image}
                  alt={tile.name}
                  referrerPolicy="no-referrer"
                  className="w-full h-full object-contain mix-blend-multiply group-hover:scale-106 transition duration-300"
                />
              </div>

              {/* Title label beneath with neat padding & size */}
              <span className="text-[11px] sm:text-xs font-bold text-slate-700 group-hover:text-slate-900 mt-2 line-clamp-2 min-h-[32px] sm:min-h-[36px] leading-tight px-1 select-none">
                {tile.name}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Category Group 3: Carpentry & Wooden Fittings */}
      <div className="space-y-3.5 pt-2 border-t border-slate-100">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base sm:text-lg font-black text-slate-900 tracking-tight">
              Carpentry & Furniture Fittings
            </h2>
            <p className="text-xs text-slate-400 font-semibold mt-0.5">
              Mortise locks, high-weight concealed hinges, telescopic channels & wood adhesives
            </p>
          </div>
        </div>

        <div className="grid grid-cols-4 gap-2 sm:gap-3.5">
          {carpentryFittings.map((tile) => (
            <div
              key={tile.id}
              onClick={() => onSelectCategory(tile.mainCategory, tile.subCategory)}
              className="flex flex-col items-center justify-between text-center cursor-pointer group focus:outline-none"
            >
              {/* Colored/tinted rounded rectangle cell exactly like the reference image */}
              <div className={`w-full aspect-square ${tile.bgTint} border rounded-2xl sm:rounded-3xl flex items-center justify-center overflow-hidden p-2.5 transition duration-200 group-hover:scale-103 group-hover:shadow-xs`}>
                <img
                  src={tile.image}
                  alt={tile.name}
                  referrerPolicy="no-referrer"
                  className="w-full h-full object-contain mix-blend-multiply group-hover:scale-106 transition duration-300"
                />
              </div>

              {/* Title label beneath with neat padding & size */}
              <span className="text-[11px] sm:text-xs font-bold text-slate-700 group-hover:text-slate-900 mt-2 line-clamp-2 min-h-[32px] sm:min-h-[36px] leading-tight px-1 select-none">
                {tile.name}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Category Group 4 */}
      <div className="space-y-3.5 pt-2 border-t border-slate-100">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base sm:text-lg font-black text-slate-900 tracking-tight">
              Tools, Screws & Materials
            </h2>
            <p className="text-xs text-slate-400 font-semibold mt-0.5">
              Premium grade fasteners, power bits, adhesives & locks
            </p>
          </div>
        </div>

        <div className="grid grid-cols-4 gap-2 sm:gap-3.5">
          {toolsAndMaterials.map((tile) => (
            <div
              key={tile.id}
              onClick={() => onSelectCategory(tile.mainCategory, tile.subCategory)}
              className="flex flex-col items-center justify-between text-center cursor-pointer group focus:outline-none"
            >
              {/* Colored/tinted rounded rectangle cell exactly like the reference image */}
              <div className={`w-full aspect-square ${tile.bgTint} border rounded-2xl sm:rounded-3xl flex items-center justify-center overflow-hidden p-2.5 transition duration-200 group-hover:scale-103 group-hover:shadow-xs`}>
                <img
                  src={tile.image}
                  alt={tile.name}
                  referrerPolicy="no-referrer"
                  className="w-full h-full object-contain mix-blend-multiply group-hover:scale-106 transition duration-300"
                />
              </div>

              {/* Title label beneath with neat padding & size */}
              <span className="text-[11px] sm:text-xs font-bold text-slate-700 group-hover:text-slate-900 mt-2 line-clamp-2 min-h-[32px] sm:min-h-[36px] leading-tight px-1 select-none">
                {tile.name}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
