import type { MachineChangeClient } from "@octant/client-runtime/machine-change-client";
import type { MachineChangeTopic } from "@octant/contracts/machine-changes";
import { useEffect, useState } from "react";

export interface MachineChangeRevisions {
  readonly chatNavigation: number;
  readonly workNavigation: number;
  readonly codeNavigation: number;
  readonly projects: number;
  readonly extensions: number;
}

const INITIAL_REVISIONS: MachineChangeRevisions = {
  chatNavigation: 0,
  workNavigation: 0,
  codeNavigation: 0,
  projects: 0,
  extensions: 0,
};

/** One Machine stream replaces per-feature navigation timers in the renderer. */
export function useMachineChangeFeed(client: MachineChangeClient): MachineChangeRevisions {
  const [revisions, setRevisions] = useState(INITIAL_REVISIONS);
  useEffect(() => {
    const controller = new AbortController();
    void consumeMachineChanges(client, controller.signal, (topics) => {
      setRevisions((current) => advanceRevisions(current, topics));
    });
    return () => controller.abort();
  }, [client]);
  return revisions;
}

async function consumeMachineChanges(
  client: MachineChangeClient,
  signal: AbortSignal,
  changed: (topics: ReadonlyArray<MachineChangeTopic>) => void,
): Promise<void> {
  let cursor = 0;
  let retryMs = 250;
  while (!signal.aborted) {
    try {
      let received = false;
      for await (const frame of client.subscribe(cursor, signal)) {
        if (signal.aborted) return;
        received = true;
        cursor = frame.sequence;
        changed(
          frame.kind === "snapshot-required"
            ? ["projects", "chat-navigation", "work-navigation", "code-navigation", "extensions"]
            : frame.topics,
        );
      }
      retryMs = received ? 50 : Math.min(retryMs * 2, 2_000);
    } catch {
      if (signal.aborted) return;
      retryMs = Math.min(retryMs * 2, 2_000);
    }
    await waitForReconnect(signal, retryMs);
  }
}

function advanceRevisions(
  current: MachineChangeRevisions,
  topics: ReadonlyArray<MachineChangeTopic>,
): MachineChangeRevisions {
  const changed = new Set(topics);
  return {
    chatNavigation: current.chatNavigation + Number(changed.has("chat-navigation")),
    workNavigation: current.workNavigation + Number(changed.has("work-navigation")),
    codeNavigation: current.codeNavigation + Number(changed.has("code-navigation")),
    projects: current.projects + Number(changed.has("projects")),
    extensions: current.extensions + Number(changed.has("extensions")),
  };
}

async function waitForReconnect(signal: AbortSignal, delayMs: number): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, delayMs);
    const abort = () => done();
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve();
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}
