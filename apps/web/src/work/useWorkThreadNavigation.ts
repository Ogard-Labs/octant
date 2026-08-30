import type { WorkThread, WorkThreadBootstrap } from "@octant/contracts";
import type { WorkThreadClient } from "@octant/client-runtime/work-thread-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { documentIsVisible, scheduleVisibleInterval } from "../polling/documentVisibility";
import type { ChatThreadNavigationItem } from "../shell/navigationModel";

export type WorkThreadNavigationStatus = "loading" | "ready" | "unavailable";

export function buildWorkThreadNavigation(
  threads: ReadonlyArray<WorkThread>,
  runtime: ReadonlyArray<{ readonly threadId: WorkThread["id"]; readonly executing: boolean }> = [],
): ReadonlyArray<ChatThreadNavigationItem> {
  const executingByThread = new Map(
    runtime.map((entry) => [String(entry.threadId), entry.executing] as const),
  );
  return threads
    .filter((thread) => thread.lifecycle !== "archived" && thread.lifecycle !== "deleted")
    .map((thread) => ({
      ...(executingByThread.get(String(thread.id)) === true
        ? { activity: "working" as const }
        : {}),
      threadId: String(thread.id),
      title: thread.title,
      projectId: String(thread.projectId),
      providerInstanceId: String(thread.providerInstanceId),
      updatedAt: thread.updatedAt,
    }));
}

export interface UseWorkThreadNavigationOptions {
  readonly navigationRefreshMs?: number;
}

export function useWorkThreadNavigation(
  client: Pick<WorkThreadClient, "bootstrap">,
  options: UseWorkThreadNavigationOptions = {},
) {
  const navigationRefreshMs = options.navigationRefreshMs ?? 1_000;
  const [bootstrap, setBootstrap] = useState<WorkThreadBootstrap>();
  const [status, setStatus] = useState<WorkThreadNavigationStatus>("loading");
  const [errorMessage, setErrorMessage] = useState<string>();
  const mounted = useRef(true);
  const bootstrapped = useRef(false);
  const requestGeneration = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++requestGeneration.current;
    if (!bootstrapped.current) setStatus("loading");
    setErrorMessage(undefined);
    try {
      const next = await client.bootstrap();
      if (!mounted.current || request !== requestGeneration.current) return false;
      bootstrapped.current = true;
      setBootstrap(next);
      setStatus("ready");
      return true;
    } catch (error) {
      if (!mounted.current || request !== requestGeneration.current) return false;
      setStatus("unavailable");
      setErrorMessage(
        error instanceof Error && error.message.trim() !== ""
          ? error.message
          : "Work threads are unavailable.",
      );
      return false;
    }
  }, [client]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      requestGeneration.current += 1;
    };
  }, [refresh]);

  // Only the thread in view streams, so the list is re-read on a timer to keep
  // titles, lifecycle, and executing state current for threads nobody is watching.
  useEffect(() => {
    if (bootstrap === undefined || navigationRefreshMs <= 0) return;
    let cancelled = false;
    let inFlight = false;
    const refreshNavigation = async () => {
      if (!documentIsVisible() || inFlight) return;
      inFlight = true;
      try {
        const next = await client.bootstrap();
        if (cancelled || !mounted.current) return;
        setBootstrap(next);
      } catch {
        // A refresh that fails leaves the last list on screen.
      } finally {
        inFlight = false;
      }
    };
    const stop = scheduleVisibleInterval(
      () => void refreshNavigation(),
      Math.max(10, navigationRefreshMs),
      { runImmediately: true },
    );
    return () => {
      cancelled = true;
      stop();
    };
  }, [bootstrap, client, navigationRefreshMs]);

  const navigation = useMemo(
    () => buildWorkThreadNavigation(bootstrap?.threads ?? [], bootstrap?.runtime ?? []),
    [bootstrap],
  );

  const applyThread = useCallback((thread: WorkThread) => {
    setBootstrap((current) => {
      if (current === undefined) return current;
      const index = current.threads.findIndex((candidate) => candidate.id === thread.id);
      if (index === -1) return current;
      const threads = current.threads.slice();
      threads[index] = thread;
      return { ...current, threads };
    });
  }, []);

  return { applyThread, bootstrap, errorMessage, navigation, refresh, status } as const;
}
