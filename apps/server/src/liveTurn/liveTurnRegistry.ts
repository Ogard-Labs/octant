import type { ProviderConnection } from "@octant/provider-sdk";
import {
  decodeUtcTimestamp,
  type MachineChangeTopic,
  type ProviderInstanceId,
  type ProviderSessionId,
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
 * The provider connection a running turn holds, so the host can act on that
 * one turn without starting another: stop one subagent the runtime started,
 * or steer a finished child's result in.
 */
export interface LiveTurnConnection {
  readonly connection: ProviderConnection;
  readonly sessionId: ProviderSessionId;
  readonly providerInstanceId: ProviderInstanceId;
  /**
   * Whether a child's result steered in mid-turn is covered by the thread's
   * journaled outside-content mark alone. Every approval gate reads that mark
   * when it decides, so a later tool in the turn acts tainted; a turn whose
   * runtime chose its own approval reviewer while the thread was unmarked
   * keeps that reviewer for the rest of the turn, so it takes no steered
   * result and the result waits for the next turn instead.
   */
  readonly takesSteeredResults: boolean;
}

/**
 * The runner's handle on one thread's turn. A runner calls `begin` when it
 * starts, `observe` for every provider event, and `end` when the turn is over
 * whatever its outcome.
 */
export interface LiveTurnTracker {
  begin(startedAt: string): void;
  observe(event: ProviderRuntimeEvent): void;
  /** Records the connection the turn acquired; it is forgotten at `end`. */
  connect(connection: LiveTurnConnection): void;
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
  readonly topic: MachineChangeTopic;
  readonly startedAt: UtcTimestamp;
  state: LiveTurnState;
  connection?: LiveTurnConnection;
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
          this.#turns.set(threadId, {
            owner,
            topic,
            startedAt: decoded,
            state: startLiveTurn(decoded),
          });
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
      connect: (connection) => {
        const turn = own();
        if (turn !== undefined) turn.connection = connection;
      },
      end: () => {
        if (own() === undefined) return;
        this.#turns.delete(threadId);
        this.#changed(topic);
      },
    };
  }

  /** The connection of the thread's running turn, once the turn acquired one. */
  connection(threadId: string): LiveTurnConnection | undefined {
    return this.#turns.get(threadId)?.connection;
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

  /** Every turn currently running, by thread id and mode topic. */
  activeEntries(): ReadonlyArray<{
    readonly threadId: string;
    readonly topic: MachineChangeTopic;
  }> {
    const entries: Array<{ readonly threadId: string; readonly topic: MachineChangeTopic }> = [];
    for (const [threadId, turn] of this.#turns) {
      entries.push({ threadId, topic: turn.topic });
    }
    return entries;
  }
}
