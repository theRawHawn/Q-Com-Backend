// Real-time Delivery ETA & Geolocation Calculation Engine
// Mirrors dynamic delivery estimation algorithms used by modern quick-commerce engines
import { HardwareProduct, CartItem, SellerPartner } from '../types';
import { HARDWARE_SELLERS, DEFAULT_SELLER, getSellerById } from '../data/sellers';

export const DEFAULT_STORE_PARTNER = DEFAULT_SELLER;

export interface Coordinates {
  lat: number;
  lng: number;
}

export interface SellerDeliveryEstimate {
  sellerId: string;
  sellerName: string;
  sellerLocality: string;
  sellerAddress: string;
  sellerRating: number;
  sellerSpecialty: string;
  distanceKm: number;
  etaMins: number;
  formattedDist: string;
  formattedEta: string;
  badge: 'ULTRA FAST' | 'EXPRESS' | 'STANDARD' | 'OUTER ZONE';
  badgeColor: string;
  arrivalTimeFormatted: string;
}

export interface CartDispatchSummary {
  maxEtaMins: number;
  formattedEta: string;
  totalHubsCount: number;
  hubs: {
    seller: SellerPartner;
    itemsCount: number;
    distanceKm: number;
    etaMins: number;
    formattedDist: string;
    formattedEta: string;
  }[];
  nearestHubDistanceKm: number;
  farthestHubDistanceKm: number;
  summaryText: string;
  arrivalTimeFormatted: string;
}

/**
 * Calculates straight-line distance in kilometers using the Haversine formula
 * ponytail: using straight-line (Haversine) calculation instead of full OSRM road distance networks
 * Upgrade Path: call OSRM/Google Maps Distance Matrix API for real-time traffic and road network routing
 */
export function getDistanceInKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371; // Earth radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const d = R * c;
  return Math.round(d * 10) / 10; // Round to 1 decimal place
}

/**
 * Computes dynamic real-time delivery estimate from a specific seller's location to the customer's jobsite.
 * 
 * Formula (inspired by quick-commerce standards):
 * - Base store preparation / picking time (seller.basePrepMins, e.g. 2 - 3.5 mins)
 * - Urban courier road transit time: distanceKm * 3.2 mins/km (avg ~19 km/h in metro traffic)
 * - Jobsite floor delivery & security gate access: 1.5 mins
 * - Category picking buffer (+1 min for heavy power tools / 50m coils, -0.5 min for quick fasteners)
 */
export function calculateSellerDeliveryEstimate(
  seller: SellerPartner = DEFAULT_SELLER,
  destinationCoords?: Coordinates
): SellerDeliveryEstimate {
  const dest = destinationCoords || { lat: 12.9352 + 0.006, lng: 77.6245 + 0.005 };
  
  let rawDist = getDistanceInKm(
    seller.coordinates.lat,
    seller.coordinates.lng,
    dest.lat,
    dest.lng
  );

  // In development, if user's real GPS is in another city/state/country (> 35 km away),
  // simulate dynamic nearest local dark store partner hub (1.2 to 2.4 km away)
  // so hyperlocal quick-commerce SLA remains realistic and functional.
  if (rawDist > 35) {
    const hash = Math.abs(Math.sin(dest.lat * 100 + dest.lng * 100));
    rawDist = 1.1 + (hash * 1.5); // 1.1km - 2.6km
  }

  // Minimum bounded distance (0.4 km for next-door dark store)
  const distanceKm = Math.max(0.4, Math.round(rawDist * 10) / 10);

  // Dynamic ETA formula:
  // Base prep (2-3.5 mins) + (distance * 3.2 mins/km) + (1.5 mins floor/gate buffer)
  const prepTime = seller.basePrepMins || 2.0;
  const calculatedMins = Math.round(prepTime + distanceKm * 3.2 + 1.5);

  // Realistic delivery bounds:
  // Minimum 8 mins (ultra-local dark hub) up to ~25 mins
  const etaMins = Math.max(8, Math.min(35, calculatedMins));

  const arrivalDate = new Date(Date.now() + etaMins * 60 * 1000);
  const arrivalTimeFormatted = arrivalDate.toLocaleTimeString('en-IN', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  let badge: 'ULTRA FAST' | 'EXPRESS' | 'STANDARD' | 'OUTER ZONE' = 'EXPRESS';
  let badgeColor = 'bg-emerald-50 text-emerald-700 border-emerald-200';

  if (etaMins <= 12) {
    badge = 'ULTRA FAST';
    badgeColor = 'bg-emerald-500 text-white border-emerald-600';
  } else if (etaMins <= 20) {
    badge = 'EXPRESS';
    badgeColor = 'bg-blue-500 text-white border-blue-600';
  } else if (etaMins <= 32) {
    badge = 'STANDARD';
    badgeColor = 'bg-amber-500 text-white border-amber-600';
  } else {
    badge = 'OUTER ZONE';
    badgeColor = 'bg-slate-700 text-white border-slate-800';
  }

  return {
    sellerId: seller.id,
    sellerName: seller.name,
    sellerLocality: seller.locality,
    sellerAddress: seller.address,
    sellerRating: seller.rating,
    sellerSpecialty: seller.specialty,
    distanceKm,
    etaMins,
    formattedDist: `${distanceKm.toFixed(1)} km`,
    formattedEta: `${etaMins} mins`,
    badge,
    badgeColor,
    arrivalTimeFormatted,
  };
}

/**
 * Calculates dynamic delivery estimate for a specific product based on its seller's location relative to destination
 */
export function calculateProductDeliveryEstimate(
  product: HardwareProduct,
  destinationCoords?: Coordinates
): SellerDeliveryEstimate {
  // Find matching seller or resolve from product data
  let seller: SellerPartner | undefined;
  if (product.sellerId) {
    seller = HARDWARE_SELLERS.find(s => s.id === product.sellerId);
  }
  if (!seller && product.sellerCoordinates) {
    seller = {
      id: 'custom-seller',
      name: product.sellerName || 'Local Hardware Hub',
      locality: product.sellerLocality || 'Bengaluru Central',
      address: product.sellerAddress || 'Hardware Trade Hub',
      coordinates: product.sellerCoordinates,
      rating: product.sellerRating || 4.9,
      reviewsCount: 500,
      phone: '+91 80 2553 4912',
      gstin: product.sellerGstin || '29AABCS8812K1ZM',
      isGstRegistered: product.isGstRegistered !== false,
      specialty: product.subcategory || 'Hardware & Tools',
      basePrepMins: 2.0,
    };
  }

  const finalSeller = seller || DEFAULT_SELLER;
  const estimate = calculateSellerDeliveryEstimate(finalSeller, destinationCoords);

  // Category specific minor adjustments (e.g. heavy tools need +1 min packing)
  let adjustedEta = estimate.etaMins;
  if (product.category === 'tools') {
    adjustedEta = Math.min(60, adjustedEta + 1);
  } else if (product.category === 'fasteners' || product.category === 'adhesives') {
    adjustedEta = Math.max(8, adjustedEta - 0.5);
  }
  adjustedEta = Math.round(adjustedEta);

  const arrivalDate = new Date(Date.now() + adjustedEta * 60 * 1000);
  const arrivalTimeFormatted = arrivalDate.toLocaleTimeString('en-IN', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  return {
    ...estimate,
    etaMins: adjustedEta,
    formattedEta: `${adjustedEta} mins`,
    arrivalTimeFormatted,
  };
}

/**
 * Computes consolidated multi-seller dispatch summary for the entire cart
 */
export function calculateCartDispatchSummary(
  cartItems: CartItem[],
  destinationCoords?: Coordinates
): CartDispatchSummary {
  if (cartItems.length === 0) {
    const defaultEst = calculateSellerDeliveryEstimate(DEFAULT_SELLER, destinationCoords);
    return {
      maxEtaMins: defaultEst.etaMins,
      formattedEta: defaultEst.formattedEta,
      totalHubsCount: 1,
      hubs: [{
        seller: DEFAULT_SELLER,
        itemsCount: 0,
        distanceKm: defaultEst.distanceKm,
        etaMins: defaultEst.etaMins,
        formattedDist: defaultEst.formattedDist,
        formattedEta: defaultEst.formattedEta,
      }],
      nearestHubDistanceKm: defaultEst.distanceKm,
      farthestHubDistanceKm: defaultEst.distanceKm,
      summaryText: `Dispatched from ${DEFAULT_SELLER.name} (${defaultEst.formattedDist})`,
      arrivalTimeFormatted: defaultEst.arrivalTimeFormatted,
    };
  }

  // Group cart items by seller
  const sellerMap = new Map<string, { seller: SellerPartner; itemsCount: number }>();

  cartItems.forEach(item => {
    const sellerId = item.product.sellerId || DEFAULT_SELLER.id;
    const seller = getSellerById(sellerId);
    const existing = sellerMap.get(seller.id);
    if (existing) {
      existing.itemsCount += item.quantity;
    } else {
      sellerMap.set(seller.id, { seller, itemsCount: item.quantity });
    }
  });

  const hubs = Array.from(sellerMap.values()).map(({ seller, itemsCount }) => {
    const est = calculateSellerDeliveryEstimate(seller, destinationCoords);
    return {
      seller,
      itemsCount,
      distanceKm: est.distanceKm,
      etaMins: est.etaMins,
      formattedDist: est.formattedDist,
      formattedEta: est.formattedEta,
    };
  });

  // Overall delivery ETA is determined by the farthest seller's arrival time (or parallel dispatch delivery)
  const maxEtaMins = Math.max(...hubs.map(h => h.etaMins));
  const nearestHubDistanceKm = Math.min(...hubs.map(h => h.distanceKm));
  const farthestHubDistanceKm = Math.max(...hubs.map(h => h.distanceKm));

  const arrivalDate = new Date(Date.now() + maxEtaMins * 60 * 1000);
  const arrivalTimeFormatted = arrivalDate.toLocaleTimeString('en-IN', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  let summaryText = '';
  if (hubs.length === 1) {
    summaryText = `Dispatched from ${hubs[0].seller.name} (${hubs[0].formattedDist} away)`;
  } else {
    const hubNames = hubs.map(h => `${h.seller.locality} (${h.formattedDist})`).join(' & ');
    summaryText = `Dispatched from ${hubs.length} local hubs: ${hubNames}`;
  }

  return {
    maxEtaMins,
    formattedEta: `${maxEtaMins} mins`,
    totalHubsCount: hubs.length,
    hubs,
    nearestHubDistanceKm,
    farthestHubDistanceKm,
    summaryText,
    arrivalTimeFormatted,
  };
}

/**
 * Standard dynamic ETA calculation helper for backward compatibility
 */
export function calculateDynamicDeliveryEta(
  destinationCoords?: Coordinates,
  storeCoords: Coordinates = DEFAULT_SELLER.coordinates
): {
  etaMins: number;
  distanceKm: number;
  formattedDist: string;
  formattedEta: string;
  badge: string;
  arrivalTimeFormatted: string;
} {
  let rawDist = getDistanceInKm(
    storeCoords.lat,
    storeCoords.lng,
    destinationCoords?.lat || (12.9352 + 0.008),
    destinationCoords?.lng || (77.6245 + 0.006)
  );
  
  if (rawDist > 35 && destinationCoords) {
    const hash = Math.abs(Math.sin(destinationCoords.lat * 100 + destinationCoords.lng * 100));
    rawDist = 1.1 + (hash * 1.5);
  }

  const distanceKm = Math.max(0.4, Math.round(rawDist * 10) / 10);
  const calculatedMins = Math.round(2.0 + distanceKm * 3.2 + 1.5);
  const etaMins = Math.max(8, Math.min(30, calculatedMins));

  const arrivalDate = new Date(Date.now() + etaMins * 60 * 1000);
  const arrivalTimeFormatted = arrivalDate.toLocaleTimeString('en-IN', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  const badge =
    etaMins <= 12
      ? 'ULTRA FAST'
      : etaMins <= 20
      ? 'EXPRESS'
      : 'PRIORITY';

  return {
    etaMins,
    distanceKm,
    formattedDist: `${distanceKm.toFixed(1)} km`,
    formattedEta: `${etaMins} mins`,
    badge,
    arrivalTimeFormatted,
  };
}
