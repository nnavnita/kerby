import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { LoginScreen } from './src/screens/LoginScreen';
import { MapScreen } from './src/screens/MapScreen';
import { NavigationScreen } from './src/screens/NavigationScreen';
import { WalkBackScreen } from './src/screens/WalkBackScreen';
import { ApiError, Bay, SessionDto, api, setOnAuthLost } from './src/api';
import { registerForPush } from './src/push';
import { storage } from './src/storage';
import { loadVoicePrefs } from './src/voice';
import { ThemeProvider, useTheme } from './src/theme/ThemeContext';

export default function App() {
  return (
    <ThemeProvider>
      <AppInner />
    </ThemeProvider>
  );
}

function AppInner() {
  const { colors, scheme } = useTheme();
  const [signedIn, setSignedIn] = useState(false);
  const [session, setSession] = useState<SessionDto | null>(null);
  const [navTarget, setNavTarget] = useState<{ bay: Bay } | null>(null);
  const [bootstrapped, setBootstrapped] = useState(false);

  const refreshSession = useCallback(async () => {
    try {
      const s = await api.currentSession();
      setSession(s ?? null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        await storage.clear();
        setSignedIn(false);
        setSession(null);
      }
    }
  }, []);

  useEffect(() => {
    (async () => {
      await loadVoicePrefs();
      const stored = await storage.getAccessToken();
      if (stored) {
        setSignedIn(true);
        await refreshSession();
        registerForPush().catch(() => {});
      }
      setBootstrapped(true);
    })();
  }, [refreshSession]);

  const signOut = useCallback(async () => {
    const refreshToken = await storage.getRefreshToken();
    if (refreshToken) {
      await api.logout(refreshToken).catch(() => {});
    }
    await storage.clear();
    setSignedIn(false);
    setSession(null);
    setNavTarget(null);
  }, []);

  useEffect(() => {
    setOnAuthLost(() => {
      signOut();
    });
    return () => setOnAuthLost(null);
  }, [signOut]);

  if (!bootstrapped) {
    return (
      <View style={[styles.centered, { backgroundColor: colors.surface.background }]}>
        <ActivityIndicator size="large" color={colors.brand.primary} />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface.background }} edges={['top']}>
        <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
        {!signedIn ? (
          <LoginScreen
            onSignedIn={async () => {
              setSignedIn(true);
              await refreshSession();
              registerForPush().catch(() => {});
            }}
          />
        ) : session ? (
          <WalkBackScreen
            session={session}
            onReturned={() => setSession(null)}
          />
        ) : navTarget ? (
          <NavigationScreen
            target={navTarget}
            onCancel={() => setNavTarget(null)}
            onArrived={async () => {
              // Auto-open the "I parked here" flow: create a session at the
              // bay's coordinates, then close the nav screen. WalkBackScreen
              // takes over via the session state.
              try {
                await api.createSession({
                  bay_id: navTarget.bay.id,
                  lat: navTarget.bay.lat,
                  lng: navTarget.bay.lng,
                  note: navTarget.bay.street ?? undefined,
                });
                await refreshSession();
              } finally {
                setNavTarget(null);
              }
            }}
          />
        ) : (
          <MapScreen
            onSignedOut={signOut}
            onSessionSaved={() => refreshSession()}
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
