import { withSandboxToolPolicy, activeSandboxPolicy } from "../process/sandboxRuntimePolicy";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import {
  AggregateId,
  AggregateVersion,
  CorrelationId,
  EventActor,
  EventId,
  TOOL_EFFECT_AGGREGATE_TYPE,
  TOOL_EFFECT_EVENT_NAMES,
  ToolEffectAwaitingApproval,
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
const decodeAwaitingApproval = Schema.decodeUnknownSync(ToolEffectAwaitingApproval);

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
    .register(TOOL_EFFECT_EVENT_NAMES.awaitingApproval, 1, ToolEffectAwaitingApproval)
    .register(TOOL_EFFECT_EVENT_NAMES.settled, 1, ToolEffectSettled);
}

/**
 * The recorded call the running code belongs to, so the service that asks a
 * person for the call's approval can say so without every tool between them
 * passing the record along. A tool whose approval service never says it is
 * waiting keeps its first frame, and a stop holds its thread: the default is
 * the safe one.
 */
const recordedCall = new AsyncLocalStorage<{
  readonly toolCallId: string;
  readonly awaitingApproval: () => boolean;
  readonly approvalAnswered: () => void;
  /**
   * Told a person-facing wait has opened, so a caller's deadline for the
   * call can stand still until `approvalWaited` reports it closed: an
   * unanswered approval never ends by timing out.
   */
  readonly approvalWaitStarted?: () => void;
  /**
   * Receives one person-facing wait's measured span as it closes, so a
   * caller timing the whole execution subtracts it instead of reading it as
   * run time.
   */
  readonly approvalWaited?: (waitMs: number) => void;
  /** The scope's clock in epoch milliseconds; `Date.now` when unset. */
  readonly now?: () => number;
}>();

/**
 * The recorded call whose execution this async scope serves, when one is.
 * An approval a tool asks while it runs carries this id, so the person's wait
 * is billed to that call alone — never guessed from whatever row is near.
 */
export function executingToolCallId(): string | undefined {
  return recordedCall.getStore()?.toolCallId;
}

/**
 * Runs one wait for a person's answer to a tool call's own approval. The
 * approval is asked before the call takes effect, so while it waits the
 * call's record says nothing ran, and a restart continues the turn and asks
 * again. Whatever the answer, the call's intent is on record again before
 * the tool hears it; when the journal refuses that frame this throws, because
 * the tool would otherwise run under a record that says it did not.
 *
 * `wait` receives `answered`, for an ask whose answer acts before the wait
 * settles (a confirmed memory proposal is written, a confirmed routine is
 * created, then the tool hears it): the service calls it as the answer
 * arrives and before it acts, so the intent is on record first. It throws
 * when the journal refuses the frame, and the service must then not act.
 * Calling it more than once records once.
 *
 * Only a wait that precedes every effect of its call belongs here. A prompt a
 * tool raises after it already acted (a download a click started) does not.
 */
export async function whileAwaitingToolApproval<T>(
  wait: (answered: () => void) => Promise<T>,
): Promise<T> {
  const call = recordedCall.getStore();
  if (call === undefined) return wait(() => undefined);
  // If the journal refuses the waiting frame, the original intent still
  // holds after restart and the person's wait still stays out of run time.
  const recorded = call.awaitingApproval();
  call.approvalWaitStarted?.();
  const startedAt = call.now?.() ?? Date.now();
  let onRecord = false;
  const answered = () => {
    if (!recorded || onRecord) return;
    call.approvalAnswered();
    onRecord = true;
  };
  try {
    return await wait(answered);
  } finally {
    try {
      answered();
    } finally {
      call.approvalWaited?.((call.now?.() ?? Date.now()) - startedAt);
    }
  }
}

/**
 * One person-facing wait inside a recorded call's execution, for asks the
 * call's own record is responsible for. Timing only: nothing joins the
 * call's record, so a call's recovery and effect state stay exactly what
 * they were whether the ask preceded every effect or not — the wait is
 * still not run time. `whileAwaitingToolApproval` remains the path for an
 * ask proven to precede the call's effects, where the record carries the
 * wait.
 */
export async function whileApprovalWaited<T>(wait: () => Promise<T>): Promise<T> {
  const call = recordedCall.getStore();
  if (call === undefined || call.approvalWaited === undefined) return wait();
  call.approvalWaitStarted?.();
  const startedAt = call.now?.() ?? Date.now();
  try {
    return await wait();
  } finally {
    call.approvalWaited((call.now?.() ?? Date.now()) - startedAt);
  }
}

/**
 * The host tool a runtime's report of a tool start names, when the start is
 * the runtime's side of a call it hands to the host: the tool's own name
 * (Codex, Pi), or the name under the server the host's tools are offered
 * through (`mcp__octant__` on Claude Code, `octant-<16 hex>_` on OpenCode).
 * Any other spelling is the runtime's own tool.
 */
function bridgedHostTool(runtimeToolName: string, hostTools: AppManagedToolSet): boolean {
  const name = runtimeToolName.trim();
  const bridged =
    /^mcp__octant__(.+)$/.exec(name)?.[1] ?? /^octant-[0-9a-f]{16}_(.+)$/.exec(name)?.[1] ?? name;
  return hostTools.definitions.some((definition) => definition.name === bridged);
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
   * `hostTools` is the set the turn offers its runtime: a start that names
   * one of them is the runtime's side of a call the host runs and records
   * itself, under another id, so it is not recorded a second time as a tool
   * that may have changed something; a `tool-request` for one of them that
   * names the runtime's earlier report of it closes that report. An
   * `approval-request` that names a reported call records that the call is
   * waiting for the runtime's answer (`approvalAnswered` ends the wait).
   */
  readonly observe: (event: ProviderRuntimeEvent, hostTools?: AppManagedToolSet) => void;
}

/** The set as the turn's runner calls it: recorded when the turn keeps a record. */
export function recordedToolSet(
  effects: TurnToolEffects | undefined,
  set: AppManagedToolSet | undefined,
  threadId?: string,
): AppManagedToolSet | undefined {
  if (set === undefined) return undefined;
  const admitted = threadId === undefined ? undefined : activeSandboxPolicy(threadId);
  const bound =
    threadId === undefined
      ? set
      : {
          ...set,
          execute: (input: Parameters<AppManagedToolSet["execute"]>[0]) =>
            withSandboxToolPolicy(threadId, () => {
              if (admitted !== undefined && activeSandboxPolicy(threadId) !== admitted)
                throw new Error("This sandbox tool set has expired. Start a new turn.");
              return set.execute(input);
            }),
        };
  return effects === undefined ? bound : effects.tools(bound);
}

interface OpenCall {
  readonly origin: ToolEffectOrigin;
  readonly toolName: string;
}

interface OpenTurn {
  version: number;
  readonly open: Map<string, OpenCall>;
}

/**
 * Runtime approval requests whose call's wait is on record, so the answer
 * can put the call's intent back before the runtime hears it. Bounded: an
 * entry no answer claims (a turn that stopped) is dropped oldest first, and
 * its call then holds after a restart as it did before the wait was recorded.
 */
const MAX_RUNTIME_ASKS = 512;

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
  readonly #runtimeAsks = new Map<
    string,
    {
      readonly turn: { readonly threadId: string; readonly turnId: string };
      readonly toolCallId: string;
    }
  >();

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
            const result = await recordedCall.run(
              {
                toolCallId,
                awaitingApproval: () => this.#awaitApproval(turn, toolCallId),
                approvalAnswered: () => this.#intend(turn, toolCallId, input.name, "host"),
                approvalWaitStarted: () => input.onApprovalWaitStarted?.(),
                approvalWaited: (waitMs) => input.onApprovalWait?.(waitMs),
                now: () => Date.parse(this.#clock()),
              },
              () => withSandboxToolPolicy(turn.threadId, () => set.execute(input)),
            );
            if (result.isError !== true) outcome = "succeeded";
            return result;
          } finally {
            this.#settle(turn, toolCallId, "host", outcome);
          }
        },
      }),
      observe: (event, hostTools) => {
        if (event.kind === "approval-request") {
          if (event.toolCallId !== undefined)
            this.#awaitRuntimeApproval(
              turn,
              boundedCallId(event.toolCallId),
              runtimeAskKey(event.sessionId, event.requestId),
            );
        } else if (event.kind === "tool-request") {
          // The runtime said which of its reported calls this request is: the
          // host runs it and records it under the request, so the runtime's
          // own report of it is closed rather than left to hold the thread.
          if (
            event.toolCallId !== undefined &&
            hostTools?.definitions.some((definition) => definition.name === event.toolName) === true
          )
            this.#settle(turn, boundedCallId(event.toolCallId), "runtime", "superseded");
        } else if (event.kind === "tool-start") {
          const toolCallId = boundedCallId(event.toolCallId);
          if (this.#turns.get(turn.turnId)?.open.has(toolCallId) === true) return;
          // The host runs this call and records it before it does. Recorded
          // here too, a read-only host tool would hold its thread as a
          // runtime tool nobody saw finish.
          if (hostTools !== undefined && bridgedHostTool(event.toolName, hostTools)) return;
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

  /**
   * A person or a reviewer answered a runtime's approval request: the call it
   * gates goes back on record as one that may take effect before the runtime
   * hears the answer. False when that frame could not be written; the caller
   * then refuses the call rather than let it run under a record that says it
   * did not. True when the request had no recorded wait.
   */
  approvalAnswered(answer: { readonly sessionId: string; readonly requestId: string }): boolean {
    const key = runtimeAskKey(answer.sessionId, answer.requestId);
    const ask = this.#runtimeAsks.get(key);
    if (ask === undefined) return true;
    this.#runtimeAsks.delete(key);
    const call = this.#turns.get(ask.turn.turnId)?.open.get(ask.toolCallId);
    if (call?.origin !== "runtime") return true;
    try {
      this.#intend(ask.turn, ask.toolCallId, call.toolName, "runtime");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Whether every side-effecting call the turn started is known to have
   * ended. A call whose last frame says it was waiting for its approval had
   * not run, and counts as ended.
   */
  certainty(turnId: string): TurnToolCertainty {
    const unsettled = this.#unsettled(turnId);
    if (unsettled === undefined) return { kind: "unreadable" };
    for (const call of unsettled.values()) {
      if (call.intended.effect === "side-effecting" && !call.awaitingApproval)
        return { kind: "uncertain", toolName: call.intended.toolName };
    }
    return { kind: "settled" };
  }

  /**
   * Closes the calls an earlier execution under this id left open. An agent
   * run keeps one record across the times it runs, and a restart reads it
   * once, when it cut the run off; without this a call that restart already
   * reported would hold the thread again after every later one.
   */
  supersede(turn: { readonly threadId: string; readonly turnId: string }): void {
    try {
      const unsettled = this.#unsettled(turn.turnId);
      if (unsettled === undefined || unsettled.size === 0) return;
      const state = this.#openTurn(turn.turnId);
      for (const toolCallId of unsettled.keys()) {
        this.#append(
          state,
          turn.turnId,
          TOOL_EFFECT_EVENT_NAMES.settled,
          decodeSettled({
            threadId: turn.threadId,
            turnId: turn.turnId,
            toolCallId,
            outcome: "superseded",
          }),
        );
        state.open.delete(toolCallId);
      }
    } catch {
      // Left open: the record reads as uncertain, the safe reading.
    }
  }

  /** The calls with no settled frame, or undefined when the record cannot be read. */
  #unsettled(
    turnId: string,
  ):
    | Map<string, { readonly intended: ToolEffectIntended; readonly awaitingApproval: boolean }>
    | undefined {
    const unsettled = new Map<
      string,
      { readonly intended: ToolEffectIntended; readonly awaitingApproval: boolean }
    >();
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
            unsettled.set(intended.toolCallId, { intended, awaitingApproval: false });
          } else if (envelope.eventName === TOOL_EFFECT_EVENT_NAMES.awaitingApproval) {
            const { toolCallId } = decodeAwaitingApproval(envelope.payload);
            const call = unsettled.get(toolCallId);
            if (call !== undefined) unsettled.set(toolCallId, { ...call, awaitingApproval: true });
          } else if (envelope.eventName === TOOL_EFFECT_EVENT_NAMES.settled) {
            unsettled.delete(decodeSettled(envelope.payload).toolCallId);
          }
          afterVersion = envelope.aggregateVersion;
        }
        if (page.length < REPLAY_PAGE) break;
      }
    } catch {
      return undefined;
    }
    return unsettled;
  }

  /**
   * Whether the call's wait for its approval is on record. When the journal
   * refuses the frame the call keeps its first one, and a stop holds it.
   */
  #awaitApproval(
    turn: { readonly threadId: string; readonly turnId: string },
    toolCallId: string,
  ): boolean {
    const state = this.#turns.get(turn.turnId);
    if (state?.open.get(toolCallId)?.origin !== "host") return false;
    try {
      this.#append(
        state,
        turn.turnId,
        TOOL_EFFECT_EVENT_NAMES.awaitingApproval,
        decodeAwaitingApproval({ threadId: turn.threadId, turnId: turn.turnId, toolCallId }),
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Marks a runtime's reported call as waiting for the runtime's approval
   * request, when the request names a call whose start the host recorded.
   * A frame the journal refuses leaves the call as it was: it holds.
   */
  #awaitRuntimeApproval(
    turn: { readonly threadId: string; readonly turnId: string },
    toolCallId: string,
    key: string,
  ): void {
    const state = this.#turns.get(turn.turnId);
    if (state?.open.get(toolCallId)?.origin !== "runtime") return;
    try {
      this.#append(
        state,
        turn.turnId,
        TOOL_EFFECT_EVENT_NAMES.awaitingApproval,
        decodeAwaitingApproval({ threadId: turn.threadId, turnId: turn.turnId, toolCallId }),
      );
    } catch {
      return;
    }
    this.#runtimeAsks.delete(key);
    this.#runtimeAsks.set(key, { turn, toolCallId });
    if (this.#runtimeAsks.size > MAX_RUNTIME_ASKS) {
      const oldest = this.#runtimeAsks.keys().next().value;
      if (oldest !== undefined) this.#runtimeAsks.delete(oldest);
    }
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
    state.open.set(toolCallId, { origin, toolName: name });
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
    if (state?.open.get(toolCallId)?.origin !== origin) return;
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

function runtimeAskKey(sessionId: string, requestId: string): string {
  return `${sessionId}\u0000${requestId}`;
}

function boundedToolName(value: string): string {
  const trimmed = value.trim().slice(0, MAX_LABEL_LENGTH).trimEnd();
  return trimmed.length === 0 ? "unnamed" : trimmed;
}

/**
 * Why a thread waits for its person after a restart, when its cut-off turn,
 * or a child run of the thread, left a call nobody saw finish. Undefined
 * when nothing is uncertain.
 */
export function uncertainToolCallHold(
  certainty: TurnToolCertainty,
  ranBy: "turn" | "child" = "turn",
): string | undefined {
  if (certainty.kind === "settled") return undefined;
  if (certainty.kind === "uncertain")
    return `Octant stopped while ${ranBy === "child" ? "a child agent's tool" : "the tool"} "${certainty.toolName}" was running, so it may or may not have taken effect. Check it, then continue.`;
  return ranBy === "child"
    ? "Octant could not read which tool calls a child agent of this thread had started. Check it, then continue."
    : "Octant could not read which tool calls this turn had started. Check it, then continue.";
}
