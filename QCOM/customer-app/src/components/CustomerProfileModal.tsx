import React, { useState, useEffect, useRef } from 'react';
import { 
  X, 
  Building2, 
  Receipt, 
  CheckCircle2, 
  ShieldCheck, 
  AlertCircle, 
  Sparkles, 
  Download, 
  ExternalLink, 
  User, 
  Phone, 
  Mail, 
  MapPin, 
  FileText,
  Percent,
  TrendingUp,
  ArrowRight,
  ArrowLeft,
  KeyRound,
  RotateCw,
  LogOut,
  Plus,
  Home,
  Briefcase,
  Check
} from 'lucide-react';
import { CustomerProfile, CustomerGstProfile, Order, AddressLocation } from '../types';

interface CustomerProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
  profile: CustomerProfile;
  onSaveProfile: (profile: CustomerProfile) => void;
  orders: Order[];
  onOpenOrderTracking: (orderId: string) => void;
  onUpdateJobSite?: (jobSite: AddressLocation) => void;
}

type OnboardingStep = 'phone_entry' | 'otp_verify' | 'profile_form';
type ProfileTab = 'personal' | 'b2b_gst' | 'invoices';

export const CustomerProfileModal: React.FC<CustomerProfileModalProps> = ({
  isOpen,
  onClose,
  profile,
  onSaveProfile,
  orders,
  onOpenOrderTracking,
  onUpdateJobSite
}) => {
  // Check if this profile has already completed phone verification & registration
  const isExistingAccount = Boolean(profile.isPhoneVerified && profile.name);

  // Mode: if existing, show 'dashboard', else show onboarding flow
  const [viewMode, setViewMode] = useState<'dashboard' | 'onboarding'>(
    isExistingAccount ? 'dashboard' : 'onboarding'
  );

  // Onboarding Step State
  const [onboardingStep, setOnboardingStep] = useState<OnboardingStep>('phone_entry');
  const [inputPhone, setInputPhone] = useState(profile.phone || '');
  const [otpDigits, setOtpDigits] = useState(['', '', '', '']);
  const [resendTimer, setResendTimer] = useState(30);
  const [isTimerRunning, setIsTimerRunning] = useState(false);
  const [otpError, setOtpError] = useState<string | null>(null);
  const [isVerifyingOtp, setIsVerifyingOtp] = useState(false);

  // Form Fields (used in both onboarding & dashboard)
  const [name, setName] = useState(profile.name || '');
  const [email, setEmail] = useState(profile.email || '');
  const [accountType, setAccountType] = useState<'individual' | 'business'>(
    profile.accountType || (profile.gstProfile?.isB2BEnabled ? 'business' : 'individual')
  );
  
  // Drop Location Fields
  const [address, setAddress] = useState(profile.defaultAddress || '14th Main, 4th Block, Koramangala, Bengaluru');
  const [floorUnit, setFloorUnit] = useState(profile.floorUnit || 'Tower B, 4th Floor, Flat 402');
  const [landmark, setLandmark] = useState(profile.landmark || 'Opposite BDA Complex, Gate #2');

  // B2B GST Fields
  const [isB2BEnabled, setIsB2BEnabled] = useState(profile.gstProfile?.isB2BEnabled || false);
  const [gstin, setGstin] = useState(profile.gstProfile?.gstin || '');
  const [legalBusinessName, setLegalBusinessName] = useState(profile.gstProfile?.legalBusinessName || '');
  const [tradeName, setTradeName] = useState(profile.gstProfile?.tradeName || '');
  const [billingAddress, setBillingAddress] = useState(profile.gstProfile?.billingAddress || '');
  const [stateName, setStateName] = useState(profile.gstProfile?.state || 'Karnataka');
  const [stateCode, setStateCode] = useState(profile.gstProfile?.stateCode || '29');
  
  // UI states
  const [gstError, setGstError] = useState<string | null>(null);
  const [savedSuccess, setSavedSuccess] = useState(false);
  const [activeTab, setActiveTab] = useState<ProfileTab>('personal');

  const otpInputRefs = [
    useRef<HTMLInputElement>(null),
    useRef<HTMLInputElement>(null),
    useRef<HTMLInputElement>(null),
    useRef<HTMLInputElement>(null),
  ];

  // Sync state when profile prop changes
  useEffect(() => {
    if (profile.name && profile.isPhoneVerified) {
      setViewMode('dashboard');
      setName(profile.name);
      setInputPhone(profile.phone);
      setEmail(profile.email);
      setAccountType(profile.accountType || (profile.gstProfile?.isB2BEnabled ? 'business' : 'individual'));
      setIsB2BEnabled(profile.gstProfile?.isB2BEnabled || false);
      setGstin(profile.gstProfile?.gstin || '');
      setLegalBusinessName(profile.gstProfile?.legalBusinessName || '');
      setTradeName(profile.gstProfile?.tradeName || '');
      setBillingAddress(profile.gstProfile?.billingAddress || '');
      setStateName(profile.gstProfile?.state || 'Karnataka');
      setStateCode(profile.gstProfile?.stateCode || '29');
      if (profile.defaultAddress) setAddress(profile.defaultAddress);
      if (profile.floorUnit) setFloorUnit(profile.floorUnit);
      if (profile.landmark) setLandmark(profile.landmark);
    }
  }, [profile]);

  // Resend Timer Countdown
  useEffect(() => {
    let interval: any;
    if (isTimerRunning && resendTimer > 0) {
      interval = setInterval(() => {
        setResendTimer(prev => prev - 1);
      }, 1000);
    } else if (resendTimer === 0) {
      setIsTimerRunning(false);
    }
    return () => clearInterval(interval);
  }, [isTimerRunning, resendTimer]);

  if (!isOpen) return null;

  // Phone Validation
  const cleanPhoneDigits = inputPhone.replace(/\D/g, '');
  const isValidPhone = cleanPhoneDigits.length === 10 || cleanPhoneDigits.length === 12;

  // Indian GSTIN Validator
  const validateGstin = (val: string) => {
    const clean = val.trim().toUpperCase();
    const gstRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
    if (!clean) {
      setGstError(null);
      return false;
    }
    if (clean.length !== 15) {
      setGstError('GSTIN must be exactly 15 alphanumeric characters.');
      return false;
    }
    if (!gstRegex.test(clean)) {
      setGstError('Invalid GSTIN format (e.g. 29AABCP1429B1Z8).');
      return false;
    }
    setGstError(null);
    return true;
  };

  const handleGstinChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value.toUpperCase();
    setGstin(val);
    if (val.length >= 2) {
      const code = val.slice(0, 2);
      setStateCode(code);
      if (code === '29') setStateName('Karnataka');
      else if (code === '27') setStateName('Maharashtra');
      else if (code === '07') setStateName('Delhi');
      else if (code === '33') setStateName('Tamil Nadu');
      else if (code === '36') setStateName('Telangana');
      else if (code === '24') setStateName('Gujarat');
    }
    if (val.length === 15) {
      validateGstin(val);
    }
  };

  const handleFillSampleGstin = () => {
    const sampleGst = '29AABCP1429B1Z8';
    setGstin(sampleGst);
    setLegalBusinessName('Kulkarni Infra & Electrical Solutions LLP');
    setTradeName('Kulkarni MEP Works');
    setBillingAddress('#45, 14th Main, 4th Block, Koramangala, Bengaluru, Karnataka - 560034');
    setStateName('Karnataka');
    setStateCode('29');
    setIsB2BEnabled(true);
    setAccountType('business');
    setGstError(null);
  };

  // Step 1: Send OTP
  const handleSendOtp = (phoneNumber?: string) => {
    const targetPhone = phoneNumber || inputPhone;
    if (!targetPhone) return;
    setInputPhone(targetPhone);
    setOtpDigits(['', '', '', '']);
    setOtpError(null);
    setOnboardingStep('otp_verify');
    setResendTimer(30);
    setIsTimerRunning(true);
    // Focus first OTP input
    setTimeout(() => {
      otpInputRefs[0].current?.focus();
    }, 100);
  };

  // OTP Input Handler
  const handleOtpDigitChange = (index: number, val: string) => {
    if (!/^\d*$/.test(val)) return;
    const newDigits = [...otpDigits];
    newDigits[index] = val.slice(-1);
    setOtpDigits(newDigits);
    setOtpError(null);

    // Auto-advance
    if (val && index < 3) {
      otpInputRefs[index + 1].current?.focus();
    }

    // Auto-verify if all 4 entered
    if (index === 3 && val) {
      const fullOtp = [...newDigits.slice(0, 3), val.slice(-1)].join('');
      if (fullOtp.length === 4) {
        verifyOtp(fullOtp);
      }
    }
  };

  const handleOtpKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !otpDigits[index] && index > 0) {
      otpInputRefs[index - 1].current?.focus();
    }
  };

  // Step 2: Verify OTP
  const verifyOtp = (codeToVerify?: string) => {
    const otp = codeToVerify || otpDigits.join('');
    if (otp.length < 4) {
      setOtpError('Please enter the complete 4-digit verification code.');
      return;
    }

    setIsVerifyingOtp(true);
    setTimeout(() => {
      setIsVerifyingOtp(false);
      // Demo accepts 4829 or any 4 digit code for testing
      setOnboardingStep('profile_form');
    }, 600);
  };

  const handleAutoFillDemoOtp = () => {
    const demo = ['4', '8', '2', '9'];
    setOtpDigits(demo);
    verifyOtp('4829');
  };

  // Step 3: Complete Account Creation
  const handleCompleteAccountCreation = () => {
    if (!name.trim()) {
      alert('Please enter your full name');
      return;
    }

    if (accountType === 'business' && isB2BEnabled && gstin) {
      if (!validateGstin(gstin)) return;
      if (!legalBusinessName.trim()) {
        setGstError('Please enter Legal Business Name for B2B billing.');
        return;
      }
    }

    let existingSaved = profile.gstProfile?.savedGstins || [];
    const cleanGst = gstin.trim().toUpperCase();
    if (cleanGst && !existingSaved.some(g => g.gstin === cleanGst)) {
      existingSaved = [
        ...existingSaved,
        {
          id: `gst_${Date.now()}`,
          gstin: cleanGst,
          legalBusinessName: legalBusinessName.trim() || name.trim(),
          tradeName: tradeName.trim() || legalBusinessName.trim() || name.trim(),
          billingAddress: billingAddress.trim() || address,
          state: stateName,
          stateCode: stateCode,
          isDefault: existingSaved.length === 0
        }
      ];
    }

    const updatedGstProfile: CustomerGstProfile = {
      isB2BEnabled: accountType === 'business' || isB2BEnabled,
      gstin: cleanGst,
      legalBusinessName: legalBusinessName.trim(),
      tradeName: tradeName.trim(),
      billingAddress: billingAddress.trim() || address,
      state: stateName,
      stateCode: stateCode,
      contactPerson: name,
      contactEmail: email,
      savedGstins: existingSaved
    };

    const formattedPhone = inputPhone.startsWith('+91') 
      ? inputPhone 
      : `+91 ${cleanPhoneDigits.slice(-10)}`;

    const newProfile: CustomerProfile = {
      id: profile.id || `cust-${Date.now()}`,
      name: name.trim(),
      phone: formattedPhone,
      email: email.trim() || `${name.toLowerCase().replace(/\s+/g, '')}@gmail.com`,
      isPhoneVerified: true,
      accountType,
      defaultAddress: address,
      floorUnit,
      landmark,
      gstProfile: updatedGstProfile,
      createdAt: profile.createdAt || new Date().toISOString()
    };

    onSaveProfile(newProfile);

    // Also update active drop location in App
    if (onUpdateJobSite) {
      onUpdateJobSite({
        address,
        floorUnit,
        landmark,
        siteContactName: name.trim(),
        sitePhone: formattedPhone,
        jobTag: `${name.split(' ')[0]}'s Drop Location`,
        coordinates: {
          lat: 12.9352,
          lng: 77.6245
        }
      });
    }

    setViewMode('dashboard');
    setSavedSuccess(true);
    setTimeout(() => setSavedSuccess(false), 2500);
  };

  // Update existing profile
  const handleSaveDashboard = () => {
    handleCompleteAccountCreation();
  };

  // Total ITC claimed
  const totalItcClaimed = orders.reduce((acc, order) => {
    const itc = order.itcAmount || (order.tax ? Math.round(order.tax * 0.9) : 0);
    return acc + itc;
  }, 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/65 backdrop-blur-xs">
      <div 
        className="bg-white w-full max-w-xl rounded-3xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col max-h-[92vh] animate-in fade-in zoom-in-95 duration-150"
      >
        
        {/* ========================================================= */}
        {/* VIEW 1: ONBOARDING / ACCOUNT CREATION WITH MOBILE OTP     */}
        {/* ========================================================= */}
        {viewMode === 'onboarding' && (
          <div className="flex flex-col flex-1 overflow-y-auto">
            
            {/* Header with Step Indicator */}
            <div className="p-4 sm:p-5 border-b border-slate-100 bg-slate-50/80 flex items-center justify-between">
              <div className="flex items-center gap-3">
                {onboardingStep !== 'phone_entry' && (
                  <button
                    onClick={() => {
                      if (onboardingStep === 'otp_verify') setOnboardingStep('phone_entry');
                      if (onboardingStep === 'profile_form') setOnboardingStep('otp_verify');
                    }}
                    className="w-8 h-8 rounded-full bg-white border border-slate-200 flex items-center justify-center text-slate-700 hover:bg-slate-100 transition cursor-pointer"
                  >
                    <ArrowLeft className="w-4 h-4" />
                  </button>
                )}
                
                <div>
                  <div className="flex items-center gap-2">
                    <div className="flex items-baseline font-black text-base text-slate-900">
                      <span>blink</span>
                      <span className="text-emerald-600">it</span>
                    </div>
                    <span className="bg-amber-400 text-zinc-950 text-[9px] font-black uppercase px-1.5 py-0.5 rounded">
                      BUYER ACCOUNT
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {onboardingStep === 'phone_entry' && 'Step 1 of 3: Enter your mobile number'}
                    {onboardingStep === 'otp_verify' && 'Step 2 of 3: Verify with instant OTP'}
                    {onboardingStep === 'profile_form' && 'Step 3 of 3: Complete your buyer profile'}
                  </p>
                </div>
              </div>

              <button
                onClick={onClose}
                className="w-8 h-8 rounded-full bg-white border border-slate-200 flex items-center justify-center text-slate-500 hover:bg-slate-100 hover:text-slate-900 transition cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Step Progress Bar */}
            <div className="w-full bg-slate-100 h-1 flex">
              <div 
                className={`bg-emerald-600 h-full transition-all duration-300 ${
                  onboardingStep === 'phone_entry' ? 'w-1/3' : 
                  onboardingStep === 'otp_verify' ? 'w-2/3' : 'w-full'
                }`} 
              />
            </div>

            {/* STEP 1: Phone Number Input */}
            {onboardingStep === 'phone_entry' && (
              <div className="p-5 sm:p-7 space-y-6">
                
                {/* Hero Feature Callout */}
                <div className="bg-gradient-to-br from-emerald-800 to-slate-900 text-white rounded-2xl p-5 shadow-sm space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-ping" />
                    <span className="font-extrabold text-sm tracking-wide">
                      India's 1st Hyperlocal RushQ App
                    </span>
                  </div>
                  <h3 className="text-base sm:text-lg font-black text-white leading-tight">
                    Get CPVC pipes, MCBs, brass valves & fasteners delivered in minutes.
                  </h3>
                  <p className="text-xs text-emerald-100/90 leading-relaxed">
                    Sign in with your mobile number to track live couriers, save drop locations, and claim 18% GST Input Tax Credit (ITC).
                  </p>
                </div>

                {/* Phone Input Box */}
                <div className="space-y-3">
                  <label className="block font-bold text-slate-800 text-xs uppercase tracking-wider">
                    Enter Mobile Phone Number
                  </label>

                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1 bg-slate-100 border border-slate-300 rounded-2xl px-3.5 py-3 text-sm font-bold text-slate-700 select-none">
                      <span className="text-base">🇮🇳</span>
                      <span>+91</span>
                    </div>

                    <input
                      type="tel"
                      maxLength={14}
                      value={inputPhone}
                      onChange={(e) => setInputPhone(e.target.value)}
                      placeholder="98450 12891"
                      className="flex-1 bg-slate-50 border border-slate-300 focus:border-emerald-600 focus:ring-2 focus:ring-emerald-500/20 rounded-2xl px-4 py-3 text-sm sm:text-base font-bold text-slate-900 tracking-wider focus:outline-none"
                    />
                  </div>

                  <p className="text-[11px] text-slate-500">
                    We will send a 4-digit verification code via SMS to confirm your account.
                  </p>
                </div>

                {/* Quick Demo Test Number Chips */}
                <div className="space-y-2 pt-2 border-t border-slate-100">
                  <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">
                    ⚡ Quick Demo Test Numbers
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {[
                      { label: 'Rahul Sharma (MEP Contractor)', num: '+91 98450 12891' },
                      { label: 'Rohan Kulkarni (Home Builder)', num: '+91 99887 76655' }
                    ].map((demo, idx) => (
                      <button
                        key={idx}
                        type="button"
                        onClick={() => handleSendOtp(demo.num)}
                        className="bg-slate-100 hover:bg-emerald-50 hover:border-emerald-300 border border-slate-200 text-slate-700 hover:text-emerald-900 font-bold text-xs px-3 py-2 rounded-xl transition cursor-pointer text-left flex items-center justify-between gap-2"
                      >
                        <span>{demo.label}</span>
                        <span className="font-mono text-[11px] text-slate-500">{demo.num}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Continue CTA */}
                <button
                  type="button"
                  onClick={() => handleSendOtp()}
                  disabled={!inputPhone.trim()}
                  className="w-full bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 text-white font-black text-sm py-3.5 rounded-2xl transition shadow-sm cursor-pointer flex items-center justify-center gap-2"
                >
                  <span>Get Verification Code (OTP)</span>
                  <ArrowRight className="w-4 h-4" />
                </button>

              </div>
            )}

            {/* STEP 2: OTP Verification Screen */}
            {onboardingStep === 'otp_verify' && (
              <div className="p-5 sm:p-7 space-y-6">
                
                {/* Number Confirmation & Edit */}
                <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-emerald-100 text-emerald-800 flex items-center justify-center font-black">
                      <Phone className="w-5 h-5" />
                    </div>
                    <div>
                      <div className="text-xs text-slate-500 font-medium">OTP sent to mobile</div>
                      <div className="font-black text-sm text-slate-900 font-mono">{inputPhone}</div>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => setOnboardingStep('phone_entry')}
                    className="text-xs font-bold text-emerald-700 hover:text-emerald-800 underline cursor-pointer"
                  >
                    Change Number
                  </button>
                </div>

                {/* Demo OTP Auto-fill Banner */}
                <div 
                  onClick={handleAutoFillDemoOtp}
                  className="bg-amber-50 border border-amber-300 hover:bg-amber-100 rounded-2xl p-3.5 cursor-pointer transition flex items-center justify-between gap-3 shadow-2xs group"
                >
                  <div className="flex items-center gap-2.5">
                    <KeyRound className="w-5 h-5 text-amber-700" />
                    <div>
                      <div className="text-xs font-extrabold text-amber-950">
                        ⚡ Demo Testing OTP: <span className="font-mono text-sm bg-amber-200 px-1.5 py-0.5 rounded font-black text-zinc-950">4829</span>
                      </div>
                      <div className="text-[11px] text-amber-900 mt-0.5">
                        Click anywhere on this box to 1-click auto-fill & verify
                      </div>
                    </div>
                  </div>
                  <span className="text-xs font-black text-amber-900 uppercase bg-amber-200 px-2.5 py-1 rounded-lg group-hover:bg-amber-300 transition">
                    Auto Fill
                  </span>
                </div>

                {/* 4-Box OTP Input */}
                <div className="space-y-3">
                  <label className="block font-bold text-slate-800 text-xs uppercase tracking-wider text-center">
                    Enter 4-Digit Verification Code
                  </label>

                  <div className="flex justify-center gap-3">
                    {otpDigits.map((digit, idx) => (
                      <input
                        key={idx}
                        ref={otpInputRefs[idx]}
                        type="text"
                        inputMode="numeric"
                        maxLength={1}
                        value={digit}
                        onChange={(e) => handleOtpDigitChange(idx, e.target.value)}
                        onKeyDown={(e) => handleOtpKeyDown(idx, e)}
                        className={`w-13 h-14 text-center text-2xl font-black rounded-2xl border ${
                          digit ? 'border-emerald-600 bg-emerald-50 text-emerald-950' : 'border-slate-300 bg-slate-50 text-slate-900'
                        } focus:outline-none focus:ring-2 focus:ring-emerald-500 font-mono`}
                      />
                    ))}
                  </div>

                  {otpError && (
                    <p className="text-center text-red-600 font-bold text-xs mt-2 flex items-center justify-center gap-1">
                      <AlertCircle className="w-3.5 h-3.5" />
                      <span>{otpError}</span>
                    </p>
                  )}
                </div>

                {/* Resend Timer */}
                <div className="flex items-center justify-between text-xs text-slate-500 pt-2">
                  <span>Didn't receive SMS?</span>
                  {isTimerRunning ? (
                    <span className="font-mono font-bold text-slate-600">
                      Resend in {resendTimer}s
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleSendOtp()}
                      className="font-bold text-emerald-700 hover:text-emerald-800 underline cursor-pointer flex items-center gap-1"
                    >
                      <RotateCw className="w-3 h-3" />
                      <span>Resend OTP</span>
                    </button>
                  )}
                </div>

                {/* Verify Button */}
                <button
                  type="button"
                  onClick={() => verifyOtp()}
                  disabled={isVerifyingOtp}
                  className="w-full bg-emerald-700 hover:bg-emerald-800 text-white font-black text-sm py-3.5 rounded-2xl transition shadow-sm cursor-pointer flex items-center justify-center gap-2"
                >
                  {isVerifyingOtp ? (
                    <span>Verifying Code...</span>
                  ) : (
                    <>
                      <CheckCircle2 className="w-4 h-4" />
                      <span>Verify & Proceed to Profile Setup</span>
                    </>
                  )}
                </button>

              </div>
            )}

            {/* STEP 3: Complete Buyer Profile Form */}
            {onboardingStep === 'profile_form' && (
              <div className="p-5 sm:p-7 space-y-5">
                
                <div className="bg-emerald-50 border border-emerald-300 rounded-2xl p-3.5 flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl bg-emerald-700 text-white flex items-center justify-center">
                    <Check className="w-5 h-5" />
                  </div>
                  <div>
                    <div className="font-black text-xs text-emerald-950">Mobile Number Verified</div>
                    <div className="text-[11px] text-emerald-800 font-mono">{inputPhone}</div>
                  </div>
                </div>

                {/* Full Name */}
                <div>
                  <label className="block font-bold text-slate-800 text-xs mb-1">
                    Your Full Name *
                  </label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Rahul Sharma"
                    className="w-full bg-slate-50 border border-slate-300 focus:border-emerald-600 focus:ring-2 focus:ring-emerald-500/20 rounded-xl p-3 text-xs sm:text-sm font-bold text-slate-900 focus:outline-none"
                  />
                </div>

                {/* Email Address */}
                <div>
                  <label className="block font-bold text-slate-800 text-xs mb-1">
                    Email Address (For Tax Invoices & Order Receipts)
                  </label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="e.g. rahul.sharma@apexmep.in"
                    className="w-full bg-slate-50 border border-slate-300 focus:border-emerald-600 focus:ring-2 focus:ring-emerald-500/20 rounded-xl p-3 text-xs text-slate-900 focus:outline-none"
                  />
                </div>

                {/* Drop Location / Default Address */}
                <div className="space-y-3 pt-2 border-t border-slate-100">
                  <div className="flex items-center gap-1.5 font-black text-slate-900 text-xs uppercase tracking-wider">
                    <MapPin className="w-3.5 h-3.5 text-emerald-700" />
                    <span>Default Drop Location</span>
                  </div>

                  <div>
                    <label className="block font-bold text-slate-700 text-[11px] mb-1">
                      Street / Area Address *
                    </label>
                    <input
                      type="text"
                      value={address}
                      onChange={(e) => setAddress(e.target.value)}
                      placeholder="e.g. 14th Main, 4th Block, Koramangala, Bengaluru"
                      className="w-full bg-slate-50 border border-slate-300 rounded-xl p-2.5 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    <div>
                      <label className="block font-bold text-slate-700 text-[11px] mb-1">
                        Floor / Unit / Flat #
                      </label>
                      <input
                        type="text"
                        value={floorUnit}
                        onChange={(e) => setFloorUnit(e.target.value)}
                        placeholder="e.g. Tower B, 4th Floor, Flat 402"
                        className="w-full bg-slate-50 border border-slate-300 rounded-xl p-2.5 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                      />
                    </div>

                    <div>
                      <label className="block font-bold text-slate-700 text-[11px] mb-1">
                        Landmark / Gate Instructions
                      </label>
                      <input
                        type="text"
                        value={landmark}
                        onChange={(e) => setLandmark(e.target.value)}
                        placeholder="e.g. Opposite BDA Complex, Gate #2"
                        className="w-full bg-slate-50 border border-slate-300 rounded-xl p-2.5 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                      />
                    </div>
                  </div>
                </div>

                {/* Account Type Selector (Individual vs Business B2B GSTIN) */}
                <div className="space-y-3 pt-2 border-t border-slate-100">
                  <label className="block font-bold text-slate-800 text-xs uppercase tracking-wider">
                    Buyer Account Type
                  </label>

                  <div className="grid grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={() => {
                        setAccountType('individual');
                        setIsB2BEnabled(false);
                      }}
                      className={`p-3 rounded-2xl border text-left transition cursor-pointer ${
                        accountType === 'individual'
                          ? 'border-emerald-700 bg-emerald-50/80 ring-2 ring-emerald-500/20'
                          : 'border-slate-200 bg-white hover:bg-slate-50'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <Home className="w-4 h-4 text-slate-700" />
                        <span className="font-black text-xs text-slate-900">Personal / Home</span>
                      </div>
                      <p className="text-[10px] text-slate-500 mt-1">
                        For DIY repairs, home renovations & emergency fixes
                      </p>
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setAccountType('business');
                        setIsB2BEnabled(true);
                      }}
                      className={`p-3 rounded-2xl border text-left transition cursor-pointer ${
                        accountType === 'business'
                          ? 'border-emerald-700 bg-emerald-50/80 ring-2 ring-emerald-500/20'
                          : 'border-slate-200 bg-white hover:bg-slate-50'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <Briefcase className="w-4 h-4 text-emerald-800" />
                        <span className="font-black text-xs text-slate-900">Contractor / B2B</span>
                      </div>
                      <p className="text-[10px] text-slate-500 mt-1">
                        Claim 18% GST Input Tax Credit (ITC) with GSTIN
                      </p>
                    </button>
                  </div>
                </div>

                {/* B2B GSTIN Section if Business Account */}
                {accountType === 'business' && (
                  <div className="bg-slate-50 border border-slate-300 rounded-2xl p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="font-black text-slate-900 text-xs flex items-center gap-1.5">
                        <Building2 className="w-3.5 h-3.5 text-emerald-700" />
                        <span>B2B GSTIN Information</span>
                      </span>
                      <button
                        type="button"
                        onClick={handleFillSampleGstin}
                        className="text-emerald-700 font-bold text-[11px] underline cursor-pointer"
                      >
                        Fill sample GSTIN
                      </button>
                    </div>

                    <div>
                      <label className="block font-bold text-slate-700 text-[11px] mb-1">
                        GSTIN (15 Alphanumeric Characters) *
                      </label>
                      <input
                        type="text"
                        maxLength={15}
                        value={gstin}
                        onChange={handleGstinChange}
                        placeholder="29AABCP1429B1Z8"
                        className="w-full bg-white border border-slate-300 rounded-xl p-2.5 font-mono text-xs font-bold text-slate-900 uppercase focus:outline-none focus:ring-2 focus:ring-emerald-500"
                      />
                      {gstError && (
                        <p className="text-red-600 text-[10px] font-bold mt-1">{gstError}</p>
                      )}
                    </div>

                    <div>
                      <label className="block font-bold text-slate-700 text-[11px] mb-1">
                        Legal Registered Business Name *
                      </label>
                      <input
                        type="text"
                        value={legalBusinessName}
                        onChange={(e) => setLegalBusinessName(e.target.value)}
                        placeholder="Apex MEP Infrastructure Pvt Ltd"
                        className="w-full bg-white border border-slate-300 rounded-xl p-2.5 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                      />
                    </div>
                  </div>
                )}

                {/* Complete Setup Button */}
                <button
                  type="button"
                  onClick={handleCompleteAccountCreation}
                  className="w-full bg-emerald-700 hover:bg-emerald-800 text-white font-black text-sm py-3.5 rounded-2xl transition shadow-md cursor-pointer flex items-center justify-center gap-2"
                >
                  <CheckCircle2 className="w-4 h-4" />
                  <span>Create Account & Start Ordering</span>
                </button>

              </div>
            )}

          </div>
        )}

        {/* ========================================================= */}
        {/* VIEW 2: LOGGED IN BUYER PROFILE HUB & ACCOUNT MANAGEMENT  */}
        {/* ========================================================= */}
        {viewMode === 'dashboard' && (
          <div className="flex flex-col flex-1 overflow-hidden">
            
            {/* Header */}
            <div className="p-4 sm:p-5 border-b border-slate-100 flex items-center justify-between bg-slate-50/80">
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-2xl bg-slate-900 text-white flex items-center justify-center font-black text-base shadow-xs">
                  {name ? name.charAt(0).toUpperCase() : 'U'}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-base sm:text-lg font-black text-slate-900">
                      {name || 'Buyer Account'}
                    </h2>
                    <span className="text-[10px] bg-emerald-100 text-emerald-800 font-extrabold px-2 py-0.5 rounded-full border border-emerald-300 flex items-center gap-1">
                      <CheckCircle2 className="w-3 h-3" />
                      <span>OTP Verified</span>
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-slate-500 font-mono mt-0.5">
                    <span>{inputPhone || profile.phone}</span>
                    <span>•</span>
                    <span className="capitalize">{accountType === 'business' ? 'B2B Contractor' : 'Individual Buyer'}</span>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    setViewMode('onboarding');
                    setOnboardingStep('phone_entry');
                  }}
                  title="Switch or Login with another mobile number"
                  className="text-xs font-bold text-slate-500 hover:text-slate-900 bg-white border border-slate-200 px-2.5 py-1.5 rounded-xl flex items-center gap-1 hover:bg-slate-100 transition cursor-pointer"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">Switch Number</span>
                </button>

                <button
                  onClick={onClose}
                  className="w-8 h-8 rounded-full bg-white border border-slate-200 flex items-center justify-center text-slate-500 hover:bg-slate-100 hover:text-slate-900 transition cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Navigation Tabs */}
            <div className="flex border-b border-slate-200 bg-white px-4 pt-2 gap-2 text-xs font-bold">
              <button
                onClick={() => setActiveTab('personal')}
                className={`pb-2.5 px-3 border-b-2 flex items-center gap-1.5 transition cursor-pointer ${
                  activeTab === 'personal'
                    ? 'border-emerald-700 text-emerald-800 font-black'
                    : 'border-transparent text-slate-500 hover:text-slate-800'
                }`}
              >
                <User className="w-3.5 h-3.5" />
                <span>Personal & Drop Location</span>
              </button>

              <button
                onClick={() => setActiveTab('b2b_gst')}
                className={`pb-2.5 px-3 border-b-2 flex items-center gap-1.5 transition cursor-pointer ${
                  activeTab === 'b2b_gst'
                    ? 'border-emerald-700 text-emerald-800 font-black'
                    : 'border-transparent text-slate-500 hover:text-slate-800'
                }`}
              >
                <Building2 className="w-3.5 h-3.5" />
                <span>B2B GSTIN & ITC</span>
              </button>

              <button
                onClick={() => setActiveTab('invoices')}
                className={`pb-2.5 px-3 border-b-2 flex items-center gap-1.5 transition cursor-pointer ${
                  activeTab === 'invoices'
                    ? 'border-emerald-700 text-emerald-800 font-black'
                    : 'border-transparent text-slate-500 hover:text-slate-800'
                }`}
              >
                <Receipt className="w-3.5 h-3.5" />
                <span>Orders & Invoices ({orders.length})</span>
              </button>
            </div>

            {/* Body */}
            <div className="p-4 sm:p-6 overflow-y-auto space-y-5 flex-1 text-slate-800 text-xs">
              
              {savedSuccess && (
                <div className="p-3 bg-emerald-50 border border-emerald-300 rounded-2xl flex items-center gap-2 text-emerald-900 font-bold">
                  <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
                  <span>Profile details and Drop Location saved successfully!</span>
                </div>
              )}

              {/* TAB 1: Personal & Drop Location */}
              {activeTab === 'personal' && (
                <div className="space-y-4">
                  
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block font-bold text-slate-700 mb-1">Full Name</label>
                      <input
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-xl p-2.5 text-xs text-slate-900 font-bold focus:outline-none focus:ring-2 focus:ring-emerald-500"
                      />
                    </div>

                    <div>
                      <label className="block font-bold text-slate-700 mb-1">Registered Mobile Number</label>
                      <div className="flex items-center gap-2">
                        <input
                          type="tel"
                          readOnly
                          value={inputPhone || profile.phone}
                          className="w-full bg-slate-100 border border-slate-200 rounded-xl p-2.5 text-xs text-slate-700 font-mono select-none"
                        />
                        <span className="text-[10px] bg-emerald-100 text-emerald-800 font-black px-2 py-1 rounded-lg shrink-0">
                          Verified
                        </span>
                      </div>
                    </div>
                  </div>

                  <div>
                    <label className="block font-bold text-slate-700 mb-1">Email Address</label>
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="rohan.kulkarni@gmail.com"
                      className="w-full bg-slate-50 border border-slate-200 rounded-xl p-2.5 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    />
                  </div>

                  {/* Drop Location Box */}
                  <div className="p-4 bg-slate-50 border border-slate-200 rounded-2xl space-y-3">
                    <div className="flex items-center gap-2 font-black text-slate-900 text-xs">
                      <MapPin className="w-4 h-4 text-emerald-700" />
                      <span>Primary Drop Location</span>
                    </div>

                    <div>
                      <label className="block font-bold text-slate-700 text-[11px] mb-1">Street Address</label>
                      <input
                        type="text"
                        value={address}
                        onChange={(e) => setAddress(e.target.value)}
                        className="w-full bg-white border border-slate-200 rounded-xl p-2.5 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                      />
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                      <div>
                        <label className="block font-bold text-slate-700 text-[11px] mb-1">Floor / Unit</label>
                        <input
                          type="text"
                          value={floorUnit}
                          onChange={(e) => setFloorUnit(e.target.value)}
                          className="w-full bg-white border border-slate-200 rounded-xl p-2.5 text-xs text-slate-900"
                        />
                      </div>
                      <div>
                        <label className="block font-bold text-slate-700 text-[11px] mb-1">Landmark / Instructions</label>
                        <input
                          type="text"
                          value={landmark}
                          onChange={(e) => setLandmark(e.target.value)}
                          className="w-full bg-white border border-slate-200 rounded-xl p-2.5 text-xs text-slate-900"
                        />
                      </div>
                    </div>
                  </div>

                </div>
              )}

              {/* TAB 2: B2B GSTIN & Tax Invoicing */}
              {activeTab === 'b2b_gst' && (
                <div className="space-y-4">
                  
                  {/* ITC Card */}
                  <div className="bg-gradient-to-r from-emerald-900 to-slate-900 text-white p-4 rounded-2xl shadow-sm space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Percent className="w-4 h-4 text-amber-400" />
                        <span className="font-extrabold text-sm tracking-wide">
                          Input Tax Credit (ITC) Active
                        </span>
                      </div>
                      <span className="text-[10px] bg-emerald-500/30 text-emerald-200 font-bold px-2 py-0.5 rounded-full border border-emerald-400/30">
                        18% GST Rebate
                      </span>
                    </div>
                    <p className="text-slate-200 text-xs leading-relaxed">
                      Your business GSTIN will be automatically included on tax invoices for instant GSTR-2B ITC reconciliation.
                    </p>
                    
                    {totalItcClaimed > 0 && (
                      <div className="pt-2 border-t border-white/10 flex items-center justify-between text-xs">
                        <span className="text-slate-300">Lifetime ITC Savings Claimed:</span>
                        <span className="font-black text-amber-400 text-sm">₹{totalItcClaimed.toLocaleString('en-IN')}</span>
                      </div>
                    )}
                  </div>

                  {/* B2B Enable Toggle */}
                  <div className="bg-slate-50 border border-slate-200 p-4 rounded-2xl flex items-center justify-between">
                    <div>
                      <div className="font-black text-slate-900 text-sm">Enable B2B GST Billing</div>
                      <div className="text-slate-500 text-xs mt-0.5">
                        Apply GSTIN on all orders for compliant tax invoice generation
                      </div>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={isB2BEnabled}
                        onChange={(e) => setIsB2BEnabled(e.target.checked)}
                        className="sr-only peer"
                      />
                      <div className="w-11 h-6 bg-slate-300 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-700"></div>
                    </label>
                  </div>

                  {isB2BEnabled && (
                    <div className="space-y-3 bg-white p-4 border border-slate-200 rounded-2xl shadow-2xs">
                      <div className="flex items-center justify-between">
                        <span className="font-black text-slate-900 uppercase text-[11px] tracking-wider">
                          GST Registration Details
                        </span>
                        <button
                          type="button"
                          onClick={handleFillSampleGstin}
                          className="text-emerald-700 hover:text-emerald-800 font-bold text-[11px] underline cursor-pointer"
                        >
                          Fill sample GSTIN
                        </button>
                      </div>

                      <div>
                        <label className="block font-bold text-slate-700 mb-1">
                          GSTIN (15 Characters) *
                        </label>
                        <input
                          type="text"
                          maxLength={15}
                          value={gstin}
                          onChange={handleGstinChange}
                          placeholder="e.g. 29AABCP1429B1Z8"
                          className="w-full bg-slate-50 border border-slate-200 rounded-xl p-2.5 font-mono text-xs font-bold text-slate-900 uppercase focus:outline-none focus:ring-2 focus:ring-emerald-500"
                        />
                        {gstError && (
                          <p className="text-red-600 font-bold text-[11px] mt-1">{gstError}</p>
                        )}
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className="block font-bold text-slate-700 mb-1">
                            Legal Business Name *
                          </label>
                          <input
                            type="text"
                            value={legalBusinessName}
                            onChange={(e) => setLegalBusinessName(e.target.value)}
                            placeholder="Apex Infrastructure Pvt Ltd"
                            className="w-full bg-slate-50 border border-slate-200 rounded-xl p-2.5 text-xs text-slate-900"
                          />
                        </div>

                        <div>
                          <label className="block font-bold text-slate-700 mb-1">
                            Trade / Firm Name
                          </label>
                          <input
                            type="text"
                            value={tradeName}
                            onChange={(e) => setTradeName(e.target.value)}
                            placeholder="Apex Projects"
                            className="w-full bg-slate-50 border border-slate-200 rounded-xl p-2.5 text-xs text-slate-900"
                          />
                        </div>
                      </div>

                      <div>
                        <label className="block font-bold text-slate-700 mb-1">
                          Registered Business Billing Address
                        </label>
                        <textarea
                          rows={2}
                          value={billingAddress}
                          onChange={(e) => setBillingAddress(e.target.value)}
                          placeholder="Office #102, Prestige Tech Park, Koramangala, Bengaluru - 560034"
                          className="w-full bg-slate-50 border border-slate-200 rounded-xl p-2.5 text-xs text-slate-900"
                        />
                      </div>
                    </div>
                  )}

                </div>
              )}

              {/* TAB 3: Past Invoices */}
              {activeTab === 'invoices' && (
                <div className="space-y-3">
                  {orders.length === 0 ? (
                    <div className="text-center py-8 text-slate-400 space-y-2">
                      <Receipt className="w-8 h-8 mx-auto text-slate-300" />
                      <p className="font-bold">No orders placed yet.</p>
                      <p className="text-[11px]">When you place orders, GST tax invoices with ITC details will be listed here.</p>
                    </div>
                  ) : (
                    orders.map((order) => (
                      <div key={order.id} className="p-3 bg-slate-50 border border-slate-200 rounded-2xl flex items-center justify-between gap-3">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-slate-900 text-xs">Order #{order.id}</span>
                            <span className="text-[10px] bg-emerald-100 text-emerald-800 font-black px-1.5 py-0.2 rounded">
                              ₹{order.total}
                            </span>
                          </div>
                          <div className="text-[11px] text-slate-500 mt-0.5">
                            Seller: {order.sellerPartner?.name || 'Sri Lakshmi Hardware'} • {new Date(order.placedAt).toLocaleDateString()}
                          </div>
                          <div className="text-[10px] text-emerald-700 font-bold mt-0.5">
                            GST Tax: ₹{order.tax} • ITC Eligible: {order.sellerPartner?.isGstRegistered ? 'Yes (18%)' : 'No'}
                          </div>
                        </div>

                        <button
                          onClick={() => {
                            onOpenOrderTracking(order.id);
                            onClose();
                          }}
                          className="bg-white border border-slate-200 hover:bg-slate-100 text-slate-800 font-bold px-3 py-1.5 rounded-xl text-xs transition cursor-pointer"
                        >
                          View Invoice
                        </button>
                      </div>
                    ))
                  )}
                </div>
              )}

            </div>

            {/* Dashboard Footer */}
            <div className="p-4 border-t border-slate-100 bg-slate-50 flex items-center justify-between">
              <button
                type="button"
                onClick={onClose}
                className="text-slate-600 hover:text-slate-900 font-bold text-xs px-4 py-2 rounded-xl transition cursor-pointer"
              >
                Close
              </button>

              <button
                type="button"
                onClick={handleSaveDashboard}
                className="bg-emerald-700 hover:bg-emerald-800 text-white font-black text-xs px-6 py-2.5 rounded-xl transition shadow-xs cursor-pointer flex items-center gap-2"
              >
                <CheckCircle2 className="w-4 h-4" />
                <span>Save Profile Changes</span>
              </button>
            </div>

          </div>
        )}

      </div>
    </div>
  );
};
