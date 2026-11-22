import type { HostMemoryPressure } from "./hostMemoryPolicy";

/** How busy a member is, as other members read it beside the roster. */
export type MemberLoadLevel = "light" | "busy" | "heavy";

/** Turns at once from which a member reads as busy, and as heavy. */
export const MEMBER_BUSY_TURNS = 2;
export const MEMBER_HEAVY_TURNS = 5;
/** How long a new level must hold before the member reports it. */
export const MEMBER_LOAD_HOLD_MS = 120_000;

/** The level this moment's readings suggest, before it has held. */
export function observedMemberLoad(input: {
  readonly memoryPressure: HostMemoryPressure;
  readonly liveTurns: number;
}): MemberLoadLevel {
  if (input.memoryPressure === "critical" || input.liveTurns >= MEMBER_HEAVY_TURNS) return "heavy";
  if (input.memoryPressure === "elevated" || input.liveTurns >= MEMBER_BUSY_TURNS) return "busy";
  return "light";
}

export interface MemberLoadState {
  /** The level the member reports. */
  readonly reported: MemberLoadLevel;
  /** A different level seen since `since`, not reported until it holds. */
  readonly pending?: { readonly level: MemberLoadLevel; readonly since: number };
}

/**
 * The reported level changes only after a different reading has held for
 * {@link MEMBER_LOAD_HOLD_MS}, so a burst of turns or one memory spike does
 * not send work elsewhere and then straight back. A reading back at the
 * reported level drops the pending one.
 */
export function holdMemberLoad(
  state: MemberLoadState,
  observed: MemberLoadLevel,
  now: number,
): MemberLoadState {
  if (observed === state.reported) return { reported: state.reported };
  if (state.pending === undefined || state.pending.level !== observed) {
    return { reported: state.reported, pending: { level: observed, since: now } };
  }
  return now - state.pending.since >= MEMBER_LOAD_HOLD_MS ? { reported: observed } : state;
}
