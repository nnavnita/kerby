import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Linking,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import MapView, { Marker, Region } from 'react-native-maps';
import * as Location from 'expo-location';
import { API_BASE, Bay, Destination, Lot, api, openLiveStream } from '../api';
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
  const wsRef = useRef<WebSocket | null>(null);
  const [region, setRegion] = useState<Region>(MELBOURNE_CBD);
  const [bays, setBays] = useState<Bay[]>([]);
  const [lots, setLots] = useState<Lot[]>([]);
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [loading, setLoading] = useState(false);
  const [availableOnly, setAvailableOnly] = useState(true);
  const [showLots, setShowLots] = useState(false);
  const [selected, setSelected] = useState<Bay | null>(null);
  const [selectedLot, setSelectedLot] = useState<Lot | null>(null);
  const [destModalOpen, setDestModalOpen] = useState(false);
  const [newDestName, setNewDestName] = useState('');

  const activeLockBayId = useMemo(
    () => bays.find((b) => b.lock?.mine)?.id ?? null,
    [bays],
  );

  const fetchBays = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await api.baysNear(
        {
          lat: region.latitude,
          lng: region.longitude,
          radius_m: 600,
          available_only: availableOnly,
        },
        token,
      );
      setBays(resp.bays);
    } catch (e: any) {
      console.warn('bays fetch failed', e?.message);
    } finally {
      setLoading(false);
    }
  }, [region.latitude, region.longitude, availableOnly, token]);

  const fetchLots = useCallback(async () => {
    if (!showLots) {
      setLots([]);
      return;
    }
    try {
      const r = await api.lotsNear({
        lat: region.latitude,
        lng: region.longitude,
        radius_m: 800,
      });
      setLots(r);
    } catch (e: any) {
      console.warn('lots fetch failed', e?.message);
    }
  }, [region.latitude, region.longitude, showLots]);

  const refreshDestinations = useCallback(async () => {
    try {
      setDestinations(await api.listDestinations(token));
    } catch {
      // silent
    }
  }, [token]);

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
          // ignore
        }
      }
    })();
    refreshDestinations();
  }, [refreshDestinations]);

  useEffect(() => {
    fetchBays();
    fetchLots();
    const t = setInterval(() => {
      fetchBays();
      fetchLots();
    }, REFRESH_MS);
    return () => clearInterval(t);
  }, [fetchBays, fetchLots]);

  // WS live subscription — active when the user holds a lock. Watches the
  // locked bay + up to 5 nearest fallbacks so we can suggest a reroute if
  // the locked bay gets taken by a real car.
  useEffect(() => {
    if (!activeLockBayId) {
      wsRef.current?.close();
      wsRef.current = null;
      return;
    }
    const watch = [
      activeLockBayId,
      ...bays.filter((b) => b.id !== activeLockBayId).slice(0, 5).map((b) => b.id),
    ];
    const ws = openLiveStream(watch);
    wsRef.current = ws;
    ws.onmessage = (msg) => {
      try {
        const ev = JSON.parse(msg.data);
        if (ev.bay_id === activeLockBayId && ev.status === 'present') {
          const nextBay = bays.find(
            (b) =>
              b.id !== activeLockBayId &&
              b.sensor?.fresh &&
              b.sensor.status === 'unoccupied' &&
              !b.lock,
          );
          Alert.alert(
            'Bay taken',
            nextBay
              ? `Bay ${activeLockBayId} was taken. Lock the next-best bay (${nextBay.id}, ${nextBay.distance_m}m)?`
              : `Bay ${activeLockBayId} was taken. No fresh unoccupied bay nearby right now.`,
            nextBay
              ? [
                  { text: 'Cancel', style: 'cancel' },
                  {
                    text: 'Reroute',
                    onPress: async () => {
                      try {
                        await api.createLock(token, nextBay.id);
                        fetchBays();
                      } catch (e: any) {
                        Alert.alert('Could not lock', e?.message ?? 'unknown');
                      }
                    },
                  },
                ]
              : [{ text: 'OK' }],
          );
        }
      } catch {
        // ignore malformed frames
      }
    };
    return () => {
      ws.close();
    };
  }, [activeLockBayId, bays, token, fetchBays]);

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

  const navigateTo = (lat: number, lng: number, label: string) => {
    // Google Maps universal URL works on both iOS + Android and lets user
    // pick their nav app.
    const gm = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`;
    // iOS also honours the Apple Maps scheme.
    const url =
      Platform.OS === 'ios'
        ? `maps://?daddr=${lat},${lng}&q=${encodeURIComponent(label)}`
        : gm;
    Linking.openURL(url).catch(() => Linking.openURL(gm));
  };

  const saveCurrentAsDestination = async () => {
    if (!newDestName.trim()) {
      Alert.alert('Name required', 'Give this location a name.');
      return;
    }
    try {
      await api.saveDestination(token, {
        name: newDestName.trim(),
        lat: region.latitude,
        lng: region.longitude,
      });
      setNewDestName('');
      refreshDestinations();
    } catch (e: any) {
      Alert.alert('Could not save', e?.message ?? 'unknown');
    }
  };

  const goToDestination = (d: Destination) => {
    const r = {
      latitude: d.lat,
      longitude: d.lng,
      latitudeDelta: 0.006,
      longitudeDelta: 0.006,
    };
    setRegion(r);
    mapRef.current?.animateToRegion(r, 500);
    setDestModalOpen(false);
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
            onPress={() => {
              setSelectedLot(null);
              setSelected(b);
            }}
          />
        ))}
        {lots.map((l) => (
          <Marker
            key={`lot-${l.id}`}
            coordinate={{ latitude: l.lat, longitude: l.lng }}
            pinColor="#1565C0"
            onPress={() => {
              setSelected(null);
              setSelectedLot(l);
            }}
          />
        ))}
      </MapView>

      <View style={styles.topBar}>
        <View style={styles.filterRow}>
          <View style={styles.filterCard}>
            <Text style={styles.filterLabel}>Available</Text>
            <Switch value={availableOnly} onValueChange={setAvailableOnly} />
          </View>
          <View style={styles.filterCard}>
            <Text style={styles.filterLabel}>Lots</Text>
            <Switch value={showLots} onValueChange={setShowLots} />
          </View>
        </View>
        <View style={styles.actionRow}>
          <Pressable
            style={styles.chip}
            onPress={() => setDestModalOpen(true)}
          >
            <Text style={styles.chipText}>Saved</Text>
          </Pressable>
          <Pressable style={styles.chip} onPress={signOut}>
            <Text style={styles.chipText}>Sign out</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.statusBar}>
        {loading && <ActivityIndicator size="small" />}
        <Text style={styles.statusText}>
          {bays.length} bay{bays.length === 1 ? '' : 's'}
          {showLots ? ` · ${lots.length} lot${lots.length === 1 ? '' : 's'}` : ''}
        </Text>
      </View>

      {/* Bay detail sheet */}
      <Modal
        visible={!!selected}
        transparent
        animationType="slide"
        onRequestClose={() => setSelected(null)}
      >
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

                <Pressable
                  style={styles.navBtn}
                  onPress={() =>
                    navigateTo(selected.lat, selected.lng, selected.street ?? `Bay ${selected.id}`)
                  }
                >
                  <Text style={styles.navBtnText}>Navigate</Text>
                </Pressable>
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
                <Pressable style={styles.parkBtn} onPress={() => parkHere(selected)}>
                  <Text style={styles.parkBtnText}>I parked here</Text>
                </Pressable>
              </>
            )}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Lot detail sheet */}
      <Modal
        visible={!!selectedLot}
        transparent
        animationType="slide"
        onRequestClose={() => setSelectedLot(null)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setSelectedLot(null)}>
          <Pressable style={styles.card} onPress={(e) => e.stopPropagation()}>
            {selectedLot && (
              <>
                <Text style={styles.cardTitle}>{selectedLot.name ?? 'Off-street lot'}</Text>
                <Text style={styles.cardMeta}>{selectedLot.distance_m} m away</Text>
                {selectedLot.capacity != null && (
                  <Text style={styles.cardMeta}>Capacity: {selectedLot.capacity}</Text>
                )}
                {selectedLot.lot_type && (
                  <Text style={styles.cardMeta}>Type: {selectedLot.lot_type}</Text>
                )}
                <Pressable
                  style={styles.navBtn}
                  onPress={() =>
                    navigateTo(
                      selectedLot.lat,
                      selectedLot.lng,
                      selectedLot.name ?? 'Off-street lot',
                    )
                  }
                >
                  <Text style={styles.navBtnText}>Navigate</Text>
                </Pressable>
              </>
            )}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Saved destinations sheet */}
      <Modal
        visible={destModalOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setDestModalOpen(false)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setDestModalOpen(false)}>
          <Pressable style={styles.card} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.cardTitle}>Saved destinations</Text>
            <FlatList
              data={destinations}
              keyExtractor={(d) => d.id}
              ListEmptyComponent={
                <Text style={styles.cardMeta}>No saved places yet.</Text>
              }
              renderItem={({ item }) => (
                <View style={styles.destRow}>
                  <Pressable
                    style={{ flex: 1 }}
                    onPress={() => goToDestination(item)}
                  >
                    <Text style={styles.destName}>{item.name}</Text>
                    <Text style={styles.destMeta}>
                      {item.lat.toFixed(4)}, {item.lng.toFixed(4)} · {item.walk_radius_m}m
                    </Text>
                  </Pressable>
                  <Pressable
                    style={styles.destDelete}
                    onPress={async () => {
                      try {
                        await api.deleteDestination(token, item.id);
                        refreshDestinations();
                      } catch (e: any) {
                        Alert.alert('Could not delete', e?.message ?? 'unknown');
                      }
                    }}
                  >
                    <Text style={{ color: '#C62828' }}>Delete</Text>
                  </Pressable>
                </View>
              )}
              style={{ maxHeight: 260 }}
            />
            <View style={styles.destAddRow}>
              <TextInput
                style={styles.destInput}
                placeholder="Save current map centre as…"
                value={newDestName}
                onChangeText={setNewDestName}
              />
              <Pressable style={styles.saveDestBtn} onPress={saveCurrentAsDestination}>
                <Text style={{ color: '#fff', fontWeight: '700' }}>Save</Text>
              </Pressable>
            </View>
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
    gap: 6,
  },
  filterRow: {
    flexDirection: 'row',
    justifyContent: 'flex-start',
    gap: 6,
  },
  actionRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 6,
  },
  filterCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
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
  chip: {
    backgroundColor: '#fff',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 24,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 6,
    elevation: 4,
  },
  chipText: { color: '#333', fontWeight: '600' },
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
  navBtn: {
    marginTop: 12,
    backgroundColor: '#1E88E5',
    padding: 14,
    borderRadius: 8,
    alignItems: 'center',
  },
  navBtnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
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
  destRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  destName: { fontSize: 16, fontWeight: '600' },
  destMeta: { fontSize: 12, opacity: 0.6, marginTop: 2 },
  destDelete: { padding: 8 },
  destAddRow: {
    flexDirection: 'row',
    marginTop: 16,
    gap: 8,
  },
  destInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#d0d0d0',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  saveDestBtn: {
    backgroundColor: '#2E7D32',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
