import {
  AggregateId,
  AggregateVersion,
  CorrelationId,
  EventActor,
  EventId,
  EventName,
  UtcTimestamp,
  type CodeCheckoutId,
  type EventActor as EventActorValue,
  type ProjectId,
} from "@octant/contracts";
import {
  CODE_DEBUG_CONFIGURATION_AGGREGATE,
  CODE_DEBUG_EVENT_NAMES,
  decodeCodeDebugConfigurationApproved,
  type CodeDebugApprovalScope,
  type CodeDebugConfiguration,
  type CodeDebugConfigurationApproved,
  type CodeDebugConfigurationDigest,
} from "@octant/contracts/code-debug";
import type { DebugAdapterPackageState } from "@octant/domain";
import { Schema } from "effect";
import type { Journal } from "../persistence/journal";

/**
 * The debug configurations a person confirmed. Canonical:
 * docs/design/language-services.md § Approval and starting.
 *
 * A confirmation is the shell-command approval for one configuration digest
 * and one adapter package state, in one checkout or every checkout of one
 * Code Project. It is journal-first: one whose event is not appended is not
 * in force, and a restarted host rebuilds them from the journal. It decides
 * nothing about who may confirm; the debug service settles that before it
 * records one. Nothing here revokes: a confirmation names the package's
 * lifecycle version, so any later change to the adapter's package leaves it
 * covering a state that no longer exists, and an edited configuration has
 * another digest.
 */

const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeEventName = Schema.decodeUnknownSync(EventName);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

const REPLAY_BATCH = 1_000;

export interface DebugConfigurationApprovalStoreOptions {
  readonly journal: Pick<Journal, "append" | "replayAggregateType">;
  /** Speaks for the person at a local window, the only one who confirms. */
  readonly personActor: EventActorValue;
  readonly uuid: () => string;
  readonly clock: () => string;
}

export class DebugConfigurationApprovalStore {
  readonly #journal: DebugConfigurationApprovalStoreOptions["journal"];
  readonly #personActor: EventActorValue;
  readonly #uuid: () => string;
  readonly #clock: () => string;
  readonly #projects = new Map<
    string,
    { version: number; readonly approvals: Array<CodeDebugConfigurationApproved> }
  >();

  constructor(options: DebugConfigurationApprovalStoreOptions) {
    this.#journal = options.journal;
    this.#personActor = decodeActor(options.personActor);
    this.#uuid = options.uuid;
    this.#clock = options.clock;
    this.#replay();
  }

  /** Every confirmation the Project holds, newest last. */
  approvals(projectId: ProjectId): ReadonlyArray<CodeDebugConfigurationApproved> {
    return this.#projects.get(String(projectId))?.approvals ?? [];
  }

  /** Journals a confirmation; it is in force only once appended. */
  record(input: {
    readonly projectId: ProjectId;
    readonly checkoutId: CodeCheckoutId;
    readonly configuration: CodeDebugConfiguration;
    readonly configurationDigest: CodeDebugConfigurationDigest;
    readonly adapter: DebugAdapterPackageState;
    readonly scope: CodeDebugApprovalScope;
  }): "recorded" | "not-recorded" {
    const projectKey = String(input.projectId);
    const held = this.#projects.get(projectKey);
    let payload: CodeDebugConfigurationApproved;
    try {
      payload = decodeCodeDebugConfigurationApproved({
        approvalId: this.#uuid(),
        projectId: input.projectId,
        approvalClass: "shell-commands",
        configurationDigest: input.configurationDigest,
        configuration: input.configuration,
        adapter: input.adapter,
        scope:
          input.scope === "project"
            ? { kind: "project" }
            : { kind: "checkout", checkoutId: input.checkoutId },
      });
      this.#journal.append({
        aggregate: {
          aggregateType: CODE_DEBUG_CONFIGURATION_AGGREGATE,
          aggregateId: decodeAggregateId(projectKey),
        },
        expectedVersion: decodeAggregateVersion(held?.version ?? 0),
        events: [
          {
            eventId: decodeEventId(this.#uuid()),
            eventName: decodeEventName(CODE_DEBUG_EVENT_NAMES.configurationApproved),
            eventVersion: 1,
            correlationId: decodeCorrelationId(this.#uuid()),
            actor: this.#personActor,
            occurredAt: decodeTimestamp(this.#clock()),
            payload,
          },
        ],
      });
    } catch {
      return "not-recorded";
    }
    const project = held ?? { version: 0, approvals: [] };
    project.version += 1;
    project.approvals.push(payload);
    this.#projects.set(projectKey, project);
    return "recorded";
  }

  /**
   * A Project erase removed this Project's confirmations from the journal
   * while the Project lives on; they stop being in force now, and its next
   * confirmation is appended to the emptied aggregate.
   */
  forgetProject(projectId: ProjectId): void {
    this.#projects.delete(String(projectId));
  }

  /** A record that no longer decodes confirms nothing, and still counts toward the version. */
  #replay(): void {
    let afterSequence = 0;
    for (;;) {
      const batch = this.#journal.replayAggregateType({
        aggregateType: CODE_DEBUG_CONFIGURATION_AGGREGATE,
        afterSequence,
        limit: REPLAY_BATCH,
      });
      for (const envelope of batch) {
        afterSequence = envelope.globalSequence;
        const project = this.#projects.get(String(envelope.aggregateId)) ?? {
          version: 0,
          approvals: [],
        };
        project.version = envelope.aggregateVersion;
        if (envelope.eventName === CODE_DEBUG_EVENT_NAMES.configurationApproved) {
          try {
            project.approvals.push(decodeCodeDebugConfigurationApproved(envelope.payload));
          } catch {
            // Unreadable: it confirms nothing.
          }
        }
        this.#projects.set(String(envelope.aggregateId), project);
      }
      if (batch.length < REPLAY_BATCH) return;
    }
  }
}
