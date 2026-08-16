import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  ThemeProvider,
  type ColorSchemePreference,
  type SurfaceStylePreference,
} from "../../design-system";
import { createExpoSecureStringStorage } from "../hosts/expoSecureStorage";
import {
  createAppearanceStore,
  DEFAULT_APPEARANCE,
  type AppearancePreferences,
  type AppearanceStore,
} from "./AppearanceStore";

export interface AppearanceContextValue {
  readonly preferences: AppearancePreferences;
  readonly ready: boolean;
  readonly setCustomBackground: (dataUri: string) => Promise<void>;
  readonly clearCustomBackground: () => Promise<void>;
  readonly useCodeGradient: () => Promise<void>;
  readonly setColorSchemePreference: (preference: ColorSchemePreference) => Promise<void>;
  readonly setSurfaceStyle: (style: SurfaceStylePreference) => Promise<void>;
}

const AppearanceContext = createContext<AppearanceContextValue | undefined>(undefined);

export function AppearanceProvider(props: {
  readonly children: ReactNode;
  readonly store?: AppearanceStore;
}) {
  const store = useMemo(
    () => props.store ?? createAppearanceStore(createExpoSecureStringStorage()),
    [props.store],
  );
  const [preferences, setPreferences] = useState<AppearancePreferences>(DEFAULT_APPEARANCE);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void store.load().then((prefs) => {
      if (cancelled) return;
      setPreferences(prefs);
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [store]);

  const setCustomBackground = useCallback(
    async (dataUri: string) => {
      const next = await store.saveCustomImage(dataUri);
      setPreferences(next);
    },
    [store],
  );

  const clearCustomBackground = useCallback(async () => {
    const next = await store.clearCustomImage();
    setPreferences(next);
  }, [store]);

  const useCodeGradient = useCallback(async () => {
    await clearCustomBackground();
  }, [clearCustomBackground]);

  const setColorSchemePreference = useCallback(
    async (preference: ColorSchemePreference) => {
      const next = await store.setColorSchemePreference(preference);
      setPreferences(next);
    },
    [store],
  );

  const setSurfaceStyle = useCallback(
    async (style: SurfaceStylePreference) => {
      const next = await store.setSurfaceStyle(style);
      setPreferences(next);
    },
    [store],
  );

  const value = useMemo(
    () => ({
      preferences,
      ready,
      setCustomBackground,
      clearCustomBackground,
      useCodeGradient,
      setColorSchemePreference,
      setSurfaceStyle,
    }),
    [
      preferences,
      ready,
      setCustomBackground,
      clearCustomBackground,
      useCodeGradient,
      setColorSchemePreference,
      setSurfaceStyle,
    ],
  );

  return (
    <AppearanceContext.Provider value={value}>
      <ThemeProvider
        preference={preferences.colorSchemePreference}
        surfaceStyle={preferences.surfaceStyle}
      >
        {props.children}
      </ThemeProvider>
    </AppearanceContext.Provider>
  );
}

export function useAppearance(): AppearanceContextValue {
  const value = useContext(AppearanceContext);
  if (value === undefined) {
    throw new Error("useAppearance requires AppearanceProvider.");
  }
  return value;
}
