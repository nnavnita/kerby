import AsyncStorage from '@react-native-async-storage/async-storage';
import { ThemeMode } from './theme/tokens';

const TOKEN_KEY = 'kerby.token';
const USER_KEY = 'kerby.user_id';
const THEME_KEY = 'kerby.theme';

export const storage = {
  async getToken(): Promise<string | null> {
    return AsyncStorage.getItem(TOKEN_KEY);
  },
  async setToken(token: string, userId: string): Promise<void> {
    await AsyncStorage.multiSet([
      [TOKEN_KEY, token],
      [USER_KEY, userId],
    ]);
  },
  async clear(): Promise<void> {
    await AsyncStorage.multiRemove([TOKEN_KEY, USER_KEY]);
  },
  async getThemeMode(): Promise<ThemeMode | null> {
    const v = await AsyncStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : null;
  },
  async setThemeMode(mode: ThemeMode): Promise<void> {
    await AsyncStorage.setItem(THEME_KEY, mode);
  },
};
