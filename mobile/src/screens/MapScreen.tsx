import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import MapView, { Marker, Region } from 'react-native-maps';
import * as Location from 'expo-location';
import { Bay, api } from '../api';
import { storage } from '../storage';

const MELBOURNE_CBD: Region = {
  latitude: -37.814,
  longitude: 144.963,
  latitudeDelta: 0.02,
  longitudeDelta: 0.02,
};

const REFRESH_MS = 15_000;

type Props = {
  token: string;
  onSignedOut: () => void;
  onSessionSaved: () => void;
};

export function MapScreen({ token, onSignedOut, onSessionSaved }: Props) {
  const mapRef = useRef<MapView>(null);
  const [region, setRegion] = useState<Region>(MELBOURNE_CBD);
  const [bays, setBays] = useState<Bay[]>([]);
  const [loading, setLoading] = useState(false);
  const [availableOnly, setAvailableOnly] = useState(true);
  const [selected, setSelected] = useState<Bay | null>(null);

  const fetchBays = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await api.baysNear({
        lat: region.latitude,
        lng: region.longitude,
        radius_m: 600,
        available_only: availableOnly,
      });
      setBays(resp.bays);
    } catch (e: any) {
      console.warn('bays fetch failed', e?.message);
    } finally {
      setLoading(false);
    }
  }, [region.latitude, region.longitude, availableOnly]);

  useEffect(() => {
    (async () => {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status === 'granted') {
        try {
          const loc = await Location.getCurrentPositionAsync({});
          const r = {
            latitude: loc.coords.latitude,
            longitude: loc.coords.longitude,
            latitudeDelta: 0.008,
            longitudeDelta: 0.008,
          };
          setRegion(r);
          mapRef.current?.animateToRegion(r, 500);
        } catch {
          // ignore — user can pan the map manually
        }
      }
    })();
  }, []);

  useEffect(() => {
    fetchBays();
    const t = setInterval(fetchBays, REFRESH_MS);
    return () => clearInterval(t);
  }, [fetchBays]);

  const parkHere = async (bay: Bay) => {
    try {
      const loc = await Location.getCurrentPositionAsync({});
      await api.createSession(token, {
        bay_id: bay.id,
        lat: loc.coords.latitude,
        lng: loc.coords.longitude,
        note: bay.street ?? undefined,
      });
      setSelected(null);
      onSessionSaved();
    } catch (e: any) {
      Alert.alert('Could not save session', e?.message ?? 'unknown');
    }
  };

  const lockBay = async (bay: Bay) => {
    try {
      await api.createLock(token, bay.id);
      setSelected(null);
      fetchBays();
    } catch (e: any) {
      Alert.alert('Could not lock', e?.message ?? 'unknown');
    }
  };

  const releaseLock = async (bay: Bay) => {
    try {
      const cur = await api.currentLock(token);
      if (cur && cur.bay_id === bay.id) {
        await api.releaseLock(token, cur.id);
      }
      setSelected(null);
      fetchBays();
    } catch (e: any) {
      Alert.alert('Could not release', e?.message ?? 'unknown');
    }
  };

  const signOut = async () => {
    await storage.clear();
    onSignedOut();
  };

  const markerColor = (bay: Bay) => {
    if (bay.lock?.mine) return '#F9A825';
    if (bay.lock) return '#7B1FA2';
    if (!bay.sensor) return '#8A8A8A';
    if (!bay.sensor.fresh) return '#8A8A8A';
    if (bay.sensor.status === 'unoccupied') return '#2E7D32';
    if (bay.sensor.status === 'present') return '#C62828';
    return '#8A8A8A';
  };

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        initialRegion={region}
        onRegionChangeComplete={setRegion}
        showsUserLocation
        showsMyLocationButton
      >
        {bays.map((b) => (
          <Marker
            key={b.id}
            coordinate={{ latitude: b.lat, longitude: b.lng }}
            pinColor={markerColor(b)}
            onPress={() => setSelected(b)}
          />
        ))}
      </MapView>

      <View style={styles.topBar}>
        <View style={styles.filterCard}>
          <Text style={styles.filterLabel}>Available only</Text>
          <Switch value={availableOnly} onValueChange={setAvailableOnly} />
        </View>
        <Pressable style={styles.signOut} onPress={signOut}>
          <Text style={styles.signOutText}>Sign out</Text>
        </Pressable>
      </View>

      <View style={styles.statusBar}>
        {loading && <ActivityIndicator size="small" />}
        <Text style={styles.statusText}>
          {bays.length} bay{bays.length === 1 ? '' : 's'} shown
        </Text>
      </View>

      <Modal visible={!!selected} transparent animationType="slide" onRequestClose={() => setSelected(null)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setSelected(null)}>
          <Pressable style={styles.card} onPress={(e) => e.stopPropagation()}>
            {selected && (
              <>
                <Text style={styles.cardTitle}>Bay {selected.id}</Text>
                {selected.street && <Text style={styles.cardStreet}>{selected.street}</Text>}
                <Text style={styles.cardMeta}>{selected.distance_m} m away</Text>
                {selected.sensor ? (
                  <Text style={styles.cardMeta}>
                    Sensor: {selected.sensor.status}
                    {selected.sensor.fresh ? '' : ' (stale)'} ·{' '}
                    {formatAge(selected.sensor.age_secs)}
                  </Text>
                ) : (
                  <Text style={styles.cardMeta}>No sensor coverage</Text>
                )}
                {selected.lock && (
                  <Text style={styles.cardMeta}>
                    {selected.lock.mine
                      ? `Locked by you until ${new Date(selected.lock.expires_at).toLocaleTimeString()}`
                      : 'Locked by another driver'}
                  </Text>
                )}
                {!selected.lock || selected.lock.mine ? (
                  <Pressable
                    style={styles.lockBtn}
                    onPress={() => (selected.lock?.mine ? releaseLock(selected) : lockBay(selected))}
                  >
                    <Text style={styles.lockBtnText}>
                      {selected.lock?.mine ? 'Release lock' : 'Lock this bay (15 min)'}
                    </Text>
                  </Pressable>
                ) : null}
                <Pressable
                  style={styles.parkBtn}
                  onPress={() => parkHere(selected)}
                >
                  <Text style={styles.parkBtnText}>I parked here</Text>
                </Pressable>
              </>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

function formatAge(secs?: number): string {
  if (secs == null) return '';
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  topBar: {
    position: 'absolute',
    top: 60,
    left: 12,
    right: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 8,
  },
  filterCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#fff',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 24,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 6,
    elevation: 4,
  },
  filterLabel: { fontWeight: '600' },
  signOut: {
    backgroundColor: '#fff',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 24,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 6,
    elevation: 4,
  },
  signOutText: { color: '#555' },
  statusBar: {
    position: 'absolute',
    bottom: 24,
    left: 12,
    right: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#fff',
    padding: 12,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 6,
    elevation: 4,
  },
  statusText: { fontSize: 14 },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.25)',
    justifyContent: 'flex-end',
  },
  card: {
    backgroundColor: '#fff',
    padding: 24,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
  },
  cardTitle: { fontSize: 20, fontWeight: '700', marginBottom: 4 },
  cardStreet: { fontSize: 14, opacity: 0.75, marginBottom: 8 },
  cardMeta: { fontSize: 14, marginBottom: 4 },
  parkBtn: {
    marginTop: 12,
    backgroundColor: '#2E7D32',
    padding: 14,
    borderRadius: 8,
    alignItems: 'center',
  },
  parkBtnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  lockBtn: {
    marginTop: 12,
    backgroundColor: '#F9A825',
    padding: 14,
    borderRadius: 8,
    alignItems: 'center',
  },
  lockBtnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
});
