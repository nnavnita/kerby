import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { LoginScreen } from './src/screens/LoginScreen';
import { MapScreen } from './src/screens/MapScreen';
import { NavigationScreen } from './src/screens/NavigationScreen';
import { WalkBackScreen } from './src/screens/WalkBackScreen';
import { Bay, SessionDto, api } from './src/api';
import { registerForPush } from './src/push';
import { storage } from './src/storage';

export default function App() {
  const [token, setToken] = useState<string | null>(null);
  const [session, setSession] = useState<SessionDto | null>(null);
  const [navTarget, setNavTarget] = useState<{ bay: Bay } | null>(null);
  const [bootstrapped, setBootstrapped] = useState(false);

  const refreshSession = useCallback(async (t: string) => {
    try {
      const s = await api.currentSession(t);
      setSession(s ?? null);
    } catch (e) {
      await storage.clear();
      setToken(null);
      setSession(null);
    }
  }, []);

  useEffect(() => {
    (async () => {
      const stored = await storage.getToken();
      if (stored) {
        setToken(stored);
        await refreshSession(stored);
        registerForPush(stored).catch(() => {});
      }
      setBootstrapped(true);
    })();
  }, [refreshSession]);

  if (!bootstrapped) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        <StatusBar style="auto" />
        {!token ? (
          <LoginScreen
            onSignedIn={async (t) => {
              setToken(t);
              await refreshSession(t);
              registerForPush(t).catch(() => {});
            }}
          />
        ) : session ? (
          <WalkBackScreen
            token={token}
            session={session}
            onReturned={() => setSession(null)}
          />
        ) : navTarget ? (
          <NavigationScreen
            token={token}
            target={navTarget}
            onCancel={() => setNavTarget(null)}
            onArrived={async () => {
              // Auto-open the "I parked here" flow: create a session at the
              // bay's coordinates, then close the nav screen. WalkBackScreen
              // takes over via the session state.
              try {
                await api.createSession(token, {
                  bay_id: navTarget.bay.id,
                  lat: navTarget.bay.lat,
                  lng: navTarget.bay.lng,
                  note: navTarget.bay.street ?? undefined,
                });
                await refreshSession(token);
              } finally {
                setNavTarget(null);
              }
            }}
          />
        ) : (
          <MapScreen
            token={token}
            onSignedOut={() => {
              setToken(null);
              setSession(null);
              setNavTarget(null);
            }}
            onSessionSaved={() => refreshSession(token)}
            onStartNav={(bay) => setNavTarget({ bay })}
          />
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
