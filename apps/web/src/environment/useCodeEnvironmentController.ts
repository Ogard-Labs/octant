import { createProjectClient, type ProjectClient } from "@octant/client-runtime/project-client";
import type {
  CodeEnvironmentObservation,
  CodeOperationId,
  CodeThreadId,
  ProjectSummary,
} from "@octant/contracts";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

export type CodeEnvironmentControllerStatus = "idle" | "loading" | "ready" | "error";

export interface CodeEnvironmentController {
  readonly status: CodeEnvironmentControllerStatus;
  readonly observation?: CodeEnvironmentObservation | undefined;
  readonly errorMessage?: string | undefined;
  readonly refresh: () => Promise<void>;
  readonly retry: () => Promise<void>;
}

export interface CodeEnvironmentControllerOptions {
  readonly client?: ProjectClient;
  readonly project?: ProjectSummary | undefined;
  readonly threadId?: CodeThreadId | undefined;
  /**
   * The thread's most recent turn to have completed, been interrupted, or
   * failed. A new value means a turn may have edited the checkout since it was
   * last read.
   */
  readonly latestSettledTurn?: CodeOperationId | undefined;
  readonly enabled: boolean;
  readonly serverUrl?: string;
  readonly windowCapability?: string;
}

export function useCodeEnvironmentController(
  options: CodeEnvironmentControllerOptions,
): CodeEnvironmentController {
  const fallbackClient = useMemo(
    () =>
      options.client ??
      createProjectClient({
        baseUrl: required(options.serverUrl),
        fetch: globalThis.fetch,
        windowCapability: required(options.windowCapability),
      }),
    [options.client, options.serverUrl, options.windowCapability],
  );
  const [status, setStatus] = useState<CodeEnvironmentControllerStatus>("idle");
  const [observation, setObservation] = useState<CodeEnvironmentObservation>();
  const [errorMessage, setErrorMessage] = useState<string>();
  const mounted = useRef(true);
  const generation = useRef(0);
  const activeRequest = useRef<AbortController | undefined>(undefined);
  const readCoversTurn = useRef<CodeOperationId | undefined>(undefined);

  const load = useCallback(
    async (fresh = false, keepObservation = false): Promise<void> => {
      const project = options.project;
      if (!options.enabled || project?.type !== "code") {
        activeRequest.current?.abort();
        activeRequest.current = undefined;
        generation.current += 1;
        setStatus("idle");
        setObservation(undefined);
        setErrorMessage(undefined);
        return;
      }

      activeRequest.current?.abort();
      const controller = new AbortController();
      activeRequest.current = controller;
      const request = ++generation.current;
      if (!keepObservation) {
        setStatus("loading");
        setObservation(undefined);
        setErrorMessage(undefined);
      }
      try {
        const nextObservation =
          options.threadId === undefined
            ? fresh
              ? await fallbackClient.environment(project.id, controller.signal, true)
              : await fallbackClient.environment(project.id, controller.signal)
            : fresh
              ? await fallbackClient.environmentForThread(
                  project.id,
                  options.threadId,
                  controller.signal,
                  true,
                )
              : await fallbackClient.environmentForThread(
                  project.id,
                  options.threadId,
                  controller.signal,
                );
        if (!mounted.current || request !== generation.current) return;
        setObservation(nextObservation);
        setErrorMessage(undefined);
        setStatus("ready");
      } catch (error) {
        if (!mounted.current || request !== generation.current) return;
        setStatus("error");
        setObservation(undefined);
        setErrorMessage(failureMessage(error));
      } finally {
        if (activeRequest.current === controller) activeRequest.current = undefined;
      }
    },
    [fallbackClient, options.enabled, options.project?.id, options.project?.type, options.threadId],
  );

  useLayoutEffect(() => {
    if (!options.enabled || options.project?.type !== "code") {
      activeRequest.current?.abort();
      activeRequest.current = undefined;
      generation.current += 1;
      setStatus("idle");
      setObservation(undefined);
      setErrorMessage(undefined);
      return;
    }
    readCoversTurn.current = options.latestSettledTurn;
    void load();
  }, [
    load,
    options.enabled,
    options.project?.id,
    options.project?.type,
    options.project?.updatedAt,
  ]);

  // Nothing else re-reads the checkout while a thread stays open: without this,
  // the counts under the composer stayed at what they were when the thread
  // opened, however much the agent went on to edit. The read skips the host's short-lived Git cache,
  // which could otherwise answer with the reading from before the edits, and
  // keeps the last facts on screen until it lands: dropping them would pull the
  // bar out from under the composer and put it back after every turn.
  useEffect(() => {
    if (!options.enabled || options.project?.type !== "code") return;
    if (readCoversTurn.current === options.latestSettledTurn) return;
    readCoversTurn.current = options.latestSettledTurn;
    void load(true, true);
  }, [load, options.enabled, options.project?.type, options.latestSettledTurn]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      activeRequest.current?.abort();
      activeRequest.current = undefined;
      generation.current += 1;
    };
  }, []);

  return {
    status,
    observation,
    errorMessage,
    refresh: () => load(true),
    retry: () => load(true),
  };
}

function required(value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    throw new Error("Octant Project authority is unavailable.");
  }
  return value;
}

function failureMessage(error: unknown): string {
  return typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
    ? error.message
    : "Octant Project service is unavailable.";
}
