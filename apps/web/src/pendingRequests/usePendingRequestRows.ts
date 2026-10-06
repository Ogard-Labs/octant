import type { PendingRequestClient } from "@octant/client-runtime/pending-request-client";
import type { OctantMode } from "@octant/contracts";
import type { PendingRequest } from "@octant/contracts/pending-requests";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  answerPendingRequest,
  pendingRequestKey,
  pendingRequestsForModes,
  type PendingRequestAnswerClients,
  type PendingRequestAnswerResult,
  type PendingRequestResponse,
} from "./pendingRequests";
import { usePendingRequests, type PendingRequestFreshness } from "./usePendingRequests";

/** What a surface needs to list and answer the requests of the modes it speaks for. */
export interface PendingRequestRowsSource extends PendingRequestFreshness {
  /** This window's reader; without one (a remote window) nothing is read. */
  readonly pendingRequestClient: PendingRequestClient | undefined;
  /** The clients each thread view already answers through; a surface adds no route. */
  readonly answerClients: PendingRequestAnswerClients;
  readonly modes: ReadonlyArray<OctantMode>;
}

/**
 * One request to draw. `unlisted` marks a request whose answer was refused and
 * which the host has since stopped listing: it stays for one more read so its
 * refusal line can be read, offers no answer, and then goes.
 */
export interface PendingRequestRowEntry {
  readonly request: PendingRequest;
  readonly unlisted: boolean;
}

const NO_FRESHNESS: PendingRequestFreshness = {
  feedRevision: 0,
  settings: undefined,
  workspace: undefined,
};

/**
 * The requests a surface lists, oldest first, with the answer that delivers a
 * response and re-reads. `rows` is undefined until the first read lands, so a
 * surface can say nothing rather than flash a loading line. Without a source
 * the hook reads nothing.
 */
export function usePendingRequestRows(source: PendingRequestRowsSource | undefined): {
  readonly rows: ReadonlyArray<PendingRequestRowEntry> | undefined;
  readonly answer: (
    request: PendingRequest,
    response: PendingRequestResponse,
  ) => Promise<PendingRequestAnswerResult>;
} {
  const { read, refresh } = usePendingRequests(
    source?.pendingRequestClient,
    source ?? NO_FRESHNESS,
  );
  const [refused, setRefused] = useState<ReadonlyMap<string, PendingRequestRowEntry>>(new Map());
  const modes = source?.modes;
  const answerClients = source?.answerClients;
  const listed = useMemo(
    () =>
      read.status === "ready" && modes !== undefined
        ? pendingRequestsForModes(read.requests, modes)
        : [],
    [modes, read],
  );

  // Each completed read reconciles what a refusal kept on screen: a request
  // the host no longer lists gets one read of grace, then leaves.
  useEffect(() => {
    setRefused((current) => {
      if (current.size === 0) return current;
      const live = new Set(listed.map(pendingRequestKey));
      const next = new Map<string, PendingRequestRowEntry>();
      for (const [key, entry] of current) {
        if (live.has(key)) next.set(key, entry);
        else if (!entry.unlisted) next.set(key, { request: entry.request, unlisted: true });
      }
      return next;
    });
  }, [listed]);

  const answer = useCallback(
    async (
      request: PendingRequest,
      response: PendingRequestResponse,
    ): Promise<PendingRequestAnswerResult> => {
      if (answerClients === undefined) return { status: "refused" };
      const key = pendingRequestKey(request);
      setRefused((current) => {
        const next = new Map(current);
        next.delete(key);
        return next;
      });
      const result = await answerPendingRequest(answerClients, request, response);
      if (result.status === "refused") {
        setRefused((current) => new Map(current).set(key, { request, unlisted: false }));
      }
      refresh();
      return result;
    },
    [answerClients, refresh],
  );

  const rows = useMemo(() => {
    if (read.status === "loading") return undefined;
    const liveKeys = new Set(listed.map(pendingRequestKey));
    return [
      ...listed.map((request) => ({ request, unlisted: false })),
      ...[...refused]
        .filter(([key]) => !liveKeys.has(key))
        .map(([, entry]) => ({ request: entry.request, unlisted: true })),
    ].toSorted((a, b) => a.request.requestedAt.localeCompare(b.request.requestedAt));
  }, [listed, read.status, refused]);

  return { rows, answer };
}
