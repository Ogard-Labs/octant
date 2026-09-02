import {
  applyWorkspacePreset,
  loadWorkspacePresetCatalog,
  WorkspacePresetClientFailure,
} from "@octant/client-runtime/workspace-preset-client";
import type {
  WorkspacePreset,
  WorkspacePresetSkillReport,
} from "@octant/contracts/workspace-presets";
import type { CodeCheckoutId, CodeThreadId } from "@octant/contracts/code";
import { useCallback, useEffect, useState } from "react";

export interface WorkspacePresetsOptions {
  readonly enabled?: boolean;
  readonly threadId: CodeThreadId;
  readonly checkoutId?: CodeCheckoutId;
  readonly serverUrl?: string;
  readonly windowCapability?: string;
  /** Injected in tests and on hosts that build their transports elsewhere. */
  readonly load?: typeof loadWorkspacePresetCatalog;
  readonly apply?: typeof applyWorkspacePreset;
}

export interface WorkspacePresets {
  readonly presets: ReadonlyArray<WorkspacePreset>;
  readonly available: boolean;
  readonly busy: boolean;
  readonly message: string | undefined;
  /**
   * What the last applied preset found for the skills it names. A reading of
   * where each one stands, never a change: a preset enables nothing.
   */
  readonly skills: ReadonlyArray<WorkspacePresetSkillReport>;
  readonly apply: (preset: WorkspacePreset) => Promise<boolean>;
}

/**
 * The workspace presets this host offers, and the one gesture that applies one.
 *
 * The catalog is the host's: this hook lists it and submits a preset's id back.
 * What a preset opens, and whether it may open it here, is the host's answer
 * too, and its refusal is shown in its own words.
 */
export function useWorkspacePresets(options: WorkspacePresetsOptions): WorkspacePresets {
  const { threadId, checkoutId, serverUrl, windowCapability } = options;
  const enabled = options.enabled !== false;
  const load = options.load ?? loadWorkspacePresetCatalog;
  const send = options.apply ?? applyWorkspacePreset;
  const [presets, setPresets] = useState<ReadonlyArray<WorkspacePreset>>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [skills, setSkills] = useState<ReadonlyArray<WorkspacePresetSkillReport>>([]);

  useEffect(() => {
    if (!enabled || serverUrl === undefined || windowCapability === undefined) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const listing = await load(
          { baseUrl: serverUrl, fetch, windowCapability },
          controller.signal,
        );
        setPresets(listing.presets);
      } catch (error) {
        if (controller.signal.aborted) return;
        setMessage(
          error instanceof WorkspacePresetClientFailure
            ? error.message
            : "Workspace presets are unavailable.",
        );
      }
    })();
    return () => controller.abort();
  }, [enabled, load, serverUrl, windowCapability]);

  const apply = useCallback(
    async (preset: WorkspacePreset): Promise<boolean> => {
      if (serverUrl === undefined || windowCapability === undefined || checkoutId === undefined) {
        return false;
      }
      setBusy(true);
      setMessage(undefined);
      try {
        const applied = await send(
          { baseUrl: serverUrl, fetch, windowCapability },
          {
            presetId: preset.id,
            threadId,
            checkoutId,
          },
        );
        setSkills(applied.skills);
        return true;
      } catch (error) {
        setMessage(
          error instanceof WorkspacePresetClientFailure
            ? error.message
            : "That preset could not be applied.",
        );
        return false;
      } finally {
        setBusy(false);
      }
    },
    [checkoutId, send, serverUrl, threadId, windowCapability],
  );

  return {
    presets,
    available:
      enabled &&
      presets.length > 0 &&
      serverUrl !== undefined &&
      windowCapability !== undefined &&
      checkoutId !== undefined,
    busy,
    message,
    skills,
    apply,
  };
}
