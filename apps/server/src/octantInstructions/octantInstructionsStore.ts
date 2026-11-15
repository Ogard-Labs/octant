import {
  AggregateId,
  AggregateVersion,
  CorrelationId,
  EventId,
  decodeProjectId,
  type EventActor,
} from "@octant/contracts";
import {
  ORCHESTRATION_INSTRUCTIONS_AGGREGATE_TYPE,
  ORCHESTRATION_INSTRUCTIONS_CHANGED,
  OrchestrationInstructionsChanged,
  PERSON_INSTRUCTIONS_AGGREGATE_TYPE,
  PERSON_INSTRUCTIONS_CHANGED,
  PROJECT_INSTRUCTIONS_AGGREGATE_TYPE,
  PROJECT_INSTRUCTIONS_CHANGED,
  PersonInstructionsChanged,
  ProjectInstructionsChanged,
  decodeOrchestrationInstructionsChanged,
  decodePersonInstructionsChanged,
  decodeProjectInstructionsChanged,
  type OctantInstructionsCommand,
  type OctantInstructionsRefusalReason,
  type OctantInstructionsResult,
  type OctantInstructionsView,
  type ProjectInstructionsView,
} from "@octant/contracts/octant-instructions";
import {
  orchestrationInstructionsBlockText,
  personInstructionsBlockText,
  projectInstructionsBlockText,
} from "@octant/domain/octant-instructions-policy";
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
/** The one orchestration record on this host. */
const ORCHESTRATION_INSTRUCTIONS_AGGREGATE_ID = "00000000-0000-4000-8000-0000000000e3";

/**
 * The key every copy of the person's instructions carries, so a session that
 * holds an earlier copy is sent an edit once, appended as a revision, rather
 * than having its whole standing context restated.
 */
export const PERSON_INSTRUCTIONS_CONTEXT_KEY = "octant-person-instructions";
export const ORCHESTRATION_INSTRUCTIONS_CONTEXT_KEY = "octant-orchestration-instructions";

/** A Project's key names the Project, so moving between Projects is a withdrawal, not a revision. */
export function projectInstructionsContextKey(projectId: string): string {
  return `octant-project-instructions:${projectId}`;
}

type JournalPort = Pick<Journal, "append" | "replayAggregateType">;

/**
 * One of the person's texts as a turn receives it. Its kind is also its
 * context category, so the inspector names it the same way in every mode.
 */
export interface OctantInstructionsBlock {
  readonly kind: "person-instructions" | "project-instructions" | "orchestration-instructions";
  readonly key: string;
  readonly text: string;
}

export function registerOctantInstructionsEvents(registry: EventRegistry): EventRegistry {
  return registry
    .register(PERSON_INSTRUCTIONS_CHANGED, 1, PersonInstructionsChanged)
    .register(ORCHESTRATION_INSTRUCTIONS_CHANGED, 1, OrchestrationInstructionsChanged)
    .register(PROJECT_INSTRUCTIONS_CHANGED, 1, ProjectInstructionsChanged);
}

/** Who asks for a change, as the route resolved it from the authenticated principal. */
export interface OctantInstructionsAuthor {
  /** What the change is journaled as. */
  readonly actor: EventActor;
  /**
   * Whether the principal acts as the host's own person: a window on this host
   * or a device that person paired. A device a hub roster admitted journals as
   * `remote-device` too, so the actor alone cannot tell the two apart.
   */
  readonly actsAsHostPerson: boolean;
}

/**
 * Only the host's own person writes these texts. A turn's agent, a routine,
 * and the host itself journal as `agent` or `system`, and none of them may
 * change what the person wrote; no tool writes them either. The store checks
 * this itself rather than relying on every caller to keep a hub-paired device
 * out first.
 */
function actsAsPerson(author: OctantInstructionsAuthor): boolean {
  const kind = author.actor.kind;
  return (
    author.actsAsHostPerson &&
    (kind === "local-user" || kind === "remote-device" || kind === "owner-unlock")
  );
}

const REFUSAL_MESSAGES: Record<OctantInstructionsRefusalReason, string> = {
  malformed: "That change is not valid.",
  "stale-version": "Your instructions changed since you opened them. Reload and try again.",
  "not-the-person": "Only you can change your instructions, from a window or a device you paired.",
  "project-not-found": "That Project is no longer on this host.",
};

export function refusedOctantInstructions(
  reason: OctantInstructionsRefusalReason,
): OctantInstructionsResult {
  return { kind: "octant-instructions-refused", reason, message: REFUSAL_MESSAGES[reason] };
}

/** One journaled record: its whole current text and the version it is at. */
interface InstructionsRecord {
  instructions: string;
  version: number;
}

type InstructionsEvent =
  | { readonly kind: "person"; readonly instructions: string }
  | { readonly kind: "orchestration"; readonly instructions: string }
  | { readonly kind: "project"; readonly projectId: string; readonly instructions: string };

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
  readonly #projectExists: (projectId: string) => boolean;
  readonly #person: InstructionsRecord = { instructions: "", version: 0 };
  readonly #orchestration: InstructionsRecord = { instructions: "", version: 0 };
  readonly #projects = new Map<string, InstructionsRecord>();

  constructor(options: {
    readonly journal: JournalPort;
    readonly uuid: () => string;
    readonly clock: () => string;
    /** Whether the Project is on this host; a change for any other is refused. */
    readonly projectExists?: (projectId: string) => boolean;
  }) {
    this.#journal = options.journal;
    this.#uuid = options.uuid;
    this.#clock = options.clock;
    this.#projectExists = options.projectExists ?? (() => true);
    this.#hydrate();
  }

  view(canChange: boolean): OctantInstructionsView {
    return {
      kind: "octant-instructions",
      instructions: this.#person.instructions,
      orchestration: this.#orchestration.instructions,
      version: this.#person.version,
      orchestrationVersion: this.#orchestration.version,
      canChange,
    };
  }

  /** One Project's instructions, or a refusal when the Project is not on this host. */
  projectView(projectId: string, canChange: boolean): OctantInstructionsResult {
    if (!this.#projectExists(projectId)) return refusedOctantInstructions("project-not-found");
    return this.#projectViewOf(projectId, canChange);
  }

  change(
    command: OctantInstructionsCommand,
    author: OctantInstructionsAuthor,
  ): OctantInstructionsResult {
    if (command.kind === "read-project-instructions") {
      return this.projectView(String(command.projectId), actsAsPerson(author));
    }
    if (!actsAsPerson(author)) return refusedOctantInstructions("not-the-person");
    const actor = author.actor;
    if (command.kind === "change-person-instructions") {
      if (command.expectedVersion !== this.#person.version) {
        return refusedOctantInstructions("stale-version");
      }
      const payload = decodePersonInstructionsChanged({ instructions: command.instructions });
      this.#append(
        PERSON_INSTRUCTIONS_AGGREGATE_TYPE,
        PERSON_INSTRUCTIONS_AGGREGATE_ID,
        this.#person,
        PERSON_INSTRUCTIONS_CHANGED,
        payload,
        actor,
      );
      this.#person.instructions = payload.instructions;
      return this.view(true);
    }
    if (command.kind === "change-orchestration-instructions") {
      if (command.expectedVersion !== this.#orchestration.version) {
        return refusedOctantInstructions("stale-version");
      }
      const payload = decodeOrchestrationInstructionsChanged({
        orchestration: command.orchestration,
      });
      this.#append(
        ORCHESTRATION_INSTRUCTIONS_AGGREGATE_TYPE,
        ORCHESTRATION_INSTRUCTIONS_AGGREGATE_ID,
        this.#orchestration,
        ORCHESTRATION_INSTRUCTIONS_CHANGED,
        payload,
        actor,
      );
      this.#orchestration.instructions = payload.orchestration;
      return this.view(true);
    }
    const projectId = String(command.projectId);
    if (!this.#projectExists(projectId)) return refusedOctantInstructions("project-not-found");
    const record = this.#project(projectId);
    if (command.expectedVersion !== record.version) {
      return refusedOctantInstructions("stale-version");
    }
    const payload = decodeProjectInstructionsChanged({
      projectId: command.projectId,
      instructions: command.instructions,
    });
    this.#append(
      PROJECT_INSTRUCTIONS_AGGREGATE_TYPE,
      projectId,
      record,
      PROJECT_INSTRUCTIONS_CHANGED,
      payload,
      actor,
    );
    record.instructions = payload.instructions;
    return this.#projectViewOf(projectId, true);
  }

  /**
   * Drops a Project's instructions after a Project-scoped purge erased their
   * journal, so turns stop receiving them at once rather than at restart.
   */
  forgetProject(projectId: string): void {
    this.#projects.delete(projectId);
  }

  /** Each Project's instructions that are not empty, for Export my data. */
  projectInstructions(): ReadonlyArray<{
    readonly projectId: string;
    readonly instructions: string;
  }> {
    return [...this.#projects]
      .filter(([, record]) => record.instructions.length > 0)
      .map(([projectId, record]) => ({ projectId, instructions: record.instructions }));
  }

  /**
   * The standing blocks a turn receives, in their order: the person's own
   * instructions, then its Project's, then orchestration for a thread that
   * reads as a coordinator (its Project's designated planner included). Every
   * turn gets them, including the turns Octant starts itself, because they
   * are the rules the person wrote for all work here.
   */
  contextBlocks(
    scope: {
      readonly projectId?: string | undefined;
      readonly orchestrates?: boolean;
    } = {},
  ): ReadonlyArray<OctantInstructionsBlock> {
    const blocks: OctantInstructionsBlock[] = [];
    const person = personInstructionsBlockText(this.#person.instructions);
    if (person !== undefined) {
      blocks.push({
        kind: "person-instructions",
        key: PERSON_INSTRUCTIONS_CONTEXT_KEY,
        text: person,
      });
    }
    const project =
      scope.projectId === undefined
        ? undefined
        : projectInstructionsBlockText(this.#projects.get(scope.projectId)?.instructions ?? "");
    if (project !== undefined && scope.projectId !== undefined) {
      blocks.push({
        kind: "project-instructions",
        key: projectInstructionsContextKey(scope.projectId),
        text: project,
      });
    }
    const orchestration =
      scope.orchestrates === true
        ? orchestrationInstructionsBlockText(this.#orchestration.instructions)
        : undefined;
    if (orchestration !== undefined) {
      blocks.push({
        kind: "orchestration-instructions",
        key: ORCHESTRATION_INSTRUCTIONS_CONTEXT_KEY,
        text: orchestration,
      });
    }
    return blocks;
  }

  #projectViewOf(projectId: string, canChange: boolean): ProjectInstructionsView {
    const record = this.#projects.get(projectId);
    return {
      kind: "project-instructions",
      projectId: decodeProjectId(projectId),
      instructions: record?.instructions ?? "",
      version: record?.version ?? 0,
      canChange,
    };
  }

  #project(projectId: string): InstructionsRecord {
    const existing = this.#projects.get(projectId);
    if (existing !== undefined) return existing;
    const created: InstructionsRecord = { instructions: "", version: 0 };
    this.#projects.set(projectId, created);
    return created;
  }

  #append(
    aggregateType: string,
    aggregateId: string,
    record: InstructionsRecord,
    eventName: string,
    payload: unknown,
    actor: EventActor,
  ): void {
    this.#journal.append({
      aggregate: { aggregateType, aggregateId: decodeAggregateId(aggregateId) },
      expectedVersion: decodeAggregateVersion(record.version),
      events: [
        {
          eventId: decodeEventId(this.#uuid()),
          eventName,
          eventVersion: 1,
          correlationId: decodeCorrelationId(this.#uuid()),
          actor,
          occurredAt: this.#clock(),
          payload,
        },
      ],
    });
    record.version += 1;
  }

  #hydrate(): void {
    for (const envelope of replayAggregateTypesInOrder(this.#journal, [
      PERSON_INSTRUCTIONS_AGGREGATE_TYPE,
      ORCHESTRATION_INSTRUCTIONS_AGGREGATE_TYPE,
      PROJECT_INSTRUCTIONS_AGGREGATE_TYPE,
    ])) {
      const event = decodeEvent(envelope.eventName, envelope.payload);
      if (event === undefined) continue;
      const record =
        event.kind === "person"
          ? this.#person
          : event.kind === "orchestration"
            ? this.#orchestration
            : this.#project(event.projectId);
      record.version = envelope.aggregateVersion;
      record.instructions = event.instructions;
    }
  }
}

function decodeEvent(eventName: string, payload: unknown): InstructionsEvent | undefined {
  if (eventName === PERSON_INSTRUCTIONS_CHANGED) {
    return { kind: "person", instructions: decodePersonInstructionsChanged(payload).instructions };
  }
  if (eventName === ORCHESTRATION_INSTRUCTIONS_CHANGED) {
    return {
      kind: "orchestration",
      instructions: decodeOrchestrationInstructionsChanged(payload).orchestration,
    };
  }
  if (eventName === PROJECT_INSTRUCTIONS_CHANGED) {
    const decoded = decodeProjectInstructionsChanged(payload);
    return {
      kind: "project",
      projectId: String(decoded.projectId),
      instructions: decoded.instructions,
    };
  }
  return undefined;
}
