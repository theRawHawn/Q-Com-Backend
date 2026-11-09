import React, { useState } from 'react';
import {
  X,
  Radio,
  Send,
  CheckCircle2,
  AlertCircle,
  Zap,
  Users,
  MapPin,
  IndianRupee
} from 'lucide-react';
import { adminApi } from '../../utils/adminApiClient';

interface RiderBroadcastModalProps {
  onClose: () => void;
  selectedCity?: string;
  activeRiderCount: number;
}

export const RiderBroadcastModal: React.FC<RiderBroadcastModalProps> = ({
  onClose,
  selectedCity = 'all',
  activeRiderCount,
}) => {
  const [message, setMessage] = useState('');
  const [incentiveAmount, setIncentiveAmount] = useState<number>(0);
  const [targetScope, setTargetScope] = useState<'ALL' | 'CITY' | 'HIGH_DEMAND'>('ALL');
  const [isSending, setIsSending] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const quickTemplates = [
    { label: '⚡ Surge Incentive', text: 'Peak construction demand alert! Extra ₹50 surge bonus per order completed from local sellers in the next 90 minutes.', incentive: 50 },
    { label: '📦 High Order Backlog', text: 'Urgent: High volume of electrical & hardware items ready at local authorised sellers. All available riders requested to go online.', incentive: 25 },
    { label: '🌧️ Monsoon Safety Gear', text: 'Rain advisory: Ride carefully, use waterproof mobile cases and safety helmets. Emergency hotline is 24/7 active.', incentive: 0 },
    { label: '⛽ Battery Swap Alert', text: 'Battery swap points across Koramangala & HSR merchant areas have 100% charged battery packs ready.', incentive: 0 },
  ];

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim()) return;

    try {
      setIsSending(true);
      setErrorMessage(null);
      const res: any = await adminApi.post('/api/admin/riders/broadcast', {
        message,
        incentiveAmount: Number(incentiveAmount) || 0,
        zoneId: targetScope === 'CITY' ? selectedCity : targetScope,
      });

      if (res && res.success) {
        setSuccessMessage(`Broadcast delivered to ${res.sentCount || activeRiderCount} active fleet devices!`);
        setTimeout(() => {
          onClose();
        }, 1500);
      } else {
        setErrorMessage(res?.error || 'Failed to dispatch broadcast');
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Error transmitting message');
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-3 sm:p-5 overflow-y-auto">
      <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-lg max-h-[90vh] sm:max-h-[85vh] flex flex-col my-auto shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        <div className="px-6 py-4 bg-slate-50 border-b border-slate-200 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-emerald-50 rounded-lg text-emerald-600 border border-emerald-200">
              <Radio className="h-5 w-5 animate-pulse" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-900">Broadcast Fleet Push Alert</h2>
              <p className="text-[11px] text-slate-500">Transmits real-time audio/push notifications to active rider apps</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-700 rounded-lg hover:bg-slate-100 transition-colors">
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSend} className="flex-1 flex flex-col min-h-0 overflow-hidden">
          <div className="p-6 space-y-4 overflow-y-auto flex-1">
            {successMessage && (
              <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs rounded-xl flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
                <span>{successMessage}</span>
              </div>
            )}

            {errorMessage && (
              <div className="p-3 bg-rose-50 border border-rose-200 text-rose-800 text-xs rounded-xl flex items-center gap-2">
                <AlertCircle className="h-4 w-4 text-rose-600 shrink-0" />
                <span>{errorMessage}</span>
              </div>
            )}

            {/* Target Scope */}
            <div>
              <label className="text-xs font-semibold text-slate-700 block mb-1.5">Broadcast Target</label>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { id: 'ALL', label: 'All Online Riders', count: `${activeRiderCount} Active` },
                  { id: 'CITY', label: selectedCity !== 'all' ? selectedCity.toUpperCase() : 'Selected City', count: 'Geo Target' },
                  { id: 'HIGH_DEMAND', label: 'High Demand Hubs', count: 'Priority' },
                ].map((scope) => (
                  <button
                    key={scope.id}
                    type="button"
                    onClick={() => setTargetScope(scope.id as any)}
                    className={`p-2 rounded-xl text-left border text-xs transition-all ${
                      targetScope === scope.id
                        ? 'border-emerald-500 bg-emerald-50/50 text-emerald-900 font-bold'
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    <span className="block truncate">{scope.label}</span>
                    <span className="text-[10px] text-slate-500 font-mono block mt-0.5">{scope.count}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Quick Presets */}
            <div>
              <label className="text-xs font-semibold text-slate-700 block mb-1.5">Quick Presets</label>
              <div className="flex flex-wrap gap-1.5">
                {quickTemplates.map((tpl, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => {
                      setMessage(tpl.text);
                      setIncentiveAmount(tpl.incentive);
                    }}
                    className="px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-[11px] font-medium border border-slate-200 transition-colors"
                  >
                    {tpl.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Message Text */}
            <div>
              <label className="text-xs font-semibold text-slate-700 block mb-1">
                Broadcast Message Content <span className="text-rose-500">*</span>
              </label>
              <textarea
                rows={3}
                required
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Enter push alert text to broadcast to rider devices..."
                className="w-full bg-slate-50 border border-slate-300 rounded-xl p-3 text-xs text-slate-900 focus:bg-white focus:ring-1 focus:ring-emerald-500 font-medium"
              />
            </div>

            {/* Incentive Surge Attachment */}
            <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs">
                <Zap className="h-4 w-4 text-amber-500" />
                <div>
                  <span className="font-semibold text-slate-800 block">Surge Incentive Bonus</span>
                  <span className="text-[10px] text-slate-500">Credited automatically per trip</span>
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-slate-500 font-mono font-bold">₹</span>
                <input
                  type="number"
                  min="0"
                  step="5"
                  value={incentiveAmount}
                  onChange={(e) => setIncentiveAmount(Number(e.target.value))}
                  className="w-20 bg-white border border-slate-300 rounded-lg px-2 py-1 text-xs font-mono font-bold text-slate-900"
                />
              </div>
            </div>
          </div>

          <div className="px-6 py-3.5 bg-slate-50 border-t border-slate-200 flex items-center justify-end gap-2 shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-200/60 rounded-xl transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSending || !message.trim()}
              className="flex items-center gap-1.5 bg-[#009DE0] hover:bg-[#0087c2] text-white font-bold px-4 py-2 rounded-xl text-xs shadow-xs disabled:opacity-50 transition-all"
            >
              <Send className="h-3.5 w-3.5" />
              <span>{isSending ? 'Transmitting...' : 'Send Broadcast Now'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
