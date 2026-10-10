import React, { useState } from 'react';
import { 
  Calculator, 
  X, 
  Clock, 
  Fuel, 
  Wrench, 
  TrendingUp, 
  CheckCircle2, 
  ArrowRight,
  ShieldCheck
} from 'lucide-react';

interface RoiCalculatorModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const RoiCalculatorModal: React.FC<RoiCalculatorModalProps> = ({
  isOpen,
  onClose,
}) => {
  const [hourlyRate, setHourlyRate] = useState<number>(450); // ₹450/hour billable contractor/plumber rate
  const [tripsPerWeek, setTripsPerWeek] = useState<number>(4); // 4 store runs per week in traffic
  const [avgTripMinutes, setAvgTripMinutes] = useState<number>(50); // 50 mins per trip (traffic + parking + waiting)

  if (!isOpen) return null;

  // Calculations in INR
  const hoursWastedPerWeek = (tripsPerWeek * avgTripMinutes) / 60;
  const billableLossPerWeek = hoursWastedPerWeek * hourlyRate;
  const fuelAndWearPerWeek = tripsPerWeek * 80; // ₹80 per bike/auto trip
  const totalWeeklyLoss = billableLossPerWeek + fuelAndWearPerWeek;

  const rushQCostPerWeek = tripsPerWeek * 25; // ₹25 delivery fee
  const netWeeklySavings = totalWeeklyLoss - rushQCostPerWeek;
  const annualSavings = netWeeklySavings * 50;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs overflow-y-auto animate-in fade-in duration-200">
      <div className="bg-white border border-slate-200 rounded-3xl max-w-lg w-full p-5 sm:p-6 shadow-2xl text-slate-900 animate-in zoom-in-95 duration-200 space-y-4">
        
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-slate-100">
          <div className="flex items-center gap-2.5">
            <div className="w-10 h-10 rounded-2xl bg-amber-100 text-amber-800 flex items-center justify-center">
              <Calculator className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-black text-slate-900">
                Tradesperson Time & ROI Calculator
              </h2>
              <p className="text-xs text-slate-500 font-medium">
                Calculate earnings saved by staying on site instead of stuck in traffic
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

        {/* Sliders */}
        <div className="space-y-4 text-xs">
          
          {/* Hourly Rate */}
          <div className="space-y-1.5 bg-slate-50 p-3 rounded-2xl border border-slate-200/80">
            <div className="flex justify-between font-bold text-slate-700">
              <span>Your Billable Hourly Rate:</span>
              <span className="text-emerald-700 font-black text-sm">₹{hourlyRate}/hr</span>
            </div>
            <input
              type="range"
              min="200"
              max="1500"
              step="50"
              value={hourlyRate}
              onChange={(e) => setHourlyRate(Number(e.target.value))}
              className="w-full accent-emerald-600 cursor-pointer"
            />
          </div>

          {/* Trips per week */}
          <div className="space-y-1.5 bg-slate-50 p-3 rounded-2xl border border-slate-200/80">
            <div className="flex justify-between font-bold text-slate-700">
              <span>Hardware Market Trips per Week:</span>
              <span className="text-emerald-700 font-black text-sm">{tripsPerWeek} trips/wk</span>
            </div>
            <input
              type="range"
              min="1"
              max="15"
              step="1"
              value={tripsPerWeek}
              onChange={(e) => setTripsPerWeek(Number(e.target.value))}
              className="w-full accent-emerald-600 cursor-pointer"
            />
          </div>

          {/* Minutes per run */}
          <div className="space-y-1.5 bg-slate-50 p-3 rounded-2xl border border-slate-200/80">
            <div className="flex justify-between font-bold text-slate-700">
              <span>Average Time Spent per Store Run:</span>
              <span className="text-emerald-700 font-black text-sm">{avgTripMinutes} mins in traffic</span>
            </div>
            <input
              type="range"
              min="20"
              max="90"
              step="5"
              value={avgTripMinutes}
              onChange={(e) => setAvgTripMinutes(Number(e.target.value))}
              className="w-full accent-emerald-600 cursor-pointer"
            />
          </div>

        </div>

        {/* Results Banner */}
        <div className="bg-gradient-to-br from-emerald-700 to-teal-800 text-white p-4 sm:p-5 rounded-2xl shadow-sm space-y-2">
          <div className="text-[10px] uppercase font-black tracking-wider text-emerald-200">
            Net Value Recovered with RushQ:
          </div>
          <div className="flex items-baseline justify-between">
            <span className="text-2xl sm:text-3xl font-black font-mono">
              +₹{Math.round(netWeeklySavings).toLocaleString('en-IN')} <span className="text-xs font-sans font-medium text-emerald-100">/ week</span>
            </span>
            <span className="text-sm font-black text-amber-300">
              ₹{(annualSavings / 100000).toFixed(2)} Lakhs / yr
            </span>
          </div>
          <p className="text-[11px] text-emerald-100 leading-relaxed pt-1 border-t border-emerald-600/60">
            By receiving parts at your location via instant dispatch instead of manual store trips, you save <strong>{hoursWastedPerWeek.toFixed(1)} billable hours</strong> and ₹{Math.round(fuelAndWearPerWeek)} in bike/auto fuel each week.
          </p>
        </div>

        {/* Close Button */}
        <button
          onClick={onClose}
          className="w-full bg-emerald-700 hover:bg-emerald-800 text-white font-black py-3 rounded-xl text-xs transition cursor-pointer"
        >
          Got It, Back to Hardware Catalog
        </button>

      </div>
    </div>
  );
};
