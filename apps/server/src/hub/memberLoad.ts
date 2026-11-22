import {
  holdMemberLoad,
  observedMemberLoad,
  type HostMemoryPressure,
  type MemberLoadLevel,
  type MemberLoadState,
} from "@octant/domain";

/**
 * This member's load level as it reports it beside the roster: sampled from
 * its memory pressure and its live turns, and changed only once a new
 * reading has held, so placement advice does not flap.
 */
export class MemberLoad {
  readonly #read: () => { readonly memoryPressure: HostMemoryPressure; readonly liveTurns: number };
  readonly #now: () => number;
  #state: MemberLoadState = { reported: "light" };

  constructor(options: {
    readonly read: () => {
      readonly memoryPressure: HostMemoryPressure;
      readonly liveTurns: number;
    };
    readonly now: () => number;
  }) {
    this.#read = options.read;
    this.#now = options.now;
  }

  /** Takes one reading; the host calls this on a steady cadence. */
  sample(): void {
    this.#state = holdMemberLoad(this.#state, observedMemberLoad(this.#read()), this.#now());
  }

  level(): MemberLoadLevel {
    return this.#state.reported;
  }
}
