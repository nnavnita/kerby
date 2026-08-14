// Shared design tokens for Kerby. Screens should read colors from
// `useTheme()` (see ThemeContext.tsx) rather than hardcoding hex values.

export type ColorScheme = 'light' | 'dark';
export type ThemeMode = 'system' | 'light' | 'dark';

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };

export const radii = { sm: 8, md: 12, lg: 16, pill: 999 };

export const typography = {
  size: { xs: 10, sm: 12, base: 14, md: 15, lg: 16, xl: 20, xxl: 24, display: 40, huge: 80 },
  weight: { regular: '400', medium: '600', bold: '700' } as const,
};

export type ThemeColors = {
  brand: {
    primary: string;
    primaryText: string;
  };
  surface: {
    background: string;
    card: string;
    pill: string;
    overlay: string;
    selected: string;
  };
  text: {
    primary: string;
    secondary: string;
    tertiary: string;
    inverse: string;
  };
  border: {
    default: string;
    subtle: string;
  };
  // Status colors encode real-world bay state (locked/occupied/free/etc.)
  // and Kerby's brand color — both stay constant across light/dark mode so
  // they remain recognizable regardless of theme, the same way a traffic
  // light doesn't change hue at night.
  status: {
    success: string;
    danger: string;
    warning: string;
    locked: string;
    neutral: string;
    info: string;
  };
  shadow: string;
};

const status = {
  success: '#2E7D32',
  danger: '#C62828',
  warning: '#F9A825',
  locked: '#7B1FA2',
  neutral: '#8A8A8A',
  info: '#1565C0',
};

const brand = {
  primary: '#1E88E5',
  primaryText: '#fff',
};

export const lightColors: ThemeColors = {
  brand,
  surface: {
    background: '#fff',
    card: '#fff',
    pill: '#F0F0F0',
    overlay: 'rgba(0,0,0,0.25)',
    selected: '#E3F2FD',
  },
  text: {
    primary: '#111111',
    secondary: '#333333',
    tertiary: '#777777',
    inverse: '#fff',
  },
  border: {
    default: '#d0d0d0',
    subtle: '#eeeeee',
  },
  status,
  shadow: '#000',
};

export const darkColors: ThemeColors = {
  brand,
  surface: {
    background: '#121212',
    card: '#1E1E1E',
    pill: '#2C2C2E',
    overlay: 'rgba(0,0,0,0.5)',
    selected: '#123A5E',
  },
  text: {
    primary: '#F2F2F2',
    secondary: '#CCCCCC',
    tertiary: '#9A9A9A',
    inverse: '#fff',
  },
  border: {
    default: '#3A3A3C',
    subtle: '#2C2C2E',
  },
  status,
  shadow: '#000',
};

export const themes: Record<ColorScheme, ThemeColors> = {
  light: lightColors,
  dark: darkColors,
};
