/** Lag above this is logged unless `OCTANT_EVENT_LOOP_LAG_MS` says otherwise. */
export const DEFAULT_EVENT_LOOP_LAG_MS = 100;
const SAMPLE_INTERVAL_MS = 50;

export interface EventLoopLagCounters {
  readonly count: number;
  readonly worstMs: number;
}

let lagCount = 0;
let worstLagMs = 0;

/** Process-wide tally since start; carries no route names. */
export function readEventLoopLagCounters(): EventLoopLagCounters {
  return { count: lagCount, worstMs: Math.round(worstLagMs) };
}

export function eventLoopLagThresholdFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = environment.OCTANT_EVENT_LOOP_LAG_MS;
  const parsed = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_EVENT_LOOP_LAG_MS;
}

interface RepeatingTimer {
  unref(): unknown;
}

export interface EventLoopLagDetectorOptions {
  readonly thresholdMs?: number;
  readonly intervalMs?: number;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  readonly setTimer?: (tick: () => void, intervalMs: number) => RepeatingTimer;
}

/**
 * Measures how late a repeating timer fires. `monitorEventLoopDelay` is not
 * used because Bun's implementation reported 2 ms of delay for a 200 ms
 * synchronous block in this runtime. The timer is unref'd so it never keeps
 * the process alive. Returns a stop function. The server tracks no request in
 * flight, so a lag line carries the duration alone.
 */
export function startEventLoopLagDetector(options: EventLoopLagDetectorOptions = {}): () => void {
  const thresholdMs = options.thresholdMs ?? eventLoopLagThresholdFromEnvironment();
  const intervalMs = options.intervalMs ?? SAMPLE_INTERVAL_MS;
  const now = options.now ?? (() => performance.now());
  const underTest = process.env.VITEST !== undefined || process.env.NODE_ENV === "test";
  const log =
    options.log ??
    (underTest && process.env.OCTANT_EVENT_LOOP_LAG_MS === undefined
      ? undefined
      : (line: string) => console.warn(line));
  let expected = now() + intervalMs;
  const startTimer = options.setTimer ?? ((tick, ms) => setInterval(tick, ms));
  const timer = startTimer(() => {
    const current = now();
    const lagMs = current - expected;
    expected = current + intervalMs;
    if (lagMs > thresholdMs) {
      lagCount += 1;
      if (lagMs > worstLagMs) worstLagMs = lagMs;
      log?.(`[event-loop-lag] ${Math.round(lagMs)} ms over ${thresholdMs} ms`);
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer as ReturnType<typeof setInterval>);
}
