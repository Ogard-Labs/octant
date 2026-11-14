import {
  AggregateId,
  AggregateVersion,
  CorrelationId,
  EventId,
  type EventActor,
} from "@octant/contracts";
import {
  PERSON_INSTRUCTIONS_AGGREGATE_TYPE,
  PERSON_INSTRUCTIONS_CHANGED,
  PROJECT_INSTRUCTIONS_CHANGED,
  PersonInstructionsChanged,
  ProjectInstructionsChanged,
  decodePersonInstructionsChanged,
  type OctantInstructionsCommand,
  type OctantInstructionsRefusalReason,
  type OctantInstructionsResult,
  type OctantInstructionsView,
} from "@octant/contracts/octant-instructions";
import { personInstructionsBlockText } from "@octant/domain/octant-instructions-policy";
import { Schema } from "effect";
import type { EventRegistry } from "../persistence/eventRegistry";
import type { Journal } from "../persistence/journal";
import { replayAggregateTypesInOrder } from "../persistence/journalHydration";

const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);

/** The one person record on this host. */
const PERSON_INSTRUCTIONS_AGGREGATE_ID = "00000000-0000-4000-8000-0000000000e2";

/**
 * The key every copy of the person's instructions carries, so a session that
 * holds an earlier copy is sent an edit once, appended as a revision, rather
 * than having its whole standing context restated.
 */
export const PERSON_INSTRUCTIONS_CONTEXT_KEY = "octant-person-instructions";

type JournalPort = Pick<Journal, "append" | "replayAggregateType">;

/**
 * One of the person's texts as a turn receives it. Its kind is also its
 * context category, so the inspector names it the same way in every mode.
 */
export interface OctantInstructionsBlock {
  readonly kind: "person-instructions";
  readonly key: string;
  readonly text: string;
}

export function registerOctantInstructionsEvents(registry: EventRegistry): EventRegistry {
  return registry
    .register(PERSON_INSTRUCTIONS_CHANGED, 1, PersonInstructionsChanged)
    .register(PROJECT_INSTRUCTIONS_CHANGED, 1, ProjectInstructionsChanged);
}

/**
 * Only the person writes these texts. A turn's agent, a routine, and the host
 * itself journal as `agent` or `system`, and none of them may change what the
 * person wrote; no tool writes them either.
 */
function actsAsPerson(actor: EventActor): boolean {
  return (
    actor.kind === "local-user" || actor.kind === "remote-device" || actor.kind === "owner-unlock"
  );
}

const REFUSAL_MESSAGES: Record<OctantInstructionsRefusalReason, string> = {
  malformed: "That change is not valid.",
  "stale-version": "Your instructions changed since you opened them. Reload and try again.",
  "not-the-person": "Only you can change your instructions, from a window or a device you paired.",
};

export function refusedOctantInstructions(
  reason: OctantInstructionsRefusalReason,
): OctantInstructionsResult {
  return { kind: "octant-instructions-refused", reason, message: REFUSAL_MESSAGES[reason] };
}

/**
 * The instructions the person wrote for Octant, rebuilt from the journal at
 * start and kept on this host only: no hub or spoke receives them, and no
 * thread carries them. Every change journals the whole new text under the
 * record's expected version, so a stale editor is refused, never merged.
 */
export class OctantInstructionsStore {
  readonly #journal: JournalPort;
  readonly #uuid: () => string;
  readonly #clock: () => string;
  #instructions = "";
  #version = 0;

  constructor(options: {
    readonly journal: JournalPort;
    readonly uuid: () => string;
    readonly clock: () => string;
  }) {
    this.#journal = options.journal;
    this.#uuid = options.uuid;
    this.#clock = options.clock;
    this.#hydrate();
  }

  view(canChange: boolean): OctantInstructionsView {
    return {
      kind: "octant-instructions",
      instructions: this.#instructions,
      version: this.#version,
      canChange,
    };
  }

  change(command: OctantInstructionsCommand, actor: EventActor): OctantInstructionsResult {
    if (!actsAsPerson(actor)) return refusedOctantInstructions("not-the-person");
    if (command.expectedVersion !== this.#version) {
      return refusedOctantInstructions("stale-version");
    }
    const payload = decodePersonInstructionsChanged({ instructions: command.instructions });
    this.#journal.append({
      aggregate: {
        aggregateType: PERSON_INSTRUCTIONS_AGGREGATE_TYPE,
        aggregateId: decodeAggregateId(PERSON_INSTRUCTIONS_AGGREGATE_ID),
      },
      expectedVersion: decodeAggregateVersion(this.#version),
      events: [
        {
          eventId: decodeEventId(this.#uuid()),
          eventName: PERSON_INSTRUCTIONS_CHANGED,
          eventVersion: 1,
          correlationId: decodeCorrelationId(this.#uuid()),
          actor,
          occurredAt: this.#clock(),
          payload,
        },
      ],
    });
    this.#version += 1;
    this.#instructions = payload.instructions;
    return this.view(true);
  }

  /**
   * The standing blocks a turn receives, in their order: the person's own
   * instructions. Every turn gets them, including the turns Octant starts
   * itself, because they are the rules the person wrote for all work here.
   */
  contextBlocks(): ReadonlyArray<OctantInstructionsBlock> {
    const text = personInstructionsBlockText(this.#instructions);
    return text === undefined
      ? []
      : [{ kind: "person-instructions", key: PERSON_INSTRUCTIONS_CONTEXT_KEY, text }];
  }

  #hydrate(): void {
    for (const envelope of replayAggregateTypesInOrder(this.#journal, [
      PERSON_INSTRUCTIONS_AGGREGATE_TYPE,
    ])) {
      if (envelope.eventName !== PERSON_INSTRUCTIONS_CHANGED) continue;
      this.#version = envelope.aggregateVersion;
      this.#instructions = decodePersonInstructionsChanged(envelope.payload).instructions;
    }
  }
}
