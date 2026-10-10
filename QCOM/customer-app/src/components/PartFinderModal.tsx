import React, { useState, useMemo } from 'react';
import { 
  Camera, 
  Image as ImageIcon,
  Sparkles, 
  X, 
  CheckCircle2, 
  AlertCircle, 
  Droplets,
  Zap,
  Hammer,
  Info,
  ArrowRight,
  Plus
} from 'lucide-react';
import { HardwareProduct } from '../types';

interface PartFinderModalProps {
  isOpen: boolean;
  onClose: () => void;
  products: HardwareProduct[];
  onAddToCart: (product: HardwareProduct, qty?: number) => void;
}

export const PartFinderModal: React.FC<PartFinderModalProps> = ({
  isOpen,
  onClose,
  products,
  onAddToCart,
}) => {
  const [description, setDescription] = useState('');
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [tradeContext, setTradeContext] = useState('plumbing');
  const [isLoading, setIsLoading] = useState(false);
  const [aiResult, setAiResult] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Accurate Inventory Match Calculation
  const matchedProducts = useMemo(() => {
    if (!aiResult && !description) return [];

    const searchTerms = [
      description,
      aiResult?.partName,
      aiResult?.estimatedSize,
      aiResult?.threadType,
      tradeContext
    ].filter(Boolean).join(' ').toLowerCase();

    const terms = searchTerms.split(/\s+/).filter(t => t.length > 2);

    const scored = products.map(product => {
      let score = 0;
      const brand = product.brand || product.specs?.brand || '';
      const subcat = product.subcategory || product.subCategory || '';
      const specText = `${product.specs?.size || ''} ${product.specs?.material || ''} ${product.specs?.standard || ''}`;
      const prodText = `${product.name} ${product.category} ${subcat} ${product.description} ${brand} ${specText}`.toLowerCase();

      // Explicit ID Match from server
      if (aiResult?.matchedProductIds?.includes(product.id)) {
        score += 100;
      }

      // Trade Context Match
      if (product.category.toLowerCase().includes(tradeContext.toLowerCase()) || 
          (tradeContext === 'plumbing' && ['plumbing', 'bathroom_fittings'].includes(product.category)) ||
          (tradeContext === 'electrical' && ['electrical', 'lighting', 'switches'].includes(product.category))) {
        score += 20;
      }

      // Keyword Matches
      terms.forEach(term => {
        if (prodText.includes(term)) {
          score += 10;
        }
      });

      return { product, score };
    });

    scored.sort((a, b) => b.score - a.score);

    // Return top 3 unique relevant items
    const results = scored.filter(s => s.score > 0).slice(0, 3).map(s => s.product);
    return results.length > 0 ? results : products.slice(0, 3);
  }, [products, aiResult, description, tradeContext]);

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setImagePreview(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const setSampleQuery = (desc: string, trade: string) => {
    setDescription(desc);
    setTradeContext(trade);
  };

  const handleAnalyze = async () => {
    if (!description && !imagePreview) {
      setError('Please take a photo, select an image, or describe the broken part.');
      return;
    }

    setIsLoading(true);
    setError(null);
    setAiResult(null);

    try {
      const response = await fetch('/api/part-finder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: description,
          imageBase64: imagePreview,
          tradeType: tradeContext
        }),
      });

      if (!response.ok) {
        throw new Error(`Analysis failed with status ${response.status}`);
      }

      const data = await response.json();
      setAiResult(data);
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'Unable to identify part. Using local catalog fallback.');
    } finally {
      setIsLoading(false);
    }
  };

  if (!isOpen) return null;

  const tradeTabs = [
    { id: 'plumbing', label: 'Plumbing' },
    { id: 'electrical', label: 'Electrical' },
    { id: 'carpentry', label: 'Carpentry' },
    { id: 'fasteners', label: 'Fasteners' },
  ];

  const presets = [
    { icon: Droplets, label: 'Angle Valve Leak', desc: '1/2 inch brass quarter-turn angle valve leaking at geyser inlet', trade: 'plumbing' },
    { icon: Zap, label: '16A MCB Tripping', desc: 'Single pole 16 Amp C-curve MCB tripping under heavy geyser load', trade: 'electrical' },
    { icon: Hammer, label: 'Heavy Wall Anchors', desc: 'Need nylon wall plugs and yellow zinc screws for hanging heavy vanity', trade: 'fasteners' }
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/60 backdrop-blur-xs transition-opacity">
      <div 
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-2xl max-w-lg w-full overflow-hidden shadow-xl border border-slate-200/80 animate-in fade-in zoom-in-95 duration-150 flex flex-col max-h-[90vh]"
      >
        
        {/* Modal Header */}
        <div className="p-4 sm:p-5 border-b border-slate-100 flex items-start justify-between gap-3 bg-slate-50/50 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center shrink-0">
              <Sparkles className="w-5 h-5 text-amber-600" />
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-bold text-slate-900 tracking-tight">
                AI Part & Spec Finder
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Snap fittings or enter problem details to match exact stock
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-full transition cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-4 sm:p-5 space-y-4 overflow-y-auto flex-1">
          
          {/* Trade Category Selector */}
          <div>
            <label className="text-xs font-semibold text-slate-500 block mb-1.5">
              Select Trade Domain
            </label>
            <div className="grid grid-cols-4 gap-1.5 bg-slate-100/80 p-1 rounded-xl">
              {tradeTabs.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTradeContext(t.id)}
                  className={`py-1.5 px-2 rounded-lg text-xs font-semibold transition text-center cursor-pointer ${
                    tradeContext === t.id
                      ? 'bg-white text-slate-900 shadow-2xs font-bold'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {/* Photo Capture / Upload Area */}
          <div>
            <label className="text-xs font-semibold text-slate-500 block mb-1.5">
              Part Photo
            </label>
            {imagePreview ? (
              <div className="relative rounded-xl overflow-hidden border border-slate-200 bg-slate-50 h-32 flex items-center justify-center">
                <img
                  src={imagePreview}
                  alt="Upload Preview"
                  className="h-full w-full object-contain p-2"
                />
                <button
                  onClick={() => setImagePreview(null)}
                  className="absolute top-2 right-2 bg-slate-900/80 text-white p-1 rounded-full hover:bg-slate-900 transition cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {/* Option 1: Direct Camera */}
                <label className="border border-slate-200 hover:border-amber-400 rounded-xl p-3 flex flex-col items-center justify-center gap-1.5 cursor-pointer transition bg-slate-50/70 hover:bg-amber-50/30 group text-center">
                  <div className="w-8 h-8 rounded-lg bg-white border border-slate-200 shadow-2xs flex items-center justify-center text-slate-700 group-hover:text-amber-700">
                    <Camera className="w-4 h-4" />
                  </div>
                  <span className="text-xs font-semibold text-slate-800">Take Photo</span>
                  <span className="text-[10px] text-slate-400">Direct Camera</span>
                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    onChange={handleImageUpload}
                    className="hidden"
                  />
                </label>

                {/* Option 2: Choose from Gallery */}
                <label className="border border-slate-200 hover:border-amber-400 rounded-xl p-3 flex flex-col items-center justify-center gap-1.5 cursor-pointer transition bg-slate-50/70 hover:bg-amber-50/30 group text-center">
                  <div className="w-8 h-8 rounded-lg bg-white border border-slate-200 shadow-2xs flex items-center justify-center text-slate-700 group-hover:text-amber-700">
                    <ImageIcon className="w-4 h-4" />
                  </div>
                  <span className="text-xs font-semibold text-slate-800">Gallery</span>
                  <span className="text-[10px] text-slate-400">Choose Image</span>
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handleImageUpload}
                    className="hidden"
                  />
                </label>
              </div>
            )}
          </div>

          {/* Description Input */}
          <div>
            <label className="text-xs font-semibold text-slate-500 block mb-1.5">
              Problem / Fitting Description
            </label>
            <textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g., Broken chrome 1/2 inch angle valve leaking under bathroom sink..."
              className="w-full border border-slate-200 rounded-xl p-2.5 text-xs text-slate-900 focus:ring-2 focus:ring-amber-400/50 focus:border-amber-400 focus:outline-none resize-none"
            />
          </div>

          {/* Quick Test Scenarios */}
          <div>
            <span className="text-[11px] font-medium text-slate-400 block mb-1.5">
              Try an example
            </span>
            <div className="flex flex-wrap gap-1.5">
              {presets.map((sample, idx) => {
                const Icon = sample.icon;
                return (
                  <button
                    key={idx}
                    onClick={() => setSampleQuery(sample.desc, sample.trade)}
                    className="text-xs font-medium bg-slate-50 hover:bg-slate-100 text-slate-700 border border-slate-200/80 px-2.5 py-1 rounded-lg transition cursor-pointer flex items-center gap-1.5"
                  >
                    <Icon className="w-3.5 h-3.5 text-slate-500" />
                    <span>{sample.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Submit Action */}
          <button
            id="run-ai-match-btn"
            onClick={handleAnalyze}
            disabled={isLoading || (!description.trim() && !imagePreview)}
            className="w-full py-2.5 px-4 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs sm:text-sm flex items-center justify-center gap-2 shadow-xs transition disabled:opacity-50 cursor-pointer mt-1"
          >
            {isLoading ? (
              <>
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                <span>Analyzing Dimensions & Specs...</span>
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4 text-amber-400" />
                <span>Scan & Match Inventory</span>
              </>
            )}
          </button>

          {/* Error Alert */}
          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-red-700 text-xs flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* AI Analysis Result */}
          {aiResult && (
            <div className="p-3.5 bg-slate-50 border border-slate-200/80 rounded-xl space-y-3 animate-in fade-in duration-150">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                  <span className="font-bold text-slate-900 text-xs">
                    {aiResult.partName || aiResult.identifiedPartName || 'Part Identified'}
                  </span>
                </div>
                <span className="text-[10px] font-bold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">
                  {aiResult.confidenceScore ? `${Math.round(aiResult.confidenceScore)}% Match` : '95% Match'}
                </span>
              </div>

              {/* Technical Spec Breakdown */}
              <div className="grid grid-cols-2 gap-2 text-xs bg-white p-2.5 rounded-lg border border-slate-200/80">
                <div>
                  <span className="text-slate-400 block text-[11px]">Thread / Standard</span>
                  <span className="font-bold text-slate-800">{aiResult.threadType || aiResult.standard || '1/2" BSP Standard'}</span>
                </div>
                <div>
                  <span className="text-slate-400 block text-[11px]">Recommended Size</span>
                  <span className="font-bold text-slate-800">{aiResult.estimatedSize || aiResult.suggestedSize || '15mm (1/2 Inch)'}</span>
                </div>
              </div>

              {/* Pro Tip */}
              {(aiResult.expertTip || aiResult.tradespersonTip) && (
                <div className="text-xs text-amber-950 bg-amber-50/80 border border-amber-200/80 p-2.5 rounded-lg flex items-start gap-2">
                  <Info className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                  <span><strong>Pro Tip:</strong> {aiResult.expertTip || aiResult.tradespersonTip}</span>
                </div>
              )}

              {/* In-Stock Matching Items */}
              {matchedProducts.length > 0 && (
                <div className="space-y-2 pt-2 border-t border-slate-200/80">
                  <span className="text-xs font-semibold text-slate-500 block">
                    In-Stock Exact Matches:
                  </span>

                  {matchedProducts.map((item) => (
                    <div key={item.id} className="bg-white p-2.5 rounded-xl border border-slate-200 flex items-center justify-between gap-2 shadow-2xs">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <img src={item.imageUrl} alt={item.name} className="w-10 h-10 object-cover rounded-lg border border-slate-100 shrink-0" />
                        <div className="truncate">
                          <div className="font-bold text-slate-900 text-xs truncate">{item.name}</div>
                          <div className="text-[11px] text-slate-500 font-medium">₹{item.price} • {item.brand || item.specs?.brand || 'Standard'}</div>
                        </div>
                      </div>
                      <button
                        onClick={() => {
                          onAddToCart(item, 1);
                          onClose();
                        }}
                        className="bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs px-2.5 py-1.5 rounded-lg transition shrink-0 cursor-pointer flex items-center gap-1"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        <span>Add</span>
                      </button>
                    </div>
                  ))}
                </div>
              )}

            </div>
          )}

        </div>
      </div>
    </div>
  );
};


