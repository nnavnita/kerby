import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as Speech from 'expo-speech';
import {
  DEFAULT_VOICE_PREFS,
  RATE_PRESETS,
  SUPPORTED_LANGUAGES,
  VoicePrefs,
  getVoicePrefs,
  saveVoicePrefs,
  speak,
} from '../voice';

type Props = {
  visible: boolean;
  onClose: () => void;
};

type VoiceEntry = Speech.Voice & { identifier: string; name: string; language: string };

const PREVIEW_TEXT = 'In 200 meters, turn left onto Bourke Street.';

export function VoiceSettingsModal({ visible, onClose }: Props) {
  const [prefs, setPrefs] = useState<VoicePrefs>(getVoicePrefs());
  const [voices, setVoices] = useState<VoiceEntry[]>([]);
  const [loadingVoices, setLoadingVoices] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setPrefs(getVoicePrefs());
    (async () => {
      setLoadingVoices(true);
      try {
        const list = await Speech.getAvailableVoicesAsync();
        setVoices(list as VoiceEntry[]);
      } catch {
        setVoices([]);
      } finally {
        setLoadingVoices(false);
      }
    })();
  }, [visible]);

  const voicesForLanguage = useMemo(
    () =>
      voices
        .filter((v) => v.language?.toLowerCase() === prefs.language.toLowerCase())
        .sort((a, b) => a.name.localeCompare(b.name)),
    [voices, prefs.language],
  );

  const update = useCallback(
    (patch: Partial<VoicePrefs>) => setPrefs((p) => ({ ...p, ...patch })),
    [],
  );

  const preview = useCallback(() => {
    Speech.stop();
    Speech.speak(PREVIEW_TEXT, {
      language: prefs.language,
      voice: prefs.voice,
      rate: prefs.rate,
      pitch: prefs.pitch,
    });
  }, [prefs.language, prefs.voice, prefs.rate, prefs.pitch]);

  const save = useCallback(async () => {
    await saveVoicePrefs(prefs);
    Speech.stop();
    speak('Voice saved.');
    onClose();
  }, [prefs, onClose]);

  const resetToDefaults = useCallback(() => {
    setPrefs(DEFAULT_VOICE_PREFS);
  }, []);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.card} onPress={(e) => e.stopPropagation()}>
          <View style={styles.header}>
            <Text style={styles.title}>Voice</Text>
            <Pressable onPress={resetToDefaults}>
              <Text style={styles.link}>Reset</Text>
            </Pressable>
          </View>

          <ScrollView style={{ maxHeight: 480 }}>
            <Text style={styles.section}>Language</Text>
            <View style={styles.pillRow}>
              {SUPPORTED_LANGUAGES.map((l) => (
                <Pressable
                  key={l.code}
                  style={[
                    styles.pill,
                    prefs.language === l.code && styles.pillActive,
                  ]}
                  onPress={() =>
                    update({ language: l.code, voice: undefined })
                  }
                >
                  <Text
                    style={[
                      styles.pillText,
                      prefs.language === l.code && styles.pillTextActive,
                    ]}
                  >
                    {l.label}
                  </Text>
                </Pressable>
              ))}
            </View>

            <Text style={styles.section}>Voice</Text>
            {loadingVoices ? (
              <ActivityIndicator size="small" />
            ) : voicesForLanguage.length === 0 ? (
              <Text style={styles.hint}>
                No system voices found for {prefs.language}. The device
                default will be used.
              </Text>
            ) : (
              <View style={styles.voiceList}>
                <Pressable
                  style={[
                    styles.voiceRow,
                    !prefs.voice && styles.voiceRowActive,
                  ]}
                  onPress={() => update({ voice: undefined })}
                >
                  <Text style={styles.voiceName}>System default</Text>
                </Pressable>
                <FlatList
                  data={voicesForLanguage}
                  keyExtractor={(v) => v.identifier}
                  scrollEnabled={false}
                  renderItem={({ item }) => {
                    const active = prefs.voice === item.identifier;
                    return (
                      <Pressable
                        style={[styles.voiceRow, active && styles.voiceRowActive]}
                        onPress={() => update({ voice: item.identifier })}
                      >
                        <Text style={styles.voiceName}>{item.name}</Text>
                        <Text style={styles.voiceMeta}>
                          {item.quality ?? ''}
                        </Text>
                      </Pressable>
                    );
                  }}
                />
              </View>
            )}

            <Text style={styles.section}>Speed</Text>
            <View style={styles.pillRow}>
              {RATE_PRESETS.map((r) => (
                <Pressable
                  key={r.label}
                  style={[
                    styles.pill,
                    Math.abs(prefs.rate - r.value) < 0.02 && styles.pillActive,
                  ]}
                  onPress={() => update({ rate: r.value })}
                >
                  <Text
                    style={[
                      styles.pillText,
                      Math.abs(prefs.rate - r.value) < 0.02 &&
                        styles.pillTextActive,
                    ]}
                  >
                    {r.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          </ScrollView>

          <View style={styles.footer}>
            <Pressable style={styles.previewBtn} onPress={preview}>
              <Text style={styles.previewBtnText}>Preview</Text>
            </Pressable>
            <Pressable style={styles.saveBtn} onPress={save}>
              <Text style={styles.saveBtnText}>Save</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
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
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  title: { fontSize: 20, fontWeight: '700' },
  link: { color: '#1E88E5', fontWeight: '600' },
  section: {
    fontSize: 13,
    fontWeight: '600',
    color: '#333',
    marginTop: 16,
    marginBottom: 8,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  pill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: '#F0F0F0',
  },
  pillActive: { backgroundColor: '#1E88E5' },
  pillText: { color: '#333', fontWeight: '600' },
  pillTextActive: { color: '#fff' },
  hint: { fontSize: 13, color: '#666' },
  voiceList: {
    borderRadius: 8,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#eee',
  },
  voiceRow: {
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  voiceRowActive: { backgroundColor: '#E3F2FD' },
  voiceName: { fontSize: 15 },
  voiceMeta: { fontSize: 12, color: '#888' },
  footer: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 16,
  },
  previewBtn: {
    flex: 1,
    backgroundColor: '#F0F0F0',
    padding: 14,
    borderRadius: 8,
    alignItems: 'center',
  },
  previewBtnText: { fontSize: 15, fontWeight: '700', color: '#333' },
  saveBtn: {
    flex: 1,
    backgroundColor: '#2E7D32',
    padding: 14,
    borderRadius: 8,
    alignItems: 'center',
  },
  saveBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
});
