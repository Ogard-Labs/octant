import type { RootlessThreadClient } from "@octant/client-runtime/rootless-thread-client";
import type {
  RootlessThreadListResult,
  RootlessThreadSummary,
} from "@octant/contracts/rootless-thread";
import type { OctantMode } from "@octant/contracts/modes";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChatThreadNavigationItem } from "../shell/navigationModel";

export type RootlessThreadNavigationStatus = "loading" | "ready" | "unavailable";
const ROOTLESS_TURN_POLL_MS = 500;

export function rootlessThreadNavigationId(
  thread: Pick<RootlessThreadSummary, "hostId" | "mode" | "threadId">,
): string {
  return `${encodeURIComponent(String(thread.hostId))}:${thread.mode}:${thread.threadId}`;
}

export function useRootlessThreadNavigation(
  client: Pick<RootlessThreadClient, "listThreads" | "lookupFirstTurn">,
) {
  const [list, setList] = useState<RootlessThreadListResult>();
  const [status, setStatus] = useState<RootlessThreadNavigationStatus>("loading");
  const [errorMessage, setErrorMessage] = useState<string>();
  const [pollDelayMs, setPollDelayMs] = useState(ROOTLESS_TURN_POLL_MS);

  const load = useCallback(
    async (showLoading: boolean) => {
      if (showLoading) setStatus("loading");
      setErrorMessage(undefined);
      try {
        setList(await client.listThreads());
        setStatus("ready");
      } catch (error) {
        setStatus("unavailable");
        setErrorMessage(
          error instanceof Error && error.message.trim() !== ""
            ? error.message
            : "Unfiled threads are unavailable.",
        );
      }
    },
    [client],
  );

  const refresh = useCallback(async () => await load(true), [load]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const activeFirstTurns = useMemo(
    () =>
      list?.all.filter(
        (thread) =>
          thread.initialTurn?.status === "accepted" || thread.initialTurn?.status === "running",
      ) ?? [],
    [list],
  );

  useEffect(() => {
    if (activeFirstTurns.length === 0) return;
    const timeout = globalThis.setTimeout(() => {
      void (async () => {
        try {
          const results = await Promise.allSettled(
            activeFirstTurns.map((thread) => client.lookupFirstTurn(thread.initialTurn!.requestId)),
          );
          const updatedTurns = new Map(
            results.flatMap((result) =>
              result.status === "fulfilled" && result.value.kind === "accepted"
                ? [[String(result.value.turn.threadId), result.value.turn] as const]
                : [],
            ),
          );
          setList((current) =>
            current === undefined
              ? current
              : {
                  recents: replaceTurns(current.recents, updatedTurns),
                  all: replaceTurns(current.all, updatedTurns),
                  unfiled: replaceTurns(current.unfiled, updatedTurns),
                },
          );
          if (results.some((result) => result.status === "rejected")) {
            setErrorMessage("Some thread progress is temporarily unavailable.");
            setPollDelayMs((current) => Math.min(current * 2, 10_000));
          } else {
            setErrorMessage(undefined);
            setPollDelayMs(ROOTLESS_TURN_POLL_MS);
          }
        } catch (error) {
          setErrorMessage(
            error instanceof Error && error.message.trim() !== ""
              ? error.message
              : "Thread progress is temporarily unavailable.",
          );
          setPollDelayMs((current) => Math.min(current * 2, 10_000));
        }
      })();
    }, pollDelayMs);
    return () => globalThis.clearTimeout(timeout);
  }, [activeFirstTurns, client, pollDelayMs]);

  const byNavigationId = useMemo(() => {
    const result = new Map<string, RootlessThreadSummary>();
    for (const thread of list?.all ?? []) result.set(rootlessThreadNavigationId(thread), thread);
    return result;
  }, [list]);

  const groupsForMode = useCallback(
    (mode: OctantMode) => {
      if (mode === "chat" || list === undefined) return undefined;
      return {
        recents: toNavigationItems(list.recents, mode),
        all: toNavigationItems(list.all, mode),
        unfiled: toNavigationItems(list.unfiled, mode),
      } as const;
    },
    [list],
  );

  return { byNavigationId, errorMessage, groupsForMode, refresh, status } as const;
}

function toNavigationItems(
  threads: ReadonlyArray<RootlessThreadSummary>,
  mode: "work" | "code",
): ReadonlyArray<ChatThreadNavigationItem> {
  return threads
    .filter((thread) => thread.mode === mode)
    .map((thread) => ({
      navigationId: rootlessThreadNavigationId(thread),
      threadId: String(thread.threadId),
      title: thread.title,
      providerInstanceId: String(thread.providerInstanceId),
      updatedAt: thread.updatedAt,
      ...(thread.workspaceKind === "project-backed" && thread.projectId !== undefined
        ? { projectId: String(thread.projectId) }
        : {}),
    }));
}

function replaceTurns(
  threads: ReadonlyArray<RootlessThreadSummary>,
  updatedTurns: ReadonlyMap<string, NonNullable<RootlessThreadSummary["initialTurn"]>>,
): ReadonlyArray<RootlessThreadSummary> {
  return threads.map((thread) => {
    const initialTurn = updatedTurns.get(String(thread.threadId));
    return initialTurn === undefined
      ? thread
      : { ...thread, initialTurn, updatedAt: initialTurn.updatedAt };
  });
}
