import type { ActiveWorkAnswer, ActiveWorkClient } from "@octant/client-runtime/active-work-client";
import { useEffect, useRef, useState } from "react";
import { documentIsVisible } from "../polling/documentVisibility";

/** A computer this window is paired with, and what its session last said of it. */
export interface ActiveWorkHost {
  readonly hostId: string;
  readonly name: string;
  readonly reach: "ready" | "connecting" | "refused" | "unreachable";
  /** When this window was last connected to it; absent when it never was. */
  readonly lastReadyAt?: string;
  readonly client?: ActiveWorkClient;
  /**
   * The existing change signal for that computer. A new value asks for one more
   * read; nothing here runs on a timer of its own.
   */
  readonly revision: unknown;
}

export type ActiveWorkReading =
  | { readonly status: "loading" }
  | ActiveWorkAnswer
  /** The session is down, so nothing is known about the computer now. */
  | { readonly status: "not-connected" };

/** A read that has not answered by now counts as a computer that did not answer. */
const READ_TIMEOUT_MS = 10_000;
/** A streaming reply moves the change signal many times a second; one read covers them. */
const READ_SPACING_MS = 1_000;

/** The last answer from each session, so coming back to the page shows rows at once. */
const lastAnswers = new WeakMap<ActiveWorkClient, ActiveWorkAnswer>();

interface HostReader {
  readonly client: ActiveWorkClient;
  readonly request: () => void;
  readonly stop: () => void;
  revision: unknown;
}

/**
 * Every computer's own active work, each read over its own session and none
 * waiting for another. A computer that stops answering keeps no rows: what it
 * was doing is not what it is doing.
 */
export function useActiveWork(
  hosts: ReadonlyArray<ActiveWorkHost>,
): ReadonlyMap<string, ActiveWorkReading> {
  const [readings, setReadings] = useState<ReadonlyMap<string, ActiveWorkReading>>(new Map());
  const readers = useRef(new Map<string, HostReader>());

  useEffect(() => {
    const live = readers.current;
    // An answer from before a computer dropped out is not what it is doing
    // when it comes back, so it is not shown again while the next read runs.
    for (const host of hosts) {
      if (host.reach !== "ready" && host.client !== undefined) lastAnswers.delete(host.client);
    }
    const wanted = new Map(
      hosts.flatMap((host) =>
        host.reach === "ready" && host.client !== undefined
          ? [[host.hostId, { client: host.client, revision: host.revision }] as const]
          : [],
      ),
    );
    for (const [hostId, reader] of live) {
      if (wanted.get(hostId)?.client === reader.client) continue;
      reader.stop();
      live.delete(hostId);
      setReadings((current) => {
        const next = new Map(current);
        next.delete(hostId);
        return next;
      });
    }
    for (const [hostId, { client, revision }] of wanted) {
      const existing = live.get(hostId);
      if (existing === undefined) {
        const reader = startReader(client, revision, (reading) =>
          setReadings((current) => new Map(current).set(hostId, reading)),
        );
        live.set(hostId, reader);
        reader.request();
      } else if (existing.revision !== revision) {
        existing.revision = revision;
        existing.request();
      }
    }
  }, [hosts]);

  useEffect(() => {
    const live = readers.current;
    return () => {
      for (const reader of live.values()) reader.stop();
      live.clear();
    };
  }, []);

  return new Map(
    hosts.map((host) => [
      host.hostId,
      host.reach === "ready" && host.client !== undefined
        ? (readings.get(host.hostId) ?? lastAnswers.get(host.client) ?? { status: "loading" })
        : host.reach === "connecting"
          ? { status: "loading" }
          : { status: host.reach === "refused" ? "refused" : "not-connected" },
    ]),
  );
}

function startReader(
  client: ActiveWorkClient,
  revision: unknown,
  onReading: (reading: ActiveWorkAnswer) => void,
): HostReader {
  const controller = new AbortController();
  let inFlight = false;
  let pending = false;
  let lastStart = Number.NEGATIVE_INFINITY;
  let hold: ReturnType<typeof setTimeout> | undefined;

  const read = async (): Promise<void> => {
    inFlight = true;
    pending = false;
    lastStart = Date.now();
    const answer = await client.read(
      AbortSignal.any([controller.signal, AbortSignal.timeout(READ_TIMEOUT_MS)]),
    );
    inFlight = false;
    if (controller.signal.aborted) return;
    lastAnswers.set(client, answer);
    onReading(answer);
    if (pending) request();
  };
  const request = () => {
    if (controller.signal.aborted) return;
    pending = true;
    if (inFlight || hold !== undefined || !documentIsVisible()) return;
    const wait = lastStart + READ_SPACING_MS - Date.now();
    if (wait <= 0) {
      void read();
      return;
    }
    hold = setTimeout(() => {
      hold = undefined;
      if (pending && documentIsVisible()) void read();
    }, wait);
  };
  const onVisible = () => {
    if (pending) request();
  };
  document.addEventListener("visibilitychange", onVisible);
  return {
    client,
    revision,
    request,
    stop: () => {
      controller.abort();
      if (hold !== undefined) clearTimeout(hold);
      document.removeEventListener("visibilitychange", onVisible);
    },
  };
}
