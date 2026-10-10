import React, { useState, useEffect } from 'react';
import { 
  ArrowLeft, 
  ShoppingBag, 
  HelpCircle, 
  Sun, 
  Moon, 
  EyeOff, 
  BookOpen, 
  Bookmark, 
  Heart, 
  FileText, 
  Gift, 
  FileCheck, 
  Award, 
  Share2, 
  Info, 
  ShieldCheck, 
  Bell, 
  LogOut, 
  ChevronRight, 
  Check, 
  Building2, 
  MapPin, 
  Phone, 
  Calendar, 
  Receipt,
  Sparkles,
  CreditCard,
  Download,
  ExternalLink,
  Edit2,
  Trash2,
  Plus,
  Send,
  MessageSquare,
  CheckCircle2,
  Lock,
  Copy,
  Tag,
  RotateCcw,
  Store,
  ArrowRight
} from 'lucide-react';
import { CustomerProfile, CustomerGstProfile, Order, AddressLocation, SavedGstinRecord } from '../types';

const STATE_CODE_MAP: Record<string, string> = {
  '01': 'Jammu & Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '19': 'West Bengal',
  '24': 'Gujarat',
  '27': 'Maharashtra',
  '29': 'Karnataka',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '36': 'Telangana',
  '37': 'Andhra Pradesh'
};

const SAMPLE_GST_PRESETS = [
  {
    gstin: '29AABCP1429B1Z8',
    legalName: 'Apex MEP Infrastructure Pvt Ltd',
    tradeName: 'Apex MEP - Bengaluru HQ',
    address: '14th Main Rd, 4th Block, Koramangala, Bengaluru - 560034',
    state: 'Karnataka',
    stateCode: '29'
  },
  {
    gstin: '27AABCP1429B1Z5',
    legalName: 'Apex MEP Infrastructure Pvt Ltd',
    tradeName: 'Apex MEP - Pune Site Office',
    address: 'Plot #18, Hinjewadi Phase 1, Pune, Maharashtra - 411057',
    state: 'Maharashtra',
    stateCode: '27'
  },
  {
    gstin: '07AABCP1429B1Z2',
    legalName: 'Apex MEP Infrastructure Pvt Ltd',
    tradeName: 'Apex MEP - Delhi NCR Hub',
    address: 'Sector 62, Noida / Okhla Phase 3, New Delhi - 110020',
    state: 'Delhi',
    stateCode: '07'
  },
  {
    gstin: '36AABCP1429B1Z0',
    legalName: 'Apex MEP Infrastructure Pvt Ltd',
    tradeName: 'Apex MEP - Hyderabad Branch',
    address: 'HITEC City, Madhapur, Hyderabad, Telangana - 500081',
    state: 'Telangana',
    stateCode: '36'
  }
];

export interface SavedAddressItem {
  id: string;
  tag: 'Job Site' | 'Home' | 'Work' | 'Warehouse' | 'Other';
  address: string;
  floorUnit: string;
  landmark: string;
  isDefault: boolean;
}

interface ProfilePageProps {
  profile: CustomerProfile;
  onSaveProfile: (profile: CustomerProfile) => void;
  orders: Order[];
  onClose: () => void;
  onOpenOrderTracking: (orderId: string) => void;
  onOpenRestock: () => void;
  onUpdateJobSite?: (jobSite: AddressLocation) => void;
  onOpenLocationModal?: () => void;
}

type SubView = 
  | 'main' 
  | 'gst_details' 
  | 'address_book' 
  | 'edit_profile' 
  | 'orders' 
  | 'bookmarks' 
  | 'wishlist' 
  | 'gift_cards' 
  | 'compliance' 
  | 'payment_settings' 
  | 'claim_gift' 
  | 'rewards' 
  | 'impact' 
  | 'about' 
  | 'privacy' 
  | 'notifications';

export const ProfilePage: React.FC<ProfilePageProps> = ({
  profile,
  onSaveProfile,
  orders,
  onClose,
  onOpenOrderTracking,
  onOpenRestock,
  onUpdateJobSite,
  onOpenLocationModal
}) => {
  // Sub-view navigation state
  const [activeSubView, setActiveSubView] = useState<SubView>('main');

  // User Profile State
  const [name, setName] = useState(profile.name || 'Rohan K');
  const [phone, setPhone] = useState(profile.phone || '+91 96111 93492');
  const [email, setEmail] = useState(profile.email || 'rohan.kulkarni@gmail.com');
  const [dob, setDob] = useState('25 Nov 1997');
  
  // Toggles & Preferences State
  const [appearance, setAppearance] = useState<'LIGHT' | 'DARK'>('LIGHT');
  const [hideSensitive, setHideSensitive] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Multiple Saved GSTIN Profiles State
  const [savedGstins, setSavedGstins] = useState<SavedGstinRecord[]>(() => {
    if (profile.gstProfile?.savedGstins && profile.gstProfile.savedGstins.length > 0) {
      return profile.gstProfile.savedGstins;
    }
    if (profile.gstProfile?.gstin) {
      return [
        {
          id: 'gst_primary',
          gstin: profile.gstProfile.gstin,
          legalBusinessName: profile.gstProfile.legalBusinessName || 'Apex MEP Infrastructure Pvt Ltd',
          tradeName: profile.gstProfile.tradeName || 'Apex MEP - Bengaluru HQ',
          billingAddress: profile.gstProfile.billingAddress || profile.defaultAddress || '14th Main Rd, 4th Block, Koramangala, Bengaluru - 560034',
          state: profile.gstProfile.state || 'Karnataka',
          stateCode: profile.gstProfile.stateCode || '29',
          isDefault: true,
          createdAt: '2026-01-10'
        }
      ];
    }
    return [
      {
        id: 'gst_1',
        gstin: '29AABCP1429B1Z8',
        legalBusinessName: 'Apex MEP Infrastructure Pvt Ltd',
        tradeName: 'Apex MEP - Bengaluru HQ',
        billingAddress: '14th Main Rd, 4th Block, Koramangala, Bengaluru - 560034',
        state: 'Karnataka',
        stateCode: '29',
        isDefault: true,
        createdAt: '2026-01-10'
      },
      {
        id: 'gst_2',
        gstin: '27AABCP1429B1Z5',
        legalBusinessName: 'Apex MEP Infrastructure Pvt Ltd',
        tradeName: 'Apex MEP - Pune Site Office',
        billingAddress: 'Plot #18, Hinjewadi Phase 1, Pune, Maharashtra - 411057',
        state: 'Maharashtra',
        stateCode: '27',
        isDefault: false,
        createdAt: '2026-03-15'
      }
    ];
  });

  // GST Form State (for adding / editing GSTIN)
  const [editingGstinId, setEditingGstinId] = useState<string | null>(null);
  const [isGstFormOpen, setIsGstFormOpen] = useState(false);
  const [formGstin, setFormGstin] = useState('');
  const [formLegalName, setFormLegalName] = useState('');
  const [formTradeName, setFormTradeName] = useState('');
  const [formBillingAddress, setFormBillingAddress] = useState('');
  const [formState, setFormState] = useState('Karnataka');
  const [formStateCode, setFormStateCode] = useState('29');
  const [formIsDefaultGst, setFormIsDefaultGst] = useState(false);
  const [gstFormError, setGstFormError] = useState<string | null>(null);
  const [gstSaved, setGstSaved] = useState(false);

  // Multiple Saved Addresses State
  const [savedAddresses, setSavedAddresses] = useState<SavedAddressItem[]>([
    {
      id: 'addr_1',
      tag: 'Job Site',
      address: profile.defaultAddress || '14th Main Rd, 4th Block, Koramangala, Bengaluru',
      floorUnit: profile.floorUnit || 'Tower B, 4th Floor, Flat 402',
      landmark: profile.landmark || 'Opposite BDA Complex, Gate #2',
      isDefault: true
    },
    {
      id: 'addr_2',
      tag: 'Warehouse',
      address: 'Plot #42, Industrial Area, Peenya 1st Stage, Bengaluru',
      floorUnit: 'Shed #3, Ground Floor',
      landmark: 'Near TVS Cross Bus Stop',
      isDefault: false
    },
    {
      id: 'addr_3',
      tag: 'Work',
      address: '100ft Road, 12th Main, Indiranagar, Bengaluru',
      floorUnit: 'Suite 201, Landmark Building',
      landmark: 'Above Axis Bank Branch',
      isDefault: false
    }
  ]);

  const [isAddingAddress, setIsAddingAddress] = useState(false);
  const [editingAddressId, setEditingAddressId] = useState<string | null>(null);

  // Address Form State
  const [formTag, setFormTag] = useState<'Job Site' | 'Home' | 'Work' | 'Warehouse' | 'Other'>('Job Site');
  const [formAddress, setFormAddress] = useState('');
  const [formFloorUnit, setFormFloorUnit] = useState('');
  const [formLandmark, setFormLandmark] = useState('');
  const [formSetDefault, setFormSetDefault] = useState(false);

  // Interactive Lists State
  const [bookmarks, setBookmarks] = useState([
    { id: 'b1', title: '2BHK Apartment Electrical BOM', itemsCount: 18, totalEst: '₹14,250', date: '12 Aug 2026' },
    { id: 'b2', title: 'Site Phase-1 CPVC Plumbing Fittings', itemsCount: 32, totalEst: '₹28,900', date: '04 Aug 2026' },
    { id: 'b3', title: 'Office False Ceiling LED Grid Lights', itemsCount: 12, totalEst: '₹9,600', date: '28 Jul 2026' }
  ]);
  const [newBookmarkTitle, setNewBookmarkTitle] = useState('');

  const [wishlist, setWishlist] = useState([
    { id: 'w1', name: 'Havells 1.5 sq mm FR PVC Insulated Wire (90m)', category: 'Electrical', price: 1480, inStock: true },
    { id: 'w2', name: 'Bosch GSB 500W Professional Impact Drill Set', category: 'Power Tools', price: 2890, inStock: true },
    { id: 'w3', name: 'Finolex 4 inch SWR PVC Agriculture Pipe 10ft', category: 'Plumbing', price: 620, inStock: true }
  ]);

  // Payment Methods State
  const [upiId, setUpiId] = useState('rohan.kulkarni@okaxis');
  const [savedCard, setSavedCard] = useState('HDFC Bank Corporate Visa •••• 4092');
  const [defaultPayment, setDefaultPayment] = useState<'UPI' | 'CARD' | 'COD'>('UPI');

  // Claim Gift Card State
  const [giftCode, setGiftCode] = useState('');
  const [claimedBalance, setClaimedBalance] = useState(0);

  // Notification Preferences State
  const [notifyWhatsapp, setNotifyWhatsapp] = useState(true);
  const [notifySms, setNotifySms] = useState(true);
  const [notifyDeals, setNotifyDeals] = useState(false);
  const [notifyTracking, setNotifyTracking] = useState(true);

  // Privacy Settings State
  const [dataSharing, setDataSharing] = useState(false);
  const [personalizedOffers, setPersonalizedOffers] = useState(true);

  // Sync state if profile prop updates
  useEffect(() => {
    if (profile.name) setName(profile.name);
    if (profile.phone) setPhone(profile.phone);
    if (profile.email) setEmail(profile.email);
    if (profile.gstProfile?.savedGstins && profile.gstProfile.savedGstins.length > 0) {
      setSavedGstins(profile.gstProfile.savedGstins);
    }
  }, [profile]);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 2500);
  };

  // GST State Handlers
  const handleGstinInputChange = (val: string) => {
    const clean = val.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 15);
    setFormGstin(clean);
    if (clean.length >= 2) {
      const code = clean.slice(0, 2);
      if (STATE_CODE_MAP[code]) {
        setFormStateCode(code);
        setFormState(STATE_CODE_MAP[code]);
      }
    }
    if (clean.length === 15) {
      setGstFormError(null);
    }
  };

  const handleApplyGstPreset = (preset: typeof SAMPLE_GST_PRESETS[0]) => {
    setFormGstin(preset.gstin);
    setFormLegalName(preset.legalName);
    setFormTradeName(preset.tradeName);
    setFormBillingAddress(preset.address);
    setFormState(preset.state);
    setFormStateCode(preset.stateCode);
    setGstFormError(null);
    showToast(`Loaded ${preset.state} GSTIN preset`);
  };

  const handleSetDefaultGstin = (id: string) => {
    const updated = savedGstins.map(g => ({
      ...g,
      isDefault: g.id === id
    }));
    setSavedGstins(updated);

    const activeItem = updated.find(g => g.id === id);
    if (activeItem) {
      const updatedProfile: CustomerProfile = {
        ...profile,
        gstProfile: {
          ...profile.gstProfile,
          isB2BEnabled: true,
          gstin: activeItem.gstin,
          legalBusinessName: activeItem.legalBusinessName,
          tradeName: activeItem.tradeName || activeItem.legalBusinessName,
          billingAddress: activeItem.billingAddress,
          state: activeItem.state || 'Karnataka',
          stateCode: activeItem.stateCode || '29',
          savedGstins: updated
        }
      };
      onSaveProfile(updatedProfile);
      showToast(`Set ${activeItem.tradeName || activeItem.gstin} as active for billing`);
    }
  };

  const handleDeleteGstin = (id: string) => {
    if (savedGstins.length <= 1) {
      showToast('You must have at least 1 saved GSTIN for B2B billing.');
      return;
    }

    const itemToDelete = savedGstins.find(g => g.id === id);
    let updated = savedGstins.filter(g => g.id !== id);

    // If deleted was default, make the first one default
    if (itemToDelete?.isDefault && updated.length > 0) {
      updated = updated.map((g, idx) => ({
        ...g,
        isDefault: idx === 0
      }));
    }

    setSavedGstins(updated);

    const defaultItem = updated.find(g => g.isDefault) || updated[0];
    const updatedProfile: CustomerProfile = {
      ...profile,
      gstProfile: {
        ...profile.gstProfile,
        isB2BEnabled: true,
        gstin: defaultItem?.gstin || '',
        legalBusinessName: defaultItem?.legalBusinessName || '',
        tradeName: defaultItem?.tradeName || '',
        billingAddress: defaultItem?.billingAddress || '',
        state: defaultItem?.state || 'Karnataka',
        stateCode: defaultItem?.stateCode || '29',
        savedGstins: updated
      }
    };
    onSaveProfile(updatedProfile);

    if (editingGstinId === id) {
      handleResetGstForm();
    }
    showToast('GSTIN removed from business profile');
  };

  const handleStartEditGstin = (item: SavedGstinRecord) => {
    setEditingGstinId(item.id);
    setFormGstin(item.gstin);
    setFormLegalName(item.legalBusinessName);
    setFormTradeName(item.tradeName || '');
    setFormBillingAddress(item.billingAddress);
    setFormState(item.state || 'Karnataka');
    setFormStateCode(item.stateCode || '29');
    setFormIsDefaultGst(item.isDefault || false);
    setIsGstFormOpen(true);
    setGstFormError(null);
  };

  const handleResetGstForm = () => {
    setEditingGstinId(null);
    setFormGstin('');
    setFormLegalName('');
    setFormTradeName('');
    setFormBillingAddress('');
    setFormState('Karnataka');
    setFormStateCode('29');
    setFormIsDefaultGst(false);
    setIsGstFormOpen(false);
    setGstFormError(null);
  };

  const handleSaveGstinForm = (e?: React.FormEvent) => {
    if (e) e.preventDefault();

    const clean = formGstin.trim().toUpperCase();
    if (clean.length !== 15) {
      setGstFormError('GSTIN must be exactly 15 alphanumeric characters (e.g. 29AABCP1429B1Z8).');
      return;
    }
    if (!formLegalName.trim()) {
      setGstFormError('Please enter the Legal Business Name.');
      return;
    }

    setGstFormError(null);

    const defaultAddressObj = savedAddresses.find(a => a.isDefault) || savedAddresses[0];
    const finalBillingAddr = formBillingAddress.trim() || defaultAddressObj?.address || '14th Main Rd, 4th Block, Koramangala, Bengaluru';

    let updatedGstins: SavedGstinRecord[];
    const shouldBeDefault = formIsDefaultGst || savedGstins.length === 0;

    if (editingGstinId) {
      updatedGstins = savedGstins.map(g => {
        if (g.id === editingGstinId) {
          return {
            ...g,
            gstin: clean,
            legalBusinessName: formLegalName.trim(),
            tradeName: formTradeName.trim() || formLegalName.trim(),
            billingAddress: finalBillingAddr,
            state: formState,
            stateCode: formStateCode,
            isDefault: shouldBeDefault ? true : g.isDefault
          };
        }
        return shouldBeDefault ? { ...g, isDefault: false } : g;
      });
    } else {
      const newRecord: SavedGstinRecord = {
        id: `gst_${Date.now()}`,
        gstin: clean,
        legalBusinessName: formLegalName.trim(),
        tradeName: formTradeName.trim() || formLegalName.trim(),
        billingAddress: finalBillingAddr,
        state: formState,
        stateCode: formStateCode,
        isDefault: shouldBeDefault,
        createdAt: new Date().toISOString().split('T')[0]
      };

      if (shouldBeDefault) {
        updatedGstins = [
          ...savedGstins.map(g => ({ ...g, isDefault: false })),
          newRecord
        ];
      } else {
        updatedGstins = [...savedGstins, newRecord];
      }
    }

    setSavedGstins(updatedGstins);

    const activeItem = updatedGstins.find(g => g.isDefault) || updatedGstins[0];
    const updatedProfile: CustomerProfile = {
      ...profile,
      name,
      phone,
      email,
      gstProfile: {
        isB2BEnabled: true,
        gstin: activeItem.gstin,
        legalBusinessName: activeItem.legalBusinessName,
        tradeName: activeItem.tradeName || activeItem.legalBusinessName,
        billingAddress: activeItem.billingAddress,
        state: activeItem.state || 'Karnataka',
        stateCode: activeItem.stateCode || '29',
        contactPerson: name,
        contactEmail: email,
        savedGstins: updatedGstins
      }
    };

    onSaveProfile(updatedProfile);
    setGstSaved(true);
    showToast(editingGstinId ? 'GSTIN updated successfully!' : 'New GSTIN added for billing!');
    handleResetGstForm();
    setTimeout(() => {
      setGstSaved(false);
    }, 1500);
  };

  // Address Book Handlers
  const handleSetDefaultAddress = (id: string) => {
    const updated = savedAddresses.map(a => ({
      ...a,
      isDefault: a.id === id
    }));
    setSavedAddresses(updated);

    const target = updated.find(a => a.id === id);
    if (target) {
      onSaveProfile({
        ...profile,
        defaultAddress: target.address,
        floorUnit: target.floorUnit,
        landmark: target.landmark
      });
      if (onUpdateJobSite) {
        onUpdateJobSite({
          address: target.address,
          floorUnit: target.floorUnit,
          landmark: target.landmark,
          siteContactName: name,
          sitePhone: phone,
          jobTag: target.tag,
          coordinates: { lat: 12.9352, lng: 77.6245 }
        });
      }
      showToast(`Default drop location set to "${target.tag}"`);
    }
  };

  const handleDeleteAddress = (id: string) => {
    if (savedAddresses.length <= 1) {
      showToast('You must keep at least 1 saved address in your address book.');
      return;
    }
    const target = savedAddresses.find(a => a.id === id);
    const updated = savedAddresses.filter(a => a.id !== id);

    // If deleted item was default, make the first remaining address default
    if (target?.isDefault && updated.length > 0) {
      updated[0].isDefault = true;
      onSaveProfile({
        ...profile,
        defaultAddress: updated[0].address,
        floorUnit: updated[0].floorUnit,
        landmark: updated[0].landmark
      });
    }

    setSavedAddresses(updated);
    showToast('Address removed from address book');
  };

  const handleStartAddAddress = () => {
    setEditingAddressId(null);
    setFormTag('Job Site');
    setFormAddress('');
    setFormFloorUnit('');
    setFormLandmark('');
    setFormSetDefault(savedAddresses.length === 0);
    setIsAddingAddress(true);
  };

  const handleStartEditAddress = (item: SavedAddressItem) => {
    setEditingAddressId(item.id);
    setFormTag(item.tag);
    setFormAddress(item.address);
    setFormFloorUnit(item.floorUnit);
    setFormLandmark(item.landmark);
    setFormSetDefault(item.isDefault);
    setIsAddingAddress(true);
  };

  const handleSaveAddressForm = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formAddress.trim()) {
      showToast('Please enter a street address.');
      return;
    }

    let updatedList: SavedAddressItem[];

    if (editingAddressId) {
      // Edit mode
      updatedList = savedAddresses.map(item => {
        if (item.id === editingAddressId) {
          return {
            ...item,
            tag: formTag,
            address: formAddress.trim(),
            floorUnit: formFloorUnit.trim(),
            landmark: formLandmark.trim(),
            isDefault: formSetDefault ? true : item.isDefault
          };
        }
        return formSetDefault ? { ...item, isDefault: false } : item;
      });
      showToast('Address updated successfully!');
    } else {
      // Add mode
      const newAddr: SavedAddressItem = {
        id: 'addr_' + Date.now(),
        tag: formTag,
        address: formAddress.trim(),
        floorUnit: formFloorUnit.trim(),
        landmark: formLandmark.trim(),
        isDefault: formSetDefault || savedAddresses.length === 0
      };

      if (formSetDefault) {
        updatedList = savedAddresses.map(a => ({ ...a, isDefault: false }));
        updatedList.unshift(newAddr);
      } else {
        updatedList = [newAddr, ...savedAddresses];
      }
      showToast('New drop address added!');
    }

    setSavedAddresses(updatedList);

    // Sync if marked as default
    const def = updatedList.find(a => a.isDefault);
    if (def) {
      onSaveProfile({
        ...profile,
        defaultAddress: def.address,
        floorUnit: def.floorUnit,
        landmark: def.landmark
      });
      if (onUpdateJobSite) {
        onUpdateJobSite({
          address: def.address,
          floorUnit: def.floorUnit,
          landmark: def.landmark,
          siteContactName: name,
          sitePhone: phone,
          jobTag: def.tag,
          coordinates: { lat: 12.9352, lng: 77.6245 }
        });
      }
    }

    setIsAddingAddress(false);
    setEditingAddressId(null);
  };

  const handleSavePersonal = () => {
    onSaveProfile({
      ...profile,
      name,
      phone,
      email
    });
    showToast('Profile details updated!');
    setActiveSubView('main');
  };

  const handleAddBookmark = () => {
    if (!newBookmarkTitle.trim()) return;
    setBookmarks([
      {
        id: 'b_' + Date.now(),
        title: newBookmarkTitle.trim(),
        itemsCount: 0,
        totalEst: '₹0',
        date: 'Today'
      },
      ...bookmarks
    ]);
    setNewBookmarkTitle('');
    showToast('New hardware list created!');
  };

  const handleClaimGiftCard = (e: React.FormEvent) => {
    e.preventDefault();
    if (!giftCode.trim()) return;
    if (giftCode.trim().toUpperCase() === 'BLINK2026' || giftCode.trim().length >= 6) {
      setClaimedBalance((prev) => prev + 500);
      showToast('🎉 ₹500 Gift Voucher Claimed Successfully!');
      setGiftCode('');
    } else {
      showToast('Invalid voucher code. Try BLINK2026');
    }
  };

  return (
    <div className={`min-h-screen ${appearance === 'DARK' ? 'bg-slate-950 text-slate-100' : 'bg-[#F4F6F8] text-slate-900'} flex flex-col font-sans pb-24 animate-in fade-in duration-200`}>
      
      {/* Toast Notification Popup */}
      {toastMessage && (
        <div className="fixed top-5 left-1/2 -translate-x-1/2 z-50 bg-slate-900 text-amber-300 font-bold text-xs px-4 py-2.5 rounded-xl shadow-xl border border-amber-400/30 flex items-center gap-2 animate-in slide-in-from-top-3 duration-200">
          <CheckCircle2 className="w-4 h-4 text-amber-400" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* ========================================== */}
      {/* TOP HEADER: Sleek, Dark Slate & Amber      */}
      {/* ========================================== */}
      <div className="bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-white pt-4 pb-8 px-4 sm:px-6 shadow-md relative overflow-hidden">
        {/* Background Decorative Warm Accent Rings */}
        <div className="absolute -top-12 -right-12 w-48 h-48 rounded-full bg-amber-500/10 blur-2xl pointer-events-none" />
        <div className="absolute top-1/2 left-0 w-32 h-32 rounded-full bg-yellow-500/10 blur-xl pointer-events-none" />

        <div className="max-w-2xl mx-auto relative z-10 space-y-5">
          
          {/* Top Bar with Back Arrow & Title */}
          <div className="flex items-center justify-between">
            <button
              onClick={() => {
                if (activeSubView !== 'main') {
                  setActiveSubView('main');
                } else {
                  onClose();
                }
              }}
              className="w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 border border-white/15 flex items-center justify-center text-white transition cursor-pointer active:scale-95"
              title="Go back"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>

            <h1 className="text-lg font-black tracking-tight text-white flex items-center gap-2">
              <span>{activeSubView === 'main' ? 'Profile' : 'Account Details'}</span>
            </h1>

            <div className="w-10" /> {/* Spacer for symmetry */}
          </div>

          {/* Centered User Avatar & Details (NO DP "+" upload button as requested) */}
          <div className="flex flex-col items-center text-center space-y-2 pt-1">
            <div className="w-20 h-20 sm:w-22 sm:h-22 rounded-full bg-white text-slate-950 font-black text-3xl sm:text-4xl flex items-center justify-center shadow-xl border-2 border-amber-400">
              {name ? name.charAt(0).toUpperCase() : 'R'}
            </div>

            <div>
              <div className="flex items-center justify-center gap-2">
                <h2 className="text-xl sm:text-2xl font-black text-white tracking-tight">
                  {name}
                </h2>
                <button
                  onClick={() => setActiveSubView('edit_profile')}
                  className="p-1 rounded-md text-amber-400 hover:text-amber-300 transition cursor-pointer"
                  title="Edit Profile Info"
                >
                  <Edit2 className="w-4 h-4" />
                </button>
              </div>

              <div className="flex items-center justify-center gap-3 text-xs text-amber-200/90 font-medium mt-1 flex-wrap">
                <span className="flex items-center gap-1 font-mono">
                  <Phone className="w-3.5 h-3.5 text-amber-400" />
                  {phone}
                </span>
                <span>•</span>
                <span className="flex items-center gap-1">
                  <Calendar className="w-3.5 h-3.5 text-amber-400" />
                  {dob}
                </span>
              </div>
            </div>
          </div>

        </div>
      </div>

      {/* ========================================== */}
      {/* MAIN BODY CONTENT AREA                     */}
      {/* ========================================== */}
      <div className="max-w-2xl w-full mx-auto px-3 sm:px-4 -mt-4 relative z-20 space-y-3.5">

        {/* ------------------------------------------ */}
        {/* SUBVIEW: ORDERS HISTORY                    */}
        {/* ------------------------------------------ */}
        {activeSubView === 'orders' && (
          <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-200 space-y-4 animate-in slide-in-from-right-4 duration-200">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <ShoppingBag className="w-5 h-5 text-amber-600" />
                <h3 className="font-black text-slate-900 text-base">Your Order History</h3>
              </div>
              <button
                onClick={() => setActiveSubView('main')}
                className="text-xs font-bold text-slate-500 hover:text-slate-900 underline"
              >
                Back
              </button>
            </div>

            {orders.length === 0 ? (
              <div className="text-center py-8 space-y-3">
                <ShoppingBag className="w-12 h-12 text-slate-300 mx-auto" />
                <p className="text-sm font-bold text-slate-700">No active orders yet.</p>
                <button
                  onClick={onOpenRestock}
                  className="bg-slate-950 text-white font-black text-xs px-4 py-2.5 rounded-xl hover:bg-slate-800 transition"
                >
                  Quick Restock / Buy Hardware
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                {orders.map((ord) => (
                  <div key={ord.id} className="p-4 bg-slate-50 rounded-xl border border-slate-200 space-y-2">
                    <div className="flex justify-between items-center text-xs font-bold">
                      <span className="font-mono text-slate-900">Order #{ord.id.slice(-6)}</span>
                      <span className="bg-amber-100 text-amber-900 px-2 py-0.5 rounded font-bold uppercase text-[10px]">
                        {ord.status}
                      </span>
                    </div>
                    <p className="text-xs text-slate-600 font-medium">
                      {ord.items.length} items • ₹{ord.totalAmount ?? ord.total}
                    </p>
                    <div className="flex gap-2 pt-1">
                      <button
                        onClick={() => {
                          onOpenOrderTracking(ord.id);
                        }}
                        className="flex-1 bg-amber-400 hover:bg-amber-300 text-slate-950 text-xs font-black py-2 rounded-lg transition"
                      >
                        Track Delivery
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ------------------------------------------ */}
        {/* SUBVIEW: GST DETAILS MANAGER (MULTI-GSTIN) */}
        {/* ------------------------------------------ */}
        {activeSubView === 'gst_details' && (
          <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-200 space-y-5 animate-in slide-in-from-right-4 duration-200">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <Building2 className="w-5 h-5 text-amber-600" />
                <div>
                  <h3 className="font-black text-slate-900 text-base">B2B GSTIN & Tax Invoicing</h3>
                  <p className="text-[11px] text-slate-500 font-medium">Manage multiple GSTINs for multi-state addresses & branch billing</p>
                </div>
              </div>
              <button
                onClick={() => {
                  handleResetGstForm();
                  setActiveSubView('main');
                }}
                className="text-xs font-bold text-slate-500 hover:text-slate-900 underline cursor-pointer"
              >
                Back
              </button>
            </div>

            {/* ITC Benefit Banner */}
            <div className="bg-emerald-50/80 border border-emerald-200/80 rounded-xl p-3.5 flex items-start gap-3">
              <div className="w-8 h-8 rounded-lg bg-emerald-100 text-emerald-800 flex items-center justify-center shrink-0 mt-0.5">
                <Receipt className="w-4 h-4 text-emerald-700" />
              </div>
              <div className="text-xs">
                <span className="font-bold text-emerald-950 block">18% Input Tax Credit (ITC) Invoicing</span>
                <p className="text-emerald-800 mt-0.5 leading-relaxed">
                  B2B Tax Invoices are generated automatically with your registered GSTIN and legal trade name on checkout. You can add separate GSTINs for each state/branch.
                </p>
              </div>
            </div>

            {/* Saved GSTIN Profiles List */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-black uppercase tracking-wider text-slate-700 flex items-center gap-2">
                  <span>Saved Business GSTINs</span>
                  <span className="bg-slate-100 text-slate-700 font-bold px-2 py-0.5 rounded-full text-[10px]">
                    {savedGstins.length}
                  </span>
                </h4>

                {!isGstFormOpen && (
                  <button
                    type="button"
                    onClick={() => {
                      handleResetGstForm();
                      setIsGstFormOpen(true);
                    }}
                    className="text-xs font-extrabold text-amber-700 hover:text-amber-800 flex items-center gap-1.5 cursor-pointer bg-amber-50 px-2.5 py-1 rounded-lg border border-amber-200"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Add New GSTIN</span>
                  </button>
                )}
              </div>

              {savedGstins.length === 0 ? (
                <div className="p-4 bg-slate-50 rounded-xl border border-dashed border-slate-300 text-center space-y-2">
                  <p className="text-xs font-bold text-slate-600">No GSTIN profiles saved yet.</p>
                  <button
                    type="button"
                    onClick={() => setIsGstFormOpen(true)}
                    className="text-xs font-bold bg-slate-900 text-white px-3 py-1.5 rounded-lg"
                  >
                    Add Business GSTIN
                  </button>
                </div>
              ) : (
                <div className="space-y-2.5">
                  {savedGstins.map((item) => (
                    <div
                      key={item.id}
                      className={`p-4 rounded-xl border transition relative ${
                        item.isDefault
                          ? 'bg-amber-50/40 border-amber-400/80 shadow-xs'
                          : 'bg-slate-50/60 border-slate-200 hover:border-slate-300'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="space-y-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-mono font-black text-sm tracking-wide text-slate-950 bg-white px-2 py-0.5 rounded border border-slate-200">
                              {item.gstin}
                            </span>
                            
                            {item.state && (
                              <span className="text-[10px] bg-slate-200 text-slate-800 font-bold px-1.5 py-0.5 rounded">
                                {item.stateCode ? `${item.stateCode} • ` : ''}{item.state}
                              </span>
                            )}

                            {item.isDefault ? (
                              <span className="text-[10px] bg-emerald-100 text-emerald-900 font-extrabold px-2 py-0.5 rounded-full flex items-center gap-1 border border-emerald-300">
                                <CheckCircle2 className="w-3 h-3 text-emerald-700" />
                                Active for Billing
                              </span>
                            ) : (
                              <button
                                type="button"
                                onClick={() => handleSetDefaultGstin(item.id)}
                                className="text-[10px] text-slate-600 hover:text-slate-950 font-bold underline cursor-pointer"
                              >
                                Set as Active Default
                              </button>
                            )}
                          </div>

                          <div className="pt-1">
                            <h5 className="font-black text-xs text-slate-900">{item.legalBusinessName}</h5>
                            {item.tradeName && item.tradeName !== item.legalBusinessName && (
                              <p className="text-[11px] font-bold text-amber-900">Branch: {item.tradeName}</p>
                            )}
                            <p className="text-[11px] text-slate-600 font-medium leading-relaxed mt-0.5">
                              {item.billingAddress}
                            </p>
                          </div>
                        </div>

                        {/* Action buttons on card */}
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => {
                              navigator.clipboard?.writeText(item.gstin);
                              showToast(`Copied GSTIN ${item.gstin}`);
                            }}
                            className="p-1.5 text-slate-500 hover:text-slate-900 hover:bg-slate-200/60 rounded-lg transition"
                            title="Copy GSTIN"
                          >
                            <Copy className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleStartEditGstin(item)}
                            className="p-1.5 text-slate-500 hover:text-slate-900 hover:bg-slate-200/60 rounded-lg transition"
                            title="Edit GSTIN details"
                          >
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteGstin(item.id)}
                            className="p-1.5 text-red-500 hover:text-red-700 hover:bg-red-50 rounded-lg transition"
                            title="Delete GSTIN"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ADD / EDIT GSTIN FORM */}
            <div className="pt-2 border-t border-slate-100">
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-xs font-black uppercase tracking-wider text-slate-800 flex items-center gap-2">
                  {editingGstinId ? (
                    <>
                      <Edit2 className="w-3.5 h-3.5 text-amber-600" />
                      <span>Edit GSTIN Profile</span>
                    </>
                  ) : (
                    <>
                      <Plus className="w-3.5 h-3.5 text-amber-600" />
                      <span>Add New Business GSTIN</span>
                    </>
                  )}
                </h4>

                {(isGstFormOpen || editingGstinId) && (
                  <button
                    type="button"
                    onClick={handleResetGstForm}
                    className="text-[11px] font-bold text-slate-500 hover:text-slate-900 underline cursor-pointer"
                  >
                    Cancel
                  </button>
                )}
              </div>

              {/* Sample Quick Fill Chips */}
              <div className="mb-3 p-2.5 bg-slate-50 rounded-xl border border-slate-200">
                <span className="text-[10px] font-extrabold uppercase text-slate-500 block mb-1.5 tracking-wider">
                  Quick Fill Sample Presets:
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {SAMPLE_GST_PRESETS.map((preset) => (
                    <button
                      key={preset.gstin}
                      type="button"
                      onClick={() => handleApplyGstPreset(preset)}
                      className="text-[10px] font-bold bg-white hover:bg-amber-50 text-slate-800 hover:text-amber-900 px-2 py-1 rounded-md border border-slate-200 transition cursor-pointer"
                    >
                      {preset.state} ({preset.stateCode})
                    </button>
                  ))}
                </div>
              </div>

              <form onSubmit={handleSaveGstinForm} className="space-y-3">
                <div>
                  <div className="flex justify-between items-center mb-1">
                    <label className="block text-xs font-bold text-slate-800">
                      GSTIN Number (15 Characters) <span className="text-red-500">*</span>
                    </label>
                    {formState && formGstin.length >= 2 && (
                      <span className="text-[10px] font-extrabold text-amber-800 bg-amber-50 px-2 py-0.5 rounded border border-amber-200">
                        Detected: {formStateCode} - {formState}
                      </span>
                    )}
                  </div>
                  <input
                    type="text"
                    maxLength={15}
                    value={formGstin}
                    onChange={(e) => handleGstinInputChange(e.target.value)}
                    placeholder="e.g. 29AABCP1429B1Z8"
                    className="w-full bg-slate-50 border border-slate-300 rounded-xl p-3 font-mono text-xs font-black text-slate-900 uppercase focus:outline-none focus:ring-2 focus:ring-amber-500"
                  />
                  {gstFormError && (
                    <p className="text-red-600 text-[11px] font-bold mt-1">{gstFormError}</p>
                  )}
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-800 mb-1">
                    Legal Registered Business Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={formLegalName}
                    onChange={(e) => setFormLegalName(e.target.value)}
                    placeholder="e.g. Apex MEP Infrastructure Pvt Ltd"
                    className="w-full bg-slate-50 border border-slate-300 rounded-xl p-3 text-xs font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-500"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <div>
                    <label className="block text-xs font-bold text-slate-800 mb-1">
                      Trade Name / Branch Tag
                    </label>
                    <input
                      type="text"
                      value={formTradeName}
                      onChange={(e) => setFormTradeName(e.target.value)}
                      placeholder="e.g. Bengaluru HQ / Site Phase 2"
                      className="w-full bg-slate-50 border border-slate-300 rounded-xl p-3 text-xs font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-500"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-800 mb-1">
                      State / Union Territory
                    </label>
                    <input
                      type="text"
                      value={formState}
                      onChange={(e) => setFormState(e.target.value)}
                      placeholder="e.g. Karnataka"
                      className="w-full bg-slate-50 border border-slate-300 rounded-xl p-3 text-xs font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-500"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-800 mb-1">
                    Registered Billing Address
                  </label>
                  <textarea
                    rows={2}
                    value={formBillingAddress}
                    onChange={(e) => setFormBillingAddress(e.target.value)}
                    placeholder="e.g. 14th Main Rd, 4th Block, Koramangala, Bengaluru - 560034"
                    className="w-full bg-slate-50 border border-slate-300 rounded-xl p-2.5 text-xs font-medium text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-500"
                  />
                </div>

                <div className="flex items-center gap-2 pt-1">
                  <input
                    type="checkbox"
                    id="formIsDefaultGst"
                    checked={formIsDefaultGst}
                    onChange={(e) => setFormIsDefaultGst(e.target.checked)}
                    className="w-4 h-4 text-amber-600 rounded border-slate-300 focus:ring-amber-500 cursor-pointer"
                  />
                  <label htmlFor="formIsDefaultGst" className="text-xs font-bold text-slate-800 cursor-pointer">
                    Set this as active default GSTIN for orders and tax invoices
                  </label>
                </div>

                <div className="flex gap-2 pt-2">
                  <button
                    type="submit"
                    className="flex-1 bg-slate-950 hover:bg-slate-900 text-white font-black text-xs sm:text-sm py-3 rounded-xl shadow-xs transition flex items-center justify-center gap-2 cursor-pointer"
                  >
                    {gstSaved ? (
                      <>
                        <Check className="w-4 h-4 text-amber-400" />
                        <span>Saved Successfully!</span>
                      </>
                    ) : (
                      <>
                        <Building2 className="w-4 h-4 text-amber-400" />
                        <span>{editingGstinId ? 'Update GSTIN Profile' : 'Save New Business GSTIN'}</span>
                      </>
                    )}
                  </button>

                  {editingGstinId && (
                    <button
                      type="button"
                      onClick={handleResetGstForm}
                      className="px-4 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs rounded-xl transition cursor-pointer"
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </form>
            </div>
          </div>
        )}

        {/* ------------------------------------------ */}
        {/* SUBVIEW: ADDRESS BOOK (MULTIPLE ADDRESSES) */}
        {/* ------------------------------------------ */}
        {activeSubView === 'address_book' && (
          <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-200 space-y-4 animate-in slide-in-from-right-4 duration-200">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <MapPin className="w-5 h-5 text-amber-600" />
                <h3 className="font-black text-slate-900 text-base">Address Book ({savedAddresses.length})</h3>
              </div>
              <button
                onClick={() => {
                  setIsAddingAddress(false);
                  setActiveSubView('main');
                }}
                className="text-xs font-bold text-slate-500 hover:text-slate-900 underline"
              >
                Back
              </button>
            </div>

            {/* List of Saved Addresses */}
            {!isAddingAddress ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs text-slate-500 font-medium">
                    Manage your delivery addresses, warehouse, and office locations.
                  </p>
                  <button
                    onClick={handleStartAddAddress}
                    className="bg-slate-950 hover:bg-slate-900 text-amber-300 font-black text-xs px-3 py-2 rounded-xl flex items-center gap-1.5 shadow-2xs transition cursor-pointer shrink-0"
                  >
                    <Plus className="w-4 h-4" />
                    <span>Add New Address</span>
                  </button>
                </div>

                <div className="space-y-3 pt-1">
                  {savedAddresses.map((addr) => (
                    <div
                      key={addr.id}
                      className={`p-4 rounded-xl border transition-all ${
                        addr.isDefault
                          ? 'bg-amber-50/60 border-amber-300 shadow-xs'
                          : 'bg-slate-50 border-slate-200 hover:border-slate-300'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="space-y-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="bg-slate-900 text-amber-300 text-[10px] font-black px-2 py-0.5 rounded uppercase tracking-wider">
                              {addr.tag}
                            </span>
                            {addr.isDefault && (
                              <span className="bg-amber-400 text-slate-950 text-[10px] font-black px-2 py-0.5 rounded uppercase tracking-wider flex items-center gap-1">
                                <Check className="w-3 h-3 stroke-[3]" /> Default Drop Location
                              </span>
                            )}
                          </div>
                          <h4 className="text-xs sm:text-sm font-extrabold text-slate-900 leading-snug pt-0.5">
                            {addr.address}
                          </h4>
                          <p className="text-xs text-slate-600 font-medium">
                            {addr.floorUnit}{addr.landmark ? ` • Landmark: ${addr.landmark}` : ''}
                          </p>
                        </div>

                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            onClick={() => handleStartEditAddress(addr)}
                            className="p-1.5 text-slate-500 hover:text-slate-900 hover:bg-slate-200/60 rounded-lg transition"
                            title="Edit Address"
                          >
                            <Edit2 className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => handleDeleteAddress(addr.id)}
                            className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition"
                            title="Delete Address"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>

                      {!addr.isDefault && (
                        <div className="mt-3 pt-2.5 border-t border-slate-200/80 flex justify-end">
                          <button
                            onClick={() => handleSetDefaultAddress(addr.id)}
                            className="text-xs font-bold text-slate-700 hover:text-slate-950 bg-white border border-slate-300 hover:border-slate-400 px-3 py-1.5 rounded-lg transition cursor-pointer shadow-2xs"
                          >
                            Set as Default Delivery Location
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {onOpenLocationModal && (
                  <button
                    type="button"
                    onClick={onOpenLocationModal}
                    className="w-full bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold text-xs py-3 rounded-xl transition cursor-pointer flex items-center justify-center gap-2 mt-2"
                  >
                    <MapPin className="w-4 h-4 text-amber-600" />
                    <span>Pick & Set Address on Live Map</span>
                  </button>
                )}
              </div>
            ) : (
              /* Add / Edit Address Form */
              <form onSubmit={handleSaveAddressForm} className="space-y-4 pt-1">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-black uppercase tracking-wider text-slate-800">
                    {editingAddressId ? 'Edit Address' : 'Add New Address'}
                  </h4>
                  <button
                    type="button"
                    onClick={() => setIsAddingAddress(false)}
                    className="text-xs font-bold text-slate-500 hover:text-slate-800"
                  >
                    Cancel
                  </button>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-800 mb-1.5">
                    Address Tag / Label
                  </label>
                  <div className="flex gap-2 flex-wrap">
                    {(['Job Site', 'Home', 'Work', 'Warehouse', 'Other'] as const).map((tagOption) => (
                      <button
                        key={tagOption}
                        type="button"
                        onClick={() => setFormTag(tagOption)}
                        className={`px-3 py-1.5 rounded-xl text-xs font-bold transition ${
                          formTag === tagOption
                            ? 'bg-slate-950 text-amber-300 font-black'
                            : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                        }`}
                      >
                        {tagOption}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-800 mb-1">
                    Street / Area Address *
                  </label>
                  <input
                    type="text"
                    required
                    value={formAddress}
                    onChange={(e) => setFormAddress(e.target.value)}
                    placeholder="e.g. 14th Main Rd, 4th Block, Koramangala, Bengaluru"
                    className="w-full bg-slate-50 border border-slate-300 rounded-xl p-3 text-xs text-slate-900 font-bold focus:outline-none focus:ring-2 focus:ring-amber-500"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-bold text-slate-800 mb-1">
                      Floor / Tower / Unit #
                    </label>
                    <input
                      type="text"
                      value={formFloorUnit}
                      onChange={(e) => setFormFloorUnit(e.target.value)}
                      placeholder="e.g. Tower B, 4th Floor"
                      className="w-full bg-slate-50 border border-slate-300 rounded-xl p-3 text-xs text-slate-900 font-bold focus:outline-none focus:ring-2 focus:ring-amber-500"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-800 mb-1">
                      Landmark / Gate Instructions
                    </label>
                    <input
                      type="text"
                      value={formLandmark}
                      onChange={(e) => setFormLandmark(e.target.value)}
                      placeholder="e.g. Near BDA Complex"
                      className="w-full bg-slate-50 border border-slate-300 rounded-xl p-3 text-xs text-slate-900 font-bold focus:outline-none focus:ring-2 focus:ring-amber-500"
                    />
                  </div>
                </div>

                <div className="flex items-center gap-2 pt-1">
                  <input
                    type="checkbox"
                    id="setDefaultCheck"
                    checked={formSetDefault}
                    onChange={(e) => setFormSetDefault(e.target.checked)}
                    className="w-4 h-4 text-amber-500 rounded border-slate-300 focus:ring-amber-400"
                  />
                  <label htmlFor="setDefaultCheck" className="text-xs font-bold text-slate-800 cursor-pointer select-none">
                    Set as my primary default delivery address
                  </label>
                </div>

                <div className="flex gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setIsAddingAddress(false)}
                    className="flex-1 bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold text-xs py-3 rounded-xl transition cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="flex-1 bg-slate-950 hover:bg-slate-900 text-white font-black text-xs py-3 rounded-xl transition cursor-pointer"
                  >
                    {editingAddressId ? 'Save Changes' : 'Add to Address Book'}
                  </button>
                </div>
              </form>
            )}
          </div>
        )}

        {/* ------------------------------------------ */}
        {/* SUBVIEW: BOOKMARKED HARDWARE LISTS         */}
        {/* ------------------------------------------ */}
        {activeSubView === 'bookmarks' && (
          <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-200 space-y-4 animate-in slide-in-from-right-4 duration-200">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <Bookmark className="w-5 h-5 text-amber-600" />
                <h3 className="font-black text-slate-900 text-base">Bookmarked Hardware BOMs</h3>
              </div>
              <button
                onClick={() => setActiveSubView('main')}
                className="text-xs font-bold text-slate-500 hover:text-slate-900 underline"
              >
                Back
              </button>
            </div>

            {/* Create New Bookmark Input */}
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="New BOM List Name (e.g. 3BHK Wiring BOM)..."
                value={newBookmarkTitle}
                onChange={(e) => setNewBookmarkTitle(e.target.value)}
                className="flex-1 bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-xs font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-500"
              />
              <button
                onClick={handleAddBookmark}
                className="bg-slate-950 hover:bg-slate-900 text-white font-bold text-xs px-3 py-2 rounded-xl flex items-center gap-1"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add</span>
              </button>
            </div>

            <div className="space-y-2.5">
              {bookmarks.map((bm) => (
                <div key={bm.id} className="p-3.5 bg-slate-50 rounded-xl border border-slate-200 flex justify-between items-center">
                  <div>
                    <h4 className="text-xs font-black text-slate-900">{bm.title}</h4>
                    <p className="text-[11px] text-slate-500 font-medium">
                      {bm.itemsCount} Items • Est: <span className="font-mono text-slate-800 font-bold">{bm.totalEst}</span>
                    </p>
                  </div>
                  <button
                    onClick={() => {
                      setBookmarks(bookmarks.filter(b => b.id !== bm.id));
                      showToast('List removed');
                    }}
                    className="p-1.5 text-slate-400 hover:text-red-600 transition"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ------------------------------------------ */}
        {/* SUBVIEW: WISHLIST                          */}
        {/* ------------------------------------------ */}
        {activeSubView === 'wishlist' && (
          <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-200 space-y-4 animate-in slide-in-from-right-4 duration-200">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <Heart className="w-5 h-5 text-red-500 fill-red-500" />
                <h3 className="font-black text-slate-900 text-base">Your Wishlist ({wishlist.length})</h3>
              </div>
              <button
                onClick={() => setActiveSubView('main')}
                className="text-xs font-bold text-slate-500 hover:text-slate-900 underline"
              >
                Back
              </button>
            </div>

            <div className="space-y-3">
              {wishlist.map((item) => (
                <div key={item.id} className="p-3.5 bg-slate-50 rounded-xl border border-slate-200 flex justify-between items-center">
                  <div className="space-y-0.5">
                    <span className="text-[10px] font-bold text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded uppercase">
                      {item.category}
                    </span>
                    <h4 className="text-xs font-extrabold text-slate-900">{item.name}</h4>
                    <p className="text-xs font-mono font-black text-slate-900">₹{item.price}</p>
                  </div>
                  <button
                    onClick={() => {
                      setWishlist(wishlist.filter(w => w.id !== item.id));
                      showToast('Added item to active cart!');
                    }}
                    className="bg-slate-950 hover:bg-slate-800 text-amber-300 font-bold text-xs px-3 py-2 rounded-lg"
                  >
                    Move to Cart
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ------------------------------------------ */}
        {/* SUBVIEW: E-GIFT CARDS & VOUCHERS          */}
        {/* ------------------------------------------ */}
        {activeSubView === 'gift_cards' && (
          <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-200 space-y-4 animate-in slide-in-from-right-4 duration-200">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <Gift className="w-5 h-5 text-amber-600" />
                <h3 className="font-black text-slate-900 text-base">Gift Cards &amp; Corporate Vouchers</h3>
              </div>
              <button
                onClick={() => setActiveSubView('main')}
                className="text-xs font-bold text-slate-500 hover:text-slate-900 underline"
              >
                Back
              </button>
            </div>

            {/* Balance Card */}
            <div className="p-4 bg-gradient-to-r from-slate-950 via-slate-900 to-slate-950 text-white rounded-xl shadow-md border border-amber-400/30 flex justify-between items-center">
              <div className="space-y-1">
                <span className="text-[10px] font-black uppercase tracking-wider bg-amber-400 text-slate-950 px-2 py-0.5 rounded">
                  Gift Card Balance
                </span>
                <p className="text-3xl font-black font-mono text-amber-300">₹{claimedBalance}</p>
                <p className="text-xs text-slate-300 font-medium">Applied automatically at instant checkout</p>
              </div>
              <Sparkles className="w-10 h-10 text-amber-400 opacity-80" />
            </div>

            {/* Redeem Gift Code Form */}
            <form onSubmit={handleClaimGiftCard} className="space-y-2 pt-1">
              <label className="block text-xs font-bold text-slate-800">Claim Gift Card / Voucher Code</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="e.g. BLINK2026"
                  value={giftCode}
                  onChange={(e) => setGiftCode(e.target.value)}
                  className="flex-1 bg-slate-50 border border-slate-300 rounded-xl px-3 py-2.5 font-mono text-xs font-bold uppercase text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-500"
                />
                <button
                  type="submit"
                  className="bg-slate-950 hover:bg-slate-900 text-amber-300 text-xs font-black px-4 py-2.5 rounded-xl transition cursor-pointer shadow-2xs"
                >
                  Claim Code
                </button>
              </div>
            </form>

            {/* Available Vouchers Section */}
            <div className="space-y-2 pt-2 border-t border-slate-100">
              <h4 className="text-xs font-black text-slate-900 uppercase tracking-wider">
                Available Contractor Vouchers
              </h4>

              <div className="space-y-2">
                {[
                  { title: '₹500 Site Welcome Gift Voucher', code: 'BLINK2026', value: '₹500 Credit', expires: 'Valid till 31 Dec 2026' },
                  { title: '₹250 B2B First Order Bonus', code: 'B2B250', value: '₹250 Credit', expires: 'Valid till 30 Nov 2026' },
                  { title: '₹1000 Electrical Bulk Order Voucher', code: 'ELEC1000', value: '₹1,000 Credit', expires: 'Valid till 15 Nov 2026' }
                ].map((voucher, idx) => (
                  <div key={idx} className="p-3.5 bg-slate-50 rounded-xl border border-slate-200 flex items-center justify-between gap-3">
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-black text-xs bg-amber-100 text-amber-900 px-2 py-0.5 rounded border border-amber-300/80">
                          {voucher.code}
                        </span>
                        <span className="text-[10px] font-bold text-emerald-800 bg-emerald-100 px-1.5 py-0.5 rounded">
                          {voucher.value}
                        </span>
                      </div>
                      <h5 className="text-xs font-extrabold text-slate-900 pt-0.5">{voucher.title}</h5>
                      <p className="text-[10px] text-slate-500 font-medium">{voucher.expires}</p>
                    </div>

                    <button
                      type="button"
                      onClick={() => {
                        setGiftCode(voucher.code);
                        showToast(`Voucher code ${voucher.code} copied to input!`);
                      }}
                      className="bg-slate-950 hover:bg-slate-800 text-white font-bold text-xs px-3 py-2 rounded-lg shrink-0 transition"
                    >
                      Use Code
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ------------------------------------------ */}
        {/* SUBVIEW: SITE SAFETY & COMPLIANCE         */}
        {/* ------------------------------------------ */}
        {activeSubView === 'compliance' && (
          <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-200 space-y-4 animate-in slide-in-from-right-4 duration-200">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <FileCheck className="w-5 h-5 text-amber-600" />
                <h3 className="font-black text-slate-900 text-base">Safety & Quality Certificates</h3>
              </div>
              <button
                onClick={() => setActiveSubView('main')}
                className="text-xs font-bold text-slate-500 hover:text-slate-900 underline"
              >
                Back
              </button>
            </div>

            <div className="space-y-3">
              {[
                { title: 'BIS Grade-A Electrical Wire Conformance Certificate', certNo: 'BIS-IND-94821', status: 'VERIFIED' },
                { title: 'ISO 9001:2015 CPVC Plumbing Pressure Rating Standard', certNo: 'ISO-PLM-3092', status: 'VERIFIED' },
                { title: 'Fire Retardant FR-LSH Switchgear Conformance Cert', certNo: 'FR-ELEC-8812', status: 'VERIFIED' }
              ].map((cert, idx) => (
                <div key={idx} className="p-3.5 bg-slate-50 rounded-xl border border-slate-200 flex justify-between items-center">
                  <div>
                    <span className="text-[10px] font-bold text-emerald-800 bg-emerald-100 px-1.5 py-0.5 rounded">
                      {cert.status}
                    </span>
                    <h4 className="text-xs font-extrabold text-slate-900 mt-1">{cert.title}</h4>
                    <p className="text-[11px] font-mono text-slate-500">{cert.certNo}</p>
                  </div>
                  <button
                    onClick={() => showToast('Downloading PDF Compliance Record...')}
                    className="p-2 bg-slate-200 hover:bg-slate-300 text-slate-800 rounded-lg"
                    title="Download PDF"
                  >
                    <Download className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ------------------------------------------ */}
        {/* SUBVIEW: PAYMENT SETTINGS                 */}
        {/* ------------------------------------------ */}
        {activeSubView === 'payment_settings' && (
          <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-200 space-y-4 animate-in slide-in-from-right-4 duration-200">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <Receipt className="w-5 h-5 text-amber-600" />
                <h3 className="font-black text-slate-900 text-base">Saved Payment Settings</h3>
              </div>
              <button
                onClick={() => setActiveSubView('main')}
                className="text-xs font-bold text-slate-500 hover:text-slate-900 underline"
              >
                Back
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-bold text-slate-800 mb-1">Primary VPA / UPI ID</label>
                <input
                  type="text"
                  value={upiId}
                  onChange={(e) => setUpiId(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-300 rounded-xl p-3 font-mono text-xs font-bold text-slate-900"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-800 mb-1">Saved Corporate Card</label>
                <input
                  type="text"
                  value={savedCard}
                  onChange={(e) => setSavedCard(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-300 rounded-xl p-3 text-xs font-bold text-slate-900"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-800 mb-1">Default Checkout Payment Method</label>
                <div className="grid grid-cols-3 gap-2">
                  {(['UPI', 'CARD', 'COD'] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setDefaultPayment(m)}
                      className={`py-2 text-xs font-bold rounded-xl border transition ${
                        defaultPayment === m
                          ? 'bg-slate-950 text-amber-300 border-slate-950'
                          : 'bg-slate-50 text-slate-700 border-slate-200'
                      }`}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </div>

              <button
                type="button"
                onClick={() => {
                  showToast('Payment settings updated!');
                  setActiveSubView('main');
                }}
                className="w-full bg-slate-950 hover:bg-slate-900 text-white font-black text-xs py-3 rounded-xl transition cursor-pointer"
              >
                Save Payment Methods
              </button>
            </div>
          </div>
        )}

        {/* ------------------------------------------ */}
        {/* SUBVIEW: REWARDS & CASHBACK               */}
        {/* ------------------------------------------ */}
        {activeSubView === 'rewards' && (
          <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-200 space-y-4 animate-in slide-in-from-right-4 duration-200">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <Award className="w-5 h-5 text-amber-600" />
                <h3 className="font-black text-slate-900 text-base">Contractor Rewards & Coins</h3>
              </div>
              <button
                onClick={() => setActiveSubView('main')}
                className="text-xs font-bold text-slate-500 hover:text-slate-900 underline"
              >
                Back
              </button>
            </div>

            <div className="p-4 bg-gradient-to-br from-slate-950 to-slate-900 text-white rounded-xl shadow-xs flex justify-between items-center">
              <div>
                <span className="text-[10px] font-bold text-amber-400 uppercase tracking-wider">
                  Express Trade Points
                </span>
                <p className="text-3xl font-black text-amber-300 font-mono">420 Coins</p>
                <p className="text-xs text-slate-300 font-medium mt-0.5">₹1 Coin = ₹1 Discount on Next Order</p>
              </div>
              <Sparkles className="w-10 h-10 text-amber-400" />
            </div>

            <div className="space-y-2">
              <h4 className="text-xs font-extrabold text-slate-900">Active Coupons</h4>
              {[
                { code: 'BULKBMS10', desc: '10% OFF on Orders above ₹10,000' },
                { code: 'FREESHIP50', desc: 'Zero Express Site Delivery Fee' }
              ].map((c, i) => (
                <div key={i} className="p-3 bg-amber-50 border border-amber-200 rounded-xl flex justify-between items-center">
                  <div>
                    <span className="font-mono font-black text-xs text-amber-900">{c.code}</span>
                    <p className="text-[11px] text-amber-800 font-medium">{c.desc}</p>
                  </div>
                  <button
                    onClick={() => {
                      navigator.clipboard?.writeText(c.code);
                      showToast(`Copied ${c.code}!`);
                    }}
                    className="p-1.5 text-amber-900 hover:text-amber-950 font-bold text-xs"
                  >
                    <Copy className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ------------------------------------------ */}
        {/* SUBVIEW: FEEDING INDIA & IMPACT            */}
        {/* ------------------------------------------ */}
        {activeSubView === 'impact' && (
          <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-200 space-y-4 animate-in slide-in-from-right-4 duration-200">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-amber-600" />
                <h3 className="font-black text-slate-900 text-base">Feeding India CSR Impact</h3>
              </div>
              <button
                onClick={() => setActiveSubView('main')}
                className="text-xs font-bold text-slate-500 hover:text-slate-900 underline"
              >
                Back
              </button>
            </div>

            <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-xl text-center space-y-1">
              <p className="text-3xl font-black text-emerald-900 font-mono">142 Meals</p>
              <p className="text-xs font-bold text-emerald-800">
                Donated through your Hardware Order contributions.
              </p>
            </div>

            <button
              onClick={() => showToast('Generating 80G Tax Exemption Certificate...')}
              className="w-full bg-slate-950 text-white font-bold text-xs py-3 rounded-xl flex items-center justify-center gap-2"
            >
              <Download className="w-4 h-4 text-amber-300" />
              <span>Download 80G Tax Exemption Receipt</span>
            </button>
          </div>
        )}

        {/* ------------------------------------------ */}
        {/* SUBVIEW: ABOUT US                          */}
        {/* ------------------------------------------ */}
        {activeSubView === 'about' && (
          <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-200 space-y-4 animate-in slide-in-from-right-4 duration-200">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <Info className="w-5 h-5 text-amber-600" />
                <h3 className="font-black text-slate-900 text-base">About RushQ</h3>
              </div>
              <button
                onClick={() => setActiveSubView('main')}
                className="text-xs font-bold text-slate-500 hover:text-slate-900 underline"
              >
                Back
              </button>
            </div>

            <div className="space-y-3 text-xs text-slate-700 leading-relaxed font-medium">
              <p>
                RushQ Edition delivers electrical, plumbing, power tools, safety equipment, and building materials directly to your delivery address with express quick-commerce speed.
              </p>
              <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 space-y-1">
                <p className="font-bold text-slate-900">App Version: 17.73.1 • Hardware Build</p>
                <p className="text-[11px] text-slate-500">Dark Store Operating Radius: Koramangala & Indiranagar Hubs</p>
              </div>
            </div>
          </div>
        )}

        {/* ------------------------------------------ */}
        {/* SUBVIEW: PRIVACY & DATA SETTINGS           */}
        {/* ------------------------------------------ */}
        {activeSubView === 'privacy' && (
          <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-200 space-y-4 animate-in slide-in-from-right-4 duration-200">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-amber-600" />
                <h3 className="font-black text-slate-900 text-base">Account Privacy & Security</h3>
              </div>
              <button
                onClick={() => setActiveSubView('main')}
                className="text-xs font-bold text-slate-500 hover:text-slate-900 underline"
              >
                Back
              </button>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between py-2 border-b border-slate-100">
                <span className="text-xs font-bold text-slate-800">Personalized Recommendations</span>
                <button
                  type="button"
                  onClick={() => setPersonalizedOffers(!personalizedOffers)}
                  className={`w-10 h-5 rounded-full transition-colors p-0.5 ${personalizedOffers ? 'bg-slate-950' : 'bg-slate-200'}`}
                >
                  <div className={`w-4 h-4 rounded-full bg-white transition-transform ${personalizedOffers ? 'translate-x-5' : 'translate-x-0'}`} />
                </button>
              </div>

              <div className="flex items-center justify-between py-2 border-b border-slate-100">
                <span className="text-xs font-bold text-slate-800">Share Anonymous Usage Analytics</span>
                <button
                  type="button"
                  onClick={() => setDataSharing(!dataSharing)}
                  className={`w-10 h-5 rounded-full transition-colors p-0.5 ${dataSharing ? 'bg-slate-950' : 'bg-slate-200'}`}
                >
                  <div className={`w-4 h-4 rounded-full bg-white transition-transform ${dataSharing ? 'translate-x-5' : 'translate-x-0'}`} />
                </button>
              </div>

              <button
                onClick={() => showToast('Exporting account data to your email...')}
                className="w-full bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold text-xs py-2.5 rounded-xl transition"
              >
                Request Full Data Export
              </button>
            </div>
          </div>
        )}

        {/* ------------------------------------------ */}
        {/* SUBVIEW: NOTIFICATION PREFERENCES          */}
        {/* ------------------------------------------ */}
        {activeSubView === 'notifications' && (
          <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-200 space-y-4 animate-in slide-in-from-right-4 duration-200">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <Bell className="w-5 h-5 text-amber-600" />
                <h3 className="font-black text-slate-900 text-base">Notification Preferences</h3>
              </div>
              <button
                onClick={() => setActiveSubView('main')}
                className="text-xs font-bold text-slate-500 hover:text-slate-900 underline"
              >
                Back
              </button>
            </div>

            <div className="space-y-3">
              {[
                { title: 'WhatsApp Live Delivery Updates', desc: 'Driver GPS link and dispatch ETA', state: notifyWhatsapp, set: setNotifyWhatsapp },
                { title: 'SMS Invoices & Receipts', desc: 'Automatic 18% ITC GST invoices', state: notifySms, set: setNotifySms },
                { title: 'Live Order Tracking Push Notifications', desc: 'Realtime order status alerts', state: notifyTracking, set: setNotifyTracking },
                { title: 'Daily Deal & Restock Alerts', desc: 'Promotions on wire, PVC & tools', state: notifyDeals, set: setNotifyDeals }
              ].map((item, idx) => (
                <div key={idx} className="flex items-center justify-between py-2 border-b border-slate-100">
                  <div>
                    <p className="text-xs font-extrabold text-slate-900">{item.title}</p>
                    <p className="text-[11px] text-slate-500">{item.desc}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => item.set(!item.state)}
                    className={`w-10 h-5 rounded-full transition-colors p-0.5 shrink-0 ${item.state ? 'bg-slate-950' : 'bg-slate-200'}`}
                  >
                    <div className={`w-4 h-4 rounded-full bg-white transition-transform ${item.state ? 'translate-x-5' : 'translate-x-0'}`} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ------------------------------------------ */}
        {/* SUBVIEW: EDIT PERSONAL PROFILE             */}
        {/* ------------------------------------------ */}
        {activeSubView === 'edit_profile' && (
          <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-200 space-y-4 animate-in slide-in-from-right-4 duration-200">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <h3 className="font-black text-slate-900 text-base">Edit Personal Details</h3>
              <button
                onClick={() => setActiveSubView('main')}
                className="text-xs font-bold text-slate-500 hover:text-slate-900 underline"
              >
                Back
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-bold text-slate-800 mb-1">Full Name</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-300 rounded-xl p-3 text-xs font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-500"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-800 mb-1">Phone Number</label>
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-300 rounded-xl p-3 text-xs font-mono font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-500"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-800 mb-1">Email Address</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-300 rounded-xl p-3 text-xs font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-500"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-800 mb-1">Date of Birth</label>
                <input
                  type="text"
                  value={dob}
                  onChange={(e) => setDob(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-300 rounded-xl p-3 text-xs font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-500"
                />
              </div>
            </div>

            <button
              type="button"
              onClick={handleSavePersonal}
              className="w-full bg-slate-950 hover:bg-slate-900 text-white font-black text-sm py-3 rounded-xl transition cursor-pointer"
            >
              Update Profile
            </button>
          </div>
        )}

        {/* ------------------------------------------ */}
        {/* MAIN PROFILE PAGE VIEW                     */}
        {/* ------------------------------------------ */}
        {activeSubView === 'main' && (
          <>
            {/* 1. TOP 3-GRID QUICK ACTIONS */}
            <div className="grid grid-cols-3 gap-2.5 sm:gap-3">
              
              {/* Card 1: Your orders */}
              <button
                onClick={() => setActiveSubView('orders')}
                className="bg-white hover:bg-slate-50 border border-slate-200/90 rounded-2xl p-3 sm:p-4 flex flex-col items-center justify-center text-center shadow-xs transition hover:shadow-md cursor-pointer active:scale-98"
              >
                <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-xl bg-slate-100 text-slate-900 flex items-center justify-center mb-2">
                  <ShoppingBag className="w-5 h-5 sm:w-6 sm:h-6 stroke-[1.8]" />
                </div>
                <span className="text-xs sm:text-sm font-extrabold text-slate-900 leading-tight">
                  Your orders
                </span>
              </button>

              {/* Card 2: Reorder */}
              <button
                onClick={() => {
                  onOpenRestock();
                }}
                className="bg-white hover:bg-slate-50 border border-slate-200/90 rounded-2xl p-3 sm:p-4 flex flex-col items-center justify-center text-center shadow-xs transition hover:shadow-md cursor-pointer active:scale-98"
              >
                <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-xl bg-emerald-50 text-emerald-800 flex items-center justify-center mb-2 border border-emerald-200/60">
                  <RotateCcw className="w-5 h-5 sm:w-6 sm:h-6 stroke-[1.8] text-emerald-700" />
                </div>
                <span className="text-xs sm:text-sm font-extrabold text-slate-900 leading-tight">
                  Reorder
                </span>
                <span className="text-[10px] font-medium text-emerald-700 mt-0.5">Past Orders</span>
              </button>

              {/* Card 3: Need help? */}
              <a
                href="https://wa.me/919845012891?text=Hi%20Support%2C%20I%20need%20help%20with%20my%20order"
                target="_blank"
                rel="noreferrer"
                className="bg-white hover:bg-slate-50 border border-slate-200/90 rounded-2xl p-3 sm:p-4 flex flex-col items-center justify-center text-center shadow-xs transition hover:shadow-md cursor-pointer active:scale-98"
              >
                <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-xl bg-slate-100 text-slate-900 flex items-center justify-center mb-2">
                  <HelpCircle className="w-5 h-5 sm:w-6 sm:h-6 stroke-[1.8]" />
                </div>
                <span className="text-xs sm:text-sm font-extrabold text-slate-900 leading-tight">
                  Need help?
                </span>
              </a>

            </div>

            {/* 2. APPEARANCE & SENSITIVE ITEMS TOGGLES */}
            <div className="bg-white rounded-2xl border border-slate-200/90 p-3.5 sm:p-4 shadow-xs space-y-3">
              
              {/* Appearance Row */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <Sun className="w-4 h-4 text-slate-700" />
                  <span className="text-xs sm:text-sm font-extrabold text-slate-800">
                    Appearance
                  </span>
                </div>

                <div className="relative">
                  <select
                    value={appearance}
                    onChange={(e) => {
                      const val = e.target.value as 'LIGHT' | 'DARK';
                      setAppearance(val);
                      showToast(`Switched to ${val} Mode`);
                    }}
                    className="bg-slate-100 border border-slate-200 rounded-lg px-2.5 py-1 text-[11px] font-extrabold text-slate-800 uppercase focus:outline-none cursor-pointer"
                  >
                    <option value="LIGHT">LIGHT</option>
                    <option value="DARK">DARK</option>
                  </select>
                </div>
              </div>

              <div className="h-px bg-slate-100" />

              {/* Hide Sensitive Items Row */}
              <div className="flex items-center justify-between">
                <div className="flex items-start gap-2.5 pr-2">
                  <EyeOff className="w-4 h-4 text-slate-700 shrink-0 mt-0.5" />
                  <div>
                    <span className="text-xs sm:text-sm font-extrabold text-slate-800 block leading-snug">
                      Hide sensitive items
                    </span>
                    <span className="text-[11px] text-slate-500 leading-tight block">
                      Chemicals, high-voltage equipment and restricted items will be hidden.{' '}
                      <button 
                        type="button" 
                        onClick={() => alert("Restricted safety chemicals and high-voltage equipment require special contractor verification.")}
                        className="underline text-slate-600 hover:text-slate-900 font-medium"
                      >
                        Know more
                      </button>
                    </span>
                  </div>
                </div>

                {/* Custom Toggle Switch */}
                <button
                  type="button"
                  onClick={() => {
                    const next = !hideSensitive;
                    setHideSensitive(next);
                    showToast(next ? 'Sensitive items hidden' : 'Showing all items');
                  }}
                  className={`w-11 h-6 rounded-full transition-colors p-0.5 shrink-0 cursor-pointer ${
                    hideSensitive ? 'bg-slate-950' : 'bg-slate-200'
                  }`}
                >
                  <div
                    className={`w-5 h-5 rounded-full bg-white shadow-xs transition-transform ${
                      hideSensitive ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

            </div>

            {/* 3. SECTION CARD: YOUR INFORMATION */}
            <div className="bg-white rounded-2xl border border-slate-200/90 shadow-xs overflow-hidden">
              <div className="px-4 pt-3.5 pb-1">
                <h3 className="text-xs sm:text-sm font-black text-slate-900 tracking-tight">
                  Your information
                </h3>
              </div>

              <div className="divide-y divide-slate-100">
                {/* Address book */}
                <button
                  onClick={() => setActiveSubView('address_book')}
                  className="w-full px-4 py-3.5 flex items-center justify-between hover:bg-slate-50 transition text-left cursor-pointer"
                >
                  <div className="flex items-center gap-3">
                    <BookOpen className="w-4 h-4 text-slate-700" />
                    <span className="text-xs sm:text-sm font-bold text-slate-800">Address book</span>
                  </div>
                  <ChevronRight className="w-4 h-4 text-slate-400" />
                </button>

                {/* Bookmarked recipes / lists */}
                <button
                  onClick={() => setActiveSubView('bookmarks')}
                  className="w-full px-4 py-3.5 flex items-center justify-between hover:bg-slate-50 transition text-left cursor-pointer"
                >
                  <div className="flex items-center gap-3">
                    <Bookmark className="w-4 h-4 text-slate-700" />
                    <span className="text-xs sm:text-sm font-bold text-slate-800">Bookmarked hardware lists</span>
                  </div>
                  <ChevronRight className="w-4 h-4 text-slate-400" />
                </button>

                {/* Your wishlist */}
                <button
                  onClick={() => setActiveSubView('wishlist')}
                  className="w-full px-4 py-3.5 flex items-center justify-between hover:bg-slate-50 transition text-left cursor-pointer"
                >
                  <div className="flex items-center gap-3">
                    <Heart className="w-4 h-4 text-slate-700" />
                    <span className="text-xs sm:text-sm font-bold text-slate-800">Your wishlist</span>
                  </div>
                  <ChevronRight className="w-4 h-4 text-slate-400" />
                </button>

                {/* GST details */}
                <button
                  onClick={() => setActiveSubView('gst_details')}
                  className="w-full px-4 py-3.5 flex items-center justify-between hover:bg-slate-50 transition text-left cursor-pointer"
                >
                  <div className="flex items-center gap-3">
                    <Building2 className="w-4 h-4 text-slate-700" />
                    <div className="flex items-center gap-2">
                      <span className="text-xs sm:text-sm font-bold text-slate-800">GST details & Invoicing</span>
                      {savedGstins.length > 0 && (
                        <span className="text-[10px] bg-amber-100 text-amber-900 font-mono font-bold px-1.5 py-0.5 rounded">
                          {savedGstins.length} {savedGstins.length === 1 ? 'GSTIN' : 'GSTINs'}
                        </span>
                      )}
                    </div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-slate-400" />
                </button>

                {/* Your prescriptions / Safety Compliance */}
                <button
                  onClick={() => setActiveSubView('compliance')}
                  className="w-full px-4 py-3.5 flex items-center justify-between hover:bg-slate-50 transition text-left cursor-pointer"
                >
                  <div className="flex items-center gap-3">
                    <FileCheck className="w-4 h-4 text-slate-700" />
                    <span className="text-xs sm:text-sm font-bold text-slate-800">Site Safety & Compliance certificates</span>
                  </div>
                  <ChevronRight className="w-4 h-4 text-slate-400" />
                </button>
              </div>
            </div>

            {/* 4. SECTION CARD: PAYMENT AND COUPONS */}
            <div className="bg-white rounded-2xl border border-slate-200/90 shadow-xs overflow-hidden">
              <div className="px-4 pt-3.5 pb-1">
                <h3 className="text-xs sm:text-sm font-black text-slate-900 tracking-tight">
                  Payment and coupons
                </h3>
              </div>

              <div className="divide-y divide-slate-100">
                {/* Payment settings */}
                <button
                  onClick={() => setActiveSubView('payment_settings')}
                  className="w-full px-4 py-3.5 flex items-center justify-between hover:bg-slate-50 transition text-left cursor-pointer"
                >
                  <div className="flex items-center gap-3">
                    <Receipt className="w-4 h-4 text-slate-700" />
                    <span className="text-xs sm:text-sm font-bold text-slate-800">Payment settings</span>
                  </div>
                  <ChevronRight className="w-4 h-4 text-slate-400" />
                </button>

                {/* Gift cards & Corporate Vouchers */}
                <button
                  onClick={() => setActiveSubView('gift_cards')}
                  className="w-full px-4 py-3.5 flex items-center justify-between hover:bg-slate-50 transition text-left cursor-pointer"
                >
                  <div className="flex items-center gap-3">
                    <Gift className="w-4 h-4 text-slate-700" />
                    <span className="text-xs sm:text-sm font-bold text-slate-800">Gift cards &amp; Corporate Vouchers</span>
                  </div>
                  <ChevronRight className="w-4 h-4 text-slate-400" />
                </button>

                {/* Your collected rewards */}
                <button
                  onClick={() => setActiveSubView('rewards')}
                  className="w-full px-4 py-3.5 flex items-center justify-between hover:bg-slate-50 transition text-left cursor-pointer"
                >
                  <div className="flex items-center gap-3">
                    <Award className="w-4 h-4 text-slate-700" />
                    <span className="text-xs sm:text-sm font-bold text-slate-800">Your collected rewards</span>
                  </div>
                  <ChevronRight className="w-4 h-4 text-slate-400" />
                </button>
              </div>
            </div>

            {/* 5. SECTION CARD: FEEDING INDIA / CSR */}
            <div className="bg-white rounded-2xl border border-slate-200/90 shadow-xs overflow-hidden">
              <div className="px-4 pt-3.5 pb-1">
                <h3 className="text-xs sm:text-sm font-black text-slate-900 tracking-tight">
                  Feeding India & Sustainability
                </h3>
              </div>

              <div className="divide-y divide-slate-100">
                <button
                  onClick={() => setActiveSubView('impact')}
                  className="w-full px-4 py-3.5 flex items-center justify-between hover:bg-slate-50 transition text-left cursor-pointer"
                >
                  <div className="flex items-center gap-3">
                    <Sparkles className="w-4 h-4 text-amber-600" />
                    <span className="text-xs sm:text-sm font-bold text-slate-800">Your impact</span>
                  </div>
                  <ChevronRight className="w-4 h-4 text-slate-400" />
                </button>

                <button
                  onClick={() => setActiveSubView('impact')}
                  className="w-full px-4 py-3.5 flex items-center justify-between hover:bg-slate-50 transition text-left cursor-pointer"
                >
                  <div className="flex items-center gap-3">
                    <Receipt className="w-4 h-4 text-slate-700" />
                    <span className="text-xs sm:text-sm font-bold text-slate-800">Get Feeding India receipt</span>
                  </div>
                  <ChevronRight className="w-4 h-4 text-slate-400" />
                </button>
              </div>
            </div>

            {/* 6. SECTION CARD: OTHER INFORMATION */}
            <div className="bg-white rounded-2xl border border-slate-200/90 shadow-xs overflow-hidden">
              <div className="px-4 pt-3.5 pb-1">
                <h3 className="text-xs sm:text-sm font-black text-slate-900 tracking-tight">
                  Other Information
                </h3>
              </div>

              <div className="divide-y divide-slate-100">
                {/* Share the app */}
                <button 
                  onClick={() => {
                    if (navigator.share) {
                      navigator.share({ title: 'RushQ', url: window.location.href });
                    } else {
                      navigator.clipboard?.writeText(window.location.href);
                      showToast('App share link copied to clipboard!');
                    }
                  }}
                  className="w-full px-4 py-3.5 flex items-center justify-between hover:bg-slate-50 transition text-left cursor-pointer"
                >
                  <div className="flex items-center gap-3">
                    <Share2 className="w-4 h-4 text-slate-700" />
                    <span className="text-xs sm:text-sm font-bold text-slate-800">Share the app</span>
                  </div>
                  <ChevronRight className="w-4 h-4 text-slate-400" />
                </button>

                {/* About us */}
                <button
                  onClick={() => setActiveSubView('about')}
                  className="w-full px-4 py-3.5 flex items-center justify-between hover:bg-slate-50 transition text-left cursor-pointer"
                >
                  <div className="flex items-center gap-3">
                    <Info className="w-4 h-4 text-slate-700" />
                    <span className="text-xs sm:text-sm font-bold text-slate-800">About us</span>
                  </div>
                  <ChevronRight className="w-4 h-4 text-slate-400" />
                </button>

                {/* Account privacy */}
                <button
                  onClick={() => setActiveSubView('privacy')}
                  className="w-full px-4 py-3.5 flex items-center justify-between hover:bg-slate-50 transition text-left cursor-pointer"
                >
                  <div className="flex items-center gap-3">
                    <ShieldCheck className="w-4 h-4 text-slate-700" />
                    <span className="text-xs sm:text-sm font-bold text-slate-800">Account privacy</span>
                  </div>
                  <ChevronRight className="w-4 h-4 text-slate-400" />
                </button>

                {/* Notification preferences */}
                <button
                  onClick={() => setActiveSubView('notifications')}
                  className="w-full px-4 py-3.5 flex items-center justify-between hover:bg-slate-50 transition text-left cursor-pointer"
                >
                  <div className="flex items-center gap-3">
                    <Bell className="w-4 h-4 text-slate-700" />
                    <span className="text-xs sm:text-sm font-bold text-slate-800">Notification preferences</span>
                  </div>
                  <ChevronRight className="w-4 h-4 text-slate-400" />
                </button>

                {/* Log out */}
                <button
                  onClick={() => {
                    if (confirm('Are you sure you want to log out of your profile?')) {
                      showToast('Logged out successfully');
                      setTimeout(onClose, 500);
                    }
                  }}
                  className="w-full px-4 py-3.5 flex items-center justify-between hover:bg-red-50 transition text-left cursor-pointer"
                >
                  <div className="flex items-center gap-3 text-red-600">
                    <LogOut className="w-4 h-4" />
                    <span className="text-xs sm:text-sm font-bold">Log out</span>
                  </div>
                  <ChevronRight className="w-4 h-4 text-red-300" />
                </button>
              </div>
            </div>

          </>
        )}

      </div>

    </div>
  );
};
