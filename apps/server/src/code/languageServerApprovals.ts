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
  CODE_LANGUAGE_SERVER_APPROVAL_AGGREGATE,
  CODE_LANGUAGE_SERVER_EVENT_NAMES,
  decodeCodeLanguageServerApprovalGranted,
  type CodeLanguageApprovalScope,
  type CodeLanguageServerApprovalGranted,
} from "@octant/contracts/code-language";
import { Schema } from "effect";
import type { Journal } from "../persistence/journal";

/**
 * The shell-command approvals a person gave `repo-tooling` language servers.
 * Canonical: docs/design/language-services.md § Repository tooling.
 *
 * An approval covers one server, named by the reviewed package state it was
 * given for, in one checkout or in every checkout of one Code Project. It is
 * journal-first: an approval whose event is not appended is not in force. It
 * decides nothing about who may approve; the language service settles that
 * before it records one. Nothing here revokes: an approval names its
 * package's lifecycle version, so any later change to the package (an update,
 * a switch, trust given or withdrawn, an uninstall) leaves it covering a
 * state that no longer exists, and the server asks again.
 */

const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeEventName = Schema.decodeUnknownSync(EventName);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

const REPLAY_BATCH = 1_000;

export interface LanguageServerApprovalSubject {
  readonly projectId: ProjectId;
  readonly checkoutId: CodeCheckoutId;
  /** The component's reviewed package state: `CodeLanguageServerComponent.approvalKey`. */
  readonly component: string;
}

export interface LanguageServerApprovalStoreOptions {
  readonly journal: Pick<Journal, "append" | "replayAggregateType">;
  /** Speaks for the person at a local window, the only one who approves. */
  readonly personActor: EventActorValue;
  readonly uuid: () => string;
  readonly clock: () => string;
}

export class LanguageServerApprovalStore {
  readonly #journal: LanguageServerApprovalStoreOptions["journal"];
  readonly #personActor: EventActorValue;
  readonly #uuid: () => string;
  readonly #clock: () => string;
  /** Each Project's approvals and its aggregate's version, rebuilt from the journal. */
  readonly #projects = new Map<
    string,
    { version: number; readonly approvals: Array<CodeLanguageServerApprovalGranted> }
  >();

  constructor(options: LanguageServerApprovalStoreOptions) {
    this.#journal = options.journal;
    this.#personActor = decodeActor(options.personActor);
    this.#uuid = options.uuid;
    this.#clock = options.clock;
    this.#replay();
  }

  /** Whether an approval on record covers this server in this checkout. */
  holds(subject: LanguageServerApprovalSubject): boolean {
    const approvals = this.#projects.get(String(subject.projectId))?.approvals ?? [];
    return approvals.some(
      (approval) =>
        approval.component === subject.component &&
        (approval.scope.kind === "project" ||
          String(approval.scope.checkoutId) === String(subject.checkoutId)),
    );
  }

  /** Journals an approval; it is in force only once appended. */
  record(
    subject: LanguageServerApprovalSubject & { readonly scope: CodeLanguageApprovalScope },
  ): "recorded" | "not-recorded" {
    const projectKey = String(subject.projectId);
    const held = this.#projects.get(projectKey);
    let payload: CodeLanguageServerApprovalGranted;
    try {
      payload = decodeCodeLanguageServerApprovalGranted({
        approvalId: this.#uuid(),
        projectId: subject.projectId,
        approvalClass: "shell-commands",
        component: subject.component,
        scope:
          subject.scope === "project"
            ? { kind: "project" }
            : { kind: "checkout", checkoutId: subject.checkoutId },
      });
      this.#journal.append({
        aggregate: {
          aggregateType: CODE_LANGUAGE_SERVER_APPROVAL_AGGREGATE,
          aggregateId: decodeAggregateId(projectKey),
        },
        expectedVersion: decodeAggregateVersion(held?.version ?? 0),
        events: [
          {
            eventId: decodeEventId(this.#uuid()),
            eventName: decodeEventName(CODE_LANGUAGE_SERVER_EVENT_NAMES.approvalGranted),
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
   * Rebuilds every Project's approvals. A record that no longer decodes
   * approves nothing, and still counts toward its aggregate's version so the
   * next append lands after it.
   */
  #replay(): void {
    let afterSequence = 0;
    for (;;) {
      const batch = this.#journal.replayAggregateType({
        aggregateType: CODE_LANGUAGE_SERVER_APPROVAL_AGGREGATE,
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
        if (envelope.eventName === CODE_LANGUAGE_SERVER_EVENT_NAMES.approvalGranted) {
          try {
            project.approvals.push(decodeCodeLanguageServerApprovalGranted(envelope.payload));
          } catch {
            // Unreadable: it approves nothing.
          }
        }
        this.#projects.set(String(envelope.aggregateId), project);
      }
      if (batch.length < REPLAY_BATCH) return;
    }
  }
}
