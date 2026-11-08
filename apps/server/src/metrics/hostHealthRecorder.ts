import {
  decodeHostHealthSample,
  HOST_HEALTH_RETENTION_DAYS,
  HOST_HEALTH_SAMPLE_INTERVAL_MS,
  type HostHealthHistory,
  type HostHealthHistoryRequest,
  type HostHealthSample,
  type UtcTimestamp,
} from "@octant/contracts";
import { hostHealthPoints } from "@octant/domain";
import { takeEventLoopLagWindow } from "../eventLoopLag";
import type { LatencyWindow } from "../latencyStatsProjection";
import { slowStatementTally, type SlowStatementCounters } from "../persistence/slowStatementLog";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";

const RETENTION_MS = HOST_HEALTH_RETENTION_DAYS * 86_400_000;
/** Pruning is cheap but not free, so it runs once an hour rather than every sample. */
const PRUNE_EVERY_SAMPLES = 60;

interface RepeatingTimer {
  unref(): unknown;
}

export interface HostHealthRecorderOptions {
  /** The side file the samples live in, beside the journal and never inside it. */
  readonly path: string;
  /** Reads the journal database's size; absent leaves the figure out. */
  readonly databaseBytes?: () => number | undefined;
  readonly latencyWindow: () => ReadonlyArray<LatencyWindow>;
  /**
   * Slow statements since the previous sample. Defaults to the process-wide
   * tally; a test passes its own, because the recorder's own writes can be slow
   * on a loaded runner and would land in the shared tally.
   */
  readonly slowStatementWindow?: () => SlowStatementCounters;
  readonly clock?: () => string;
  readonly memory?: () => { readonly rss: number; readonly heapUsed: number };
  readonly intervalMs?: number;
  readonly setTimer?: (tick: () => void, intervalMs: number) => RepeatingTimer;
}

/**
 * Keeps one host-health sample a minute for two weeks, so a stall, a memory
 * climb, or a slow database outlives the restart that usually follows it. The
 * samples are host diagnostics, not product state: they live in their own
 * SQLite file rather than the journal, hold numbers only (no route, SQL,
 * thread, or Project), and deleting the file loses nothing a person made.
 * Recording never throws into the host; a sample that cannot be written is
 * dropped.
 */
export class HostHealthRecorder {
  readonly #options: HostHealthRecorderOptions;
  readonly #clock: () => string;
  readonly #processStartedAt: string;
  #connection: SqliteConnection | undefined;
  #lastSampleMs: number;
  // Starts due, so a host that never runs an hour still prunes on its first sample.
  #samplesSincePrune = PRUNE_EVERY_SAMPLES;
  // Set by stop; a sample or read after it neither writes nor reopens the file.
  #closed = false;

  constructor(options: HostHealthRecorderOptions) {
    this.#options = options;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#processStartedAt = this.#clock();
    this.#lastSampleMs = Date.parse(this.#processStartedAt);
  }

  /** Starts sampling; the returned function stops it and closes the file. */
  start(): () => void {
    const intervalMs = this.#options.intervalMs ?? HOST_HEALTH_SAMPLE_INTERVAL_MS;
    const startTimer = this.#options.setTimer ?? ((tick, ms) => setInterval(tick, ms));
    const timer = startTimer(() => this.sample(), intervalMs);
    timer.unref();
    return () => {
      clearInterval(timer as ReturnType<typeof setInterval>);
      this.#closed = true;
      this.#connection?.close();
      this.#connection = undefined;
    };
  }

  /** Takes and stores one sample of the window since the previous one. */
  sample(): HostHealthSample | undefined {
    if (this.#closed) return undefined;
    try {
      const sampledAt = this.#clock();
      const sampledMs = Date.parse(sampledAt);
      const memory = this.#options.memory?.() ?? process.memoryUsage();
      const lag = takeEventLoopLagWindow();
      const statements = (
        this.#options.slowStatementWindow ?? (() => slowStatementTally.takeWindow())
      )();
      const databaseBytes = this.#options.databaseBytes?.();
      const sample = decodeHostHealthSample({
        sampledAt,
        windowMs: Math.max(1, Math.round(sampledMs - this.#lastSampleMs)),
        processStartedAt: this.#processStartedAt,
        rssBytes: Math.round(memory.rss),
        heapUsedBytes: Math.round(memory.heapUsed),
        ...(databaseBytes === undefined ? {} : { databaseBytes }),
        eventLoopLagCount: lag.count,
        eventLoopLagWorstMs: lag.worstMs,
        slowStatementCount: statements.count,
        slowStatementWorstMs: statements.worstMs,
        latency: this.#options.latencyWindow().map((window) => ({
          key: window.key,
          count: window.count,
          p50Ms: window.p50Ms,
          p95Ms: window.p95Ms,
          maxMs: window.maxMs,
        })),
      });
      this.#lastSampleMs = sampledMs;
      const connection = this.#open();
      connection
        .prepare("INSERT OR REPLACE INTO host_health_samples (sampled_at, sample) VALUES (?, ?)")
        .run(sample.sampledAt, JSON.stringify(sample));
      this.#samplesSincePrune += 1;
      if (this.#samplesSincePrune >= PRUNE_EVERY_SAMPLES) {
        this.#samplesSincePrune = 0;
        this.#prune(sampledMs);
      }
      return sample;
    } catch {
      return undefined;
    }
  }

  /**
   * Samples in the span, oldest first, as minutes or hours. A stored row that
   * no longer decodes (a sample written by a newer host) is skipped rather
   * than failing the read.
   */
  read(request: HostHealthHistoryRequest): HostHealthHistory {
    const generatedAt = this.#clock() as UtcTimestamp;
    const from = request.from ?? new Date(Date.parse(generatedAt) - RETENTION_MS).toISOString();
    const to = request.to ?? generatedAt;
    let rows: ReadonlyArray<unknown> = [];
    try {
      if (this.#closed) throw new Error("Host health recording has stopped.");
      rows = this.#open()
        .prepare(
          "SELECT sample FROM host_health_samples WHERE sampled_at >= ? AND sampled_at <= ? ORDER BY sampled_at",
        )
        .all(from, to);
    } catch {
      rows = [];
    }
    const samples: HostHealthSample[] = [];
    for (const row of rows) {
      if (typeof row !== "object" || row === null || !("sample" in row)) continue;
      if (typeof row.sample !== "string") continue;
      try {
        samples.push(decodeHostHealthSample(JSON.parse(row.sample)));
      } catch {
        // Unreadable rows are left for retention to remove.
      }
    }
    const points = hostHealthPoints(samples, request.resolution);
    return {
      generatedAt,
      resolution: points.resolution,
      retentionDays: HOST_HEALTH_RETENTION_DAYS,
      samples: points.samples,
      processStarts: points.processStarts,
    };
  }

  #open(): SqliteConnection {
    if (this.#connection !== undefined) return this.#connection;
    const connection = openSqlite(this.#options.path);
    connection.exec(
      "CREATE TABLE IF NOT EXISTS host_health_samples (sampled_at TEXT PRIMARY KEY, sample TEXT NOT NULL)",
    );
    this.#connection = connection;
    return connection;
  }

  #prune(nowMs: number): void {
    this.#open()
      .prepare("DELETE FROM host_health_samples WHERE sampled_at < ?")
      .run(new Date(nowMs - RETENTION_MS).toISOString());
  }
}
