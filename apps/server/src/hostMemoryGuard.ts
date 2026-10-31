import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HostMemoryStatus } from "@octant/contracts/host-control";
import {
  classifyHostMemory,
  shouldRelieveHostMemory,
  type HostMemoryPressure,
  type SystemMemorySignal,
} from "@octant/domain";

const STATE_SCHEMA_VERSION = 1;
const CALM_INTERVAL_MS = 15_000;
/** Pressure is sampled faster, so a crash leaves a recent reading behind. */
const PRESSURED_INTERVAL_MS = 5_000;
const MEGABYTE = 1024 ** 2;

interface RepeatingTimer {
  unref(): unknown;
  clear(): void;
}

export interface HostMemoryReliefPort {
  /** Stops provider runtimes and parked sessions nobody is using. */
  readonly releaseIdle: () => Promise<{
    readonly idleRuntimesStopped: number;
    readonly idleSessionsReleased: number;
  }>;
  /** Drops memory the host can rebuild; true when it ran. */
  readonly trimCaches: () => boolean | Promise<boolean>;
  /** Running turns. Relief never stops one; the count is only reported. */
  readonly activeTurns: () => number;
}

export interface HostMemoryGuardOptions {
  /** Absolute path of the private file that survives a crash. */
  readonly stateFile: string;
  readonly readSystem: () => Promise<{
    readonly signal: SystemMemorySignal;
    readonly totalBytes: number;
  }>;
  readonly readProcessRssBytes: () => number;
  readonly relief: HostMemoryReliefPort;
  /** Epoch milliseconds. */
  readonly clock?: () => number;
  readonly log?: (line: string) => void;
  readonly setTimer?: (tick: () => void, delayMs: number) => RepeatingTimer;
}

type LastRelief = NonNullable<HostMemoryStatus["lastRelief"]>;

/**
 * Watches the host process and the system's memory pressure, and eases the
 * host before the system has to kill it. Relief stops only what is waiting
 * (idle provider runtimes and parked sessions) and trims caches the host
 * rebuilds on demand; a running turn is never stopped. Everything stays on
 * this machine: readings are logged locally and the one file it keeps holds a
 * pressure level, a size, and a time.
 *
 * The state file also answers a question after a crash: it is marked clean
 * only by `stop`, so a file found unmarked at the next start means the last
 * process ended without one, and its final reading is shown to the person.
 */
export class HostMemoryGuard {
  readonly #options: HostMemoryGuardOptions;
  readonly #clock: () => number;
  readonly #log: (line: string) => void;
  readonly #startTimer: (tick: () => void, delayMs: number) => RepeatingTimer;
  #pressure: HostMemoryPressure = "normal";
  #processMegabytes = 0;
  #lastRelief: LastRelief | undefined;
  #lastReliefAt: { readonly at: number; readonly pressure: HostMemoryPressure } | undefined;
  #previousStop: HostMemoryStatus["previousStop"];
  #timer: RepeatingTimer | undefined;
  #running: Promise<void> | undefined;
  #stopped = false;

  constructor(options: HostMemoryGuardOptions) {
    this.#options = options;
    this.#clock = options.clock ?? Date.now;
    this.#log = options.log ?? ((line) => console.warn(line));
    this.#startTimer =
      options.setTimer ??
      ((tick, delayMs) => {
        const handle = setTimeout(tick, delayMs);
        return { unref: () => handle.unref(), clear: () => clearTimeout(handle) };
      });
  }

  async start(): Promise<void> {
    this.#previousStop = await this.#readPreviousStop();
    if (this.#previousStop !== undefined) {
      this.#log(
        `[memory-guard] the previous host stopped without a clean exit; last seen ${this.#previousStop.lastSeenAt} at ${this.#previousStop.pressure} pressure using ${this.#previousStop.processMegabytes} MB`,
      );
    }
    // A failed first reading must not hold the host back from serving.
    await this.sample().catch(() => this.#log("[memory-guard] the first memory reading failed"));
    this.#schedule();
  }

  /** Marks this run as ended cleanly. Called from the host's shutdown. */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#timer?.clear();
    await this.#running;
    await this.#persist(true);
  }

  report(): HostMemoryStatus {
    return {
      pressure: this.#pressure,
      processMegabytes: this.#processMegabytes,
      ...(this.#lastRelief === undefined ? {} : { lastRelief: this.#lastRelief }),
      ...(this.#previousStop === undefined ? {} : { previousStop: this.#previousStop }),
    };
  }

  /** One reading and, when pressure calls for it, one relief. */
  async sample(): Promise<void> {
    if (this.#running !== undefined) return this.#running;
    this.#running = this.#sample().finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  async #sample(): Promise<void> {
    const system = await this.#options.readSystem();
    const rssBytes = this.#options.readProcessRssBytes();
    const { pressure, source } = classifyHostMemory({
      system: system.signal,
      processRssBytes: rssBytes,
      totalBytes: system.totalBytes,
    });
    const processMegabytes = Math.round(rssBytes / MEGABYTE);
    if (pressure !== this.#pressure) {
      this.#log(
        `[memory-guard] memory pressure went from ${this.#pressure} to ${pressure} (${source}); host using ${processMegabytes} MB`,
      );
    }
    this.#pressure = pressure;
    this.#processMegabytes = processMegabytes;
    const now = this.#clock();
    if (
      pressure !== "normal" &&
      source !== "none" &&
      shouldRelieveHostMemory({ pressure, now, lastRelief: this.#lastReliefAt })
    ) {
      this.#lastReliefAt = { at: now, pressure };
      await this.#relieve(pressure, source, now);
    }
    if (!this.#stopped) await this.#persist(false);
  }

  async #relieve(
    pressure: Exclude<HostMemoryPressure, "normal">,
    source: "system" | "process" | "both",
    now: number,
  ): Promise<void> {
    let idleProviderRuntimesStopped = 0;
    let idleSessionsReleased = 0;
    try {
      const released = await this.#options.relief.releaseIdle();
      idleProviderRuntimesStopped = released.idleRuntimesStopped;
      idleSessionsReleased = released.idleSessionsReleased;
    } catch {
      this.#log("[memory-guard] could not stop idle provider work");
    }
    let cachesTrimmed = false;
    try {
      cachesTrimmed = await this.#options.relief.trimCaches();
    } catch {
      this.#log("[memory-guard] could not trim caches");
    }
    const activeTurnsKept = this.#options.relief.activeTurns();
    this.#lastRelief = {
      at: new Date(now).toISOString(),
      pressure,
      source,
      idleProviderRuntimesStopped,
      idleSessionsReleased,
      cachesTrimmed,
      activeTurnsKept,
    };
    this.#log(
      `[memory-guard] relieved ${pressure} pressure: stopped ${idleProviderRuntimesStopped} idle provider runtimes, released ${idleSessionsReleased} parked sessions, ${cachesTrimmed ? "trimmed" : "did not trim"} caches, ${activeTurnsKept} turns kept running`,
    );
  }

  #schedule(): void {
    if (this.#stopped) return;
    const delay = this.#pressure === "normal" ? CALM_INTERVAL_MS : PRESSURED_INTERVAL_MS;
    this.#timer = this.#startTimer(() => {
      void this.sample()
        .catch(() => this.#log("[memory-guard] a memory reading failed"))
        .finally(() => this.#schedule());
    }, delay);
    this.#timer.unref();
  }

  async #readPreviousStop(): Promise<HostMemoryStatus["previousStop"]> {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(this.#options.stateFile, "utf8"));
    } catch {
      return undefined;
    }
    if (typeof value !== "object" || value === null) return undefined;
    const record = value as Record<string, unknown>;
    const { cleanExit, lastSeenAt, pressure, processMegabytes } = record;
    if (
      record.schemaVersion !== STATE_SCHEMA_VERSION ||
      cleanExit !== false ||
      typeof lastSeenAt !== "string" ||
      Number.isNaN(Date.parse(lastSeenAt)) ||
      (pressure !== "normal" && pressure !== "elevated" && pressure !== "critical") ||
      typeof processMegabytes !== "number" ||
      !Number.isSafeInteger(processMegabytes) ||
      processMegabytes < 0
    ) {
      return undefined;
    }
    return { lastSeenAt, pressure, processMegabytes };
  }

  async #persist(cleanExit: boolean): Promise<void> {
    const file = this.#options.stateFile;
    const temporary = join(dirname(file), `.host-memory-${randomUUID()}.tmp`);
    try {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(
        temporary,
        JSON.stringify({
          schemaVersion: STATE_SCHEMA_VERSION,
          cleanExit,
          lastSeenAt: new Date(this.#clock()).toISOString(),
          pressure: this.#pressure,
          processMegabytes: this.#processMegabytes,
        }),
        { encoding: "utf8", mode: 0o600 },
      );
      await chmod(temporary, 0o600);
      await rename(temporary, file);
    } catch {
      // A reading that cannot be saved costs only the next-start notice.
      this.#log("[memory-guard] the memory state could not be saved");
    }
  }
}
