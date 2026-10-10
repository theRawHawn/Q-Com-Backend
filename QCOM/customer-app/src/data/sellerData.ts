import { EVRider, Order, DarkStoreStats } from '../types';
import { INITIAL_PRODUCTS } from './products';

export const INITIAL_RIDERS: EVRider[] = [
  {
    id: 'rider-01',
    name: 'Anil Kumar',
    phone: '+91 98450 12891',
    vehicle: 'Bajaj Chetak EV (#EV-42)',
    batteryPercent: 88,
    status: 'in_transit',
    completedToday: 14,
    rating: 4.95,
    photo: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=200&auto=format&fit=crop&q=80',
  },
  {
    id: 'rider-02',
    name: 'Rajesh Varma',
    phone: '+91 98201 44520',
    vehicle: 'Ather 450X Pro (#EV-19)',
    batteryPercent: 74,
    status: 'idle_at_hub',
    completedToday: 11,
    rating: 4.91,
    photo: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=200&auto=format&fit=crop&q=80',
  },
  {
    id: 'rider-03',
    name: 'Deepak Sharma',
    phone: '+91 99881 77312',
    vehicle: 'TVS iQube Electric (#EV-08)',
    batteryPercent: 92,
    status: 'idle_at_hub',
    completedToday: 16,
    rating: 4.88,
    photo: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=200&auto=format&fit=crop&q=80',
  },
  {
    id: 'rider-04',
    name: 'Manoj Gowda',
    phone: '+91 97410 88231',
    vehicle: 'Ola S1 Pro (#EV-65)',
    batteryPercent: 65,
    status: 'picking_up',
    completedToday: 9,
    rating: 4.93,
    photo: 'https://images.unsplash.com/photo-1522075469751-3a6694fb2f61?w=200&auto=format&fit=crop&q=80',
  }
];

export const INITIAL_ORDERS: Order[] = [
  {
    id: 'BH-849201',
    items: [
      { product: INITIAL_PRODUCTS[0], quantity: 2 }, // Supreme Angle valve
      { product: INITIAL_PRODUCTS[1], quantity: 3 }, // Teflon tape
    ],
    subtotal: 505,
    deliveryFee: 0,
    urgencyFee: 5,
    tax: 91,
    total: 601,
    savingsVsLeavingSite: 350,
    timeSavedMinutes: 45,
    status: 'placed',
    placedAt: new Date(Date.now() - 2 * 60 * 1000), // 2 mins ago
    estimatedDeliveryAt: new Date(Date.now() + 10 * 60 * 1000),
    jobSite: {
      address: '14th Main, 4th Block, Koramangala, Bengaluru',
      landmark: 'Opposite BDA Complex',
      floorUnit: 'Tower B, 4th Floor, Flat 402',
      gateCode: 'MyGate #8841',
      siteContactName: 'Rajesh Mistri',
      sitePhone: '+91 98450 12891',
      tradeType: 'Plumber',
      jobTag: 'Prestige Greenwoods #402 - Bath Remodel',
      coordinates: { lat: 12.9352, lng: 77.6245 }
    },
    darkStore: {
      name: 'Express Dark Store #07 (Koramangala Hub)',
      code: 'DS-07',
      distanceKm: 1.2,
      pickerName: 'Ramesh (Bay Specialist)'
    },
    rider: {
      name: 'Anil Kumar',
      phone: '+91 98450 12891',
      vehicle: 'Bajaj Chetak EV (#EV-42)',
      rating: 4.95,
      photo: '',
      currentLocation: { lat: 12.9352, lng: 77.6245, distanceMeters: 1200 }
    },
    deliveryOtp: '4921',
    paymentMethod: 'Instant UPI',
    clientInvoiceNeeded: true,
    clientName: 'Prestige Greenwoods 402 Client'
  },
  {
    id: 'BH-719342',
    items: [
      { product: INITIAL_PRODUCTS[7], quantity: 2 }, // Havells MCB
      { product: INITIAL_PRODUCTS[8], quantity: 1 }, // Wago Connectors
      { product: INITIAL_PRODUCTS[9], quantity: 2 }, // Anchor Insulation tape
    ],
    subtotal: 640,
    deliveryFee: 0,
    urgencyFee: 5,
    tax: 115,
    total: 760,
    savingsVsLeavingSite: 400,
    timeSavedMinutes: 50,
    status: 'picking',
    placedAt: new Date(Date.now() - 5 * 60 * 1000), // 5 mins ago
    estimatedDeliveryAt: new Date(Date.now() + 7 * 60 * 1000),
    jobSite: {
      address: 'Indiranagar 100ft Road, Bengaluru',
      landmark: 'Near Metro Station',
      floorUnit: '2nd Floor, Commercial Unit #04',
      gateCode: 'Call Guard',
      siteContactName: 'Santosh Electricals',
      sitePhone: '+91 98201 55910',
      tradeType: 'Electrician',
      jobTag: 'Cafe Coffee Day Renovations',
      coordinates: { lat: 12.9716, lng: 77.6412 }
    },
    darkStore: {
      name: 'Express Dark Store #07 (Koramangala Hub)',
      code: 'DS-07',
      distanceKm: 1.8,
      pickerName: 'Suresh (Picker #02)'
    },
    rider: {
      name: 'Deepak Sharma',
      phone: '+91 99881 77312',
      vehicle: 'TVS iQube Electric (#EV-08)',
      rating: 4.88,
      photo: '',
      currentLocation: { lat: 12.9716, lng: 77.6412, distanceMeters: 1800 }
    },
    deliveryOtp: '8204',
    paymentMethod: 'Trade Credit (Net 30)',
    clientInvoiceNeeded: true
  }
];

export const INITIAL_STATS: DarkStoreStats = {
  todayGmv: 42850,
  totalOrders: 64,
  avgPickSeconds: 105, // 1m 45s
  avgDeliveryMinutes: 11.4,
  onTimePercent: 98.4,
};
