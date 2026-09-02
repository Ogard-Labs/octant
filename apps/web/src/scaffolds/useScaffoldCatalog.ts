import { createCodeClient, type CodeClient } from "@octant/client-runtime/code-client";
import { loadScaffoldCatalog, ScaffoldClientFailure } from "@octant/client-runtime/scaffold-client";
import type { ScaffoldEntry, ScaffoldRun } from "@octant/contracts/scaffolds";
import { useCallback, useEffect, useMemo, useState } from "react";

export interface ScaffoldCatalogOptions {
  readonly enabled?: boolean;
  readonly threadId: string;
  readonly checkoutId: string;
  readonly serverUrl?: string;
  readonly windowCapability?: string;
  /** Injected in tests and on hosts that build the clients elsewhere. */
  readonly code?: Pick<CodeClient, "executeOperation">;
  readonly load?: typeof loadScaffoldCatalog;
  readonly uuid?: () => string;
}

export interface ScaffoldCatalog {
  readonly entries: ReadonlyArray<ScaffoldEntry>;
  /** Whether this machine has the tool each entry needs, by entry id. */
  readonly runnable: ReadonlyMap<string, boolean>;
  readonly available: boolean;
  readonly busy: boolean;
  readonly message: string | undefined;
  readonly lastRun: ScaffoldRun | undefined;
  readonly start: (entry: ScaffoldEntry, directoryName: string) => Promise<boolean>;
}

/**
 * The scaffolds this host offers, and the one gesture that starts one.
 *
 * The catalog is the host's: this hook lists it and submits an entry's id back.
 * Whether a scaffold may run here — Plan mode, a missing tool, a name already
 * taken — is the host's answer too, and its refusal is shown in its own words
 * rather than re-derived from the entry.
 */
export function useScaffoldCatalog(options: ScaffoldCatalogOptions): ScaffoldCatalog {
  const { threadId, checkoutId, serverUrl, windowCapability } = options;
  const enabled = options.enabled !== false;
  const load = options.load ?? loadScaffoldCatalog;
  const uuid = options.uuid ?? globalThis.crypto.randomUUID.bind(globalThis.crypto);
  const injectedCode = options.code;
  const code = useMemo(() => {
    if (injectedCode !== undefined) return injectedCode;
    if (serverUrl === undefined || windowCapability === undefined) return undefined;
    try {
      return createCodeClient({ baseUrl: serverUrl, fetch, windowCapability });
    } catch {
      return undefined;
    }
  }, [injectedCode, serverUrl, windowCapability]);

  const [entries, setEntries] = useState<ReadonlyArray<ScaffoldEntry>>([]);
  const [tools, setTools] = useState<ReadonlyArray<string>>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [lastRun, setLastRun] = useState<ScaffoldRun>();

  useEffect(() => {
    if (!enabled || serverUrl === undefined || windowCapability === undefined) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const listing = await load(
          { baseUrl: serverUrl, fetch, windowCapability },
          controller.signal,
        );
        setEntries(listing.entries);
        setTools(listing.availableTools);
      } catch (error) {
        if (controller.signal.aborted) return;
        setMessage(
          error instanceof ScaffoldClientFailure ? error.message : "Scaffolds are unavailable.",
        );
      }
    })();
    return () => controller.abort();
  }, [enabled, load, serverUrl, windowCapability]);

  const start = useCallback(
    async (entry: ScaffoldEntry, directoryName: string): Promise<boolean> => {
      if (code === undefined) return false;
      setBusy(true);
      setMessage(undefined);
      try {
        const result = await code.executeOperation({
          kind: "run-scaffold",
          operationId: uuid() as never,
          threadId: threadId as never,
          checkoutId: checkoutId as never,
          scaffoldRunId: uuid() as never,
          scaffoldId: entry.id,
          directoryName: directoryName as never,
        });
        if (result.kind === "operation-failed") {
          setMessage(result.failure.message);
          return false;
        }
        if (result.kind !== "scaffold-run") return false;
        setLastRun(result.run);
        if (result.run.outcome !== "created") {
          setMessage(runFailureText(result.run));
          return false;
        }
        return true;
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "The scaffold could not be started.");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [checkoutId, code, threadId, uuid],
  );

  return {
    entries,
    runnable: useMemo(
      () => new Map(entries.map((entry) => [String(entry.id), tools.includes(entry.requiresTool)])),
      [entries, tools],
    ),
    available: enabled && code !== undefined && entries.length > 0,
    busy,
    message,
    lastRun,
    start,
  };
}

/** What a run that did not create a project is called, in the run's own terms. */
function runFailureText(run: ScaffoldRun): string {
  switch (run.outcome) {
    case "cancelled":
      return "The scaffold was stopped before it finished.";
    case "unavailable":
      return "The generator could not be started on this machine.";
    default:
      return "The generator stopped before it finished. Its output is below.";
  }
}
