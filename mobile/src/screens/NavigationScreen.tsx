import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import MapView, { Marker, Polyline } from 'react-native-maps';
import * as Location from 'expo-location';
import * as Speech from 'expo-speech';
import {
  Bay,
  DirectionsResponse,
  DirectionsStep,
  api,
  openLiveStream,
} from '../api';
import { distanceToPolyline, haversineMeters } from '../geo';
import { decodePolyline, LatLng } from '../polyline';

const OFF_ROUTE_METERS = 40;
const OFF_ROUTE_HOLD_MS = 5_000;
const ARRIVAL_METERS = 25;
const STEP_ADVANCE_METERS = 20;

type Props = {
  token: string;
  target: {
    bay: Bay;
  };
  onCancel: () => void;
  onArrived: () => void;
};

export function NavigationScreen({ token, target, onCancel, onArrived }: Props) {
  const mapRef = useRef<MapView>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const spokenSteps = useRef<Set<number>>(new Set());
  const offRouteSince = useRef<number | null>(null);
  const parkedRef = useRef(false);

  const [route, setRoute] = useState<DirectionsResponse | null>(null);
  const [decodedPoly, setDecodedPoly] = useState<LatLng[]>([]);
  const [me, setMe] = useState<LatLng | null>(null);
  const [currentStep, setCurrentStep] = useState(0);
  const [loadingRoute, setLoadingRoute] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const destination = useMemo(
    () => ({
      lat: target.bay.lat,
      lng: target.bay.lng,
      label: target.bay.street ?? `Bay ${target.bay.id}`,
    }),
    [target.bay],
  );

  const fetchRoute = useCallback(
    async (origin: LatLng) => {
      setLoadingRoute(true);
      setError(null);
      try {
        const r = await api.getDirections({
          origin: { lat: origin.latitude, lng: origin.longitude },
          destination: { lat: destination.lat, lng: destination.lng },
          mode: 'driving',
        });
        setRoute(r);
        setDecodedPoly(decodePolyline(r.polyline));
        setCurrentStep(0);
        spokenSteps.current.clear();
      } catch (e: any) {
        setError(e?.message ?? 'route failed');
      } finally {
        setLoadingRoute(false);
      }
    },
    [destination.lat, destination.lng],
  );

  // Location + first route.
  useEffect(() => {
    let sub: Location.LocationSubscription | undefined;
    (async () => {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== 'granted') {
        setError('location permission denied');
        return;
      }
      try {
        const first = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.BestForNavigation,
        });
        const start: LatLng = {
          latitude: first.coords.latitude,
          longitude: first.coords.longitude,
        };
        setMe(start);
        fetchRoute(start);
      } catch (e: any) {
        setError(e?.message ?? 'gps failed');
      }
      try {
        sub = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.BestForNavigation,
            distanceInterval: 5,
            timeInterval: 1_000,
          },
          (loc) => {
            setMe({
              latitude: loc.coords.latitude,
              longitude: loc.coords.longitude,
            });
          },
        );
      } catch {
        // ignore — we still have the initial fix
      }
    })();
    return () => {
      sub?.remove();
      Speech.stop();
    };
  }, [fetchRoute]);

  // WebSocket subscription for the locked bay (auto-reroute on takeover).
  useEffect(() => {
    if (!target.bay.lock?.mine) return;
    const ws = openLiveStream([target.bay.id]);
    wsRef.current = ws;
    ws.onmessage = (msg) => {
      try {
        const ev = JSON.parse(msg.data);
        if (ev.bay_id === target.bay.id && ev.status === 'present') {
          Speech.speak('Bay taken, exit navigation.');
          Alert.alert(
            'Bay taken',
            'The bay you locked was just taken by another car. Head back to search.',
            [{ text: 'OK', onPress: onCancel }],
          );
        }
      } catch {
        // ignore
      }
    };
    return () => ws.close();
  }, [target.bay.id, target.bay.lock?.mine, onCancel]);

  // Speak the first step's instruction once we have a route.
  useEffect(() => {
    if (!route || route.steps.length === 0) return;
    if (spokenSteps.current.has(0)) return;
    spokenSteps.current.add(0);
    Speech.speak(route.steps[0].instruction);
  }, [route]);

  // Follow user with camera.
  useEffect(() => {
    if (!me) return;
    mapRef.current?.animateCamera(
      {
        center: { latitude: me.latitude, longitude: me.longitude },
        zoom: 17,
      },
      { duration: 400 },
    );
  }, [me]);

  // Step advancement, arrival detection, off-route refetch.
  useEffect(() => {
    if (!me || !route) return;

    // Arrival check first.
    const destLL: LatLng = {
      latitude: destination.lat,
      longitude: destination.lng,
    };
    const distToDest = haversineMeters(me, destLL);
    if (distToDest < ARRIVAL_METERS && !parkedRef.current) {
      parkedRef.current = true;
      Speech.speak('You have arrived at your bay.');
      onArrived();
      return;
    }

    // Step progression.
    const step = route.steps[currentStep];
    if (step) {
      const stepEndLL: LatLng = {
        latitude: step.end.lat,
        longitude: step.end.lng,
      };
      const distToStepEnd = haversineMeters(me, stepEndLL);
      if (
        distToStepEnd < STEP_ADVANCE_METERS &&
        currentStep < route.steps.length - 1
      ) {
        const next = currentStep + 1;
        setCurrentStep(next);
        if (!spokenSteps.current.has(next)) {
          spokenSteps.current.add(next);
          Speech.speak(route.steps[next].instruction);
        }
      }
    }

    // Off-route: measure perpendicular distance to the route polyline.
    if (decodedPoly.length > 1) {
      const off = distanceToPolyline(me, decodedPoly);
      if (off > OFF_ROUTE_METERS) {
        if (offRouteSince.current == null) offRouteSince.current = Date.now();
        else if (Date.now() - offRouteSince.current > OFF_ROUTE_HOLD_MS) {
          offRouteSince.current = null;
          Speech.speak('Rerouting.');
          fetchRoute(me);
        }
      } else {
        offRouteSince.current = null;
      }
    }
  }, [me, route, decodedPoly, currentStep, destination.lat, destination.lng, fetchRoute, onArrived]);

  const currentInstruction =
    route && route.steps[currentStep] ? route.steps[currentStep] : null;
  const distanceToStepEnd =
    me && currentInstruction
      ? Math.round(
          haversineMeters(me, {
            latitude: currentInstruction.end.lat,
            longitude: currentInstruction.end.lng,
          }),
        )
      : null;
  const distanceToDest =
    me && route
      ? Math.round(
          haversineMeters(me, {
            latitude: destination.lat,
            longitude: destination.lng,
          }),
        )
      : null;

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        showsUserLocation
        showsCompass
        initialRegion={{
          latitude: destination.lat,
          longitude: destination.lng,
          latitudeDelta: 0.02,
          longitudeDelta: 0.02,
        }}
      >
        {decodedPoly.length > 0 && (
          <Polyline
            coordinates={decodedPoly}
            strokeColor="#1E88E5"
            strokeWidth={6}
          />
        )}
        <Marker
          coordinate={{ latitude: destination.lat, longitude: destination.lng }}
          pinColor="#2E7D32"
          title={destination.label}
        />
      </MapView>

      <View style={styles.instructionCard}>
        {loadingRoute ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator size="small" color="#fff" />
            <Text style={styles.instructionText}>Getting directions…</Text>
          </View>
        ) : currentInstruction ? (
          <>
            {currentInstruction.maneuver && (
              <Text style={styles.maneuver}>
                {formatManeuver(currentInstruction.maneuver)}
              </Text>
            )}
            <Text style={styles.instructionText}>
              {currentInstruction.instruction}
            </Text>
            {distanceToStepEnd != null && (
              <Text style={styles.instructionMeta}>
                {formatDistance(distanceToStepEnd)}
              </Text>
            )}
          </>
        ) : error ? (
          <Text style={styles.errorText}>{error}</Text>
        ) : null}
      </View>

      <View style={styles.footerBar}>
        <View style={{ flex: 1 }}>
          <Text style={styles.destinationLabel} numberOfLines={1}>
            To {destination.label}
          </Text>
          {distanceToDest != null && route && (
            <Text style={styles.footerMeta}>
              {formatDistance(distanceToDest)} · {formatDuration(route.duration_s)}
            </Text>
          )}
        </View>
        <Pressable style={styles.cancelBtn} onPress={onCancel}>
          <Text style={styles.cancelBtnText}>End</Text>
        </Pressable>
      </View>
    </View>
  );
}

function formatDistance(m: number): string {
  if (m < 1000) return `${m} m`;
  const km = m / 1000;
  return `${km.toFixed(km < 10 ? 1 : 0)} km`;
}

function formatDuration(s: number): string {
  if (s < 60) return `${s} sec`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const rem = min % 60;
  return `${h} h ${rem} min`;
}

function formatManeuver(raw: string): string {
  return raw.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  instructionCard: {
    position: 'absolute',
    top: 44,
    left: 12,
    right: 12,
    backgroundColor: '#1E88E5',
    padding: 16,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 6,
    gap: 4,
  },
  maneuver: { color: '#fff', fontSize: 14, fontWeight: '600', opacity: 0.85 },
  instructionText: { color: '#fff', fontSize: 18, fontWeight: '600' },
  instructionMeta: { color: '#fff', fontSize: 14, opacity: 0.85 },
  errorText: { color: '#fff', fontSize: 14 },
  loadingRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  footerBar: {
    position: 'absolute',
    bottom: 24,
    left: 12,
    right: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#fff',
    padding: 14,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 4,
  },
  destinationLabel: { fontSize: 15, fontWeight: '700' },
  footerMeta: { fontSize: 13, color: '#666', marginTop: 2 },
  cancelBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#C62828',
    borderRadius: 8,
  },
  cancelBtnText: { color: '#fff', fontWeight: '700' },
});
