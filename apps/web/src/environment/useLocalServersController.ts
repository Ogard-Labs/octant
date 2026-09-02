import { createLocalServerClient, type LocalServerClient } from "@octant/client-runtime";
import type {
  CodeThreadId,
  LocalServerFailure,
  LocalServerListenerId,
  LocalServerOpenTarget,
  LocalServerSnapshot,
  LocalServerStopConfirmation,
  ProjectId,
} from "@octant/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { scheduleVisibleInterval } from "../polling/documentVisibility";

export type LocalServersStatus = "idle" | "loading" | "ready" | "error";

/** Refresh cadence while the section is visible. Hidden panels never scan. */
export const LOCAL_SERVERS_REFRESH_INTERVAL_MS = 5_000;

export interface LocalServersController {
  readonly status: LocalServersStatus;
  readonly snapshot?: LocalServerSnapshot | undefined;
  readonly errorMessage?: string | undefined;
  /** The host's last typed refusal, kept so the panel can state it in words. */
  readonly failure?: LocalServerFailure | undefined;
  readonly busyListenerId?: LocalServerListenerId | undefined;
  readonly refresh: () => Promise<void>;
  readonly open: (listenerId: LocalServerListenerId) => Promise<LocalServerOpenTarget | undefined>;
  readonly stop: (
    listenerId: LocalServerListenerId,
    confirmation?: LocalServerStopConfirmation,
  ) => Promise<boolean>;
  readonly dismissFailure: () => void;
}

export interface LocalServersControllerOptions {
  readonly client?: LocalServerClient;
  readonly threadId?: CodeThreadId | undefined;
  readonly projectId?: ProjectId | undefined;
  /** True only while local servers may be observed at all. */
  readonly enabled: boolean;
  /**
   * Interval refresh while the Environment tab is open. A closed tab still
   * takes one observation for the summary count and then stays quiet.
   */
  readonly poll?: boolean;
  readonly serverUrl?: string;
  readonly windowCapability?: string;
  readonly newRequestId?: () => string;
  readonly refreshIntervalMs?: number;
}

/**
 * Drive the Code Environment "Local servers" section.
 *
 * The host is authoritative for classification, health, and whether Stop is
 * offered at all; this controller only transports commands and holds the last
 * snapshot. A closed Environment takes one observation for the compact count
 * and then stays quiet. Interval refresh, and a refresh the moment polling
 * starts, run only while the Environment tab is open. Disabled sections never scan.
 */
export function useLocalServersController(
  options: LocalServersControllerOptions,
): LocalServersController {
  const client = useMemo(() => {
    if (options.client !== undefined) return options.client;
    if (!options.enabled) return undefined;
    const baseUrl = options.serverUrl;
    const windowCapability = options.windowCapability;
    if (baseUrl === undefined || windowCapability === undefined) return undefined;
    return createLocalServerClient({ baseUrl, fetch: globalThis.fetch, windowCapability });
  }, [options.client, options.enabled, options.serverUrl, options.windowCapability]);

  // Held in a ref so a caller that passes a fresh arrow each render cannot
  // retrigger the scan effect and abort its own in-flight request.
  const newRequestIdRef = useRef(options.newRequestId);
  newRequestIdRef.current = options.newRequestId;
  const newRequestId = useCallback(
    () => newRequestIdRef.current?.() ?? globalThis.crypto.randomUUID(),
    [],
  );
  const [status, setStatus] = useState<LocalServersStatus>("idle");
  const [snapshot, setSnapshot] = useState<LocalServerSnapshot>();
  const [errorMessage, setErrorMessage] = useState<string>();
  const [failure, setFailure] = useState<LocalServerFailure>();
  const [busyListenerId, setBusyListenerId] = useState<LocalServerListenerId>();
  const mounted = useRef(true);
  const generation = useRef(0);
  const active = useRef<AbortController | undefined>(undefined);

  const ready =
    options.enabled &&
    client !== undefined &&
    options.threadId !== undefined &&
    options.projectId !== undefined;

  const load = useCallback(
    async (reason: "open" | "poll" | "refresh"): Promise<void> => {
      const threadId = options.threadId;
      const projectId = options.projectId;
      if (
        !options.enabled ||
        client === undefined ||
        threadId === undefined ||
        projectId === undefined
      ) {
        active.current?.abort();
        active.current = undefined;
        generation.current += 1;
        setStatus("idle");
        setSnapshot(undefined);
        setErrorMessage(undefined);
        return;
      }
      if (reason === "poll" && active.current !== undefined) return;

      active.current?.abort();
      const controller = new AbortController();
      active.current = controller;
      const request = ++generation.current;
      if (reason !== "poll") setStatus("loading");
      try {
        const result = await client.execute(
          {
            kind: "list-local-servers",
            requestId: newRequestId() as never,
            threadId,
            projectId,
          },
          controller.signal,
        );
        if (!mounted.current || request !== generation.current) return;
        if (result.kind === "local-servers-listed") {
          setSnapshot(result.snapshot);
          setErrorMessage(undefined);
          setStatus("ready");
          return;
        }
        if (result.kind === "local-server-rejected") {
          setSnapshot(undefined);
          setErrorMessage(result.failure.message);
          setStatus("error");
        }
      } catch (error) {
        // An abort is this controller replacing its own request, never a host
        // failure the user should see.
        if (!mounted.current || request !== generation.current || controller.signal.aborted) return;
        if (reason !== "poll") setStatus("error");
        setErrorMessage(failureMessage(error));
      } finally {
        if (active.current === controller) active.current = undefined;
      }
    },
    [client, newRequestId, options.enabled, options.projectId, options.threadId],
  );

  useEffect(() => {
    void load("open");
  }, [load]);

  useEffect(() => {
    if (!ready || options.poll === false) return;
    return scheduleVisibleInterval(
      () => {
        void load("poll");
      },
      options.refreshIntervalMs ?? LOCAL_SERVERS_REFRESH_INTERVAL_MS,
      {
        runImmediately: true,
      },
    );
  }, [load, options.poll, options.refreshIntervalMs, ready]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current?.abort();
      active.current = undefined;
      generation.current += 1;
    };
  }, []);

  const open = useCallback(
    async (listenerId: LocalServerListenerId): Promise<LocalServerOpenTarget | undefined> => {
      const threadId = options.threadId;
      const projectId = options.projectId;
      if (client === undefined || threadId === undefined || projectId === undefined) {
        return undefined;
      }
      setBusyListenerId(listenerId);
      setFailure(undefined);
      try {
        const result = await client.execute({
          kind: "open-local-server",
          requestId: newRequestId() as never,
          threadId,
          projectId,
          listenerId,
        });
        if (result.kind === "local-server-open-prepared") return result.target;
        if (result.kind === "local-server-rejected") setFailure(result.failure);
        return undefined;
      } catch (error) {
        setFailure({ category: "unavailable", message: failureMessage(error) as never });
        return undefined;
      } finally {
        if (mounted.current) setBusyListenerId(undefined);
      }
    },
    [client, newRequestId, options.projectId, options.threadId],
  );

  const stop = useCallback(
    async (
      listenerId: LocalServerListenerId,
      confirmation?: LocalServerStopConfirmation,
    ): Promise<boolean> => {
      const threadId = options.threadId;
      const projectId = options.projectId;
      if (client === undefined || threadId === undefined || projectId === undefined) return false;
      setBusyListenerId(listenerId);
      setFailure(undefined);
      try {
        const result = await client.execute({
          kind: "stop-local-server",
          requestId: newRequestId() as never,
          threadId,
          projectId,
          listenerId,
          ...(confirmation === undefined ? {} : { confirmation }),
        });
        if (result.kind === "local-server-stopped") {
          if (mounted.current) {
            // The host refreshed as part of the stop; adopt that observation
            // rather than showing a row the server has already retired.
            setSnapshot(result.snapshot);
            setStatus("ready");
          }
          return true;
        }
        if (result.kind === "local-server-rejected" && mounted.current) setFailure(result.failure);
        return false;
      } catch (error) {
        if (mounted.current) {
          setFailure({ category: "unavailable", message: failureMessage(error) as never });
        }
        return false;
      } finally {
        if (mounted.current) setBusyListenerId(undefined);
      }
    },
    [client, newRequestId, options.projectId, options.threadId],
  );

  return {
    status,
    snapshot,
    errorMessage,
    failure,
    busyListenerId,
    refresh: () => load("refresh"),
    open,
    stop,
    dismissFailure: () => setFailure(undefined),
  };
}

function failureMessage(error: unknown): string {
  return typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
    ? error.message
    : "Octant Local servers are unavailable.";
}
