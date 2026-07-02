import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { LoginScreen } from './src/screens/LoginScreen';
import { MapScreen } from './src/screens/MapScreen';
import { WalkBackScreen } from './src/screens/WalkBackScreen';
import { SessionDto, api } from './src/api';
import { storage } from './src/storage';

export default function App() {
  const [token, setToken] = useState<string | null>(null);
  const [session, setSession] = useState<SessionDto | null>(null);
  const [bootstrapped, setBootstrapped] = useState(false);

  const refreshSession = useCallback(async (t: string) => {
    try {
      const s = await api.currentSession(t);
      setSession(s ?? null);
    } catch (e) {
      // If token is invalid, sign out.
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
            }}
          />
        ) : session ? (
          <WalkBackScreen
            token={token}
            session={session}
            onReturned={() => setSession(null)}
          />
        ) : (
          <MapScreen
            token={token}
            onSignedOut={() => {
              setToken(null);
              setSession(null);
            }}
            onSessionSaved={() => refreshSession(token)}
          />
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
