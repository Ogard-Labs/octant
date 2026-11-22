import type { HostDrainStatus } from "@octant/contracts/host-control";

/**
 * Draining this host before an update: new Chat, Work and Code turns and
 * routine runs are refused while the turns already running go on, until no
 * turn runs or the wait the person chose passes. Then the update stops the
 * host, and restart continuation resumes any turn the stop cut off.
 * Canonical: docs/architecture.md § Draining before an update.
 *
 * Nothing here cancels a turn: only stopping the host does, and that is the
 * update's step, run after the wait or at once when the person chose to.
 * The drain lives in this process alone, so a host that stops or restarts
 * admits turns again.
 */

/** What a new turn reads while this host drains. */
export const HOST_DRAINING_REFUSAL =
  "This computer is about to update. Try again in a few minutes.";

/**
 * How long a drain keeps refusing after its wait ends. The update stops the
 * host right after the wait, or lifts the drain when it fails before the
 * swap; this bound lifts a drain whose update never came back (its SSH
 * connection dropped) so the computer does not refuse turns indefinitely.
 */
const HOLD_AFTER_WAIT_MS = 5 * 60_000;

/** One running turn: a thread runs one turn at a time in its mode. */
export interface RunningTurn {
  readonly mode: string;
  readonly threadId: string;
}

/**
 * A prepared turn's admission. An accepted turn that ends before its provider
 * starts (a spend refusal, a failed journal write) calls `release`, which
 * forgets only this registration: once the turn started, or the thread's next
 * turn registered, it changes nothing.
 */
export type TurnAcceptance =
  | { readonly status: "refused"; readonly message: string }
  | { readonly status: "accepted"; readonly release: () => void };

export class HostDrain {
  readonly #now: () => number;
  /** Each running thread with the registration that counts it. */
  readonly #running = new Map<string, symbol>();
  #drain: { readonly waitEndsAt: number; readonly liftsAt: number } | undefined;

  constructor(options: { readonly now: () => number }) {
    this.#now = options.now;
  }

  /**
   * Starts refusing new turns and gives running ones `minutes` to end. A
   * second drain starts its wait again.
   */
  enter(minutes: number): HostDrainStatus {
    const waitEndsAt = this.#now() + minutes * 60_000;
    this.#drain = { waitEndsAt, liftsAt: waitEndsAt + HOLD_AFTER_WAIT_MS };
    return this.status();
  }

  lift(): void {
    this.#drain = undefined;
  }

  /** The sentence a new turn is refused with, or nothing while the host admits turns. */
  refusal(): string | undefined {
    return this.#current() === undefined ? undefined : HOST_DRAINING_REFUSAL;
  }

  status(): HostDrainStatus {
    const drain = this.#current();
    if (drain === undefined) return { state: "not-draining" };
    const running = this.#running.size;
    if (running === 0) return { state: "drained" };
    return this.#now() >= drain.waitEndsAt
      ? { state: "timed-out", running }
      : { state: "draining", running };
  }

  /**
   * Checked again right before a prepared turn is accepted: a drain that
   * began while the turn read attachments or context refuses it, and an
   * accepted turn counts as running from here, before its provider starts,
   * so the drain waits for it.
   */
  accept(turn: RunningTurn): TurnAcceptance {
    const refusal = this.refusal();
    if (refusal !== undefined) return { status: "refused", message: refusal };
    const key = keyOf(turn);
    const registration = Symbol(key);
    this.#running.set(key, registration);
    return {
      status: "accepted",
      release: () => {
        if (this.#running.get(key) === registration) this.#running.delete(key);
      },
    };
  }

  turnStarted(turn: RunningTurn): void {
    const key = keyOf(turn);
    this.#running.set(key, Symbol(key));
  }

  turnEnded(turn: RunningTurn): void {
    this.#running.delete(keyOf(turn));
  }

  #current(): { readonly waitEndsAt: number; readonly liftsAt: number } | undefined {
    if (this.#drain !== undefined && this.#now() >= this.#drain.liftsAt) this.#drain = undefined;
    return this.#drain;
  }
}

/**
 * Keyed by thread rather than counted: a turn whose end was never reported
 * is forgotten when its thread's next turn ends, instead of holding every
 * later drain until it times out.
 */
function keyOf(turn: RunningTurn): string {
  return `${turn.mode}:${turn.threadId}`;
}
