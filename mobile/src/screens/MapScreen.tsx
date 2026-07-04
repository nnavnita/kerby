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
import {
  Bay,
  Destination,
  GeocodeResult,
  Lot,
  api,
  geocode,
  openLiveStream,
} from '../api';
import { storage } from '../storage';

const MELBOURNE_CBD: Region = {
  latitude: -37.814,
  longitude: 144.963,
  latitudeDelta: 0.02,
  longitudeDelta: 0.02,
};

const REFRESH_MS = 15_000;

type Filters = {
  availableOnly: boolean;
  maxWalkM: number;
  includeNoSensor: boolean;
  includeLots: boolean;
};

const DEFAULT_FILTERS: Filters = {
  availableOnly: true,
  maxWalkM: 400,
  includeNoSensor: false,
  includeLots: false,
};

type Props = {
  token: string;
  onSignedOut: () => void;
  onSessionSaved: () => void;
};

type Target = {
  label: string;
  lat: number;
  lng: number;
};

export function MapScreen({ token, onSignedOut, onSessionSaved }: Props) {
  const mapRef = useRef<MapView>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [region, setRegion] = useState<Region>(MELBOURNE_CBD);
  const [target, setTarget] = useState<Target | null>(null);
  const [bays, setBays] = useState<Bay[]>([]);
  const [lots, setLots] = useState<Lot[]>([]);
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [selected, setSelected] = useState<Bay | null>(null);
  const [selectedLot, setSelectedLot] = useState<Lot | null>(null);
  const [destModalOpen, setDestModalOpen] = useState(false);
  const [filterModalOpen, setFilterModalOpen] = useState(false);
  const [newDestName, setNewDestName] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<GeocodeResult[]>([]);
  const [searching, setSearching] = useState(false);

  const activeLockBayId = useMemo(
    () => bays.find((b) => b.lock?.mine)?.id ?? null,
    [bays],
  );

  // Centre of the search — destination if set, otherwise map centre.
  const searchCentre = useMemo(
    () =>
      target
        ? { lat: target.lat, lng: target.lng }
        : { lat: region.latitude, lng: region.longitude },
    [target, region.latitude, region.longitude],
  );

  const fetchBays = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await api.baysNear(
        {
          lat: searchCentre.lat,
          lng: searchCentre.lng,
          radius_m: Math.max(filters.maxWalkM, 150),
          available_only: filters.availableOnly,
        },
        token,
      );
      // Apply the client-side "hide no-sensor bays" filter — the backend already
      // enforces available_only and radius.
      const filtered = filters.includeNoSensor
        ? resp.bays
        : resp.bays.filter((b) => b.sensor != null);
      setBays(filtered);
    } catch (e: any) {
      console.warn('bays fetch failed', e?.message);
    } finally {
      setLoading(false);
    }
  }, [searchCentre.lat, searchCentre.lng, filters, token]);

  const fetchLots = useCallback(async () => {
    if (!filters.includeLots) {
      setLots([]);
      return;
    }
    try {
      const r = await api.lotsNear({
        lat: searchCentre.lat,
        lng: searchCentre.lng,
        radius_m: Math.max(filters.maxWalkM * 2, 400),
      });
      setLots(r);
    } catch (e: any) {
      console.warn('lots fetch failed', e?.message);
    }
  }, [searchCentre.lat, searchCentre.lng, filters.maxWalkM, filters.includeLots]);

  const refreshDestinations = useCallback(async () => {
    try {
      setDestinations(await api.listDestinations(token));
    } catch {
      // silent
    }
  }, [token]);

  // First-run: try to centre on the user's current location.
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

  // WS reroute subscription — active when the user holds a lock.
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
          const nextBay = pickBestBay(
            bays.filter((b) => b.id !== activeLockBayId),
            filters,
          );
          Alert.alert(
            'Bay taken',
            nextBay
              ? `Bay ${activeLockBayId} was taken. Lock the next-best bay (${nextBay.id}, ${nextBay.distance_m}m)?`
              : `Bay ${activeLockBayId} was taken. No matching bay nearby right now.`,
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
        // ignore
      }
    };
    return () => ws.close();
  }, [activeLockBayId, bays, token, fetchBays, filters]);

  const bestBay = useMemo(() => pickBestBay(bays, filters), [bays, filters]);

  const runSearch = useCallback(async (q: string) => {
    if (q.trim().length < 3) {
      setSearchResults([]);
      return;
    }
    setSearching(true);
    try {
      setSearchResults(await geocode(q));
    } catch (e: any) {
      console.warn('geocode', e?.message);
    } finally {
      setSearching(false);
    }
  }, []);

  useEffect(() => {
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    searchDebounce.current = setTimeout(() => runSearch(searchQuery), 400);
    return () => {
      if (searchDebounce.current) clearTimeout(searchDebounce.current);
    };
  }, [searchQuery, runSearch]);

  const applySearchResult = (r: GeocodeResult) => {
    const shortLabel = r.label.split(',').slice(0, 2).join(',');
    setTarget({ label: shortLabel, lat: r.lat, lng: r.lng });
    setSearchQuery('');
    setSearchResults([]);
    const region = {
      latitude: r.lat,
      longitude: r.lng,
      latitudeDelta: 0.006,
      longitudeDelta: 0.006,
    };
    setRegion(region);
    mapRef.current?.animateToRegion(region, 500);
  };

  const clearTarget = () => setTarget(null);

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
    const gm = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`;
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
    const centre = target ?? { lat: region.latitude, lng: region.longitude };
    try {
      await api.saveDestination(token, {
        name: newDestName.trim(),
        lat: centre.lat,
        lng: centre.lng,
      });
      setNewDestName('');
      refreshDestinations();
    } catch (e: any) {
      Alert.alert('Could not save', e?.message ?? 'unknown');
    }
  };

  const goToDestination = (d: Destination) => {
    setTarget({ label: d.name, lat: d.lat, lng: d.lng });
    const r = {
      latitude: d.lat,
      longitude: d.lng,
      latitudeDelta: 0.006,
      longitudeDelta: 0.006,
    };
    setRegion(r);
    mapRef.current?.animateToRegion(r, 500);
    setDestModalOpen(false);
    setFilters((f) => ({ ...f, maxWalkM: d.walk_radius_m }));
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
        {target && (
          <Marker
            coordinate={{ latitude: target.lat, longitude: target.lng }}
            pinColor="#1E88E5"
            title={target.label}
            description="Destination"
          />
        )}
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

      {/* Search + destination pill */}
      <View style={styles.topBar}>
        <View style={styles.searchCard}>
          <TextInput
            style={styles.searchInput}
            placeholder="Where are you driving to?"
            value={searchQuery}
            onChangeText={setSearchQuery}
            autoCorrect={false}
            returnKeyType="search"
            onSubmitEditing={() => runSearch(searchQuery)}
          />
          {searching && <ActivityIndicator size="small" />}
        </View>
        {target && (
          <View style={styles.targetPill}>
            <Text numberOfLines={1} style={styles.targetPillText}>
              {target.label}
            </Text>
            <Pressable onPress={clearTarget}>
              <Text style={styles.targetPillClear}>✕</Text>
            </Pressable>
          </View>
        )}
        {searchResults.length > 0 && (
          <View style={styles.searchDropdown}>
            {searchResults.map((r, i) => (
              <Pressable
                key={`${r.lat}-${r.lng}-${i}`}
                style={styles.searchResultRow}
                onPress={() => applySearchResult(r)}
              >
                <Text numberOfLines={2} style={styles.searchResultText}>
                  {r.label}
                </Text>
              </Pressable>
            ))}
          </View>
        )}
        <View style={styles.actionRow}>
          <Pressable style={styles.chip} onPress={() => setFilterModalOpen(true)}>
            <Text style={styles.chipText}>Filters</Text>
          </Pressable>
          <Pressable style={styles.chip} onPress={() => setDestModalOpen(true)}>
            <Text style={styles.chipText}>Saved</Text>
          </Pressable>
          <Pressable style={styles.chip} onPress={signOut}>
            <Text style={styles.chipText}>Sign out</Text>
          </Pressable>
        </View>
      </View>

      {/* Best-bay recommendation card */}
      {bestBay && (
        <View style={styles.bestCard}>
          <View style={{ flex: 1 }}>
            <Text style={styles.bestLabel}>Best bay for {target?.label ?? 'here'}</Text>
            <Text style={styles.bestTitle}>
              Bay {bestBay.id} · {bestBay.distance_m}m
            </Text>
            {bestBay.street && (
              <Text style={styles.bestMeta} numberOfLines={1}>
                {bestBay.street}
              </Text>
            )}
          </View>
          <View style={styles.bestActions}>
            {!bestBay.lock?.mine && !bestBay.lock && (
              <Pressable style={styles.smallBtn} onPress={() => lockBay(bestBay)}>
                <Text style={styles.smallBtnText}>Lock</Text>
              </Pressable>
            )}
            <Pressable
              style={[styles.smallBtn, styles.smallBtnPrimary]}
              onPress={() =>
                navigateTo(bestBay.lat, bestBay.lng, bestBay.street ?? `Bay ${bestBay.id}`)
              }
            >
              <Text style={styles.smallBtnText}>Nav</Text>
            </Pressable>
          </View>
        </View>
      )}

      <View style={styles.statusBar}>
        {loading && <ActivityIndicator size="small" />}
        <Text style={styles.statusText}>
          {bays.length} bay{bays.length === 1 ? '' : 's'}
          {filters.includeLots ? ` · ${lots.length} lot${lots.length === 1 ? '' : 's'}` : ''}
          {' · '}within {filters.maxWalkM}m
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
                      ? `Locked by you until ${new Date(
                          selected.lock.expires_at,
                        ).toLocaleTimeString()}`
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

      {/* Filters sheet */}
      <Modal
        visible={filterModalOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setFilterModalOpen(false)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setFilterModalOpen(false)}>
          <Pressable style={styles.card} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.cardTitle}>Filters</Text>

            <View style={styles.filterRow}>
              <Text style={styles.filterName}>Available now only</Text>
              <Switch
                value={filters.availableOnly}
                onValueChange={(v) => setFilters((f) => ({ ...f, availableOnly: v }))}
              />
            </View>
            <Text style={styles.filterHint}>
              Hide bays whose sensor is stale, occupied, or missing.
            </Text>

            <View style={styles.filterRow}>
              <Text style={styles.filterName}>Include bays with no sensor</Text>
              <Switch
                value={filters.includeNoSensor}
                onValueChange={(v) => setFilters((f) => ({ ...f, includeNoSensor: v }))}
              />
            </View>
            <Text style={styles.filterHint}>
              Off if you want live-availability guarantees.
            </Text>

            <View style={styles.filterRow}>
              <Text style={styles.filterName}>Include off-street lots</Text>
              <Switch
                value={filters.includeLots}
                onValueChange={(v) => setFilters((f) => ({ ...f, includeLots: v }))}
              />
            </View>

            <Text style={[styles.filterName, { marginTop: 16 }]}>
              Max walk distance: {filters.maxWalkM} m
            </Text>
            <View style={styles.chipRow}>
              {[150, 250, 400, 600, 1000].map((d) => (
                <Pressable
                  key={d}
                  style={[
                    styles.pill,
                    filters.maxWalkM === d && styles.pillActive,
                  ]}
                  onPress={() => setFilters((f) => ({ ...f, maxWalkM: d }))}
                >
                  <Text
                    style={[
                      styles.pillText,
                      filters.maxWalkM === d && styles.pillTextActive,
                    ]}
                  >
                    {d}m
                  </Text>
                </Pressable>
              ))}
            </View>

            <Text style={styles.disabledFilter}>
              Restriction type + bay shape filters coming soon — CoM data doesn't
              expose them yet (see project README).
            </Text>

            <Pressable
              style={styles.parkBtn}
              onPress={() => setFilterModalOpen(false)}
            >
              <Text style={styles.parkBtnText}>Done</Text>
            </Pressable>
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
                  <Pressable style={{ flex: 1 }} onPress={() => goToDestination(item)}>
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
                placeholder="Save current spot as…"
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

function pickBestBay(bays: Bay[], filters: Filters): Bay | null {
  const eligible = bays.filter((b) => {
    if (b.distance_m > filters.maxWalkM) return false;
    if (b.lock && !b.lock.mine) return false;
    if (filters.availableOnly) {
      if (!b.sensor) return false;
      if (!b.sensor.fresh) return false;
      if (b.sensor.status !== 'unoccupied') return false;
    } else if (!filters.includeNoSensor && !b.sensor) {
      return false;
    }
    return true;
  });
  if (eligible.length === 0) return null;
  return eligible.slice().sort((a, b) => a.distance_m - b.distance_m)[0];
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
  searchCard: {
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
  searchInput: {
    flex: 1,
    fontSize: 15,
    paddingVertical: 6,
  },
  searchDropdown: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 4,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 6,
    elevation: 4,
  },
  searchResultRow: {
    padding: 12,
    borderRadius: 8,
  },
  searchResultText: { fontSize: 14 },
  targetPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    alignSelf: 'flex-start',
    maxWidth: '90%',
    backgroundColor: '#1E88E5',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 24,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 6,
    elevation: 4,
  },
  targetPillText: { color: '#fff', fontWeight: '600', flexShrink: 1 },
  targetPillClear: { color: '#fff', fontWeight: '700', paddingLeft: 6 },
  actionRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 6,
  },
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
  bestCard: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 78,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    padding: 12,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 6,
    gap: 8,
  },
  bestLabel: { fontSize: 12, opacity: 0.6 },
  bestTitle: { fontSize: 16, fontWeight: '700' },
  bestMeta: { fontSize: 12, opacity: 0.7 },
  bestActions: { flexDirection: 'row', gap: 6 },
  smallBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#F9A825',
  },
  smallBtnPrimary: { backgroundColor: '#1E88E5' },
  smallBtnText: { color: '#fff', fontWeight: '700' },
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
  filterRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 12,
  },
  filterName: { fontSize: 15, fontWeight: '600' },
  filterHint: { fontSize: 12, opacity: 0.6, marginTop: 2 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  pill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: '#F0F0F0',
  },
  pillActive: { backgroundColor: '#1E88E5' },
  pillText: { fontWeight: '600', color: '#333' },
  pillTextActive: { color: '#fff' },
  disabledFilter: {
    marginTop: 16,
    fontSize: 12,
    opacity: 0.6,
    fontStyle: 'italic',
  },
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
