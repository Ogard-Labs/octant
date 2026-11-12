import { availableParallelism, cpus, freemem, loadavg, totalmem } from "node:os";
import type { HostResourceBudgetSnapshot, HostResourcePolicy } from "@octant/contracts";
import {
  decideHostResourceLimits,
  type HostResourceReading,
  type HostResourceLimits,
} from "@octant/domain/host-resource-policy";

export interface HostResourceLease {
  readonly workers: number;
  readonly release: () => void;
}
interface Waiter {
  readonly signal: AbortSignal | undefined;
  readonly resolve: (lease: HostResourceLease | undefined) => void;
  readonly clean: () => void;
}

/** One admission budget per host. Only pending work owns a timer; no process scanning. */
export class HostResourceBudget {
  readonly #policy: () => HostResourcePolicy;
  readonly #read: () => HostResourceReading;
  readonly #now: () => number;
  readonly #waiting: Waiter[] = [];
  readonly #rechecks = new Set<() => void>();
  #active = 0;
  #workers = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #healthySince: number | undefined;
  #pressured = false;
  #disposed = false;
  constructor(options: {
    readonly policy: () => HostResourcePolicy;
    readonly read?: () => HostResourceReading;
    readonly now?: () => number;
  }) {
    this.#policy = options.policy;
    this.#now = options.now ?? Date.now;
    this.#read = options.read ?? createHostResourceReading(this.#now);
  }
  snapshot(): HostResourceBudgetSnapshot {
    const policy = this.#policy();
    let reading: HostResourceReading;
    try {
      reading = this.#read();
    } catch {
      reading = {
        cores: 0,
        totalMemoryBytes: 0,
        availableMemoryBytes: 0,
        cpuPercent: NaN,
        load: 0,
      };
    }
    let limits: HostResourceLimits = decideHostResourceLimits(policy, reading);
    if (limits.reason === "cpu-pressure" || limits.reason === "memory-pressure") {
      this.#pressured = true;
      this.#healthySince = undefined;
    } else if (policy.mode === "automatic" && this.#pressured && limits.reason === "unavailable") {
      this.#healthySince = undefined;
      limits = { ...limits, commands: 0, agents: 0 };
    } else if (policy.mode === "automatic" && this.#pressured && limits.reason === "ready") {
      this.#healthySince ??= this.#now();
      if (this.#now() - this.#healthySince < 5_000)
        limits = { ...limits, commands: 0, agents: 0, reason: "recovering" };
      else this.#pressured = false;
    }
    if (policy.mode !== "automatic") {
      this.#pressured = false;
      this.#healthySince = undefined;
    }
    const nonnegative = (value: number) =>
      Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
    return {
      policy,
      ...limits,
      cores: nonnegative(reading.cores),
      totalMemoryBytes: nonnegative(reading.totalMemoryBytes),
      availableMemoryBytes: nonnegative(reading.availableMemoryBytes),
      cpuPercent: Math.min(100, nonnegative(reading.cpuPercent)),
      activeCommands: this.#active,
      queuedCommands: this.#waiting.length,
    };
  }
  nativeWorkerEnvironment(): Readonly<Record<string, string>> {
    const snapshot = this.snapshot();
    // Native runtimes own their descendants. Divide the default across the configured
    // helper ceiling; these variables are cooperative runner settings, not admission.
    const workers = Math.max(1, Math.floor(snapshot.workers / snapshot.policy.maxAgents));
    return {
      VITEST_MAX_WORKERS: String(workers),
      VITEST_MAX_THREADS: String(workers),
      VITEST_MIN_THREADS: "1",
      CMAKE_BUILD_PARALLEL_LEVEL: String(workers),
    };
  }
  acquire(
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<HostResourceLease | undefined> {
    if (this.#disposed || signal?.aborted || timeoutMs <= 0) return Promise.resolve(undefined);
    // Bound queued state even if a caller produces commands faster than they finish.
    if (this.#waiting.length >= 128) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const cancel = () => {
        const index = this.#waiting.indexOf(waiter);
        if (index < 0) return;
        this.#waiting.splice(index, 1);
        waiter.clean();
        resolve(undefined);
        this.#pump();
      };
      const timeout = setTimeout(cancel, Math.min(timeoutMs, 30 * 60_000));
      const waiter: Waiter = {
        signal,
        resolve,
        clean: () => {
          clearTimeout(timeout);
          signal?.removeEventListener("abort", cancel);
        },
      };
      signal?.addEventListener("abort", cancel, { once: true });
      this.#waiting.push(waiter);
      this.#pump();
    });
  }
  recheck(callback: () => void): void {
    if (this.#disposed) return;
    this.#rechecks.add(callback);
    this.#schedule();
  }
  dispose(): void {
    this.#disposed = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#rechecks.clear();
    for (const waiter of this.#waiting.splice(0)) {
      waiter.clean();
      waiter.resolve(undefined);
    }
  }
  #pump(): void {
    if (this.#disposed) return;
    const limits = this.snapshot();
    // maxCommands bounds process groups; the worker pool also bounds their combined fan-out.
    const workerPool = limits.workers;
    while (
      this.#waiting.length > 0 &&
      this.#active < limits.commands &&
      this.#workers < workerPool
    ) {
      const waiter = this.#waiting.shift();
      if (waiter === undefined) break;
      waiter.clean();
      if (waiter.signal?.aborted) {
        waiter.resolve(undefined);
        continue;
      }
      const workers = Math.min(
        workerPool - this.#workers,
        Math.max(1, Math.floor(workerPool / limits.commands)),
      );
      this.#active++;
      this.#workers += workers;
      let released = false;
      waiter.resolve({
        workers,
        release: () => {
          if (released) return;
          released = true;
          this.#active--;
          this.#workers -= workers;
          this.#pump();
        },
      });
    }
    if (this.#waiting.length > 0 || this.#rechecks.size > 0) this.#schedule();
    else if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }
  #schedule(): void {
    if (this.#timer !== undefined || this.#disposed) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      const callbacks = [...this.#rechecks];
      this.#rechecks.clear();
      this.#pump();
      for (const callback of callbacks) callback();
    }, 2_000);
    this.#timer.unref?.();
  }
}

function createHostResourceReading(now: () => number): () => HostResourceReading {
  const times = () => {
    let idle = 0;
    let total = 0;
    for (const cpu of cpus()) {
      idle += cpu.times.idle;
      total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
    }
    return { idle, total };
  };
  let previous = times();
  let at = now();
  let cached: HostResourceReading | undefined;
  return () => {
    if (cached !== undefined && now() - at < 2_000) return cached;
    const current = times();
    const elapsed = current.total - previous.total;
    cached = {
      cores: availableParallelism(),
      totalMemoryBytes: totalmem(),
      availableMemoryBytes: freemem(),
      cpuPercent:
        elapsed > 0
          ? Math.max(0, Math.min(100, 100 * (1 - (current.idle - previous.idle) / elapsed)))
          : NaN,
      load: loadavg()[0] ?? 0,
    };
    previous = current;
    at = now();
    return cached;
  };
}
