export interface Coordinates {
  latitude: number;
  longitude: number;
}

export interface RouteSummary {
  distanceMeters: number;
  distanceKm: number;
  durationSeconds: number;
  durationMinutes: number;
  routeType: 'OSRM_DRIVING' | 'BIKE_COURIER' | 'URBAN_GRID_FALLBACK';
  geometryPolyline?: string;
  roadCurvatureFactor: number;
  accessibleEntranceSnapped: boolean;
}

export interface RouteCalculationResult {
  selectedRoute: RouteSummary;
  alternativeRoutes: RouteSummary[];
  sellerPickupEntrance?: Coordinates;
  customerDropoffEntrance?: Coordinates;
  summary: {
    totalDistanceKm: number;
    estimatedEtaMinutes: number;
    fastestRouteType: string;
  };
  cached: boolean;
}
