import AsyncStorage from '@react-native-async-storage/async-storage';
import { ThemeMode } from './theme/tokens';

const ACCESS_TOKEN_KEY = 'kerby.access_token';
const REFRESH_TOKEN_KEY = 'kerby.refresh_token';
const USER_KEY = 'kerby.user_id';
const THEME_KEY = 'kerby.theme';

export const storage = {
  async getAccessToken(): Promise<string | null> {
    return AsyncStorage.getItem(ACCESS_TOKEN_KEY);
  },
  async getRefreshToken(): Promise<string | null> {
    return AsyncStorage.getItem(REFRESH_TOKEN_KEY);
  },
  async setTokens(accessToken: string, refreshToken: string, userId: string): Promise<void> {
    await AsyncStorage.multiSet([
      [ACCESS_TOKEN_KEY, accessToken],
      [REFRESH_TOKEN_KEY, refreshToken],
      [USER_KEY, userId],
    ]);
  },
  async clear(): Promise<void> {
    await AsyncStorage.multiRemove([ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY, USER_KEY]);
  },
  async getThemeMode(): Promise<ThemeMode | null> {
    const v = await AsyncStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : null;
  },
  async setThemeMode(mode: ThemeMode): Promise<void> {
    await AsyncStorage.setItem(THEME_KEY, mode);
  },
};
