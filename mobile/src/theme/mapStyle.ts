// Dark-mode Google Maps JSON style, applied via MapView's `customMapStyle`
// prop. Only takes effect on Android (Google Maps renderer) — iOS uses
// Apple MapKit, which gets its dark appearance from the `userInterfaceStyle`
// prop instead since MapKit doesn't support arbitrary JSON styling.
export const DARK_MAP_STYLE = [
  { elementType: 'geometry', stylers: [{ color: '#1d2c34' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#1d2c34' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#8ec3b9' }] },
  {
    featureType: 'administrative',
    elementType: 'geometry.stroke',
    stylers: [{ color: '#4b6878' }],
  },
  {
    featureType: 'administrative.land_parcel',
    elementType: 'labels.text.fill',
    stylers: [{ color: '#64779e' }],
  },
  {
    featureType: 'landscape.man_made',
    elementType: 'geometry.stroke',
    stylers: [{ color: '#334e87' }],
  },
  { featureType: 'poi', elementType: 'geometry', stylers: [{ color: '#283d6a' }] },
  { featureType: 'poi', elementType: 'labels.text.fill', stylers: [{ color: '#6f9ba5' }] },
  { featureType: 'poi.park', elementType: 'geometry.fill', stylers: [{ color: '#023e58' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#304a7d' }] },
  { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#98a5be' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#2c6675' }] },
  {
    featureType: 'road.highway',
    elementType: 'labels.text.fill',
    stylers: [{ color: '#b0d5ce' }],
  },
  { featureType: 'transit', elementType: 'labels.text.fill', stylers: [{ color: '#758fad' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0e1626' }] },
  { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#4e6d70' }] },
];
