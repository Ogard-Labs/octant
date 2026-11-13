import { afterEach, describe, expect, it, vi } from "vitest";
import { HostResourceBudget } from "./hostResourceBudget";
import { DEFAULT_HOST_RESOURCE_POLICY } from "@octant/contracts";
const idle = {
  cores: 8,
  totalMemoryBytes: 16 * 2 ** 30,
  availableMemoryBytes: 12 * 2 ** 30,
  cpuPercent: 10,
  load: 0.5,
};
afterEach(() => vi.useRealTimers());
describe("shared host resource budget", () => {
  it("does not treat a failed reading as recovery from known pressure", () => {
    let reading = { ...idle, cpuPercent: 99 };
    const budget = new HostResourceBudget({
      policy: () => DEFAULT_HOST_RESOURCE_POLICY,
      read: () => reading,
    });
    expect(budget.snapshot().commands).toBe(0);
    reading = { ...idle, cpuPercent: NaN };
    expect(budget.snapshot()).toMatchObject({ reason: "unavailable", commands: 0, agents: 0 });
    budget.dispose();
  });

  it("allows concurrent commands without multiplying the total worker allocation", async () => {
    const budget = new HostResourceBudget({
      policy: () => ({ ...DEFAULT_HOST_RESOURCE_POLICY, mode: "manual", maxWorkers: 2 }),
      read: () => idle,
    });
    const one = await budget.acquire(undefined, 1000);
    const two = await budget.acquire(undefined, 1000);
    expect([one?.workers, two?.workers]).toEqual([1, 1]);
    const pending = budget.acquire(undefined, 1000);
    expect(budget.snapshot()).toMatchObject({ activeCommands: 2, queuedCommands: 1 });
    one?.release();
    const three = await pending;
    expect(three?.workers).toBe(1);
    two?.release();
    three?.release();
    budget.dispose();
  });

  it("shares worker capacity across launches and cancels a waiting command without starting it", async () => {
    const budget = new HostResourceBudget({
      policy: () => ({ ...DEFAULT_HOST_RESOURCE_POLICY, maxCommands: 1 }),
      read: () => idle,
    });
    const first = await budget.acquire(undefined, 10_000);
    expect(first?.workers).toBe(4);
    const controller = new AbortController();
    const waiting = budget.acquire(controller.signal, 10_000);
    expect(budget.snapshot().queuedCommands).toBe(1);
    controller.abort();
    expect(await waiting).toBeUndefined();
    first?.release();
    expect(budget.snapshot()).toMatchObject({ activeCommands: 0, queuedCommands: 0 });
    budget.dispose();
  });
  it("resumes after sustained recovery without needing a running command to finish", async () => {
    vi.useFakeTimers();
    let reading = { ...idle, cpuPercent: 99 };
    const budget = new HostResourceBudget({
      policy: () => ({ ...DEFAULT_HOST_RESOURCE_POLICY, maxCommands: 1 }),
      read: () => reading,
    });
    const pending = budget.acquire(undefined, 30_000);
    expect(budget.snapshot().reason).toBe("cpu-pressure");
    reading = idle;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(budget.snapshot().reason).toBe("recovering");
    await vi.advanceTimersByTimeAsync(6_000);
    const lease = await pending;
    expect(lease?.workers).toBe(4);
    lease?.release();
    budget.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds queue lifetime and disposes pending requests", async () => {
    vi.useFakeTimers();
    const budget = new HostResourceBudget({
      policy: () => ({ ...DEFAULT_HOST_RESOURCE_POLICY, mode: "paused" }),
      read: () => idle,
    });
    const pending = budget.acquire(undefined, 100);
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toBeUndefined();
    const another = budget.acquire(undefined, 1000);
    budget.dispose();
    expect(await another).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});
