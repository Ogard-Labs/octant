import { DEFAULT_THEME_SETTINGS, type ThemeSettings } from "@octant/contracts/theme";
import {
  createThemeClient,
  ThemeClientFailure,
  type ThemeClient,
} from "@octant/client-runtime/theme-client";
import { importThemeSettings, serializeOctantTheme } from "@octant/theme/import";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type ThemeControllerStatus = "loading" | "ready" | "unavailable" | "conflict";

export interface ThemeController {
  readonly status: ThemeControllerStatus;
  readonly settings: ThemeSettings | undefined;
  readonly draft: ThemeSettings | undefined;
  readonly version: number;
  readonly error: string | undefined;
  readonly hasDraftChanges: boolean;
  readonly updateDraft: (patch: Partial<ThemeSettings>) => void;
  readonly apply: () => Promise<boolean>;
  readonly cancel: () => void;
  readonly reset: () => void;
  readonly importJson: (value: string) => void;
  readonly exportJson: () => string | undefined;
}

export function useThemeController(options: {
  readonly client?: ThemeClient;
  readonly serverUrl: string;
  readonly windowCapability: string;
}): ThemeController {
  const client = useMemo(
    () =>
      options.client ??
      createThemeClient({
        baseUrl: options.serverUrl,
        fetch: globalThis.fetch,
        windowCapability: options.windowCapability,
      }),
    [options.client, options.serverUrl, options.windowCapability],
  );
  const [status, setStatus] = useState<ThemeControllerStatus>("loading");
  const [settings, setSettings] = useState<ThemeSettings>();
  const [draft, setDraft] = useState<ThemeSettings>();
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string>();
  const mounted = useRef(true);

  const load = useCallback(async () => {
    setStatus("loading");
    try {
      const bootstrap = await client.bootstrap();
      if (!mounted.current) return;
      setSettings(bootstrap.settings);
      setDraft(bootstrap.settings);
      setVersion(bootstrap.version);
      setError(undefined);
      setStatus("ready");
    } catch (cause) {
      if (!mounted.current) return;
      setStatus("unavailable");
      setError(cause instanceof Error ? cause.message : "Appearance settings are unavailable.");
    }
  }, [client]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  const updateDraft = useCallback((patch: Partial<ThemeSettings>) => {
    setDraft((current) => (current === undefined ? undefined : { ...current, ...patch }));
  }, []);

  const apply = useCallback(async () => {
    if (settings === undefined || draft === undefined) return false;
    try {
      const result = await client.execute({
        kind: "update-theme-settings",
        settings: draft,
        expectedVersion: version as never,
      });
      if (!mounted.current) return false;
      setSettings(result.settings);
      setDraft(result.settings);
      setVersion(result.version);
      setStatus("ready");
      setError(undefined);
      return true;
    } catch (cause) {
      if (!mounted.current) return false;
      if (cause instanceof ThemeClientFailure && cause.category === "conflict") {
        setStatus("conflict");
        setError(cause.message);
        void load();
      } else {
        setStatus("unavailable");
        setError(
          cause instanceof Error ? cause.message : "Appearance settings could not be applied.",
        );
      }
      return false;
    }
  }, [client, draft, load, settings, version]);

  const cancel = useCallback(() => {
    if (settings === undefined) return;
    setDraft(settings);
    setError(undefined);
    setStatus("ready");
  }, [settings]);

  const reset = useCallback(() => {
    setDraft(DEFAULT_THEME_SETTINGS);
    setError(undefined);
  }, []);

  const importJson = useCallback((value: string) => {
    if (value.length > 256_000) {
      setError("Theme import is too large. Use a JSON file smaller than 256 KB.");
      return;
    }
    try {
      setDraft(importThemeSettings(JSON.parse(value)));
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Theme import is invalid.");
    }
  }, []);

  const exportJson = useCallback(
    () => (settings === undefined ? undefined : serializeOctantTheme(draft ?? settings)),
    [draft, settings],
  );
  const hasDraftChanges =
    settings !== undefined &&
    draft !== undefined &&
    JSON.stringify(settings) !== JSON.stringify(draft);
  return {
    status,
    settings,
    draft,
    version,
    error,
    hasDraftChanges,
    updateDraft,
    apply,
    cancel,
    reset,
    importJson,
    exportJson,
  };
}
