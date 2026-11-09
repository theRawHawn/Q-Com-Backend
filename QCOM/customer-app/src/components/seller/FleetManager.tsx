import React from 'react';
import { 
  Bike, 
  BatteryCharging, 
  Phone, 
  MapPin, 
  Star, 
  CheckCircle, 
  Clock, 
  Zap, 
  User,
  ShieldCheck
} from 'lucide-react';
import { EVRider } from '../../types';

interface FleetManagerProps {
  riders: EVRider[];
}

export const FleetManager: React.FC<FleetManagerProps> = ({ riders }) => {
  const getStatusDisplay = (status: EVRider['status']) => {
    switch (status) {
      case 'idle_at_hub':
        return <span className="bg-emerald-100 text-emerald-900 border border-emerald-300 text-[10px] font-black px-2 py-0.5 rounded-full">🟢 IDLE AT HUB (READY)</span>;
      case 'picking_up':
        return <span className="bg-blue-100 text-blue-900 border border-blue-300 text-[10px] font-black px-2 py-0.5 rounded-full">📦 PICKING UP AT DOCK</span>;
      case 'in_transit':
        return <span className="bg-amber-100 text-amber-900 border border-amber-300 text-[10px] font-black px-2 py-0.5 rounded-full animate-pulse">🛵 IN TRANSIT TO ADDRESS</span>;
      case 'returning':
        return <span className="bg-purple-100 text-purple-900 border border-purple-300 text-[10px] font-black px-2 py-0.5 rounded-full">⚡ RETURNING TO HUB</span>;
    }
  };

  return (
    <div className="space-y-4">
      
      {/* Fleet Overview Top Bar */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-2xs">
          <div className="text-[10px] uppercase font-bold text-slate-400">Total Active EV Fleet</div>
          <div className="text-xl font-black text-slate-900 mt-0.5">{riders.length} On Duty</div>
          <div className="text-[11px] text-emerald-700 font-bold mt-1">100% Electric EV Scooters</div>
        </div>

        <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-2xs">
          <div className="text-[10px] uppercase font-bold text-slate-400">Available at Hub Dock</div>
          <div className="text-xl font-black text-emerald-700 mt-0.5">
            {riders.filter(r => r.status === 'idle_at_hub').length} Couriers Ready
          </div>
          <div className="text-[11px] text-slate-500 mt-1">Instant dispatch SLA: 45 sec</div>
        </div>

        <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-2xs">
          <div className="text-[10px] uppercase font-bold text-slate-400">On-Road Dispatches</div>
          <div className="text-xl font-black text-amber-600 mt-0.5">
            {riders.filter(r => r.status === 'in_transit' || r.status === 'picking_up').length} Active Deliveries
          </div>
          <div className="text-[11px] text-slate-500 mt-1">Avg Speed: 24 km/h</div>
        </div>

        <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-2xs">
          <div className="text-[10px] uppercase font-bold text-slate-400">Total Trips Completed Today</div>
          <div className="text-xl font-black text-slate-900 mt-0.5">
            {riders.reduce((s, r) => s + r.completedToday, 0)} Drops
          </div>
          <div className="text-[11px] text-emerald-700 font-bold mt-1">₹0 Tailpipe Emissions</div>
        </div>
      </div>

      {/* Rider Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {riders.map((rider) => (
          <div 
            key={rider.id}
            className="bg-white rounded-3xl border border-slate-200 shadow-2xs p-4 sm:p-5 space-y-3.5 hover:shadow-md transition"
          >
            {/* Rider Header */}
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <img 
                  src={rider.photo} 
                  alt={rider.name}
                  referrerPolicy="no-referrer"
                  className="w-12 h-12 rounded-2xl object-cover border-2 border-emerald-500" 
                />
                <div>
                  <h4 className="font-black text-slate-900 text-sm">{rider.name}</h4>
                  <div className="text-[11px] text-slate-500 font-medium">{rider.vehicle}</div>
                  <div className="flex items-center gap-1 mt-0.5">
                    <Star className="w-3 h-3 fill-amber-400 text-amber-400" />
                    <span className="text-[11px] font-bold text-slate-800">{rider.rating} Rating</span>
                  </div>
                </div>
              </div>

              <div>
                {getStatusDisplay(rider.status)}
              </div>
            </div>

            {/* Battery & Stats Bar */}
            <div className="bg-slate-50 p-3 rounded-2xl border border-slate-200/80 grid grid-cols-2 gap-2 text-xs">
              <div className="flex items-center gap-2">
                <BatteryCharging className="w-4 h-4 text-emerald-600" />
                <div>
                  <div className="text-[10px] text-slate-400 uppercase font-bold">EV Battery</div>
                  <div className="font-black text-slate-900">{rider.batteryPercent}% Charged</div>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <CheckCircle className="w-4 h-4 text-blue-600" />
                <div>
                  <div className="text-[10px] text-slate-400 uppercase font-bold">Today's Trips</div>
                  <div className="font-black text-slate-900">{rider.completedToday} Drops Completed</div>
                </div>
              </div>
            </div>

            {/* Action Bar */}
            <div className="flex items-center justify-between pt-1 text-xs">
              <span className="font-mono text-[11px] text-slate-500">
                Courier ID: {rider.id}
              </span>
              <a
                href={`tel:${rider.phone}`}
                className="inline-flex items-center gap-1.5 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 font-bold px-3 py-1.5 rounded-xl transition border border-emerald-200"
              >
                <Phone className="w-3.5 h-3.5" />
                <span>Call Courier ({rider.phone.slice(-4)})</span>
              </a>
            </div>

          </div>
        ))}
      </div>

    </div>
  );
};
