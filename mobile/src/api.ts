import Constants from 'expo-constants';

const API_BASE: string =
  (Constants.expoConfig?.extra as any)?.apiBase ?? 'http://localhost:8080';

type Json = Record<string, unknown> | Array<unknown> | null;

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(
  path: string,
  opts: { method?: string; token?: string | null; body?: Json } = {},
): Promise<T> {
  const { method = 'GET', token, body } = opts;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const resp = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!resp.ok) {
    const msg = (parsed && (parsed as any).error) || resp.statusText;
    throw new ApiError(resp.status, msg);
  }
  return parsed as T;
}

export type AuthResponse = {
  token: string;
  user_id: string;
  expires_at: string;
};

export type SensorInfo = {
  status: 'unoccupied' | 'present' | 'unknown';
  source_updated_at?: string;
  fetched_at?: string;
  fresh: boolean;
  age_secs?: number;
};

export type LockInfo = {
  expires_at: string;
  mine: boolean;
};

export type Bay = {
  id: string;
  lat: number;
  lng: number;
  street: string | null;
  distance_m: number;
  sensor: SensorInfo | null;
  lock: LockInfo | null;
};

export type LockDto = {
  id: string;
  bay_id: string;
  user_id: string;
  created_at: string;
  expires_at: string;
  released_at: string | null;
};

export type Destination = {
  id: string;
  name: string;
  lat: number;
  lng: number;
  walk_radius_m: number;
  available_only: boolean;
  created_at: string;
  updated_at: string;
};

export type DirectionsStep = {
  instruction: string;
  distance_m: number;
  duration_s: number;
  start: { lat: number; lng: number };
  end: { lat: number; lng: number };
  maneuver?: string;
};

export type DirectionsResponse = {
  polyline: string;
  distance_m: number;
  duration_s: number;
  steps: DirectionsStep[];
  cached: boolean;
};

export type Lot = {
  id: string;
  name: string | null;
  operator: string | null;
  lot_type: string | null;
  capacity: number | null;
  lat: number;
  lng: number;
  distance_m: number;
};

export type NearResponse = {
  count: number;
  generated_at: string;
  bays: Bay[];
};

export type SessionDto = {
  id: string;
  bay_id: string | null;
  lat: number;
  lng: number;
  photo_url: string | null;
  note: string | null;
  parked_at: string;
  returned_at: string | null;
};

export const api = {
  signup: (email: string, password: string) =>
    request<AuthResponse>('/auth/signup', { method: 'POST', body: { email, password } }),
  login: (email: string, password: string) =>
    request<AuthResponse>('/auth/login', { method: 'POST', body: { email, password } }),
  baysNear: (
    opts: {
      lat: number;
      lng: number;
      radius_m: number;
      available_only: boolean;
    },
    token?: string,
  ) => {
    const qs = new URLSearchParams({
      lat: String(opts.lat),
      lng: String(opts.lng),
      radius_m: String(opts.radius_m),
      available_only: String(opts.available_only),
    });
    return request<NearResponse>(`/bays/near?${qs.toString()}`, { token });
  },
  createSession: (
    token: string,
    body: { bay_id?: string | null; lat: number; lng: number; note?: string | null },
  ) => request<SessionDto>('/sessions', { method: 'POST', token, body }),
  currentSession: (token: string) =>
    request<SessionDto | null>('/sessions/current', { token }),
  returnSession: (token: string, id: string) =>
    request<SessionDto>(`/sessions/${id}/return`, { method: 'POST', token }),

  createLock: (token: string, bay_id: string) =>
    request<LockDto>('/locks', { method: 'POST', token, body: { bay_id } }),
  currentLock: (token: string) =>
    request<LockDto | null>('/locks/current', { token }),
  releaseLock: (token: string, id: string) =>
    request<LockDto>(`/locks/${id}`, { method: 'DELETE', token }),
  extendLock: (token: string, id: string, lat: number, lng: number) =>
    request<LockDto>(`/locks/${id}/extend`, {
      method: 'POST',
      token,
      body: { lat, lng },
    }),

  listDestinations: (token: string) =>
    request<Destination[]>('/destinations', { token }),
  saveDestination: (
    token: string,
    body: {
      name: string;
      lat: number;
      lng: number;
      walk_radius_m?: number;
      available_only?: boolean;
    },
  ) => request<Destination>('/destinations', { method: 'POST', token, body }),
  deleteDestination: (token: string, id: string) =>
    request<{ ok: true }>(`/destinations/${id}`, { method: 'DELETE', token }),

  lotsNear: (opts: { lat: number; lng: number; radius_m?: number }) => {
    const qs = new URLSearchParams({
      lat: String(opts.lat),
      lng: String(opts.lng),
      ...(opts.radius_m ? { radius_m: String(opts.radius_m) } : {}),
    });
    return request<Lot[]>(`/lots/near?${qs.toString()}`);
  },

  setPushToken: (token: string, expoToken: string | null) =>
    request<{ ok: true }>('/users/push-token', {
      method: 'POST',
      token,
      body: { token: expoToken },
    }),

  getDirections: (opts: {
    origin: { lat: number; lng: number };
    destination: { lat: number; lng: number };
    mode?: 'driving' | 'walking' | 'bicycling' | 'transit';
  }) => {
    const qs = new URLSearchParams({
      origin: `${opts.origin.lat},${opts.origin.lng}`,
      destination: `${opts.destination.lat},${opts.destination.lng}`,
      ...(opts.mode ? { mode: opts.mode } : {}),
    });
    return request<DirectionsResponse>(`/directions?${qs}`);
  },
};

export function openLiveStream(bayIds: string[]): WebSocket {
  const wsBase = API_BASE.replace(/^http/, 'ws');
  const ws = new WebSocket(`${wsBase}/live`);
  ws.onopen = () => {
    ws.send(JSON.stringify({ subscribe: bayIds }));
  };
  return ws;
}

/// Geocode a free-text query to a Melbourne-area lat/lng using OSM
/// Nominatim. Free, no key required, rate-limited to 1 req/s per IP.
export type GeocodeResult = {
  label: string;
  lat: number;
  lng: number;
};

const LOCATIONIQ_TOKEN: string | undefined = (Constants.expoConfig?.extra as any)
  ?.locationiqToken;

/// Geocode a free-text query. Primary path proxies through the Kerby backend
/// (which holds the Google API key, caches results, and rate-limits abuse).
/// Falls back to LocationIQ then Photon if the backend has no key configured
/// or the request fails.
export async function geocode(query: string): Promise<GeocodeResult[]> {
  const trimmed = query.trim();
  if (trimmed.length < 3) return [];
  try {
    return await geocodeBackend(trimmed);
  } catch (e) {
    if (LOCATIONIQ_TOKEN) return geocodeLocationIQ(trimmed);
    return geocodePhoton(trimmed);
  }
}

async function geocodeBackend(q: string): Promise<GeocodeResult[]> {
  const qs = new URLSearchParams({ q });
  const resp = await fetch(`${API_BASE}/geocode?${qs}`);
  if (!resp.ok) throw new Error(`geocode ${resp.status}`);
  const raw = (await resp.json()) as { results: GeocodeResult[] };
  return raw.results;
}

async function geocodeLocationIQ(q: string): Promise<GeocodeResult[]> {
  const qs = new URLSearchParams({
    key: LOCATIONIQ_TOKEN!,
    q,
    limit: '8',
    countrycodes: 'au',
    format: 'json',
    // Bias to Melbourne but don't hard-restrict.
    viewbox: '144.85,-37.75,145.05,-37.90',
    bounded: '0',
    dedupe: '1',
    addressdetails: '1',
  });
  const resp = await fetch(`https://api.locationiq.com/v1/autocomplete?${qs}`);
  if (!resp.ok) throw new Error(`geocode ${resp.status}`);
  const raw = (await resp.json()) as Array<{
    display_name: string;
    lat: string;
    lon: string;
  }>;
  return raw.map((r) => ({
    label: r.display_name,
    lat: parseFloat(r.lat),
    lng: parseFloat(r.lon),
  }));
}

async function geocodePhoton(q: string): Promise<GeocodeResult[]> {
  const qs = new URLSearchParams({
    q,
    limit: '8',
    lang: 'en',
    lat: '-37.814',
    lon: '144.963',
  });
  const resp = await fetch(`https://photon.komoot.io/api/?${qs}`, {
    headers: { 'User-Agent': 'kerby-mobile/0.1 (kerby@nnavnita.com)' },
  });
  if (!resp.ok) throw new Error(`geocode ${resp.status}`);
  const raw = (await resp.json()) as {
    features?: Array<{
      geometry: { coordinates: [number, number] };
      properties: {
        name?: string;
        housenumber?: string;
        street?: string;
        city?: string;
        state?: string;
        country?: string;
      };
    }>;
  };
  return (raw.features ?? [])
    .filter((f) => f.properties?.country === 'Australia')
    .map((f) => {
      const [lng, lat] = f.geometry.coordinates;
      const p = f.properties;
      const parts = [
        [p.housenumber, p.street].filter(Boolean).join(' '),
        p.name && p.name !== p.street ? p.name : '',
        p.city,
        p.state,
      ].filter(Boolean);
      return {
        label: parts.join(', ') || p.name || 'Unknown place',
        lat,
        lng,
      };
    });
}

export { API_BASE };
