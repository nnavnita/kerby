import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Speech from 'expo-speech';

const STORAGE_KEY = 'kerby.voice';

export type VoicePrefs = {
  language: string;
  voice?: string;
  rate: number;
  pitch: number;
};

export const DEFAULT_VOICE_PREFS: VoicePrefs = {
  language: 'en-AU',
  voice: undefined,
  rate: 0.95,
  pitch: 1.0,
};

/// Available English-speaking locales the user can pick between. Kept small
/// so the settings UI stays scannable.
export const SUPPORTED_LANGUAGES: Array<{ code: string; label: string }> = [
  { code: 'en-AU', label: 'English (Australia)' },
  { code: 'en-GB', label: 'English (UK)' },
  { code: 'en-US', label: 'English (US)' },
  { code: 'en-NZ', label: 'English (New Zealand)' },
  { code: 'en-IE', label: 'English (Ireland)' },
  { code: 'en-IN', label: 'English (India)' },
  { code: 'en-CA', label: 'English (Canada)' },
  { code: 'en-ZA', label: 'English (South Africa)' },
];

export const RATE_PRESETS: Array<{ label: string; value: number }> = [
  { label: 'Slower', value: 0.85 },
  { label: 'Normal', value: 0.95 },
  { label: 'Faster', value: 1.1 },
];

let cache: VoicePrefs = DEFAULT_VOICE_PREFS;
let loaded = false;

/// Warm the in-memory cache from AsyncStorage. Call once at app bootstrap.
export async function loadVoicePrefs(): Promise<VoicePrefs> {
  if (loaded) return cache;
  loaded = true;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<VoicePrefs>;
      cache = {
        ...DEFAULT_VOICE_PREFS,
        ...parsed,
      };
    }
  } catch {
    // Storage errors fall back to defaults silently.
  }
  return cache;
}

export function getVoicePrefs(): VoicePrefs {
  return cache;
}

export async function saveVoicePrefs(prefs: VoicePrefs): Promise<void> {
  cache = prefs;
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}

/// Speak a string using the current voice preferences.
export function speak(text: string, override?: Partial<Speech.SpeechOptions>): void {
  const p = cache;
  Speech.speak(text, {
    language: p.language,
    voice: p.voice,
    rate: p.rate,
    pitch: p.pitch,
    ...override,
  });
}

export function stopSpeaking(): void {
  Speech.stop();
}
