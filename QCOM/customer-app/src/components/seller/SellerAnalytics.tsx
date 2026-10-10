import React from 'react';
import { 
  TrendingUp, 
  DollarSign, 
  Clock, 
  CheckCircle2, 
  Package, 
  Award, 
  Zap, 
  Droplet, 
  Anchor, 
  Hammer 
} from 'lucide-react';
import { DarkStoreStats, HardwareProduct } from '../../types';

interface SellerAnalyticsProps {
  stats: DarkStoreStats;
  products: HardwareProduct[];
}

export const SellerAnalytics: React.FC<SellerAnalyticsProps> = ({ stats, products }) => {
  return (
    <div className="space-y-4">
      
      {/* Top Stat Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        
        <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-2xs">
          <div className="flex items-center justify-between text-slate-500">
            <span className="text-[10px] uppercase font-bold">Today's Gross GMV</span>
            <span className="text-[10px] font-black text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded">+18.4%</span>
          </div>
          <div className="text-2xl font-black text-slate-900 mt-1">₹{stats.todayGmv.toLocaleString()}</div>
          <div className="text-[11px] text-slate-500 mt-1">From {stats.totalOrders} customer orders today</div>
        </div>

        <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-2xs">
          <div className="flex items-center justify-between text-slate-500">
            <span className="text-[10px] uppercase font-bold">Avg Pick & Pack SLA</span>
            <span className="text-[10px] font-black text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded">Target &lt; 2m</span>
          </div>
          <div className="text-2xl font-black text-emerald-700 mt-1">1m 45s</div>
          <div className="text-[11px] text-slate-500 mt-1">Time from order tap to bagged parcel</div>
        </div>

        <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-2xs">
          <div className="flex items-center justify-between text-slate-500">
            <span className="text-[10px] uppercase font-bold">Avg Doorstep Delivery SLA</span>
            <span className="text-[10px] font-black text-blue-700 bg-blue-50 px-1.5 py-0.5 rounded">Live ETA Target</span>
          </div>
          <div className="text-2xl font-black text-blue-700 mt-1">11.4 Mins</div>
          <div className="text-[11px] text-slate-500 mt-1">Direct to contractor floor/unit</div>
        </div>

        <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-2xs">
          <div className="flex items-center justify-between text-slate-500">
            <span className="text-[10px] uppercase font-bold">On-Time Delivery Rate</span>
            <span className="text-[10px] font-black text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded">Excellence</span>
          </div>
          <div className="text-2xl font-black text-slate-900 mt-1">{stats.onTimePercent}%</div>
          <div className="text-[11px] text-emerald-700 font-bold mt-1">62 / 64 deliveries under 15 mins</div>
        </div>

      </div>

      {/* 2-Column Analytics Breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        
        {/* Top Fast-Moving Hardware SKUs */}
        <div className="bg-white p-5 rounded-3xl border border-slate-200 shadow-2xs space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-black text-slate-900 text-sm">Top Fast-Moving SKUs</h3>
              <p className="text-[11px] text-slate-500">Highest velocity parts dispatched from Dark Store #07</p>
            </div>
            <Award className="w-5 h-5 text-amber-500" />
          </div>

          <div className="space-y-2.5">
            {[
              { name: 'SealLock Teflon PTFE Thread Tape (Pack of 3)', cat: 'Plumbing', units: '142 packs', rev: '₹6,390', share: '85%' },
              { name: 'Supreme 1/2" Brass Quarter-Turn Angle Valve', cat: 'Plumbing', units: '86 units', rev: '₹15,910', share: '70%' },
              { name: 'Havells 16A Single Pole C-Curve MCB Breaker', cat: 'Electrical', units: '58 units', rev: '₹8,990', share: '55%' },
              { name: 'Fischer Type Nylon Wall Plugs / Gitti (Box 150)', cat: 'Fasteners', units: '44 boxes', rev: '₹4,840', share: '45%' },
              { name: 'WD-40 Multi-Use Spray & Lubricant Can (240ml)', cat: 'Chemicals', units: '38 cans', rev: '₹6,270', share: '38%' },
            ].map((item, idx) => (
              <div key={idx} className="bg-slate-50 p-3 rounded-2xl border border-slate-100 space-y-1.5">
                <div className="flex items-center justify-between text-xs font-bold">
                  <span className="text-slate-900 truncate">{idx + 1}. {item.name}</span>
                  <span className="text-emerald-800 font-black shrink-0">{item.rev}</span>
                </div>
                <div className="flex items-center justify-between text-[10px] text-slate-500">
                  <span>{item.cat} • {item.units} dispatched</span>
                  <div className="w-24 bg-slate-200 h-1.5 rounded-full overflow-hidden">
                    <div className="bg-emerald-600 h-full rounded-full" style={{ width: item.share }} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Trade Category Revenue Share & Peak Hours */}
        <div className="bg-white p-5 rounded-3xl border border-slate-200 shadow-2xs space-y-4">
          <div>
            <h3 className="font-black text-slate-900 text-sm">Trade Category Share & Contractor Hours</h3>
            <p className="text-[11px] text-slate-500">Peak demand spikes occur during active morning renovations</p>
          </div>

          <div className="space-y-3">
            <div>
              <div className="flex justify-between text-xs font-bold mb-1">
                <span className="flex items-center gap-1.5 text-blue-700">
                  <Droplet className="w-3.5 h-3.5" /> Plumbing Emergency Spares
                </span>
                <span>38% (₹16,280)</span>
              </div>
              <div className="w-full bg-slate-100 h-2 rounded-full overflow-hidden">
                <div className="bg-blue-600 h-full rounded-full" style={{ width: '38%' }} />
              </div>
            </div>

            <div>
              <div className="flex justify-between text-xs font-bold mb-1">
                <span className="flex items-center gap-1.5 text-amber-700">
                  <Zap className="w-3.5 h-3.5" /> Electrical MCBs & Wires
                </span>
                <span>32% (₹13,710)</span>
              </div>
              <div className="w-full bg-slate-100 h-2 rounded-full overflow-hidden">
                <div className="bg-amber-500 h-full rounded-full" style={{ width: '32%' }} />
              </div>
            </div>

            <div>
              <div className="flex justify-between text-xs font-bold mb-1">
                <span className="flex items-center gap-1.5 text-slate-700">
                  <Anchor className="w-3.5 h-3.5" /> Fasteners, Screws & Anchors
                </span>
                <span>18% (₹7,710)</span>
              </div>
              <div className="w-full bg-slate-100 h-2 rounded-full overflow-hidden">
                <div className="bg-slate-700 h-full rounded-full" style={{ width: '18%' }} />
              </div>
            </div>

            <div>
              <div className="flex justify-between text-xs font-bold mb-1">
                <span className="flex items-center gap-1.5 text-emerald-700">
                  <Hammer className="w-3.5 h-3.5" /> Tools, Bits & Adhesives
                </span>
                <span>12% (₹5,150)</span>
              </div>
              <div className="w-full bg-slate-100 h-2 rounded-full overflow-hidden">
                <div className="bg-emerald-600 h-full rounded-full" style={{ width: '12%' }} />
              </div>
            </div>
          </div>

          {/* Peak Hours Callout */}
          <div className="bg-amber-50 border border-amber-200 p-3 rounded-2xl text-xs space-y-1 text-amber-950">
            <div className="font-black flex items-center gap-1">
              <Clock className="w-3.5 h-3.5 text-amber-700" />
              <span>Tradesperson Rush Hours: 9:30 AM - 1:30 PM</span>
            </div>
            <p className="text-[11px] text-amber-900 leading-relaxed">
              Contractors and homeowners discover missing or broken fittings after reaching delivery locations in the morning. Pre-stage Top 20 plumbing valves and MCBs near packing stations for 1-minute pick speeds.
            </p>
          </div>

        </div>

      </div>

    </div>
  );
};
