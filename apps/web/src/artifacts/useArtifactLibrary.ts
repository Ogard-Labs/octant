import {
  ArtifactLibraryClientFailure,
  loadArtifactLibrary,
} from "@octant/client-runtime/artifact-library-client";
import type {
  ArtifactKind,
  ArtifactLibraryListing,
  ArtifactLibraryQuery,
  ArtifactLibraryTab,
} from "@octant/contracts/artifact-library";
import type { OctantMode, ProjectId } from "@octant/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface ArtifactLibraryFilters {
  readonly tab: ArtifactLibraryTab;
  readonly query: string;
  readonly projectId?: ProjectId;
  readonly mode?: OctantMode;
  readonly kind?: ArtifactKind;
}

export interface ArtifactLibraryOptions {
  readonly serverUrl?: string;
  readonly windowCapability?: string;
  /** Injected in tests and on hosts that build the client elsewhere. */
  readonly load?: typeof loadArtifactLibrary;
}

export interface ArtifactLibrary {
  readonly listing: ArtifactLibraryListing | undefined;
  readonly filters: ArtifactLibraryFilters;
  readonly setFilters: (next: ArtifactLibraryFilters) => void;
  readonly busy: boolean;
  readonly message: string | undefined;
  readonly refresh: () => void;
}

export const INITIAL_ARTIFACT_FILTERS: ArtifactLibraryFilters = { tab: "all", query: "" };

/**
 * The host's artifact library, as one view asks for it.
 *
 * Every filter travels to the host, which decides the answer. Nothing here
 * narrows a wider list: a listing this hook holds is already exactly what this
 * caller may see.
 */
export function useArtifactLibrary(options: ArtifactLibraryOptions): ArtifactLibrary {
  const { serverUrl, windowCapability } = options;
  const load = options.load ?? loadArtifactLibrary;
  const [filters, setFilters] = useState<ArtifactLibraryFilters>(INITIAL_ARTIFACT_FILTERS);
  const [listing, setListing] = useState<ArtifactLibraryListing>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [reloads, setReloads] = useState(0);
  const latest = useRef(0);

  const query = useMemo((): ArtifactLibraryQuery => {
    const trimmed = filters.query.trim();
    return {
      tab: filters.tab,
      ...(trimmed === "" ? {} : { query: trimmed }),
      ...(filters.projectId === undefined ? {} : { projectId: filters.projectId }),
      ...(filters.mode === undefined ? {} : { mode: filters.mode }),
      ...(filters.kind === undefined ? {} : { kind: filters.kind }),
    } as ArtifactLibraryQuery;
  }, [filters]);

  useEffect(() => {
    if (serverUrl === undefined || windowCapability === undefined) {
      setMessage("The artifact library is unavailable.");
      return;
    }
    const controller = new AbortController();
    const request = (latest.current += 1);
    setBusy(true);
    void (async () => {
      try {
        const next = await load(
          { baseUrl: serverUrl, fetch, windowCapability },
          query,
          controller.signal,
        );
        // A slower earlier request must not overwrite a newer answer, which is
        // what typing into the search field produces.
        if (controller.signal.aborted || request !== latest.current) return;
        setListing(next);
        setMessage(undefined);
      } catch (error) {
        if (controller.signal.aborted || request !== latest.current) return;
        setMessage(
          error instanceof ArtifactLibraryClientFailure
            ? error.message
            : "The artifact library is unavailable.",
        );
      } finally {
        if (request === latest.current) setBusy(false);
      }
    })();
    return () => controller.abort();
  }, [load, query, reloads, serverUrl, windowCapability]);

  return {
    listing,
    filters,
    setFilters,
    busy,
    message,
    refresh: useCallback(() => setReloads((count) => count + 1), []),
  };
}
