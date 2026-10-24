import type { MachineChangeClient } from "@octant/client-runtime/machine-change-client";
import type { MachineChangeTopic } from "@octant/contracts/machine-changes";
import { useEffect, useState } from "react";
import { waitForReconnect } from "../lib/waitForReconnect";

export interface MachineChangeRevisions {
  readonly computerUse: number;
  readonly chatNavigation: number;
  readonly workNavigation: number;
  readonly codeNavigation: number;
  readonly projects: number;
  readonly extensions: number;
  readonly imageJobs: number;
}

const INITIAL_REVISIONS: MachineChangeRevisions = {
  computerUse: 0,
  chatNavigation: 0,
  workNavigation: 0,
  codeNavigation: 0,
  projects: 0,
  extensions: 0,
  imageJobs: 0,
};

/**
 * How long a burst of notices is merged into one revision bump after the
 * first one has gone through. A streamed Chat reply appends one journal
 * event per text delta, and each one reaches this feed as a `chat-navigation`
 * notice, so without a window every delta re-read the navigation list and
 * re-rendered the shell: 775 times for one reply. The first notice of a
 * burst still lands at once, so a single change is not delayed.
 */
export const MACHINE_CHANGE_COALESCE_MS = 200;

/** One Machine stream replaces per-feature navigation timers in the renderer. */
export function useMachineChangeFeed(client: MachineChangeClient): MachineChangeRevisions {
  const [revisions, setRevisions] = useState(INITIAL_REVISIONS);
  useEffect(() => {
    const controller = new AbortController();
    const held = new Set<MachineChangeTopic>();
    let hold: ReturnType<typeof setTimeout> | undefined;
    const release = () => {
      hold = undefined;
      if (held.size === 0) return;
      const topics = [...held];
      held.clear();
      setRevisions((current) => advanceRevisions(current, topics));
      hold = setTimeout(release, MACHINE_CHANGE_COALESCE_MS);
    };
    void consumeMachineChanges(client, controller.signal, (topics) => {
      if (hold === undefined) {
        setRevisions((current) => advanceRevisions(current, topics));
        hold = setTimeout(release, MACHINE_CHANGE_COALESCE_MS);
        return;
      }
      for (const topic of topics) held.add(topic);
    });
    return () => {
      controller.abort();
      if (hold !== undefined) clearTimeout(hold);
    };
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
            ? [
                "projects",
                "chat-navigation",
                "work-navigation",
                "code-navigation",
                "extensions",
                "computer-use",
                "image-jobs",
              ]
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
    computerUse: current.computerUse + Number(changed.has("computer-use")),
    chatNavigation: current.chatNavigation + Number(changed.has("chat-navigation")),
    workNavigation: current.workNavigation + Number(changed.has("work-navigation")),
    codeNavigation: current.codeNavigation + Number(changed.has("code-navigation")),
    projects: current.projects + Number(changed.has("projects")),
    extensions: current.extensions + Number(changed.has("extensions")),
    imageJobs: current.imageJobs + Number(changed.has("image-jobs")),
  };
}
