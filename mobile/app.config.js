// Kerby Expo config. Reads secrets from environment (dotenv is loaded
// automatically by Expo CLI from mobile/.env). Committed to git; the
// real .env file is gitignored.

module.exports = () => ({
  expo: {
    name: 'Kerby',
    slug: 'kerby',
    version: '0.1.0',
    orientation: 'portrait',
    userInterfaceStyle: 'automatic',
    scheme: 'kerby',
    ios: {
      supportsTablet: false,
      bundleIdentifier: 'app.kerby.mobile',
      associatedDomains: ['applinks:kerby-api.fly.dev'],
      infoPlist: {
        NSLocationWhenInUseUsageDescription:
          'Kerby needs your location to find parking bays near you and guide you back to your car.',
      },
    },
    android: {
      package: 'app.kerby.mobile',
      adaptiveIcon: {
        backgroundColor: '#ffffff',
      },
      permissions: ['ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION'],
      intentFilters: [
        {
          action: 'VIEW',
          autoVerify: true,
          data: [
            {
              scheme: 'https',
              host: 'kerby-api.fly.dev',
              pathPrefix: '/share/bay',
            },
          ],
          category: ['BROWSABLE', 'DEFAULT'],
        },
        {
          action: 'VIEW',
          data: [{ scheme: 'kerby' }],
          category: ['BROWSABLE', 'DEFAULT'],
        },
      ],
    },
    web: {
      bundler: 'metro',
    },
    plugins: [
      [
        'expo-location',
        {
          locationAlwaysAndWhenInUsePermission:
            'Allow Kerby to use your location.',
        },
      ],
      'expo-notifications',
    ],
    extra: {
      apiBase: process.env.KERBY_API_BASE ?? 'http://localhost:8080',
      googleMapsKey: process.env.GOOGLE_MAPS_KEY ?? '',
      locationiqToken: process.env.LOCATIONIQ_TOKEN ?? '',
    },
  },
});
