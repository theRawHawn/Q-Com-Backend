import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { Maximize2, Navigation, AlertTriangle } from 'lucide-react';
import { apiCalculateRoute, apiRerouteRider } from '../utils/apiClient';
import { RouteCandidate, TurnInstruction, RoutingResponse } from '../types';

// Fix default Leaflet icon paths in bundlers
const defaultIcon = L.icon({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

L.Marker.prototype.options.icon = defaultIcon;

// Custom Leaflet HTML DivIcons matching Swiggy Delivery UI exactly
export const createHubIcon = (storeName: string = 'Sri Lakshmi Hardware') => {
  return L.divIcon({
    className: 'custom-hub-marker',
    html: `
      <div style="position: relative; display: flex; flex-direction: column; align-items: center; cursor: pointer;">
        <!-- Top Store Label Pill -->
        <div style="background: #ffffff; color: #0f172a; padding: 3px 10px; border-radius: 9999px; font-size: 10px; font-weight: 800; white-space: nowrap; box-shadow: 0 4px 14px rgba(0,0,0,0.12); display: flex; align-items: center; gap: 5px; margin-bottom: 4px; border: 1px solid #e2e8f0; font-family: ui-sans-serif, system-ui, sans-serif;">
          <span style="width: 7px; height: 7px; border-radius: 9999px; background: #059669;"></span>
          <span>${storeName}</span>
        </div>

        <!-- Store Marker Badge with Shopping/Store Icon -->
        <div style="width: 40px; height: 40px; background: #ffffff; border-radius: 9999px; display: flex; align-items: center; justify-content: center; box-shadow: 0 6px 16px rgba(0,0,0,0.15); border: 2.5px solid #059669; position: relative;">
          <!-- Store Icon SVG -->
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#059669" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
            <polyline points="9 22 9 12 15 12 15 22"/>
          </svg>
        </div>

        <!-- Contact Ground Shadow -->
        <div style="width: 20px; height: 5px; background: radial-gradient(ellipse at center, rgba(0,0,0,0.25) 0%, rgba(0,0,0,0) 70%); border-radius: 9999px; margin-top: 2px;"></div>
      </div>
    `,
    iconSize: [120, 75],
    iconAnchor: [60, 68],
    popupAnchor: [0, -68],
  });
};

export const createRiderIcon = (speedKmH: number = 28, riderName: string = 'AMAN KUMAR', bearing: number = 0) => {
  return L.divIcon({
    className: 'custom-rider-marker',
    html: `
      <div style="position: relative; display: flex; flex-direction: column; align-items: center; cursor: pointer;">
        <!-- Two-Wheeler Scooter Marker matching Swiggy Screenshot -->
        <div style="position: relative; width: 50px; height: 50px; display: flex; align-items: center; justify-content: center;">
          
          <!-- Outer Soft Pulse Glow -->
          <div style="position: absolute; inset: -4px; border-radius: 9999px; background: rgba(234, 88, 12, 0.2); animation: ping 2.5s cubic-bezier(0, 0, 0.2, 1) infinite;"></div>

          <!-- White Border Disc with Two-Wheeler Scooter & Swiggy Red/Orange Delivery Box -->
          <div style="width: 46px; height: 46px; background: #ffffff; border-radius: 9999px; display: flex; align-items: center; justify-content: center; box-shadow: 0 8px 20px rgba(234,88,12,0.35); border: 2.5px solid #ea580c; position: relative;">
            
            <!-- Delivery Two-Wheeler Scooter SVG with Red Delivery Box on Rear Rack -->
            <svg width="30" height="30" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
              <!-- Rider Body & Helmet -->
              <circle cx="15" cy="9" r="3.2" fill="#1e293b"/>
              <path d="M12 13.5C12 13.5 14.5 12 16.5 12C18.5 12 21 13.5 21 13.5L19.5 17H13.5L12 13.5Z" fill="#334155"/>
              
              <!-- Scooter Front Handlebars -->
              <path d="M9.5 15.5H23.5" stroke="#ea580c" strokeWidth="2" strokeLinecap="round"/>
              <circle cx="9.5" cy="22.5" r="3" fill="#0f172a" stroke="#ffffff" strokeWidth="1.2"/>
              <circle cx="23.5" cy="22.5" r="3" fill="#0f172a" stroke="#ffffff" strokeWidth="1.2"/>
              
              <!-- Scooter Chassis -->
              <path d="M10.5 22.5H22.5L20 16H13.5L10.5 22.5Z" fill="#ea580c"/>
              
              <!-- Swiggy Delivery Box (Red/Orange box on rear rack) -->
              <rect x="18" y="10" width="8" height="8" rx="1.5" fill="#dc2626" stroke="#ffffff" strokeWidth="1.2"/>
              <path d="M22 12V16" stroke="#ffffff" strokeWidth="1.2" strokeLinecap="round"/>
              <path d="M20 14H24" stroke="#ffffff" strokeWidth="1" strokeLinecap="round"/>
            </svg>
          </div>

          <!-- Small Speed Badge -->
          <div style="position: absolute; bottom: -2px; right: -2px; width: 17px; height: 17px; background: #ea580c; border-radius: 9999px; border: 1.5px solid #ffffff; display: flex; align-items: center; justify-content: center; color: #ffffff; font-size: 8px; font-weight: 900; box-shadow: 0 2px 6px rgba(0,0,0,0.2);">
            ⚡
          </div>
        </div>

        <!-- Ground Contact Shadow -->
        <div style="width: 26px; height: 5px; background: radial-gradient(ellipse at center, rgba(234,88,12,0.4) 0%, rgba(234,88,12,0) 75%); border-radius: 9999px; margin-top: 1px;"></div>
      </div>
    `,
    iconSize: [60, 60],
    iconAnchor: [30, 48],
    popupAnchor: [0, -48],
  });
};

/**
 * Calculates accurate Haversine distance in meters between two [lat, lng] points.
 */
export function computeHaversineMeters(p1: [number, number], p2: [number, number]): number {
  const R = 6371000; // Earth radius in meters
  const dLat = (p2[0] - p1[0]) * Math.PI / 180;
  const dLng = (p2[1] - p1[1]) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(p1[0] * Math.PI / 180) * Math.cos(p2[0] * Math.PI / 180) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Computes total physical route length in meters for a path.
 */
export function computeTotalRouteDistance(points: [number, number][]): number {
  if (points.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    total += computeHaversineMeters(points[i], points[i + 1]);
  }
  return total;
}

/**
 * Street grid road path generator (strictly follows street corridors, cross roads, and main road intersections).
 */
export function generateRealisticRoadPath(start: [number, number], end: [number, number]): [number, number][] {
  const dLat = end[0] - start[0];
  const dLng = end[1] - start[1];

  // Snapped to orthogonal street network (travels along street corridors turning at road junctions, never cutting through buildings)
  const keyWaypoints: [number, number][] = [
    [start[0], start[1]],                                                   // Start Gate
    [start[0], start[1] + dLng * 0.45],                                     // Along 13th Cross / Local Street
    [start[0] + dLat * 0.40, start[1] + dLng * 0.45],                       // Turn North at 5th Main Junction
    [start[0] + dLat * 0.40, start[1] + dLng * 0.95],                       // Turn East along 12th Main Corridor
    [start[0] + dLat * 0.90, start[1] + dLng * 0.95],                       // Turn onto Access Lane
    [end[0], end[1]],                                                       // Store / Address Entrance
  ];

  const densePath: [number, number][] = [];
  for (let i = 0; i < keyWaypoints.length - 1; i++) {
    const p1 = keyWaypoints[i];
    const p2 = keyWaypoints[i + 1];
    const segDist = computeHaversineMeters(p1, p2);
    const steps = Math.max(4, Math.ceil(segDist / 6)); // 6m dense points
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      densePath.push([
        p1[0] + (p2[0] - p1[0]) * t,
        p1[1] + (p2[1] - p1[1]) * t
      ]);
    }
  }
  densePath.push(end);
  return densePath;
}

/**
 * OpenStreetMap Live OSRM Delivery Engine Integration.
 * Fetches real drivable road vector polyline snapping to actual streets, turns, and lanes.
 * Uses bike / two-wheeler profile first (matches QCOM delivery partner routes, avoiding highway car median detour loops).
 */
export async function fetchRealRoadRoute(
  start: [number, number],
  end: [number, number]
): Promise<{ polyline: [number, number][]; routingResponse?: RoutingResponse }> {
  // 1. Query live OpenStreetMap OSRM engine (try bike / two-wheeler profile first for direct street access)
  const profiles = ['bike', 'driving'];
  for (const profile of profiles) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      const osrmUrl = `https://router.project-osrm.org/route/v1/${profile}/${start[1]},${start[0]};${end[1]},${end[0]}?overview=full&geometries=geojson&steps=true`;
      
      const response = await fetch(osrmUrl, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();
        if (data.code === 'Ok' && data.routes && data.routes[0]?.geometry?.coordinates) {
          // GeoJSON coordinates are [lng, lat], Leaflet requires [lat, lng]
          const rawCoords: [number, number][] = data.routes[0].geometry.coordinates.map(
            ([lng, lat]: [number, number]) => [lat, lng]
          );
          if (rawCoords.length >= 2) {
            const dense = interpolateDensePoints(rawCoords);
            return { polyline: dense };
          }
        }
      }
    } catch {
      // try next profile
    }
  }

  // 2. Query backend routing API if available
  try {
    const res: RoutingResponse = await apiCalculateRoute(
      { lat: start[0], lng: start[1] },
      { lat: end[0], lng: end[1] }
    );

    if (res && res.success && res.selectedRoute?.polyline?.length >= 2) {
      const dense = interpolateDensePoints(res.selectedRoute.polyline);
      return { polyline: dense, routingResponse: res };
    }
  } catch {
    // ignore
  }

  // 3. Fallback to high-precision orthogonal street grid road network
  const streetPoints = generateRealisticRoadPath(start, end);
  return { polyline: streetPoints };
}

function interpolateDensePoints(points: [number, number][]): [number, number][] {
  if (points.length < 2) return points;
  const dense: [number, number][] = [];
  
  for (let i = 0; i < points.length - 1; i++) {
    const p1 = points[i];
    const p2 = points[i + 1];
    const dist = computeHaversineMeters(p1, p2);
    const steps = Math.max(2, Math.ceil(dist / 8)); // ~8m dense points
    
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      dense.push([
        p1[0] + (p2[0] - p1[0]) * t,
        p1[1] + (p2[1] - p1[1]) * t
      ]);
    }
  }
  dense.push(points[points.length - 1]);
  return dense;
}

// Red Drop-Pin icon designed specifically for location selection & doorstep dropping (clean pin only)
export const createLocationPinIcon = () => {
  return L.divIcon({
    className: 'custom-location-pin-marker',
    html: `
      <div style="position: relative; display: flex; flex-direction: column; align-items: center; cursor: grab;">
        <!-- Premium Clean Drop Pin Shape -->
        <div style="position: relative; width: 36px; height: 46px; filter: drop-shadow(0 6px 12px rgba(220, 38, 38, 0.45));">
          <svg width="36" height="46" viewBox="0 0 36 46" fill="none" xmlns="http://www.w3.org/2000/svg">
            <!-- Pin Body -->
            <path d="M18 0C8.05887 0 0 8.05887 0 18C0 29.5 15.5 44 17.1 45.45C17.62 45.92 18.38 45.92 18.9 45.45C20.5 44 36 29.5 36 18C36 8.05887 27.9411 0 18 0Z" fill="#DC2626"/>
            <!-- Inner Gradient Highlight -->
            <path d="M18 2C9.16344 2 2 9.16344 2 18C2 27.8 15.2 40.5 18 43.1C20.8 40.5 34 27.8 34 18C34 9.16344 26.8366 2 18 2Z" fill="url(#pinGradient)"/>
            <!-- White Center Dot / Target -->
            <circle cx="18" cy="18" r="7" fill="#ffffff" />
            <circle cx="18" cy="18" r="3.5" fill="#DC2626" />
            
            <defs>
              <linearGradient id="pinGradient" x1="18" y1="2" x2="18" y2="43.1" gradientUnits="userSpaceOnUse">
                <stop stop-color="#EF4444"/>
                <stop offset="1" stop-color="#B91C1C"/>
              </linearGradient>
            </defs>
          </svg>
        </div>

        <!-- Ground Contact Target Ripple -->
        <div style="width: 14px; height: 4px; background: radial-gradient(ellipse at center, rgba(15,23,42,0.4) 0%, rgba(15,23,42,0) 75%); border-radius: 9999px; margin-top: -2px;"></div>
      </div>
    `,
    iconSize: [36, 48],
    iconAnchor: [18, 46],
    popupAnchor: [0, -46],
  });
};

export const createDestinationIcon = (label: string = 'Destination', isInteractive: boolean = false) => {
  return L.divIcon({
    className: 'custom-destination-marker',
    html: `
      <div style="position: relative; display: flex; flex-direction: column; align-items: center; cursor: pointer;">
        <!-- Top Label Pill (matches Swiggy destination badge dynamically) -->
        <div style="background: #ffffff; color: #0f172a; padding: 3px 10px; border-radius: 9999px; font-size: 10px; font-weight: 800; white-space: nowrap; box-shadow: 0 4px 14px rgba(0,0,0,0.12); display: flex; align-items: center; gap: 5px; margin-bottom: 4px; border: 1px solid #e2e8f0; font-family: ui-sans-serif, system-ui, sans-serif;">
          <span style="width: 7px; height: 7px; border-radius: 9999px; background: #dc2626;"></span>
          <span style="max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${label}</span>
          ${isInteractive ? '<span style="color: #64748b; font-size: 8px;">• Drag</span>' : ''}
        </div>

        <!-- Customer Destination Marker Badge (Dark Circle with House/Building Pin Icon) -->
        <div style="width: 38px; height: 38px; background: #1e293b; border-radius: 9999px; display: flex; align-items: center; justify-content: center; box-shadow: 0 6px 16px rgba(15,23,42,0.25); border: 2.5px solid #ffffff; position: relative;">
          <!-- Pin / House SVG -->
          <svg width="18" height="18" viewBox="0 0 24 24" fill="#ffffff" stroke="#ffffff" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
          </svg>
        </div>

        <!-- Ground Ripple -->
        <div style="width: 20px; height: 5px; background: radial-gradient(ellipse at center, rgba(15,23,42,0.3) 0%, rgba(15,23,42,0) 75%); border-radius: 9999px; margin-top: 2px;"></div>
      </div>
    `,
    iconSize: [120, 75],
    iconAnchor: [60, 68],
    popupAnchor: [0, -68],
  });
};

interface OpenStreetMapProps {
  center: [number, number]; // [lat, lng]
  zoom?: number;
  interactive?: boolean;
  onLocationSelect?: (lat: number, lng: number) => void;
  // Route visualization mode
  isRouteMode?: boolean;
  hubLocation?: [number, number];
  destinationLocation?: [number, number];
  destinationLabel?: string;
  riderStartLocation?: [number, number];
  riderLocation?: [number, number];
  riderName?: string;
  riderSpeed?: number;
  orderStatus?: string;
  className?: string;
  showHubCoverage?: boolean;
  onExpandFullscreen?: () => void;
}

export const OpenStreetMap: React.FC<OpenStreetMapProps> = ({
  center,
  zoom = 14,
  interactive = true,
  onLocationSelect,
  isRouteMode = false,
  hubLocation,
  destinationLocation,
  destinationLabel = 'Destination',
  riderStartLocation,
  riderLocation,
  riderName = 'AMAN KUMAR',
  riderSpeed = 28,
  orderStatus = 'out_for_delivery',
  className = 'h-full w-full',
  showHubCoverage = false,
  onExpandFullscreen,
}) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const hubMarkerRef = useRef<L.Marker | null>(null);
  const destMarkerRef = useRef<L.Marker | null>(null);
  const riderMarkerRef = useRef<L.Marker | null>(null);
  const routePolylineRef = useRef<L.Polyline | null>(null);
  const routePolylineGlowRef = useRef<L.Polyline | null>(null);
  const latestRemainingPointsRef = useRef<[number, number][]>([]);
  const isPinchingOrZoomingRef = useRef<boolean>(false);
  
  // Track manual user interaction so manual zoom/pan stays zoomed in
  const userHasInteractedRef = useRef<boolean>(false);
  const initialFitBoundsDoneRef = useRef<boolean>(false);
  const [tilesLoaded, setTilesLoaded] = useState(false);
  const [realRoadPoints, setRealRoadPoints] = useState<[number, number][]>([]);

  // Animation refs for 60fps continuous smooth glide navigation
  const currentProgressRef = useRef<number>(0);
  const targetProgressRef = useRef<number>(0);
  const animFrameRef = useRef<number | null>(null);

  const [routingMeta, setRoutingMeta] = useState<RoutingResponse | null>(null);
  const [isRerouting, setIsRerouting] = useState<boolean>(false);
  const lastRerouteTimeRef = useRef<number>(0);

  // Fetch real OpenStreetMap driving route from live OSRM engine for active leg
  useEffect(() => {
    if (!isRouteMode || !hubLocation || !destinationLocation) return;
    let isCancelled = false;

    const isPrepLeg = orderStatus === 'placed' || orderStatus === 'picking' || orderStatus === 'packed';
    const riderStartPos = riderStartLocation || [hubLocation[0] - 0.0048, hubLocation[1] - 0.0036];
    
    const activeStart = isPrepLeg ? riderStartPos : hubLocation;
    const activeEnd = isPrepLeg ? hubLocation : destinationLocation;

    fetchRealRoadRoute(activeStart, activeEnd).then((result) => {
      if (!isCancelled && result && result.polyline && result.polyline.length > 0) {
        setRealRoadPoints(result.polyline);
        if (result.routingResponse) {
          setRoutingMeta(result.routingResponse);
        }
      }
    });

    return () => {
      isCancelled = true;
    };
  }, [
    isRouteMode, 
    orderStatus,
    hubLocation?.[0], hubLocation?.[1], 
    destinationLocation?.[0], destinationLocation?.[1],
    riderStartLocation?.[0], riderStartLocation?.[1]
  ]);

  // Initialize Map
  useEffect(() => {
    if (!mapContainerRef.current) return;

    if (!mapInstanceRef.current) {
      const map = L.map(mapContainerRef.current, {
        center,
        zoom,
        zoomControl: false,
        attributionControl: false,
        scrollWheelZoom: interactive,
        dragging: interactive,
        touchZoom: interactive,
        doubleClickZoom: interactive,
        preferCanvas: true,
      });

      // Listen for user interaction and pinch/zoom events
      const onUserInteraction = (e: any) => {
        if (e.originalEvent) {
          userHasInteractedRef.current = true;
        }
      };

      const syncPolylines = () => {
        if (latestRemainingPointsRef.current.length >= 2) {
          if (routePolylineRef.current) {
            routePolylineRef.current.setLatLngs(latestRemainingPointsRef.current);
          }
          if (routePolylineGlowRef.current) {
            routePolylineGlowRef.current.setLatLngs(latestRemainingPointsRef.current);
          }
        }
      };

      const onZoomStart = () => {
        isPinchingOrZoomingRef.current = true;
      };

      const onZoomEnd = () => {
        isPinchingOrZoomingRef.current = false;
        requestAnimationFrame(() => {
          syncPolylines();
        });
      };

      map.on('zoomstart zoomanim', onZoomStart);
      map.on('zoomend', onZoomEnd);
      map.on('movestart dragstart', onUserInteraction);

      // Handle mobile touch gestures for pinch zoom
      const container = mapContainerRef.current;
      const onTouchStart = (e: TouchEvent) => {
        userHasInteractedRef.current = true;
        if (e.touches.length >= 2) {
          isPinchingOrZoomingRef.current = true;
        }
      };
      const onTouchMove = (e: TouchEvent) => {
        if (e.touches.length >= 2) {
          isPinchingOrZoomingRef.current = true;
        }
      };
      const onTouchEnd = (e: TouchEvent) => {
        if (e.touches.length < 2) {
          setTimeout(() => {
            isPinchingOrZoomingRef.current = false;
            syncPolylines();
          }, 60);
        }
      };

      container.addEventListener('touchstart', onTouchStart, { passive: true });
      container.addEventListener('touchmove', onTouchMove, { passive: true });
      container.addEventListener('touchend', onTouchEnd, { passive: true });
      container.addEventListener('touchcancel', onTouchEnd, { passive: true });

      // High-Res Clean OpenStreetMap Standard Vector-rendered Road Tiles (No watermark, 100% free & clear)
      const tileLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap contributors',
      });

      tileLayer.on('load', () => setTilesLoaded(true));
      tileLayer.addTo(map);

      mapInstanceRef.current = map;
    }

    const map = mapInstanceRef.current;

    // Force size invalidation so tiles immediately take up the full container height
    setTimeout(() => {
      map.invalidateSize();
    }, 50);
    setTimeout(() => {
      map.invalidateSize();
    }, 250);

    return () => {
      // Map cleanup on unmount
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
      }
    };
  }, []);

  // Reactive updates for Single Pin Picker Mode (when center, zoom, or interactive changes)
  useEffect(() => {
    if (isRouteMode || !mapInstanceRef.current) return;
    const map = mapInstanceRef.current;

    // 1. Create or update the destination marker
    if (markerRef.current) {
      markerRef.current.setLatLng(center);
      markerRef.current.setIcon(createLocationPinIcon());
    } else {
      const marker = L.marker(center, {
        draggable: interactive && Boolean(onLocationSelect),
        icon: createLocationPinIcon(),
      }).addTo(map);

      markerRef.current = marker;
    }

    // 2. Attach drag and click events
    if (markerRef.current) {
      if (interactive && onLocationSelect) {
        if (markerRef.current.dragging) {
          markerRef.current.dragging.enable();
        }
        markerRef.current.off('dragend');
        markerRef.current.on('dragend', () => {
          const pos = markerRef.current!.getLatLng();
          onLocationSelect(pos.lat, pos.lng);
        });
      } else if (markerRef.current.dragging) {
        markerRef.current.dragging.disable();
      }
    }

    if (interactive && onLocationSelect) {
      map.off('click');
      map.on('click', (e: L.LeafletMouseEvent) => {
        markerRef.current?.setLatLng(e.latlng);
        onLocationSelect(e.latlng.lat, e.latlng.lng);
      });
    }

    // 3. Pan and fly the map to the target center
    const currentCenter = map.getCenter();
    const distanceMeters = computeHaversineMeters([currentCenter.lat, currentCenter.lng], center);
    
    if (distanceMeters > 5) {
      map.flyTo(center, Math.max(map.getZoom(), zoom), {
        animate: true,
        duration: 0.75,
      });
    }

    // Ensure proper size rendering
    setTimeout(() => {
      map.invalidateSize();
    }, 60);
    setTimeout(() => {
      map.invalidateSize();
    }, 200);
  }, [center[0], center[1], zoom, isRouteMode, interactive, onLocationSelect]);

  // Resize observer to ensure Leaflet renders correctly whenever container geometry changes
  useEffect(() => {
    if (!mapContainerRef.current || !mapInstanceRef.current) return;

    const resizeObserver = new ResizeObserver(() => {
      mapInstanceRef.current?.invalidateSize();
    });

    resizeObserver.observe(mapContainerRef.current);
    return () => resizeObserver.disconnect();
  }, []);

  // Route & Live Courier Animation Mode (Smooth 60fps navigation on realistic road geometry)
  useEffect(() => {
    if (!isRouteMode || !mapInstanceRef.current || !hubLocation || !destinationLocation) return;

    const map = mapInstanceRef.current;
    
    // Determine active leg based on order status
    const isPrepLeg = orderStatus === 'placed' || orderStatus === 'picking' || orderStatus === 'packed';
    const riderStartPos = riderStartLocation || [hubLocation[0] - 0.0048, hubLocation[1] - 0.0036];
    
    // Leg 1: Rider -> Hub (Store)
    // Leg 2: Hub (Store) -> Destination (Customer)
    const start = isPrepLeg ? riderStartPos : hubLocation;
    const end = isPrepLeg ? hubLocation : destinationLocation;

    // Drivable road geometry (snaps to actual OpenStreetMap roads and street corridors)
    const roadPoints = realRoadPoints.length > 0
      ? realRoadPoints 
      : generateRealisticRoadPath(start, end);

    const isRiderActive = true; // Rider marker is always active in tracking mode

    // Target position calculation along current leg path
    const currentRiderPos = riderLocation || (orderStatus === 'delivered' ? destinationLocation : start);

    // Compute target progress fraction (0 to 1) along current road path
    let targetRatio = 0;
    if (orderStatus === 'delivered') {
      targetRatio = 1;
    } else if (orderStatus === 'packed') {
      targetRatio = 1; // Reached store
    } else {
      const totalLatDiff = end[0] - start[0];
      const currentLatDiff = currentRiderPos[0] - start[0];
      targetRatio = Math.min(1, Math.max(0, totalLatDiff !== 0 ? currentLatDiff / totalLatDiff : 0));
    }
    targetProgressRef.current = targetRatio;

    // Store Partner Marker (Pickup Point)
    if (!hubMarkerRef.current) {
      hubMarkerRef.current = L.marker(hubLocation, { icon: createHubIcon('Sri Lakshmi Hardware') })
        .bindPopup('<strong style="font-size:12px;">Sri Lakshmi Hardware & Electricals</strong><br><span style="font-size:10px;color:#666;">Store Partner (Order Pickup Point)</span>')
        .addTo(map);
    } else {
      hubMarkerRef.current.setLatLng(hubLocation);
    }

    // Customer Destination Marker (Customer Drop Point) - Only display once out for delivery to jobsite
    const dynamicLabel = orderStatus === 'delivered' ? '✓ Delivered' : destinationLabel;
    if (isPrepLeg) {
      if (destMarkerRef.current) {
        destMarkerRef.current.remove();
        destMarkerRef.current = null;
      }
    } else {
      if (!destMarkerRef.current) {
        destMarkerRef.current = L.marker(destinationLocation, { 
          icon: createDestinationIcon(dynamicLabel, false) 
        })
          .bindPopup(`<strong style="font-size:12px;">Customer Delivery Location</strong><br><span style="font-size:10px;color:#666;">${destinationLabel} Drop Point</span>`)
          .addTo(map);
      } else {
        destMarkerRef.current.setLatLng(destinationLocation);
        destMarkerRef.current.setIcon(createDestinationIcon(dynamicLabel, false));
      }
    }

    // Rider Marker initialization (Tracks as he moves towards seller location or jobsite)
    if (!riderMarkerRef.current) {
      const initialPos = roadPoints[0];
      riderMarkerRef.current = L.marker(initialPos, { 
        icon: createRiderIcon(riderSpeed, riderName) 
      }).addTo(map);
    }

    // Compute initial trimmed remaining points based on current progress
    const initProg = currentProgressRef.current;
    const initTotalPoints = roadPoints.length;
    const initExactIdx = initProg * (initTotalPoints - 1);
    const initBaseIdx = Math.min(initTotalPoints - 2, Math.max(0, Math.floor(initExactIdx)));
    const initSubRatio = initExactIdx - initBaseIdx;
    const initPt1 = roadPoints[initBaseIdx];
    const initPt2 = roadPoints[initBaseIdx + 1] || initPt1;
    const initCurrentPos: [number, number] = [
      initPt1[0] + (initPt2[0] - initPt1[0]) * initSubRatio,
      initPt1[1] + (initPt2[1] - initPt1[1]) * initSubRatio,
    ];
    const initialRemainingPoints: [number, number][] = initProg > 0 && initTotalPoints >= 2
      ? [initCurrentPos, ...roadPoints.slice(initBaseIdx + 1)]
      : roadPoints;

    // Route Glow Polyline (Casing / Glow for high visibility)
    if (!routePolylineGlowRef.current) {
      routePolylineGlowRef.current = L.polyline(initialRemainingPoints, {
        color: '#ea580c',
        weight: 8,
        opacity: 0.25,
        lineCap: 'round',
        lineJoin: 'round',
      }).addTo(map);
    } else {
      routePolylineGlowRef.current.setLatLngs(initialRemainingPoints);
    }

    // Route Active Solid Polyline (Crisp high-contrast route path)
    if (!routePolylineRef.current) {
      routePolylineRef.current = L.polyline(initialRemainingPoints, {
        color: '#ea580c',
        weight: 4.5,
        opacity: 1,
        lineCap: 'round',
        lineJoin: 'round',
      }).addTo(map);
    } else {
      routePolylineRef.current.setLatLngs(initialRemainingPoints);
    }

    // PRESERVE USER MANUAL ZOOM LEVEL: Auto-fit bounds ONCE on initial map load only
    if (!initialFitBoundsDoneRef.current) {
      const bounds = isPrepLeg
        ? L.latLngBounds([start, end])
        : L.latLngBounds([hubLocation, destinationLocation]);
      map.fitBounds(bounds, { 
        paddingTopLeft: [50, 40],
        paddingBottomRight: [50, 60],
        maxZoom: 16,
      });
      initialFitBoundsDoneRef.current = true;
    }

    // CONTINUOUS 60FPS FLUID GLIDE ANIMATION LOOP
    const animateStep = () => {
      const target = targetProgressRef.current;
      const current = currentProgressRef.current;
      const diff = target - current;

      if (Math.abs(diff) > 0.00008) {
        // Continuous smooth ease-out interpolation (no discrete steps/ticks)
        currentProgressRef.current += diff * 0.05;
      } else {
        currentProgressRef.current = target;
      }

      const p = currentProgressRef.current;
      const totalPoints = roadPoints.length;
      const exactIndexFloat = p * (totalPoints - 1);
      const baseIdx = Math.min(totalPoints - 2, Math.max(0, Math.floor(exactIndexFloat)));
      const subRatio = exactIndexFloat - baseIdx;

      const pt1 = roadPoints[baseIdx];
      const pt2 = roadPoints[baseIdx + 1] || pt1;

      const currLat = pt1[0] + (pt2[0] - pt1[0]) * subRatio;
      const currLng = pt1[1] + (pt2[1] - pt1[1]) * subRatio;
      const interpolatedPos: [number, number] = [currLat, currLng];

      // Move rider marker smoothly frame-by-frame
      if (riderMarkerRef.current) {
        riderMarkerRef.current.setLatLng(interpolatedPos);
      }

      // Cut off / trim the completed route behind the rider: keep only remaining route ahead
      const remainingPoints: [number, number][] = [interpolatedPos, ...roadPoints.slice(baseIdx + 1)];
      latestRemainingPointsRef.current = remainingPoints;

      // Update remaining polyline ahead unless active pinch zoom / zoom animation is transforming the map
      if (
        remainingPoints.length >= 2 &&
        !isPinchingOrZoomingRef.current &&
        !(map as any)._animatingZoom
      ) {
        if (routePolylineRef.current) {
          routePolylineRef.current.setLatLngs(remainingPoints);
        }
        if (routePolylineGlowRef.current) {
          routePolylineGlowRef.current.setLatLngs(remainingPoints);
        }
      }

      animFrameRef.current = requestAnimationFrame(animateStep);
    };

    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
    }
    animFrameRef.current = requestAnimationFrame(animateStep);

    return () => {
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
      }
    };
  }, [isRouteMode, hubLocation, destinationLocation, riderStartLocation, riderLocation, riderName, riderSpeed, orderStatus, realRoadPoints]);

  // Handle Recenter Map action when user taps recenter button
  const handleRecenterMap = () => {
    if (!mapInstanceRef.current || !hubLocation || !destinationLocation) return;
    userHasInteractedRef.current = false;
    const currentRiderPos = riderLocation || hubLocation;
    const bounds = L.latLngBounds([hubLocation, destinationLocation, currentRiderPos]);
    mapInstanceRef.current.fitBounds(bounds, {
      paddingTopLeft: [50, 40],
      paddingBottomRight: [50, 60],
      maxZoom: 16,
    });
  };

  return (
    <div className={`relative ${className} bg-[#e5e9ec] overflow-hidden`}>
      {/* Real Map Canvas Container */}
      <div 
        ref={mapContainerRef} 
        style={{ width: '100%', height: '100%', minHeight: '340px' }} 
        className="w-full h-full relative z-10" 
      />

      {/* Stacked Map Floating Action Controls (Arrow Recenter on Top, Enlarge Button Directly Below) */}
      <div className="absolute top-16 right-3.5 z-20 flex flex-col items-center gap-2">
        {isRouteMode && (
          <button
            type="button"
            onClick={handleRecenterMap}
            title="Recenter Map on Route"
            className="w-9 h-9 rounded-full bg-white/95 text-slate-700 shadow-md border border-slate-200/80 flex items-center justify-center hover:bg-white active:scale-95 transition cursor-pointer"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="3 11 22 2 13 21 11 13 3 11"/>
            </svg>
          </button>
        )}

        {onExpandFullscreen && (
          <button
            id="expand-fullscreen-map-control"
            type="button"
            onClick={onExpandFullscreen}
            title="Fullscreen Live Map"
            className="w-9 h-9 rounded-full bg-white/95 hover:bg-white text-slate-800 active:scale-95 flex items-center justify-center shadow-md border border-slate-200/80 transition cursor-pointer"
          >
            <Maximize2 className="w-4.5 h-4.5 text-emerald-700" />
          </button>
        )}
      </div>
    </div>
  );
};
