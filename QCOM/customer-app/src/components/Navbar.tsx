import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  Search, ArrowLeft, 
  ChevronDown, 
  Camera, 
  Mic, 
  MicOff,
  Zap,
  User,
  X
} from 'lucide-react';
import { AddressLocation, CustomerProfile, TradeCategory } from '../types';
import { calculateDynamicDeliveryEta } from '../utils/deliveryEta';
import { MAIN_CATEGORIES } from '../data/categories';

interface NavbarProps {
  jobSite: AddressLocation;
  customerProfile: CustomerProfile;
  onOpenLocationModal: () => void;
  onOpenProfileModal: () => void;
  onOpenAiPartFinder: () => void;
  onOpenRoiCalculator?: () => void;
  onOpenToolboxRestock?: () => void;
  onOpenCart?: () => void;
  cartCount?: number;
  cartTotal?: number;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  selectedCategory: TradeCategory;
  onSelectCategory: (category: TradeCategory) => void;
  isGstFilterActive?: boolean;
  onToggleGstFilter?: () => void;
}

// Multilingual & colloquial speech cleanup (Hinglish, Kanglish, etc.)
function cleanSpokenSearchText(raw: string): string {
  let clean = raw.trim();
  if (!clean) return '';

  // Clean common search filler prefixes
  const prefixes = [
    /^search for\s+/i,
    /^find me\s+/i,
    /^look for\s+/i,
    /^i need\s+/i,
    /^show me\s+/i,
    /^mujhe chahiye\s+/i,
    /^mujhe\s+/i,
    /^dhoondo\s+/i,
    /^dikhao\s+/i,
    /^nange beku\s+/i,
    /^beku\s+/i,
    /^namage beku\s+/i,
    /^mala pahije\s+/i
  ];
  for (const prefix of prefixes) {
    if (prefix.test(clean)) {
      clean = clean.replace(prefix, '');
      break;
    }
  }

  // Clean trailing filler words
  const suffixes = [
    /\s+chahiye$/i,
    /\s+beku$/i,
    /\s+dikhao$/i,
    /\s+lao$/i,
    /\s+urgent$/i
  ];
  for (const suffix of suffixes) {
    if (suffix.test(clean)) {
      clean = clean.replace(suffix, '');
      break;
    }
  }

  return clean.trim();
}

export const Navbar: React.FC<NavbarProps> = ({
  jobSite,
  customerProfile,
  onOpenLocationModal,
  onOpenProfileModal,
  onOpenAiPartFinder,
  searchQuery,
  onSearchChange,
  selectedCategory,
  onSelectCategory,
}) => {
  const placeholders = [
    'Search "1/2 brass angle valve"',
    'Search "Bosch 1250W tile cutter machine"',
    'Search "4 inch diamond cutting disc"',
    'Search "Self-drilling hex head screws"',
    'Search "16A C-Curve MCB breaker"',
    'Search "Dewalt 4 inch angle grinder"',
    'Search "Fischer nylon wall plugs & screws"',
    'Search "Ultra-thin iron cutting wheel disc"',
  ];

  const [placeholderIndex, setPlaceholderIndex] = useState(0);
  const [isListening, setIsListening] = useState(false);
  const [voiceInterim, setVoiceInterim] = useState('');
  const [speechError, setSpeechError] = useState<string | null>(null);

  const recognitionRef = useRef<any>(null);
  const autoStopTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const interval = setInterval(() => {
      setPlaceholderIndex((prev) => (prev + 1) % placeholders.length);
    }, 2800);
    return () => clearInterval(interval);
  }, [placeholders.length]);

  // Clean stop of voice recognition
  const stopVoiceSearch = useCallback(() => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {}
    }
    setIsListening(false);
    setVoiceInterim('');
    if (autoStopTimeoutRef.current) {
      clearTimeout(autoStopTimeoutRef.current);
      autoStopTimeoutRef.current = null;
    }
  }, []);

  // Google-style voice-to-text trigger directly in search bar
  const startVoiceSearch = useCallback(() => {
    setSpeechError(null);
    setVoiceInterim('');

    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      setSpeechError('Voice recognition not supported in this browser.');
      setTimeout(() => setSpeechError(null), 3000);
      return;
    }

    try {
      if (recognitionRef.current) {
        try { recognitionRef.current.abort(); } catch {}
      }

      const recognition = new SpeechRecognition();
      recognition.continuous = false; // Auto-finishes when user pauses talking
      recognition.interimResults = true;
      // 'en-IN' provides superior recognition for Indian accents, Hinglish, Kanglish & tool names
      recognition.lang = 'en-IN';
      recognition.maxAlternatives = 1;

      recognition.onstart = () => {
        setIsListening(true);
      };

      recognition.onresult = (event: any) => {
        let interimTranscript = '';
        let finalTranscript = '';

        for (let i = event.resultIndex; i < event.results.length; ++i) {
          const item = event.results[i];
          if (item.isFinal) {
            finalTranscript += item[0].transcript;
          } else {
            interimTranscript += item[0].transcript;
          }
        }

        if (interimTranscript) {
          setVoiceInterim(interimTranscript);
          onSearchChange(interimTranscript);
        }

        if (finalTranscript) {
          const cleaned = cleanSpokenSearchText(finalTranscript);
          setVoiceInterim('');
          onSearchChange(cleaned || finalTranscript);
          setIsListening(false);
        }
      };

      recognition.onerror = (event: any) => {
        if (event.error !== 'no-speech') {
          console.warn('Speech error:', event.error);
        }
        setIsListening(false);
        setVoiceInterim('');
      };

      recognition.onend = () => {
        setIsListening(false);
        setVoiceInterim('');
      };

      recognitionRef.current = recognition;
      recognition.start();

      // Auto fallback timeout (max 10s of listening)
      if (autoStopTimeoutRef.current) clearTimeout(autoStopTimeoutRef.current);
      autoStopTimeoutRef.current = setTimeout(() => {
        stopVoiceSearch();
      }, 10000);

    } catch (err) {
      console.warn('Microphone error:', err);
      setIsListening(false);
      setVoiceInterim('');
    }
  }, [onSearchChange, stopVoiceSearch]);

  const toggleVoiceSearch = () => {
    if (isListening) {
      stopVoiceSearch();
    } else {
      startVoiceSearch();
    }
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        try { recognitionRef.current.abort(); } catch {}
      }
      if (autoStopTimeoutRef.current) {
        clearTimeout(autoStopTimeoutRef.current);
      }
    };
  }, []);

  // Real-time dynamic delivery ETA calculation based on current jobsite coordinates
  const liveEta = calculateDynamicDeliveryEta(jobSite.coordinates);
  const userInitial = customerProfile.name ? customerProfile.name.charAt(0).toUpperCase() : 'R';

  return (
    <header className="sticky top-0 z-40 w-full rounded-none bg-gradient-to-b from-[#F7D336] via-[#FAD845] to-[#FCE67E] border-b border-amber-400/60 shadow-xs text-slate-950 transition-all select-none">
      <div className="max-w-7xl mx-auto px-3 sm:px-6 pt-3 pb-2 space-y-2.5 sm:space-y-3">
        
        {/* Top Row: Logo, Delivery ETA, Address & Profile */}
        <div className="flex items-center justify-between gap-3">
          
          {/* Left Block: ETA + Location */}
          <div className="flex items-center gap-3 sm:gap-4 min-w-0 flex-1">
            {/* Delivery Info Block */}
            <div className="min-w-0 flex-1">
              {/* Big ETA Text with Lightning bolt */}
              <div className="flex items-center gap-1.5">
                <Zap className="w-5 h-5 sm:w-6 sm:h-6 md:w-7 md:h-7 text-slate-950 fill-slate-950 shrink-0 animate-bounce [animation-duration:1.5s]" />
                <h1 className="text-2xl sm:text-3xl md:text-4xl font-black text-slate-950 tracking-tight leading-none shrink-0">
                  {liveEta.etaMins} minutes
                </h1>
              </div>

              {/* Delivery Address Dropdown with reduced size and lower contrast */}
              <button
                onClick={onOpenLocationModal}
                id="navbar-address-modal-btn"
                className="mt-1 flex items-center gap-1 text-[11px] sm:text-xs font-semibold text-slate-900/90 hover:text-slate-950 transition cursor-pointer max-w-full sm:max-w-md group"
                title="Change Delivery Address"
              >
                <span className="font-extrabold uppercase tracking-tight text-slate-950 underline decoration-slate-950/40 underline-offset-2 shrink-0">
                  {jobSite.jobTag || 'DELIVER TO'}
                </span>
                <span className="text-slate-900/80 font-medium truncate max-w-[170px] sm:max-w-[280px] md:max-w-[380px]">
                  - {jobSite.floorUnit ? `${jobSite.floorUnit}, ` : ''}{jobSite.address}
                </span>
                <ChevronDown className="w-3 h-3 text-slate-950 group-hover:translate-y-0.5 transition shrink-0 ml-0.5" />
              </button>
            </div>
          </div>

          {/* Right Block: Account Profile Button */}
          <div className="flex items-center shrink-0">
            <button
              onClick={onOpenProfileModal}
              className="w-9 h-9 sm:w-10 sm:h-10 rounded-full bg-slate-950 text-white border border-amber-300 shadow-md flex items-center justify-center font-black text-sm hover:scale-105 active:scale-95 transition cursor-pointer"
              title="Account & Trade Profile"
            >
              {userInitial ? (
                <span className="text-sm font-black text-amber-300">{userInitial}</span>
              ) : (
                <User className="w-5 h-5 text-amber-300" />
              )}
            </button>
          </div>
        </div>

        {/* Search Bar Row: Spacious, Clean Floating Card */}
        <div className="relative">
          <div className={`flex items-center bg-white border rounded-2xl sm:rounded-full px-3.5 py-2.5 sm:py-3 shadow-md transition-all ${
            isListening 
              ? 'border-amber-500 ring-2 ring-amber-400/60 shadow-lg bg-amber-50/30' 
              : 'border-slate-200/90 focus-within:ring-2 focus-within:ring-slate-900 focus-within:shadow-lg'
          }`}>
            
            {/* Search or Creative Soundwave Equalizer Indicator */}
            {isListening ? (
              <div className="flex items-center gap-1.5 mr-2.5 shrink-0 px-1 py-0.5">
                {/* 5-Bar Dynamic Audio Waveform Equalizer (Clean, no container background) */}
                <div className="flex items-center gap-1 h-5">
                  <span className="w-1 rounded-full bg-amber-500 voice-wave-bar-1" />
                  <span className="w-1 rounded-full bg-orange-500 voice-wave-bar-2" />
                  <span className="w-1 rounded-full bg-slate-950 voice-wave-bar-3" />
                  <span className="w-1 rounded-full bg-amber-600 voice-wave-bar-4" />
                  <span className="w-1 rounded-full bg-emerald-600 voice-wave-bar-5" />
                </div>
              </div>
            ) : searchQuery ? (
              <button onClick={() => onSearchChange('')} className="mr-2.5 text-slate-800 hover:bg-slate-100 rounded-full p-1 -ml-1 transition cursor-pointer">
                <ArrowLeft className="w-5 h-5" />
              </button>
            ) : (
              <Search className="w-5 h-5 text-slate-800 shrink-0 mr-2.5" />
            )}

            {/* Input with real-time speech transcription */}
            <input
              id="quick-search-input"
              type="text"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder={
                isListening 
                  ? 'Listening... Speak now' 
                  : speechError || placeholders[placeholderIndex]
              }
              className={`w-full bg-transparent text-xs sm:text-sm md:text-base placeholder-slate-400 focus:outline-none font-semibold min-w-0 ${
                isListening ? 'text-slate-950 placeholder-slate-600 font-bold' : 'text-slate-900'
              }`}
            />

            {/* Right Action Buttons in Search Bar */}
            <div className="flex items-center gap-1.5 shrink-0 ml-1">
              
              {/* Clear button if active query */}
              {searchQuery && !isListening && (
                <button
                  onClick={() => onSearchChange('')}
                  className="p-1 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-full transition cursor-pointer flex items-center justify-center mr-0.5"
                  title="Clear search"
                >
                  <X className="w-4 h-4" />
                </button>
              )}

              {/* AI Photo Match / Camera Button */}
              <button
                onClick={onOpenAiPartFinder}
                className="bg-emerald-50 hover:bg-emerald-100 text-emerald-900 border border-emerald-300/80 font-black text-xs px-2.5 py-1.5 rounded-xl flex items-center gap-1.5 shrink-0 transition cursor-pointer shadow-2xs"
                title="Snap or upload hardware part photo for AI match"
              >
                <Camera className="w-4 h-4 text-emerald-700" />
                <span className="hidden sm:inline text-xs">AI Match</span>
              </button>

              {/* Voice Mic Button */}
              <button
                onClick={toggleVoiceSearch}
                className={`p-2 transition cursor-pointer rounded-full active:scale-95 relative flex items-center justify-center ${
                  isListening
                    ? 'bg-slate-950 text-amber-400 shadow-md ring-4 ring-amber-300/70'
                    : 'text-slate-700 hover:text-slate-950 hover:bg-amber-200/80'
                }`}
                title={isListening ? 'Tap to stop listening' : 'Voice Search'}
              >
                {isListening ? (
                  <MicOff className="w-4 h-4 text-amber-400 animate-pulse" />
                ) : (
                  <Mic className="w-4 h-4 text-slate-800 hover:text-slate-950 transition-transform" />
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Integrated Category Bar Row (Merged as one with Navbar) */}
        <div className="pt-0.5 pb-0.5">
          <div className="flex items-center gap-1.5 sm:gap-2 md:gap-3 overflow-x-auto py-1 scrollbar-none">
            {MAIN_CATEGORIES.map((cat) => {
              const isSelected = selectedCategory === cat.id;
              const Icon = cat.icon;

              return (
                <button
                  key={cat.id}
                  onClick={() => {
                    if (isSelected && cat.id !== 'all') {
                      onSelectCategory('all');
                    } else {
                      onSelectCategory(cat.id);
                    }
                  }}
                  className="flex-shrink-0 flex flex-col items-center justify-between min-w-[56px] sm:min-w-[66px] px-1.5 py-0.5 cursor-pointer group focus:outline-none transition-transform active:scale-95 relative"
                >
                  {/* Category Icon */}
                  <div className="relative flex items-center justify-center h-8 sm:h-9 w-8 sm:w-9 mb-0.5">
                    <Icon 
                      className={`transition-all duration-150 ${
                        isSelected 
                          ? 'w-6 h-6 sm:w-7 sm:h-7 text-slate-950 stroke-[2.4] drop-shadow-xs' 
                          : 'w-5 h-5 sm:w-6 sm:h-6 text-slate-900/80 group-hover:text-slate-950 stroke-[1.9] group-hover:scale-105'
                      }`} 
                    />

                    {/* Clear Filter Badge */}
                    {isSelected && cat.id !== 'all' && (
                      <div
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectCategory('all');
                        }}
                        className="absolute -top-1 -right-1.5 w-4 h-4 bg-slate-950 text-white hover:bg-rose-600 rounded-full flex items-center justify-center shadow-xs border border-white transition cursor-pointer"
                        title="Clear category filter"
                      >
                        <X className="w-2.5 h-2.5 stroke-[3]" />
                      </div>
                    )}
                  </div>

                  {/* Category Label */}
                  <span 
                    className={`text-[11px] sm:text-[12px] leading-tight tracking-tight text-center whitespace-nowrap transition-colors ${
                      isSelected 
                        ? 'text-slate-950 font-black' 
                        : 'text-slate-900 font-semibold group-hover:text-slate-950'
                    }`}
                  >
                    {cat.label}
                  </span>

                  {/* Bottom Indicator Bar */}
                  <div 
                    className={`h-[3px] rounded-full transition-all duration-200 mt-1 ${
                      isSelected 
                        ? 'w-7 sm:w-9 bg-slate-950 shadow-xs' 
                        : 'w-0 bg-transparent'
                    }`}
                  />
                </button>
              );
            })}
          </div>
        </div>

      </div>
    </header>
  );
};

