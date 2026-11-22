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
  decodeServerProjectActionsReplacedPayload,
  decodeServerProjectActionsReplacedPayloadV2,
  decodeServerProjectBoundPayload,
  decodeServerProjectBoundPayloadV2,
  decodeServerProjectRemovedPayload,
  decodeServerProjectRemovedPayloadV2,
  decodeServerProjectRenamedPayload,
  decodeServerProjectRenamedPayloadV2,
  decodeServerWorkDeveloperToolsChangedPayload,
  decodeServerWorkDeveloperToolsChangedPayloadV2,
  MAX_SERVER_PROJECTS,
  SERVER_PROJECTS_AGGREGATE,
  SERVER_PROJECTS_AGGREGATE_ID,
  SERVER_PROJECTS_EVENT_NAMES,
  SERVER_PROJECTS_EVENT_NAMES_V2,
  SERVER_PROJECTS_PORT_FORWARD_CLOSED,
  SERVER_PROJECTS_PORT_FORWARD_OPENED,
  SERVER_PROJECTS_PREVIEW_OUTCOME_V1,
  decodeServerPortForwardClosedPayload,
  decodeServerPortForwardOpenedPayload,
  ServerFolderPath,
  type ServerPortForwardCloseReason,
  type ServerPortForwardOpenedPayload,
  type ServerProject,
  type ServerProjectsRefusalReason,
} from "@octant/contracts/server-projects";
import type { ProjectAction } from "@octant/contracts/projects";
import type { ShieldServer } from "@octant/contracts/shield-servers";
import { Schema } from "effect";
import type { Journal } from "../persistence/journal";
import {
  SSH_KEY_CONFIRMATION_MESSAGE,
  sshNeedsHostKeyConfirmation,
  type ServerAddress,
  type ServerConnection,
} from "./serverConnection";

/**
 * The Code and Work Projects bound to a folder on a registered server, journaled and
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

export type ServerProjectPrincipal =
  | "local-window"
  | "remote-device"
  | "agent"
  | "routine"
  | {
      readonly kind: "person-paired-device";
      readonly credentialGeneration: number;
      readonly actor: EventActorValue;
    };

type AdmittedServerProjectPrincipal =
  | {
      readonly version: 1;
      readonly payloadPrincipal: { readonly kind: "local-window" };
      readonly actor: EventActorValue;
    }
  | {
      readonly version: 2;
      readonly payloadPrincipal: {
        readonly kind: "person-paired-device";
        readonly credentialGeneration: number;
      };
      readonly actor: EventActorValue;
    };

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
  readonly journal: Pick<Journal, "append" | "replayAggregateType" | "aggregateVersions"> &
    Partial<Pick<Journal, "transaction">>;
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
  // Ids the person removed, so a routine still naming one can say why it
  // stopped instead of reading as a Project nobody knows.
  readonly #removed = new Set<string>();
  // Port forwards the journal shows opened and not yet closed, by Project.
  readonly #openForwards = new Map<string, ServerPortForwardOpenedPayload>();
  #version = 0;

  constructor(options: ServerProjectStoreOptions) {
    this.#options = options;
    this.#personActor = decodeActor(options.personActor);
  }

  /** Rebuilds the catalog from the journal, in journal order. A record that no longer decodes changes nothing. */
  load(): void {
    this.#projects.clear();
    this.#removed.clear();
    this.#openForwards.clear();
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

  /** Whether the person removed a server Project with this id. */
  wasRemoved(projectId: string): boolean {
    return this.#removed.has(projectId);
  }

  /** A server Project whose threads are Code threads; a Work one is not. */
  codeProject(projectId: string): ServerProject | undefined {
    const project = this.#projects.get(projectId);
    return project === undefined || project.mode === "work" ? undefined : project;
  }

  /** A server Project whose threads are Work threads. */
  workProject(projectId: string): ServerProject | undefined {
    const project = this.#projects.get(projectId);
    return project?.mode === "work" ? project : undefined;
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

  /** The registered record a Project's server has now, whose profile caps Shield there. */
  serverOf(projectId: string): ShieldServer | undefined {
    const project = this.#projects.get(projectId);
    if (project === undefined) return undefined;
    return this.#options
      .servers()
      .find((candidate) => String(candidate.serverId) === String(project.serverId));
  }

  /**
   * Binds a Code or Work Project to a folder on a registered server. The folder is
   * resolved on the server first, and only its real path is journaled; a
   * folder that cannot be reached or is not a folder binds nothing.
   */
  async bind(input: {
    readonly name: string;
    readonly serverId: string;
    readonly folder: string;
    /** `work` for a Work Project; absent binds a Code Project. */
    readonly mode?: "work" | undefined;
    readonly principal: ServerProjectPrincipal;
    readonly signal?: AbortSignal;
  }): Promise<ServerProjectsChange> {
    const admitted = this.#admit(input.principal);
    if (admitted === undefined) return refused("needs-person");
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
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
    );
    if (call.status === "unreachable") {
      if (admitted.version === 2 && sshNeedsHostKeyConfirmation(call.errorOutput ?? call.message)) {
        return refused("server-unreachable", SSH_KEY_CONFIRMATION_MESSAGE);
      }
      return refused("server-unreachable", `${server.alias} could not be reached: ${call.message}`);
    }
    if (call.status !== "ran") return refused("server-unreachable");
    if (call.exitCode !== 0) return refused("folder-not-found");
    const folder = decodeFolder(call.output.toString("utf8").replace(/\n$/, ""));
    if (folder._tag === "None") return refused("folder-not-found");
    // A Project folder is a folder inside the server, never all of it: the
    // file tools judge every path as inside or outside it.
    if (folder.value === "/") {
      return refused("folder-not-found", "Choose a folder inside the server, not its root.");
    }
    // The check above waited on the server, so the limit and the registry are
    // read again: another bind may have filled the catalog, or the server may
    // have been removed or pointed at another host, in the meantime.
    if (this.#projects.size >= MAX_SERVER_PROJECTS) return refused("too-many-projects");
    if (
      !this.#options
        .servers()
        .some(
          (candidate) =>
            String(candidate.serverId) === String(server.serverId) &&
            candidate.alias === server.alias &&
            candidate.user === server.user,
        )
    ) {
      return refused("server-not-registered");
    }
    const project: ServerProject = {
      id: decodeProjectId(this.#options.uuid()),
      name: input.name.trim(),
      serverId: server.serverId,
      folder: folder.value,
      boundAt: decodeTimestamp(this.#options.clock()),
      ...(input.mode === "work" ? { mode: "work" as const } : {}),
    };
    const eventName =
      admitted.version === 2
        ? SERVER_PROJECTS_EVENT_NAMES_V2.bound
        : SERVER_PROJECTS_EVENT_NAMES.bound;
    const payload = { project, principal: admitted.payloadPrincipal };
    if (!this.#append(eventName, payload, admitted.actor)) return refused("unavailable");
    this.#apply(eventName, payload);
    return { kind: "changed", project };
  }

  rename(input: {
    readonly projectId: string;
    readonly name: string;
    readonly principal: ServerProjectPrincipal;
  }): ServerProjectsChange {
    const admitted = this.#admit(input.principal);
    if (admitted === undefined) return refused("needs-person");
    const existing = this.#projects.get(input.projectId);
    if (existing === undefined) return refused("project-not-found");
    const name = input.name.trim();
    if (name === existing.name) return { kind: "changed", project: existing };
    const eventName =
      admitted.version === 2
        ? SERVER_PROJECTS_EVENT_NAMES_V2.renamed
        : SERVER_PROJECTS_EVENT_NAMES.renamed;
    const payload = { projectId: existing.id, name, principal: admitted.payloadPrincipal };
    if (!this.#append(eventName, payload, admitted.actor)) return refused("unavailable");
    this.#apply(eventName, payload);
    return { kind: "changed", project: this.#projects.get(input.projectId) ?? existing };
  }

  remove(input: {
    readonly projectId: string;
    readonly principal: ServerProjectPrincipal;
    /**
     * Appends companion events inside the same journal transaction as
     * `server-projects.removed@1`, returning a callback to publish their
     * in-memory state only after the transaction commits. Any failure rolls
     * back both companion appends and catalog removal together.
     */
    readonly withinTransaction?: (project: ServerProject) => () => void;
  }): ServerProjectsChange {
    const admitted = this.#admit(input.principal);
    if (admitted === undefined) return refused("needs-person");
    const existing = this.#projects.get(input.projectId);
    if (existing === undefined) return refused("project-not-found");
    const eventName =
      admitted.version === 2
        ? SERVER_PROJECTS_EVENT_NAMES_V2.removed
        : SERVER_PROJECTS_EVENT_NAMES.removed;
    const payload = { projectId: existing.id, principal: admitted.payloadPrincipal };
    let publishCompanion: (() => void) | undefined;
    const run = (): void => {
      if (input.withinTransaction !== undefined) {
        publishCompanion = input.withinTransaction(existing);
      }
      this.#appendRaw(eventName, payload, admitted.actor);
    };
    try {
      if (this.#options.journal.transaction !== undefined) {
        this.#options.journal.transaction(run);
      } else {
        run();
      }
    } catch {
      return refused("unavailable");
    }
    this.#version += 1;
    this.#apply(eventName, payload);
    publishCompanion?.();
    return { kind: "changed" };
  }

  setActions(input: {
    readonly projectId: string;
    readonly actions: ReadonlyArray<ProjectAction>;
    readonly expectedVersion: number;
    readonly principal: ServerProjectPrincipal;
  }): ServerProjectsChange {
    const admitted = this.#admit(input.principal);
    if (admitted === undefined) return refused("needs-person");
    const project = this.#projects.get(input.projectId);
    if (project === undefined) return refused("project-not-found");
    if (input.expectedVersion !== (project.actionsVersion ?? 0)) return refused("actions-changed");
    if (input.actions.some((action) => action.preparesWorktrees === true))
      return refused(
        "unavailable",
        "Server actions cannot be automatic worktree preparation recipes.",
      );
    if (JSON.stringify(input.actions) === JSON.stringify(project.actions ?? []))
      return { kind: "changed", project };
    const eventName =
      admitted.version === 2
        ? SERVER_PROJECTS_EVENT_NAMES_V2.actionsReplaced
        : SERVER_PROJECTS_EVENT_NAMES.actionsReplaced;
    const payload = {
      projectId: project.id,
      actions: input.actions,
      actionsVersion: decodeAggregateVersion((project.actionsVersion ?? 0) + 1),
      principal: admitted.payloadPrincipal,
    };
    if (!this.#append(eventName, payload, admitted.actor)) return refused("unavailable");
    this.#apply(eventName, payload);
    return {
      kind: "changed",
      project: { ...project, actions: payload.actions, actionsVersion: payload.actionsVersion },
    };
  }

  recordPreview(
    payload: import("./serverPreviewTunnel").ServerPreviewView & { readonly owner: string },
    principal?: {
      readonly kind: "person-paired-device";
      readonly credentialGeneration: number;
      readonly actor: EventActorValue;
    },
  ): boolean {
    if (principal !== undefined) {
      return this.#append(
        SERVER_PROJECTS_EVENT_NAMES_V2.previewOutcome,
        {
          ...payload,
          principal: {
            kind: "person-paired-device",
            credentialGeneration: principal.credentialGeneration,
          },
        },
        principal.actor,
      );
    }
    return this.#append(SERVER_PROJECTS_PREVIEW_OUTCOME_V1, payload, this.#personActor);
  }

  /**
   * A port forward's opening or closing, journaled as the person at a local
   * window with the Project and the ports alone.
   */
  recordForward(
    record:
      | ({ readonly event: "opened" } & ServerPortForwardOpenedPayload)
      | ({
          readonly event: "closed";
          readonly reason: ServerPortForwardCloseReason;
        } & ServerPortForwardOpenedPayload),
  ): boolean {
    const opened = {
      projectId: record.projectId,
      remotePort: record.remotePort,
      localPort: record.localPort,
    };
    const [eventName, payload] =
      record.event === "opened"
        ? [SERVER_PROJECTS_PORT_FORWARD_OPENED, opened]
        : [SERVER_PROJECTS_PORT_FORWARD_CLOSED, { ...opened, reason: record.reason }];
    if (!this.#append(eventName, payload, this.#personActor)) return false;
    this.#apply(eventName, payload);
    return true;
  }

  /**
   * Forwards live only in the host's memory, so one the journal still shows
   * open was left by a run that stopped without closing it. A starting host
   * records each closed, so the journal never shows a forward nothing serves.
   */
  closeForwardsLeftOpen(): void {
    for (const opened of this.#openForwards.values()) {
      this.recordForward({ event: "closed", ...opened, reason: "host-stopped" });
    }
  }

  setDeveloperTools(input: {
    readonly projectId: string;
    readonly enabled: boolean;
    readonly principal: ServerProjectPrincipal;
  }): ServerProjectsChange {
    const admitted = this.#admit(input.principal);
    if (admitted === undefined) return refused("needs-person");
    const project = this.#projects.get(input.projectId);
    if (project?.mode !== "work") return refused("project-not-found");
    if ((project.developerTools?.enabled ?? false) === input.enabled)
      return { kind: "changed", project };
    const eventName =
      admitted.version === 2
        ? SERVER_PROJECTS_EVENT_NAMES_V2.developerToolsChanged
        : SERVER_PROJECTS_EVENT_NAMES.developerToolsChanged;
    const payload = {
      projectId: project.id,
      developerTools: {
        enabled: input.enabled,
        changedBy: admitted.actor,
        changedAt: decodeTimestamp(this.#options.clock()),
      },
      principal: admitted.payloadPrincipal,
    };
    if (!this.#append(eventName, payload, admitted.actor)) return refused("unavailable");
    this.#apply(eventName, payload);
    return { kind: "changed", project: { ...project, developerTools: payload.developerTools } };
  }

  #admit(principal: ServerProjectPrincipal): AdmittedServerProjectPrincipal | undefined {
    if (principal === "local-window") {
      return {
        version: 1,
        payloadPrincipal: { kind: "local-window" },
        actor: this.#personActor,
      };
    }
    if (typeof principal === "object" && principal.kind === "person-paired-device") {
      return {
        version: 2,
        payloadPrincipal: {
          kind: "person-paired-device",
          credentialGeneration: principal.credentialGeneration,
        },
        actor: decodeActor(principal.actor),
      };
    }
    return undefined;
  }

  #apply(eventName: string, payload: unknown): void {
    if (eventName === SERVER_PROJECTS_PORT_FORWARD_OPENED) {
      const opened = decodeServerPortForwardOpenedPayload(payload);
      this.#openForwards.set(opened.projectId, opened);
      return;
    }
    if (eventName === SERVER_PROJECTS_PORT_FORWARD_CLOSED) {
      this.#openForwards.delete(decodeServerPortForwardClosedPayload(payload).projectId);
      return;
    }
    if (
      eventName === SERVER_PROJECTS_EVENT_NAMES.developerToolsChanged ||
      eventName === SERVER_PROJECTS_EVENT_NAMES_V2.developerToolsChanged
    ) {
      const change =
        eventName === SERVER_PROJECTS_EVENT_NAMES_V2.developerToolsChanged
          ? decodeServerWorkDeveloperToolsChangedPayloadV2(payload)
          : decodeServerWorkDeveloperToolsChangedPayload(payload);
      const project = this.#projects.get(String(change.projectId));
      if (project?.mode === "work")
        this.#projects.set(String(project.id), {
          ...project,
          developerTools: change.developerTools,
        });
      return;
    }
    if (
      eventName === SERVER_PROJECTS_EVENT_NAMES.actionsReplaced ||
      eventName === SERVER_PROJECTS_EVENT_NAMES_V2.actionsReplaced
    ) {
      const replacement =
        eventName === SERVER_PROJECTS_EVENT_NAMES_V2.actionsReplaced
          ? decodeServerProjectActionsReplacedPayloadV2(payload)
          : decodeServerProjectActionsReplacedPayload(payload);
      const project = this.#projects.get(String(replacement.projectId));
      if (project !== undefined)
        this.#projects.set(String(project.id), {
          ...project,
          actions: replacement.actions,
          actionsVersion: replacement.actionsVersion,
        });
      return;
    }
    if (
      eventName === SERVER_PROJECTS_EVENT_NAMES.bound ||
      eventName === SERVER_PROJECTS_EVENT_NAMES_V2.bound
    ) {
      const { project } =
        eventName === SERVER_PROJECTS_EVENT_NAMES_V2.bound
          ? decodeServerProjectBoundPayloadV2(payload)
          : decodeServerProjectBoundPayload(payload);
      this.#projects.set(String(project.id), project);
      return;
    }
    if (
      eventName === SERVER_PROJECTS_EVENT_NAMES.renamed ||
      eventName === SERVER_PROJECTS_EVENT_NAMES_V2.renamed
    ) {
      const { projectId, name } =
        eventName === SERVER_PROJECTS_EVENT_NAMES_V2.renamed
          ? decodeServerProjectRenamedPayloadV2(payload)
          : decodeServerProjectRenamedPayload(payload);
      const existing = this.#projects.get(String(projectId));
      if (existing !== undefined) this.#projects.set(String(projectId), { ...existing, name });
      return;
    }
    if (
      eventName === SERVER_PROJECTS_EVENT_NAMES.removed ||
      eventName === SERVER_PROJECTS_EVENT_NAMES_V2.removed
    ) {
      const projectId = String(
        (eventName === SERVER_PROJECTS_EVENT_NAMES_V2.removed
          ? decodeServerProjectRemovedPayloadV2(payload)
          : decodeServerProjectRemovedPayload(payload)
        ).projectId,
      );
      this.#projects.delete(projectId);
      this.#removed.add(projectId);
    }
  }

  #append(eventName: string, payload: unknown, actor: EventActorValue): boolean {
    try {
      this.#appendRaw(eventName, payload, actor);
    } catch {
      return false;
    }
    this.#version += 1;
    return true;
  }

  #appendRaw(eventName: string, payload: unknown, actor: EventActorValue): void {
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
          actor,
          occurredAt: decodeTimestamp(this.#options.clock()),
          payload,
        },
      ],
    });
  }
}

function refused(reason: ServerProjectsRefusalReason, message?: string): ServerProjectsChange {
  return message === undefined ? { kind: "refused", reason } : { kind: "refused", reason, message };
}
