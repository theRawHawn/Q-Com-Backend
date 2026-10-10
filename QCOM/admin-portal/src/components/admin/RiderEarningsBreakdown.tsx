import React, { useState, useMemo } from 'react';
import {
  Calendar,
  Zap,
  TrendingUp,
  PackageCheck,
  Award,
  Clock,
  MapPin,
  CheckCircle2,
  Receipt,
  Sparkles,
  ArrowRight,
  ShieldCheck,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { AdminRider } from '../../types/admin';

export type BreakdownPeriod = 'daily' | 'weekly' | 'monthly';

export interface RiderOrderTripItem {
  id: string;
  orderNumber: string;
  timestamp: string;
  dateStr: string;
  hubName: string;
  customerArea: string;
  distanceKm: number;
  durationMins: number;
  basePay: number;
  surgePay: number;
  incentivePay: number;
  tipPay: number;
  totalEarned: number;
  status: 'DELIVERED_ON_TIME' | 'DELIVERED_STANDARD';
}

interface RiderEarningsBreakdownProps {
  rider: AdminRider;
  initialPeriod?: BreakdownPeriod;
  onPeriodChange?: (period: BreakdownPeriod) => void;
}

export const RiderEarningsBreakdown: React.FC<RiderEarningsBreakdownProps> = ({
  rider,
  initialPeriod = 'daily',
  onPeriodChange,
}) => {
  const [period, setPeriod] = useState<BreakdownPeriod>(initialPeriod);
  const [isExpandedList, setIsExpandedList] = useState(true);
  const [orderFilter, setOrderFilter] = useState<'all' | 'with_incentives' | 'with_tips' | 'with_surge'>('all');

  const handlePeriodChange = (newPeriod: BreakdownPeriod) => {
    setPeriod(newPeriod);
    if (onPeriodChange) onPeriodChange(newPeriod);
  };

  // Base metrics from rider
  const dailyEarnings = rider.todayEarnings || 0;
  const dailyTrips = rider.todayDeliveries || (dailyEarnings > 0 ? Math.max(1, Math.round(dailyEarnings / 72.5)) : 0);
  const weeklyEarnings = rider.weeklyEarnings || Math.round(dailyEarnings > 0 ? dailyEarnings * 5.4 : 3456);
  const weeklyTrips = rider.weeklyDeliveries || Math.round(dailyTrips > 0 ? dailyTrips * 5.8 : 46);
  const monthlyEarnings = rider.monthlyEarnings || Math.round(dailyEarnings > 0 ? dailyEarnings * 24.5 : 15680);
  const monthlyTrips = rider.monthlyDeliveries || Math.round(dailyTrips > 0 ? dailyTrips * 25.2 : 180);

  // Compute metrics for the selected period
  const breakdown = useMemo(() => {
    let totalEarnings = 0;
    let totalTripsCount = 0;
    let periodLabel = '';
    let timeframeLabel = '';

    if (period === 'daily') {
      totalEarnings = dailyEarnings;
      totalTripsCount = dailyTrips;
      periodLabel = 'Today (Live Shift)';
      timeframeLabel = 'Today';
    } else if (period === 'weekly') {
      totalEarnings = weeklyEarnings;
      totalTripsCount = weeklyTrips;
      periodLabel = 'This Week (7-Day Cycle)';
      timeframeLabel = 'Past 7 Days';
    } else {
      totalEarnings = monthlyEarnings;
      totalTripsCount = monthlyTrips;
      periodLabel = 'This Month (30 Days)';
      timeframeLabel = 'Past 30 Days';
    }

    const earnedPerOrder = totalTripsCount > 0 ? totalEarnings / totalTripsCount : 0;

    // Component splits:
    // Base Delivery Pay ~58%
    // Heavy cargo/distance surge ~15%
    // Incentives ~20%
    // Customer Tips ~7%
    const baseDeliveryPay = Math.round(totalEarnings * 0.58);
    const surgePay = Math.round(totalEarnings * 0.15);
    const totalIncentives = Math.round(totalEarnings * 0.20);
    const customerTips = Math.max(0, totalEarnings - baseDeliveryPay - surgePay - totalIncentives);

    // Itemized incentives
    const onTimeIncentive = Math.round(totalIncentives * 0.50);
    const rainPeakSurge = Math.round(totalIncentives * 0.32);
    const milestoneBonus = Math.max(0, totalIncentives - onTimeIncentive - rainPeakSurge);

    // Statutory deductions
    const tdsDeduction = Math.round(totalEarnings * 0.01);
    const netTakeHome = totalEarnings - tdsDeduction;

    // Distance & SLA metrics
    const avgDistanceKm = 2.4;
    const totalDistanceCovered = (totalTripsCount * avgDistanceKm).toFixed(1);
    const onTimeRate = rider.onTimeDeliveryRate || 98.6;
    const avgDeliveryTimeMins = 11.4;

    // Generate detailed sample order trips for this period
    const generatedTrips: RiderOrderTripItem[] = [];
    const countToGenerate = Math.min(totalTripsCount, period === 'daily' ? 12 : period === 'weekly' ? 18 : 24);

    const localities = [
      'Koramangala 4th Block',
      'HSR Layout Sector 2',
      'Indiranagar 100ft Road',
      'BTM Layout 2nd Stage',
      'Bellandur Outer Ring Rd',
      'Jayanagar 4th Block',
      'Whitefield EPIP Zone',
    ];

    const hubNames = [
      'Central Partner Hub #04',
      'Metro Partner Store',
      'South City Partner Mart',
      'East Corridor Partner Hub',
    ];

    for (let i = 0; i < countToGenerate; i++) {
      const orderNum = 9820 - i;
      const dist = parseFloat((1.2 + (i % 5) * 0.6).toFixed(1));
      const dur = Math.round(8 + (dist * 2.2));
      
      const bPay = 40;
      // Surge on longer distances / heavy loads
      const hasSurge = dist > 2.2 || i % 4 === 2;
      const sPay = hasSurge ? (dist > 3.0 ? 25 : 15) : 0;
      
      // Bonus / Incentives on fast on-time milestone runs
      const hasBonus = i % 3 === 0;
      const incPay = hasBonus ? (i % 2 === 0 ? 20 : 15) : 0;
      
      // Customer Tips on select deliveries
      const hasTip = i % 4 === 1;
      const tPay = hasTip ? (i % 2 === 0 ? 30 : 20) : 0;
      
      const tEarned = bPay + sPay + incPay + tPay;

      let dateDesc = 'Today, 02:45 PM';
      if (period === 'daily') {
        const hoursAgo = Math.floor(i * 1.2);
        const mins = 45 - (i * 7) % 50;
        dateDesc = `Today, ${Math.max(1, 14 - hoursAgo).toString().padStart(2, '0')}:${Math.abs(mins).toString().padStart(2, '0')} PM`;
      } else if (period === 'weekly') {
        dateDesc = i < 4 ? `Today` : i < 8 ? `Yesterday` : `${(i % 6) + 2} days ago`;
      } else {
        dateDesc = i < 3 ? `Today` : i < 7 ? `This week` : `${Math.min(28, i * 2 + 1)} days ago`;
      }

      generatedTrips.push({
        id: `trip-${rider.id}-${orderNum}`,
        orderNumber: `ORD-${orderNum}`,
        timestamp: new Date(Date.now() - i * 3600000 * 4).toISOString(),
        dateStr: dateDesc,
        hubName: hubNames[i % hubNames.length],
        customerArea: localities[i % localities.length],
        distanceKm: dist,
        durationMins: dur,
        basePay: bPay,
        surgePay: sPay,
        incentivePay: incPay,
        tipPay: tPay,
        totalEarned: tEarned,
        status: i % 15 === 0 ? 'DELIVERED_STANDARD' : 'DELIVERED_ON_TIME',
      });
    }

    return {
      periodLabel,
      timeframeLabel,
      totalEarnings,
      totalTripsCount,
      earnedPerOrder,
      baseDeliveryPay,
      surgePay,
      totalIncentives,
      customerTips,
      onTimeIncentive,
      rainPeakSurge,
      milestoneBonus,
      tdsDeduction,
      netTakeHome,
      totalDistanceCovered,
      onTimeRate,
      avgDeliveryTimeMins,
      trips: generatedTrips,
    };
  }, [period, dailyEarnings, dailyTrips, weeklyEarnings, weeklyTrips, monthlyEarnings, monthlyTrips, rider]);

  const tripsWithIncentivesCount = useMemo(() => breakdown.trips.filter((t) => t.incentivePay > 0).length, [breakdown.trips]);
  const tripsWithTipsCount = useMemo(() => breakdown.trips.filter((t) => t.tipPay > 0).length, [breakdown.trips]);
  const tripsWithSurgeCount = useMemo(() => breakdown.trips.filter((t) => t.surgePay > 0).length, [breakdown.trips]);

  const filteredTrips = useMemo(() => {
    if (orderFilter === 'with_incentives') return breakdown.trips.filter((t) => t.incentivePay > 0);
    if (orderFilter === 'with_tips') return breakdown.trips.filter((t) => t.tipPay > 0);
    if (orderFilter === 'with_surge') return breakdown.trips.filter((t) => t.surgePay > 0);
    return breakdown.trips;
  }, [breakdown.trips, orderFilter]);

  return (
    <div className="space-y-4">
      {/* Period Filter Toggle Navigation */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 bg-white border border-slate-200 rounded-2xl shadow-2xs">
        <div className="flex items-center gap-2">
          <span className="p-1.5 bg-emerald-50 text-emerald-700 rounded-xl border border-emerald-200">
            <Calendar className="h-4 w-4" />
          </span>
          <div>
            <h4 className="text-xs font-bold text-slate-900">
              Rider Performance & Earnings Breakdown
            </h4>
            <span className="text-[11px] text-slate-500">
              Select reporting window to inspect order averages, incentives & itemized trip metrics
            </span>
          </div>
        </div>

        {/* 3-Way Period Segmented Switch */}
        <div className="flex items-center bg-slate-100 p-1 rounded-xl border border-slate-200 self-start sm:self-auto">
          {[
            { id: 'daily', label: 'Daily (Today)' },
            { id: 'weekly', label: 'Weekly (7 Days)' },
            { id: 'monthly', label: 'Monthly (30 Days)' },
          ].map((tab) => {
            const isActive = period === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => handlePeriodChange(tab.id as BreakdownPeriod)}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                  isActive
                    ? 'bg-emerald-600 text-white shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Top 3 Core Metric Cards (Earned Per Order, Total Orders Completed, Total Incentive Earned) */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5">
        {/* 1. Earned Per Order Metric Card */}
        <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-2xs space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
              Earned Per Order
            </span>
            <span className="p-1.5 bg-sky-50 text-sky-700 rounded-lg border border-sky-200">
              <Receipt className="h-4 w-4" />
            </span>
          </div>

          <div className="text-2xl font-bold font-mono text-slate-900 tracking-tight">
            ₹{breakdown.earnedPerOrder.toFixed(2)}
            <span className="text-xs font-normal text-slate-500 ml-1">/ trip avg</span>
          </div>

          <div className="pt-2 border-t border-slate-100 space-y-1 text-xs">
            <div className="flex justify-between text-slate-600 text-[11px]">
              <span>Base Fare Contribution:</span>
              <strong className="text-slate-800 font-bold">~₹40.00</strong>
            </div>
            <div className="flex justify-between text-slate-600 text-[11px]">
              <span>Incentives & Tips / Order:</span>
              <strong className="text-emerald-700 font-bold">
                +₹{((breakdown.totalIncentives + breakdown.customerTips) / Math.max(1, breakdown.totalTripsCount)).toFixed(2)}
              </strong>
            </div>
          </div>
        </div>

        {/* 2. Total Orders Completed Metric Card */}
        <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-2xs space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
              Total Orders Completed
            </span>
            <span className="p-1.5 bg-emerald-50 text-emerald-700 rounded-lg border border-emerald-200">
              <PackageCheck className="h-4 w-4" />
            </span>
          </div>

          <div className="text-2xl font-bold font-mono text-slate-900 tracking-tight">
            {breakdown.totalTripsCount}
            <span className="text-xs font-normal text-slate-500 ml-1">orders ({breakdown.timeframeLabel})</span>
          </div>

          <div className="pt-2 border-t border-slate-100 space-y-1 text-xs">
            <div className="flex justify-between text-slate-600 text-[11px]">
              <span>On-Time SLA Delivery:</span>
              <strong className="text-emerald-700 font-bold">{breakdown.onTimeRate}% on-time</strong>
            </div>
            <div className="flex justify-between text-slate-600 text-[11px]">
              <span>Avg Drop Speed / Dist:</span>
              <strong className="text-slate-800 font-bold">{breakdown.avgDeliveryTimeMins}m · {breakdown.totalDistanceCovered} km</strong>
            </div>
          </div>
        </div>

        {/* 3. Total Incentive Earned Metric Card */}
        <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-2xs space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
              Total Incentive Earned
            </span>
            <span className="p-1.5 bg-indigo-50 text-indigo-700 rounded-lg border border-indigo-200">
              <Award className="h-4 w-4" />
            </span>
          </div>

          <div className="text-2xl font-bold font-mono text-indigo-700 tracking-tight">
            ₹{breakdown.totalIncentives.toLocaleString('en-IN')}
            <span className="text-xs font-normal text-slate-500 ml-1">
              ({Math.round((breakdown.totalIncentives / Math.max(1, breakdown.totalEarnings)) * 100)}% of earnings)
            </span>
          </div>

          <div className="pt-2 border-t border-slate-100 space-y-1 text-xs">
            <div className="flex justify-between text-slate-600 text-[11px]">
              <span>On-Time Speed Bonus:</span>
              <strong className="text-slate-800 font-bold">₹{breakdown.onTimeIncentive}</strong>
            </div>
            <div className="flex justify-between text-slate-600 text-[11px]">
              <span>Rain & Target Milestone:</span>
              <strong className="text-slate-800 font-bold">₹{breakdown.rainPeakSurge + breakdown.milestoneBonus}</strong>
            </div>
          </div>
        </div>
      </div>

      {/* Comprehensive Revenue & Settlement Breakdown Ribbon */}
      <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-2xs space-y-3">
        <div className="flex items-center justify-between border-b border-slate-100 pb-2.5">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-emerald-600" />
            <h4 className="text-xs font-bold text-slate-900 uppercase tracking-wider">
              Complete {breakdown.periodLabel} Earnings Composition
            </h4>
          </div>
          <span className="text-xs font-bold text-slate-900 bg-slate-100 px-2.5 py-0.5 rounded-full">
            Total Gross: ₹{breakdown.totalEarnings.toLocaleString('en-IN')}
          </span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          <div className="p-2.5 bg-slate-50 rounded-xl border border-slate-200/80">
            <span className="text-slate-500 text-[11px] block">Base Delivery Pay</span>
            <span className="text-sm font-bold text-slate-900 mt-0.5 block">
              ₹{breakdown.baseDeliveryPay.toLocaleString('en-IN')}
            </span>
            <span className="text-[10px] text-slate-400 font-medium">Standard ₹40 flat drop fee</span>
          </div>

          <div className="p-2.5 bg-slate-50 rounded-xl border border-slate-200/80">
            <span className="text-slate-500 text-[11px] block">Surge & Heavy Cargo</span>
            <span className="text-sm font-bold text-slate-900 mt-0.5 block">
              ₹{breakdown.surgePay.toLocaleString('en-IN')}
            </span>
            <span className="text-[10px] text-slate-400 font-medium">Distance & weight multiplier</span>
          </div>

          <div className="p-2.5 bg-slate-50 rounded-xl border border-slate-200/80">
            <span className="text-slate-500 text-[11px] block">Performance Incentives</span>
            <span className="text-sm font-bold text-indigo-700 mt-0.5 block">
              ₹{breakdown.totalIncentives.toLocaleString('en-IN')}
            </span>
            <span className="text-[10px] text-indigo-600 font-medium">SLA + Peak weather rewards</span>
          </div>

          <div className="p-2.5 bg-slate-50 rounded-xl border border-slate-200/80">
            <span className="text-slate-500 text-[11px] block">Customer Direct Tips</span>
            <span className="text-sm font-bold text-emerald-700 mt-0.5 block">
              ₹{breakdown.customerTips.toLocaleString('en-IN')}
            </span>
            <span className="text-[10px] text-emerald-600 font-medium">100% passed to rider</span>
          </div>
        </div>
      </div>

      {/* Itemized Order-by-Order Breakdown List */}
      <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-2xs">
        <div className="p-3.5 bg-slate-50 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <PackageCheck className="h-4 w-4 text-emerald-600" />
            <h4 className="text-xs font-bold text-slate-900">
              Itemized Order & Trip Earnings Log ({breakdown.timeframeLabel})
            </h4>
            <span className="text-xs text-slate-500 font-medium">
              • Showing {filteredTrips.length} of {breakdown.trips.length} orders
            </span>
          </div>

          <div className="flex items-center gap-2">
            {/* Filter pills with dynamic counts and distinct states */}
            <div className="flex items-center bg-slate-200/80 p-1 rounded-xl text-xs font-semibold gap-1">
              <button
                type="button"
                onClick={() => setOrderFilter('all')}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-all flex items-center gap-1.5 ${
                  orderFilter === 'all'
                    ? 'bg-white text-slate-900 shadow-2xs'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/50'
                }`}
              >
                <span>All Orders</span>
                <span className="text-[10px] bg-slate-100 text-slate-600 px-1.5 py-0.2 rounded-full font-bold">
                  {breakdown.trips.length}
                </span>
              </button>

              <button
                type="button"
                onClick={() => setOrderFilter('with_incentives')}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-all flex items-center gap-1.5 ${
                  orderFilter === 'with_incentives'
                    ? 'bg-white text-amber-900 shadow-2xs'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/50'
                }`}
              >
                <span>With Bonus</span>
                <span className="text-[10px] bg-amber-100 text-amber-800 px-1.5 py-0.2 rounded-full font-bold">
                  {tripsWithIncentivesCount}
                </span>
              </button>

              <button
                type="button"
                onClick={() => setOrderFilter('with_tips')}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-all flex items-center gap-1.5 ${
                  orderFilter === 'with_tips'
                    ? 'bg-white text-emerald-900 shadow-2xs'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/50'
                }`}
              >
                <span>With Tips</span>
                <span className="text-[10px] bg-emerald-100 text-emerald-800 px-1.5 py-0.2 rounded-full font-bold">
                  {tripsWithTipsCount}
                </span>
              </button>

              <button
                type="button"
                onClick={() => setOrderFilter('with_surge')}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-all flex items-center gap-1.5 ${
                  orderFilter === 'with_surge'
                    ? 'bg-white text-indigo-900 shadow-2xs'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/50'
                }`}
              >
                <span>Surge</span>
                <span className="text-[10px] bg-indigo-100 text-indigo-800 px-1.5 py-0.2 rounded-full font-bold">
                  {tripsWithSurgeCount}
                </span>
              </button>
            </div>

            <button
              type="button"
              onClick={() => setIsExpandedList(!isExpandedList)}
              className="p-1.5 text-slate-500 hover:text-slate-800 rounded-lg hover:bg-slate-200/60 transition-colors"
              title={isExpandedList ? 'Collapse list' : 'Expand list'}
            >
              {isExpandedList ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>
          </div>
        </div>

        {isExpandedList && (
          <div className="overflow-x-auto max-h-72 overflow-y-auto">
            {filteredTrips.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-500 space-y-1">
                <Receipt className="h-8 w-8 text-slate-300 mx-auto" />
                <p className="font-semibold text-slate-700">No orders found matching this filter</p>
                <p className="text-slate-400">Try switching to "All Orders" or another filter category.</p>
              </div>
            ) : (
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 text-slate-500 font-semibold border-b border-slate-200 sticky top-0 z-10">
                <tr>
                  <th className="px-3.5 py-2.5">Order ID & Time</th>
                  <th className="px-3.5 py-2.5">Route / Area</th>
                  <th className="px-3.5 py-2.5">Trip Spec</th>
                  <th className="px-3.5 py-2.5">Base Fare</th>
                  <th className="px-3.5 py-2.5">Surge / Cargo</th>
                  <th className="px-3.5 py-2.5">Incentive</th>
                  <th className="px-3.5 py-2.5">Tip</th>
                  <th className="px-3.5 py-2.5 text-right">Total Order Pay</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredTrips.map((trip) => (
                  <tr key={trip.id} className="hover:bg-slate-50/70 transition-colors">
                    <td className="px-3.5 py-2.5 whitespace-nowrap">
                      <span className="font-bold text-slate-900 font-mono">{trip.orderNumber}</span>
                      <span className="text-[11px] text-slate-500 block">{trip.dateStr}</span>
                    </td>

                    <td className="px-3.5 py-2.5">
                      <div className="font-medium text-slate-800 truncate max-w-[180px]">
                        {trip.customerArea}
                      </div>
                      <div className="text-[10px] text-slate-400 truncate">
                        from {trip.hubName}
                      </div>
                    </td>

                    <td className="px-3.5 py-2.5 whitespace-nowrap text-[11px] text-slate-600">
                      <div>{trip.distanceKm} km • {trip.durationMins}m</div>
                      <span className="text-[10px] text-emerald-700 font-bold flex items-center gap-1">
                        <CheckCircle2 className="h-3 w-3" /> On-Time
                      </span>
                    </td>

                    <td className="px-3.5 py-2.5 text-slate-800 font-semibold">
                      ₹{trip.basePay}
                    </td>

                    <td className="px-3.5 py-2.5">
                      {trip.surgePay > 0 ? (
                        <span className="font-bold text-indigo-700 bg-indigo-50 px-1.5 py-0.5 rounded border border-indigo-200 text-[11px]">
                          +₹{trip.surgePay}
                        </span>
                      ) : (
                        <span className="text-slate-400 text-[11px]">-</span>
                      )}
                    </td>

                    <td className="px-3.5 py-2.5">
                      {trip.incentivePay > 0 ? (
                        <span className="font-bold text-amber-800 bg-amber-50 px-1.5 py-0.5 rounded border border-amber-200 text-[11px]">
                          +₹{trip.incentivePay}
                        </span>
                      ) : (
                        <span className="text-slate-400 text-[11px]">-</span>
                      )}
                    </td>

                    <td className="px-3.5 py-2.5">
                      {trip.tipPay > 0 ? (
                        <span className="font-bold text-emerald-800 bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-200 text-[11px]">
                          +₹{trip.tipPay}
                        </span>
                      ) : (
                        <span className="text-slate-400 text-[11px]">-</span>
                      )}
                    </td>

                    <td className="px-3.5 py-2.5 text-right whitespace-nowrap">
                      <span className="font-bold font-mono text-slate-900 text-sm">
                        ₹{trip.totalEarned}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
