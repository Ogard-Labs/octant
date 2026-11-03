import type { UpdateWorkInFlight } from "@octant/domain";

export type LocalHostOwnership = "desktop-owned" | "managed";
export type LocalHostState = "stopped" | "starting" | "running" | "attention-required";

export interface LocalHostDescriptor {
  readonly url: string;
  readonly instanceId: string;
  readonly ownership: LocalHostOwnership;
}

export interface LocalHostActivity {
  readonly activeAgentCount: number;
  /**
   * The host needs a look: a provider that is not ready, a lost host, a stranded
   * session. It drives the menu-bar mark and the "attention" state. It does not
   * say anything is running, so a signed-out provider sets it with no work at
   * all; whether stopping would interrupt something is `workInFlight`.
   */
  readonly attentionRequired: boolean;
  /**
   * The desktop could not confirm what the host is running (it did not answer
   * its health check, or its window authority could not be refreshed), so its
   * zero agent count proves nothing and stopping may still interrupt work.
   */
  readonly activityUnconfirmed?: boolean;
}

export interface LocalHostSnapshot extends LocalHostActivity {
  readonly state: LocalHostState;
  readonly ownership: LocalHostOwnership | undefined;
  readonly url?: string;
  readonly instanceId?: string;
}

export interface HostLifecycleOperations {
  readonly attach: () => Promise<LocalHostDescriptor | undefined>;
  readonly start: () => Promise<LocalHostDescriptor>;
  readonly stop: (host: LocalHostDescriptor) => Promise<void>;
}

export type HostAction = "start" | "stop" | "restart";
export type HostQuitResult = "stopped" | "attached" | "cancelled";

export function canRunHostAction(snapshot: LocalHostSnapshot, action: HostAction): boolean {
  if (action === "start") {
    return snapshot.state === "stopped" && snapshot.ownership !== "managed";
  }
  return snapshot.state !== "stopped" && snapshot.ownership === "desktop-owned";
}

export interface FreshHostActivitySource {
  readonly refreshActivity: () => Promise<void>;
  readonly snapshot: () => LocalHostSnapshot;
  /** How long the fresh reading may take before it counts as unconfirmed. */
  readonly boundMs?: number;
}

/**
 * The desktop's activity refresh also re-reads window authorities and, with a
 * menu bar, the fleet roster, and those requests carry no timeout of their own.
 * Without a bound one stalled request would leave Relaunch to update, or Quit,
 * waiting forever.
 */
const FRESH_ACTIVITY_BOUND_MS = 2_000;

/**
 * The conservative activity reading for quitting and installing a downloaded
 * update. Both read this one value so they cannot disagree.
 *
 * Running agents count, and so does a thread parked on an approval or question,
 * because its session is still live. The count can also include idle provider
 * sessions kept for another turn. A provider that merely needs sign-in or is
 * not installed interrupts nothing and does not count. Work the desktop could
 * not confirm sets `activityUnconfirmed`, so the install waits and quit asks
 * rather than trusting a zero it could not check.
 */
export function workInFlight(snapshot: LocalHostActivity): UpdateWorkInFlight;
export function workInFlight(source: FreshHostActivitySource): Promise<UpdateWorkInFlight>;
export function workInFlight(
  input: LocalHostActivity | FreshHostActivitySource,
): UpdateWorkInFlight | Promise<UpdateWorkInFlight> {
  if ("refreshActivity" in input) {
    return refreshWorkInFlight(input);
  }
  return {
    activeAgentCount: input.activeAgentCount,
    activityUnconfirmed: input.activityUnconfirmed === true,
  };
}

async function refreshWorkInFlight(source: FreshHostActivitySource): Promise<UpdateWorkInFlight> {
  let refreshFailed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // A reading that does not finish in time is one the desktop could not
    // confirm, so the install waits and quit asks, as for a failed one.
    const outcome = await Promise.race([
      source.refreshActivity().then(() => "refreshed" as const),
      new Promise<"timed-out">((resolve) => {
        timer = setTimeout(() => resolve("timed-out"), source.boundMs ?? FRESH_ACTIVITY_BOUND_MS);
      }),
    ]);
    refreshFailed = outcome === "timed-out";
  } catch {
    refreshFailed = true;
  } finally {
    clearTimeout(timer);
  }
  const snapshot = source.snapshot();
  const activeHost = snapshot.state !== "stopped" && snapshot.ownership !== undefined;
  return {
    activeAgentCount: snapshot.activeAgentCount,
    activityUnconfirmed: snapshot.activityUnconfirmed === true || (refreshFailed && activeHost),
  };
}

export function shouldConfirmQuit(
  snapshot: LocalHostSnapshot,
  work: UpdateWorkInFlight = workInFlight(snapshot),
): boolean {
  return (
    snapshot.state !== "stopped" &&
    snapshot.ownership === "desktop-owned" &&
    (work.activeAgentCount > 0 || work.activityUnconfirmed)
  );
}

export function createHostLifecycleController(operations: HostLifecycleOperations) {
  let host: LocalHostDescriptor | undefined;
  let state: LocalHostState = "stopped";
  let activity: LocalHostActivity = { activeAgentCount: 0, attentionRequired: false };
  let pending: Promise<unknown> = Promise.resolve();

  const snapshot = (): LocalHostSnapshot => ({
    state,
    ownership: host?.ownership,
    ...(host?.url === undefined ? {} : { url: host.url }),
    ...(host?.instanceId === undefined ? {} : { instanceId: host.instanceId }),
    ...activity,
  });

  const runExclusive = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = pending.then(operation, operation);
    pending = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const ensureRunning = (): Promise<LocalHostDescriptor> =>
    runExclusive(async () => {
      if (host !== undefined && state !== "stopped") return host;
      state = "starting";
      try {
        host = (await operations.attach()) ?? (await operations.start());
        state = activity.attentionRequired ? "attention-required" : "running";
        return host;
      } catch (error) {
        host = undefined;
        state = "attention-required";
        throw error;
      }
    });

  const stop = (): Promise<void> =>
    runExclusive(async () => {
      if (host === undefined || state === "stopped") return;
      if (host.ownership !== "desktop-owned") {
        throw new Error("Octant cannot stop a separately managed host.");
      }
      const stopping = host;
      await operations.stop(stopping);
      host = undefined;
      state = "stopped";
      activity = { activeAgentCount: 0, attentionRequired: false };
    });

  const reattachManagedHost = (): Promise<LocalHostDescriptor | undefined> =>
    runExclusive(async () => {
      if (host?.ownership !== "managed" || state === "stopped") return undefined;
      const replacement = await operations.attach();
      if (replacement?.ownership !== "managed") {
        state = "attention-required";
        activity = { activeAgentCount: 0, attentionRequired: true, activityUnconfirmed: true };
        return undefined;
      }
      host = replacement;
      state = "running";
      activity = { activeAgentCount: 0, attentionRequired: false };
      return replacement;
    });

  const restart = (): Promise<LocalHostDescriptor> =>
    runExclusive(async () => {
      if (host !== undefined && host.ownership !== "desktop-owned") {
        throw new Error("Octant cannot restart a separately managed host.");
      }
      if (host !== undefined && state !== "stopped") {
        const stopping = host;
        await operations.stop(stopping);
        host = undefined;
        state = "stopped";
      }
      state = "starting";
      try {
        host = await operations.start();
        state = activity.attentionRequired ? "attention-required" : "running";
        return host;
      } catch (error) {
        host = undefined;
        state = "stopped";
        activity = { activeAgentCount: 0, attentionRequired: false };
        throw error;
      }
    });

  const prepareQuit = (confirmQuit: () => boolean | Promise<boolean>): Promise<HostQuitResult> =>
    runExclusive(async () => {
      const current = snapshot();
      if (current.state === "stopped" || current.ownership === undefined) return "stopped";
      if (current.ownership === "managed") return "attached";
      if (shouldConfirmQuit(current) && !(await confirmQuit())) return "cancelled";
      const stopping = host;
      if (stopping !== undefined) await operations.stop(stopping);
      host = undefined;
      state = "stopped";
      activity = { activeAgentCount: 0, attentionRequired: false };
      return "stopped";
    });

  return Object.freeze({
    ensureRunning,
    onLastWindowClosed: (): void => undefined,
    prepareQuit,
    reattachManagedHost,
    restart,
    setActivity: (next: LocalHostActivity): void => {
      if (!Number.isSafeInteger(next.activeAgentCount) || next.activeAgentCount < 0) {
        throw new Error("Octant host activity count is invalid.");
      }
      activity = Object.freeze({ ...next });
      if (state === "running" || state === "attention-required") {
        state = next.attentionRequired ? "attention-required" : "running";
      }
    },
    snapshot,
    stop,
  });
}
