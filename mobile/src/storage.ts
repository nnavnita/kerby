import AsyncStorage from '@react-native-async-storage/async-storage';

const TOKEN_KEY = 'kerby.token';
const USER_KEY = 'kerby.user_id';

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
};
