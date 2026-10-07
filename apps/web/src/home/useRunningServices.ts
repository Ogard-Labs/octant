import type { LocalServerClient } from "@octant/client-runtime";
import type {
  LocalServerFailure,
  LocalServerListenerId,
  LocalServerOpenTarget,
  LocalServerRequestId,
  RunningService,
} from "@octant/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { LOCAL_SERVERS_REFRESH_INTERVAL_MS } from "../environment/useLocalServersController";
import { failureMessage } from "../lib/failureMessage";
import { scheduleVisibleInterval } from "../polling/documentVisibility";

const UNAVAILABLE = "Octant Running services are unavailable.";

export type RunningServicesStatus = "loading" | "ready" | "unavailable";

export interface RunningServicesController {
  readonly status: RunningServicesStatus;
  readonly services: ReadonlyArray<RunningService>;
  /** Why the host could not look, when it never gave a first answer. */
  readonly unavailableMessage?: string;
  /** The host's last typed refusal of an Open or Stop, kept to say in words. */
  readonly failure?: LocalServerFailure;
  readonly busyListenerId?: LocalServerListenerId;
  readonly open: (service: RunningService) => Promise<LocalServerOpenTarget | undefined>;
  readonly stop: (service: RunningService, confirmed: boolean) => Promise<void>;
  readonly dismissFailure: () => void;
}

/**
 * The start screen's Running services, read from the host.
 *
 * The host classifies, attributes, and decides Stop; this hook carries commands
 * and holds the last answer. It reads once when the card mounts and then on the
 * Environment panel's own cadence, and only while the document is visible. The
 * card is mounted only while it is on and the start screen is showing, so a
 * card that is off, or a screen that is not there, scans nothing. A read the
 * host refuses after an answer keeps that answer; before one, the card says it
 * could not look rather than describing a quiet computer.
 */
export function useRunningServices(options: {
  readonly client: LocalServerClient | undefined;
  readonly refreshIntervalMs?: number;
}): RunningServicesController {
  const { client } = options;
  const [status, setStatus] = useState<RunningServicesStatus>("loading");
  const [services, setServices] = useState<ReadonlyArray<RunningService>>([]);
  const [unavailableMessage, setUnavailableMessage] = useState<string>();
  const [failure, setFailure] = useState<LocalServerFailure>();
  const [busyListenerId, setBusyListenerId] = useState<LocalServerListenerId>();
  const mounted = useRef(true);
  const answered = useRef(false);
  const active = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current?.abort();
      active.current = undefined;
    };
  }, []);

  useEffect(() => {
    if (client === undefined) return;
    const load = async () => {
      // A scan still outstanding is not asked again: the host bounds it, and
      // piling a second on a slow computer is what the cadence exists to avoid.
      if (active.current !== undefined) return;
      const controller = new AbortController();
      active.current = controller;
      try {
        const result = await client.executeRunningServices(
          { kind: "list-running-services", requestId: newRequestId() },
          controller.signal,
        );
        if (!mounted.current || controller.signal.aborted) return;
        if (result.kind === "running-services-listed") {
          answered.current = true;
          setServices(result.snapshot.services);
          setStatus("ready");
        } else if (result.kind === "running-service-rejected" && !answered.current) {
          setUnavailableMessage(result.failure.message);
          setStatus("unavailable");
        }
      } catch (error) {
        if (!mounted.current || controller.signal.aborted || answered.current) return;
        setUnavailableMessage(failureMessage(error, UNAVAILABLE));
        setStatus("unavailable");
      } finally {
        if (active.current === controller) active.current = undefined;
      }
    };
    return scheduleVisibleInterval(
      () => void load(),
      options.refreshIntervalMs ?? LOCAL_SERVERS_REFRESH_INTERVAL_MS,
      { runImmediately: true },
    );
  }, [client, options.refreshIntervalMs]);

  const open = useCallback(
    async (service: RunningService): Promise<LocalServerOpenTarget | undefined> => {
      if (client === undefined) return undefined;
      setBusyListenerId(service.listenerId);
      setFailure(undefined);
      try {
        const result = await client.executeRunningServices({
          kind: "open-running-service",
          requestId: newRequestId(),
          listenerId: service.listenerId,
        });
        if (result.kind === "running-service-open-prepared") return result.target;
        if (result.kind === "running-service-rejected") setFailure(result.failure);
        return undefined;
      } catch (error) {
        setFailure(unavailable(error));
        return undefined;
      } finally {
        if (mounted.current) setBusyListenerId(undefined);
      }
    },
    [client],
  );

  const stop = useCallback(
    async (service: RunningService, confirmed: boolean): Promise<void> => {
      if (client === undefined) return;
      setBusyListenerId(service.listenerId);
      setFailure(undefined);
      try {
        const result = await client.executeRunningServices({
          kind: "stop-running-service",
          requestId: newRequestId(),
          listenerId: service.listenerId,
          // Echoes exactly what the confirmation showed; the host re-checks it
          // against the listener it finds, so a stale one signals nothing.
          ...(confirmed
            ? {
                confirmation: {
                  acknowledgedProcessName: service.processName,
                  acknowledgedPort: service.port,
                  ...(service.workingDirectory === undefined
                    ? {}
                    : { acknowledgedWorkingDirectory: service.workingDirectory }),
                },
              }
            : {}),
        });
        if (!mounted.current) return;
        if (result.kind === "running-service-stopped") {
          // The host re-listed as part of the stop; adopt that rather than show
          // a row it has already retired.
          answered.current = true;
          setServices(result.snapshot.services);
          setStatus("ready");
        } else if (result.kind === "running-service-rejected") {
          setFailure(result.failure);
        }
      } catch (error) {
        if (mounted.current) setFailure(unavailable(error));
      } finally {
        if (mounted.current) setBusyListenerId(undefined);
      }
    },
    [client],
  );

  const dismissFailure = useCallback(() => setFailure(undefined), []);

  return {
    status: client === undefined ? "unavailable" : status,
    services,
    ...(unavailableMessage === undefined ? {} : { unavailableMessage }),
    ...(failure === undefined ? {} : { failure }),
    ...(busyListenerId === undefined ? {} : { busyListenerId }),
    open,
    stop,
    dismissFailure,
  };
}

function newRequestId(): LocalServerRequestId {
  return globalThis.crypto.randomUUID() as LocalServerRequestId;
}

function unavailable(error: unknown): LocalServerFailure {
  return { category: "unavailable", message: failureMessage(error, UNAVAILABLE) };
}
