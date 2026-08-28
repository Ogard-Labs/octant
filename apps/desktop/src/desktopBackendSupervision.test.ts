import { describe, expect, it, vi } from "vitest";
import { ServicePolicyError } from "@octant/host-runtime";
import {
  classifyDesktopBackendFailure,
  createDesktopBackendSupervisor,
} from "./desktopBackendSupervision";
import type { ManagedChildProcess } from "./serverProcess";

interface FakeChild extends ManagedChildProcess {
  readonly exit: () => void;
  readonly once: (event: "exit", listener: () => void) => unknown;
  readonly kill: (signal: NodeJS.Signals) => boolean | void;
}

function createChild(state?: {
  readonly exitCode?: number | null;
  readonly signalCode?: NodeJS.Signals | null;
}): FakeChild {
  let listener: (() => void) | undefined;
  return {
    exitCode: state?.exitCode ?? null,
    signalCode: state?.signalCode ?? null,
    kill: vi.fn(),
    once: vi.fn((_event, next) => {
      listener = next;
    }),
    off: vi.fn((_event, next) => {
      if (listener === next) listener = undefined;
    }),
    exit: () => listener?.(),
  };
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function createSchedule() {
  const runs: Array<{ readonly delayMs: number; readonly run: () => void }> = [];
  return {
    runs,
    schedule: (run: () => void, delayMs: number) => {
      let cancelled = false;
      const entry = {
        delayMs,
        run: () => {
          if (cancelled) return;
          run();
        },
      };
      runs.push(entry);
      return () => {
        cancelled = true;
      };
    },
  };
}

describe("classifyDesktopBackendFailure", () => {
  it("classifies policy errors as fatal and restartable errors as transient", () => {
    expect(classifyDesktopBackendFailure(new ServicePolicyError("invalid-policy", "invalid"))).toBe(
      "fatal",
    );
    expect(classifyDesktopBackendFailure({ code: "ECONNREFUSED" })).toBe("transient");
    expect(classifyDesktopBackendFailure(new Error("unexpected"))).toBe("transient");
  });
});

describe("createDesktopBackendSupervisor", () => {
  it("restarts the backend after an unexpected exit and backoff", async () => {
    const schedule = createSchedule();
    const first = createChild();
    const second = createChild();
    const restart = vi.fn(async () => second);
    const supervisor = createDesktopBackendSupervisor({
      restart,
      reportFatal: vi.fn(),
      schedule: schedule.schedule,
      now: () => 1_000,
    });

    supervisor.observe(first);
    expect(first.once).toHaveBeenCalledOnce();
    first.exit();
    expect(supervisor.snapshot()).toMatchObject({
      failures: 1,
      status: "waiting-to-restart",
    });
    expect(schedule.runs.at(-1)?.delayMs).toBe(1_000);

    schedule.runs.at(-1)?.run();
    await Promise.resolve();
    expect(restart).toHaveBeenCalledOnce();
    expect(supervisor.snapshot().status).toBe("supervising");
  });

  it("does not restart a backend exit released for shutdown", () => {
    const child = createChild();
    const restart = vi.fn(async () => child);
    const supervisor = createDesktopBackendSupervisor({
      restart,
      reportFatal: vi.fn(),
    });

    supervisor.observe(child);
    supervisor.release();
    child.exit();

    expect(restart).not.toHaveBeenCalled();
    expect(supervisor.snapshot().status).toBe("idle");
  });

  it("surfaces one fatal failure when repeated crashes reach the cap", async () => {
    const schedule = createSchedule();
    const reportFatal = vi.fn();
    const children = Array.from({ length: 7 }, () => createChild());
    let nextChild = 1;
    const restart = vi.fn(async () => children[nextChild++]);
    const supervisor = createDesktopBackendSupervisor({
      restart,
      reportFatal,
      schedule: schedule.schedule,
      now: () => 1_000,
    });

    supervisor.observe(children[0] as FakeChild);
    for (let index = 0; index < 6; index += 1) {
      children[index]?.exit();
      const pending = schedule.runs.at(-1);
      pending?.run();
      await Promise.resolve();
      if (supervisor.snapshot().status === "gave-up") break;
    }

    expect(supervisor.snapshot().status).toBe("gave-up");
    expect(reportFatal).toHaveBeenCalledOnce();
  });

  it("reports a fatal restart error without retrying", async () => {
    const schedule = createSchedule();
    const reportFatal = vi.fn();
    const restart = vi.fn(async () => {
      throw new ServicePolicyError("invalid-policy", "invalid");
    });
    const child = createChild();
    const supervisor = createDesktopBackendSupervisor({
      restart,
      reportFatal,
      schedule: schedule.schedule,
    });

    supervisor.observe(child);
    child.exit();
    schedule.runs.at(-1)?.run();
    await Promise.resolve();

    expect(supervisor.snapshot().status).toBe("gave-up");
    expect(reportFatal).toHaveBeenCalledOnce();
    expect(schedule.runs).toHaveLength(2);
  });

  it("resets failures after the replacement backend stays healthy", async () => {
    const schedule = createSchedule();
    const first = createChild();
    const second = createChild();
    const supervisor = createDesktopBackendSupervisor({
      restart: async () => second,
      reportFatal: vi.fn(),
      schedule: schedule.schedule,
      now: () => 1_000,
    });

    supervisor.observe(first);
    first.exit();
    expect(supervisor.snapshot().failures).toBe(1);
    schedule.runs.at(-1)?.run();
    await Promise.resolve();
    expect(supervisor.snapshot()).toMatchObject({
      failures: 1,
      status: "supervising",
    });

    const healthyTimer = schedule.runs.at(-1);
    expect(healthyTimer?.delayMs).toBe(60_000);
    healthyTimer?.run();
    expect(supervisor.snapshot().failures).toBe(0);
  });

  it("keeps crash retries after a restart port that fails transiently", async () => {
    const schedule = createSchedule();
    const first = createChild();
    const second = createChild();
    let attempts = 0;
    const restart = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
      }
      return second;
    });
    const supervisor = createDesktopBackendSupervisor({
      restart,
      reportFatal: vi.fn(),
      schedule: schedule.schedule,
      now: () => 1_000,
    });

    supervisor.observe(first);
    first.exit();
    schedule.runs.at(-1)?.run();
    await Promise.resolve();
    expect(restart).toHaveBeenCalledOnce();
    expect(supervisor.snapshot().status).toBe("waiting-to-restart");

    schedule.runs.at(-1)?.run();
    await Promise.resolve();
    expect(restart).toHaveBeenCalledTimes(2);
    expect(supervisor.snapshot().status).toBe("supervising");
  });

  it("does not observe a resolved restart after release", async () => {
    const schedule = createSchedule();
    const first = createChild();
    const second = createChild();
    const pending = createDeferred<FakeChild | undefined>();
    const restart = vi.fn(() => pending.promise);
    const supervisor = createDesktopBackendSupervisor({
      restart,
      reportFatal: vi.fn(),
      schedule: schedule.schedule,
      now: () => 1_000,
    });

    supervisor.observe(first);
    first.exit();
    schedule.runs.at(-1)?.run();
    expect(supervisor.snapshot().status).toBe("restarting");

    supervisor.release();
    pending.resolve(second);
    await Promise.resolve();

    expect(second.kill).toHaveBeenCalledWith("SIGTERM");
    expect(second.once).not.toHaveBeenCalled();
    expect(restart).toHaveBeenCalledOnce();
    expect(supervisor.snapshot().status).toBe("idle");
  });

  it("does not retry a rejected restart after release", async () => {
    const schedule = createSchedule();
    const first = createChild();
    const pending = createDeferred<FakeChild | undefined>();
    const restart = vi.fn(() => pending.promise);
    const supervisor = createDesktopBackendSupervisor({
      restart,
      reportFatal: vi.fn(),
      schedule: schedule.schedule,
      now: () => 1_000,
    });

    supervisor.observe(first);
    first.exit();
    schedule.runs.at(-1)?.run();
    expect(supervisor.snapshot().status).toBe("restarting");

    supervisor.release();
    pending.reject(Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }));
    await Promise.resolve();

    expect(restart).toHaveBeenCalledOnce();
    expect(supervisor.snapshot().status).toBe("idle");
  });

  it("restarts a child that already exited before observation", () => {
    const schedule = createSchedule();
    const child = createChild({ exitCode: 1 });
    const supervisor = createDesktopBackendSupervisor({
      restart: vi.fn(async () => createChild()),
      reportFatal: vi.fn(),
      schedule: schedule.schedule,
      now: () => 1_000,
    });

    supervisor.observe(child);
    expect(child.once).not.toHaveBeenCalled();
    expect(supervisor.snapshot()).toMatchObject({
      failures: 1,
      status: "waiting-to-restart",
    });
  });

  it("restarts a child that already received a signal before observation", () => {
    const schedule = createSchedule();
    const child = createChild({ signalCode: "SIGTERM" });
    const supervisor = createDesktopBackendSupervisor({
      restart: vi.fn(async () => createChild()),
      reportFatal: vi.fn(),
      schedule: schedule.schedule,
      now: () => 1_000,
    });

    supervisor.observe(child);
    expect(child.once).not.toHaveBeenCalled();
    expect(supervisor.snapshot()).toMatchObject({
      failures: 1,
      status: "waiting-to-restart",
    });
  });
});
