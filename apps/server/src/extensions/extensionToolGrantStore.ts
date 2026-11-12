import {
  AggregateId,
  AggregateVersion,
  EventActor,
  EventId,
  EventName,
  UtcTimestamp,
  type EventActor as EventActorValue,
} from "@octant/contracts";
import {
  EXTENSION_TOOL_GRANT_AGGREGATE,
  EXTENSION_TOOL_GRANT_EVENT_NAMES,
  decodeExtensionToolGrantRecorded,
  decodeExtensionToolGrantRevoked,
  type ExtensionToolGrantRevocationReason,
} from "@octant/contracts/extension-events";
import type { ExtensionToolGrant } from "@octant/contracts/extension-rpc";
import { extensionToolGrantRevocationReason } from "@octant/domain/extension-tool-grant-policy";
import { Schema } from "effect";
import { readAggregateVersion } from "../persistence/chatProjection";
import { readExtensionRecord } from "../persistence/extensionProjection";
import {
  extensionToolGrantAggregateId,
  extensionToolGrantId,
  readActiveExtensionToolGrants,
  readExtensionToolGrant,
  type ExtensionToolGrantSubject,
  type ProjectedExtensionToolGrant,
} from "../persistence/extensionToolGrantProjection";
import type { Journal } from "../persistence/journal";
import {
  ConcurrencyConflict,
  EventPayloadInvalid,
  JournalInputInvalid,
} from "../persistence/journalErrors";
import type { SqliteConnection } from "../persistence/sqlitePort";

const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeEventName = Schema.decodeUnknownSync(EventName);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

const MAX_APPEND_ATTEMPTS = 3;

export interface ExtensionToolGrantStoreOptions {
  readonly journal: Pick<Journal, "append">;
  readonly connection: SqliteConnection;
  readonly uuid: () => string;
  readonly clock: () => string;
  readonly actor: EventActorValue;
}

/**
 * The journal side of remembered MCP tool approvals. It writes what it is
 * told and decides nothing: who may record a grant is settled by the approval
 * prompt before `record` is reached, and whether a stored grant covers a call
 * is `decideExtensionToolGrant`. It does report a grant as revoked once the
 * package's lifecycle has committed an uninstall, rollback, or trust
 * withdrawal after the grant was journaled, so a host that stopped before
 * appending the revocation cannot leave the grant standing for a later install.
 */
export class ExtensionToolGrantStore {
  readonly #journal: Pick<Journal, "append">;
  readonly #connection: SqliteConnection;
  readonly #approvalsEnded = new Map<string, number>();
  readonly #uuid: () => string;
  readonly #clock: () => string;
  readonly #actor: EventActorValue;

  constructor(options: ExtensionToolGrantStoreOptions) {
    this.#journal = options.journal;
    this.#connection = options.connection;
    this.#uuid = options.uuid;
    this.#clock = options.clock;
    this.#actor = decodeActor(options.actor);
  }

  /** The stored grant for a tool or a whole server, revoked or not. */
  read(subject: ExtensionToolGrantSubject): ProjectedExtensionToolGrant | undefined {
    const grant = readExtensionToolGrant(this.#connection, extensionToolGrantId(subject));
    return grant === undefined ? undefined : this.#standing(grant);
  }

  /** Every grant a call could still use, across Projects and the account. */
  list(): ReadonlyArray<ExtensionToolGrant> {
    return readActiveExtensionToolGrants(this.#connection)
      .map((grant) => this.#standing(grant))
      .filter((grant) => grant.revocationReason === undefined)
      .map(
        ({ revocationReason: _revocationReason, lastSequence: _lastSequence, ...grant }) => grant,
      );
  }

  /**
   * Journals a grant. One for a whole server carries neither a tool name nor
   * a listing digest; the payload schema refuses one without the other.
   */
  record(
    grant: ExtensionToolGrantSubject & {
      readonly version: string;
      readonly digest: string;
      readonly definitionDigest?: string | undefined;
    },
  ): "recorded" | "refused" {
    let payload: ReturnType<typeof decodeExtensionToolGrantRecorded>;
    try {
      payload = decodeExtensionToolGrantRecorded({
        grantId: extensionToolGrantId(grant),
        ...(grant.projectId === undefined ? {} : { projectId: grant.projectId }),
        extensionId: grant.extensionId,
        packageId: grant.packageId,
        componentId: grant.componentId,
        ...(grant.mcpToolName === undefined ? {} : { mcpToolName: grant.mcpToolName }),
        version: grant.version,
        digest: grant.digest,
        ...(grant.definitionDigest === undefined
          ? {}
          : { definitionDigest: grant.definitionDigest }),
      });
    } catch {
      return "refused";
    }
    return this.#append(payload.projectId, [
      { eventName: EXTENSION_TOOL_GRANT_EVENT_NAMES.recorded, payload },
    ])
      ? "recorded"
      : "refused";
  }

  /** A person takes one grant away. */
  revoke(grantId: string): "revoked" | "not-found" {
    const stored = readExtensionToolGrant(this.#connection, grantId);
    const grant = stored === undefined ? undefined : this.#standing(stored);
    if (grant === undefined || grant.revocationReason !== undefined) return "not-found";
    return this.#revoke([grant], "person") > 0 ? "revoked" : "not-found";
  }

  /**
   * Ends every grant of one extension's tools and servers, in every Project
   * and for the account, and reports how many it ended. Called when the package is uninstalled, rolled back, or
   * loses its trust.
   */
  revokeExtension(
    extensionId: string,
    reason: Exclude<ExtensionToolGrantRevocationReason, "person">,
  ): number {
    this.#approvalsEnded.set(extensionId, this.approvalsEnded(extensionId) + 1);
    return this.#revoke(readActiveExtensionToolGrants(this.#connection, extensionId), reason);
  }

  /**
   * How many times this host has ended every approval of one extension. An
   * answer that is held in memory rather than as a grant is bound to this
   * count, so trusting or installing the same version again cannot revive it.
   */
  approvalsEnded(extensionId: string): number {
    return this.#approvalsEnded.get(extensionId) ?? 0;
  }

  /**
   * Ends the grants a package lifecycle command makes void, and reports how
   * many. Uninstall, rollback, and withdrawn trust do; every other command
   * leaves grants stored, so re-enabling a plugin needs no new answer.
   */
  revokeForLifecycleChange(change: {
    readonly kind: string;
    readonly extensionId?: string;
    readonly trusted?: boolean;
  }): number {
    const reason = extensionToolGrantRevocationReason(change);
    if (reason === undefined || change.extensionId === undefined) return 0;
    return this.revokeExtension(change.extensionId, reason);
  }

  /**
   * A grant journaled before its extension's latest uninstall, rollback, or
   * trust withdrawal is revoked for that reason, though its own revocation may
   * never have been appended: the lifecycle commit and the revocation are two
   * journal appends, and the host can stop between them. Without this, the
   * same package installed again would find an approval nobody gave it.
   */
  #standing(grant: ProjectedExtensionToolGrant): ProjectedExtensionToolGrant {
    if (grant.revocationReason !== undefined) return grant;
    const ended = readExtensionRecord(this.#connection, grant.extensionId)?.grantsEnded;
    return ended !== undefined && grant.lastSequence < ended.sequence
      ? { ...grant, revocationReason: ended.reason }
      : grant;
  }

  #revoke(
    grants: ReadonlyArray<ProjectedExtensionToolGrant>,
    reason: ExtensionToolGrantRevocationReason,
  ): number {
    const byProject = new Map<string | undefined, Array<ProjectedExtensionToolGrant>>();
    for (const grant of grants) {
      const projectId = grant.projectId === undefined ? undefined : String(grant.projectId);
      byProject.set(projectId, [...(byProject.get(projectId) ?? []), grant]);
    }
    let revoked = 0;
    for (const [projectId, projectGrants] of byProject) {
      const appended = this.#append(
        projectId,
        projectGrants.map((grant) => ({
          eventName: EXTENSION_TOOL_GRANT_EVENT_NAMES.revoked,
          payload: decodeExtensionToolGrantRevoked({
            grantId: grant.grantId,
            ...(grant.projectId === undefined ? {} : { projectId: grant.projectId }),
            reason,
          }),
        })),
      );
      if (appended) revoked += projectGrants.length;
    }
    return revoked;
  }

  /**
   * One append per Project, or for the account when there is none; a
   * concurrent writer to the same aggregate is retried.
   */
  #append(
    projectId: string | undefined,
    events: ReadonlyArray<{ readonly eventName: string; readonly payload: unknown }>,
  ): boolean {
    const aggregateId = decodeAggregateId(extensionToolGrantAggregateId(projectId));
    for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt += 1) {
      const expectedVersion = decodeAggregateVersion(
        readAggregateVersion(this.#connection, EXTENSION_TOOL_GRANT_AGGREGATE, aggregateId),
      );
      try {
        this.#journal.append({
          aggregate: { aggregateType: EXTENSION_TOOL_GRANT_AGGREGATE, aggregateId },
          expectedVersion,
          events: events.map((event) => {
            const eventId = decodeEventId(this.#uuid());
            return {
              eventId,
              eventName: decodeEventName(event.eventName),
              eventVersion: 1,
              correlationId: eventId,
              actor: this.#actor,
              occurredAt: decodeTimestamp(this.#clock()),
              payload: event.payload,
            };
          }),
        });
        return true;
      } catch (error) {
        if (error instanceof ConcurrencyConflict) continue;
        if (error instanceof JournalInputInvalid || error instanceof EventPayloadInvalid) {
          return false;
        }
        throw error;
      }
    }
    return false;
  }
}
