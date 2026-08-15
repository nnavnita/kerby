import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useColorScheme } from 'react-native';
import { storage } from '../storage';
import { ColorScheme, ThemeColors, ThemeMode, radii, spacing, themes, typography } from './tokens';

export type ThemeContextValue = {
  mode: ThemeMode;
  scheme: ColorScheme;
  colors: ThemeColors;
  spacing: typeof spacing;
  radii: typeof radii;
  typography: typeof typography;
  setMode: (mode: ThemeMode) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme() must be used within ThemeProvider');
  return ctx;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const systemScheme = useColorScheme();
  const [mode, setModeState] = useState<ThemeMode>('system');

  useEffect(() => {
    (async () => {
      const stored = await storage.getThemeMode();
      if (stored) setModeState(stored);
    })();
  }, []);

  const setMode = (next: ThemeMode) => {
    setModeState(next);
    storage.setThemeMode(next).catch(() => {});
  };

  const scheme: ColorScheme = mode === 'system' ? systemScheme ?? 'light' : mode;
  const colors = themes[scheme];

  const value = useMemo<ThemeContextValue>(
    () => ({ mode, scheme, colors, spacing, radii, typography, setMode }),
    [mode, scheme, colors],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
