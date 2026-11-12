import { createHash } from "node:crypto";
import {
  AggregateId,
  AggregateVersion,
  CorrelationId,
  EventActor,
  EventId,
  TOOL_EFFECT_AGGREGATE_TYPE,
  TOOL_EFFECT_EVENT_NAMES,
  ToolEffectIntended,
  ToolEffectSettled,
  type ProviderRuntimeEvent,
  type ToolEffectOrigin,
} from "@octant/contracts";
import { Schema } from "effect";
import type { EventRegistry } from "../persistence/eventRegistry";
import type { Journal } from "../persistence/journal";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import { toolEffectClass } from "./toolEffectClass";

const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeIntended = Schema.decodeUnknownSync(ToolEffectIntended);
const decodeSettled = Schema.decodeUnknownSync(ToolEffectSettled);

/** The contract's bound on a tool name and a call id. */
const MAX_LABEL_LENGTH = 128;
const REPLAY_PAGE = 1_000;
/**
 * Turns whose record position is kept in memory. A turn with no call open is
 * dropped at once, so this only bounds turns a runtime left a start open on.
 */
const MAX_OPEN_TURNS = 512;

type JournalPort = Pick<Journal, "append" | "replayAggregate" | "latestAggregateEvent">;

export function registerToolEffectEvents(registry: EventRegistry): EventRegistry {
  return registry
    .register(TOOL_EFFECT_EVENT_NAMES.intended, 1, ToolEffectIntended)
    .register(TOOL_EFFECT_EVENT_NAMES.settled, 1, ToolEffectSettled);
}

/**
 * What a turn's record says of the calls it started. `uncertain` names the
 * first side-effecting call with no settled record: it may or may not have
 * taken effect. `unreadable` is a record the host could not read, which
 * proves nothing either way.
 */
export type TurnToolCertainty =
  | { readonly kind: "settled" }
  | { readonly kind: "uncertain"; readonly toolName: string }
  | { readonly kind: "unreadable" };

/** One turn's side of the ledger, handed to the turn's runner. */
export interface TurnToolEffects {
  /** The set with every call recorded before it runs and settled after. */
  readonly tools: (set: AppManagedToolSet) => AppManagedToolSet;
  /**
   * Records what a provider runtime reports of its own tools: a start as a
   * call that may have taken effect, a success or failure as its end.
   */
  readonly observe: (event: ProviderRuntimeEvent) => void;
}

/** The set as the turn's runner calls it: recorded when the turn keeps a record. */
export function recordedToolSet(
  effects: TurnToolEffects | undefined,
  set: AppManagedToolSet | undefined,
): AppManagedToolSet | undefined {
  return effects === undefined || set === undefined ? set : effects.tools(set);
}

interface OpenTurn {
  version: number;
  readonly open: Map<string, ToolEffectOrigin>;
}

/**
 * The record of tool calls about to take effect. A restart cuts a turn off
 * wherever it is, and without this nothing says whether a shell command, an
 * edit or an MCP call was in flight: the host would continue the turn and the
 * agent could repeat it. Each call writes one frame before it runs and one
 * when its outcome is known, on the turn's own aggregate, so a call with no
 * second frame is one nobody saw finish.
 *
 * Nothing is rebuilt at start: a turn's record is read only when a restart
 * cut that turn off, so the cost of a start does not grow with the calls a
 * host has ever made. Frames carry `threadId`, which is how a thread's purge
 * finds them.
 */
export class ToolEffectLedger {
  readonly #journal: JournalPort;
  readonly #uuid: () => string;
  readonly #actor: typeof EventActor.Type;
  readonly #clock: () => string;
  readonly #turns = new Map<string, OpenTurn>();

  constructor(options: {
    readonly journal: JournalPort;
    readonly uuid: () => string;
    readonly actor: typeof EventActor.Type;
    readonly clock: () => string;
  }) {
    this.#journal = options.journal;
    this.#uuid = options.uuid;
    this.#actor = decodeActor(options.actor);
    this.#clock = options.clock;
  }

  forTurn(turn: { readonly threadId: string; readonly turnId: string }): TurnToolEffects {
    return {
      tools: (set) => ({
        ...set,
        execute: async (input) => {
          // A tool the set does not offer is refused by the set and can take
          // no effect, so it leaves no record.
          if (!set.definitions.some((definition) => definition.name === input.name))
            return set.execute(input);
          const toolCallId = boundedCallId(input.toolCallId ?? this.#uuid());
          try {
            this.#intend(turn, toolCallId, input.name, "host");
          } catch {
            // Running it unrecorded would let a restart continue past a call
            // nobody can account for.
            return { result: { error: "tool-call-unrecorded" }, isError: true };
          }
          let outcome: ToolEffectSettled["outcome"] = "failed";
          try {
            const result = await set.execute(input);
            if (result.isError !== true) outcome = "succeeded";
            return result;
          } finally {
            this.#settle(turn, toolCallId, "host", outcome);
          }
        },
      }),
      observe: (event) => {
        if (event.kind === "tool-start") {
          const toolCallId = boundedCallId(event.toolCallId);
          if (this.#turns.get(turn.turnId)?.open.has(toolCallId) === true) return;
          try {
            this.#intend(turn, toolCallId, event.toolName, "runtime");
          } catch {
            // The runtime already started its tool; a frame the journal
            // refused cannot stop it, and the turn goes on unrecorded.
          }
        } else if (event.kind === "tool-success" || event.kind === "tool-failure") {
          this.#settle(
            turn,
            boundedCallId(event.toolCallId),
            "runtime",
            event.kind === "tool-success" ? "succeeded" : "failed",
          );
        }
      },
    };
  }

  /** Whether every side-effecting call the turn started is known to have ended. */
  certainty(turnId: string): TurnToolCertainty {
    const unsettled = new Map<string, ToolEffectIntended>();
    try {
      let afterVersion = 0;
      for (;;) {
        const page = this.#journal.replayAggregate({
          aggregateType: TOOL_EFFECT_AGGREGATE_TYPE,
          aggregateId: turnId,
          afterVersion,
          limit: REPLAY_PAGE,
        });
        for (const envelope of page) {
          if (envelope.eventName === TOOL_EFFECT_EVENT_NAMES.intended) {
            const intended = decodeIntended(envelope.payload);
            unsettled.set(intended.toolCallId, intended);
          } else if (envelope.eventName === TOOL_EFFECT_EVENT_NAMES.settled) {
            unsettled.delete(decodeSettled(envelope.payload).toolCallId);
          }
          afterVersion = envelope.aggregateVersion;
        }
        if (page.length < REPLAY_PAGE) break;
      }
    } catch {
      return { kind: "unreadable" };
    }
    for (const intended of unsettled.values()) {
      if (intended.effect === "side-effecting")
        return { kind: "uncertain", toolName: intended.toolName };
    }
    return { kind: "settled" };
  }

  #intend(
    turn: { readonly threadId: string; readonly turnId: string },
    toolCallId: string,
    toolName: string,
    origin: ToolEffectOrigin,
  ): void {
    const name = boundedToolName(toolName);
    const state = this.#openTurn(turn.turnId);
    this.#append(
      state,
      turn.turnId,
      TOOL_EFFECT_EVENT_NAMES.intended,
      decodeIntended({
        threadId: turn.threadId,
        turnId: turn.turnId,
        toolCallId,
        toolName: name,
        // A runtime's own tool is never declared: its name says nothing the
        // host can rely on.
        effect: origin === "host" ? toolEffectClass(name) : "side-effecting",
        origin,
      }),
    );
    state.open.set(toolCallId, origin);
    this.#turns.delete(turn.turnId);
    this.#turns.set(turn.turnId, state);
    if (this.#turns.size > MAX_OPEN_TURNS) {
      const oldest = this.#turns.keys().next().value;
      if (oldest !== undefined) this.#turns.delete(oldest);
    }
  }

  #settle(
    turn: { readonly threadId: string; readonly turnId: string },
    toolCallId: string,
    origin: ToolEffectOrigin,
    outcome: ToolEffectSettled["outcome"],
  ): void {
    const state = this.#turns.get(turn.turnId);
    // Only the side that recorded the start ends it: a runtime's report of a
    // call the host is still running says nothing of the host's own tool.
    if (state?.open.get(toolCallId) !== origin) return;
    try {
      this.#append(
        state,
        turn.turnId,
        TOOL_EFFECT_EVENT_NAMES.settled,
        decodeSettled({ threadId: turn.threadId, turnId: turn.turnId, toolCallId, outcome }),
      );
    } catch {
      // Left unsettled: after a restart the call reads as uncertain, which
      // is the safe reading of an outcome that was never written down.
    }
    state.open.delete(toolCallId);
    if (state.open.size === 0) this.#turns.delete(turn.turnId);
  }

  #openTurn(turnId: string): OpenTurn {
    const known = this.#turns.get(turnId);
    if (known !== undefined) return known;
    const head = this.#journal.latestAggregateEvent({
      aggregateType: TOOL_EFFECT_AGGREGATE_TYPE,
      aggregateId: turnId,
    });
    return { version: head?.aggregateVersion ?? 0, open: new Map() };
  }

  #append(state: OpenTurn, turnId: string, eventName: string, payload: unknown): void {
    this.#journal.append({
      aggregate: {
        aggregateType: TOOL_EFFECT_AGGREGATE_TYPE,
        aggregateId: decodeAggregateId(turnId),
      },
      expectedVersion: decodeAggregateVersion(state.version),
      events: [
        {
          eventId: decodeEventId(this.#uuid()),
          eventName,
          eventVersion: 1,
          correlationId: decodeCorrelationId(this.#uuid()),
          actor: this.#actor,
          occurredAt: this.#clock(),
          payload,
        },
      ],
    });
    state.version += 1;
  }
}

/**
 * A runtime names its calls freely; the record's field is bounded. A longer
 * id is replaced by its digest, which still pairs a start with its finish.
 */
function boundedCallId(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "unnamed";
  return trimmed.length <= MAX_LABEL_LENGTH
    ? trimmed
    : createHash("sha256").update(trimmed).digest("hex");
}

function boundedToolName(value: string): string {
  const trimmed = value.trim().slice(0, MAX_LABEL_LENGTH).trimEnd();
  return trimmed.length === 0 ? "unnamed" : trimmed;
}

/**
 * Why a thread waits for its person after a restart, when its cut-off turn
 * left a call nobody saw finish. Undefined when nothing is uncertain.
 */
export function uncertainToolCallHold(certainty: TurnToolCertainty): string | undefined {
  if (certainty.kind === "settled") return undefined;
  return certainty.kind === "uncertain"
    ? `Octant stopped while the tool "${certainty.toolName}" was running, so it may or may not have taken effect. Check it, then continue.`
    : "Octant could not read which tool calls this turn had started. Check it, then continue.";
}
