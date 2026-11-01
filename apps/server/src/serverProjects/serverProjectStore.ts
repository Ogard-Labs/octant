import {
  AggregateId,
  AggregateVersion,
  CorrelationId,
  EventActor,
  EventId,
  EventName,
  UtcTimestamp,
  type EventActor as EventActorValue,
} from "@octant/contracts";
import { ProjectId } from "@octant/contracts/projects";
import {
  decodeServerProjectBoundPayload,
  decodeServerProjectRemovedPayload,
  decodeServerProjectRenamedPayload,
  MAX_SERVER_PROJECTS,
  SERVER_PROJECTS_AGGREGATE,
  SERVER_PROJECTS_AGGREGATE_ID,
  SERVER_PROJECTS_EVENT_NAMES,
  ServerFolderPath,
  type ServerProject,
  type ServerProjectsRefusalReason,
} from "@octant/contracts/server-projects";
import type { ShieldServer } from "@octant/contracts/shield-servers";
import { Schema } from "effect";
import type { Journal } from "../persistence/journal";
import type { ServerAddress, ServerConnection } from "./serverConnection";

/**
 * The Code Projects bound to a folder on a registered server, journaled and
 * rebuilt from the journal at startup. Canonical:
 * docs/design/server-projects.md § Binding.
 *
 * They are a catalog of their own, never the local Project catalog, so no
 * service that reads a local Project's folder is ever handed a server path.
 * Every change is journaled whole and journal first, and only a person at a
 * local window makes one.
 */

const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeEventName = Schema.decodeUnknownSync(EventName);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);
const decodeProjectId = Schema.decodeUnknownSync(ProjectId);
const decodeFolder = Schema.decodeUnknownOption(ServerFolderPath);

const REPLAY_BATCH = 500;
const FOLDER_CHECK_TIMEOUT_MS = 20_000;

export type ServerProjectPrincipal = "local-window" | "remote-device";

export type ServerProjectsChange =
  | { readonly kind: "changed"; readonly project?: ServerProject }
  | {
      readonly kind: "refused";
      readonly reason: ServerProjectsRefusalReason;
      readonly message?: string;
    };

/** Where a server Project's calls go, or why none can. */
export type ServerProjectAddress =
  | { readonly kind: "address"; readonly server: ServerAddress; readonly folder: string }
  | { readonly kind: "refused"; readonly reason: "project-not-found" | "server-not-registered" };

export interface ServerProjectStoreOptions {
  readonly journal: Pick<Journal, "append" | "replayAggregateType" | "aggregateVersions">;
  readonly personActor: EventActorValue;
  readonly uuid: () => string;
  readonly clock: () => string;
  /** The person's registered servers, read when they are needed. */
  readonly servers: () => ReadonlyArray<ShieldServer>;
  readonly connection: Pick<ServerConnection, "run">;
}

export class ServerProjectStore {
  readonly #options: ServerProjectStoreOptions;
  readonly #personActor: EventActorValue;
  readonly #projects = new Map<string, ServerProject>();
  #version = 0;

  constructor(options: ServerProjectStoreOptions) {
    this.#options = options;
    this.#personActor = decodeActor(options.personActor);
  }

  /** Rebuilds the catalog from the journal, in journal order. A record that no longer decodes changes nothing. */
  load(): void {
    this.#projects.clear();
    let after = 0;
    for (;;) {
      const batch = this.#options.journal.replayAggregateType({
        aggregateType: SERVER_PROJECTS_AGGREGATE,
        afterSequence: after,
        limit: REPLAY_BATCH,
      });
      for (const envelope of batch) {
        after = envelope.globalSequence;
        try {
          this.#apply(envelope.eventName, envelope.payload);
        } catch {
          // An unreadable record binds nothing; the catalog keeps what it had.
        }
      }
      if (batch.length < REPLAY_BATCH) break;
    }
    this.#version = 0;
    for (const { aggregateId, aggregateVersion } of this.#options.journal.aggregateVersions(
      SERVER_PROJECTS_AGGREGATE,
    )) {
      if (String(aggregateId) === SERVER_PROJECTS_AGGREGATE_ID) this.#version = aggregateVersion;
    }
  }

  projects(): ReadonlyArray<ServerProject> {
    return [...this.#projects.values()];
  }

  project(projectId: string): ServerProject | undefined {
    return this.#projects.get(projectId);
  }

  /** The server and folder a Project's calls go to, read from the registry now. */
  addressOf(projectId: string): ServerProjectAddress {
    const project = this.#projects.get(projectId);
    if (project === undefined) return { kind: "refused", reason: "project-not-found" };
    const server = this.#options
      .servers()
      .find((candidate) => String(candidate.serverId) === String(project.serverId));
    if (server === undefined) return { kind: "refused", reason: "server-not-registered" };
    return {
      kind: "address",
      server: { alias: server.alias, user: server.user },
      folder: project.folder,
    };
  }

  /**
   * Binds a Code Project to a folder on a registered server. The folder is
   * resolved on the server first, and only its real path is journaled; a
   * folder that cannot be reached or is not a folder binds nothing.
   */
  async bind(input: {
    readonly name: string;
    readonly serverId: string;
    readonly folder: string;
    readonly principal: ServerProjectPrincipal;
  }): Promise<ServerProjectsChange> {
    if (input.principal !== "local-window") return refused("needs-local-window");
    if (this.#projects.size >= MAX_SERVER_PROJECTS) return refused("too-many-projects");
    const server = this.#options
      .servers()
      .find((candidate) => String(candidate.serverId) === input.serverId);
    if (server === undefined) return refused("server-not-registered");
    const call = await this.#options.connection.run(
      { alias: server.alias, user: server.user },
      {
        script: `exec 2>/dev/null; cd -P -- "$1" || exit 2; pwd -P`,
        args: [input.folder],
        timeoutMs: FOLDER_CHECK_TIMEOUT_MS,
        maxOutputBytes: 4_096,
      },
    );
    if (call.status === "unreachable") {
      return refused("server-unreachable", `${server.alias} could not be reached: ${call.message}`);
    }
    if (call.status !== "ran") return refused("server-unreachable");
    if (call.exitCode !== 0) return refused("folder-not-found");
    const folder = decodeFolder(call.output.toString("utf8").replace(/\n$/, ""));
    if (folder._tag === "None") return refused("folder-not-found");
    const project: ServerProject = {
      id: decodeProjectId(this.#options.uuid()),
      name: input.name.trim(),
      serverId: server.serverId,
      folder: folder.value,
      boundAt: decodeTimestamp(this.#options.clock()),
    };
    const payload = { project, principal: { kind: "local-window" as const } };
    if (!this.#append(SERVER_PROJECTS_EVENT_NAMES.bound, payload)) return refused("unavailable");
    this.#apply(SERVER_PROJECTS_EVENT_NAMES.bound, payload);
    return { kind: "changed", project };
  }

  rename(input: {
    readonly projectId: string;
    readonly name: string;
    readonly principal: ServerProjectPrincipal;
  }): ServerProjectsChange {
    if (input.principal !== "local-window") return refused("needs-local-window");
    const existing = this.#projects.get(input.projectId);
    if (existing === undefined) return refused("project-not-found");
    const name = input.name.trim();
    if (name === existing.name) return { kind: "changed", project: existing };
    const payload = { projectId: existing.id, name, principal: { kind: "local-window" as const } };
    if (!this.#append(SERVER_PROJECTS_EVENT_NAMES.renamed, payload)) return refused("unavailable");
    this.#apply(SERVER_PROJECTS_EVENT_NAMES.renamed, payload);
    return { kind: "changed", project: this.#projects.get(input.projectId) ?? existing };
  }

  remove(input: {
    readonly projectId: string;
    readonly principal: ServerProjectPrincipal;
  }): ServerProjectsChange {
    if (input.principal !== "local-window") return refused("needs-local-window");
    const existing = this.#projects.get(input.projectId);
    if (existing === undefined) return refused("project-not-found");
    const payload = { projectId: existing.id, principal: { kind: "local-window" as const } };
    if (!this.#append(SERVER_PROJECTS_EVENT_NAMES.removed, payload)) return refused("unavailable");
    this.#apply(SERVER_PROJECTS_EVENT_NAMES.removed, payload);
    return { kind: "changed" };
  }

  #apply(eventName: string, payload: unknown): void {
    if (eventName === SERVER_PROJECTS_EVENT_NAMES.bound) {
      const { project } = decodeServerProjectBoundPayload(payload);
      this.#projects.set(String(project.id), project);
      return;
    }
    if (eventName === SERVER_PROJECTS_EVENT_NAMES.renamed) {
      const { projectId, name } = decodeServerProjectRenamedPayload(payload);
      const existing = this.#projects.get(String(projectId));
      if (existing !== undefined) this.#projects.set(String(projectId), { ...existing, name });
      return;
    }
    if (eventName === SERVER_PROJECTS_EVENT_NAMES.removed) {
      this.#projects.delete(String(decodeServerProjectRemovedPayload(payload).projectId));
    }
  }

  #append(eventName: string, payload: unknown): boolean {
    try {
      this.#options.journal.append({
        aggregate: {
          aggregateType: SERVER_PROJECTS_AGGREGATE,
          aggregateId: decodeAggregateId(SERVER_PROJECTS_AGGREGATE_ID),
        },
        expectedVersion: decodeAggregateVersion(this.#version),
        events: [
          {
            eventId: decodeEventId(this.#options.uuid()),
            eventName: decodeEventName(eventName),
            eventVersion: 1,
            correlationId: decodeCorrelationId(this.#options.uuid()),
            actor: this.#personActor,
            occurredAt: decodeTimestamp(this.#options.clock()),
            payload,
          },
        ],
      });
    } catch {
      return false;
    }
    this.#version += 1;
    return true;
  }
}

function refused(reason: ServerProjectsRefusalReason, message?: string): ServerProjectsChange {
  return message === undefined ? { kind: "refused", reason } : { kind: "refused", reason, message };
}
