export type LatLng = { latitude: number; longitude: number };

/// Decode a Google encoded polyline string into a list of latlng points.
/// See https://developers.google.com/maps/documentation/utilities/polylinealgorithm.
export function decodePolyline(str: string): LatLng[] {
  const coords: LatLng[] = [];
  let lat = 0;
  let lng = 0;
  let index = 0;
  while (index < str.length) {
    let byte: number;
    let shift = 0;
    let result = 0;
    do {
      byte = str.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    shift = 0;
    result = 0;
    do {
      byte = str.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    coords.push({ latitude: lat / 1e5, longitude: lng / 1e5 });
  }
  return coords;
}
