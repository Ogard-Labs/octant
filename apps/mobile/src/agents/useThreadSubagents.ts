import {
  mobileSubagentIsActive,
  readMobileLiveTasks,
  readMobileSubagents,
  type MobileLiveTask,
  type MobileRemoteTransport,
  type MobileSubagent,
} from "@octant/client-runtime";
import { useCallback, useEffect, useRef, useState } from "react";

/** How often the list is read while something in the thread is at work. */
const WORKING_INTERVAL_MS = 3_000;
/** How often it is read while nothing is; a new subagent starts with a turn. */
const IDLE_INTERVAL_MS = 30_000;

export interface ThreadSubagents {
  readonly subagents: ReadonlyArray<MobileSubagent>;
  readonly liveTasks: ReadonlyArray<MobileLiveTask>;
  /** The computer refused: this device may not read the thread's subagents. */
  readonly refused: boolean;
  /** The computer holds more than the phone shows: the oldest finished ones are left out. */
  readonly truncated: boolean;
  readonly refresh: () => void;
}

/**
 * A thread's subagents and background tasks, read from its computer while the
 * thread is on screen: often while a turn or a subagent works, rarely
 * otherwise. A failed read keeps the last list rather than emptying it.
 */
export function useThreadSubagents(input: {
  readonly transport: MobileRemoteTransport | undefined;
  readonly threadId: string | undefined;
  readonly mode: "chat" | "work" | "code" | undefined;
  /** A turn is running, so new subagents may start at any moment. */
  readonly turnLive: boolean;
}): ThreadSubagents {
  const { transport, threadId, mode, turnLive } = input;
  const [subagents, setSubagents] = useState<ReadonlyArray<MobileSubagent>>([]);
  const [liveTasks, setLiveTasks] = useState<ReadonlyArray<MobileLiveTask>>([]);
  const [refused, setRefused] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [tick, setTick] = useState(0);
  const reading = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    setSubagents([]);
    setLiveTasks([]);
    setRefused(false);
    setTruncated(false);
  }, [transport, threadId]);

  const working = turnLive || subagents.some((subagent) => mobileSubagentIsActive(subagent.status));

  useEffect(() => {
    if (transport === undefined || threadId === undefined || mode === undefined) return;
    const controller = new AbortController();
    reading.current?.abort();
    reading.current = controller;
    void (async () => {
      const [read, tasks] = await Promise.all([
        readMobileSubagents({ transport, threadId, signal: controller.signal }),
        mode === "chat"
          ? undefined
          : readMobileLiveTasks({ transport, mode, threadId, signal: controller.signal }),
      ]);
      if (controller.signal.aborted) return;
      if (read.status === "listed") {
        setSubagents(read.subagents);
        setTruncated(read.truncated);
        setRefused(false);
      } else if (read.status === "refused") {
        setSubagents([]);
        setRefused(true);
      }
      if (tasks?.status === "listed") setLiveTasks(tasks.tasks);
      else if (tasks?.status === "refused") setLiveTasks([]);
    })();
    const timer = setTimeout(
      () => setTick((value) => value + 1),
      working ? WORKING_INTERVAL_MS : IDLE_INTERVAL_MS,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [transport, threadId, mode, working, tick]);

  const refresh = useCallback(() => setTick((value) => value + 1), []);
  return { subagents, liveTasks, refused, truncated, refresh };
}
