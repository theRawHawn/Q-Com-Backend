/**
 * Hyperlocal & Global Reverse Geocoding and Geolocation Helper
 * Resolves high-precision GPS coordinates anywhere globally into clean doorstep addresses.
 */

export interface GeocodedAddress {
  formattedAddress: string;
  road: string;
  suburb: string;
  city: string;
  state: string;
  country: string;
  postcode: string;
  landmark: string;
  lat: number;
  lng: number;
}

export interface SearchLocationResult {
  displayName: string;
  mainName: string;
  subName: string;
  lat: number;
  lng: number;
}

export interface LiveLocationResult {
  lat: number;
  lng: number;
  accuracyMeters?: number;
  source: 'gps_high_accuracy' | 'gps_low_accuracy' | 'ip_geolocation' | 'default_fallback';
  isIpFallback: boolean;
  errorMessage?: string;
}

/**
 * High-reliability GPS resolver for mobile devices and desktops.
 * Handles mobile browser permission prompts, cold GPS starts, and multi-tier fallbacks.
 */
export async function getLiveUserLocation(options?: {
  timeoutMs?: number;
  forceHighAccuracy?: boolean;
}): Promise<LiveLocationResult> {
  const timeoutMs = options?.timeoutMs ?? 15000;

  // 1. Direct Browser / Mobile Device HTML5 Geolocation
  if (typeof navigator !== 'undefined' && navigator.geolocation) {
    // Strategy A: High-accuracy GPS with generous timeout (allows user to tap 'Allow' prompt)
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('GPS request timed out.'));
        }, timeoutMs);

        navigator.geolocation.getCurrentPosition(
          (position) => {
            clearTimeout(timer);
            resolve(position);
          },
          (error) => {
            clearTimeout(timer);
            reject(error);
          },
          {
            enableHighAccuracy: true,
            timeout: timeoutMs,
            maximumAge: 60000, // Accept cached mobile GPS fix from the last 60s for instant response
          }
        );
      });

      return {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracyMeters: pos.coords.accuracy,
        source: 'gps_high_accuracy',
        isIpFallback: false,
      };
    } catch (err: any) {
      console.warn('High-accuracy GPS attempt failed, trying fast network/cell geolocation...', err?.message || err);

      // Strategy B: Standard accuracy GPS / Cell Tower / WiFi Positioning
      try {
        const posLow = await new Promise<GeolocationPosition>((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(
            resolve,
            reject,
            {
              enableHighAccuracy: false,
              timeout: 8000,
              maximumAge: 300000, // 5 min cache
            }
          );
        });

        return {
          lat: posLow.coords.latitude,
          lng: posLow.coords.longitude,
          accuracyMeters: posLow.coords.accuracy,
          source: 'gps_low_accuracy',
          isIpFallback: false,
        };
      } catch (err2: any) {
        console.warn('Standard HTML5 Geolocation failed or permission denied:', err2?.message || err2);
      }
    }
  }

  // 2. IP Geolocation Fallback Service 1 (BigDataCloud Client)
  try {
    const bdcRes = await fetch('https://api.bigdatacloud.net/data/reverse-geocode-client');
    if (bdcRes.ok) {
      const data = await bdcRes.json();
      if (data && data.latitude && data.longitude) {
        const lat = parseFloat(data.latitude);
        const lng = parseFloat(data.longitude);
        if (!isNaN(lat) && !isNaN(lng) && (lat !== 0 || lng !== 0)) {
          return {
            lat,
            lng,
            source: 'ip_geolocation',
            isIpFallback: true,
          };
        }
      }
    }
  } catch (e) {
    console.warn('BigDataCloud IP lookup failed', e);
  }

  // 3. IP Geolocation Fallback Service 2 (ipwho.is)
  try {
    const res = await fetch('https://ipwho.is/');
    if (res.ok) {
      const data = await res.json();
      if (data && data.success !== false && data.latitude && data.longitude) {
        return {
          lat: parseFloat(data.latitude),
          lng: parseFloat(data.longitude),
          source: 'ip_geolocation',
          isIpFallback: true,
        };
      }
    }
  } catch (e) {
    console.warn('ipwho.is lookup failed', e);
  }

  // 4. IP Geolocation Fallback Service 3 (geojs.io)
  try {
    const res = await fetch('https://get.geojs.io/v1/ip/geo.json');
    if (res.ok) {
      const data = await res.json();
      if (data && data.latitude && data.longitude) {
        return {
          lat: parseFloat(data.latitude),
          lng: parseFloat(data.longitude),
          source: 'ip_geolocation',
          isIpFallback: true,
        };
      }
    }
  } catch (e) {
    console.warn('geojs.io lookup failed', e);
  }

  // 5. Ultimate Fallback (Default location)
  return {
    lat: 12.9352,
    lng: 77.6245,
    source: 'default_fallback',
    isIpFallback: true,
  };
}

/**
 * Reverse geocodes coordinates (lat, lng) to a structured address globally without city limitations.
 */
export async function reverseGeocodeCoordinates(lat: number, lng: number): Promise<GeocodedAddress> {
  // Tier 1: OpenStreetMap Nominatim API with detailed address breakdown
  try {
    const nominatimUrl = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&addressdetails=1&accept-language=en`;
    const response = await fetch(nominatimUrl, {
      headers: {
        'Accept': 'application/json',
      },
    });

    if (response.ok) {
      const data = await response.json();
      const addr = data.address || {};

      const houseNumber = addr.house_number || addr.building || addr.house_name || '';
      const road = addr.road || addr.street || addr.footway || addr.path || addr.neighbourhood || addr.suburb || '';
      const suburb = addr.suburb || addr.neighbourhood || addr.residential || addr.subdistrict || addr.district || '';
      const city = addr.city || addr.town || addr.village || addr.municipality || addr.state_district || addr.county || '';
      const state = addr.state || addr.province || addr.region || '';
      const country = addr.country || '';
      const postcode = addr.postcode || '';
      const landmark = addr.amenity || addr.building || addr.shop || addr.leisure || addr.tourism || '';

      const parts: string[] = [];
      if (houseNumber && road) parts.push(`${houseNumber}, ${road}`);
      else if (road) parts.push(road);
      else if (suburb) parts.push(suburb);

      if (suburb && !parts.includes(suburb)) parts.push(suburb);
      if (city && !parts.includes(city)) parts.push(city);
      if (state && !parts.includes(state)) parts.push(state);
      if (postcode) parts.push(postcode);
      if (country && !parts.includes(country)) parts.push(country);

      const formattedAddress = parts.length > 0
        ? parts.join(', ')
        : data.display_name || `GPS (${lat.toFixed(5)}, ${lng.toFixed(5)})`;

      return {
        formattedAddress,
        road: road || suburb || 'Local Street',
        suburb: suburb || city || 'Local Area',
        city: city || state || country || 'Current Location',
        state: state || '',
        country: country || '',
        postcode: postcode || '',
        landmark: landmark || 'Near GPS Pin',
        lat,
        lng,
      };
    }
  } catch (err) {
    console.warn('Nominatim reverse geocode attempt failed, trying fallback...', err);
  }

  // Tier 2: BigDataCloud Reverse Geocoding API (Fast, CORS friendly, free tier)
  try {
    const bdcUrl = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=en`;
    const response = await fetch(bdcUrl);
    if (response.ok) {
      const data = await response.json();
      const locality = data.locality || data.localityInfo?.administrative?.[3]?.name || '';
      const city = data.city || data.principalSubdivision || data.countryName || 'Local Area';
      const postcode = data.postcode || '';
      const state = data.principalSubdivision || '';
      const country = data.countryName || '';

      const parts: string[] = [];
      if (locality) parts.push(locality);
      if (city && city !== locality) parts.push(city);
      if (state && state !== city) parts.push(state);
      if (postcode) parts.push(postcode);
      if (country) parts.push(country);

      const formattedAddress = parts.length > 0
        ? parts.join(', ')
        : `Doorstep Pin, ${city} ${postcode}`.trim();

      return {
        formattedAddress,
        road: locality || 'Local Street',
        suburb: locality || city,
        city: city || country || 'Current City',
        state: state || '',
        country: country || '',
        postcode: postcode || '',
        landmark: 'Near GPS Location',
        lat,
        lng,
      };
    }
  } catch (err) {
    console.warn('BigDataCloud reverse geocode failed, using coordinate fallback', err);
  }

  // Tier 3: Coordinate Fallback
  return {
    formattedAddress: `Current Location (${lat.toFixed(5)}, ${lng.toFixed(5)})`,
    road: 'Doorstep Location',
    suburb: 'Local Area',
    city: 'Current Location',
    state: '',
    country: '',
    postcode: '',
    landmark: 'GPS Pin Point',
    lat,
    lng,
  };
}

/**
 * Global address/place search using OpenStreetMap Nominatim
 */
export async function searchAddressGlobal(query: string): Promise<SearchLocationResult[]> {
  if (!query || query.trim().length < 2) return [];

  try {
    const searchUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query.trim())}&format=json&addressdetails=1&limit=5&accept-language=en`;
    const response = await fetch(searchUrl, {
      headers: {
        'Accept': 'application/json',
      },
    });

    if (response.ok) {
      const data = await response.json();
      return data.map((item: any) => {
        const addr = item.address || {};
        const main = addr.road || addr.suburb || addr.neighbourhood || addr.city || addr.town || item.name || query;
        const subParts: string[] = [];
        if (addr.city && addr.city !== main) subParts.push(addr.city);
        if (addr.state) subParts.push(addr.state);
        if (addr.country) subParts.push(addr.country);

        return {
          displayName: item.display_name,
          mainName: main,
          subName: subParts.join(', ') || item.display_name.split(',').slice(1, 4).join(','),
          lat: parseFloat(item.lat),
          lng: parseFloat(item.lon),
        };
      });
    }
  } catch (err) {
    console.warn('Global address search failed:', err);
  }
  return [];
}
