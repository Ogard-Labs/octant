import { createCodeFileListingClient, type CodeFileListingClient } from "@octant/client-runtime";
import type {
  CodeCheckoutId,
  CodeFileListing,
  CodeFileListingEntry,
  CodeRelativePath,
  CodeThreadId,
} from "@octant/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CodeFileExplorerEntry } from "./CodeFileExplorer";

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
}

/**
 * Load the confined file listing for one Code thread's checkout.
 *
 * The renderer never decides availability: a file the host marked oversized or
 * unavailable is rendered exactly as the host classified it. The listing is
 * fetched when the surface mounts and on explicit refresh only — a file tree is
 * not a live observation, and polling one would scan the checkout on a timer
 * for no user-visible gain.
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
