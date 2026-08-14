import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { api } from '../api';
import { storage } from '../storage';
import { ThemeColors } from '../theme/tokens';
import { useTheme } from '../theme/ThemeContext';

type Props = { onSignedIn: (token: string) => void };

export function LoginScreen({ onSignedIn }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      const resp =
        mode === 'login' ? await api.login(email, password) : await api.signup(email, password);
      await storage.setToken(resp.token, resp.user_id);
      onSignedIn(resp.token);
    } catch (e: any) {
      Alert.alert('Sign-in failed', e?.message ?? 'unknown error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Text style={styles.title}>Kerby</Text>
      <Text style={styles.subtitle}>
        {mode === 'login' ? 'Sign in' : 'Create account'}
      </Text>
      <TextInput
        style={styles.input}
        placeholder="Email"
        autoCapitalize="none"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />
      <TextInput
        style={styles.input}
        placeholder="Password"
        secureTextEntry
        value={password}
        onChangeText={setPassword}
      />
      <Pressable style={styles.button} disabled={busy} onPress={submit}>
        {busy ? (
          <ActivityIndicator color={colors.brand.primaryText} />
        ) : (
          <Text style={styles.buttonText}>
            {mode === 'login' ? 'Sign in' : 'Create account'}
          </Text>
        )}
      </Pressable>
      <Pressable onPress={() => setMode(mode === 'login' ? 'signup' : 'login')}>
        <Text style={styles.switch}>
          {mode === 'login' ? 'New here? Create account' : 'Already have an account? Sign in'}
        </Text>
      </Pressable>
    </KeyboardAvoidingView>
  );
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: { flex: 1, padding: 24, justifyContent: 'center', backgroundColor: colors.surface.background },
    title: { fontSize: 40, fontWeight: '700', textAlign: 'center', marginBottom: 4, color: colors.text.primary },
    subtitle: { fontSize: 16, textAlign: 'center', marginBottom: 24, opacity: 0.7, color: colors.text.primary },
    input: {
      borderWidth: 1,
      borderColor: colors.border.default,
      borderRadius: 8,
      padding: 14,
      marginBottom: 12,
      fontSize: 16,
      color: colors.text.primary,
    },
    button: {
      backgroundColor: colors.brand.primary,
      padding: 16,
      borderRadius: 8,
      alignItems: 'center',
      marginTop: 8,
    },
    buttonText: { color: colors.brand.primaryText, fontSize: 16, fontWeight: '600' },
    switch: { color: colors.brand.primary, textAlign: 'center', marginTop: 16 },
  });
}
