import { createCodeFileListingClient, type CodeFileListingClient } from "@octant/client-runtime";
import type {
  CodeCheckoutId,
  CodeFileChangeNotice,
  CodeFileListing,
  CodeFileListingEntry,
  CodeRelativePath,
  CodeThreadId,
} from "@octant/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CodeFileExplorerEntry } from "./CodeFileExplorer";
import { useCodeFileChangeWatch } from "./useCodeFileChangeWatch";

export type CodeFileListingStatus = "idle" | "loading" | "ready" | "error";

export interface CodeFileListingController {
  readonly status: CodeFileListingStatus;
  readonly entries: ReadonlyArray<CodeFileExplorerEntry>;
  /** True when the host stopped the walk before the whole tree was described. */
  readonly truncated: boolean;
  readonly errorMessage?: string | undefined;
  readonly refresh: () => Promise<void>;
}

export interface CodeFileListingControllerOptions {
  readonly client?: CodeFileListingClient;
  readonly threadId?: CodeThreadId | undefined;
  readonly checkoutId?: CodeCheckoutId | undefined;
  readonly directory?: CodeRelativePath | undefined;
  readonly enabled: boolean;
  readonly serverUrl?: string;
  readonly windowCapability?: string;
  /**
   * Follow the checkout live. Surfaces that stay on screen while an agent
   * edits — the explorer — want this; a transient picker does not, and holding
   * a connection open for a menu that closes in a second would only cost one.
   */
  readonly watch?: boolean;
  /**
   * Called for every change the host reports, before the listing reloads, so a
   * surface holding an open file can decide for itself whether that file is
   * one of the changed paths.
   */
  readonly onFilesChanged?: (notice: CodeFileChangeNotice) => void;
}

/**
 * Load the confined file listing for one Code thread's checkout.
 *
 * The renderer never decides availability: a file the host marked oversized or
 * unavailable is rendered exactly as the host classified it. The listing is
 * fetched when the surface mounts, on explicit refresh, and — when the caller
 * asks to watch — when the host reports that the checkout changed. It is never
 * polled: a timer would rescan the repository whether or not anything moved,
 * while a notice arrives only when something did.
 */
export function useCodeFileListingController(
  options: CodeFileListingControllerOptions,
): CodeFileListingController {
  const client = useMemo(() => {
    if (options.client !== undefined) return options.client;
    if (!options.enabled) return undefined;
    const baseUrl = options.serverUrl;
    const windowCapability = options.windowCapability;
    if (baseUrl === undefined || windowCapability === undefined) return undefined;
    return createCodeFileListingClient({ baseUrl, fetch: globalThis.fetch, windowCapability });
  }, [options.client, options.enabled, options.serverUrl, options.windowCapability]);

  const [status, setStatus] = useState<CodeFileListingStatus>("idle");
  const [entries, setEntries] = useState<ReadonlyArray<CodeFileExplorerEntry>>([]);
  const [truncated, setTruncated] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string>();
  const mounted = useRef(true);
  const generation = useRef(0);
  const active = useRef<AbortController | undefined>(undefined);

  const load = useCallback(async (): Promise<void> => {
    const threadId = options.threadId;
    const checkoutId = options.checkoutId;
    if (
      !options.enabled ||
      client === undefined ||
      threadId === undefined ||
      checkoutId === undefined
    ) {
      active.current?.abort();
      active.current = undefined;
      generation.current += 1;
      setStatus("idle");
      setEntries([]);
      setTruncated(false);
      setErrorMessage(undefined);
      return;
    }

    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const request = ++generation.current;
    setStatus("loading");
    setErrorMessage(undefined);
    try {
      const result = await client.list(
        {
          threadId,
          checkoutId,
          ...(options.directory === undefined ? {} : { directory: options.directory }),
        },
        controller.signal,
      );
      if (!mounted.current || request !== generation.current) return;
      if (result.status === "failed") {
        setEntries([]);
        setTruncated(false);
        setErrorMessage(result.failure.message);
        setStatus("error");
        return;
      }
      setEntries(toExplorerEntries(result.listing));
      setTruncated(result.listing.truncated);
      setErrorMessage(undefined);
      setStatus("ready");
    } catch (error) {
      if (!mounted.current || request !== generation.current) return;
      setEntries([]);
      setTruncated(false);
      setErrorMessage(failureMessage(error));
      setStatus("error");
    } finally {
      if (active.current === controller) active.current = undefined;
    }
  }, [client, options.checkoutId, options.directory, options.enabled, options.threadId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current?.abort();
      active.current = undefined;
      generation.current += 1;
    };
  }, []);

  const watchTarget = options.watch === true;
  const onFilesChanged = useRef(options.onFilesChanged);
  onFilesChanged.current = options.onFilesChanged;
  const reload = useRef(load);
  reload.current = load;

  useCodeFileChangeWatch({
    enabled: options.enabled && watchTarget,
    ...(client === undefined ? {} : { client }),
    ...(options.threadId === undefined ? {} : { threadId: options.threadId }),
    ...(options.checkoutId === undefined ? {} : { checkoutId: options.checkoutId }),
    onChanged: (notice) => {
      onFilesChanged.current?.(notice);
      void reload.current();
    },
  });

  return { status, entries, truncated, errorMessage, refresh: load };
}

/**
 * Map the authoritative listing onto the explorer's entry shape. The mapping is
 * total and lossless in the direction that matters: every server-decided
 * availability keeps its meaning, and nothing is upgraded to openable here.
 */
export function toExplorerEntries(listing: CodeFileListing): ReadonlyArray<CodeFileExplorerEntry> {
  return listing.entries.map((entry: CodeFileListingEntry) =>
    entry.kind === "directory"
      ? { kind: "directory", path: entry.path }
      : {
          kind: "file",
          fileId: entry.fileId,
          path: entry.path,
          availability:
            entry.availability.status === "available"
              ? { status: "available" }
              : entry.availability.status === "read-only"
                ? { status: "read-only", reason: "oversized" }
                : { status: "unavailable", reason: entry.availability.reason },
        },
  );
}

function failureMessage(error: unknown): string {
  return typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
    ? error.message
    : "Octant Code file listing is unavailable.";
}
