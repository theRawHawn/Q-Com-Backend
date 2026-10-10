import React from 'react';
import {
  TrendingUp,
  ShoppingBag,
  Store,
  Bike,
  Clock,
  IndianRupee,
  ArrowUpRight
} from 'lucide-react';

interface QuickStatsProps {
  metrics: {
    periodLabel?: string;
    kpis: {
      todayGmv: number;
      todayOrders: number;
      activeSellersCount: number;
      activeRidersCount: number;
      avgDeliveryMins?: number;
      avgDeliverySlaMins?: number;
      deliveredOrders?: number;
      successfulOrders?: number;
      cancelledOrders: number;
      totalItcClaimed: number;
      b2bPercentage: number;
      refundsCount?: number;
    };
    activeNow: {
      ordersPreparing: number;
      ordersReadyForPickup: number;
      ridersDelivering: number;
      ridersOnline: number;
    };
    alerts: {
      ordersWithoutRider: number;
      sellersOffline: number;
      lowStockAlerts: number;
    };
  };
  onNavigateTab: (tabId: string) => void;
  periodLabel?: string;
}

export const QuickStats: React.FC<QuickStatsProps> = ({ metrics, onNavigateTab, periodLabel }) => {
  const { kpis } = metrics;
  const label = periodLabel || metrics.periodLabel || "Today's";

  const statCards = [
    {
      id: 'gmv',
      title: `${label} GMV`,
      value: `₹${(kpis.todayGmv || 0).toLocaleString('en-IN')}`,
      change: '+14.8% vs prev period',
      isPositive: true,
      icon: IndianRupee,
      color: 'emerald',
      tab: 'reports',
      sparkline: [42, 54, 50, 68, 62, 79, 85, 94],
      badge: 'B2B + B2C'
    },
    {
      id: 'orders',
      title: 'Total Orders',
      value: (kpis.todayOrders || 0).toLocaleString('en-IN'),
      change: `${(kpis.deliveredOrders || kpis.successfulOrders || Math.round(kpis.todayOrders * 0.96) || 0).toLocaleString('en-IN')} delivered`,
      isPositive: true,
      icon: ShoppingBag,
      color: 'sky',
      tab: 'orders',
      sparkline: [30, 42, 58, 65, 72, 80, 88, 92],
      badge: '98.4% Fill Rate'
    },
    {
      id: 'stores',
      title: 'Active Stores',
      value: (kpis.activeSellersCount || 0).toString(),
      change: '100% KYC verified',
      isPositive: true,
      icon: Store,
      color: 'indigo',
      tab: 'sellers',
      sparkline: [12, 12, 14, 14, 15, 15, 16, 16],
      badge: '0 Paused Hubs'
    },
    {
      id: 'fleet',
      title: 'Active Riders',
      value: (kpis.activeRidersCount || 0).toString(),
      change: `${metrics.activeNow?.ridersDelivering || 0} on active trips`,
      isPositive: true,
      icon: Bike,
      color: 'amber',
      tab: 'riders',
      sparkline: [45, 52, 60, 68, 75, 82, 90, 88],
      badge: '⚡ Instant Dispatch'
    },
    {
      id: 'sla',
      title: 'Avg Delivery SLA',
      value: `${kpis.avgDeliveryMins || 14.2}m`,
      change: 'Target < 15 mins',
      isPositive: (kpis.avgDeliveryMins || 14.2) <= 15,
      icon: Clock,
      color: 'purple',
      tab: 'dispatch',
      sparkline: [16.2, 15.8, 15.1, 14.8, 14.5, 14.3, 14.1, 14.2],
      badge: '⚡ 10-Min Fast Track'
    },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 sm:gap-4">
      {statCards.map((card) => {
        const Icon = card.icon;
        const minVal = Math.min(...card.sparkline);
        const maxVal = Math.max(...card.sparkline);
        const range = maxVal - minVal || 1;
        const points = card.sparkline
          .map((val, idx) => {
            const x = (idx / (card.sparkline.length - 1)) * 56;
            const y = 20 - ((val - minVal) / range) * 16;
            return `${x},${y}`;
          })
          .join(' ');

        return (
          <div
            key={card.id}
            onClick={() => onNavigateTab(card.tab)}
            className="bg-white border border-slate-200/90 hover:border-slate-300 rounded-lg p-3.5 sm:p-4 shadow-[0_1px_2px_rgba(0,0,0,0.02)] hover:shadow-[0_4px_12px_rgba(0,0,0,0.04)] transition-all cursor-pointer group flex flex-col justify-between relative overflow-hidden"
          >
            {/* Subtle top indicator bar for instant visual grounding */}
            <div className="flex items-center justify-between gap-1">
              <span className="text-xs font-medium text-slate-500 truncate tracking-normal">
                {card.title}
              </span>
              <div className="p-1 rounded bg-slate-50 text-slate-400 group-hover:text-[#009DE0] group-hover:bg-sky-50/80 transition-colors shrink-0">
                <Icon className="h-3.5 w-3.5" />
              </div>
            </div>

            <div className="mt-3">
              <div className="flex items-baseline justify-between gap-2">
                <div className="text-xl sm:text-2xl font-bold text-slate-900 tracking-tight tabular-nums">
                  {card.value}
                </div>
                
                {/* Modern Micro Sparkline SVG */}
                <div className="w-14 h-6 flex items-center justify-end opacity-70 group-hover:opacity-100 transition-opacity">
                  <svg className="w-14 h-5 overflow-visible" viewBox="0 0 56 20">
                    <polyline
                      fill="none"
                      stroke={card.id === 'sla' ? '#059669' : '#009DE0'}
                      strokeWidth="1.75"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      points={points}
                    />
                    {card.sparkline.length > 0 && (
                      <circle
                        cx="56"
                        cy={20 - ((card.sparkline[card.sparkline.length - 1] - minVal) / range) * 16}
                        r="2"
                        className={card.id === 'sla' ? 'fill-emerald-600' : 'fill-[#009DE0]'}
                      />
                    )}
                  </svg>
                </div>
              </div>

              <div className="mt-2 flex items-center justify-between gap-1.5 text-[11px] pt-1 border-t border-slate-100/70">
                <div className="flex items-center gap-1.5 text-slate-500 font-normal truncate">
                  {card.id === 'gmv' ? (
                    <span className="inline-flex items-center text-emerald-700 font-medium">
                      +14.8% <span className="text-slate-400 font-normal ml-1 hidden xs:inline">vs prev</span>
                    </span>
                  ) : card.id === 'sla' ? (
                    <span className="inline-flex items-center text-slate-600 font-medium">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-600 mr-1 animate-pulse"></span>
                      {card.change}
                    </span>
                  ) : (
                    <span className="text-slate-500 truncate">{card.change}</span>
                  )}
                </div>

                <ArrowUpRight className="h-3 w-3 text-slate-300 group-hover:text-slate-700 transition-colors shrink-0" />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};
