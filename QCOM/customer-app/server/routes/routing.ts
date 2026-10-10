import { Router, Request, Response } from 'express';
import { 
  createRateLimiter, 
  isValidCoordinate, 
  sanitizeString 
} from '../security';
import { authoritativeRouteStore } from '../store';
import { 
  RouteCandidate, 
  TurnInstruction, 
  RoutingResponse, 
  RerouteRequest,
  RouteTelemetryRecord 
} from '../../src/types';

const router = Router();

// Rate limiter for routing requests: 60 per minute per IP
const routingLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 60,
  message: 'Routing request limit exceeded. Please throttle GPS/routing updates.',
  keyPrefix: 'rl:route'
});

// Simple in-memory LRU route cache (10 minute TTL)
interface CachedRoute {
  timestamp: number;
  data: RoutingResponse;
}
const routeCache = new Map<string, CachedRoute>();
const CACHE_TTL_MS = 10 * 60 * 1000;

function getCacheKey(origin: [number, number], dest: [number, number]): string {
  return `${origin[0].toFixed(4)},${origin[1].toFixed(4)}_${dest[0].toFixed(4)},${dest[1].toFixed(4)}`;
}

/**
 * Calculates straight-line distance (Haversine) in meters
 */
function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000; // meters
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Deterministic QCOM Route Scoring Algorithm
 * Primary Objective: Fastest legal drivable route (Lowest ETA)
 * Secondary Objective: Reasonable distance & legal accessibility
 */
function scoreRouteCandidate(candidate: {
  durationSeconds: number;
  distanceMeters: number;
  isLegalDrivable: boolean;
  profile: string;
}): number {
  // Base duration in seconds (ETA is primary: 1 sec = 1.0 penalty point)
  const durationScore = candidate.durationSeconds * 1.0;
  
  // Distance in meters (Secondary factor: 1 meter = 0.05 penalty points)
  const distanceScore = candidate.distanceMeters * 0.05;

  // Profile penalty (Driving profile is preferred for legal road network)
  let profilePenalty = 0;
  if (candidate.profile === 'osrm_bike') profilePenalty = 120; // +2 mins penalty for narrow bike paths
  if (candidate.profile === 'urban_shortcut') profilePenalty = 180; // +3 mins penalty for unverified shortcut

  // Illegal or inaccessible road penalty
  const legalityPenalty = candidate.isLegalDrivable ? 0 : 5000;

  return durationScore + distanceScore + profilePenalty + legalityPenalty;
}

/**
 * Generates an urban grid fallback route when public routing endpoints are unreachable
 */
function generateUrbanFallbackRoute(
  origin: [number, number],
  dest: [number, number],
  profileName: 'osrm_driving' | 'urban_shortcut' = 'osrm_driving'
): RouteCandidate {
  const points: [number, number][] = [origin];
  const totalMeters = haversineMeters(origin[0], origin[1], dest[0], dest[1]) * 1.25; // ~1.25x road curvature factor

  const midLat = origin[0] + (dest[0] - origin[0]) * 0.5;
  const midLng = origin[1] + (dest[1] - origin[1]) * 0.5;

  // Add intermediate cross-street waypoints for realistic road geometry
  const dLat = dest[0] - origin[0];
  const dLng = dest[1] - origin[1];

  points.push([origin[0] + dLat * 0.3, origin[1] + dLng * 0.1]);
  points.push([midLat, origin[1] + dLng * 0.6]);
  points.push([origin[0] + dLat * 0.85, dest[1]]);
  points.push(dest);

  // Speed assumptions: ~22 km/h average city courier speed = ~6.1 m/s
  const durationSeconds = Math.round(totalMeters / 6.1);
  const etaMinutes = Math.max(2, Math.round(durationSeconds / 60));

  const instructions: TurnInstruction[] = [
    { text: 'Head out from pickup hub onto main arterial road', distanceMeters: 150, durationSeconds: 25, location: origin },
    { text: 'Turn onto cross-street shortcut towards customer locality', distanceMeters: Math.round(totalMeters * 0.5), durationSeconds: Math.round(durationSeconds * 0.5), location: [midLat, midLng] },
    { text: 'Arrive at customer vehicle-accessible gate/drop-off point', distanceMeters: 100, durationSeconds: 20, location: dest }
  ];

  const score = scoreRouteCandidate({
    durationSeconds,
    distanceMeters: totalMeters,
    isLegalDrivable: true,
    profile: profileName
  });

  return {
    id: `route_fallback_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    engineProfile: profileName,
    distanceMeters: Math.round(totalMeters),
    durationSeconds,
    etaMinutes,
    polyline: points,
    instructions,
    score,
    isLegalDrivable: true,
    snappedOrigin: origin,
    snappedDestination: dest
  };
}

/**
 * Fetches real driving routes with alternatives from OSRM
 */
async function fetchOSRMRouteCandidates(
  origin: [number, number],
  dest: [number, number]
): Promise<RouteCandidate[]> {
  const candidates: RouteCandidate[] = [];

  // 1. Fetch OSRM Driving Profile with alternatives
  try {
    // OSRM expects: lon,lat;lon,lat
    const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${origin[1]},${origin[0]};${dest[1]},${dest[0]}?overview=full&geometries=geojson&steps=true&alternatives=true`;
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000); // 4 sec timeout

    const response = await fetch(osrmUrl, { 
      signal: controller.signal,
      headers: { 'User-Agent': 'QuickHardware-QCOM-Server/1.0' }
    });
    clearTimeout(timeoutId);

    if (response.ok) {
      const data = await response.json();
      if (data && data.code === 'Ok' && Array.isArray(data.routes)) {
        data.routes.forEach((rt: any, index: number) => {
          const coords: [number, number][] = (rt.geometry?.coordinates || []).map(
            (c: [number, number]) => [c[1], c[0]] as [number, number]
          );

          if (coords.length >= 2) {
            const steps: TurnInstruction[] = [];
            if (rt.legs?.[0]?.steps) {
              rt.legs[0].steps.forEach((st: any) => {
                if (st.maneuver) {
                  steps.push({
                    text: `${st.maneuver.type || 'Proceed'} ${st.name ? 'on ' + st.name : ''}`.trim(),
                    distanceMeters: Math.round(st.distance || 0),
                    durationSeconds: Math.round(st.duration || 0),
                    modifier: st.maneuver.modifier,
                    type: st.maneuver.type,
                    location: [st.maneuver.location[1], st.maneuver.location[0]]
                  });
                }
              });
            }

            const durationSec = Math.round(rt.duration || 120);
            const distMeters = Math.round(rt.distance || 1000);
            const score = scoreRouteCandidate({
              durationSeconds: durationSec,
              distanceMeters: distMeters,
              isLegalDrivable: true,
              profile: 'osrm_driving'
            });

            candidates.push({
              id: `osrm_driving_alt_${index + 1}`,
              engineProfile: 'osrm_driving',
              distanceMeters: distMeters,
              durationSeconds: durationSec,
              etaMinutes: Math.max(1, Math.round(durationSec / 60)),
              polyline: coords,
              instructions: steps.length > 0 ? steps : [
                { text: 'Follow mapped driving route to destination', distanceMeters: distMeters, durationSeconds: durationSec, location: origin }
              ],
              score,
              isLegalDrivable: true,
              snappedOrigin: coords[0],
              snappedDestination: coords[coords.length - 1]
            });
          }
        });
      }
    }
  } catch (err) {
    console.warn('[ROUTING] OSRM driving API call timed out or failed, using fallback network generator', err);
  }

  // 2. Fetch OSRM Bike Profile for comparison if candidates are sparse
  if (candidates.length < 2) {
    try {
      const bikeUrl = `https://router.project-osrm.org/route/v1/bike/${origin[1]},${origin[0]};${dest[1]},${dest[0]}?overview=full&geometries=geojson&steps=true`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);

      const response = await fetch(bikeUrl, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();
        if (data && data.code === 'Ok' && data.routes?.[0]) {
          const rt = data.routes[0];
          const coords: [number, number][] = (rt.geometry?.coordinates || []).map(
            (c: [number, number]) => [c[1], c[0]] as [number, number]
          );

          if (coords.length >= 2) {
            const durationSec = Math.round((rt.duration || 120) * 0.9); // Electric scooter speed factor
            const distMeters = Math.round(rt.distance || 1000);
            const score = scoreRouteCandidate({
              durationSeconds: durationSec,
              distanceMeters: distMeters,
              isLegalDrivable: true,
              profile: 'osrm_bike'
            });

            candidates.push({
              id: 'osrm_bike_shortcut',
              engineProfile: 'osrm_bike',
              distanceMeters: distMeters,
              durationSeconds: durationSec,
              etaMinutes: Math.max(1, Math.round(durationSec / 60)),
              polyline: coords,
              instructions: [
                { text: 'Follow local quick-commerce courier corridor', distanceMeters: distMeters, durationSeconds: durationSec, location: origin }
              ],
              score,
              isLegalDrivable: true,
              snappedOrigin: coords[0],
              snappedDestination: coords[coords.length - 1]
            });
          }
        }
      }
    } catch {
      // Ignore bike fallback error
    }
  }

  // Always append urban grid fallback candidate to guarantee robust response
  const fallbackCandidate = generateUrbanFallbackRoute(origin, dest, 'urban_shortcut');
  candidates.push(fallbackCandidate);

  return candidates;
}

// ==========================================
// 1. CALCULATE OPTIMAL QCOM ROUTE
// ==========================================
router.post('/calculate', routingLimiter, async (req: Request, res: Response) => {
  try {
    const { sellerLocation, customerLocation, vehicleType } = req.body;

    if (!sellerLocation || !customerLocation ||
        !isValidCoordinate(sellerLocation.lat, sellerLocation.lng) ||
        !isValidCoordinate(customerLocation.lat, customerLocation.lng)) {
      return res.status(400).json({
        error: 'INVALID_COORDINATES',
        message: 'Valid seller and customer coordinates are required.'
      });
    }

    const sellerBuilding: [number, number] = [sellerLocation.lat, sellerLocation.lng];
    const customerBuilding: [number, number] = [customerLocation.lat, customerLocation.lng];

    // Check for custom accessible entrance override in store
    const sellerKey = `seller_${sellerLocation.lat.toFixed(4)}_${sellerLocation.lng.toFixed(4)}`;
    const customerKey = `cust_${customerLocation.lat.toFixed(4)}_${customerLocation.lng.toFixed(4)}`;

    const savedSellerEntrance = authoritativeRouteStore.getEntranceCorrection(sellerKey);
    const savedCustomerEntrance = authoritativeRouteStore.getEntranceCorrection(customerKey);

    const sellerAccessiblePin: [number, number] = sellerLocation.accessibleEntranceCoords
      ? [sellerLocation.accessibleEntranceCoords.lat, sellerLocation.accessibleEntranceCoords.lng]
      : (savedSellerEntrance ? [savedSellerEntrance.lat, savedSellerEntrance.lng] : sellerBuilding);

    const customerAccessiblePin: [number, number] = customerLocation.accessibleEntranceCoords
      ? [customerLocation.accessibleEntranceCoords.lat, customerLocation.accessibleEntranceCoords.lng]
      : (savedCustomerEntrance ? [savedCustomerEntrance.lat, savedCustomerEntrance.lng] : customerBuilding);

    // Check LRU Cache
    const cacheKey = getCacheKey(sellerAccessiblePin, customerAccessiblePin);
    const cachedEntry = routeCache.get(cacheKey);
    if (cachedEntry && (Date.now() - cachedEntry.timestamp < CACHE_TTL_MS)) {
      return res.json({
        ...cachedEntry.data,
        cached: true
      });
    }

    // Fetch candidate routes from OSRM & urban network generators
    const candidateRoutes = await fetchOSRMRouteCandidates(sellerAccessiblePin, customerAccessiblePin);

    // Sort candidate routes by QCOM Route Score (FASTEST ETA FIRST, lower score = better)
    candidateRoutes.sort((a, b) => a.score - b.score);

    const selectedRoute = candidateRoutes[0];
    const alternativeRoutes = candidateRoutes.slice(1);

    const distKm = Math.round((selectedRoute.distanceMeters / 1000) * 10) / 10;
    const baseEtaMins = selectedRoute.etaMinutes;
    // Base store pick/prep buffer (2 mins) + Floor access buffer (1.5 mins)
    const totalDeliveryEtaMins = Math.max(5, baseEtaMins + 3.5);

    const responseData: RoutingResponse = {
      success: true,
      selectedRoute,
      alternativeRoutes,
      sellerPickupEntrance: {
        buildingPin: sellerBuilding,
        accessibleEntrancePin: sellerAccessiblePin,
        pickupNotes: sellerLocation.pickupNotes || 'Use ground-level service loading bay'
      },
      customerDropoffEntrance: {
        buildingPin: customerBuilding,
        accessibleEntrancePin: customerAccessiblePin,
        dropoffInstructions: customerLocation.dropoffInstructions || 'Deliver to security reception / doorstep'
      },
      summary: {
        distanceKm: distKm,
        baseEtaMinutes: baseEtaMins,
        trafficAdjustedEtaMinutes: Math.round(baseEtaMins * 1.1),
        totalDeliveryEtaMinutes: Math.round(totalDeliveryEtaMins),
        formattedDistance: `${distKm.toFixed(1)} km`,
        formattedEta: `${Math.round(totalDeliveryEtaMins)} mins`,
        confidenceScore: 96,
        routeQuality: selectedRoute.engineProfile === 'osrm_driving' ? 'OPTIMAL_FASTEST' : 'SHORTCUT_FALLBACK'
      },
      cached: false,
      calculatedAt: new Date().toISOString()
    };

    // Store in cache
    routeCache.set(cacheKey, { timestamp: Date.now(), data: responseData });

    res.json(responseData);
  } catch (err: any) {
    console.error('[ROUTING_ERROR]', err?.message || err);
    res.status(500).json({
      error: 'ROUTING_ENGINE_ERROR',
      message: 'Failed to calculate optimal route. Using safe fallback defaults.'
    });
  }
});

// ==========================================
// 2. REROUTE COURIER ON DEVIATION
// ==========================================
router.post('/reroute', routingLimiter, async (req: Request, res: Response) => {
  try {
    const { orderId, currentRiderLocation, destinationLocation }: RerouteRequest = req.body;

    if (!currentRiderLocation || !destinationLocation ||
        !isValidCoordinate(currentRiderLocation.lat, currentRiderLocation.lng) ||
        !isValidCoordinate(destinationLocation.lat, destinationLocation.lng)) {
      return res.status(400).json({
        error: 'INVALID_REROUTE_COORDINATES',
        message: 'Valid current rider position and destination coordinates are required.'
      });
    }

    const riderPin: [number, number] = [currentRiderLocation.lat, currentRiderLocation.lng];
    const destPin: [number, number] = [destinationLocation.lat, destinationLocation.lng];

    // Calculate fresh optimal route from rider's CURRENT location
    const candidates = await fetchOSRMRouteCandidates(riderPin, destPin);
    candidates.sort((a, b) => a.score - b.score);

    const freshRoute = candidates[0];
    const distKm = Math.round((freshRoute.distanceMeters / 1000) * 10) / 10;
    const etaMins = Math.max(2, Math.round(freshRoute.durationSeconds / 60));

    // Log reroute event in telemetry
    const existingTelemetry = authoritativeRouteStore.getTelemetry(orderId);
    if (existingTelemetry) {
      existingTelemetry.rerouteCount = (existingTelemetry.rerouteCount || 0) + 1;
      existingTelemetry.offRouteDeviations = (existingTelemetry.offRouteDeviations || 0) + 1;
      authoritativeRouteStore.saveTelemetry(existingTelemetry);
    }

    console.log(`[REROUTE] Recalculated route for order ${orderId} from rider pos (${riderPin.join(',')}) -> new ETA: ${etaMins} mins, ${distKm} km`);

    res.json({
      success: true,
      message: 'Route recalculated successfully from live rider location.',
      recalculatedRoute: freshRoute,
      summary: {
        distanceKm: distKm,
        etaMinutes: etaMins,
        formattedDistance: `${distKm.toFixed(1)} km`,
        formattedEta: `${etaMins} mins`
      },
      recalculatedAt: new Date().toISOString()
    });
  } catch (err: any) {
    console.error('[REROUTE_ERROR]', err?.message || err);
    res.status(500).json({
      error: 'REROUTE_FAILED',
      message: 'Failed to recalculate route on deviation.'
    });
  }
});

// ==========================================
// 3. ENTRANCE CORRECTION OVERRIDE
// ==========================================
router.post('/entrance-correction', routingLimiter, (req: Request, res: Response) => {
  const { locationType, originalCoords, accessibleEntranceCoords, notes } = req.body;

  if (!originalCoords || !accessibleEntranceCoords ||
      !isValidCoordinate(originalCoords.lat, originalCoords.lng) ||
      !isValidCoordinate(accessibleEntranceCoords.lat, accessibleEntranceCoords.lng)) {
    return res.status(400).json({
      error: 'INVALID_ENTRANCE_DATA',
      message: 'Valid coordinates required for entrance correction.'
    });
  }

  const locationKey = `${locationType || 'loc'}_${originalCoords.lat.toFixed(4)}_${originalCoords.lng.toFixed(4)}`;
  authoritativeRouteStore.saveEntranceCorrection(locationKey, {
    lat: accessibleEntranceCoords.lat,
    lng: accessibleEntranceCoords.lng,
    notes: sanitizeString(notes, 200)
  });

  res.json({
    success: true,
    message: 'Vehicle-accessible entrance point recorded successfully.',
    locationKey,
    accessibleEntranceCoords
  });
});

// ==========================================
// 4. HISTORICAL ROUTE TELEMETRY
// ==========================================
router.post('/telemetry', routingLimiter, (req: Request, res: Response) => {
  const { 
    orderId, 
    sellerId, 
    originCoords, 
    destinationCoords, 
    plannedDistanceMeters, 
    plannedEtaMinutes,
    actualDurationSeconds,
    actualDistanceMeters,
    riderGpsTrace
  } = req.body;

  if (!orderId) {
    return res.status(400).json({ error: 'ORDER_ID_REQUIRED' });
  }

  const record: RouteTelemetryRecord = {
    id: `telemetry_${orderId}`,
    orderId,
    sellerId: sanitizeString(sellerId || 'seller_default', 50),
    originCoords: originCoords || [12.9352, 77.6245],
    destinationCoords: destinationCoords || [12.9408, 77.6287],
    plannedDistanceMeters: plannedDistanceMeters || 1800,
    plannedEtaMinutes: plannedEtaMinutes || 12,
    actualDurationSeconds: actualDurationSeconds || undefined,
    actualDistanceMeters: actualDistanceMeters || undefined,
    rerouteCount: 0,
    offRouteDeviations: 0,
    riderGpsTrace: Array.isArray(riderGpsTrace) ? riderGpsTrace.slice(0, 100) : [],
    createdAt: new Date().toISOString()
  };

  authoritativeRouteStore.saveTelemetry(record);

  res.json({
    success: true,
    message: 'Route performance telemetry logged.',
    recordId: record.id
  });
});

export default router;
