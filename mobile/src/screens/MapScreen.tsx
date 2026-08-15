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
import { AccountModal } from './AccountModal';
import { VoiceSettingsModal } from './VoiceSettingsModal';
import { ThemeColors } from '../theme/tokens';
import { useTheme } from '../theme/ThemeContext';
import { DARK_MAP_STYLE } from '../theme/mapStyle';

const MELBOURNE_CBD: Region = {
  latitude: -37.814,
  longitude: 144.963,
  latitudeDelta: 0.02,
  longitudeDelta: 0.02,
};

const REFRESH_MS = 15_000;
const STREET_SPOT_LATITUDE_DELTA = 0.0035;

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
  emailVerified: boolean;
  onResendVerification: () => Promise<{ ok: true }>;
  onSignedOut: () => void;
  onSessionSaved: () => void;
  onStartNav: (bay: Bay) => void;
};

type Target = {
  label: string;
  lat: number;
  lng: number;
};

export function MapScreen({
  emailVerified,
  onResendVerification,
  onSignedOut,
  onSessionSaved,
  onStartNav,
}: Props) {
  const { colors, scheme } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const mapRef = useRef<MapView>(null);
  const [verifyBannerDismissed, setVerifyBannerDismissed] = useState(false);
  const [resendBusy, setResendBusy] = useState(false);
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
  const [voiceModalOpen, setVoiceModalOpen] = useState(false);
  const [accountModalOpen, setAccountModalOpen] = useState(false);
  const [newDestName, setNewDestName] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<GeocodeResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [refreshingBayId, setRefreshingBayId] = useState<string | null>(null);

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
  const streetSpotMode = region.latitudeDelta <= STREET_SPOT_LATITUDE_DELTA;

  const fetchBays = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await api.baysNear({
        lat: searchCentre.lat,
        lng: searchCentre.lng,
        radius_m: Math.max(filters.maxWalkM, 150),
        available_only: filters.availableOnly && !streetSpotMode,
        limit: streetSpotMode ? 500 : undefined,
      });
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
  }, [searchCentre.lat, searchCentre.lng, filters, streetSpotMode]);

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

  const refreshMap = useCallback(() => {
    fetchBays();
    fetchLots();
  }, [fetchBays, fetchLots]);

  const refreshDestinations = useCallback(async () => {
    try {
      setDestinations(await api.listDestinations());
    } catch {
      // silent
    }
  }, []);

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
    refreshMap();
    const t = setInterval(() => {
      refreshMap();
    }, REFRESH_MS);
    return () => clearInterval(t);
  }, [refreshMap]);

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
                        await api.createLock(nextBay.id);
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
  }, [activeLockBayId, bays, fetchBays, filters]);

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
      await api.createSession({
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
      await api.createLock(bay.id);
      setSelected(null);
      fetchBays();
    } catch (e: any) {
      Alert.alert('Could not lock', e?.message ?? 'unknown');
    }
  };

  const releaseLock = async (bay: Bay) => {
    try {
      const cur = await api.currentLock();
      if (cur && cur.bay_id === bay.id) {
        await api.releaseLock(cur.id);
      }
      setSelected(null);
      fetchBays();
    } catch (e: any) {
      Alert.alert('Could not release', e?.message ?? 'unknown');
    }
  };

  const refreshBaySensor = async (bay: Bay) => {
    setRefreshingBayId(bay.id);
    try {
      const refreshed = await api.refreshBaySensor(bay.id);
      const updateBay = (b: Bay) =>
        b.id === refreshed.bay_id ? { ...b, sensor: refreshed.sensor } : b;
      setBays((items) => items.map(updateBay));
      setSelected((current) => (current ? updateBay(current) : current));
    } catch (e: any) {
      const message =
        e?.status === 404
          ? 'City does not currently publish a live sensor row for this bay.'
          : e?.message ?? 'unknown';
      Alert.alert('Could not refresh sensor', message);
    } finally {
      setRefreshingBayId(null);
    }
  };

  /// Start in-app turn-by-turn navigation to a specific bay. Called from
  /// the bay detail sheet and the best-bay card.
  const startNav = (bay: Bay) => {
    setSelected(null);
    onStartNav(bay);
  };

  /// Fallback: open Apple/Google Maps for off-street lots (we don't own the
  /// lot dataset well enough yet to do in-app nav to them).
  const openExternalMaps = (lat: number, lng: number, label: string) => {
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
      await api.saveDestination({
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
    if (bay.lock?.mine) return colors.status.warning;
    if (bay.lock) return colors.status.locked;
    if (!bay.sensor) return colors.status.neutral;
    if (!bay.sensor.fresh) return colors.status.neutral;
    if (bay.sensor.status === 'unoccupied') return colors.status.success;
    if (bay.sensor.status === 'present') return colors.status.danger;
    return colors.status.neutral;
  };

  const canTargetBay = (bay: Bay) => {
    if (bay.lock?.mine) return true;
    if (bay.lock) return false;
    if (!bay.sensor) return filters.includeNoSensor;
    return bay.sensor.fresh && bay.sensor.status === 'unoccupied';
  };

  const markerLabel = (bay: Bay) => {
    if (bay.lock?.mine) return 'Locked by you';
    if (bay.lock) return 'Locked by another driver';
    if (!bay.sensor) return 'No sensor coverage';
    if (!bay.sensor.fresh) return 'Sensor stale';
    if (bay.sensor.status === 'unoccupied') return 'Available';
    if (bay.sensor.status === 'present') return 'Taken';
    return 'Unknown';
  };

  const spotMarkerStyle = (bay: Bay) => {
    if (bay.lock?.mine) return [styles.spotMarker, styles.spotMarkerMine];
    if (bay.lock) return [styles.spotMarker, styles.spotMarkerLocked];
    if (!bay.sensor || !bay.sensor.fresh) {
      return [styles.spotMarker, styles.spotMarkerUnknown];
    }
    if (bay.sensor.status === 'unoccupied') {
      return [styles.spotMarker, styles.spotMarkerAvailable];
    }
    if (bay.sensor.status === 'present') {
      return [styles.spotMarker, styles.spotMarkerTaken];
    }
    return [styles.spotMarker, styles.spotMarkerUnknown];
  };

  return (
    <View style={styles.container}>
      {!emailVerified && !verifyBannerDismissed && (
        <View style={styles.verifyBanner}>
          <Text style={styles.verifyBannerText}>Verify your email to secure your account</Text>
          <Pressable
            disabled={resendBusy}
            onPress={async () => {
              setResendBusy(true);
              try {
                await onResendVerification();
              } finally {
                setResendBusy(false);
              }
            }}
          >
            <Text style={styles.verifyBannerAction}>{resendBusy ? 'Sending…' : 'Resend'}</Text>
          </Pressable>
          <Pressable onPress={() => setVerifyBannerDismissed(true)}>
            <Text style={styles.verifyBannerAction}>Dismiss</Text>
          </Pressable>
        </View>
      )}
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        initialRegion={region}
        onRegionChangeComplete={setRegion}
        showsUserLocation
        showsMyLocationButton
        userInterfaceStyle={scheme}
        customMapStyle={scheme === 'dark' ? DARK_MAP_STYLE : []}
      >
        {target && (
          <Marker
            coordinate={{ latitude: target.lat, longitude: target.lng }}
            pinColor={colors.brand.primary}
            title={target.label}
            description="Destination"
          />
        )}
        {bays.map((b) => (
          <Marker
            key={b.id}
            coordinate={{ latitude: b.lat, longitude: b.lng }}
            pinColor={streetSpotMode ? undefined : markerColor(b)}
            anchor={{ x: 0.5, y: 0.5 }}
            title={`Bay ${b.id}`}
            description={markerLabel(b)}
            onPress={() => {
              setSelectedLot(null);
              setSelected(b);
            }}
          >
            {streetSpotMode ? <View style={spotMarkerStyle(b)} /> : undefined}
          </Marker>
        ))}
        {lots.map((l) => (
          <Marker
            key={`lot-${l.id}`}
            coordinate={{ latitude: l.lat, longitude: l.lng }}
            pinColor={colors.status.info}
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
          <Pressable
            style={[styles.chip, loading && styles.chipDisabled]}
            onPress={refreshMap}
            disabled={loading}
          >
            <Text style={styles.chipText}>Refresh</Text>
          </Pressable>
          <Pressable style={styles.chip} onPress={() => setFilterModalOpen(true)}>
            <Text style={styles.chipText}>Filters</Text>
          </Pressable>
          <Pressable style={styles.chip} onPress={() => setDestModalOpen(true)}>
            <Text style={styles.chipText}>Saved</Text>
          </Pressable>
          <Pressable style={styles.chip} onPress={() => setVoiceModalOpen(true)}>
            <Text style={styles.chipText}>Voice</Text>
          </Pressable>
          <Pressable style={styles.chip} onPress={() => setAccountModalOpen(true)}>
            <Text style={styles.chipText}>Account</Text>
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
              onPress={() => startNav(bestBay)}
            >
              <Text style={styles.smallBtnText}>Nav</Text>
            </Pressable>
          </View>
        </View>
      )}

      <View style={styles.statusBar}>
        {loading && <ActivityIndicator size="small" />}
        <View style={{ flex: 1 }}>
          <Text style={styles.statusText}>
            {bays.length} bay{bays.length === 1 ? '' : 's'}
            {filters.includeLots ? ` · ${lots.length} lot${lots.length === 1 ? '' : 's'}` : ''}
            {' · '}within {filters.maxWalkM}m
          </Text>
          <Text style={styles.attribText}>
            Data © City of Melbourne, CC-BY 4.0
          </Text>
        </View>
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
                  <>
                    <Text style={styles.cardMeta}>
                      City reading: {selected.sensor.status}
                      {selected.sensor.fresh ? '' : ' (stale)'} ·{' '}
                      {formatAge(selected.sensor.age_secs)}
                    </Text>
                    {selected.sensor.fetched_at && (
                      <Text style={styles.cardMeta}>
                        Kerby checked: {formatTimestampAge(selected.sensor.fetched_at)}
                      </Text>
                    )}
                  </>
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
                  style={[styles.refreshSensorBtn, refreshingBayId === selected.id && styles.chipDisabled]}
                  onPress={() => refreshBaySensor(selected)}
                  disabled={refreshingBayId === selected.id}
                >
                  <Text style={styles.refreshSensorBtnText}>
                    {refreshingBayId === selected.id ? 'Refreshing sensor...' : 'Refresh sensor'}
                  </Text>
                </Pressable>
                {canTargetBay(selected) && (
                  <Pressable
                    style={styles.navBtn}
                    onPress={() => startNav(selected)}
                  >
                    <Text style={styles.navBtnText}>Navigate</Text>
                  </Pressable>
                )}
                {selected.lock?.mine || (!selected.lock && canTargetBay(selected)) ? (
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
                    openExternalMaps(
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

            <Pressable
              style={styles.parkBtn}
              onPress={() => setFilterModalOpen(false)}
            >
              <Text style={styles.parkBtnText}>Done</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      <VoiceSettingsModal visible={voiceModalOpen} onClose={() => setVoiceModalOpen(false)} />
      <AccountModal
        visible={accountModalOpen}
        onClose={() => setAccountModalOpen(false)}
        onDeleted={signOut}
      />

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
                        await api.deleteDestination(item.id);
                        refreshDestinations();
                      } catch (e: any) {
                        Alert.alert('Could not delete', e?.message ?? 'unknown');
                      }
                    }}
                  >
                    <Text style={styles.destDeleteText}>Delete</Text>
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
                <Text style={styles.saveDestBtnText}>Save</Text>
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

function formatTimestampAge(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  return formatAge(secs);
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.surface.background },
    spotMarker: {
      width: 10,
      height: 10,
      borderRadius: 5,
      borderWidth: 1.5,
      borderColor: colors.surface.card,
      shadowColor: colors.shadow,
      shadowOpacity: 0.18,
      shadowRadius: 2,
      elevation: 2,
    },
    spotMarkerAvailable: { backgroundColor: colors.status.success },
    spotMarkerTaken: { backgroundColor: colors.status.danger, opacity: 0.5 },
    spotMarkerUnknown: { backgroundColor: colors.text.tertiary, opacity: 0.55 },
    spotMarkerLocked: { backgroundColor: colors.status.locked },
    spotMarkerMine: { backgroundColor: colors.status.warning },
    verifyBanner: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      zIndex: 10,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      backgroundColor: colors.brand.primary,
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    verifyBannerText: { flex: 1, color: colors.brand.primaryText, fontSize: 13 },
    verifyBannerAction: { color: colors.brand.primaryText, fontSize: 13, fontWeight: '700' },
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
      backgroundColor: colors.surface.card,
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 24,
      shadowColor: colors.shadow,
      shadowOpacity: 0.15,
      shadowRadius: 6,
      elevation: 4,
    },
    searchInput: {
      flex: 1,
      fontSize: 15,
      paddingVertical: 6,
      color: colors.text.primary,
    },
    searchDropdown: {
      backgroundColor: colors.surface.card,
      borderRadius: 12,
      padding: 4,
      shadowColor: colors.shadow,
      shadowOpacity: 0.15,
      shadowRadius: 6,
      elevation: 4,
    },
    searchResultRow: {
      padding: 12,
      borderRadius: 8,
    },
    searchResultText: { fontSize: 14, color: colors.text.primary },
    targetPill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      alignSelf: 'flex-start',
      maxWidth: '90%',
      backgroundColor: colors.brand.primary,
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 24,
      shadowColor: colors.shadow,
      shadowOpacity: 0.15,
      shadowRadius: 6,
      elevation: 4,
    },
    targetPillText: { color: colors.text.inverse, fontWeight: '600', flexShrink: 1 },
    targetPillClear: { color: colors.text.inverse, fontWeight: '700', paddingLeft: 6 },
    actionRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'flex-end',
      gap: 6,
    },
    chip: {
      backgroundColor: colors.surface.card,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 24,
      shadowColor: colors.shadow,
      shadowOpacity: 0.15,
      shadowRadius: 6,
      elevation: 4,
    },
    chipDisabled: { opacity: 0.6 },
    chipText: { color: colors.text.secondary, fontWeight: '600' },
    bestCard: {
      position: 'absolute',
      left: 12,
      right: 12,
      bottom: 78,
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.surface.card,
      padding: 12,
      borderRadius: 12,
      shadowColor: colors.shadow,
      shadowOpacity: 0.2,
      shadowRadius: 8,
      elevation: 6,
      gap: 8,
    },
    bestLabel: { fontSize: 12, opacity: 0.6, color: colors.text.primary },
    bestTitle: { fontSize: 16, fontWeight: '700', color: colors.text.primary },
    bestMeta: { fontSize: 12, opacity: 0.7, color: colors.text.primary },
    bestActions: { flexDirection: 'row', gap: 6 },
    smallBtn: {
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 8,
      backgroundColor: colors.status.warning,
    },
    smallBtnPrimary: { backgroundColor: colors.brand.primary },
    smallBtnText: { color: colors.text.inverse, fontWeight: '700' },
    statusBar: {
      position: 'absolute',
      bottom: 24,
      left: 12,
      right: 12,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      backgroundColor: colors.surface.card,
      padding: 12,
      borderRadius: 12,
      shadowColor: colors.shadow,
      shadowOpacity: 0.15,
      shadowRadius: 6,
      elevation: 4,
    },
    statusText: { fontSize: 14, color: colors.text.primary },
    attribText: { fontSize: 10, color: colors.text.tertiary, marginTop: 2 },
    modalBackdrop: {
      flex: 1,
      backgroundColor: colors.surface.overlay,
      justifyContent: 'flex-end',
    },
    card: {
      backgroundColor: colors.surface.card,
      padding: 24,
      borderTopLeftRadius: 16,
      borderTopRightRadius: 16,
    },
    cardTitle: { fontSize: 20, fontWeight: '700', marginBottom: 4, color: colors.text.primary },
    cardStreet: { fontSize: 14, opacity: 0.75, marginBottom: 8, color: colors.text.primary },
    cardMeta: { fontSize: 14, marginBottom: 4, color: colors.text.primary },
    navBtn: {
      marginTop: 12,
      backgroundColor: colors.brand.primary,
      padding: 14,
      borderRadius: 8,
      alignItems: 'center',
    },
    navBtnText: { color: colors.text.inverse, fontWeight: '700', fontSize: 16 },
    refreshSensorBtn: {
      marginTop: 12,
      backgroundColor: colors.surface.pill,
      padding: 14,
      borderRadius: 8,
      alignItems: 'center',
    },
    refreshSensorBtnText: { color: colors.text.secondary, fontWeight: '700', fontSize: 16 },
    parkBtn: {
      marginTop: 12,
      backgroundColor: colors.status.success,
      padding: 14,
      borderRadius: 8,
      alignItems: 'center',
    },
    parkBtnText: { color: colors.text.inverse, fontWeight: '700', fontSize: 16 },
    lockBtn: {
      marginTop: 12,
      backgroundColor: colors.status.warning,
      padding: 14,
      borderRadius: 8,
      alignItems: 'center',
    },
    lockBtnText: { color: colors.text.inverse, fontWeight: '700', fontSize: 16 },
    filterRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginTop: 12,
    },
    filterName: { fontSize: 15, fontWeight: '600', color: colors.text.primary },
    filterHint: { fontSize: 12, opacity: 0.6, marginTop: 2, color: colors.text.primary },
    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
    pill: {
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 999,
      backgroundColor: colors.surface.pill,
    },
    pillActive: { backgroundColor: colors.brand.primary },
    pillText: { fontWeight: '600', color: colors.text.secondary },
    pillTextActive: { color: colors.text.inverse },
    destRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 10,
      borderBottomWidth: 1,
      borderBottomColor: colors.border.subtle,
    },
    destName: { fontSize: 16, fontWeight: '600', color: colors.text.primary },
    destMeta: { fontSize: 12, opacity: 0.6, marginTop: 2, color: colors.text.primary },
    destDelete: { padding: 8 },
    destDeleteText: { color: colors.status.danger },
    destAddRow: {
      flexDirection: 'row',
      marginTop: 16,
      gap: 8,
    },
    destInput: {
      flex: 1,
      borderWidth: 1,
      borderColor: colors.border.default,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      color: colors.text.primary,
    },
    saveDestBtn: {
      backgroundColor: colors.status.success,
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderRadius: 8,
      alignItems: 'center',
      justifyContent: 'center',
    },
    saveDestBtnText: { color: colors.text.inverse, fontWeight: '700' },
  });
}
