/**
 * A click's wave: an uneven ring (now and then a heart) that spreads from where
 * a person clicked and fades. The moving print lights its cells with it; the
 * character ground draws its own patches and answers no click.
 */

/** How fast a click's ring spreads, how wide it is, and how long it lasts. */
export const RIPPLE_SPEED = 320;
export const RIPPLE_BAND = 40;
const RIPPLE_SECONDS = 1.6;
/** A fainter echo follows each ring this many seconds behind, at this strength. */
export const ECHO_DELAY = 0.22;
const ECHO_GAIN = 0.45;
/** About one click in this many draws a heart instead of a ring. */
const HEART_ODDS = 6;

export interface Ripple {
  readonly x: number;
  readonly y: number;
  /** Field time, in seconds, when the click landed. */
  readonly start: number;
  /** Phase for the ring's wobble, so no two clicks look alike. */
  readonly seed: number;
  /** How far the ring's edge strays from a circle; 0 is a perfect circle. */
  readonly wobble: number;
  readonly heart: boolean;
}

export function createRipple(x: number, y: number, start: number, random = Math.random): Ripple {
  return {
    x,
    y,
    start,
    seed: random() * Math.PI * 2,
    wobble: 0.08 + random() * 0.14,
    heart: random() < 1 / HEART_ODDS,
  };
}

/**
 * How far the edge reaches in the direction `angle`, as a share of the ring's
 * plain radius. A ring wobbles and the wobble drifts while it grows; a heart
 * keeps its cleft above the click and its point below (screen y runs down).
 */
function edgeReach(ripple: Ripple, angle: number, t: number): number {
  if (ripple.heart) {
    const up = -Math.sin(angle);
    const across = Math.cos(angle);
    return (2 - 2 * up + (up * Math.sqrt(Math.abs(across))) / (up + 1.4)) / 2.2;
  }
  return (
    1 +
    ripple.wobble *
      (0.6 * Math.sin(3 * angle + ripple.seed + t * 1.7) +
        0.4 * Math.sin(5 * angle - ripple.seed * 1.3 - t * 2.3))
  );
}

/**
 * The brightness a click's wave lends a point at time `t`: full on the edge,
 * falling off across a band whose width varies around the ring, fading as the
 * wave grows old, with a fainter echo just behind it.
 */
export function rippleBrightness(ripple: Ripple, x: number, y: number, t: number): number {
  const angle = Math.atan2(y - ripple.y, x - ripple.x);
  const distance = Math.hypot(x - ripple.x, y - ripple.y);
  const band = RIPPLE_BAND * (0.8 + 0.4 * Math.sin(angle * 4 + ripple.seed));
  let lit = 0;
  for (const [delay, gain] of [
    [0, 1],
    [ECHO_DELAY, ECHO_GAIN],
  ] as const) {
    const age = t - ripple.start - delay;
    if (age < 0 || age > RIPPLE_SECONDS) continue;
    const fromEdge = Math.abs(distance - age * RIPPLE_SPEED * edgeReach(ripple, angle, t));
    if (fromEdge < band)
      lit = Math.max(lit, gain * (1 - fromEdge / band) * (1 - age / RIPPLE_SECONDS));
  }
  return lit;
}

/**
 * Whether a click may send a ring. With `within`, only a click inside a
 * matching element counts: under the whole shell the field also lies behind
 * threads, where a ring answering every click in a transcript was a
 * distraction, so there it answers the start screen alone.
 */
export function acceptsRipple(target: EventTarget | null, within: string | undefined): boolean {
  if (within === undefined) return true;
  return target instanceof Element && target.closest(within) !== null;
}
