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
  type GroundEffect,
  type GroundPicture,
  type SurfaceStylePreference,
} from "../../design-system";
import { createExpoSecureStringStorage } from "../hosts/expoSecureStorage";
import { wallpaperFileExists } from "./wallpaperFile";
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
  readonly setPicture: (picture: Exclude<GroundPicture, "custom">) => Promise<void>;
  readonly setEffect: (effect: GroundEffect) => Promise<void>;
  readonly setColorSchemePreference: (preference: ColorSchemePreference) => Promise<void>;
  readonly setSurfaceStyle: (style: SurfaceStylePreference) => Promise<void>;
}

const AppearanceContext = createContext<AppearanceContextValue | undefined>(undefined);

export function AppearanceProvider(props: {
  readonly children: ReactNode;
  readonly store?: AppearanceStore;
}) {
  const store = useMemo(
    () =>
      props.store ??
      createAppearanceStore(createExpoSecureStringStorage({ persistWeb: true }), {
        fileExists: wallpaperFileExists,
      }),
    [props.store],
  );
  const [preferences, setPreferences] = useState<AppearancePreferences>(DEFAULT_APPEARANCE);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // A failed read of secure storage must not leave the app waiting on
    // `ready` forever; it falls back to the defaults already in state.
    void store
      .load()
      .then(
        (prefs) => {
          if (!cancelled) setPreferences(prefs);
        },
        () => undefined,
      )
      .then(() => {
        if (!cancelled) setReady(true);
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

  const setPicture = useCallback(
    async (picture: Exclude<GroundPicture, "custom">) => {
      const next = await store.setPicture(picture);
      setPreferences(next);
    },
    [store],
  );

  const setEffect = useCallback(
    async (effect: GroundEffect) => {
      const next = await store.setEffect(effect);
      setPreferences(next);
    },
    [store],
  );

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
      setPicture,
      setEffect,
      setColorSchemePreference,
      setSurfaceStyle,
    }),
    [
      preferences,
      ready,
      setCustomBackground,
      clearCustomBackground,
      setPicture,
      setEffect,
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
