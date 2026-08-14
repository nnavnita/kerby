import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import * as Linking from 'expo-linking';

import { LoginScreen } from './src/screens/LoginScreen';
import { MapScreen } from './src/screens/MapScreen';
import { NavigationScreen } from './src/screens/NavigationScreen';
import { WalkBackScreen } from './src/screens/WalkBackScreen';
import { ResetPasswordScreen } from './src/screens/ResetPasswordScreen';
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
  const [resetToken, setResetToken] = useState<string | null>(null);
  const [emailVerified, setEmailVerified] = useState(true);

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

  const refreshMe = useCallback(async () => {
    try {
      const me = await api.getMe();
      setEmailVerified(me.email_verified);
    } catch {
      // silent — banner just won't update this cycle
    }
  }, []);

  useEffect(() => {
    (async () => {
      await loadVoicePrefs();
      const stored = await storage.getAccessToken();
      if (stored) {
        setSignedIn(true);
        await refreshSession();
        await refreshMe();
        registerForPush().catch(() => {});
      }
      setBootstrapped(true);
    })();
  }, [refreshSession, refreshMe]);

  // Inbound kerby:// links — reset-password and verify-email both carry a
  // `token` query param. This is the first inbound handler for the scheme;
  // T3.3's share links only ever open kerby:// URLs in *other* apps.
  useEffect(() => {
    const handleUrl = (url: string) => {
      const { hostname, path, queryParams } = Linking.parse(url);
      const token = queryParams?.token;
      if (typeof token !== 'string') return;
      // Custom-scheme URLs (kerby://reset-password?...) put the route in
      // `hostname`. Expo-hosted URL forms (no custom scheme) leave
      // `hostname` null and put the route segment in `path` instead.
      const route = hostname ?? path?.replace(/^\/+/, '');
      if (route === 'reset-password') {
        setResetToken(token);
      } else if (route === 'verify-email') {
        api
          .verifyEmail(token)
          .then(() => setEmailVerified(true))
          .catch(() => {});
      }
    };
    Linking.getInitialURL().then((url) => {
      if (url) handleUrl(url);
    });
    const sub = Linking.addEventListener('url', ({ url }) => handleUrl(url));
    return () => sub.remove();
  }, []);

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

  if (resetToken) {
    return (
      <SafeAreaProvider>
        <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface.background }} edges={['top']}>
          <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
          <ResetPasswordScreen
            token={resetToken}
            onCancel={() => setResetToken(null)}
            onSuccess={async () => {
              // Password reset just revoked every refresh_tokens row for
              // this account server-side. If the user was signed in when
              // they went through this flow, the access/refresh tokens we
              // still hold are dead — land them on a clean signed-out login
              // screen rather than returning to the (now-broken) app.
              await storage.clear();
              setSignedIn(false);
              setSession(null);
              setResetToken(null);
            }}
          />
        </SafeAreaView>
      </SafeAreaProvider>
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
              await refreshMe();
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
            emailVerified={emailVerified}
            onResendVerification={() => api.resendVerification()}
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
