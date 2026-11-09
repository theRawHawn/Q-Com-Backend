import React from 'react';
import { 
  Store, 
  ShoppingBag, 
  Boxes, 
  Bike, 
  BarChart3, 
  Bell, 
  BellOff, 
  Sparkles, 
  PlusCircle, 
  ChevronRight,
  Radio,
  Zap
} from 'lucide-react';
import { AppMode, SellerTab } from '../../types';

interface SellerHeaderProps {
  activeTab: SellerTab;
  onTabChange: (tab: SellerTab) => void;
  onSwitchToCustomer: () => void;
  pendingOrdersCount: number;
  onSimulateOrder: () => void;
  soundEnabled: boolean;
  onToggleSound: () => void;
  onOpenAddProduct: () => void;
}

export const SellerHeader: React.FC<SellerHeaderProps> = ({
  activeTab,
  onTabChange,
  onSwitchToCustomer,
  pendingOrdersCount,
  onSimulateOrder,
  soundEnabled,
  onToggleSound,
  onOpenAddProduct,
}) => {
  return (
    <header className="sticky top-0 z-40 bg-slate-900 text-white border-b border-slate-800 shadow-md">
      
      {/* Top Merchant Sub-bar */}
      <div className="bg-slate-950 px-4 py-1.5 text-[11px] border-b border-slate-800/80 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 text-emerald-400 font-bold">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span>Dark Store Hub #07 • Koramangala Active</span>
          </div>
          <span className="text-slate-600 hidden sm:inline">•</span>
          <span className="text-slate-400 hidden sm:inline">
            Pick & Pack SLA: <strong className="text-white">1m 45s</strong> | Express Service Radius: <strong className="text-white">3.5 km</strong>
          </span>
        </div>

        {/* Switch to Customer App Button */}
        <button
          onClick={onSwitchToCustomer}
          className="flex items-center gap-1.5 bg-amber-400 hover:bg-amber-300 text-slate-950 font-black px-3 py-1 rounded-full text-xs transition cursor-pointer shadow-xs"
        >
          <ShoppingBag className="w-3.5 h-3.5" />
          <span>Switch to Customer App</span>
        </button>
      </div>

      {/* Main Merchant Nav Bar */}
      <div className="max-w-7xl mx-auto px-4 py-3 flex flex-wrap items-center justify-between gap-3">
        
        {/* Brand & Hub Code */}
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-gradient-to-tr from-amber-500 to-yellow-400 text-slate-950 flex items-center justify-center font-black text-xl shadow-xs">
            ⚡
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-black tracking-tight text-base sm:text-lg text-white">
                blink<span className="text-amber-400">it</span>
              </span>
              <span className="bg-emerald-800/80 text-emerald-300 border border-emerald-600/50 text-[10px] font-black px-2 py-0.5 rounded uppercase tracking-wider">
                Partner Hub
              </span>
            </div>
            <div className="text-[11px] text-slate-400 font-medium flex items-center gap-1">
              <span>Merchant & Dark Store Terminal</span>
              <span>•</span>
              <span className="text-emerald-400 font-mono">HUB-BLR-07</span>
            </div>
          </div>
        </div>

        {/* Actions (Simulate Order, Audio Alert, Add SKU) */}
        <div className="flex items-center gap-2">
          
          {/* Audio alert toggle */}
          <button
            onClick={onToggleSound}
            title={soundEnabled ? "Audio alerts enabled" : "Audio alerts muted"}
            className={`p-2 rounded-xl border text-xs font-bold transition cursor-pointer flex items-center gap-1.5 ${
              soundEnabled 
                ? 'bg-slate-800 border-slate-700 text-emerald-400 hover:bg-slate-700' 
                : 'bg-slate-800/50 border-slate-800 text-slate-500'
            }`}
          >
            {soundEnabled ? <Bell className="w-4 h-4" /> : <BellOff className="w-4 h-4" />}
            <span className="hidden md:inline">{soundEnabled ? 'Alerts ON' : 'Muted'}</span>
          </button>

          {/* Simulate Tradesperson Live Order Button */}
          <button
            onClick={onSimulateOrder}
            className="bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs px-3 py-2 rounded-xl shadow-xs transition flex items-center gap-1.5 cursor-pointer"
          >
            <Sparkles className="w-3.5 h-3.5 text-indigo-200" />
            <span className="hidden sm:inline">Simulate</span> Incoming Order
          </button>

          {/* Add SKU Button */}
          <button
            onClick={onOpenAddProduct}
            className="bg-emerald-600 hover:bg-emerald-500 text-white font-black text-xs px-3.5 py-2 rounded-xl shadow-xs transition flex items-center gap-1.5 cursor-pointer"
          >
            <PlusCircle className="w-3.5 h-3.5" />
            <span>+ Add SKU</span>
          </button>

        </div>

      </div>

      {/* Tabs Row */}
      <div className="max-w-7xl mx-auto px-4 flex items-center gap-2 overflow-x-auto scrollbar-none border-t border-slate-800 text-xs">
        
        <button
          onClick={() => onTabChange('orders')}
          className={`py-3 px-3.5 font-bold flex items-center gap-2 border-b-2 transition cursor-pointer whitespace-nowrap ${
            activeTab === 'orders'
              ? 'border-amber-400 text-amber-400'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <Radio className="w-4 h-4" />
          <span>Live Order Dispatch</span>
          {pendingOrdersCount > 0 && (
            <span className="bg-amber-400 text-slate-950 font-black text-[10px] px-1.5 py-0.2 rounded-full">
              {pendingOrdersCount}
            </span>
          )}
        </button>

        <button
          onClick={() => onTabChange('inventory')}
          className={`py-3 px-3.5 font-bold flex items-center gap-2 border-b-2 transition cursor-pointer whitespace-nowrap ${
            activeTab === 'inventory'
              ? 'border-amber-400 text-amber-400'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <Boxes className="w-4 h-4" />
          <span>Dark Store Inventory & Bins</span>
        </button>

        <button
          onClick={() => onTabChange('fleet')}
          className={`py-3 px-3.5 font-bold flex items-center gap-2 border-b-2 transition cursor-pointer whitespace-nowrap ${
            activeTab === 'fleet'
              ? 'border-amber-400 text-amber-400'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <Bike className="w-4 h-4" />
          <span>EV Rider Fleet Ops</span>
        </button>

        <button
          onClick={() => onTabChange('analytics')}
          className={`py-3 px-3.5 font-bold flex items-center gap-2 border-b-2 transition cursor-pointer whitespace-nowrap ${
            activeTab === 'analytics'
              ? 'border-amber-400 text-amber-400'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <BarChart3 className="w-4 h-4" />
          <span>Store GMV & Metrics</span>
        </button>

        <button
          onClick={() => onTabChange('settings')}
          className={`py-3 px-3.5 font-bold flex items-center gap-2 border-b-2 transition cursor-pointer whitespace-nowrap ${
            activeTab === 'settings'
              ? 'border-amber-400 text-amber-400'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <Zap className="w-4 h-4 text-amber-400" />
          <span>Platform Pricing & Handling Charges</span>
        </button>

      </div>

    </header>
  );
};
