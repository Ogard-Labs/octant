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
): WorkSettingsController {
  const [settings, setSettings] = useState<WorkSettings>();
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const clientRef = useRef(client);
  clientRef.current = client;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const load = useCallback(async () => {
    const current = clientRef.current;
    if (current === undefined) return;
    try {
      const bootstrap = await current.bootstrap();
      setSettings(bootstrap.settings);
    } catch {
      setMessage("Work settings are unavailable on this host.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [client, load]);

  const update = useCallback(
    async (change: WorkSettingsChange) => {
      const current = clientRef.current;
      const saved = settingsRef.current;
      if (current === undefined || saved === undefined) return false;
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
        setBusy(false);
      }
    },
    [load],
  );

  return { settings, message, busy, update };
}
