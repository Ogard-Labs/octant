import { createProjectClient, type ProjectClient } from "@octant/client-runtime/project-client";
import type { CodeEnvironmentObservation, CodeThreadId, ProjectSummary } from "@octant/contracts";
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
  readonly enabled: boolean;
  readonly serverUrl?: string;
  readonly windowCapability?: string;
}

export const CODE_ENVIRONMENT_REFRESH_INTERVAL_MS = 2_000;

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

  const load = useCallback(
    async (reason: "open" | "poll" | "refresh" | "retry"): Promise<void> => {
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

      if (reason === "poll" && activeRequest.current !== undefined) return;

      activeRequest.current?.abort();
      const controller = new AbortController();
      activeRequest.current = controller;
      const request = ++generation.current;
      if (reason !== "poll") {
        setStatus("loading");
        setObservation(undefined);
        setErrorMessage(undefined);
      }
      try {
        const nextObservation =
          options.threadId === undefined
            ? await fallbackClient.environment(project.id, controller.signal)
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
        if (reason !== "poll") setStatus("error");
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
    void load("open");
  }, [
    load,
    options.enabled,
    options.project?.id,
    options.project?.type,
    options.project?.updatedAt,
  ]);

  useEffect(() => {
    if (!options.enabled || options.project?.type !== "code") return;
    const interval = globalThis.setInterval(() => {
      void load("poll");
    }, CODE_ENVIRONMENT_REFRESH_INTERVAL_MS);
    return () => globalThis.clearInterval(interval);
  }, [load, options.enabled, options.project?.type]);

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
    refresh: () => load("refresh"),
    retry: () => load("retry"),
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
