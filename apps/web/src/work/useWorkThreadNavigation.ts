import type { WorkThread, WorkThreadBootstrap, WorkThreadNavigation } from "@octant/contracts";
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
  readonly changeRevision?: number;
}

export function useWorkThreadNavigation(
  client: Pick<WorkThreadClient, "bootstrap" | "navigation">,
  options: UseWorkThreadNavigationOptions = {},
) {
  const navigationRefreshMs = options.navigationRefreshMs ?? 1_000;
  const [bootstrap, setBootstrap] = useState<WorkThreadBootstrap | WorkThreadNavigation>();
  const [status, setStatus] = useState<WorkThreadNavigationStatus>("loading");
  const [errorMessage, setErrorMessage] = useState<string>();
  const mounted = useRef(true);
  const bootstrapped = useRef(false);
  const requestGeneration = useRef(0);
  const clientRef = useRef(client);
  clientRef.current = client;

  const refresh = useCallback(async () => {
    const request = ++requestGeneration.current;
    if (!bootstrapped.current) setStatus("loading");
    setErrorMessage(undefined);
    try {
      const next = await clientRef.current.bootstrap();
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
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      requestGeneration.current += 1;
    };
  }, [refresh]);

  // Only the thread in view streams, so the list is re-read from projections
  // on a timer to keep titles, lifecycle, and executing state current for
  // threads nobody is watching. Full bootstrap validates Project roots and
  // must not run in this background path.
  useEffect(() => {
    if (bootstrap === undefined || navigationRefreshMs <= 0) return;
    let cancelled = false;
    let inFlight = false;
    const refreshNavigation = async () => {
      if (!documentIsVisible() || inFlight) return;
      inFlight = true;
      const request = ++requestGeneration.current;
      try {
        const next = await clientRef.current.navigation();
        if (
          cancelled ||
          !mounted.current ||
          !documentIsVisible() ||
          request !== requestGeneration.current
        ) {
          return;
        }
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
    );
    const invalidateHiddenRequest = () => {
      if (!documentIsVisible()) requestGeneration.current += 1;
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", invalidateHiddenRequest);
    }
    return () => {
      cancelled = true;
      requestGeneration.current += 1;
      stop();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", invalidateHiddenRequest);
      }
    };
  }, [bootstrap !== undefined, navigationRefreshMs]);

  useEffect(() => {
    if (
      options.changeRevision === undefined ||
      options.changeRevision <= 0 ||
      !bootstrapped.current
    )
      return;
    let cancelled = false;
    const request = ++requestGeneration.current;
    void clientRef.current
      .navigation()
      .then((next) => {
        if (!cancelled && mounted.current && request === requestGeneration.current) {
          setBootstrap(next);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (request === requestGeneration.current) requestGeneration.current += 1;
    };
  }, [options.changeRevision]);

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
