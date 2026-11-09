import React, { useState, useEffect, useRef } from 'react';
import { 
  ArrowLeft, 
  MapPin, 
  Home,
  Briefcase,
  Building,
  MoreVertical,
  Share2,
  Search,
  X,
  LocateFixed,
  Plus,
  MessageSquare,
  Sparkles,
  CheckCircle2,
  Pencil,
  Trash2,
  ChevronRight,
  Globe,
  Loader2
} from 'lucide-react';
import { AddressLocation } from '../types';
import { calculateDynamicDeliveryEta } from '../utils/deliveryEta';
import { OpenStreetMap } from './OpenStreetMap';
import { reverseGeocodeCoordinates, searchAddressGlobal, SearchLocationResult, getLiveUserLocation } from '../utils/geolocation';

export interface SavedAddress {
  id: string;
  tag: 'Home' | 'Work' | 'Hotel' | 'Other' | 'Address' | 'Warehouse';
  address: string;
  floorUnit: string;
  landmark: string;
  siteContactName: string;
  sitePhone: string;
  isDefault: boolean;
  orderingFor?: 'Myself' | 'Someone else';
  coordinates: {
    lat: number;
    lng: number;
  };
  distanceSla?: string;
}

const DEFAULT_SAVED_ADDRESSES: SavedAddress[] = [
  {
    id: 'addr_home',
    tag: 'Home',
    address: 'Flat No. 38, 3rd Floor, Dollar Point Apartments, Dollars Colony, Bengaluru, Karnataka, 560078',
    floorUnit: 'Flat No. 38, 3rd Floor',
    landmark: 'Near Dollar Colony Park',
    siteContactName: 'Rohan K',
    sitePhone: '+91 9611193492',
    isDefault: true,
    orderingFor: 'Myself',
    coordinates: { lat: 12.9081, lng: 77.5963 },
    distanceSla: calculateDynamicDeliveryEta({lat: 12.9081, lng: 77.5963}).etaMins + ' minutes • 1.6 km away',
  },
  {
    id: 'addr_work',
    tag: 'Work',
    address: 'Suite 402, 4th Floor, Tech Hub Tower, 100ft Road, Indiranagar, Bengaluru, Karnataka, 560038',
    floorUnit: 'Suite 402, 4th Floor',
    landmark: 'Opposite Metro Station Pillar #124',
    siteContactName: 'Rohan K',
    sitePhone: '+91 9611193492',
    isDefault: false,
    orderingFor: 'Myself',
    coordinates: { lat: 12.9716, lng: 77.6412 },
    distanceSla: calculateDynamicDeliveryEta({lat: 12.9716, lng: 77.6412}).etaMins + ' minutes • 3.2 km away',
  },
  {
    id: 'addr_site',
    tag: 'Other',
    address: 'Site #14, 14th Main Rd, 4th Block, Koramangala, Bengaluru, Karnataka, 560034',
    floorUnit: 'Tower B, Ground Floor Storage',
    landmark: 'Opposite BDA Complex Gate 2',
    siteContactName: 'Rahul Sharma (Lead)',
    sitePhone: '+91 98450 12891',
    isDefault: false,
    orderingFor: 'Someone else',
    coordinates: { lat: 12.9352, lng: 77.6245 },
    distanceSla: calculateDynamicDeliveryEta({lat: 12.9352, lng: 77.6245}).etaMins + ' minutes • 2.1 km away',
  },
];

interface LocationPageProps {
  currentLocation: AddressLocation;
  onSaveLocation: (loc: AddressLocation) => void;
  onClose: () => void;
}

type FlowStep = 'step1_select' | 'step2_map' | 'step3_details';

export const LocationPage: React.FC<LocationPageProps> = ({
  currentLocation,
  onSaveLocation,
  onClose,
}) => {
  const [step, setStep] = useState<FlowStep>('step1_select');

  // Saved Addresses State
  const [savedAddresses, setSavedAddresses] = useState<SavedAddress[]>(() => {
    try {
      const stored = localStorage.getItem('rushq_saved_addresses_list') || localStorage.getItem('quickhardware_saved_addresses_list');
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch {
      // fallback
    }
    return DEFAULT_SAVED_ADDRESSES;
  });

  const [activeAddressId, setActiveAddressId] = useState<string>(() => {
    const match = savedAddresses.find(
      (a) => a.address.toLowerCase() === currentLocation.address.toLowerCase()
    );
    return match ? match.id : savedAddresses[0]?.id || 'addr_home';
  });

  // Search & Map Picking State
  const [searchQuery, setSearchQuery] = useState('');
  const [mapSearchQuery, setMapSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchLocationResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const searchDebounceRef = useRef<NodeJS.Timeout | null>(null);

  const [selectedCoords, setSelectedCoords] = useState<{ lat: number; lng: number }>(
    currentLocation.coordinates || { lat: 12.9081, lng: 77.5963 }
  );

  // Address Geocoded Location Meta
  const [geocodedArea, setGeocodedArea] = useState<{
    mainArea: string;
    subArea: string;
    fullFormatted: string;
  }>({
    mainArea: 'Selected Location',
    subArea: 'Current Area',
    fullFormatted: currentLocation.address || 'Selected Location',
  });

  // Step 3 Form State
  const [orderingFor, setOrderingFor] = useState<'Myself' | 'Someone else'>('Myself');
  const [addressTag, setAddressTag] = useState<'Home' | 'Work' | 'Hotel' | 'Other'>('Home');
  const [buildingHouse, setBuildingHouse] = useState('');
  const [floorUnit, setFloorUnit] = useState('');
  const [landmark, setLandmark] = useState('');
  const [receiverName, setReceiverName] = useState('Rohan K');
  const [receiverPhone, setReceiverPhone] = useState('+91 9611193492');
  const [editingAddressId, setEditingAddressId] = useState<string | null>(null);

  // Toast and status alerts
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [isDetectingGps, setIsDetectingGps] = useState(false);
  const [activeMenuAddressId, setActiveMenuAddressId] = useState<string | null>(null);
  const [showShareBanner, setShowShareBanner] = useState(true);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3000);
  };

  const persistAddresses = (list: SavedAddress[]) => {
    setSavedAddresses(list);
    try {
      localStorage.setItem('rushq_saved_addresses_list', JSON.stringify(list));
    } catch {
      // ignore
    }
  };

  // Perform reverse geocode when coordinates change anywhere globally
  const updateAddressFromCoords = async (lat: number, lng: number) => {
    setSelectedCoords({ lat, lng });
    try {
      const res = await reverseGeocodeCoordinates(lat, lng);
      const main = res.road || res.suburb || res.city || 'Selected Location';
      const subParts: string[] = [];
      if (res.suburb && res.suburb !== main) subParts.push(res.suburb);
      if (res.city && res.city !== main) subParts.push(res.city);
      if (res.state) subParts.push(res.state);
      if (res.country) subParts.push(res.country);

      setGeocodedArea({
        mainArea: main,
        subArea: subParts.join(', ') || res.country || 'Global Location',
        fullFormatted: res.formattedAddress,
      });
    } catch (e) {
      console.error('Error reverse geocoding:', e);
    }
  };

  // Initial geocoding on mount
  useEffect(() => {
    if (currentLocation.coordinates) {
      updateAddressFromCoords(currentLocation.coordinates.lat, currentLocation.coordinates.lng);
    }
  }, []);

  // Global search autocomplete handler for Step 1 and Step 2
  const handlePerformSearch = (query: string) => {
    if (searchDebounceRef.current) {
      clearTimeout(searchDebounceRef.current);
    }
    if (!query || query.trim().length < 2) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }

    setIsSearching(true);
    searchDebounceRef.current = setTimeout(async () => {
      const results = await searchAddressGlobal(query);
      setSearchResults(results);
      setIsSearching(false);
    }, 350);
  };

  // Handle selecting a global search suggestion
  const handleSelectSearchResult = async (result: SearchLocationResult) => {
    setSearchResults([]);
    setSearchQuery('');
    setMapSearchQuery('');
    await updateAddressFromCoords(result.lat, result.lng);
    setStep('step2_map');
    showToast(`Location set to ${result.mainName}`);
  };

  // Handle GPS detection (Global - no city restriction with automatic IP fallback)
  const handleUseCurrentLocation = async () => {
    // 1. Immediately switch to Map View so user sees instant response
    setStep('step2_map');
    setIsDetectingGps(true);
    showToast('Locating your position...');

    try {
      const location = await getLiveUserLocation();
      
      // 2. Set coordinates immediately so map centers on exact location
      setSelectedCoords({ lat: location.lat, lng: location.lng });
      
      // 3. Fetch reverse geocoded address non-blocking in background
      updateAddressFromCoords(location.lat, location.lng).finally(() => {
        setIsDetectingGps(false);
      });

      if (location.isIpFallback) {
        showToast('Approximate current location detected');
      } else {
        showToast('Live location centered on map');
      }
    } catch (err) {
      console.error('Failed to get location:', err);
      setIsDetectingGps(false);
      showToast('Unable to detect live location. Please pinpoint on map.');
    }
  };

  // Directly confirm current location without forcing extra form steps
  const handleConfirmCurrentLocation = () => {
    const fullAddress = geocodedArea.fullFormatted || 'Current Location Pin';
    const mainArea = geocodedArea.mainArea || 'Current Location';

    const newAddressLoc: AddressLocation = {
      address: fullAddress,
      floorUnit: buildingHouse || 'Doorstep Location',
      landmark: landmark || 'Current Location Pin',
      siteContactName: receiverName || 'Rohan K',
      sitePhone: receiverPhone || '+91 9611193492',
      jobTag: 'Home',
      coordinates: selectedCoords,
    };

    // Save into saved addresses list if not present
    const newSaved: SavedAddress = {
      id: 'addr_current_' + Date.now(),
      tag: 'Home',
      address: fullAddress,
      floorUnit: buildingHouse || 'Doorstep Location',
      landmark: landmark || 'GPS Location',
      siteContactName: receiverName || 'Rohan K',
      sitePhone: receiverPhone || '+91 9611193492',
      isDefault: true,
      orderingFor: 'Myself',
      coordinates: selectedCoords,
      distanceSla: calculateDynamicDeliveryEta(selectedCoords).etaMins + ' minutes • Hyperlocal Express',
    };

    const updated = [newSaved, ...savedAddresses.filter(a => a.id !== newSaved.id)];
    persistAddresses(updated);

    onSaveLocation(newAddressLoc);
    showToast(`Delivering to ${mainArea}`);
    setTimeout(() => {
      onClose();
    }, 300);
  };

  // Select a saved address and apply it
  const handleSelectSavedAddress = (addr: SavedAddress) => {
    setActiveAddressId(addr.id);
    const newAddressLoc: AddressLocation = {
      address: addr.address,
      floorUnit: addr.floorUnit,
      landmark: addr.landmark,
      siteContactName: addr.siteContactName,
      sitePhone: addr.sitePhone,
      jobTag: addr.tag,
      coordinates: addr.coordinates,
    };
    onSaveLocation(newAddressLoc);
    showToast(`Delivering to ${addr.tag}`);
    setTimeout(() => {
      onClose();
    }, 400);
  };

  // Start adding new address -> go to map view
  const handleStartAddNew = () => {
    setEditingAddressId(null);
    setBuildingHouse('');
    setFloorUnit('');
    setLandmark('');
    setOrderingFor('Myself');
    setAddressTag('Home');
    setStep('step2_map');
  };

  // Edit existing address
  const handleEditAddress = (addr: SavedAddress, e: React.MouseEvent) => {
    e.stopPropagation();
    setActiveMenuAddressId(null);
    setEditingAddressId(addr.id);
    setSelectedCoords(addr.coordinates);
    setAddressTag(
      addr.tag === 'Home' || addr.tag === 'Work' || addr.tag === 'Hotel' ? addr.tag : 'Other'
    );
    setOrderingFor(addr.orderingFor || 'Myself');
    setBuildingHouse(addr.floorUnit || '');
    setFloorUnit(addr.floorUnit || '');
    setLandmark(addr.landmark || '');
    setReceiverName(addr.siteContactName || 'Rohan K');
    setReceiverPhone(addr.sitePhone || '+91 9611193492');
    updateAddressFromCoords(addr.coordinates.lat, addr.coordinates.lng);
    setStep('step3_details');
  };

  // Delete saved address
  const handleDeleteAddress = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setActiveMenuAddressId(null);
    const updated = savedAddresses.filter((a) => a.id !== id);
    persistAddresses(updated);
    showToast('Address deleted');
  };

  // Share address handler
  const handleShareAddress = (addr: SavedAddress, e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (navigator.share) {
      navigator.share({
        title: `Delivery Address - ${addr.tag}`,
        text: `${addr.tag}: ${addr.address} (Contact: ${addr.siteContactName}, ${addr.sitePhone})`,
      }).catch(() => {});
    } else {
      navigator.clipboard.writeText(`${addr.tag}: ${addr.address}`);
      showToast('Address copied to clipboard!');
    }
  };

  // Save complete address form (Step 3)
  const handleSaveCompleteAddress = (e: React.FormEvent) => {
    e.preventDefault();
    if (!buildingHouse.trim()) {
      showToast('Please enter Flat / House no / Building name');
      return;
    }

    const fullAddrString = `${buildingHouse.trim()}, ${floorUnit ? floorUnit.trim() + ', ' : ''}${geocodedArea.fullFormatted}`;

    if (editingAddressId) {
      // Update existing
      const updated = savedAddresses.map((a) => {
        if (a.id === editingAddressId) {
          return {
            ...a,
            tag: addressTag,
            address: fullAddrString,
            floorUnit: buildingHouse.trim(),
            landmark: landmark.trim(),
            siteContactName: receiverName.trim(),
            sitePhone: receiverPhone.trim(),
            orderingFor,
            coordinates: selectedCoords,
          };
        }
        return a;
      });
      persistAddresses(updated);
      const matched = updated.find((a) => a.id === editingAddressId);
      if (matched) handleSelectSavedAddress(matched);
    } else {
      // Create new
      const newSaved: SavedAddress = {
        id: 'addr_' + Date.now(),
        tag: addressTag,
        address: fullAddrString,
        floorUnit: buildingHouse.trim(),
        landmark: landmark.trim(),
        siteContactName: receiverName.trim(),
        sitePhone: receiverPhone.trim(),
        isDefault: false,
        orderingFor,
        coordinates: selectedCoords,
        distanceSla: calculateDynamicDeliveryEta({lat: 12.9081, lng: 77.5963}).etaMins + ' minutes • Hyperlocal Express',
      };
      const updated = [newSaved, ...savedAddresses];
      persistAddresses(updated);
      handleSelectSavedAddress(newSaved);
    }
  };

  // Filtered saved addresses
  const filteredAddresses = savedAddresses.filter((a) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      a.tag.toLowerCase().includes(q) ||
      a.address.toLowerCase().includes(q) ||
      a.siteContactName.toLowerCase().includes(q)
    );
  });

  const getTagBadgeIcon = (tag: string) => {
    switch (tag) {
      case 'Home':
        return <Home className="w-5 h-5 text-amber-600" />;
      case 'Work':
        return <Briefcase className="w-5 h-5 text-blue-600" />;
      case 'Hotel':
        return <Building className="w-5 h-5 text-indigo-600" />;
      default:
        return <MapPin className="w-5 h-5 text-emerald-600" />;
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex flex-col justify-end sm:justify-center items-center p-0 sm:p-4 overflow-hidden animate-in fade-in duration-200">
      
      {/* Toast popup */}
      {toastMessage && (
        <div className="fixed top-6 z-50 bg-slate-950 text-white px-4 py-2.5 rounded-full text-xs font-bold shadow-2xl flex items-center gap-2 border border-slate-800 animate-in slide-in-from-top-4 duration-200">
          <Sparkles className="w-3.5 h-3.5 text-amber-400" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* ============================================================= */}
      {/* STEP 1: SELECT DELIVERY LOCATION (Bottom Sheet / Modal)       */}
      {/* ============================================================= */}
      {step === 'step1_select' && (
        <div className="w-full sm:max-w-md md:max-w-lg bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl max-h-[92vh] flex flex-col overflow-hidden relative border border-slate-100">
          
          {/* Top Header */}
          <div className="pt-3.5 pb-2 px-5 flex items-center justify-between border-b border-slate-100/80">
            <h2 className="text-base font-black text-slate-900 tracking-tight flex items-center gap-2">
              <Globe className="w-4 h-4 text-emerald-600" />
              <span>Select delivery location</span>
            </h2>
            <button
              onClick={onClose}
              className="w-8 h-8 rounded-full bg-slate-950 text-white flex items-center justify-center hover:bg-slate-800 transition cursor-pointer shadow-sm"
              title="Close"
            >
              <X className="w-4 h-4 stroke-[2.5]" />
            </button>
          </div>

          <div className="p-4 sm:p-5 overflow-y-auto space-y-4">
            
            {/* Global Search Bar with Live Suggestions */}
            <div className="relative">
              <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  handlePerformSearch(e.target.value);
                }}
                placeholder="Search any city, locality, street globally..."
                className="w-full bg-slate-50 border border-slate-200/90 rounded-2xl pl-10 pr-10 py-2.5 text-xs sm:text-sm font-semibold text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition"
              />
              {isSearching && (
                <Loader2 className="w-4 h-4 text-slate-400 animate-spin absolute right-3.5 top-1/2 -translate-y-1/2" />
              )}
              {searchQuery && !isSearching && (
                <button
                  onClick={() => {
                    setSearchQuery('');
                    setSearchResults([]);
                  }}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                >
                  <X className="w-4 h-4" />
                </button>
              )}

              {/* Global Search Autocomplete Dropdown */}
              {searchResults.length > 0 && (
                <div className="absolute top-full left-0 right-0 mt-1.5 bg-white border border-slate-200 rounded-2xl shadow-xl z-40 overflow-hidden divide-y divide-slate-100 max-h-56 overflow-y-auto">
                  {searchResults.map((res, idx) => (
                    <button
                      key={idx}
                      onClick={() => handleSelectSearchResult(res)}
                      className="w-full text-left p-3 hover:bg-emerald-50/50 transition flex items-start gap-2.5"
                    >
                      <MapPin className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-bold text-slate-900 truncate">
                          {res.mainName}
                        </div>
                        <div className="text-[11px] text-slate-500 truncate">
                          {res.subName}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Quick Actions List */}
            <div className="bg-white rounded-2xl border border-slate-100 divide-y divide-slate-100 shadow-2xs overflow-hidden">
              
              {/* Action 1: Use Current Location (GPS) */}
              <div
                onClick={handleUseCurrentLocation}
                id="location-page-use-gps-btn"
                className="p-3.5 flex items-center justify-between hover:bg-emerald-50/60 bg-emerald-50/20 transition cursor-pointer group"
              >
                <div className="flex items-start gap-3 min-w-0 flex-1 pr-2">
                  <div className="w-10 h-10 rounded-full bg-emerald-100/80 border border-emerald-300 text-emerald-700 flex items-center justify-center shrink-0 group-hover:scale-105 transition shadow-2xs">
                    <LocateFixed className={`w-5 h-5 text-emerald-700 ${isDetectingGps ? 'animate-spin' : ''}`} />
                  </div>
                  <div className="min-w-0">
                    <div className="text-xs sm:text-sm font-black text-emerald-900 group-hover:text-emerald-800 flex items-center gap-1.5">
                      <span>Use Current GPS Location</span>
                      {isDetectingGps && (
                        <span className="text-[10px] bg-emerald-200 text-emerald-800 px-1.5 py-0.2 rounded-full font-bold animate-pulse">
                          Detecting...
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-emerald-700/80 font-medium truncate mt-0.5">
                      {isDetectingGps ? 'Pinpointing high-accuracy mobile GPS...' : 'Fetch live doorstep location from device GPS'}
                    </p>
                  </div>
                </div>
                <ChevronRight className="w-4 h-4 text-emerald-600 group-hover:translate-x-0.5 transition shrink-0" />
              </div>

              {/* Action 2: Add New Address */}
              <div
                onClick={handleStartAddNew}
                className="p-3.5 flex items-center justify-between hover:bg-emerald-50/40 transition cursor-pointer group"
              >
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full bg-emerald-50 border border-emerald-200/70 text-emerald-600 flex items-center justify-center shrink-0 group-hover:scale-105 transition">
                    <Plus className="w-5 h-5 text-emerald-600 stroke-[2.5]" />
                  </div>
                  <div className="text-xs sm:text-sm font-black text-emerald-800 group-hover:text-emerald-700">
                    Add new address
                  </div>
                </div>
                <ChevronRight className="w-4 h-4 text-slate-400 group-hover:translate-x-0.5 transition shrink-0" />
              </div>

              {/* Action 3: Request address from someone else */}
              <div
                onClick={() => {
                  if (navigator.clipboard) {
                    navigator.clipboard.writeText('https://rushq.app/request-address');
                    showToast('Address request link copied! Share via WhatsApp');
                  }
                }}
                className="p-3.5 flex items-center justify-between hover:bg-slate-50 transition cursor-pointer group"
              >
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full bg-emerald-500 text-white flex items-center justify-center shrink-0 shadow-2xs">
                    <MessageSquare className="w-4 h-4 fill-white text-emerald-500" />
                  </div>
                  <div className="text-xs sm:text-sm font-bold text-slate-800">
                    Request address from someone else
                  </div>
                </div>
                <ChevronRight className="w-4 h-4 text-slate-400 group-hover:translate-x-0.5 transition shrink-0" />
              </div>



            </div>

            {/* Saved Addresses Section */}
            <div className="space-y-3 pt-2">
              <div className="text-xs font-black uppercase tracking-wider text-slate-500 px-1">
                Your saved addresses
              </div>

              <div className="space-y-2.5">
                {filteredAddresses.map((addr) => {
                  const isCurrent = activeAddressId === addr.id;
                  return (
                    <div
                      key={addr.id}
                      onClick={() => handleSelectSavedAddress(addr)}
                      className={`p-4 rounded-2xl border transition-all cursor-pointer relative group ${
                        isCurrent
                          ? 'border-emerald-500 bg-white shadow-sm ring-1 ring-emerald-500/30'
                          : 'border-slate-200/90 bg-white hover:border-slate-300'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-start gap-3 min-w-0 flex-1">
                          <div className="p-2.5 rounded-xl bg-amber-50 border border-amber-100 shrink-0 mt-0.5">
                            {getTagBadgeIcon(addr.tag)}
                          </div>

                          <div className="space-y-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-black text-slate-900">
                                {addr.tag}
                              </span>
                              {isCurrent && (
                                <span className="text-[11px] font-bold text-emerald-700 flex items-center gap-1">
                                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                                  Active Location
                                </span>
                              )}
                            </div>

                            <p className="text-xs font-medium text-slate-600 leading-relaxed line-clamp-2">
                              {addr.address}
                            </p>

                            <p className="text-xs text-slate-500 font-semibold pt-0.5">
                              Phone: <span className="text-slate-800">{addr.sitePhone}</span>
                            </p>

                            {/* Share & Actions */}
                            <div className="flex items-center gap-3 pt-2">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setActiveMenuAddressId(activeMenuAddressId === addr.id ? null : addr.id);
                                }}
                                className="p-1 rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition"
                                title="More options"
                              >
                                <MoreVertical className="w-4 h-4" />
                              </button>

                              <button
                                onClick={(e) => handleShareAddress(addr, e)}
                                className="p-1 rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition"
                                title="Share address"
                              >
                                <Share2 className="w-4 h-4" />
                              </button>
                            </div>
                          </div>
                        </div>

                        {/* Selected Indicator */}
                        {isCurrent && (
                          <div className="w-5 h-5 rounded-full bg-emerald-600 text-white flex items-center justify-center shrink-0 mt-1">
                            <CheckCircle2 className="w-4 h-4" />
                          </div>
                        )}
                      </div>

                      {/* Dropdown Menu for Edit/Delete */}
                      {activeMenuAddressId === addr.id && (
                        <div 
                          onClick={(e) => e.stopPropagation()}
                          className="absolute right-4 bottom-3 bg-white border border-slate-200 rounded-xl shadow-lg p-1 z-20 flex items-center gap-1 animate-in fade-in zoom-in-95 duration-150"
                        >
                          <button
                            onClick={(e) => handleEditAddress(addr, e)}
                            className="px-2.5 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-100 rounded-lg flex items-center gap-1.5"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                            Edit
                          </button>
                          <button
                            onClick={(e) => handleDeleteAddress(addr.id, e)}
                            className="px-2.5 py-1.5 text-xs font-bold text-rose-600 hover:bg-rose-50 rounded-lg flex items-center gap-1.5"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                            Delete
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Bottom Promo / Tip Share Banner */}
            {showShareBanner && (
              <div className="bg-amber-50/80 border border-amber-200/80 rounded-2xl p-3 flex items-center justify-between gap-2 shadow-2xs">
                <div className="flex items-center gap-2.5 text-xs font-bold text-amber-950">
                  <div className="w-7 h-7 rounded-lg bg-amber-200/80 flex items-center justify-center shrink-0">
                    <Share2 className="w-4 h-4 text-amber-800" />
                  </div>
                  <span>Now share your addresses with friends and family</span>
                </div>
                <button
                  onClick={() => setShowShareBanner(false)}
                  className="p-1 text-amber-800 hover:text-amber-950 rounded-md"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

          </div>

        </div>
      )}

      {/* ============================================================= */}
      {/* STEP 2: MAP PIN SELECTION (Interactive Global Map)            */}
      {/* ============================================================= */}
      {step === 'step2_map' && (
        <div className="w-full h-full sm:max-w-xl sm:h-[90vh] bg-white sm:rounded-3xl shadow-2xl flex flex-col overflow-hidden relative">
          
          {/* Top Bar: Back & Add Address Heading */}
          <div className="bg-white px-4 py-3 border-b border-slate-100 flex items-center gap-3 z-30 shadow-2xs">
            <button
              onClick={() => setStep('step1_select')}
              className="p-1.5 -ml-1.5 rounded-full hover:bg-slate-100 text-slate-800 transition cursor-pointer"
            >
              <ArrowLeft className="w-5 h-5 stroke-[2.5]" />
            </button>
            <h2 className="text-base font-black text-slate-900 tracking-tight">
              Add address
            </h2>
          </div>

          {/* Floating Global Search Bar on Map */}
          <div className="absolute top-14 inset-x-4 z-30 pointer-events-auto">
            <div className="bg-white rounded-2xl shadow-lg border border-slate-200/90 px-3.5 py-2.5 flex items-center gap-2.5">
              <Search className="w-4 h-4 text-slate-400 shrink-0" />
              <input
                type="text"
                value={mapSearchQuery}
                onChange={(e) => {
                  setMapSearchQuery(e.target.value);
                  handlePerformSearch(e.target.value);
                }}
                placeholder="Search any locality, city or landmark globally..."
                className="w-full bg-transparent text-xs sm:text-sm font-semibold text-slate-900 placeholder-slate-400 focus:outline-none"
              />
              {isSearching && (
                <Loader2 className="w-4 h-4 text-slate-400 animate-spin shrink-0" />
              )}
              {mapSearchQuery && !isSearching && (
                <button
                  onClick={() => {
                    setMapSearchQuery('');
                    setSearchResults([]);
                  }}
                >
                  <X className="w-4 h-4 text-slate-400" />
                </button>
              )}
            </div>

            {/* Global Search Suggestions Dropdown on Map */}
            {searchResults.length > 0 && (
              <div className="mt-1.5 bg-white border border-slate-200 rounded-2xl shadow-2xl overflow-hidden divide-y divide-slate-100 max-h-56 overflow-y-auto">
                {searchResults.map((res, idx) => (
                  <button
                    key={idx}
                    onClick={() => handleSelectSearchResult(res)}
                    className="w-full text-left p-3 hover:bg-emerald-50/50 transition flex items-start gap-2.5"
                  >
                    <MapPin className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-bold text-slate-900 truncate">
                        {res.mainName}
                      </div>
                      <div className="text-[11px] text-slate-500 truncate">
                        {res.subName}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Interactive OpenStreetMap Container */}
          <div className="flex-1 relative w-full overflow-hidden">
            {/* Top Drag & Drop Guidance Badge */}
            <div className="absolute top-[72px] inset-x-0 z-20 flex justify-center pointer-events-none px-4">
              <div className="bg-slate-950/85 backdrop-blur-md text-white text-[11px] font-bold px-3.5 py-1.5 rounded-full shadow-lg border border-slate-700/60 flex items-center gap-1.5 animate-in fade-in slide-in-from-top-2 duration-200">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0"></span>
                <span>Drag pin or tap map to drop at your exact doorstep</span>
              </div>
            </div>

            <OpenStreetMap
              center={[selectedCoords.lat, selectedCoords.lng]}
              zoom={16}
              interactive={true}
              onLocationSelect={(lat, lng) => updateAddressFromCoords(lat, lng)}
              showHubCoverage={false}
              className="h-full w-full"
            />

            {/* Floating 'Use current location' Button over Map (Stacked directly above zoom controls) */}
            <div className="absolute bottom-[98px] right-[12px] z-30 pointer-events-auto">
              <button
                onClick={handleUseCurrentLocation}
                id="location-map-gps-btn"
                className="w-[42px] h-[42px] bg-white rounded-xl shadow-lg border border-slate-200 flex items-center justify-center text-slate-800 hover:text-emerald-600 transition cursor-pointer hover:scale-105 active:scale-95"
                title="Use current location"
              >
                <LocateFixed className={`w-5 h-5 ${isDetectingGps ? 'animate-spin text-emerald-600' : 'text-slate-800'}`} />
              </button>
            </div>
          </div>

          {/* Bottom Delivery Summary Sheet */}
          <div className="bg-white border-t border-slate-100 p-4 sm:p-5 space-y-3 z-30 shadow-2xl">
            <div className="text-xs font-black text-slate-800 uppercase tracking-wider">
              Delivering your order to
            </div>

            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-2.5 min-w-0 flex-1">
                <div className="p-1.5 rounded-full bg-slate-950 text-white shrink-0 mt-0.5">
                  <MapPin className="w-4 h-4" />
                </div>
                <div className="min-w-0">
                  <div className="text-sm sm:text-base font-black text-slate-950 truncate">
                    {geocodedArea.mainArea}
                  </div>
                  <div className="text-xs text-slate-500 font-semibold truncate">
                    {geocodedArea.subArea}
                  </div>
                </div>
              </div>

              <button
                onClick={() => setStep('step1_select')}
                className="text-xs font-bold text-emerald-700 hover:text-emerald-800 px-2 py-1 rounded-md transition"
              >
                Change
              </button>
            </div>

            {/* Primary Action Button */}
            <div className="pt-1">
              <button
                onClick={() => setStep('step3_details')}
                className="w-full bg-[#16a34a] hover:bg-[#15803d] text-white font-black text-sm py-3.5 rounded-2xl shadow-md transition flex items-center justify-center gap-2 cursor-pointer active:scale-[0.99]"
              >
                <span>Confirm Location & Proceed</span>
                <ChevronRight className="w-4 h-4 stroke-[3]" />
              </button>
            </div>
          </div>

        </div>
      )}

      {/* ============================================================= */}
      {/* STEP 3: ENTER COMPLETE ADDRESS FORM                           */}
      {/* ============================================================= */}
      {step === 'step3_details' && (
        <div className="w-full sm:max-w-md md:max-w-lg bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl max-h-[92vh] flex flex-col overflow-hidden relative border border-slate-100">
          
          {/* Header */}
          <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <button
                onClick={() => setStep('step2_map')}
                className="p-1 -ml-1 rounded-full hover:bg-slate-100 text-slate-700 transition"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
              <h2 className="text-base font-black text-slate-900 tracking-tight">
                Enter complete address
              </h2>
            </div>
            <button
              onClick={onClose}
              className="p-1 rounded-full text-slate-400 hover:text-slate-800 hover:bg-slate-100 transition"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Form Content */}
          <form onSubmit={handleSaveCompleteAddress} className="p-5 overflow-y-auto space-y-4">
            
            {/* Who you are ordering for? */}
            <div className="space-y-2">
              <div className="text-xs font-black text-slate-900">
                Who you are ordering for?
              </div>
              <div className="flex items-center gap-6">
                <label className="flex items-center gap-2 text-xs font-bold text-slate-800 cursor-pointer">
                  <input
                    type="radio"
                    name="orderingFor"
                    checked={orderingFor === 'Myself'}
                    onChange={() => {
                      setOrderingFor('Myself');
                      setReceiverName('Rohan K');
                      setReceiverPhone('+91 9611193492');
                    }}
                    className="w-4 h-4 text-emerald-600 accent-emerald-600 cursor-pointer"
                  />
                  <span>Myself</span>
                </label>

                <label className="flex items-center gap-2 text-xs font-bold text-slate-800 cursor-pointer">
                  <input
                    type="radio"
                    name="orderingFor"
                    checked={orderingFor === 'Someone else'}
                    onChange={() => {
                      setOrderingFor('Someone else');
                      setReceiverName('');
                      setReceiverPhone('');
                    }}
                    className="w-4 h-4 text-emerald-600 accent-emerald-600 cursor-pointer"
                  />
                  <span>Someone else</span>
                </label>
              </div>
            </div>

            {/* Save address as * (Chips) */}
            <div className="space-y-2 pt-1">
              <div className="text-xs font-bold text-slate-700">
                Save address as *
              </div>
              <div className="grid grid-cols-4 gap-2">
                {[
                  { tag: 'Home' as const, label: 'Home', icon: Home },
                  { tag: 'Work' as const, label: 'Work', icon: Briefcase },
                  { tag: 'Hotel' as const, label: 'Hotel', icon: Building },
                  { tag: 'Other' as const, label: 'Other', icon: MapPin },
                ].map(({ tag, label, icon: Icon }) => {
                  const isSelected = addressTag === tag;
                  return (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => setAddressTag(tag)}
                      className={`py-2 px-2 rounded-xl text-xs font-bold border transition flex items-center justify-center gap-1.5 cursor-pointer ${
                        isSelected
                          ? 'border-emerald-600 text-emerald-800 bg-emerald-50/70 shadow-2xs'
                          : 'border-slate-200 text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      <Icon className={`w-3.5 h-3.5 ${isSelected ? 'text-emerald-700' : 'text-slate-500'}`} />
                      <span>{label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Address Input Fields */}
            <div className="space-y-3 pt-2">
              
              {/* Field 1: Flat / House no / Building name * */}
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Flat / House no / Building name *
                </label>
                <input
                  type="text"
                  required
                  value={buildingHouse}
                  onChange={(e) => setBuildingHouse(e.target.value)}
                  placeholder="e.g. Apartment / House 42, Green Valley"
                  className="w-full bg-white border border-slate-300 rounded-xl p-3 text-xs sm:text-sm font-semibold text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-600 transition"
                />
              </div>

              {/* Field 2: Floor (optional) */}
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Floor (optional)
                </label>
                <input
                  type="text"
                  value={floorUnit}
                  onChange={(e) => setFloorUnit(e.target.value)}
                  placeholder="e.g. 3rd Floor"
                  className="w-full bg-white border border-slate-300 rounded-xl p-3 text-xs sm:text-sm font-semibold text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-600 transition"
                />
              </div>

              {/* Field 3: Area / Sector / Locality * */}
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Area / Locality / City *
                </label>
                <div className="flex items-center justify-between bg-slate-50 border border-slate-200 rounded-xl p-3">
                  <span className="text-xs sm:text-sm font-bold text-slate-800 truncate pr-2">
                    {geocodedArea.mainArea}, {geocodedArea.subArea}
                  </span>
                  <button
                    type="button"
                    onClick={() => setStep('step2_map')}
                    className="text-xs font-bold text-emerald-700 hover:text-emerald-800 shrink-0"
                  >
                    Change
                  </button>
                </div>
              </div>

              {/* Field 4: Nearby landmark (optional) */}
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Nearby landmark (optional)
                </label>
                <input
                  type="text"
                  value={landmark}
                  onChange={(e) => setLandmark(e.target.value)}
                  placeholder="e.g. Near Central Park / Metro Entrance"
                  className="w-full bg-white border border-slate-300 rounded-xl p-3 text-xs sm:text-sm font-semibold text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-600 transition"
                />
              </div>
            </div>

            {/* Receiver Contact Details */}
            <div className="pt-2 border-t border-slate-100 space-y-3">
              <div className="text-xs text-slate-500 font-medium">
                Enter your details for seamless delivery experience
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Your name *
                </label>
                <div className="relative">
                  <input
                    type="text"
                    required
                    value={receiverName}
                    onChange={(e) => setReceiverName(e.target.value)}
                    placeholder="Enter full name"
                    className="w-full bg-white border border-slate-300 rounded-xl p-3 pr-9 text-xs sm:text-sm font-semibold text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-600 transition"
                  />
                  {receiverName && (
                    <button
                      type="button"
                      onClick={() => setReceiverName('')}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Your phone number (optional)
                </label>
                <div className="relative">
                  <input
                    type="tel"
                    value={receiverPhone}
                    onChange={(e) => setReceiverPhone(e.target.value)}
                    placeholder="+1 555-0199 or +91 9876543210"
                    className="w-full bg-white border border-slate-300 rounded-xl p-3 pr-9 text-xs sm:text-sm font-semibold text-slate-900 font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-600 transition"
                  />
                  {receiverPhone && (
                    <button
                      type="button"
                      onClick={() => setReceiverPhone('')}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Sticky Save Address Button */}
            <div className="pt-3">
              <button
                type="submit"
                className="w-full bg-[#16a34a] hover:bg-[#15803d] text-white font-black text-sm py-3.5 rounded-2xl shadow-md transition cursor-pointer active:scale-[0.99]"
              >
                Save address
              </button>
            </div>

          </form>

        </div>
      )}

    </div>
  );
};
