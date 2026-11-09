import React, { useState } from 'react';
import { 
  AppMode, 
  SellerTab, 
  Order, 
  OrderStatus, 
  HardwareProduct, 
  EVRider, 
  DarkStoreStats 
} from '../../types';
import { SellerHeader } from './SellerHeader';
import { LiveOrderQueue } from './LiveOrderQueue';
import { InventoryManager } from './InventoryManager';
import { FleetManager } from './FleetManager';
import { SellerAnalytics } from './SellerAnalytics';
import { PlatformSettings } from './PlatformSettings';
import { AddProductModal } from './AddProductModal';

interface SellerDashboardProps {
  orders: Order[];
  onUpdateOrderStatus: (orderId: string, newStatus: OrderStatus) => void;
  products: HardwareProduct[];
  onUpdateStock: (productId: string, newStock: number) => void;
  onUpdatePrice: (productId: string, newPrice: number) => void;
  onUpdateGstRate?: (productId: string, newGstRate: number) => void;
  onAddProduct: (product: HardwareProduct) => void;
  riders: EVRider[];
  onAssignRider: (orderId: string, riderId: string) => void;
  onSwitchToCustomer: () => void;
  onSimulateOrder: () => void;
  stats: DarkStoreStats;
}

export const SellerDashboard: React.FC<SellerDashboardProps> = ({
  orders,
  onUpdateOrderStatus,
  products,
  onUpdateStock,
  onUpdatePrice,
  onUpdateGstRate,
  onAddProduct,
  riders,
  onAssignRider,
  onSwitchToCustomer,
  onSimulateOrder,
  stats,
}) => {
  const [activeTab, setActiveTab] = useState<SellerTab>('orders');
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);

  const pendingOrdersCount = orders.filter(o => o.status === 'placed' || o.status === 'picking').length;

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900 pb-16">
      
      {/* Top Header */}
      <SellerHeader
        activeTab={activeTab}
        onTabChange={setActiveTab}
        onSwitchToCustomer={onSwitchToCustomer}
        pendingOrdersCount={pendingOrdersCount}
        onSimulateOrder={onSimulateOrder}
        soundEnabled={soundEnabled}
        onToggleSound={() => setSoundEnabled(!soundEnabled)}
        onOpenAddProduct={() => setIsAddModalOpen(true)}
      />

      {/* Main Content Area */}
      <main className="max-w-7xl mx-auto px-4 py-6">
        {activeTab === 'orders' && (
          <LiveOrderQueue
            orders={orders}
            onUpdateOrderStatus={onUpdateOrderStatus}
            riders={riders}
            onAssignRider={onAssignRider}
            onSimulateOrder={onSimulateOrder}
          />
        )}

        {activeTab === 'inventory' && (
          <InventoryManager
            products={products}
            onUpdateStock={onUpdateStock}
            onUpdatePrice={onUpdatePrice}
            onUpdateGstRate={onUpdateGstRate}
            onOpenAddModal={() => setIsAddModalOpen(true)}
          />
        )}

        {activeTab === 'fleet' && (
          <FleetManager riders={riders} />
        )}

        {activeTab === 'analytics' && (
          <SellerAnalytics stats={stats} products={products} />
        )}

        {activeTab === 'settings' && (
          <PlatformSettings />
        )}
      </main>

      {/* Add SKU Modal */}
      <AddProductModal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
        onAddProduct={onAddProduct}
      />

    </div>
  );
};
