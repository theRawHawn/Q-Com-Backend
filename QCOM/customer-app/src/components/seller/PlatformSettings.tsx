import React, { useState } from 'react';
import { CustomerPricingService } from '../../utils/customerPricingService';
import { IndianRupee, Save, Sparkles, AlertCircle, CheckCircle2, Sliders, ShieldCheck, Receipt } from 'lucide-react';

export const PlatformSettings: React.FC = () => {
  const currentConfig = CustomerPricingService.getAdminConfig();
  const [baseHandling, setBaseHandling] = useState<number>(currentConfig.handling_charge || 10);
  const [freeDeliveryThreshold, setFreeDeliveryThreshold] = useState<number>(currentConfig.free_delivery_threshold || 499);
  const [savedSuccess, setSavedSuccess] = useState<boolean>(false);

  // Calculate live GST breakdown for base handling charge
  const gstRate = 18;
  const gstAmount = Math.round(baseHandling * (gstRate / 100) * 100) / 100; // e.g., 1.80 for 10
  const preRoundingTotal = baseHandling + gstAmount; // 11.80
  const roundedTotal = Math.round(preRoundingTotal); // 12

  const handleSave = () => {
    CustomerPricingService.updateHandlingCharge(baseHandling);
    CustomerPricingService.updateAdminConfig({
      free_delivery_threshold: freeDeliveryThreshold
    });
    setSavedSuccess(true);
    setTimeout(() => setSavedSuccess(false), 3000);
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header Banner */}
      <div className="bg-slate-900 text-white rounded-3xl p-6 shadow-md border border-slate-800 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="bg-amber-400 text-slate-950 text-[10px] font-black px-2 py-0.5 rounded-full uppercase tracking-wider">
              Admin Control Panel
            </span>
            <span className="text-slate-400 text-xs font-mono">Pricing Version 2.4</span>
          </div>
          <h1 className="text-xl sm:text-2xl font-black tracking-tight text-white flex items-center gap-2">
            <Sliders className="w-6 h-6 text-amber-400" />
            <span>Platform Pricing & Handling Charge Settings</span>
          </h1>
          <p className="text-xs text-slate-300 font-medium max-w-xl">
            Configure default order handling fees, GST taxation, and customer delivery rules. Updates reflect instantly across cart checkout, receipts, and tax invoices.
          </p>
        </div>

        {savedSuccess && (
          <div className="bg-emerald-500/20 border border-emerald-400 text-emerald-300 px-4 py-2.5 rounded-2xl flex items-center gap-2 text-xs font-bold animate-in fade-in duration-200">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>Settings saved successfully!</span>
          </div>
        )}
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        
        {/* Card 1: Fixed Handling Charge Settings */}
        <div className="bg-white rounded-3xl border border-slate-200 p-6 shadow-xs space-y-5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-amber-50 border border-amber-200 flex items-center justify-center text-amber-600 font-bold shrink-0">
              <Receipt className="w-5 h-5 stroke-[2.5]" />
            </div>
            <div>
              <h2 className="text-base font-black text-slate-900">Fixed Handling Charges</h2>
              <p className="text-xs text-slate-500 font-medium">Applied to every customer order at checkout & invoice</p>
            </div>
          </div>

          <div className="space-y-4 pt-2">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1.5">
                Base Handling Charge (₹)
              </label>
              <div className="relative">
                <span className="absolute left-3.5 top-2.5 text-slate-400 font-bold text-sm">₹</span>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={baseHandling}
                  onChange={(e) => setBaseHandling(Math.max(0, Number(e.target.value) || 0))}
                  className="w-full bg-slate-50 border border-slate-200 rounded-2xl pl-8 pr-4 py-2 text-sm font-bold text-slate-900 focus:bg-white focus:border-amber-500 focus:outline-none transition"
                />
              </div>
              <p className="text-[11px] text-slate-400 font-medium mt-1">
                Base fee before statutory 18% GST calculation.
              </p>
            </div>

            {/* Live Calculation Box */}
            <div className="bg-slate-50 rounded-2xl border border-slate-200 p-4 space-y-2.5">
              <span className="text-[10px] uppercase font-black tracking-wider text-slate-400 block">
                Live Tax & Total Breakdown
              </span>
              
              <div className="space-y-1.5 text-xs">
                <div className="flex justify-between text-slate-600 font-medium">
                  <span>Base Handling Amount:</span>
                  <span className="font-mono font-bold text-slate-900">₹{baseHandling.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-slate-600 font-medium">
                  <span>GST Rate (18% Statutory):</span>
                  <span className="font-mono font-bold text-slate-900">₹{gstAmount.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-slate-500 text-[11px] font-mono pl-2 border-l-2 border-slate-300">
                  <span>• CGST (9%)</span>
                  <span>₹{(gstAmount / 2).toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-slate-500 text-[11px] font-mono pl-2 border-l-2 border-slate-300">
                  <span>• SGST (9%)</span>
                  <span>₹{(gstAmount / 2).toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-slate-600 font-medium pt-1 border-t border-slate-200">
                  <span>Calculated Gross:</span>
                  <span className="font-mono font-bold text-slate-900">₹{preRoundingTotal.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-emerald-800 font-extrabold bg-emerald-50 p-2 rounded-xl border border-emerald-200 text-sm">
                  <span>Customer Payable (Rounded):</span>
                  <span className="font-mono font-black text-emerald-700">₹{roundedTotal}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Card 2: Delivery Thresholds & Policy */}
        <div className="bg-white rounded-3xl border border-slate-200 p-6 shadow-xs space-y-5 flex flex-col justify-between">
          <div className="space-y-5">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl bg-emerald-50 border border-emerald-200 flex items-center justify-center text-emerald-700 font-bold shrink-0">
                <ShieldCheck className="w-5 h-5 stroke-[2.5]" />
              </div>
              <div>
                <h2 className="text-base font-black text-slate-900">Delivery Thresholds</h2>
                <p className="text-xs text-slate-500 font-medium">Set free delivery qualifications & minimum values</p>
              </div>
            </div>

            <div className="space-y-4 pt-2">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5">
                  Free Delivery Cart Value Threshold (₹)
                </label>
                <div className="relative">
                  <span className="absolute left-3.5 top-2.5 text-slate-400 font-bold text-sm">₹</span>
                  <input
                    type="number"
                    min="0"
                    step="50"
                    value={freeDeliveryThreshold}
                    onChange={(e) => setFreeDeliveryThreshold(Math.max(0, Number(e.target.value) || 0))}
                    className="w-full bg-slate-50 border border-slate-200 rounded-2xl pl-8 pr-4 py-2 text-sm font-bold text-slate-900 focus:bg-white focus:border-amber-500 focus:outline-none transition"
                  />
                </div>
                <p className="text-[11px] text-slate-400 font-medium mt-1">
                  Cart subtotal threshold to grant free delivery to customer.
                </p>
              </div>

              <div className="bg-amber-50/80 border border-amber-200 p-3.5 rounded-2xl text-xs text-amber-900 space-y-1">
                <div className="font-bold flex items-center gap-1.5 text-amber-950">
                  <Sparkles className="w-4 h-4 text-amber-600" />
                  <span>Invoice Synchronization Notice</span>
                </div>
                <p className="text-[11px] text-amber-800 leading-snug">
                  Both Handling Charges (<strong>₹{roundedTotal}</strong>) and Delivery Charges will appear as separate item lines on tax invoices issued to customers.
                </p>
              </div>
            </div>
          </div>

          <button
            onClick={handleSave}
            className="w-full bg-amber-400 hover:bg-amber-300 text-slate-950 font-black text-sm py-3 px-4 rounded-2xl shadow-md transition flex items-center justify-center gap-2 cursor-pointer mt-4"
          >
            <Save className="w-4 h-4 stroke-[2.5]" />
            <span>Save & Apply Settings</span>
          </button>
        </div>

      </div>
    </div>
  );
};
