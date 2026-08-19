import type { WorkThread, WorkThreadBootstrap } from "@octant/contracts";
import type { WorkThreadClient } from "@octant/client-runtime/work-thread-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatThreadNavigationItem } from "../shell/navigationModel";

export type WorkThreadNavigationStatus = "loading" | "ready" | "unavailable";

export function buildWorkThreadNavigation(
  threads: ReadonlyArray<WorkThread>,
): ReadonlyArray<ChatThreadNavigationItem> {
  return threads
    .filter((thread) => thread.lifecycle !== "archived" && thread.lifecycle !== "deleted")
    .map((thread) => ({
      threadId: String(thread.id),
      title: thread.title,
      projectId: String(thread.projectId),
      providerInstanceId: String(thread.providerInstanceId),
      updatedAt: thread.updatedAt,
    }));
}

export function useWorkThreadNavigation(client: Pick<WorkThreadClient, "bootstrap">) {
  const [bootstrap, setBootstrap] = useState<WorkThreadBootstrap>();
  const [status, setStatus] = useState<WorkThreadNavigationStatus>("loading");
  const [errorMessage, setErrorMessage] = useState<string>();
  const mounted = useRef(true);
  const requestGeneration = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++requestGeneration.current;
    setStatus("loading");
    setErrorMessage(undefined);
    try {
      const next = await client.bootstrap();
      if (!mounted.current || request !== requestGeneration.current) return false;
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

  const navigation = useMemo(
    () => buildWorkThreadNavigation(bootstrap?.threads ?? []),
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
