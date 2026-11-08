import type { ExtensionClient } from "@octant/client-runtime/extension-client";
import type { RuntimeCompactionDefaults } from "@octant/contracts/extension-rpc";
import { useEffect, useState } from "react";
import { compactTokenCount } from "../context/contextInspectorModel";

/** Claude Code keeps this much of its auto-compact window free (2.1.287). */
const CLAUDE_AUTO_COMPACT_RESERVE_TOKENS = 13_000;

/**
 * What each runtime does on its own, from the person's own files, said as the
 * Settings row's second sentence. These are the runtime's points; a share
 * picked in Octant is passed to the sessions Octant starts and changes neither
 * file.
 */
export function runtimeCompactionDefaultsText(defaults: RuntimeCompactionDefaults): string {
  const { claude, codex } = defaults;
  const claudeText = !claude.autoCompact
    ? "Claude Code has auto-compact off"
    : claude.autoCompactWindow === undefined
      ? "Claude Code compacts by itself near a full window"
      : `Claude Code compacts by itself at ${compactTokenCount(
          Math.max(0, claude.autoCompactWindow - CLAUDE_AUTO_COMPACT_RESERVE_TOKENS),
        )}`;
  const codexText =
    codex.autoCompactTokenLimit === undefined
      ? "Codex at its model's own limit"
      : `Codex at ${compactTokenCount(codex.autoCompactTokenLimit)}`;
  return `Your own settings: ${claudeText}; ${codexText}. Octant leaves those files as they are.`;
}

/** Reads the runtimes' own compaction settings once; undefined until known, or where unreadable. */
export function useRuntimeCompactionDefaults(
  client: Pick<ExtensionClient, "runtimeCompactionDefaults"> | undefined,
): RuntimeCompactionDefaults | undefined {
  const [defaults, setDefaults] = useState<RuntimeCompactionDefaults | undefined>(undefined);
  useEffect(() => {
    if (client === undefined) return;
    let live = true;
    client.runtimeCompactionDefaults().then(
      (read) => {
        if (live) setDefaults(read);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [client]);
  return defaults;
}
