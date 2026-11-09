import React from 'react';

interface HandlingPlatformChargesModalProps {
  isOpen: boolean;
  onClose: () => void;
  handlingCharge?: number;
  platformFee?: number;
}

export const HandlingPlatformChargesModal: React.FC<HandlingPlatformChargesModalProps> = ({
  isOpen,
  onClose,
  handlingCharge = 12,
  platformFee = 13,
}) => {
  if (!isOpen) return null;

  return (
    <div 
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-[2px] animate-in fade-in duration-150"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div 
        className="bg-white w-full max-w-[340px] sm:max-w-[360px] rounded-2xl shadow-2xl p-5 border border-slate-100/80 animate-in zoom-in-95 duration-150"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Title */}
        <h3 className="font-bold text-[17px] text-slate-800 tracking-tight mb-4">
          GST &amp; Other Charges
        </h3>

        {/* Platform Fee */}
        <div className="space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-0.5 pr-2">
              <div className="font-semibold text-slate-700 text-[14px]">
                Platform Fee
              </div>
              <p className="text-[12px] text-slate-500 leading-snug">
                <span className="text-emerald-700 font-medium">Inclusive of GST.</span> This fee helps us operate and maintain platform
              </p>
            </div>
            <div className="text-right shrink-0">
              <span className="font-semibold text-[15px] text-slate-800 font-mono">
                ₹{platformFee}
              </span>
            </div>
          </div>

          {/* Handling Charges (in place of Restaurant GST) without subtext */}
          <div className="flex items-center justify-between gap-3 pt-1">
            <div className="space-y-0.5 pr-2">
              <div className="font-semibold text-slate-700 text-[14px]">
                Handling Charges
              </div>
            </div>
            <div className="text-right shrink-0">
              <span className="font-semibold text-[15px] text-slate-800 font-mono">
                ₹{handlingCharge}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
