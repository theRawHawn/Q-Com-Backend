import React, { useState } from 'react';
import {
  X,
  Bike,
  User,
  ShieldCheck,
  Building,
  CreditCard,
  Truck,
  AlertCircle,
  Save,
  Check,
  Battery,
  MapPin,
  Clock,
  Phone,
  Mail,
  HeartPulse
} from 'lucide-react';
import { AdminRider } from '../../types/admin';
import { adminApi } from '../../utils/adminApiClient';

interface RiderEditModalProps {
  rider: AdminRider | null; // null for creating a new rider
  onClose: () => void;
  onSuccess: (updatedRider: AdminRider) => void;
  selectedCity?: string;
}

export const RiderEditModal: React.FC<RiderEditModalProps> = ({
  rider,
  onClose,
  onSuccess,
  selectedCity = 'bengaluru',
}) => {
  const isEditing = Boolean(rider);

  const [activeTab, setActiveTab] = useState<'profile' | 'vehicle' | 'zone' | 'documents' | 'bank'>('profile');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Form State
  const [formData, setFormData] = useState({
    name: rider?.name || '',
    phone: rider?.phone || '',
    email: rider?.email || '',
    avatar: rider?.avatar || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=120&auto=format&fit=crop&q=80',
    bloodGroup: rider?.bloodGroup || 'O+',
    emergencyContact: {
      name: rider?.emergencyContact?.name || '',
      relationship: rider?.emergencyContact?.relationship || 'Family',
      phone: rider?.emergencyContact?.phone || '',
    },
    // Vehicle
    vehicleType: rider?.vehicleType || 'EV_SCOOTER',
    vehicleMakeModel: rider?.vehicleMakeModel || (rider?.vehicleType === 'E_LOADER' ? 'Mahindra Treo Zor' : 'Ather 450X Gen 3'),
    vehicleNumber: rider?.vehicleNumber || '',
    maxPayloadKg: rider?.maxPayloadKg || (rider?.vehicleType === 'E_LOADER' ? 350 : 60),
    batteryPercent: rider?.batteryPercent ?? 90,
    fuelType: rider?.fuelType || 'ELECTRIC',
    hasInsulatedThermalBag: rider?.hasInsulatedThermalBag ?? true,
    hasHelmetAndSafetyGear: rider?.hasHelmetAndSafetyGear ?? true,
    // Zone & Shift
    cityId: rider?.cityId || (selectedCity !== 'all' ? selectedCity : 'bengaluru'),
    cityName: rider?.cityName || (selectedCity !== 'all' ? selectedCity.charAt(0).toUpperCase() + selectedCity.slice(1) : 'Bengaluru'),
    assignedZoneName: rider?.assignedZoneName || 'Koramangala 4th-6th Block',
    assignedZoneId: rider?.assignedZoneId || 'zone-blr-01',
    dutyType: rider?.dutyType || 'FULL_TIME',
    shiftHours: rider?.shiftHours || '07:00 AM - 04:00 PM',
    status: rider?.status || 'ONLINE',
    rating: rider?.rating ?? 4.9,
    // Documents
    documents: {
      drivingLicenseNumber: rider?.documents?.drivingLicenseNumber || '',
      drivingLicenseVerified: rider?.documents?.drivingLicenseVerified ?? true,
      drivingLicenseExpiry: rider?.documents?.drivingLicenseExpiry || '2035-12-31',
      rcNumber: rider?.documents?.rcNumber || '',
      rcVerified: rider?.documents?.rcVerified ?? true,
      aadharNumber: rider?.documents?.aadharNumber || '',
      aadharVerified: rider?.documents?.aadharVerified ?? true,
      panNumber: rider?.documents?.panNumber || '',
      panVerified: rider?.documents?.panVerified ?? true,
      insurancePolicyNumber: rider?.documents?.insurancePolicyNumber || '',
      insuranceVerified: rider?.documents?.insuranceVerified ?? true,
      backgroundCheckPassed: rider?.documents?.backgroundCheckPassed ?? true,
      policeVerificationDocVerified: rider?.documents?.policeVerificationDocVerified ?? true,
    },
    // Bank Details
    bankDetails: {
      accountHolderName: rider?.bankDetails?.accountHolderName || rider?.name || '',
      accountNumber: rider?.bankDetails?.accountNumber || '',
      ifscCode: rider?.bankDetails?.ifscCode || '',
      bankName: rider?.bankDetails?.bankName || '',
      upiId: rider?.bankDetails?.upiId || '',
      payoutFrequency: rider?.bankDetails?.payoutFrequency || 'DAILY',
    },
  });

  const cityDeliveryZoneMap: Record<string, string[]> = {
    bengaluru: [
      'Koramangala 4th-6th Block',
      'HSR Layout Sectors 1-4',
      'Indiranagar 100ft Road',
      'Whitefield & ITPL Circle',
      'Jayanagar & JP Nagar',
    ],
    mumbai: [
      'Andheri East & MIDC',
      'BKC & Kurla',
      'Lower Parel & Dadar',
      'Thane West',
      'Vashi & Sanpada',
    ],
    delhi: [
      'DLF Phase 2 & Cyber City',
      'Okhla Phase 2 & 3',
      'Noida Sector 18 & 62',
      'Karol Bagh & CP',
      'South Extension & Lajpat Nagar',
    ],
    hyderabad: [
      'Madhapur & HITEC City',
      'Gachibowli & Financial District',
      'Kukatpally & KPHB',
      'Secunderabad',
    ],
    chennai: [
      'Guindy & Ekkatuthangal',
      'OMR & Thoraipakkam',
      'Anna Nagar',
      'T. Nagar & Pondy Bazaar',
    ],
    pune: [
      'Hinjewadi Phase 1 & 2',
      'Viman Nagar & Kalyani Nagar',
      'Hadapsar & Magarpatta',
      'Kothrud & Karve Road',
    ],
  };

  const handleCityChange = (newCityId: string) => {
    const zones = cityDeliveryZoneMap[newCityId] || ['Local Area Zone (3km)'];
    setFormData((prev) => ({
      ...prev,
      cityId: newCityId,
      cityName: newCityId.charAt(0).toUpperCase() + newCityId.slice(1),
      assignedZoneName: zones[0],
    }));
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    if (!formData.name.trim()) {
      setErrorMessage('Full Name is required');
      return;
    }
    if (!formData.phone.trim()) {
      setErrorMessage('Phone number is required');
      return;
    }
    if (!formData.vehicleNumber.trim()) {
      setErrorMessage('Vehicle registration number is required');
      return;
    }

    try {
      setIsSubmitting(true);
      let res: any;

      if (isEditing && rider) {
        res = await adminApi.put(`/api/admin/riders/${rider.id}`, formData);
      } else {
        res = await adminApi.post('/api/admin/riders', formData);
      }

      if (res && res.success) {
        onSuccess(res.rider);
        onClose();
      } else {
        setErrorMessage(res?.error || 'Failed to save rider profile');
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Error communicating with server');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-4xl shadow-xl flex flex-col max-h-[92vh] overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50/80">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-emerald-50 rounded-xl border border-emerald-200 text-emerald-700">
              <Bike className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900">
                {isEditing ? `Edit Fleet Profile: ${rider?.name}` : 'Onboard New Delivery Partner'}
              </h2>
              <p className="text-xs text-slate-500">
                {isEditing ? `ID: ${rider?.id} • Registration: ${formData.vehicleNumber || 'Pending'}` : 'Register a delivery executive, fleet asset & KYC verification'}
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-200/60 rounded-lg transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="flex border-b border-slate-200 bg-white px-6 gap-2 text-xs font-semibold overflow-x-auto">
          {[
            { id: 'profile', label: '1. Personal & Contact', icon: User },
            { id: 'vehicle', label: '2. Vehicle & Fleet Specs', icon: Truck },
            { id: 'zone', label: '3. Hub, City & Shifts', icon: MapPin },
            { id: 'documents', label: '4. Documents & KYC', icon: ShieldCheck },
            { id: 'bank', label: '5. Payout Bank Details', icon: CreditCard },
          ].map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id as any)}
                className={`py-3 px-3.5 border-b-2 flex items-center gap-2 whitespace-nowrap transition-all ${
                  isActive
                    ? 'border-emerald-600 text-emerald-700 font-bold'
                    : 'border-transparent text-slate-500 hover:text-slate-800'
                }`}
              >
                <Icon className={`h-4 w-4 ${isActive ? 'text-emerald-600' : 'text-slate-400'}`} />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>

        {/* Error notification */}
        {errorMessage && (
          <div className="mx-6 mt-4 p-3 bg-rose-50 border border-rose-200 rounded-xl text-rose-700 text-xs flex items-center gap-2">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{errorMessage}</span>
          </div>
        )}

        {/* Form Body */}
        <form onSubmit={handleSave} className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* TAB 1: Personal & Contact */}
          {activeTab === 'profile' && (
            <div className="space-y-4">
              <div className="flex items-center gap-4 p-4 bg-slate-50 rounded-xl border border-slate-200">
                <img
                  src={formData.avatar}
                  alt={formData.name || 'Rider avatar'}
                  className="h-16 w-16 rounded-2xl object-cover border border-slate-200 shadow-xs"
                />
                <div className="flex-1">
                  <label className="text-xs font-semibold text-slate-700 block mb-1">Avatar Photo URL</label>
                  <input
                    type="text"
                    value={formData.avatar}
                    onChange={(e) => setFormData({ ...formData, avatar: e.target.value })}
                    placeholder="https://images.unsplash.com/..."
                    className="w-full bg-white border border-slate-300 rounded-lg px-3 py-1.5 text-xs text-slate-800 focus:ring-1 focus:ring-emerald-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-semibold text-slate-700 block mb-1">
                    Full Name <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    placeholder="e.g. Manjunath Gowda"
                    className="w-full bg-slate-50/50 border border-slate-300 rounded-lg px-3 py-2 text-xs text-slate-900 focus:bg-white focus:ring-1 focus:ring-emerald-500 font-medium"
                  />
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-700 block mb-1">
                    Phone Number <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="tel"
                    required
                    value={formData.phone}
                    onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                    placeholder="+91 98450 11223"
                    className="w-full bg-slate-50/50 border border-slate-300 rounded-lg px-3 py-2 text-xs text-slate-900 focus:bg-white focus:ring-1 focus:ring-emerald-500"
                  />
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-700 block mb-1">Official Fleet Email</label>
                  <input
                    type="email"
                    value={formData.email}
                    onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                    placeholder="rider.name@qcomfleet.in"
                    className="w-full bg-slate-50/50 border border-slate-300 rounded-lg px-3 py-2 text-xs text-slate-900 focus:bg-white focus:ring-1 focus:ring-emerald-500"
                  />
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-700 block mb-1">Blood Group</label>
                  <select
                    value={formData.bloodGroup}
                    onChange={(e) => setFormData({ ...formData, bloodGroup: e.target.value })}
                    className="w-full bg-slate-50/50 border border-slate-300 rounded-lg px-3 py-2 text-xs text-slate-900 focus:bg-white focus:ring-1 focus:ring-emerald-500"
                  >
                    {['O+', 'O-', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-'].map((bg) => (
                      <option key={bg} value={bg}>{bg}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Emergency Contact */}
              <div className="mt-4 p-4 bg-amber-50/50 border border-amber-200 rounded-xl space-y-3">
                <div className="flex items-center gap-2 text-xs font-bold text-amber-900">
                  <HeartPulse className="h-4 w-4 text-amber-600" />
                  <span>Emergency SOS Contact (Mandatory for Fleet Safety)</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                  <div>
                    <label className="text-[11px] font-medium text-slate-600 block mb-1">Contact Name</label>
                    <input
                      type="text"
                      value={formData.emergencyContact.name}
                      onChange={(e) => setFormData({
                        ...formData,
                        emergencyContact: { ...formData.emergencyContact, name: e.target.value }
                      })}
                      placeholder="e.g. Sunitha Gowda"
                      className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs text-slate-900"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] font-medium text-slate-600 block mb-1">Relationship</label>
                    <input
                      type="text"
                      value={formData.emergencyContact.relationship}
                      onChange={(e) => setFormData({
                        ...formData,
                        emergencyContact: { ...formData.emergencyContact, relationship: e.target.value }
                      })}
                      placeholder="Spouse / Parent / Brother"
                      className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs text-slate-900"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] font-medium text-slate-600 block mb-1">Emergency Phone</label>
                    <input
                      type="tel"
                      value={formData.emergencyContact.phone}
                      onChange={(e) => setFormData({
                        ...formData,
                        emergencyContact: { ...formData.emergencyContact, phone: e.target.value }
                      })}
                      placeholder="+91 98450 99881"
                      className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs text-slate-900"
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: Vehicle & Fleet Specs */}
          {activeTab === 'vehicle' && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-semibold text-slate-700 block mb-1">Vehicle Classification</label>
                  <select
                    value={formData.vehicleType}
                    onChange={(e) => {
                      const vType = e.target.value as any;
                      setFormData({
                        ...formData,
                        vehicleType: vType,
                        maxPayloadKg: vType === 'E_LOADER' ? 350 : vType === 'MINI_TRUCK' ? 750 : 60,
                      });
                    }}
                    className="w-full bg-slate-50/50 border border-slate-300 rounded-lg px-3 py-2 text-xs text-slate-900 focus:bg-white focus:ring-1 focus:ring-emerald-500 font-semibold"
                  >
                    <option value="EV_SCOOTER">EV Commercial 2-Wheeler (Fast Dispatch)</option>
                    <option value="E_LOADER">E-Loader 3-Wheeler Cargo (Heavy Bulky)</option>
                    <option value="BIKE">ICE Petrol Bike (Long Range)</option>
                    <option value="MINI_TRUCK">Electric Mini-Truck (Wholesale/Depot)</option>
                    <option value="ELECTRIC_VAN">Electric Covered Van (High Capacity)</option>
                  </select>
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-700 block mb-1">
                    Registration Plate Number <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={formData.vehicleNumber}
                    onChange={(e) => setFormData({ ...formData, vehicleNumber: e.target.value.toUpperCase() })}
                    placeholder="e.g. KA-05-EV-1029"
                    className="w-full bg-slate-50/50 border border-slate-300 rounded-lg px-3 py-2 text-xs text-slate-900 font-bold uppercase focus:bg-white focus:ring-1 focus:ring-emerald-500"
                  />
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-700 block mb-1">Make & Model</label>
                  <input
                    type="text"
                    value={formData.vehicleMakeModel}
                    onChange={(e) => setFormData({ ...formData, vehicleMakeModel: e.target.value })}
                    placeholder="e.g. Ather 450X Gen 3 / Mahindra Treo Zor"
                    className="w-full bg-slate-50/50 border border-slate-300 rounded-lg px-3 py-2 text-xs text-slate-900 focus:bg-white focus:ring-1 focus:ring-emerald-500"
                  />
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-700 block mb-1">Powertrain / Fuel</label>
                  <select
                    value={formData.fuelType}
                    onChange={(e) => setFormData({ ...formData, fuelType: e.target.value as any })}
                    className="w-full bg-slate-50/50 border border-slate-300 rounded-lg px-3 py-2 text-xs text-slate-900 focus:bg-white focus:ring-1 focus:ring-emerald-500"
                  >
                    <option value="ELECTRIC">100% Zero-Emission Electric (EV)</option>
                    <option value="PETROL">Petrol / Combustion Engine</option>
                    <option value="CNG">Compressed Natural Gas (CNG)</option>
                  </select>
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-700 block mb-1">Max Payload Capacity (Kg)</label>
                  <input
                    type="number"
                    value={formData.maxPayloadKg}
                    onChange={(e) => setFormData({ ...formData, maxPayloadKg: Number(e.target.value) })}
                    placeholder="65"
                    className="w-full bg-slate-50/50 border border-slate-300 rounded-lg px-3 py-2 text-xs text-slate-900 focus:bg-white focus:ring-1 focus:ring-emerald-500"
                  />
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-700 block mb-1">Current EV Battery Level (%)</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={formData.batteryPercent}
                      onChange={(e) => setFormData({ ...formData, batteryPercent: Number(e.target.value) })}
                      className="flex-1 accent-emerald-600"
                    />
                    <span className="text-xs font-bold text-emerald-700 bg-emerald-50 px-2.5 py-1 rounded border border-emerald-200">
                      {formData.batteryPercent}%
                    </span>
                  </div>
                </div>
              </div>

              {/* Equipment Checklist */}
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 space-y-2">
                <span className="text-xs font-bold text-slate-900 block mb-2">Safety Gear & Equipment Compliance</span>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <label className="flex items-center gap-2.5 text-xs text-slate-700 cursor-pointer bg-white p-2.5 rounded-lg border border-slate-200">
                    <input
                      type="checkbox"
                      checked={formData.hasInsulatedThermalBag}
                      onChange={(e) => setFormData({ ...formData, hasInsulatedThermalBag: e.target.checked })}
                      className="h-4 w-4 rounded text-emerald-600 focus:ring-emerald-500 border-slate-300"
                    />
                    <span>High-Capacity Delivery Bag Issued</span>
                  </label>

                  <label className="flex items-center gap-2.5 text-xs text-slate-700 cursor-pointer bg-white p-2.5 rounded-lg border border-slate-200">
                    <input
                      type="checkbox"
                      checked={formData.hasHelmetAndSafetyGear}
                      onChange={(e) => setFormData({ ...formData, hasHelmetAndSafetyGear: e.target.checked })}
                      className="h-4 w-4 rounded text-emerald-600 focus:ring-emerald-500 border-slate-300"
                    />
                    <span>DOT/ISI Safety Helmet & Hi-Vis Vest Issued</span>
                  </label>
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: Zone, City & Shifts */}
          {activeTab === 'zone' && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-semibold text-slate-700 block mb-1">Operating City</label>
                  <select
                    value={formData.cityId}
                    onChange={(e) => handleCityChange(e.target.value)}
                    className="w-full bg-slate-50/50 border border-slate-300 rounded-lg px-3 py-2 text-xs text-slate-900 focus:bg-white focus:ring-1 focus:ring-emerald-500 font-semibold"
                  >
                    <option value="bengaluru">Bengaluru</option>
                    <option value="mumbai">Mumbai MMR</option>
                    <option value="delhi">Delhi NCR</option>
                    <option value="hyderabad">Hyderabad</option>
                    <option value="chennai">Chennai</option>
                    <option value="pune">Pune</option>
                  </select>
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-700 block mb-1">Assigned Locality / Delivery Area (3-4 km Radius)</label>
                  <select
                    value={formData.assignedZoneName}
                    onChange={(e) => setFormData({ ...formData, assignedZoneName: e.target.value })}
                    className="w-full bg-slate-50/50 border border-slate-300 rounded-lg px-3 py-2 text-xs text-slate-900 focus:bg-white focus:ring-1 focus:ring-emerald-500 font-medium"
                  >
                    {(cityDeliveryZoneMap[formData.cityId] || [formData.assignedZoneName]).map((zone) => (
                      <option key={zone} value={zone}>{zone}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-700 block mb-1">Contract / Duty Type</label>
                  <select
                    value={formData.dutyType}
                    onChange={(e) => setFormData({ ...formData, dutyType: e.target.value as any })}
                    className="w-full bg-slate-50/50 border border-slate-300 rounded-lg px-3 py-2 text-xs text-slate-900 focus:bg-white focus:ring-1 focus:ring-emerald-500"
                  >
                    <option value="FULL_TIME">Full-Time (8 Hours Shift)</option>
                    <option value="PART_TIME">Part-Time (4 Hours Shift)</option>
                    <option value="WEEKEND_PEAK">Weekend Peak Demand Specialist</option>
                    <option value="NIGHT_SHIFT">Night Rapid Response Fleet</option>
                  </select>
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-700 block mb-1">Active Shift Hours</label>
                  <input
                    type="text"
                    value={formData.shiftHours}
                    onChange={(e) => setFormData({ ...formData, shiftHours: e.target.value })}
                    placeholder="07:00 AM - 04:00 PM"
                    className="w-full bg-slate-50/50 border border-slate-300 rounded-lg px-3 py-2 text-xs text-slate-900 focus:bg-white focus:ring-1 focus:ring-emerald-500"
                  />
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-700 block mb-1">App Telemetry Status</label>
                  <select
                    value={formData.status}
                    onChange={(e) => setFormData({ ...formData, status: e.target.value as any })}
                    className="w-full bg-slate-50/50 border border-slate-300 rounded-lg px-3 py-2 text-xs text-slate-900 focus:bg-white focus:ring-1 focus:ring-emerald-500 font-semibold"
                  >
                    <option value="ONLINE">ONLINE (Available for Dispatch)</option>
                    <option value="ON_DELIVERY">ON DELIVERY (Active on Trip)</option>
                    <option value="OFFLINE">OFFLINE (Off-Duty)</option>
                    <option value="PENDING_APPROVAL">PENDING APPROVAL (Documents under review)</option>
                    <option value="SUSPENDED">SUSPENDED (Access locked)</option>
                  </select>
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-700 block mb-1">Partner Rating Score</label>
                  <input
                    type="number"
                    step="0.1"
                    min="1.0"
                    max="5.0"
                    value={formData.rating}
                    onChange={(e) => setFormData({ ...formData, rating: Number(e.target.value) })}
                    className="w-full bg-slate-50/50 border border-slate-300 rounded-lg px-3 py-2 text-xs text-slate-900 focus:bg-white focus:ring-1 focus:ring-emerald-500"
                  />
                </div>
              </div>
            </div>
          )}

          {/* TAB 4: Documents & KYC */}
          {activeTab === 'documents' && (
            <div className="space-y-4">
              <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-800 flex items-center justify-between">
                <span>All documents are verified against government transport and identity registries.</span>
                <button
                  type="button"
                  onClick={() => {
                    setFormData({
                      ...formData,
                      documents: {
                        ...formData.documents,
                        drivingLicenseVerified: true,
                        rcVerified: true,
                        aadharVerified: true,
                        panVerified: true,
                        insuranceVerified: true,
                        backgroundCheckPassed: true,
                        policeVerificationDocVerified: true,
                      }
                    });
                  }}
                  className="bg-[#009DE0] text-white font-bold px-3 py-1 rounded-lg text-xs hover:bg-[#0087c2]"
                >
                  Verify All Documents
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* Driving License */}
                <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-900">1. Driving License</span>
                    <label className="flex items-center gap-1.5 text-xs font-semibold text-emerald-700 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={formData.documents.drivingLicenseVerified}
                        onChange={(e) => setFormData({
                          ...formData,
                          documents: { ...formData.documents, drivingLicenseVerified: e.target.checked }
                        })}
                        className="rounded text-emerald-600 focus:ring-emerald-500 border-slate-300"
                      />
                      <span>Verified</span>
                    </label>
                  </div>
                  <input
                    type="text"
                    value={formData.documents.drivingLicenseNumber}
                    onChange={(e) => setFormData({
                      ...formData,
                      documents: { ...formData.documents, drivingLicenseNumber: e.target.value.toUpperCase() }
                    })}
                    placeholder="DL Number: KA052021008891"
                    className="w-full bg-white border border-slate-300 rounded px-2.5 py-1.5 text-xs"
                  />
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-slate-500">Expiry Date:</span>
                    <input
                      type="date"
                      value={formData.documents.drivingLicenseExpiry}
                      onChange={(e) => setFormData({
                        ...formData,
                        documents: { ...formData.documents, drivingLicenseExpiry: e.target.value }
                      })}
                      className="bg-white border border-slate-300 rounded px-2 py-0.5 text-xs text-slate-800"
                    />
                  </div>
                </div>

                {/* RC Book */}
                <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-900">2. Vehicle RC Book / Fitness</span>
                    <label className="flex items-center gap-1.5 text-xs font-semibold text-emerald-700 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={formData.documents.rcVerified}
                        onChange={(e) => setFormData({
                          ...formData,
                          documents: { ...formData.documents, rcVerified: e.target.checked }
                        })}
                        className="rounded text-emerald-600 focus:ring-emerald-500 border-slate-300"
                      />
                      <span>Verified</span>
                    </label>
                  </div>
                  <input
                    type="text"
                    value={formData.documents.rcNumber}
                    onChange={(e) => setFormData({
                      ...formData,
                      documents: { ...formData.documents, rcNumber: e.target.value.toUpperCase() }
                    })}
                    placeholder="RC Reference: KA05EV1029RC"
                    className="w-full bg-white border border-slate-300 rounded px-2.5 py-1.5 text-xs"
                  />
                </div>

                {/* Aadhaar Card */}
                <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-900">3. Aadhaar Identity Card</span>
                    <label className="flex items-center gap-1.5 text-xs font-semibold text-emerald-700 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={formData.documents.aadharVerified}
                        onChange={(e) => setFormData({
                          ...formData,
                          documents: { ...formData.documents, aadharVerified: e.target.checked }
                        })}
                        className="rounded text-emerald-600 focus:ring-emerald-500 border-slate-300"
                      />
                      <span>Verified</span>
                    </label>
                  </div>
                  <input
                    type="text"
                    value={formData.documents.aadharNumber}
                    onChange={(e) => setFormData({
                      ...formData,
                      documents: { ...formData.documents, aadharNumber: e.target.value }
                    })}
                    placeholder="Aadhaar: 8812 4491 0021"
                    className="w-full bg-white border border-slate-300 rounded px-2.5 py-1.5 text-xs"
                  />
                </div>

                {/* PAN Card */}
                <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-900">4. PAN Tax Identifier</span>
                    <label className="flex items-center gap-1.5 text-xs font-semibold text-emerald-700 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={formData.documents.panVerified}
                        onChange={(e) => setFormData({
                          ...formData,
                          documents: { ...formData.documents, panVerified: e.target.checked }
                        })}
                        className="rounded text-emerald-600 focus:ring-emerald-500 border-slate-300"
                      />
                      <span>Verified</span>
                    </label>
                  </div>
                  <input
                    type="text"
                    value={formData.documents.panNumber}
                    onChange={(e) => setFormData({
                      ...formData,
                      documents: { ...formData.documents, panNumber: e.target.value.toUpperCase() }
                    })}
                    placeholder="PAN: BGWPG8819L"
                    className="w-full bg-white border border-slate-300 rounded px-2.5 py-1.5 text-xs uppercase"
                  />
                </div>

                {/* Commercial Insurance */}
                <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-900">5. Commercial Insurance</span>
                    <label className="flex items-center gap-1.5 text-xs font-semibold text-emerald-700 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={formData.documents.insuranceVerified}
                        onChange={(e) => setFormData({
                          ...formData,
                          documents: { ...formData.documents, insuranceVerified: e.target.checked }
                        })}
                        className="rounded text-emerald-600 focus:ring-emerald-500 border-slate-300"
                      />
                      <span>Verified</span>
                    </label>
                  </div>
                  <input
                    type="text"
                    value={formData.documents.insurancePolicyNumber}
                    onChange={(e) => setFormData({
                      ...formData,
                      documents: { ...formData.documents, insurancePolicyNumber: e.target.value }
                    })}
                    placeholder="Policy No: ICICI-LOMB-990182"
                    className="w-full bg-white border border-slate-300 rounded px-2.5 py-1.5 text-xs"
                  />
                </div>

                {/* Background Check */}
                <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-900">6. Background Check & Verification</span>
                  </div>
                  <div className="space-y-1.5 pt-1">
                    <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={formData.documents.backgroundCheckPassed}
                        onChange={(e) => setFormData({
                          ...formData,
                          documents: { ...formData.documents, backgroundCheckPassed: e.target.checked }
                        })}
                        className="rounded text-emerald-600 focus:ring-emerald-500 border-slate-300"
                      />
                      <span>Third-Party Background Clearance Passed</span>
                    </label>
                    <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={formData.documents.policeVerificationDocVerified}
                        onChange={(e) => setFormData({
                          ...formData,
                          documents: { ...formData.documents, policeVerificationDocVerified: e.target.checked }
                        })}
                        className="rounded text-emerald-600 focus:ring-emerald-500 border-slate-300"
                      />
                      <span>Police Verification Letter Verified</span>
                    </label>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 5: Bank Details */}
          {activeTab === 'bank' && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-semibold text-slate-700 block mb-1">Beneficiary Account Name</label>
                  <input
                    type="text"
                    value={formData.bankDetails.accountHolderName}
                    onChange={(e) => setFormData({
                      ...formData,
                      bankDetails: { ...formData.bankDetails, accountHolderName: e.target.value }
                    })}
                    placeholder="e.g. Manjunath Gowda"
                    className="w-full bg-slate-50/50 border border-slate-300 rounded-lg px-3 py-2 text-xs text-slate-900 focus:bg-white focus:ring-1 focus:ring-emerald-500 font-medium"
                  />
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-700 block mb-1">Bank Account Number</label>
                  <input
                    type="text"
                    value={formData.bankDetails.accountNumber}
                    onChange={(e) => setFormData({
                      ...formData,
                      bankDetails: { ...formData.bankDetails, accountNumber: e.target.value }
                    })}
                    placeholder="e.g. 91802030405060"
                    className="w-full bg-slate-50/50 border border-slate-300 rounded-lg px-3 py-2 text-xs text-slate-900 focus:bg-white focus:ring-1 focus:ring-emerald-500"
                  />
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-700 block mb-1">Bank IFSC Code</label>
                  <input
                    type="text"
                    value={formData.bankDetails.ifscCode}
                    onChange={(e) => setFormData({
                      ...formData,
                      bankDetails: { ...formData.bankDetails, ifscCode: e.target.value.toUpperCase() }
                    })}
                    placeholder="e.g. HDFC0001234"
                    className="w-full bg-slate-50/50 border border-slate-300 rounded-lg px-3 py-2 text-xs text-slate-900 uppercase focus:bg-white focus:ring-1 focus:ring-emerald-500"
                  />
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-700 block mb-1">Bank Name & Branch</label>
                  <input
                    type="text"
                    value={formData.bankDetails.bankName}
                    onChange={(e) => setFormData({
                      ...formData,
                      bankDetails: { ...formData.bankDetails, bankName: e.target.value }
                    })}
                    placeholder="e.g. HDFC Bank, Koramangala Branch"
                    className="w-full bg-slate-50/50 border border-slate-300 rounded-lg px-3 py-2 text-xs text-slate-900 focus:bg-white focus:ring-1 focus:ring-emerald-500"
                  />
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-700 block mb-1">Direct UPI ID / VPA</label>
                  <input
                    type="text"
                    value={formData.bankDetails.upiId}
                    onChange={(e) => setFormData({
                      ...formData,
                      bankDetails: { ...formData.bankDetails, upiId: e.target.value }
                    })}
                    placeholder="e.g. manjunath.gowda@okhdfcbank"
                    className="w-full bg-slate-50/50 border border-slate-300 rounded-lg px-3 py-2 text-xs text-slate-900 focus:bg-white focus:ring-1 focus:ring-emerald-500"
                  />
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-700 block mb-1">Payout Settlement Frequency</label>
                  <select
                    value={formData.bankDetails.payoutFrequency}
                    onChange={(e) => setFormData({
                      ...formData,
                      bankDetails: { ...formData.bankDetails, payoutFrequency: e.target.value as any }
                    })}
                    className="w-full bg-slate-50/50 border border-slate-300 rounded-lg px-3 py-2 text-xs text-slate-900 focus:bg-white focus:ring-1 focus:ring-emerald-500 font-semibold"
                  >
                    <option value="DAILY">Daily Auto-Disbursement (Every night at 11:30 PM)</option>
                    <option value="WEEKLY">Weekly Batch Payout (Every Monday morning)</option>
                  </select>
                </div>
              </div>
            </div>
          )}

          {/* Footer Controls */}
          <div className="pt-4 border-t border-slate-200 flex items-center justify-between">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-100 rounded-xl transition-colors"
            >
              Cancel
            </button>

            <div className="flex items-center gap-2">
              <button
                type="submit"
                disabled={isSubmitting}
                className="flex items-center gap-2 bg-[#009DE0] hover:bg-[#0087c2] text-white px-5 py-2 rounded-xl text-xs font-bold shadow-xs transition-all disabled:opacity-50"
              >
                <Save className="h-4 w-4" />
                <span>{isSubmitting ? 'Saving Profile...' : isEditing ? 'Update Rider Profile' : 'Complete Onboarding'}</span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
