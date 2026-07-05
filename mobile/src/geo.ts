import type { LatLng } from './polyline';

const EARTH_RADIUS_M = 6_371_000;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) *
      Math.cos(toRad(b.latitude)) *
      Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

/// Great-circle bearing from A to B in degrees (0 = north, 90 = east).
export function bearingDeg(a: LatLng, b: LatLng): number {
  const φ1 = toRad(a.latitude);
  const φ2 = toRad(b.latitude);
  const λ1 = toRad(a.longitude);
  const λ2 = toRad(b.longitude);
  const y = Math.sin(λ2 - λ1) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(λ2 - λ1);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

/// Perpendicular distance (m) from p to the segment ab. Uses a local
/// equirectangular projection — accurate to within a few cm for the
/// distances (< 5 km) we care about here.
export function distancePointToSegment(
  p: LatLng,
  a: LatLng,
  b: LatLng,
): number {
  const latRad = toRad((a.latitude + b.latitude) / 2);
  const mPerDegLat = 111_320;
  const mPerDegLng = 111_320 * Math.cos(latRad);
  const bx = (b.longitude - a.longitude) * mPerDegLng;
  const by = (b.latitude - a.latitude) * mPerDegLat;
  const px = (p.longitude - a.longitude) * mPerDegLng;
  const py = (p.latitude - a.latitude) * mPerDegLat;
  const lenSq = bx * bx + by * by;
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / lenSq));
  const cx = t * bx;
  const cy = t * by;
  return Math.hypot(px - cx, py - cy);
}

export function distanceToPolyline(p: LatLng, poly: LatLng[]): number {
  if (poly.length === 0) return Infinity;
  if (poly.length === 1) return haversineMeters(p, poly[0]);
  let min = Infinity;
  for (let i = 0; i < poly.length - 1; i++) {
    const d = distancePointToSegment(p, poly[i], poly[i + 1]);
    if (d < min) min = d;
  }
  return min;
}
