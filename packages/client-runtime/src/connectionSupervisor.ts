import type { RemoteSessionBridge, RemoteSessionBridgeState } from "./remoteSessionBridge";

export type ConnectionStatusKind =
  | "idle"
  | "connecting"
  | "connected"
  | "stale"
  | "waiting-to-retry"
  | "offline"
  | "blocked";

export interface ConnectionStatus {
  readonly kind: ConnectionStatusKind;
  /** Consecutive failed attempts since the last connected state. */
  readonly attempts: number;
  readonly retryDelayMs?: number;
  readonly hostId?: string;
  readonly displayName?: string;
  readonly reason?: string;
}

export interface ConnectionSupervisorOptions {
  readonly bridge: RemoteSessionBridge;
  /** Origin used to resume a paired device when no live connection remains. */
  readonly origin: string;
  readonly retryDelaysMs?: ReadonlyArray<number>;
  readonly schedule?: (run: () => void, delayMs: number) => () => void;
  readonly online?: () => boolean;
  readonly observeNetworkStatus?: (listener: (online: boolean) => void) => () => void;
  readonly observeWake?: (listener: () => void) => () => void;
}

export interface ConnectionSupervisor {
  readonly status: () => ConnectionStatus;
  readonly subscribe: (listener: (status: ConnectionStatus) => void) => () => void;
  readonly start: () => void;
  readonly retryNow: () => void;
  readonly wake: () => void;
  readonly stop: () => void;
}

const DEFAULT_RETRY_DELAYS_MS = [3_000, 4_000, 8_000, 16_000] as const;

function defaultSchedule(run: () => void, delayMs: number): () => void {
  const timer = globalThis.setTimeout(run, delayMs);
  return () => globalThis.clearTimeout(timer);
}

function defaultOnline(): boolean {
  return typeof navigator === "undefined" || typeof navigator.onLine !== "boolean"
    ? true
    : navigator.onLine;
}

function defaultObserveNetworkStatus(listener: (online: boolean) => void): () => void {
  if (typeof globalThis.addEventListener !== "function") return () => undefined;
  const onOnline = () => listener(true);
  const onOffline = () => listener(false);
  globalThis.addEventListener("online", onOnline);
  globalThis.addEventListener("offline", onOffline);
  return () => {
    globalThis.removeEventListener("online", onOnline);
    globalThis.removeEventListener("offline", onOffline);
  };
}

function defaultObserveWake(listener: () => void): () => void {
  if (typeof document === "undefined" || typeof document.addEventListener !== "function") {
    return () => undefined;
  }
  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") listener();
  };
  document.addEventListener("visibilitychange", onVisibilityChange);
  return () => document.removeEventListener("visibilitychange", onVisibilityChange);
}

function stateFacts(
  state: RemoteSessionBridgeState,
): Pick<ConnectionStatus, "hostId" | "displayName" | "reason"> {
  return {
    ...("hostId" in state && state.hostId !== undefined ? { hostId: state.hostId } : {}),
    ...("displayName" in state && state.displayName !== undefined
      ? { displayName: state.displayName }
      : {}),
    ...("reason" in state ? { reason: state.reason } : {}),
  };
}

function sameStatus(left: ConnectionStatus, right: ConnectionStatus): boolean {
  return (
    left.kind === right.kind &&
    left.attempts === right.attempts &&
    left.retryDelayMs === right.retryDelayMs &&
    left.hostId === right.hostId &&
    left.displayName === right.displayName &&
    left.reason === right.reason
  );
}

export function createConnectionSupervisor(
  options: ConnectionSupervisorOptions,
): ConnectionSupervisor {
  const retryDelays =
    options.retryDelaysMs === undefined || options.retryDelaysMs.length === 0
      ? DEFAULT_RETRY_DELAYS_MS
      : options.retryDelaysMs;
  const schedule = options.schedule ?? defaultSchedule;
  const online = options.online ?? defaultOnline;
  const observeNetworkStatus = options.observeNetworkStatus ?? defaultObserveNetworkStatus;
  const observeWake = options.observeWake ?? defaultObserveWake;
  const listeners = new Set<(status: ConnectionStatus) => void>();
  let current: ConnectionStatus = { kind: "idle", attempts: 0 };
  let attempts = 0;
  let cancelRetry: (() => void) | undefined;
  let unsubscribeBridge: (() => void) | undefined;
  let unsubscribeNetwork: (() => void) | undefined;
  let unsubscribeWake: (() => void) | undefined;
  let started = false;

  const emit = (next: ConnectionStatus): void => {
    if (sameStatus(current, next)) return;
    current = next;
    for (const listener of listeners) listener(next);
  };

  const cancelPendingRetry = (): void => {
    cancelRetry?.();
    cancelRetry = undefined;
  };

  const currentFacts = (): Pick<ConnectionStatus, "hostId" | "displayName" | "reason"> => ({
    ...(current.hostId === undefined ? {} : { hostId: current.hostId }),
    ...(current.displayName === undefined ? {} : { displayName: current.displayName }),
    ...(current.reason === undefined ? {} : { reason: current.reason }),
  });

  const emitOffline = (): void => {
    cancelPendingRetry();
    emit({ kind: "offline", attempts, ...currentFacts() });
  };

  const attempt = (): void => {
    if (!started) return;
    if (!online()) {
      emitOffline();
      return;
    }
    cancelPendingRetry();
    try {
      if (options.bridge.connection() === undefined) {
        options.bridge.resume(options.origin);
      } else {
        options.bridge.reconnect();
      }
    } catch (error) {
      transientFailure(error instanceof Error ? error.message : "Remote host is unavailable.");
    }
  };

  const scheduleRetry = (delayMs: number): void => {
    cancelPendingRetry();
    cancelRetry = schedule(() => {
      cancelRetry = undefined;
      attempt();
    }, delayMs);
  };

  const transientFailure = (
    reason: string,
    facts: Pick<ConnectionStatus, "hostId" | "displayName"> = {},
    stale = false,
  ): void => {
    if (!online()) {
      emitOffline();
      return;
    }
    attempts += 1;
    const retryDelayMs = retryDelays[Math.min(attempts - 1, retryDelays.length - 1)];
    if (retryDelayMs === undefined) return;
    const currentStateFacts = {
      ...currentFacts(),
      ...facts,
    };
    if (stale) {
      emit({ kind: "stale", attempts, retryDelayMs, ...currentStateFacts });
      scheduleRetry(retryDelayMs);
      return;
    }
    emit({ kind: "waiting-to-retry", attempts, retryDelayMs, ...currentStateFacts, reason });
    scheduleRetry(retryDelayMs);
  };

  const handleBridgeState = (state: RemoteSessionBridgeState): void => {
    switch (state.kind) {
      case "idle":
        emit({ kind: "idle", attempts });
        return;
      case "connecting":
      case "negotiating":
      case "authenticating":
      case "reconnecting":
        emit({ kind: "connecting", attempts, ...stateFacts(state) });
        return;
      case "ready":
        attempts = 0;
        cancelPendingRetry();
        emit({ kind: "connected", attempts: 0, ...stateFacts(state) });
        return;
      case "stale":
        transientFailure("The remote session is stale.", stateFacts(state), true);
        return;
      case "unavailable":
        transientFailure(state.reason, stateFacts(state));
        return;
      case "unauthorized":
      case "incompatible":
        cancelPendingRetry();
        emit({ kind: "blocked", attempts, ...stateFacts(state) });
        return;
    }
  };

  const handleNetworkStatus = (isOnline: boolean): void => {
    if (!isOnline) {
      emitOffline();
      return;
    }
    if (started && current.kind === "offline") attempt();
  };

  const wake = (): void => {
    if (!started) return;
    if (current.kind === "connected") {
      const connection = options.bridge.connection();
      if (connection === undefined) {
        attempt();
        return;
      }
      void connection.renewIfSpent().catch((error: unknown) => {
        if (current.kind !== "connected") return;
        transientFailure(error instanceof Error ? error.message : "Remote session renewal failed.");
      });
      return;
    }
    if (
      current.kind === "waiting-to-retry" ||
      current.kind === "offline" ||
      current.kind === "stale" ||
      current.kind === "idle"
    ) {
      attempt();
    }
  };

  const start = (): void => {
    if (started) return;
    started = true;
    unsubscribeBridge = options.bridge.subscribe(handleBridgeState);
    unsubscribeNetwork = observeNetworkStatus(handleNetworkStatus);
    unsubscribeWake = observeWake(wake);
    handleBridgeState(options.bridge.getState());
    if (options.bridge.getState().kind === "idle") attempt();
  };

  return {
    status: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start,
    retryNow: () => attempt(),
    wake,
    stop: () => {
      started = false;
      cancelPendingRetry();
      unsubscribeBridge?.();
      unsubscribeNetwork?.();
      unsubscribeWake?.();
      unsubscribeBridge = undefined;
      unsubscribeNetwork = undefined;
      unsubscribeWake = undefined;
    },
  };
}
