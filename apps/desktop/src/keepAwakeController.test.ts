import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeDesktopAgentWorkSnapshot,
  type DesktopAgentWorkSnapshot,
  type KeepAwakePolicy,
} from "@octant/contracts";
import {
  DESKTOP_AGENT_WORK_ROUTE,
  formatKeepAwakeSummary,
  KEEP_AWAKE_POLL_INTERVAL_MS,
  KEEP_AWAKE_RELEASE_DELAY_MS,
  KEEP_AWAKE_ROUTINE_LEAD_MS,
  KeepAwakeController,
  readDesktopAgentWork,
  type KeepAwakePowerMonitor,
  type KeepAwakePowerSaveBlocker,
} from "./keepAwakeController";
import { decodeKeepAwakeStatus, type KeepAwakeStatus } from "./keepAwakeStatus";

const BASE_NOW_MS = Date.parse("2026-11-19T20:00:00.000Z");

function makeSnapshot(
  overrides: {
    readonly keepAwake?: KeepAwakePolicy;
    readonly chat?: number;
    readonly work?: number;
    readonly code?: number;
    readonly childRuns?: number;
    readonly coordinatorWorkers?: number;
    readonly nextRoutineDueAt?: string | null;
    readonly observedAtMs?: number;
  } = {},
): DesktopAgentWorkSnapshot {
  return decodeDesktopAgentWorkSnapshot({
    keepAwake: overrides.keepAwake ?? "on-power",
    turns: {
      chat: overrides.chat ?? 0,
      work: overrides.work ?? 0,
      code: overrides.code ?? 0,
    },
    childRuns: overrides.childRuns ?? 0,
    coordinatorWorkers: overrides.coordinatorWorkers ?? 0,
    nextRoutineDueAt: overrides.nextRoutineDueAt ?? null,
    observedAt: new Date(overrides.observedAtMs ?? BASE_NOW_MS).toISOString(),
  });
}

function createFakePower(
  options: {
    readonly onBattery?: boolean;
    readonly unreadableBattery?: boolean;
    readonly refuseStart?: boolean;
    readonly throwOnStart?: boolean;
  } = {},
) {
  let nextId = 1;
  const activeIds = new Set<number>();
  const startedTypes: Array<string> = [];
  const stoppedIds: Array<number> = [];
  let refuseStart = options.refuseStart ?? false;
  let throwOnStart = options.throwOnStart ?? false;

  const powerSaveBlocker: KeepAwakePowerSaveBlocker = {
    start: vi.fn((type: "prevent-app-suspension") => {
      startedTypes.push(type);
      if (throwOnStart) throw new Error("platform refused assertion");
      const id = nextId;
      nextId += 1;
      if (!refuseStart) activeIds.add(id);
      return id;
    }),
    stop: vi.fn((id: number) => {
      stoppedIds.push(id);
      activeIds.delete(id);
    }),
    isStarted: vi.fn((id: number) => activeIds.has(id)),
  };

  let battery = options.onBattery ?? false;
  const listeners = new Map<"on-ac" | "on-battery", Set<() => void>>([
    ["on-ac", new Set()],
    ["on-battery", new Set()],
  ]);

  const powerMonitor: KeepAwakePowerMonitor = {
    isOnBatteryPower: () => {
      if (options.unreadableBattery === true) throw new Error("battery unreadable");
      return battery;
    },
    on: (event, listener) => {
      listeners.get(event)?.add(listener);
    },
    removeListener: (event, listener) => {
      listeners.get(event)?.delete(listener);
    },
  };

  const emitPower = (event: "on-ac" | "on-battery") => {
    battery = event === "on-battery";
    for (const listener of listeners.get(event) ?? []) listener();
  };

  return {
    powerSaveBlocker,
    powerMonitor,
    activeIds,
    startedTypes,
    stoppedIds,
    listeners,
    emitPower,
    setRefuseStart: (value: boolean) => {
      refuseStart = value;
    },
    setThrowOnStart: (value: boolean) => {
      throwOnStart = value;
    },
  };
}

describe("KeepAwakeController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_NOW_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("takes a prevent-app-suspension assertion on first running work and releases it 10 s after the last work ends without dropping early when new work arrives", async () => {
    const power = createFakePower();
    let currentWork: DesktopAgentWorkSnapshot = makeSnapshot();
    const statuses: KeepAwakeStatus[] = [];

    const controller = new KeepAwakeController({
      powerSaveBlocker: power.powerSaveBlocker,
      powerMonitor: power.powerMonitor,
      readWork: async () => currentWork,
      onStatusChanged: (status) => statuses.push(status),
    });

    controller.start();
    await Promise.resolve();
    expect(power.activeIds.size).toBe(0);
    expect(controller.status()).toEqual({ state: "idle", reason: "no-work" });

    // First running work takes a prevent-app-suspension assertion immediately on poll.
    currentWork = makeSnapshot({ chat: 1, code: 1 });
    await vi.advanceTimersByTimeAsync(KEEP_AWAKE_POLL_INTERVAL_MS);
    expect(power.startedTypes).toEqual(["prevent-app-suspension"]);
    expect(power.activeIds.size).toBe(1);
    expect(controller.status()).toEqual({
      state: "active",
      summary: "Kept awake: 2 turns running",
    });

    // Work ends: assertion stays held for 10 s.
    currentWork = makeSnapshot();
    await vi.advanceTimersByTimeAsync(KEEP_AWAKE_POLL_INTERVAL_MS);
    expect(power.activeIds.size).toBe(1);
    expect(power.stoppedIds).toEqual([]);

    // New work arrives within 10 s (at +5 s): assertion is never dropped or re-taken.
    currentWork = makeSnapshot({ work: 1, childRuns: 1 });
    await vi.advanceTimersByTimeAsync(KEEP_AWAKE_POLL_INTERVAL_MS);
    expect(power.startedTypes).toHaveLength(1);
    expect(power.stoppedIds).toEqual([]);
    expect(controller.status()).toEqual({
      state: "active",
      summary: "Kept awake: 1 turn, 1 child run",
    });

    // Work ends again and stays idle for 10 s: assertion releases after 10 s.
    currentWork = makeSnapshot();
    await vi.advanceTimersByTimeAsync(KEEP_AWAKE_POLL_INTERVAL_MS);
    expect(power.activeIds.size).toBe(1);

    await vi.advanceTimersByTimeAsync(KEEP_AWAKE_RELEASE_DELAY_MS - 1);
    expect(power.activeIds.size).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(power.activeIds.size).toBe(0);
    expect(power.stoppedIds).toEqual([1]);
    expect(controller.status()).toEqual({ state: "idle", reason: "no-work" });
    expect(statuses.at(-1)).toEqual({ state: "idle", reason: "no-work" });

    controller.dispose();
  });

  it("takes the assertion when a routine is due within 5 minutes and does not when it is further away", async () => {
    const power = createFakePower();
    let currentWork: DesktopAgentWorkSnapshot = makeSnapshot({
      nextRoutineDueAt: new Date(BASE_NOW_MS + KEEP_AWAKE_ROUTINE_LEAD_MS + 60_000).toISOString(),
    });

    const controller = new KeepAwakeController({
      powerSaveBlocker: power.powerSaveBlocker,
      powerMonitor: power.powerMonitor,
      readWork: async () => currentWork,
    });

    controller.start();
    await Promise.resolve();
    expect(power.activeIds.size).toBe(0);
    expect(controller.status()).toEqual({ state: "idle", reason: "no-work" });

    // Once within 5 minutes of the due time, the assertion is taken.
    currentWork = makeSnapshot({
      nextRoutineDueAt: new Date(Date.now() + KEEP_AWAKE_ROUTINE_LEAD_MS).toISOString(),
    });
    await controller.pollNow();
    expect(power.activeIds.size).toBe(1);
    expect(controller.status()).toEqual({
      state: "active",
      summary: "Kept awake: routine due soon",
    });

    controller.dispose();
  });

  it("releases the assertion immediately on quit/shutdown and ignores late poll responses", async () => {
    const power = createFakePower();
    let resolveLatePoll: ((snapshot: DesktopAgentWorkSnapshot) => void) | undefined;
    let firstPoll = true;

    const controller = new KeepAwakeController({
      powerSaveBlocker: power.powerSaveBlocker,
      powerMonitor: power.powerMonitor,
      readWork: () => {
        if (firstPoll) {
          firstPoll = false;
          return Promise.resolve(makeSnapshot({ coordinatorWorkers: 2 }));
        }
        return new Promise((resolve) => {
          resolveLatePoll = resolve;
        });
      },
    });

    controller.start();
    await Promise.resolve();
    expect(power.activeIds.size).toBe(1);
    expect(controller.status()).toEqual({
      state: "active",
      summary: "Kept awake: 2 workers",
    });

    // Kick off an in-flight poll, then dispose (quit) before it resolves.
    const late = controller.pollNow();
    controller.dispose();
    expect(power.activeIds.size).toBe(0);
    expect(power.stoppedIds).toEqual([1]);
    expect(power.listeners.get("on-ac")?.size).toBe(0);
    expect(power.listeners.get("on-battery")?.size).toBe(0);

    resolveLatePoll?.(makeSnapshot({ code: 3 }));
    await late;
    expect(power.activeIds.size).toBe(0);
    expect(power.startedTypes).toHaveLength(1);
  });

  it("releases immediately on battery and re-takes on power under while-on-power, and treats unreadable battery state as on power", async () => {
    const power = createFakePower({ onBattery: false });
    let currentWork: DesktopAgentWorkSnapshot = makeSnapshot({
      keepAwake: "on-power",
      code: 1,
    });

    const controller = new KeepAwakeController({
      powerSaveBlocker: power.powerSaveBlocker,
      powerMonitor: power.powerMonitor,
      readWork: async () => currentWork,
    });

    controller.start();
    await Promise.resolve();
    expect(power.activeIds.size).toBe(1);

    // Unplugging releases immediately without waiting 10 s.
    power.emitPower("on-battery");
    expect(power.activeIds.size).toBe(0);
    expect(controller.status()).toEqual({ state: "idle", reason: "on-battery" });

    // Plugging back in re-takes immediately while work is still running.
    power.emitPower("on-ac");
    expect(power.activeIds.size).toBe(1);
    expect(controller.status()).toEqual({
      state: "active",
      summary: "Kept awake: 1 turn running",
    });

    // Switching to "always" keeps the assertion on battery.
    currentWork = makeSnapshot({ keepAwake: "always", code: 1 });
    await controller.pollNow();
    power.emitPower("on-battery");
    expect(power.activeIds.size).toBe(1);

    controller.dispose();

    // Unreadable battery state counts as on power.
    const unreadablePower = createFakePower({ unreadableBattery: true });
    const unreadableController = new KeepAwakeController({
      powerSaveBlocker: unreadablePower.powerSaveBlocker,
      powerMonitor: unreadablePower.powerMonitor,
      readWork: async () => makeSnapshot({ keepAwake: "on-power", chat: 1 }),
    });
    unreadableController.start();
    await Promise.resolve();
    expect(unreadablePower.activeIds.size).toBe(1);
    unreadableController.dispose();
  });

  it("holds nothing when policy is never and releases immediately if switched to never", async () => {
    const power = createFakePower();
    let currentWork: DesktopAgentWorkSnapshot = makeSnapshot({
      keepAwake: "never",
      chat: 2,
      childRuns: 1,
    });

    const controller = new KeepAwakeController({
      powerSaveBlocker: power.powerSaveBlocker,
      powerMonitor: power.powerMonitor,
      readWork: async () => currentWork,
    });

    controller.start();
    await Promise.resolve();
    expect(power.startedTypes).toEqual([]);
    expect(power.activeIds.size).toBe(0);
    expect(controller.status()).toEqual({ state: "idle", reason: "disabled" });

    currentWork = makeSnapshot({ keepAwake: "always", chat: 1 });
    await controller.pollNow();
    expect(power.activeIds.size).toBe(1);

    currentWork = makeSnapshot({ keepAwake: "never", chat: 1 });
    await controller.pollNow();
    expect(power.activeIds.size).toBe(0);
    expect(controller.status()).toEqual({ state: "idle", reason: "disabled" });

    controller.dispose();
  });

  it("reports unavailable when the platform refuses the assertion and does not retry until work next starts", async () => {
    const power = createFakePower({ refuseStart: true });
    let currentWork: DesktopAgentWorkSnapshot = makeSnapshot({ code: 1 });

    const controller = new KeepAwakeController({
      powerSaveBlocker: power.powerSaveBlocker,
      powerMonitor: power.powerMonitor,
      readWork: async () => currentWork,
    });

    controller.start();
    await Promise.resolve();
    expect(power.startedTypes).toHaveLength(1);
    expect(power.activeIds.size).toBe(0);
    expect(controller.status()).toEqual({ state: "unavailable" });

    // Subsequent polls while the same work continues must not retry start().
    await vi.advanceTimersByTimeAsync(KEEP_AWAKE_POLL_INTERVAL_MS * 3);
    expect(power.startedTypes).toHaveLength(1);
    expect(controller.status()).toEqual({ state: "unavailable" });

    // Work ends -> idle, still no retry.
    currentWork = makeSnapshot();
    await controller.pollNow();
    expect(power.startedTypes).toHaveLength(1);
    expect(controller.status()).toEqual({ state: "idle", reason: "no-work" });

    // When new work next starts, desktop retries and succeeds once platform permits it.
    power.setRefuseStart(false);
    currentWork = makeSnapshot({ work: 1 });
    await controller.pollNow();
    expect(power.startedTypes).toHaveLength(2);
    expect(power.activeIds.size).toBe(1);
    expect(controller.status()).toEqual({
      state: "active",
      summary: "Kept awake: 1 turn running",
    });

    controller.dispose();
  });

  it("reports unavailable when powerSaveBlocker.start throws", async () => {
    const power = createFakePower({ throwOnStart: true });
    const controller = new KeepAwakeController({
      powerSaveBlocker: power.powerSaveBlocker,
      powerMonitor: power.powerMonitor,
      readWork: async () => makeSnapshot({ chat: 1 }),
    });

    controller.start();
    await Promise.resolve();
    expect(controller.status()).toEqual({ state: "unavailable" });
    controller.dispose();
  });

  it("builds status summaries strictly from counts and never thread titles", () => {
    expect(
      formatKeepAwakeSummary({
        totalTurns: 2,
        childRuns: 0,
        coordinatorWorkers: 0,
        routineDueSoon: false,
      }),
    ).toBe("Kept awake: 2 turns running");
    expect(
      formatKeepAwakeSummary({
        totalTurns: 1,
        childRuns: 1,
        coordinatorWorkers: 0,
        routineDueSoon: false,
      }),
    ).toBe("Kept awake: 1 turn, 1 child run");
    expect(
      formatKeepAwakeSummary({
        totalTurns: 0,
        childRuns: 0,
        coordinatorWorkers: 0,
        routineDueSoon: true,
      }),
    ).toBe("Kept awake: routine due soon");
    expect(
      formatKeepAwakeSummary({
        totalTurns: 1,
        childRuns: 2,
        coordinatorWorkers: 1,
        routineDueSoon: true,
      }),
    ).toBe("Kept awake: 1 turn, 2 child runs, 1 worker, routine due soon");
  });

  it("reads /api/desktop/agent-work with the desktop broker secret and decodes bridge status payloads", async () => {
    const fetchMock: typeof globalThis.fetch = Object.assign(
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        expect(String(input)).toBe(`http://127.0.0.1:4567${DESKTOP_AGENT_WORK_ROUTE}`);
        expect(init?.method).toBe("GET");
        expect(init?.headers).toEqual({ "x-octant-desktop-secret": "bridge-secret" });
        return Response.json(makeSnapshot({ chat: 1, childRuns: 2 }));
      }),
      { preconnect: vi.fn() },
    );

    const snapshot = await readDesktopAgentWork({
      hostUrl: "http://127.0.0.1:4567",
      brokerHeaders: { "x-octant-desktop-secret": "bridge-secret" },
      fetch: fetchMock,
    });
    expect(snapshot).toMatchObject({
      turns: { chat: 1, work: 0, code: 0 },
      childRuns: 2,
    });

    expect(decodeKeepAwakeStatus({ state: "unavailable" })).toEqual({ state: "unavailable" });
    expect(decodeKeepAwakeStatus({ state: "idle", reason: "on-battery" })).toEqual({
      state: "idle",
      reason: "on-battery",
    });
    expect(
      decodeKeepAwakeStatus({ state: "active", summary: "Kept awake: 2 turns running" }),
    ).toEqual({ state: "active", summary: "Kept awake: 2 turns running" });
    expect(() => decodeKeepAwakeStatus({ state: "active", summary: "" })).toThrow();
    expect(() => decodeKeepAwakeStatus({ state: "idle", reason: "unknown" })).toThrow();
  });
});
