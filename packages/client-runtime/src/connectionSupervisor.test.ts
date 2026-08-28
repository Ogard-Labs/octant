import { describe, expect, it, vi } from "vitest";
import type { RemoteConnection } from "./remoteConnection";
import type { RemoteSessionBridge, RemoteSessionBridgeState } from "./remoteSessionBridge";
import { createConnectionSupervisor } from "./connectionSupervisor";

interface ScheduledRun {
  readonly run: () => void;
  readonly delayMs: number;
  cancelled: boolean;
}

function createBridge(): {
  readonly bridge: RemoteSessionBridge;
  readonly emit: (state: RemoteSessionBridgeState) => void;
  readonly scheduledConnection: RemoteConnection;
  readonly setConnection: (connection: RemoteConnection | undefined) => void;
  readonly reconnect: ReturnType<typeof vi.fn>;
} {
  let state: RemoteSessionBridgeState = { kind: "idle" };
  let connection: RemoteConnection | undefined;
  const listeners = new Set<(next: RemoteSessionBridgeState) => void>();
  const scheduledConnection: RemoteConnection = {
    state: () => "ready",
    onStateChange: () => () => undefined,
    connect: async () => undefined,
    reconnect: async () => undefined,
    disconnect: () => undefined,
    refresh: async () => undefined,
    renewIfSpent: async () => undefined,
    session: () => undefined,
    deviceIdentity: () => undefined,
    updateFetch: () => undefined,
    authenticatedFetch: async () => new Response(),
  };
  const reconnect = vi.fn();
  const bridge = {
    getState: () => state,
    subscribe: (listener: (next: RemoteSessionBridgeState) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    connect: vi.fn(),
    resume: vi.fn(),
    forgetDeviceKey: vi.fn(async () => undefined),
    stageDeviceKeyRotation: vi.fn(async () => {
      throw new Error("not used");
    }),
    reconnect,
    disconnect: vi.fn(),
    connection: vi.fn(() => connection),
  } satisfies RemoteSessionBridge;
  return {
    bridge,
    emit(next) {
      state = next;
      for (const listener of listeners) listener(next);
    },
    scheduledConnection,
    reconnect,
    setConnection(next) {
      connection = next;
    },
  };
}

function createSchedule() {
  const runs: ScheduledRun[] = [];
  return {
    schedule: (run: () => void, delayMs: number) => {
      const entry: ScheduledRun = { run, delayMs, cancelled: false };
      runs.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    runs,
  };
}

describe("ConnectionSupervisor", () => {
  it("walks the retry ladder and repeats its final delay", () => {
    const fake = createBridge();
    fake.setConnection(fake.scheduledConnection);
    const clock = createSchedule();
    const supervisor = createConnectionSupervisor({
      bridge: fake.bridge,
      origin: "https://host.example",
      schedule: clock.schedule,
      online: () => true,
      observeNetworkStatus: () => () => undefined,
      observeWake: () => () => undefined,
    });
    supervisor.start();

    for (const delayMs of [3_000, 4_000, 8_000, 16_000, 16_000]) {
      fake.emit({
        kind: "unavailable",
        reason: "Host unavailable.",
        hostId: "host",
        displayName: "Host",
      });
      expect(supervisor.status().retryDelayMs).toBe(delayMs);
      const pending = clock.runs.at(-1);
      expect(pending?.delayMs).toBe(delayMs);
      pending?.run();
    }
  });

  it("resets the retry ladder after the host becomes ready", () => {
    const fake = createBridge();
    fake.setConnection(fake.scheduledConnection);
    const clock = createSchedule();
    const supervisor = createConnectionSupervisor({
      bridge: fake.bridge,
      origin: "https://host.example",
      schedule: clock.schedule,
      online: () => true,
      observeNetworkStatus: () => () => undefined,
      observeWake: () => () => undefined,
    });
    supervisor.start();
    fake.emit({ kind: "unavailable", reason: "Host unavailable." });
    fake.emit({ kind: "ready", hostId: "host", displayName: "Host" });
    fake.emit({ kind: "unavailable", reason: "Host unavailable." });

    expect(supervisor.status()).toMatchObject({
      kind: "waiting-to-retry",
      attempts: 1,
      retryDelayMs: 3_000,
    });
  });

  it("stops automatic retries after authorization is refused", () => {
    const fake = createBridge();
    const clock = createSchedule();
    const supervisor = createConnectionSupervisor({
      bridge: fake.bridge,
      origin: "https://host.example",
      schedule: clock.schedule,
      online: () => true,
      observeNetworkStatus: () => () => undefined,
      observeWake: () => () => undefined,
    });
    supervisor.start();
    fake.emit({ kind: "unauthorized", reason: "Pairing is refused." });

    expect(supervisor.status()).toMatchObject({ kind: "blocked", reason: "Pairing is refused." });
    expect(clock.runs).toHaveLength(0);
    supervisor.retryNow();
    expect(fake.bridge.resume).toHaveBeenCalledWith("https://host.example");
  });

  it("suspends retries offline and attempts immediately when the network returns", () => {
    const fake = createBridge();
    fake.setConnection(fake.scheduledConnection);
    const clock = createSchedule();
    let isOnline = true;
    let networkListener: ((online: boolean) => void) | undefined;
    const supervisor = createConnectionSupervisor({
      bridge: fake.bridge,
      origin: "https://host.example",
      schedule: clock.schedule,
      online: () => isOnline,
      observeNetworkStatus: (listener) => {
        networkListener = listener;
        return () => undefined;
      },
      observeWake: () => () => undefined,
    });
    supervisor.start();
    fake.emit({ kind: "unavailable", reason: "Host unavailable." });
    isOnline = false;
    networkListener?.(false);
    const reconnectCount = fake.reconnect.mock.calls.length;
    clock.runs.at(-1)?.run();
    expect(supervisor.status().kind).toBe("offline");
    expect(fake.reconnect).toHaveBeenCalledTimes(reconnectCount);
    isOnline = true;
    networkListener?.(true);
    expect(fake.reconnect).toHaveBeenCalledTimes(reconnectCount + 1);
  });

  it("renews a spent connected session when the app wakes", async () => {
    const fake = createBridge();
    const renewIfSpent = vi.fn(async () => undefined);
    fake.setConnection({ ...fake.scheduledConnection, renewIfSpent });
    const supervisor = createConnectionSupervisor({
      bridge: fake.bridge,
      origin: "https://host.example",
      online: () => true,
      observeNetworkStatus: () => () => undefined,
      observeWake: () => () => undefined,
    });
    supervisor.start();
    fake.emit({ kind: "ready", hostId: "host", displayName: "Host" });
    supervisor.wake();
    await Promise.resolve();

    expect(renewIfSpent).toHaveBeenCalledOnce();
  });

  it("resumes the paired origin when a retry has no live connection", () => {
    const fake = createBridge();
    const clock = createSchedule();
    const supervisor = createConnectionSupervisor({
      bridge: fake.bridge,
      origin: "https://host.example",
      schedule: clock.schedule,
      online: () => true,
      observeNetworkStatus: () => () => undefined,
      observeWake: () => () => undefined,
    });
    supervisor.start();
    fake.emit({ kind: "unavailable", reason: "Host unavailable." });
    clock.runs.at(-1)?.run();

    expect(fake.bridge.resume).toHaveBeenCalledWith("https://host.example");
    expect(fake.bridge.reconnect).not.toHaveBeenCalled();
  });
});
