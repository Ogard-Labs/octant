import type {
  ProviderInstanceId,
  ProviderModelId,
  WorkAccess,
  WorkSettings,
} from "@octant/contracts";
import type { WorkThreadClient } from "@octant/client-runtime/work-thread-client";
import { useCallback, useEffect, useRef, useState } from "react";

export interface WorkSettingsChange {
  readonly defaultModel?:
    | { readonly providerInstanceId: ProviderInstanceId; readonly modelId: ProviderModelId }
    | undefined;
  readonly defaultAccess?: WorkAccess;
}

export interface WorkSettingsController {
  /**
   * Loading until the host first answers. Unsupported when there is no Work
   * client, the host predates Work settings, or the read failed; new threads
   * then fall back to the first available model, as they always did.
   */
  readonly status: "loading" | "ready" | "unsupported";
  /** Undefined until the host answers; a host that predates Work settings never does. */
  readonly settings: WorkSettings | undefined;
  readonly message: string | undefined;
  readonly busy: boolean;
  readonly update: (change: WorkSettingsChange) => Promise<boolean>;
}

/**
 * Work's defaults for new threads: read once from the Work bootstrap and
 * saved with the version they were read at, so a save made against an older
 * copy is refused by the host and the page reloads instead of overwriting.
 */
export function useWorkSettings(
  client: Pick<WorkThreadClient, "bootstrap" | "execute"> | undefined,
  /**
   * Bumps when the host journals Work navigation changes, which includes a
   * save from another window; without it this window kept starting threads
   * on the old default until a reload.
   */
  changeRevision?: number,
): WorkSettingsController {
  const [settings, setSettings] = useState<WorkSettings>();
  const [status, setStatus] = useState<WorkSettingsController["status"]>(
    client === undefined ? "unsupported" : "loading",
  );
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  // Set before the first await, so a second change made before React
  // re-renders the disabled controls cannot send the same version twice.
  const saving = useRef(false);
  const clientRef = useRef(client);
  clientRef.current = client;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const load = useCallback(async () => {
    const current = clientRef.current;
    if (current === undefined) {
      setStatus("unsupported");
      return;
    }
    try {
      const bootstrap = await current.bootstrap();
      setSettings(bootstrap.settings);
      if (bootstrap.settings === undefined) {
        setStatus("unsupported");
        setMessage("Work settings are unavailable on this host.");
      } else {
        setStatus("ready");
      }
    } catch {
      setStatus("unsupported");
      setMessage("Work settings are unavailable on this host.");
    }
  }, []);

  // A new client has not answered yet; a change revision on the same client
  // keeps the settings in hand while it re-reads them.
  useEffect(() => {
    setStatus(client === undefined ? "unsupported" : "loading");
  }, [client]);

  useEffect(() => {
    void load();
  }, [client, changeRevision, load]);

  const update = useCallback(
    async (change: WorkSettingsChange) => {
      const current = clientRef.current;
      const saved = settingsRef.current;
      if (current === undefined || saved === undefined || saving.current) return false;
      saving.current = true;
      const model =
        "defaultModel" in change
          ? change.defaultModel
          : saved.defaultProviderInstanceId === undefined || saved.defaultModelId === undefined
            ? undefined
            : {
                providerInstanceId: saved.defaultProviderInstanceId,
                modelId: saved.defaultModelId,
              };
      setBusy(true);
      setMessage(undefined);
      try {
        const result = await current.execute({
          kind: "update-work-settings",
          expectedVersion: saved.version,
          ...(model === undefined
            ? {}
            : {
                defaultProviderInstanceId: model.providerInstanceId,
                defaultModelId: model.modelId,
              }),
          defaultAccess: change.defaultAccess ?? saved.defaultAccess,
        });
        if ("kind" in result && result.kind === "settings-updated") {
          setSettings(result.settings);
          return true;
        }
        setMessage("message" in result ? result.message : "Work settings could not be saved.");
        return false;
      } catch (error) {
        // Most often another window saved first; show what the host holds now.
        await load();
        setMessage(
          error instanceof Error && error.message.trim() !== ""
            ? error.message
            : "Work settings could not be saved.",
        );
        return false;
      } finally {
        saving.current = false;
        setBusy(false);
      }
    },
    [load],
  );

  return { status, settings, message, busy, update };
}
