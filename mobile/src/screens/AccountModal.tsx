import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { api, ApiError } from '../api';
import { ThemeColors } from '../theme/tokens';
import { useTheme } from '../theme/ThemeContext';

type Props = {
  visible: boolean;
  onClose: () => void;
  onDeleted: () => void;
};

export function AccountModal({ visible, onClose, onDeleted }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setPassword('');
    setError(null);
    setBusy(false);
  };

  const close = () => {
    reset();
    onClose();
  };

  const confirmDelete = () => {
    Alert.alert(
      'Delete account?',
      'This permanently deletes your account and all your data. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: doDelete },
      ],
    );
  };

  const doDelete = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.deleteAccount(password);
      reset();
      onDeleted();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
      <Pressable style={styles.backdrop} onPress={close}>
        <Pressable style={styles.card} onPress={(e) => e.stopPropagation()}>
          <View style={styles.header}>
            <Text style={styles.title}>Account</Text>
          </View>

          <Text style={styles.section}>Delete account</Text>
          <Text style={styles.hint}>
            Enter your password to permanently delete your account and all
            your data.
          </Text>
          <TextInput
            style={styles.input}
            placeholder="Password"
            secureTextEntry
            value={password}
            onChangeText={setPassword}
          />
          {error && <Text style={styles.error}>{error}</Text>}
          <Pressable
            style={styles.deleteBtn}
            disabled={busy || !password}
            onPress={confirmDelete}
          >
            {busy ? (
              <ActivityIndicator color={colors.brand.primaryText} />
            ) : (
              <Text style={styles.deleteBtnText}>Delete account</Text>
            )}
          </Pressable>

          <Pressable onPress={close}>
            <Text style={styles.link}>Cancel</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    backdrop: {
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
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 8,
    },
    title: { fontSize: 20, fontWeight: '700', color: colors.text.primary },
    link: { color: colors.brand.primary, fontWeight: '600', textAlign: 'center', marginTop: 16 },
    section: {
      fontSize: 13,
      fontWeight: '600',
      color: colors.text.secondary,
      marginTop: 16,
      marginBottom: 4,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    hint: { fontSize: 13, color: colors.text.tertiary, marginBottom: 12 },
    input: {
      borderWidth: 1,
      borderColor: colors.border.default,
      borderRadius: 8,
      padding: 14,
      marginBottom: 8,
      fontSize: 16,
      color: colors.text.primary,
    },
    error: { color: colors.status.danger, fontSize: 13, marginBottom: 8 },
    deleteBtn: {
      backgroundColor: colors.status.danger,
      padding: 14,
      borderRadius: 8,
      alignItems: 'center',
      marginTop: 4,
    },
    deleteBtnText: { color: colors.brand.primaryText, fontSize: 15, fontWeight: '700' },
  });
}
