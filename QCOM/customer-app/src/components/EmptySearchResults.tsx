import React from 'react';
import { motion } from 'motion/react';
import { 
  Search, 
  RotateCcw, 
  Zap, 
  Droplet, 
  Wrench, 
  Sparkles,
  ArrowRight,
  PackageSearch
} from 'lucide-react';
import { TradeCategory } from '../types';

interface EmptySearchResultsProps {
  searchQuery: string;
  onClearFilters: () => void;
  onSelectSuggestion: (term: string) => void;
  onSelectCategory?: (category: TradeCategory) => void;
}

const POPULAR_SEARCH_CHIPS = [
  { label: 'MCB & Breakers', query: 'mcb', icon: Zap },
  { label: 'Ball Valves', query: 'valve', icon: Droplet },
  { label: 'Hex Screws', query: 'screw', icon: Wrench },
  { label: 'Teflon Tape', query: 'tape', icon: Sparkles },
  { label: 'Pliers & Tools', query: 'pliers', icon: Wrench },
  { label: 'LED Lights', query: 'led', icon: Zap },
];

const POPULAR_DEPARTMENTS: { label: string; category: TradeCategory; icon: any; color: string; bg: string }[] = [
  { label: 'Electrical', category: 'electrical', icon: Zap, color: 'text-amber-600', bg: 'bg-amber-50 hover:bg-amber-100 border-amber-200/80' },
  { label: 'Plumbing & Bath', category: 'plumbing', icon: Droplet, color: 'text-sky-600', bg: 'bg-sky-50 hover:bg-sky-100 border-sky-200/80' },
  { label: 'Screws & Nuts', category: 'screws', icon: Wrench, color: 'text-orange-600', bg: 'bg-orange-50 hover:bg-orange-100 border-orange-200/80' },
  { label: 'Hand Tools', category: 'tools', icon: PackageSearch, color: 'text-emerald-600', bg: 'bg-emerald-50 hover:bg-emerald-100 border-emerald-200/80' },
];

export const EmptySearchResults: React.FC<EmptySearchResultsProps> = ({
  searchQuery,
  onClearFilters,
  onSelectSuggestion,
  onSelectCategory,
}) => {
  return (
    <motion.div 
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      className="w-full max-w-2xl mx-auto py-8 sm:py-12 px-4 text-center"
      id="empty-search-state-container"
    >
      {/* Lottie-style Motion Illustration Canvas */}
      <div className="relative w-48 h-48 sm:w-56 sm:h-56 mx-auto mb-5 flex items-center justify-center select-none pointer-events-none">
        {/* Soft Ambient Radial Glow */}
        <div className="absolute inset-0 bg-gradient-to-tr from-amber-200/30 via-emerald-100/40 to-sky-100/30 rounded-full blur-2xl -z-10" />

        {/* Pulse Radar Waves (Concentric expanding rings) */}
        <motion.div
          animate={{
            scale: [0.85, 1.35, 1.6],
            opacity: [0.5, 0.2, 0],
          }}
          transition={{
            duration: 3,
            repeat: Infinity,
            ease: 'easeOut',
          }}
          className="absolute w-32 h-32 rounded-full border-2 border-dashed border-amber-400/60"
        />
        <motion.div
          animate={{
            scale: [0.85, 1.4, 1.7],
            opacity: [0.4, 0.15, 0],
          }}
          transition={{
            duration: 3,
            repeat: Infinity,
            delay: 1,
            ease: 'easeOut',
          }}
          className="absolute w-32 h-32 rounded-full border border-emerald-400/50"
        />

        {/* Isometric Platform / Ground Base */}
        <div className="absolute bottom-6 w-36 h-10 bg-slate-200/70 rounded-[100%] blur-[2px] transform scale-y-50" />

        {/* Floating Background Sparkle/Mote Particles */}
        <motion.div
          animate={{
            y: [-8, 8, -8],
            x: [-4, 4, -4],
            rotate: [0, 45, 0],
            opacity: [0.6, 1, 0.6],
          }}
          transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
          className="absolute top-4 left-6 w-7 h-7 rounded-xl bg-amber-100/90 border border-amber-300 shadow-xs flex items-center justify-center text-amber-600"
        >
          <Zap className="w-3.5 h-3.5 fill-amber-400" />
        </motion.div>

        <motion.div
          animate={{
            y: [6, -8, 6],
            x: [4, -4, 4],
            rotate: [0, -30, 0],
            opacity: [0.7, 1, 0.7],
          }}
          transition={{ duration: 4.5, repeat: Infinity, ease: 'easeInOut', delay: 0.5 }}
          className="absolute top-8 right-6 w-8 h-8 rounded-xl bg-sky-100/90 border border-sky-300 shadow-xs flex items-center justify-center text-sky-600"
        >
          <Droplet className="w-4 h-4 fill-sky-300" />
        </motion.div>

        <motion.div
          animate={{
            y: [-6, 6, -6],
            rotate: [0, 90, 0],
          }}
          transition={{ duration: 5, repeat: Infinity, ease: 'easeInOut', delay: 1 }}
          className="absolute bottom-10 left-8 w-7 h-7 rounded-xl bg-orange-100/90 border border-orange-300 shadow-xs flex items-center justify-center text-orange-600"
        >
          <Wrench className="w-3.5 h-3.5" />
        </motion.div>

        {/* Central Lottie-Style Animated Magnifier with Radar Glass */}
        <motion.div
          animate={{
            rotate: [-6, 6, -6],
            y: [-5, 5, -5],
            x: [-3, 3, -3],
          }}
          transition={{
            duration: 4,
            repeat: Infinity,
            ease: 'easeInOut',
          }}
          className="relative z-10 flex items-center justify-center"
        >
          {/* Magnifying Glass Frame */}
          <div className="relative w-24 h-24 rounded-full bg-gradient-to-br from-white via-slate-50 to-slate-100 border-4 border-slate-700 shadow-xl flex items-center justify-center overflow-hidden">
            {/* Glass Lens Reflection Gradient */}
            <div className="absolute inset-0 bg-gradient-to-tr from-sky-400/10 via-amber-200/20 to-transparent pointer-events-none" />
            <div className="absolute -top-6 -left-6 w-16 h-16 bg-white/60 rounded-full blur-xs pointer-events-none" />

            {/* Radar Sweep Beam inside lens */}
            <motion.div
              animate={{ rotate: 360 }}
              transition={{ duration: 4, repeat: Infinity, ease: 'linear' }}
              className="absolute inset-0 origin-center flex items-center justify-center pointer-events-none opacity-40"
            >
              <div className="w-1/2 h-0.5 bg-gradient-to-r from-transparent to-amber-500 origin-left" />
            </motion.div>

            {/* Centered Target Ping Icon */}
            <motion.div
              animate={{ scale: [0.9, 1.1, 0.9] }}
              transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
              className="relative z-10 w-9 h-9 rounded-full bg-slate-100/90 border border-slate-300/80 flex items-center justify-center text-slate-500 shadow-2xs"
            >
              <Search className="w-4 h-4 text-slate-600" />
            </motion.div>
          </div>

          {/* Magnifier Handle */}
          <div 
            className="absolute -bottom-6 -right-5 w-6 h-12 bg-slate-800 rounded-b-md border-2 border-slate-700 shadow-md transform rotate-[-45deg] origin-top"
          >
            {/* Handle Grip Detail Accent */}
            <div className="w-full h-2 bg-amber-500 mt-2" />
          </div>
        </motion.div>
      </div>

      {/* Main Content & Messaging */}
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1, duration: 0.3 }}
        className="space-y-2 mb-6"
      >
        <h3 className="text-base sm:text-lg font-bold text-slate-800 tracking-tight" id="empty-state-heading">
          No matching item found
        </h3>
        
        {searchQuery ? (
          <p className="text-xs sm:text-sm text-slate-500 max-w-md mx-auto leading-relaxed">
            We couldn't find matches for <span className="font-semibold text-slate-700 bg-slate-100 px-1.5 py-0.5 rounded-md border border-slate-200">"{searchQuery}"</span>. Check spelling or try popular hardware terms below.
          </p>
        ) : (
          <p className="text-xs sm:text-sm text-slate-500 max-w-md mx-auto leading-relaxed">
            No hardware items match your selected filter criteria. Try clearing filters to see all available inventory.
          </p>
        )}
      </motion.div>

      {/* Primary Action Button */}
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ delay: 0.15, duration: 0.25 }}
        className="flex flex-wrap items-center justify-center gap-3 mb-7"
      >
        <motion.button
          whileHover={{ scale: 1.02, translateY: -1 }}
          whileTap={{ scale: 0.98 }}
          onClick={onClearFilters}
          id="empty-state-clear-btn"
          className="inline-flex items-center gap-2 bg-emerald-700 hover:bg-emerald-800 text-white text-xs sm:text-sm font-bold px-5 py-2.5 rounded-xl shadow-xs hover:shadow-md transition-all cursor-pointer"
        >
          <RotateCcw className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
          Clear Filters & View All Products
        </motion.button>
      </motion.div>

      {/* Popular Hardware Search Suggestions */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2, duration: 0.3 }}
        className="mb-7"
      >
        <p className="text-[11px] uppercase tracking-wider font-bold text-slate-400 mb-2.5">
          Popular Hardware Searches
        </p>
        <div className="flex flex-wrap items-center justify-center gap-1.5 sm:gap-2">
          {POPULAR_SEARCH_CHIPS.map((chip) => {
            const IconComponent = chip.icon;
            return (
              <motion.button
                key={chip.query}
                whileHover={{ scale: 1.04 }}
                whileTap={{ scale: 0.96 }}
                onClick={() => onSelectSuggestion(chip.query)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white hover:bg-slate-50 border border-slate-200/90 text-slate-700 text-xs font-semibold shadow-2xs hover:border-slate-300 transition-colors cursor-pointer"
              >
                <IconComponent className="w-3 h-3 text-slate-400" />
                <span>{chip.label}</span>
              </motion.button>
            );
          })}
        </div>
      </motion.div>

      {/* Browse Top Departments Carousel / Grid */}
      {onSelectCategory && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25, duration: 0.3 }}
          className="pt-4 border-t border-slate-200/70"
        >
          <div className="flex items-center justify-between mb-3 px-1">
            <span className="text-[11px] uppercase tracking-wider font-bold text-slate-400">
              Or Browse By Trade Department
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {POPULAR_DEPARTMENTS.map((dept) => {
              const IconComp = dept.icon;
              return (
                <motion.button
                  key={dept.category}
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => onSelectCategory(dept.category)}
                  className={`flex items-center gap-2 p-2.5 rounded-xl border text-left transition-all cursor-pointer ${dept.bg}`}
                >
                  <div className={`p-1.5 rounded-lg bg-white shadow-2xs ${dept.color}`}>
                    <IconComp className="w-4 h-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-bold text-slate-800 truncate">
                      {dept.label}
                    </div>
                  </div>
                  <ArrowRight className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                </motion.button>
              );
            })}
          </div>
        </motion.div>
      )}
    </motion.div>
  );
};
