import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import {
  AggregateId,
  AggregateVersion,
  EventActor,
  EventId,
  EventName,
  UtcTimestamp,
  type EventActor as EventActorValue,
} from "@octant/contracts";
import type { HostExportSshTarget } from "@octant/contracts/host-export";
import type { SshRemoteProject } from "@octant/contracts/ssh-remote-project";
import {
  SshAttestationFacts,
  type SshAttestation,
  type SshPinnedHostKey,
  type SshTarget,
  type SshTargetId,
  type SshTargetPostureAdmission,
} from "@octant/contracts/ssh-target";
import {
  SSH_REMOTE_PROJECT_AGGREGATE,
  SSH_REMOTE_PROJECT_EVENT_NAMES,
  SSH_TARGET_AGGREGATE,
  SSH_TARGET_EVENT_NAMES,
} from "@octant/contracts/ssh-target-events";
import { readAggregateVersion } from "../persistence/chatProjection";
import type { Journal } from "../persistence/journal";
import {
  ConcurrencyConflict,
  EventPayloadInvalid,
  JournalInputInvalid,
} from "../persistence/journalErrors";
import {
  readSshRemoteProject,
  readSshRemoteProjects,
  readSshTarget,
  readSshTargets,
} from "../persistence/sshTargetProjection";
import type { SqliteConnection } from "../persistence/sqlitePort";

/**
 * SSH targets, their pinned host keys and attestation results, and the Code
 * Projects bound to their folders, recorded in this host's journal.
 * Canonical: docs/design/remote-ssh-environments.md § Registering an SSH
 * target and § Data placement and lifecycle.
 *
 * The journal is the record. The one file outside it is each target's pin, an
 * owner-only known-hosts file under the data directory holding exactly the
 * journaled key for every name (`*`), because the SSH client reads keys only
 * from a file. It is written from the journal before every connection, so an
 * edited or stale file never decides which key a session trusts. Matching any
 * name lets the person's configuration resolve the destination (an alias,
 * another port, a jump host) without the pin depending on which name the
 * client looks up; the file never vouches for another target.
 *
 * Only a local window or the local CLI changes this store, through the
 * administration routes.
 */

const DIRECTORY = "ssh-targets";
const KNOWN_HOSTS_FILE = "known_hosts";
const MAX_APPEND_ATTEMPTS = 3;

const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeEventName = Schema.decodeUnknownSync(EventName);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);
const encodeFacts = Schema.encodeSync(SshAttestationFacts);

export interface SshTargetStoreOptions {
  readonly journal: Pick<Journal, "append">;
  readonly connection: SqliteConnection;
  /** Where the pin files live: `<dataDirectory>/ssh-targets/<target>/known_hosts`. */
  readonly dataDirectory: string;
  readonly uuid: () => string;
  readonly clock: () => string;
  readonly actor: EventActorValue;
}

/** Whether a change reached the journal. A refused one changed nothing. */
export type SshTargetStoreWrite = "recorded" | "refused";

/** SHA-256 of the facts as their schema encodes them, in this build's field order. */
export function sshAttestationFactsDigest(facts: SshAttestation["facts"]): string {
  return createHash("sha256")
    .update(JSON.stringify(encodeFacts(facts)))
    .digest("hex");
}

export class SshTargetStore {
  readonly #journal: Pick<Journal, "append">;
  readonly #connection: SqliteConnection;
  readonly #root: string;
  readonly #uuid: () => string;
  readonly #clock: () => string;
  readonly #actor: EventActorValue;

  constructor(options: SshTargetStoreOptions) {
    this.#journal = options.journal;
    this.#connection = options.connection;
    this.#root = join(options.dataDirectory, DIRECTORY);
    this.#uuid = options.uuid;
    this.#clock = options.clock;
    this.#actor = decodeActor(options.actor);
  }

  list(): ReadonlyArray<SshTarget> {
    return readSshTargets(this.#connection).map((record) => record.target);
  }

  get(id: SshTargetId): SshTarget | undefined {
    return readSshTarget(this.#connection, String(id))?.target;
  }

  knownHostsFile(id: SshTargetId): string {
    return join(this.#root, String(id), KNOWN_HOSTS_FILE);
  }

  /** Writes the target's pin file from its journaled key, owner-only. */
  writePin(target: SshTarget): string {
    const directory = join(this.#root, String(target.id));
    mkdirSync(this.#root, { recursive: true, mode: 0o700 });
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = this.knownHostsFile(target.id);
    writeOwnerOnly(path, `* ${target.hostKey.algorithm} ${target.hostKey.publicKey}\n`);
    return path;
  }

  /** A private scratch directory for one host-key probe, removed by the caller. */
  probeDirectory(name: string): string {
    const directory = join(this.#root, ".probes", name);
    mkdirSync(join(this.#root, ".probes"), { recursive: true, mode: 0o700 });
    mkdirSync(directory, { mode: 0o700 });
    return directory;
  }

  register(target: SshTarget): SshTargetStoreWrite {
    return this.#append(
      SSH_TARGET_AGGREGATE,
      String(target.id),
      SSH_TARGET_EVENT_NAMES.registered,
      {
        target,
      },
    );
  }

  repin(targetId: SshTargetId, hostKey: SshPinnedHostKey): SshTargetStoreWrite {
    return this.#append(SSH_TARGET_AGGREGATE, String(targetId), SSH_TARGET_EVENT_NAMES.repinned, {
      targetId,
      hostKey,
    });
  }

  /**
   * Journals one connection's attestation: a digest of the facts its executor
   * reported, and what this host decided from them for each confined posture.
   */
  recordAttestation(
    targetId: SshTargetId,
    attestation: SshAttestation,
    admission: ReadonlyArray<SshTargetPostureAdmission>,
  ): SshTargetStoreWrite {
    return this.#append(SSH_TARGET_AGGREGATE, String(targetId), SSH_TARGET_EVENT_NAMES.attested, {
      targetId,
      connectionId: attestation.connectionId,
      factsDigest: sshAttestationFactsDigest(attestation.facts),
      admission,
    });
  }

  /** Removes the registration and its pin. Bound Projects stay, and refuse new work. */
  remove(targetId: SshTargetId): SshTargetStoreWrite {
    const removed = this.#append(
      SSH_TARGET_AGGREGATE,
      String(targetId),
      SSH_TARGET_EVENT_NAMES.removed,
      { targetId },
    );
    if (removed === "recorded") {
      rmSync(join(this.#root, String(targetId)), { recursive: true, force: true });
    }
    return removed;
  }

  listProjects(): ReadonlyArray<SshRemoteProject> {
    return readSshRemoteProjects(this.#connection);
  }

  getProject(projectId: string): SshRemoteProject | undefined {
    return readSshRemoteProject(this.#connection, projectId);
  }

  bindProject(project: SshRemoteProject): SshTargetStoreWrite {
    return this.#append(
      SSH_REMOTE_PROJECT_AGGREGATE,
      String(project.id),
      SSH_REMOTE_PROJECT_EVENT_NAMES.bound,
      { project },
      { expectNew: true },
    );
  }

  /**
   * Each target as the host export carries it: when it was registered, the
   * Projects bound to it, and its last attestation's digest and decisions.
   * The destination, host key, and executor path are left behind here.
   */
  exportTargets(): ReadonlyArray<HostExportSshTarget> {
    const projects = this.listProjects();
    return readSshTargets(this.#connection).map((record) => ({
      targetId: record.target.id,
      registeredAt: decodeTimestamp(record.registeredAt),
      projectIds: projects
        .filter((project) => String(project.targetId) === String(record.target.id))
        .map((project) => project.id),
      ...(record.lastAttestation === undefined
        ? {}
        : {
            lastAttestation: {
              attestedAt: decodeTimestamp(record.lastAttestation.attestedAt),
              factsDigest: record.lastAttestation.attested.factsDigest,
              admission: record.lastAttestation.attested.admission,
            },
          }),
    }));
  }

  #append(
    aggregateType: string,
    id: string,
    eventName: string,
    payload: unknown,
    options: { readonly expectNew?: boolean } = {},
  ): SshTargetStoreWrite {
    const aggregateId = decodeAggregateId(id);
    for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt += 1) {
      const expectedVersion = decodeAggregateVersion(
        readAggregateVersion(this.#connection, aggregateType, aggregateId),
      );
      // A bound Project is never re-bound: a second binding under one id
      // would be a change of kind or target, which the design forbids.
      if (options.expectNew === true && expectedVersion > 0) return "refused";
      try {
        const eventId = decodeEventId(this.#uuid());
        this.#journal.append({
          aggregate: { aggregateType, aggregateId },
          expectedVersion,
          events: [
            {
              eventId,
              eventName: decodeEventName(eventName),
              eventVersion: 1,
              correlationId: eventId,
              actor: this.#actor,
              occurredAt: decodeTimestamp(this.#clock()),
              payload,
            },
          ],
        });
        return "recorded";
      } catch (error) {
        if (error instanceof ConcurrencyConflict) continue;
        if (error instanceof JournalInputInvalid || error instanceof EventPayloadInvalid) {
          return "refused";
        }
        throw error;
      }
    }
    return "refused";
  }
}

function writeOwnerOnly(path: string, content: string): void {
  const staging = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(staging, content, { mode: 0o600 });
  // The mode applies only when the file is created, so a staging file left by
  // a crashed write is narrowed here too.
  chmodSync(staging, 0o600);
  renameSync(staging, path);
}
