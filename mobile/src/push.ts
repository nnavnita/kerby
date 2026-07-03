import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { api } from './api';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/// Register the current device with the backend so we can push lock-taken
/// and pre-expiry notifications. Silently no-ops on simulators / when the
/// user denies permission.
export async function registerForPush(authToken: string): Promise<void> {
  if (!Constants.isDevice) return;

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'default',
      importance: Notifications.AndroidImportance.DEFAULT,
      sound: 'default',
    });
  }

  const perm = await Notifications.getPermissionsAsync();
  let status = perm.status;
  if (status !== 'granted') {
    const req = await Notifications.requestPermissionsAsync();
    status = req.status;
  }
  if (status !== 'granted') return;

  const projectId =
    (Constants.expoConfig?.extra as any)?.eas?.projectId ??
    (Constants.easConfig as any)?.projectId;
  const push = await Notifications.getExpoPushTokenAsync(
    projectId ? { projectId } : undefined,
  );
  try {
    await api.setPushToken(authToken, push.data);
  } catch (e) {
    // Non-fatal — user can still use the app.
    console.warn('push token upload failed', e);
  }
}
