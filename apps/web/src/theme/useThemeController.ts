import { DEFAULT_THEME_SETTINGS, type ThemeSettings } from "@octant/contracts/theme";
import {
  createThemeClient,
  ThemeClientFailure,
  type ThemeClient,
} from "@octant/client-runtime/theme-client";
import { importThemeSettings, serializeOctantTheme } from "@octant/theme/import";
import { exportThemeTokens, type ThemeExport, type ThemeExportFormat } from "@octant/theme/export";
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
  /** Save one change now, bypassing the draft the editor accumulates. */
  readonly applyPatch: (patch: Partial<ThemeSettings>) => Promise<boolean>;
  readonly cancel: () => void;
  readonly reset: () => void;
  readonly importJson: (value: string) => void;
  readonly exportJson: () => string | undefined;
  /**
   * The theme as design tokens for a project outside Octant, in the format the
   * project consumes. Undefined before the host has answered with a theme —
   * there is nothing to export until then.
   */
  readonly exportTokens: (format: ThemeExportFormat) => ThemeExport | undefined;
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
  const draftRef = useRef<ThemeSettings | undefined>(undefined);
  // A write carries the version it expects, so two of them started from the
  // same render both claim it and the server rejects the second as a conflict.
  // Which one survives would then be whichever arrived first, not the one the
  // user chose last. Writes queue, and each reads the version as it goes out.
  const versionRef = useRef(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  // A conflict means another window wrote these settings and the host reloaded
  // them. Anything already queued was composed from what this window held
  // before that, so sending it at the reloaded version would put the other
  // window's values back. Queued writes check this and stand down instead.
  const conflicts = useRef(0);

  const load = useCallback(async () => {
    setStatus("loading");
    try {
      const bootstrap = await client.bootstrap();
      if (!mounted.current) return;
      setSettings(bootstrap.settings);
      setDraft(bootstrap.settings);
      draftRef.current = bootstrap.settings;
      setVersion(bootstrap.version);
      versionRef.current = bootstrap.version;
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
    const current = draftRef.current;
    if (current === undefined) return;
    const next = { ...current, ...patch };
    draftRef.current = next;
    setDraft(next);
  }, []);

  const send = useCallback(
    async (next: ThemeSettings) => {
      try {
        const result = await client.execute({
          kind: "update-theme-settings",
          settings: next,
          expectedVersion: versionRef.current as never,
        });
        versionRef.current = result.version;
        if (!mounted.current) return false;
        setSettings(result.settings);
        // A later control may already be previewing another queued value. The
        // older response advances authoritative version/settings, but it must
        // not visually roll that newer choice back while its own write waits.
        if (draftRef.current === next) {
          draftRef.current = result.settings;
          setDraft(result.settings);
        }
        setVersion(result.version);
        setStatus("ready");
        setError(undefined);
        return true;
      } catch (cause) {
        if (!mounted.current) return false;
        if (cause instanceof ThemeClientFailure && cause.category === "conflict") {
          conflicts.current += 1;
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
    },
    [client, load],
  );

  const applyExact = useCallback(
    async (next: ThemeSettings) => {
      if (draftRef.current === undefined) return false;
      // Queued behind whatever is already in flight, so this write expects the
      // version that one produced rather than the version this render saw.
      const startedAt = conflicts.current;
      const started = queue.current;
      const write = started
        .catch(() => undefined)
        .then(async () => (conflicts.current === startedAt ? await send(next) : false));
      queue.current = write;
      return await write;
    },
    [send],
  );

  const apply = useCallback(async () => {
    if (draft === undefined) return false;
    return applyExact(draft);
  }, [applyExact, draft]);

  /**
   * Save one change immediately, without going through the draft.
   *
   * The editor's Apply button saves whatever the draft has accumulated, which
   * is right for a form the user is composing. A control that takes effect the
   * moment it is pressed cannot use that path: `updateDraft` schedules a state
   * update, so an `apply` in the same tick would save the draft as it stood
   * *before* the press. Passing the patch straight through keeps the saved
   * value the one the user just chose.
   */
  const applyPatch = useCallback(
    async (patch: Partial<ThemeSettings>) => {
      const current = draftRef.current;
      if (current === undefined) return false;
      const next = { ...current, ...patch };
      draftRef.current = next;
      setDraft(next);
      setError(undefined);
      setStatus("ready");
      return applyExact(next);
    },
    [applyExact],
  );

  const cancel = useCallback(() => {
    if (settings === undefined) return;
    draftRef.current = settings;
    setDraft(settings);
    setError(undefined);
    setStatus("ready");
  }, [settings]);

  const reset = useCallback(() => {
    draftRef.current = DEFAULT_THEME_SETTINGS;
    setDraft(DEFAULT_THEME_SETTINGS);
    setError(undefined);
    void applyExact(DEFAULT_THEME_SETTINGS);
  }, [applyExact]);

  const importJson = useCallback(
    (value: string) => {
      if (value.length > 256_000) {
        setError("Theme import is too large. Use a JSON file smaller than 256 KB.");
        return;
      }
      try {
        const imported = importThemeSettings(JSON.parse(value));
        draftRef.current = imported;
        setDraft(imported);
        setError(undefined);
        void applyExact(imported);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Theme import is invalid.");
      }
    },
    [applyExact],
  );

  const exportJson = useCallback(
    () => (settings === undefined ? undefined : serializeOctantTheme(draft ?? settings)),
    [draft, settings],
  );
  // Exports the draft when there is one: what the user is looking at is what
  // they mean to hand to the project.
  const exportTokens = useCallback(
    (format: ThemeExportFormat) => {
      const source = draft ?? settings;
      if (source === undefined) return undefined;
      try {
        return exportThemeTokens(source, { format, includeTypography: true });
      } catch {
        return undefined;
      }
    },
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
    applyPatch,
    cancel,
    reset,
    importJson,
    exportJson,
    exportTokens,
  };
}
