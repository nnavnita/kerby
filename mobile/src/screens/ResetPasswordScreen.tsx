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
} from 'react-native';
import { api } from '../api';
import { ThemeColors } from '../theme/tokens';
import { useTheme } from '../theme/ThemeContext';

type Props = { token: string; onSuccess: () => void; onCancel: () => void };

export function ResetPasswordScreen({ token, onSuccess, onCancel }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await api.resetPassword(token, password);
      Alert.alert('Password updated', 'Sign in with your new password.');
      onSuccess();
    } catch (e: any) {
      Alert.alert('Could not reset password', e?.message ?? 'unknown error');
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
      <Text style={styles.subtitle}>Set a new password</Text>
      <TextInput
        style={styles.input}
        placeholder="New password"
        secureTextEntry
        value={password}
        onChangeText={setPassword}
      />
      <Pressable style={styles.button} disabled={busy} onPress={submit}>
        {busy ? (
          <ActivityIndicator color={colors.brand.primaryText} />
        ) : (
          <Text style={styles.buttonText}>Update password</Text>
        )}
      </Pressable>
      <Pressable onPress={onCancel}>
        <Text style={styles.switch}>Cancel</Text>
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
