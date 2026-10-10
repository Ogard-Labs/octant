/** A point as fractions of the screen from its top-left corner. */
export interface ScreenFraction {
  readonly x: number;
  readonly y: number;
}

/** Where the finger is, and how long after it went down. */
export interface TouchSample extends ScreenFraction {
  readonly atMs: number;
}

/** About one display frame at 60 Hz, the pace the native helper also moves at. */
export const SWIPE_STEP_MS = 16;

/**
 * How close to an edge, as a fraction of the screen, a swipe must start to be
 * a system edge gesture. The pane's drag from the home indicator starts in the
 * bottom 1–2% of the screen; nothing inside the screen should count.
 */
const EDGE_BAND = 0.02;

/**
 * The finger's path for a swipe: down at `from`, then evenly spaced moves
 * along the straight line until it reaches `to` at `durationMs`. iOS reads a
 * finger that stays still and then jumps as a press-and-hold followed by a
 * teleport (observed 2026-10-08 on iOS 27: a 300 ms drag from the home
 * indicator put SpringBoard into icon-edit mode), so every step moves.
 */
export function swipePath(
  from: ScreenFraction,
  to: ScreenFraction,
  durationMs: number,
): ReadonlyArray<TouchSample> {
  const moves = Math.max(Math.ceil(durationMs / SWIPE_STEP_MS), 1);
  const samples: TouchSample[] = [{ x: from.x, y: from.y, atMs: 0 }];
  for (let step = 1; step < moves; step += 1) {
    const progress = step / moves;
    samples.push({
      x: from.x + (to.x - from.x) * progress,
      y: from.y + (to.y - from.y) * progress,
      atMs: durationMs * progress,
    });
  }
  // The last move is the requested end exactly, not a rounded product.
  samples.push({ x: to.x, y: to.y, atMs: durationMs });
  return samples;
}

export type ScreenEdge = "top" | "bottom" | "left" | "right";

/**
 * The screen edge a swipe starts on, if any. The Simulator recognises Home,
 * Notification Center and Control Center only from touches flagged as edge
 * touches: through serve-sim on iOS 27 (observed 2026-10-10) an unflagged
 * drag from the very bottom left Settings open, and the same drag flagged as
 * a bottom-edge touch went Home.
 */
export function swipeEdge(start: ScreenFraction): ScreenEdge | undefined {
  const distances: ReadonlyArray<readonly [ScreenEdge, number]> = [
    ["bottom", 1 - start.y],
    ["top", start.y],
    ["left", start.x],
    ["right", 1 - start.x],
  ];
  let nearest: readonly [ScreenEdge, number] | undefined;
  for (const candidate of distances) {
    if (candidate[1] <= EDGE_BAND && (nearest === undefined || candidate[1] < nearest[1])) {
      nearest = candidate;
    }
  }
  return nearest?.[0];
}
