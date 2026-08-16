export type LocalHostOwnership = "desktop-owned" | "managed";
export type LocalHostState = "stopped" | "starting" | "running" | "attention-required";

export interface LocalHostDescriptor {
  readonly url: string;
  readonly instanceId: string;
  readonly ownership: LocalHostOwnership;
}

export interface LocalHostActivity {
  readonly activeAgentCount: number;
  readonly attentionRequired: boolean;
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

export function shouldConfirmQuit(snapshot: LocalHostSnapshot): boolean {
  return (
    snapshot.state !== "stopped" &&
    snapshot.ownership === "desktop-owned" &&
    (snapshot.activeAgentCount > 0 || snapshot.attentionRequired)
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
        activity = { activeAgentCount: 0, attentionRequired: true };
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
