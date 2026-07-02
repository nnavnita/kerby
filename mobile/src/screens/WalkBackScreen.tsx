import React, { useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Location from 'expo-location';
import { SessionDto, api } from '../api';

type Props = {
  token: string;
  session: SessionDto;
  onReturned: () => void;
};

export function WalkBackScreen({ token, session, onReturned }: Props) {
  const [me, setMe] = useState<{ lat: number; lng: number } | null>(null);
  const [bearing, setBearing] = useState<number | null>(null);
  const [distance, setDistance] = useState<number | null>(null);

  useEffect(() => {
    let sub: Location.LocationSubscription | undefined;
    (async () => {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== 'granted') return;
      sub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.Balanced, distanceInterval: 2, timeInterval: 2_000 },
        (loc) => {
          const lat = loc.coords.latitude;
          const lng = loc.coords.longitude;
          setMe({ lat, lng });
          setDistance(haversineMeters(lat, lng, session.lat, session.lng));
          setBearing(bearingDeg(lat, lng, session.lat, session.lng));
        },
      );
    })();
    return () => {
      sub?.remove();
    };
  }, [session.lat, session.lng]);

  const markReturned = async () => {
    try {
      await api.returnSession(token, session.id);
      onReturned();
    } catch (e: any) {
      Alert.alert('Could not mark returned', e?.message ?? 'unknown');
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Walk back to your car</Text>
      {session.note && <Text style={styles.note}>{session.note}</Text>}

      <View style={styles.compassWrap}>
        <View
          style={[
            styles.arrow,
            { transform: [{ rotate: `${bearing ?? 0}deg` }] },
          ]}
        >
          <Text style={styles.arrowSymbol}>↑</Text>
        </View>
      </View>

      <Text style={styles.distance}>
        {distance == null ? '…' : `${Math.round(distance)} m`}
      </Text>
      <Text style={styles.hint}>Arrow points to your parked spot.</Text>

      <Pressable style={styles.doneBtn} onPress={markReturned}>
        <Text style={styles.doneBtnText}>I found my car</Text>
      </Pressable>
    </View>
  );
}

function toRad(d: number) {
  return (d * Math.PI) / 180;
}

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearingDeg(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const λ1 = toRad(lng1);
  const λ2 = toRad(lng2);
  const y = Math.sin(λ2 - λ1) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(λ2 - λ1);
  const θ = Math.atan2(y, x);
  return (θ * 180) / Math.PI;
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 24, fontWeight: '700', marginBottom: 8 },
  note: { fontSize: 14, opacity: 0.75, marginBottom: 24, textAlign: 'center' },
  compassWrap: {
    width: 200,
    height: 200,
    borderRadius: 100,
    borderWidth: 2,
    borderColor: '#1E88E5',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 24,
  },
  arrow: { width: 100, height: 100, alignItems: 'center', justifyContent: 'center' },
  arrowSymbol: { fontSize: 80, color: '#1E88E5' },
  distance: { fontSize: 48, fontWeight: '700', marginBottom: 8 },
  hint: { fontSize: 14, opacity: 0.6, marginBottom: 24 },
  doneBtn: {
    backgroundColor: '#1E88E5',
    paddingHorizontal: 32,
    paddingVertical: 16,
    borderRadius: 8,
  },
  doneBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
