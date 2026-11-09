import React, { useState, useEffect } from 'react';
import {
  MapPin,
  CheckCircle2,
  AlertTriangle,
  Zap,
  RefreshCw,
  Power,
  Sliders,
  ShieldCheck,
  Building2,
  Globe2,
  Plus,
  Compass,
  Check,
  TrendingUp,
  Layers,
  ArrowUpRight,
  Sparkles,
  Settings2,
  Store,
  Bike,
  Clock,
  Search
} from 'lucide-react';
import { IndianCityConfig, ServiceAreaZone, AdminPermission } from '../../types/admin';
import { adminApi } from '../../utils/adminApiClient';

interface ServiceAreasConfigProps {
  userPermissions: AdminPermission[];
  selectedCity?: string;
  onSelectCity?: (cityId: string) => void;
  searchQuery?: string;
  onSearchQueryChange?: (q: string) => void;
}

type RegionTab = 'ALL' | 'South' | 'North' | 'West' | 'East';

export const ServiceAreasConfig: React.FC<ServiceAreasConfigProps> = ({ 
  userPermissions,
  selectedCity = 'all',
  onSelectCity,
  searchQuery: externalSearchQuery,
  onSearchQueryChange,
}) => {
  const [cities, setCities] = useState<IndianCityConfig[]>([]);
  const [zones, setZones] = useState<ServiceAreaZone[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'CITIES' | 'ZONES'>('CITIES');
  const [selectedRegion, setSelectedRegion] = useState<RegionTab>('ALL');
  const [filterCityId, setFilterCityId] = useState<string>(selectedCity);
  const [searchQuery, setSearchQuery] = useState(externalSearchQuery || '');

  useEffect(() => {
    if (externalSearchQuery !== undefined) {
      setSearchQuery(externalSearchQuery);
    }
  }, [externalSearchQuery]);

  const handleSearchChange = (val: string) => {
    setSearchQuery(val);
    if (onSearchQueryChange) {
      onSearchQueryChange(val);
    }
  };

  // Modals & Drawers
  const [isAddCityOpen, setIsAddCityOpen] = useState(false);
  const [isAddZoneOpen, setIsAddZoneOpen] = useState(false);
  const [editingCity, setEditingCity] = useState<IndianCityConfig | null>(null);
  const [editingSurgeZoneId, setEditingSurgeZoneId] = useState<string | null>(null);
  const [tempSurge, setTempSurge] = useState(1.0);

  // New City Form State
  const [newCityName, setNewCityName] = useState('');
  const [newCityState, setNewCityState] = useState('');
  const [newCityRegion, setNewCityRegion] = useState<'North' | 'South' | 'West' | 'East' | 'Central'>('North');
  const [newCityTier, setNewCityTier] = useState('Tier 2');
  const [newCityCode, setNewCityCode] = useState('');

  // New Zone Form State
  const [newZoneCityId, setNewZoneCityId] = useState('');
  const [newZoneName, setNewZoneName] = useState('');
  const [newZoneHub, setNewZoneHub] = useState('');
  const [newZoneRadius, setNewZoneRadius] = useState(6.0);
  const [newZoneSla, setNewZoneSla] = useState(15);

  const canManageAreas = userPermissions.includes('service_areas.manage') || userPermissions.includes('service_areas.view');

  const fetchData = async () => {
    try {
      setLoading(true);
      const [citiesRes, zonesRes]: [any, any] = await Promise.all([
        adminApi.get('/api/admin/cities'),
        adminApi.get('/api/admin/service-areas'),
      ]);
      if (citiesRes.success) setCities(citiesRes.cities);
      if (zonesRes.success) setZones(zonesRes.zones);
    } catch (err) {
      console.error('Failed to load Indian cities and service areas:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  useEffect(() => {
    if (selectedCity && selectedCity !== 'all') {
      setFilterCityId(selectedCity);
    }
  }, [selectedCity]);

  // Toggle City Active Status
  const handleToggleCity = async (city: IndianCityConfig) => {
    try {
      await adminApi.post(`/api/admin/cities/${city.id}/toggle`, {
        isActive: !city.isActive,
      });
      fetchData();
    } catch (err: any) {
      alert(err.message || 'Failed to update city status');
    }
  };

  // Toggle Zone Active Status
  const handleToggleZone = async (zone: ServiceAreaZone) => {
    try {
      await adminApi.post(`/api/admin/service-areas/${zone.id}/toggle`, {
        isActive: !zone.isActive,
      });
      fetchData();
    } catch (err: any) {
      alert(err.message || 'Failed to update zone status');
    }
  };

  // Update Zone Surge
  const handleSaveZoneSurge = async (zoneId: string) => {
    try {
      await adminApi.post(`/api/admin/service-areas/${zoneId}/toggle`, {
        surgeMultiplier: tempSurge,
      });
      setEditingSurgeZoneId(null);
      fetchData();
    } catch (err: any) {
      alert(err.message || 'Failed to update zone surge');
    }
  };

  // Save City Config
  const handleSaveCityConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingCity) return;
    try {
      await adminApi.post(`/api/admin/cities/${editingCity.id}/config`, {
        minOrderValue: editingCity.minOrderValue,
        baseDeliveryFee: editingCity.baseDeliveryFee,
        surgeMultiplier: editingCity.surgeMultiplier,
        operationalMode: editingCity.operationalMode,
        dailyGmvTarget: editingCity.dailyGmvTarget,
      });
      setEditingCity(null);
      fetchData();
    } catch (err: any) {
      alert(err.message || 'Failed to save city configuration');
    }
  };

  // Create New City
  const handleCreateCity = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCityName || !newCityState) return;
    try {
      await adminApi.post('/api/admin/cities', {
        name: newCityName,
        state: newCityState,
        region: newCityRegion,
        tier: newCityTier,
        code: newCityCode || newCityName.substring(0, 3).toUpperCase(),
      });
      setIsAddCityOpen(false);
      setNewCityName('');
      setNewCityState('');
      setNewCityCode('');
      fetchData();
    } catch (err: any) {
      alert(err.message || 'Failed to launch new city territory');
    }
  };

  // Create New Zone
  const handleCreateZone = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newZoneName || !newZoneCityId) return;
    try {
      await adminApi.post('/api/admin/service-areas', {
        name: newZoneName,
        cityId: newZoneCityId,
        hubLocation: newZoneHub,
        serviceableRadiusKm: newZoneRadius,
        baseSlaMins: newZoneSla,
      });
      setIsAddZoneOpen(false);
      setNewZoneName('');
      setNewZoneHub('');
      fetchData();
    } catch (err: any) {
      alert(err.message || 'Failed to add service area zone');
    }
  };

  const queryLower = searchQuery.toLowerCase();

  // Filters
  const filteredCities = cities.filter((c) => {
    if (selectedRegion !== 'ALL' && c.region !== selectedRegion) return false;
    if (
      queryLower &&
      !c.name.toLowerCase().includes(queryLower) &&
      !c.state.toLowerCase().includes(queryLower) &&
      !c.code?.toLowerCase().includes(queryLower) &&
      !c.region.toLowerCase().includes(queryLower)
    ) {
      return false;
    }
    return true;
  });

  const filteredZones = zones.filter((z) => {
    if (selectedRegion !== 'ALL' && z.region !== selectedRegion) return false;
    if (filterCityId !== 'all' && z.cityId !== filterCityId) return false;
    if (
      queryLower &&
      !z.name.toLowerCase().includes(queryLower) &&
      !z.hubLocation.toLowerCase().includes(queryLower) &&
      !z.cityName.toLowerCase().includes(queryLower)
    ) {
      return false;
    }
    return true;
  });

  const totalActivePartnerStores = cities.reduce((acc, c) => acc + (c.activePartnerStores || 0), 0);
  const totalActiveRiders = zones.reduce((acc, z) => acc + (z.activeRidersCount || 0), 0);
  const avgSla = Math.round((zones.reduce((acc, z) => acc + (z.avgSlaMins || 15), 0) / (zones.length || 1)) * 10) / 10;

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">
            Service Areas & Hubs
          </h1>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-2 flex-wrap self-start sm:self-auto">
          <button
            onClick={() => setIsAddCityOpen(true)}
            className="flex items-center gap-1.5 bg-slate-900 hover:bg-slate-800 text-white font-medium px-3 py-1.5 rounded-md text-xs transition-colors shadow-[0_1px_2px_rgba(0,0,0,0.06)] cursor-pointer"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>Launch New City</span>
          </button>

          <button
            onClick={() => setIsAddZoneOpen(true)}
            className="flex items-center gap-1.5 bg-white hover:bg-slate-50 text-slate-700 font-medium px-3 py-1.5 rounded-md text-xs border border-slate-200/90 transition-colors shadow-[0_1px_2px_rgba(0,0,0,0.02)] cursor-pointer"
          >
            <Layers className="h-3.5 w-3.5 text-slate-400" />
            <span>Add Partner Store Zone</span>
          </button>

          <button
            onClick={fetchData}
            className="flex items-center gap-1.5 bg-white hover:bg-slate-50 text-slate-700 px-3 py-1.5 rounded-md text-xs font-medium border border-slate-200/90 transition-colors shadow-[0_1px_2px_rgba(0,0,0,0.02)] cursor-pointer"
            title="Refresh Indian Grid"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin text-emerald-700' : 'text-slate-500'}`} />
          </button>
        </div>
      </div>

      {/* Top Realtime National Metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-2xs">
          <div className="flex items-center justify-between text-xs text-slate-500 mb-1 font-medium">
            <span>Active Cities & Metros</span>
            <Building2 className="h-4 w-4 text-emerald-600" />
          </div>
          <div className="text-2xl font-bold text-slate-900 font-mono">
            {cities.filter((c) => c.isActive).length} <span className="text-xs text-slate-400 font-normal">/ {cities.length}</span>
          </div>
          <div className="text-[11px] text-emerald-700 mt-1 flex items-center gap-1 font-medium">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500"></span>
            Across North, South, West & East
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-2xs">
          <div className="flex items-center justify-between text-xs text-slate-500 mb-1 font-medium">
            <span>Authorised Partner Stores</span>
            <Store className="h-4 w-4 text-sky-600" />
          </div>
          <div className="text-2xl font-bold text-slate-900 font-mono">{totalActivePartnerStores}</div>
          <div className="text-[11px] text-slate-500 mt-1">10-15 Min Local Delivery</div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-2xs">
          <div className="flex items-center justify-between text-xs text-slate-500 mb-1 font-medium">
            <span>Active Fleet On Duty</span>
            <Bike className="h-4 w-4 text-indigo-600" />
          </div>
          <div className="text-2xl font-bold text-slate-900 font-mono">{totalActiveRiders}</div>
          <div className="text-[11px] text-indigo-700 mt-1 font-medium">EV Scooters & Loaders</div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-2xs">
          <div className="flex items-center justify-between text-xs text-slate-500 mb-1 font-medium">
            <span>Avg Delivery SLA</span>
            <Clock className="h-4 w-4 text-amber-600" />
          </div>
          <div className="text-2xl font-bold text-slate-900 font-mono">{avgSla}m</div>
          <div className="text-[11px] text-emerald-700 mt-1 font-medium">98.4% SLA Adherence</div>
        </div>
      </div>

      {/* Main Tabs: Cities Management vs Hyperlocal Zones */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-slate-50 p-2 rounded-xl border border-slate-200">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setActiveTab('CITIES')}
            className={`px-4 py-2 rounded-lg text-xs font-bold transition-all flex items-center gap-2 ${
              activeTab === 'CITIES'
                ? 'bg-[#009DE0] text-white shadow-xs'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/60'
            }`}
          >
            <Building2 className="h-4 w-4" />
            <span>National City Territories ({cities.length})</span>
          </button>

          <button
            onClick={() => setActiveTab('ZONES')}
            className={`px-4 py-2 rounded-lg text-xs font-bold transition-all flex items-center gap-2 ${
              activeTab === 'ZONES'
                ? 'bg-[#009DE0] text-white shadow-xs'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/60'
            }`}
          >
            <Layers className="h-4 w-4" />
            <span>Hyperlocal Fulfillment Zones ({zones.length})</span>
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-60">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
            <input
              type="text"
              placeholder="Search cities, hubs & zones..."
              value={searchQuery}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="w-full bg-white border border-slate-200 rounded-lg pl-9 pr-3 py-1.5 text-xs text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-900 shadow-2xs"
            />
          </div>

          {/* Region Filter Chips */}
          <div className="flex items-center gap-1.5 overflow-x-auto">
            <span className="text-[11px] text-slate-500 font-mono mr-1 hidden lg:inline">REGION:</span>
            {(['ALL', 'South', 'North', 'West', 'East'] as RegionTab[]).map((reg) => (
              <button
                key={reg}
                onClick={() => setSelectedRegion(reg)}
                className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-colors ${
                  selectedRegion === reg
                    ? 'bg-slate-800 text-white font-bold'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/60'
                }`}
              >
                {reg === 'ALL' ? 'Pan-India' : reg}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* VIEW 1: Indian Cities Management Grid */}
      {activeTab === 'CITIES' && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredCities.map((city) => {
            const cityZones = zones.filter((z) => z.cityId === city.id);
            return (
              <div
                key={city.id}
                className="bg-white border border-slate-200 hover:border-slate-300 rounded-2xl p-5 shadow-xs transition-all flex flex-col justify-between space-y-4"
              >
                <div>
                  {/* City Title & Status Badge */}
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="font-extrabold text-slate-900 text-base">{city.name}</h3>
                        <span className="text-[10px] font-mono bg-slate-100 text-slate-700 font-semibold px-1.5 py-0.5 rounded border border-slate-200">
                          {city.code || city.id.toUpperCase().substring(0, 3)}
                        </span>
                      </div>
                      <p className="text-xs text-slate-500 mt-0.5 flex items-center gap-1">
                        <span>{city.state}</span>
                        <span>•</span>
                        <span className="text-emerald-700 font-medium">{city.region} India</span>
                        <span>•</span>
                        <span className="text-slate-500">{city.tier || 'Tier 1'}</span>
                      </p>
                    </div>

                    <button
                      onClick={() => handleToggleCity(city)}
                      className={`px-2.5 py-1 rounded-lg text-[10px] font-mono font-bold uppercase transition-colors ${
                        city.isActive
                          ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                          : 'bg-rose-100 text-rose-800 border border-rose-200'
                      }`}
                    >
                      {city.isActive ? 'ACTIVE' : 'PAUSED'}
                    </button>
                  </div>

                  {/* Mode Badge & KPI Strip */}
                  <div className="mt-3 flex items-center gap-2">
                    <span className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded-full border ${
                      city.operationalMode === 'HYPER_SCALE'
                        ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                        : city.operationalMode === 'GROWTH'
                        ? 'bg-sky-50 text-sky-800 border-sky-200'
                        : 'bg-amber-50 text-amber-800 border-amber-200'
                    }`}>
                      MODE: {city.operationalMode}
                    </span>

                    <span className="text-[10px] font-mono text-slate-500">
                      Target: ₹{(city.dailyGmvTarget || 100000).toLocaleString('en-IN')}/day
                    </span>
                  </div>

                  {/* Stats Card */}
                  <div className="mt-4 p-3 bg-slate-50 rounded-xl border border-slate-200 space-y-2 text-xs font-mono">
                    <div className="flex justify-between text-slate-700">
                      <span className="text-slate-500">Partner Stores:</span>
                      <span className="text-slate-900 font-bold">{city.activePartnerStores || 0} Stores ({cityZones.length} Zones)</span>
                    </div>
                    <div className="flex justify-between text-slate-700">
                      <span className="text-slate-500">Contractors Active:</span>
                      <span className="text-emerald-700 font-bold">{city.activeContractorsCount || 120}+ registered</span>
                    </div>
                    <div className="flex justify-between text-slate-700">
                      <span className="text-slate-500">Base Delivery Fee:</span>
                      <span className="text-slate-900">₹{city.baseDeliveryFee} (Free above ₹{city.minOrderValue})</span>
                    </div>
                    <div className="flex justify-between text-slate-700">
                      <span className="text-slate-500">Surge Multiplier:</span>
                      <span className={`font-bold ${city.surgeMultiplier > 1.0 ? 'text-amber-700' : 'text-slate-700'}`}>
                        {city.surgeMultiplier}x
                      </span>
                    </div>
                  </div>
                </div>

                {/* Card Footer Actions */}
                <div className="pt-3 border-t border-slate-200 flex items-center justify-between gap-2">
                  <button
                    onClick={() => {
                      setFilterCityId(city.id);
                      setActiveTab('ZONES');
                    }}
                    className="text-xs text-sky-700 hover:text-sky-800 font-semibold flex items-center gap-1"
                  >
                    <span>View {cityZones.length} Zones</span>
                    <ArrowUpRight className="h-3 w-3" />
                  </button>

                  <button
                    onClick={() => setEditingCity(city)}
                    className="flex items-center gap-1 bg-white hover:bg-slate-50 text-slate-700 px-2.5 py-1 rounded-lg text-xs font-semibold border border-slate-300 transition-colors shadow-2xs"
                  >
                    <Settings2 className="h-3.5 w-3.5 text-slate-500" />
                    <span>Configure</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* VIEW 2: Hyperlocal Delivery Zones Grid */}
      {activeTab === 'ZONES' && (
        <div className="space-y-4">
          {/* City Filter Selector */}
          <div className="flex items-center justify-between gap-4 bg-white p-3 rounded-xl border border-slate-200 shadow-2xs">
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-500 font-mono font-medium">FILTER BY METRO:</span>
              <select
                value={filterCityId}
                onChange={(e) => setFilterCityId(e.target.value)}
                className="bg-white border border-slate-300 rounded-lg px-3 py-1 text-xs text-slate-900 font-medium focus:outline-none focus:ring-1 focus:ring-emerald-500"
              >
                <option value="all">All Cities & Regions</option>
                {cities.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.state}) - {c.region}
                  </option>
                ))}
              </select>
            </div>

            <span className="text-xs text-slate-500 font-mono">
              Showing {filteredZones.length} of {zones.length} active zones
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredZones.map((zone) => (
              <div
                key={zone.id}
                className="bg-white border border-slate-200 rounded-2xl p-5 shadow-xs space-y-4 hover:border-slate-300 transition-all flex flex-col justify-between"
              >
                <div>
                  <div className="flex items-start justify-between">
                    <div>
                      <h3 className="font-bold text-slate-900 text-base flex items-center gap-1.5">
                        <MapPin className="h-4 w-4 text-sky-600" />
                        {zone.name}
                      </h3>
                      <p className="text-xs text-slate-500 mt-0.5 flex items-center gap-1.5 font-mono">
                        <span className="text-emerald-700 font-semibold">{zone.cityName || 'Metro'}</span>
                        <span>•</span>
                        <span>{zone.state || 'India'}</span>
                      </p>
                    </div>

                    <button
                      onClick={() => handleToggleZone(zone)}
                      className={`px-2.5 py-1 rounded-lg text-[10px] font-mono font-bold uppercase transition-colors ${
                        zone.isActive
                          ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                          : 'bg-slate-100 text-slate-500 border border-slate-200'
                      }`}
                    >
                      {zone.isActive ? 'ACTIVE ZONE' : 'DISABLED'}
                    </button>
                  </div>

                  <div className="mt-4 p-3 bg-slate-50 rounded-xl border border-slate-200 space-y-2 text-xs font-mono">
                    <div className="flex justify-between text-slate-700">
                      <span className="text-slate-500">Partner Store Location:</span>
                      <span className="text-slate-900 font-bold truncate max-w-[170px]">{zone.hubLocation || 'Local Partner Store'}</span>
                    </div>
                    <div className="flex justify-between text-slate-700">
                      <span className="text-slate-500">Coverage Radius:</span>
                      <span className="text-slate-900 font-bold">{zone.serviceableRadiusKm || zone.radiusKm || 6.5} km radius</span>
                    </div>
                    <div className="flex justify-between text-slate-700">
                      <span className="text-slate-500">Active Riders on Duty:</span>
                      <span className="text-emerald-700 font-bold">{zone.activeRidersCount} Online</span>
                    </div>
                    <div className="flex justify-between text-slate-700">
                      <span className="text-slate-500">Avg Delivery SLA:</span>
                      <span className="text-sky-700 font-bold">{zone.avgSlaMins || 15} mins</span>
                    </div>
                  </div>
                </div>

                {/* Surge multiplier editor */}
                <div className="pt-3 border-t border-slate-200 flex items-center justify-between text-xs">
                  <span className="text-slate-500 flex items-center gap-1 font-medium">
                    <Zap className="h-3.5 w-3.5 text-amber-600" />
                    Surge Multiplier:
                  </span>

                  {editingSurgeZoneId === zone.id ? (
                    <div className="flex items-center gap-1.5">
                      <input
                        type="number"
                        step="0.1"
                        min="1.0"
                        max="3.0"
                        value={tempSurge}
                        onChange={(e) => setTempSurge(Number(e.target.value))}
                        className="w-16 bg-white border border-slate-300 rounded px-1.5 py-0.5 text-xs text-slate-900 font-mono"
                      />
                      <button
                        onClick={() => handleSaveZoneSurge(zone.id)}
                        className="bg-emerald-600 text-white font-bold px-2 py-0.5 rounded text-[11px]"
                      >
                        Save
                      </button>
                      <button
                        onClick={() => setEditingSurgeZoneId(null)}
                        className="text-slate-500 hover:text-slate-800 text-[11px]"
                      >
                        X
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <span
                        className={`font-mono font-bold ${
                          zone.surgeMultiplier > 1.0 ? 'text-amber-700' : 'text-slate-700'
                        }`}
                      >
                        {zone.surgeMultiplier}x
                      </span>
                      <button
                        onClick={() => {
                          setEditingSurgeZoneId(zone.id);
                          setTempSurge(zone.surgeMultiplier);
                        }}
                        className="text-slate-500 hover:text-slate-800 text-[10px] underline font-mono"
                      >
                        Edit
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* MODAL 1: Launch New Indian City Territory */}
      {isAddCityOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs z-50 flex items-center justify-center p-3 sm:p-5 overflow-y-auto">
          <div className="bg-white border border-slate-200 rounded-2xl max-w-lg w-full max-h-[90vh] sm:max-h-[85vh] flex flex-col my-auto shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 shrink-0 bg-white">
              <div className="flex items-center gap-2 font-bold text-slate-900 text-base">
                <Globe2 className="h-5 w-5 text-emerald-600" />
                Launch New Indian City Territory
              </div>
              <button
                onClick={() => setIsAddCityOpen(false)}
                className="text-slate-400 hover:text-slate-700 font-bold text-sm p-1 rounded-lg hover:bg-slate-100 transition-colors"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleCreateCity} className="flex-1 flex flex-col min-h-0 overflow-hidden text-xs">
              <div className="p-6 space-y-4 overflow-y-auto flex-1">
                <div>
                  <label className="block text-slate-700 font-semibold mb-1">City Name</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Lucknow, Chandigarh, Surat"
                    value={newCityName}
                    onChange={(e) => setNewCityName(e.target.value)}
                    className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-slate-700 font-semibold mb-1">State</label>
                    <input
                      type="text"
                      required
                      placeholder="e.g. Uttar Pradesh"
                      value={newCityState}
                      onChange={(e) => setNewCityState(e.target.value)}
                      className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    />
                  </div>

                  <div>
                    <label className="block text-slate-700 font-semibold mb-1">3-Letter Code</label>
                    <input
                      type="text"
                      placeholder="e.g. LKO"
                      maxLength={4}
                      value={newCityCode}
                      onChange={(e) => setNewCityCode(e.target.value.toUpperCase())}
                      className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-slate-900 font-mono uppercase focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-slate-700 font-semibold mb-1">Region</label>
                    <select
                      value={newCityRegion}
                      onChange={(e: any) => setNewCityRegion(e.target.value)}
                      className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    >
                      <option value="North">North India</option>
                      <option value="South">South India</option>
                      <option value="West">West India</option>
                      <option value="East">East India</option>
                      <option value="Central">Central India</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-slate-700 font-semibold mb-1">Tier</label>
                    <select
                      value={newCityTier}
                      onChange={(e) => setNewCityTier(e.target.value)}
                      className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    >
                      <option value="Tier 1">Tier 1 Metro</option>
                      <option value="Tier 2">Tier 2 Industrial Hub</option>
                      <option value="Tier 3">Tier 3 Smart City</option>
                    </select>
                  </div>
                </div>
              </div>

              <div className="px-6 py-3.5 bg-slate-50 border-t border-slate-200 flex justify-end gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => setIsAddCityOpen(false)}
                  className="px-4 py-2 rounded-lg bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 font-semibold transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-lg bg-[#009DE0] hover:bg-[#0087c2] text-white font-bold transition-colors shadow-xs"
                >
                  Launch Territory
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 2: Add Hyperlocal Partner Store Zone */}
      {isAddZoneOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs z-50 flex items-center justify-center p-3 sm:p-5 overflow-y-auto">
          <div className="bg-white border border-slate-200 rounded-2xl max-w-lg w-full max-h-[90vh] sm:max-h-[85vh] flex flex-col my-auto shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 shrink-0 bg-white">
              <div className="flex items-center gap-2 font-bold text-slate-900 text-base">
                <Layers className="h-5 w-5 text-sky-600" />
                Add Hyperlocal Partner Store Zone
              </div>
              <button
                onClick={() => setIsAddZoneOpen(false)}
                className="text-slate-400 hover:text-slate-700 font-bold text-sm p-1 rounded-lg hover:bg-slate-100 transition-colors"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleCreateZone} className="flex-1 flex flex-col min-h-0 overflow-hidden text-xs">
              <div className="p-6 space-y-4 overflow-y-auto flex-1">
                <div>
                  <label className="block text-slate-700 font-semibold mb-1">Select Parent City</label>
                  <select
                    required
                    value={newZoneCityId}
                    onChange={(e) => setNewZoneCityId(e.target.value)}
                    className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  >
                    <option value="">-- Choose Indian City Territory --</option>
                    {cities.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.state}) - {c.region}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-slate-700 font-semibold mb-1">Zone / Micro-Market Name</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Powai Tech Park, Cyber Hub, OMR IT Corridor"
                    value={newZoneName}
                    onChange={(e) => setNewZoneName(e.target.value)}
                    className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </div>

                <div>
                  <label className="block text-slate-700 font-semibold mb-1">Primary Fulfillment Store / Authorised Seller</label>
                  <input
                    type="text"
                    placeholder="e.g. Powai Organic Mart (GST Auth)"
                    value={newZoneHub}
                    onChange={(e) => setNewZoneHub(e.target.value)}
                    className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-slate-700 font-semibold mb-1">Coverage Radius (Km)</label>
                    <input
                      type="number"
                      step="0.5"
                      min="2"
                      max="15"
                      value={newZoneRadius}
                      onChange={(e) => setNewZoneRadius(Number(e.target.value))}
                      className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-slate-900 font-mono"
                    />
                  </div>

                  <div>
                    <label className="block text-slate-700 font-semibold mb-1">Target SLA (Mins)</label>
                    <input
                      type="number"
                      min="10"
                      max="30"
                      value={newZoneSla}
                      onChange={(e) => setNewZoneSla(Number(e.target.value))}
                      className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-slate-900 font-mono"
                    />
                  </div>
                </div>
              </div>

              <div className="px-6 py-3.5 bg-slate-50 border-t border-slate-200 flex justify-end gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => setIsAddZoneOpen(false)}
                  className="px-4 py-2 rounded-lg bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 font-semibold transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white font-bold transition-colors shadow-xs"
                >
                  Add Zone
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 3: Configure City Territory Economics */}
      {editingCity && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs z-50 flex items-center justify-center p-3 sm:p-5 overflow-y-auto">
          <div className="bg-white border border-slate-200 rounded-2xl max-w-lg w-full max-h-[90vh] sm:max-h-[85vh] flex flex-col my-auto shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 shrink-0 bg-white">
              <div>
                <div className="font-bold text-slate-900 text-base flex items-center gap-2">
                  <Settings2 className="h-5 w-5 text-emerald-600" />
                  Configure {editingCity.name} ({editingCity.state})
                </div>
                <span className="text-[11px] text-slate-500 font-mono">
                  {editingCity.region} India • {editingCity.tier || 'Tier 1'}
                </span>
              </div>
              <button
                onClick={() => setEditingCity(null)}
                className="text-slate-400 hover:text-slate-700 font-bold text-sm p-1 rounded-lg hover:bg-slate-100 transition-colors"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSaveCityConfig} className="flex-1 flex flex-col min-h-0 overflow-hidden text-xs">
              <div className="p-6 space-y-4 overflow-y-auto flex-1">
                <div>
                  <label className="block text-slate-700 font-semibold mb-1">Operational Mode</label>
                  <select
                    value={editingCity.operationalMode}
                    onChange={(e: any) =>
                      setEditingCity({ ...editingCity, operationalMode: e.target.value })
                    }
                    className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  >
                    <option value="PILOT">PILOT (Initial Soft Launch & Calibration)</option>
                    <option value="GROWTH">GROWTH (Scaling Local Seller Network)</option>
                    <option value="HYPER_SCALE">HYPER_SCALE (High Density & Automated Dispatch)</option>
                    <option value="MAINTENANCE">MAINTENANCE (Temporary Restricted Operations)</option>
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-slate-700 font-semibold mb-1">Base Delivery Fee (₹)</label>
                    <input
                      type="number"
                      min="0"
                      value={editingCity.baseDeliveryFee}
                      onChange={(e) =>
                        setEditingCity({ ...editingCity, baseDeliveryFee: Number(e.target.value) })
                      }
                      className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-slate-900 font-mono"
                    />
                  </div>

                  <div>
                    <label className="block text-slate-700 font-semibold mb-1">Free Delivery Min Order (₹)</label>
                    <input
                      type="number"
                      min="0"
                      value={editingCity.minOrderValue}
                      onChange={(e) =>
                        setEditingCity({ ...editingCity, minOrderValue: Number(e.target.value) })
                      }
                      className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-slate-900 font-mono"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-slate-700 font-semibold mb-1">Surge Multiplier</label>
                    <input
                      type="number"
                      step="0.1"
                      min="1.0"
                      max="3.0"
                      value={editingCity.surgeMultiplier}
                      onChange={(e) =>
                        setEditingCity({ ...editingCity, surgeMultiplier: Number(e.target.value) })
                      }
                      className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-slate-900 font-mono"
                    />
                  </div>

                  <div>
                    <label className="block text-slate-700 font-semibold mb-1">Daily Target GMV (₹)</label>
                    <input
                      type="number"
                      step="50000"
                      min="50000"
                      value={editingCity.dailyGmvTarget || 150000}
                      onChange={(e) =>
                        setEditingCity({ ...editingCity, dailyGmvTarget: Number(e.target.value) })
                      }
                      className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-slate-900 font-mono"
                    />
                  </div>
                </div>
              </div>

              <div className="px-6 py-3.5 bg-slate-50 border-t border-slate-200 flex justify-end gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => setEditingCity(null)}
                  className="px-4 py-2 rounded-lg bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 font-semibold transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-lg bg-[#009DE0] hover:bg-[#0087c2] text-white font-bold transition-colors shadow-xs"
                >
                  Save City Economics
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
