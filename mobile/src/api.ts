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
  baysNear: (opts: {
    lat: number;
    lng: number;
    radius_m: number;
    available_only: boolean;
  }) => {
    const qs = new URLSearchParams({
      lat: String(opts.lat),
      lng: String(opts.lng),
      radius_m: String(opts.radius_m),
      available_only: String(opts.available_only),
    });
    return request<NearResponse>(`/bays/near?${qs.toString()}`);
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
};

export function openLiveStream(bayIds: string[]): WebSocket {
  const wsBase = API_BASE.replace(/^http/, 'ws');
  const ws = new WebSocket(`${wsBase}/live`);
  ws.onopen = () => {
    ws.send(JSON.stringify({ subscribe: bayIds }));
  };
  return ws;
}

export { API_BASE };
