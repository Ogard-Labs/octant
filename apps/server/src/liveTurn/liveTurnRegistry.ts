import {
  decodeUtcTimestamp,
  type MachineChangeTopic,
  type ProviderRuntimeEvent,
  type ThreadLiveStep,
  type UtcTimestamp,
} from "@octant/contracts";
import {
  liveTurnStep,
  observeLiveTurn,
  startLiveTurn,
  type LiveTurnState,
} from "@octant/domain/live-turn-policy";

/** What a navigation row may carry about a thread whose turn is running. */
export interface LiveTurnFacts {
  readonly turnStartedAt: UtcTimestamp;
  readonly liveStep?: ThreadLiveStep;
}

/**
 * The runner's handle on one thread's turn. A runner calls `begin` when it
 * starts, `observe` for every provider event, and `end` when the turn is over
 * whatever its outcome.
 */
export interface LiveTurnTracker {
  begin(startedAt: string): void;
  observe(event: ProviderRuntimeEvent): void;
  end(): void;
}

export interface LiveTurnRegistryOptions {
  /**
   * Told that a topic's navigation read is out of date. A live step is not a
   * journal event, so nothing else would invalidate the sidebar for it: the
   * host's navigation reads follow the change feed, not a timer.
   */
  readonly onChanged?: (topic: MachineChangeTopic) => void;
  /** How long changes to one topic are held back and merged into a single notice. */
  readonly coalesceMs?: number;
}

const DEFAULT_COALESCE_MS = 250;

interface LiveTurn {
  readonly owner: symbol;
  readonly startedAt: UtcTimestamp;
  state: LiveTurnState;
}

/**
 * Process-local record of what each running turn is doing, for the Chat, Work,
 * and Code navigation reads.
 *
 * It is deliberately not journaled: a turn that was running when the host
 * stopped is reconciled to interrupted on restart, so there is nothing live to
 * rebuild, and a step line that survived a restart would describe a process
 * that no longer exists. An entry lives only between `begin` and `end`, and a
 * tracker only ever touches the entry it began, so a late `end` from an older
 * turn cannot erase the turn that replaced it.
 */
export class LiveTurnRegistry {
  readonly #turns = new Map<string, LiveTurn>();
  readonly #onChanged: ((topic: MachineChangeTopic) => void) | undefined;
  readonly #coalesceMs: number;
  readonly #pending = new Map<MachineChangeTopic, ReturnType<typeof setTimeout>>();

  constructor(options: LiveTurnRegistryOptions = {}) {
    this.#onChanged = options.onChanged;
    this.#coalesceMs = options.coalesceMs ?? DEFAULT_COALESCE_MS;
  }

  /**
   * A tool-heavy turn can change its step many times a second, and every notice
   * costs each client a navigation read, so the notices are merged: one goes
   * out after the first change, carrying whatever the step has become by then.
   */
  #changed(topic: MachineChangeTopic): void {
    if (this.#onChanged === undefined || this.#pending.has(topic)) return;
    const timer = setTimeout(() => {
      this.#pending.delete(topic);
      this.#onChanged?.(topic);
    }, this.#coalesceMs);
    timer.unref?.();
    this.#pending.set(topic, timer);
  }

  tracker(threadId: string, topic: MachineChangeTopic): LiveTurnTracker {
    const owner = Symbol(threadId);
    const own = (): LiveTurn | undefined => {
      const turn = this.#turns.get(threadId);
      return turn?.owner === owner ? turn : undefined;
    };
    return {
      begin: (startedAt) => {
        // A start time that is not a timestamp is not one the row can show, so
        // the turn simply goes unreported rather than failing to run.
        try {
          const decoded = decodeUtcTimestamp(startedAt);
          this.#turns.set(threadId, { owner, startedAt: decoded, state: startLiveTurn(decoded) });
        } catch {
          this.#turns.delete(threadId);
        }
        this.#changed(topic);
      },
      observe: (event) => {
        const turn = own();
        if (turn === undefined) return;
        // Text deltas arrive many times a second and never move the step; the
        // fold hands back the same state for them, so they cost one comparison.
        const next = observeLiveTurn(turn.state, event);
        if (next === turn.state) return;
        const moved =
          JSON.stringify(liveTurnStep(next)) !== JSON.stringify(liveTurnStep(turn.state));
        turn.state = next;
        if (moved) this.#changed(topic);
      },
      end: () => {
        if (own() === undefined) return;
        this.#turns.delete(threadId);
        this.#changed(topic);
      },
    };
  }

  /** The thread's live-turn facts, or nothing when no turn is running. */
  read(threadId: string): LiveTurnFacts | undefined {
    const turn = this.#turns.get(threadId);
    if (turn === undefined) return undefined;
    const step = liveTurnStep(turn.state);
    return {
      turnStartedAt: turn.startedAt,
      ...(step === undefined ? {} : { liveStep: step }),
    };
  }
}
