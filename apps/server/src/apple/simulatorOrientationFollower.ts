export type SimulatorOrientation = "portrait" | "landscape";

/** The foreground app decides the orientation, and it takes a moment to turn after a press. */
const SETTLE_MS = 700;
/** No Simulator's orientation is read more often than this, whoever asks. */
const MIN_GAP_MS = 2_000;
/** While a live view is open, the orientation is re-read this often at most. */
const STREAMING_EVERY_MS = 5_000;

/** The input that can change which app is in front: Home, an app switch, or a tap on an icon or link. */
export function mayChangeForeground(request: {
  readonly kind: string;
  readonly key?: string | undefined;
}): boolean {
  if (request.kind === "tap") return true;
  if (request.kind !== "key-press") return false;
  const key = (request.key ?? "").toLowerCase();
  return key === "home" || key.includes("switch");
}

/**
 * Keeps the host's idea of a Simulator's orientation true to what the device
 * shows. Springboard stays portrait while an app turns, so the last rotate
 * request goes stale as soon as the foreground changes. Reads are screenshot
 * sized, never per frame: a trigger waits for the turn to settle, and no
 * Simulator is read twice within the minimum gap.
 */
export function createSimulatorOrientationFollower(options: {
  readonly read: (
    simulatorId: string,
    signal: AbortSignal,
  ) => Promise<SimulatorOrientation | undefined>;
  readonly note: (simulatorId: string, orientation: SimulatorOrientation) => void;
}) {
  const lastReadAt = new Map<string, number>();
  const scheduled = new Set<string>();
  const reading = new Set<string>();

  function readSoon(simulatorId: string, settleMs: number): void {
    if (scheduled.has(simulatorId)) return;
    const sinceLast = Date.now() - (lastReadAt.get(simulatorId) ?? -Infinity);
    const delay = Math.max(settleMs, MIN_GAP_MS - sinceLast);
    scheduled.add(simulatorId);
    setTimeout(() => {
      scheduled.delete(simulatorId);
      if (reading.has(simulatorId)) return;
      reading.add(simulatorId);
      lastReadAt.set(simulatorId, Date.now());
      void options
        .read(simulatorId, AbortSignal.timeout(5_000))
        .then(
          (orientation) => {
            if (orientation !== undefined) options.note(simulatorId, orientation);
          },
          () => undefined,
        )
        .finally(() => reading.delete(simulatorId));
    }, delay);
  }

  return {
    /** After input that ran: re-read when it may have changed the foreground app. */
    afterInput(
      simulatorId: string,
      request: Parameters<typeof mayChangeForeground>[0],
      outcome: string,
    ): void {
      if (outcome === "succeeded" && mayChangeForeground(request)) readSoon(simulatorId, SETTLE_MS);
    },
    /** While a live view is open: re-read on a slow interval until it ends. */
    whileWatching(simulatorId: string, signal: AbortSignal): void {
      if (signal.aborted) return;
      const timer = setInterval(() => readSoon(simulatorId, 0), STREAMING_EVERY_MS);
      signal.addEventListener("abort", () => clearInterval(timer), { once: true });
    },
  };
}
