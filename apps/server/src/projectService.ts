import {
  ActorId,
  AggregateVersion,
  BindingRevisionId,
  CorrelationId,
  EventId,
  UtcTimestamp,
  decodeMemoryCommand,
  decodeMemoryCommandResult,
  decodeProjectBootstrap,
  decodeProjectCommand,
  decodeProjectCommandResult,
  decodeProjectFailure,
  decodeProjectId,
  decodeProjectMemoryView,
  type ActiveMemoryEntry,
  type BoundProject,
  type ConnectedGitHubRepository,
  type MemoryCommandResult,
  type MemoryEntry,
  type Project,
  type ProjectBootstrap,
  type ProjectCommandResult,
  type ProjectFailure,
  type ProjectId,
  type ProjectMemoryView,
  type ProjectSummary,
  type ProjectType,
  type WindowId,
} from "@octant/contracts";
import {
  ProjectPolicyRejected,
  MemoryPolicyRejected,
  changeProjectLifecycle,
  changeCodeProjectAccess,
  changeCodeProjectNewThreadWorkspace,
  changeCodeProjectPullRequestBackgroundRefresh,
  createMemoryEntry,
  createProject,
  defaultShellSettings,
  enabledModes,
  moveProject,
  rankBetween,
  retractMemoryEntry,
  relinkProject,
  renameProject,
  supersedeMemoryEntry,
  transferMemoryEntry,
} from "@octant/domain";
import { Schema } from "effect";
import { BindingReceiptError, type BindingReceiptStorePort } from "./bindingReceiptStore";
import { ConcurrencyConflict, JournalWriteFailed } from "./persistence/journalErrors";
import type { PersistenceService } from "./persistence/persistenceService";
import { ProjectionApplicationFailed } from "./persistence/projection";
import type { ProjectRootPort } from "./projectRootPort";
import { OCTANT_LOCAL_ACTOR_ID } from "./shellService";

const decodeActorId = Schema.decodeUnknownSync(ActorId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeBindingRevisionId = Schema.decodeUnknownSync(BindingRevisionId);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

export interface ProjectServiceApi {
  readonly bootstrap: (authenticatedWindowId: WindowId) => Promise<ProjectBootstrap>;
  readonly search: (query: string) => Promise<ReadonlyArray<ProjectSummary>>;
  readonly executeProject: (
    authenticatedWindowId: WindowId,
    command: unknown,
  ) => Promise<ProjectCommandResult>;
  readonly memory: (projectId: unknown) => Promise<ProjectMemoryView>;
  readonly executeMemory: (command: unknown) => Promise<MemoryCommandResult>;
}

export interface ProjectServiceOptions {
  readonly persistence: PersistenceService;
  readonly bindingReceiptStore: Pick<BindingReceiptStorePort, "consume">;
  readonly projectRootPort: Pick<ProjectRootPort, "validate">;
  readonly uuid: () => string;
  readonly clock: () => string;
  readonly now?: () => number;
  /** Server-owned, credential-free GitHub identity observation for Code Projects. */
  readonly observeCodeProjectRepository?: (
    canonicalRoot: string,
  ) => Promise<ConnectedGitHubRepository | undefined>;
}

export class ProjectServiceError extends Error {
  override readonly name = "ProjectServiceError";
  constructor(readonly failure: ProjectFailure) {
    super(failure.message);
  }
}

export class ProjectService implements ProjectServiceApi {
  readonly #persistence: PersistenceService;
  readonly #receipts: Pick<BindingReceiptStorePort, "consume">;
  readonly #roots: Pick<ProjectRootPort, "validate">;
  readonly #uuid: () => string;
  readonly #clock: () => string;
  readonly #now: () => number;
  readonly #observeCodeProjectRepository:
    | ((canonicalRoot: string) => Promise<ConnectedGitHubRepository | undefined>)
    | undefined;
  readonly #archiveListeners = new Set<
    (project: Extract<Project, { readonly type: "work" }>) => void
  >();

  constructor(options: ProjectServiceOptions) {
    this.#persistence = options.persistence;
    this.#receipts = options.bindingReceiptStore;
    this.#roots = options.projectRootPort;
    this.#uuid = options.uuid;
    this.#clock = options.clock;
    this.#now = options.now ?? Date.now;
    this.#observeCodeProjectRepository = options.observeCodeProjectRepository;
  }

  hasActiveProject(projectId: ProjectId, requiredType: ProjectType): boolean {
    try {
      const project = this.#persistence.readProject(projectId);
      return project?.lifecycle === "active" && project.type === requiredType;
    } catch {
      return false;
    }
  }

  /**
   * Registers a server-internal observer for a Work Project archive. The
   * Project transition has already committed when observers run, so they may
   * reconcile dependent, rebuildable projections without granting renderer
   * authority or mutating the Project transition itself.
   */
  onWorkProjectArchived(
    listener: (project: Extract<Project, { readonly type: "work" }>) => void,
  ): () => void {
    this.#archiveListeners.add(listener);
    return () => this.#archiveListeners.delete(listener);
  }

  async bootstrap(_authenticatedWindowId: WindowId): Promise<ProjectBootstrap> {
    this.#assertReady();
    try {
      const projects = this.#persistence.readProjects();
      const availability = await Promise.all(
        projects
          .filter((project): project is BoundProject => project.type !== "chat")
          .map(async (project) => {
            const observedAt = decodeTimestamp(this.#clock());
            try {
              const binding = await this.#roots.validate(
                project.type,
                project.binding.canonicalRoot,
              );
              if (binding.canonicalRoot !== project.binding.canonicalRoot)
                throw new Error("changed");
              return { projectId: project.id, status: "available" as const, observedAt };
            } catch {
              return {
                projectId: project.id,
                status: "unavailable" as const,
                reason: "Relink required.",
                observedAt,
              };
            }
          }),
      );
      const summaries = await Promise.all(
        projects.map(async (project) => {
          const summary = toSummary(project);
          if (
            project.type !== "code" ||
            project.lifecycle !== "active" ||
            this.#observeCodeProjectRepository === undefined
          ) {
            return summary;
          }
          try {
            const connectedRepository = await this.#observeCodeProjectRepository(
              project.binding.canonicalRoot,
            );
            return connectedRepository === undefined
              ? summary
              : { ...summary, connectedRepository };
          } catch {
            // Repository observation is optional and read-only. A failed or
            // ambiguous remote must not make an otherwise usable Project fail.
            return summary;
          }
        }),
      );
      return decodeProjectBootstrap({
        active: summaries.filter((project) => project.lifecycle === "active"),
        archived: summaries.filter((project) => project.lifecycle === "archived"),
        availability,
        memory: projects.map((project) => this.#persistence.readProjectMemory(project.id)),
      });
    } catch (error) {
      if (error instanceof ProjectServiceError) throw error;
      throw this.#unavailable();
    }
  }

  async search(query: string): Promise<ReadonlyArray<ProjectSummary>> {
    this.#assertReady();
    try {
      return this.#persistence.searchProjects(query.trim().toLowerCase()).map(toSummary);
    } catch {
      throw this.#unavailable();
    }
  }

  async memory(input: unknown): Promise<ProjectMemoryView> {
    let projectId: ProjectId;
    try {
      projectId = decodeProjectId(input);
    } catch {
      throw new ProjectServiceError({ category: "invalid", message: "Project ID is invalid." });
    }
    this.#assertReady();
    try {
      if (this.#persistence.readProject(projectId) === undefined) {
        throw new ProjectServiceError({
          category: "not-found",
          message: "Project was not found.",
        });
      }
      return decodeProjectMemoryView(this.#persistence.readProjectMemory(projectId));
    } catch (error) {
      throw this.#mapFailure(error);
    }
  }

  async executeMemory(input: unknown): Promise<MemoryCommandResult> {
    let command: ReturnType<typeof decodeMemoryCommand>;
    try {
      command = decodeMemoryCommand(input);
    } catch {
      throw new ProjectServiceError({
        category: "invalid",
        message: "Memory command is invalid.",
      });
    }
    this.#assertReady();
    try {
      const destinationProjectId =
        command.kind === "transfer-memory-entry" ? command.destinationProjectId : command.projectId;
      const destination = this.#persistence.readProject(destinationProjectId);
      if (destination === undefined) {
        throw new ProjectServiceError({
          category: "not-found",
          message: "Project was not found.",
        });
      }
      this.#assertModeEnabled(destination.type);
      if (destination.lifecycle !== "active") {
        throw new ProjectServiceError({
          category: "invalid",
          message: "Archived Projects are read-only.",
        });
      }
      const destinationMemory = this.#persistence.readProjectMemory(destinationProjectId);
      this.#assertMemoryExpectedVersion(destinationMemory, command.expectedVersion);
      const timestamp = decodeTimestamp(this.#clock());
      const actor = { kind: "local-user" as const, actorId: OCTANT_LOCAL_ACTOR_ID };
      let result: MemoryCommandResult;
      let eventName: string;
      let payload: unknown;
      let resultEntryId;

      if (command.kind === "create-memory-entry") {
        this.#assertNewMemoryEntryId(destinationProjectId, command.entryId);
        const entry = createMemoryEntry({
          id: command.entryId,
          projectId: command.projectId,
          kind: command.memoryKind,
          content: command.content,
          actor,
          createdAt: timestamp,
          expectedVersion: command.expectedVersion,
        });
        result = { kind: "memory-entry-created", entry };
        eventName = "memory.entry-created@1";
        payload = { entry };
        resultEntryId = entry.id;
      } else if (command.kind === "supersede-memory-entry") {
        const previous = this.#requireMemoryEntry(command.projectId, command.entryId);
        this.#assertNewMemoryEntryId(command.projectId, command.successorEntryId);
        const changed = supersedeMemoryEntry(previous, {
          successorEntryId: command.successorEntryId,
          content: command.content,
          actor,
          supersededAt: timestamp,
          expectedVersion: command.expectedVersion,
        });
        result = { kind: "memory-entry-superseded", ...changed };
        eventName = "memory.entry-superseded@1";
        payload = changed;
        resultEntryId = changed.entry.id;
      } else if (command.kind === "retract-memory-entry") {
        const current = this.#requireMemoryEntry(command.projectId, command.entryId);
        const entry = retractMemoryEntry(current, {
          reason: command.reason,
          actor,
          retractedAt: timestamp,
          expectedVersion: command.expectedVersion,
        });
        result = { kind: "memory-entry-retracted", entry };
        eventName = "memory.entry-retracted@1";
        payload = { entry };
        resultEntryId = entry.id;
      } else {
        const sourceProject = this.#persistence.readProject(command.sourceProjectId);
        if (sourceProject === undefined) {
          throw new ProjectServiceError({
            category: "not-found",
            message: "Source Project was not found.",
          });
        }
        this.#assertModeEnabled(sourceProject.type);
        const source = this.#requireMemoryEntry(command.sourceProjectId, command.sourceEntryId);
        this.#assertNewMemoryEntryId(command.destinationProjectId, command.destinationEntryId);
        const entry = transferMemoryEntry(source, {
          destinationProjectId: command.destinationProjectId,
          destinationEntryId: command.destinationEntryId,
          actor,
          transferredAt: timestamp,
          expectedVersion: command.expectedVersion,
        });
        result = { kind: "memory-entry-transferred", entry };
        eventName = "memory.entry-transferred@1";
        payload = { entry };
        resultEntryId = entry.id;
      }

      this.#persistence.journal.append({
        aggregate: { aggregateType: "project-memory", aggregateId: destinationProjectId },
        expectedVersion: command.expectedVersion,
        events: [this.#pendingEvent(eventName, payload)],
      });
      const authoritative = this.#persistence.readMemoryEntry(destinationProjectId, resultEntryId);
      if (authoritative === undefined || authoritative.version !== command.expectedVersion + 1) {
        throw this.#unavailable();
      }
      if (result.kind === "memory-entry-superseded") {
        const previous = this.#persistence.readMemoryEntry(
          destinationProjectId,
          result.previousEntry.id,
        );
        if (previous?.status !== "superseded" || authoritative.status !== "active") {
          throw this.#unavailable();
        }
        return decodeMemoryCommandResult({
          kind: result.kind,
          previousEntry: previous,
          entry: authoritative,
        });
      }
      return decodeMemoryCommandResult({ kind: result.kind, entry: authoritative });
    } catch (error) {
      throw this.#mapFailure(error);
    }
  }

  async executeProject(
    authenticatedWindowId: WindowId,
    input: unknown,
  ): Promise<ProjectCommandResult> {
    let command: ReturnType<typeof decodeProjectCommand>;
    try {
      command = decodeProjectCommand(input);
    } catch {
      throw new ProjectServiceError({
        category: "invalid",
        message: "Project command is invalid.",
      });
    }
    this.#assertReady();
    try {
      const current = this.#persistence.readProject(command.projectId);
      this.#assertExpectedVersion(current, command.expectedVersion);
      const timestamp = decodeTimestamp(this.#clock());
      const actor = { kind: "local-user" as const, actorId: OCTANT_LOCAL_ACTOR_ID };
      let project: Project;
      let kind: ProjectCommandResult["kind"];
      let eventName: string;

      if (
        command.kind === "create-chat-project" ||
        command.kind === "create-work-project" ||
        command.kind === "create-code-project"
      ) {
        const type =
          command.kind === "create-chat-project"
            ? "chat"
            : command.kind === "create-work-project"
              ? "work"
              : "code";
        this.#assertModeEnabled(type);
        const sameLane = this.#persistence
          .readProjects({ type, lifecycle: "active" })
          .filter((candidate) => !candidate.pinned);
        const rank = rankBetween(sameLane.at(-1)?.rank, undefined);
        if (command.kind === "create-chat-project") {
          project = createProject({
            type: "chat",
            id: command.projectId,
            name: command.name,
            rank,
            createdAt: timestamp,
          });
          kind = "chat-project-created";
        } else {
          const type = command.kind === "create-work-project" ? "work" : "code";
          const binding = this.#receipts.consume({
            receiptId: command.receiptId,
            authenticatedWindowId,
            projectType: type,
            now: this.#now(),
          });
          const common = {
            id: command.projectId,
            name: command.name,
            rank,
            createdAt: timestamp,
            binding,
            revisionId: decodeBindingRevisionId(this.#uuid()),
            actor,
          };
          project =
            type === "work"
              ? createProject({ ...common, type })
              : createProject({ ...common, type });
          kind = type === "work" ? "work-project-created" : "code-project-created";
        }
        eventName = "project.created@1";
      } else {
        if (current === undefined)
          throw new ProjectServiceError({
            category: "not-found",
            message: "Project was not found.",
          });
        this.#assertModeEnabled(current.type);
        if (
          current.lifecycle === "archived" &&
          !(command.kind === "change-project-lifecycle" && command.lifecycle === "active")
        ) {
          throw new ProjectServiceError({
            category: "invalid",
            message: "Archived Projects are read-only.",
          });
        }
        if (command.kind === "rename-project") {
          project = renameProject(current, command.name, timestamp);
          kind = "project-renamed";
          eventName = "project.renamed@1";
        } else if (command.kind === "move-project") {
          const beforeProject =
            command.beforeProjectId === undefined
              ? undefined
              : this.#persistence.readProject(command.beforeProjectId);
          const afterProject =
            command.afterProjectId === undefined
              ? undefined
              : this.#persistence.readProject(command.afterProjectId);
          if (
            (command.beforeProjectId !== undefined && beforeProject === undefined) ||
            (command.afterProjectId !== undefined && afterProject === undefined)
          ) {
            throw new ProjectServiceError({
              category: "invalid",
              message: "Project move neighbor is invalid.",
            });
          }
          project = moveProject(current, {
            pinned: command.pinned,
            ...(beforeProject === undefined ? {} : { beforeProject }),
            ...(afterProject === undefined ? {} : { afterProject }),
            updatedAt: timestamp,
          });
          kind = "project-moved";
          eventName = "project.order-changed@1";
        } else if (command.kind === "change-project-lifecycle") {
          project = changeProjectLifecycle(current, command.lifecycle, timestamp);
          kind = "project-lifecycle-changed";
          eventName = "project.lifecycle-changed@1";
        } else if (command.kind === "change-code-project-access") {
          project = changeCodeProjectAccess(current, command.codeAccessPersistence, timestamp);
          kind = "code-project-access-changed";
          eventName = "project.code-access-changed@1";
        } else if (command.kind === "change-code-project-new-thread-workspace") {
          // The habit lives on the Project record, not in a local named
          // view, so every window sees the same default after this event.
          project = changeCodeProjectNewThreadWorkspace(
            current,
            command.newThreadWorkspace,
            timestamp,
          );
          kind = "code-project-new-thread-workspace-changed";
          eventName = "project.code-new-thread-workspace-changed@1";
        } else if (command.kind === "change-code-project-pull-request-background-refresh") {
          // One journaled event per user toggle. The background cadence the
          // setting enables never journals anything itself: its observations
          // stay in the in-memory pull-request snapshot.
          project = changeCodeProjectPullRequestBackgroundRefresh(
            current,
            command.pullRequestBackgroundRefresh,
            timestamp,
          );
          kind = "code-project-pull-request-background-refresh-changed";
          eventName = "project.code-pull-request-background-refresh-changed@1";
        } else {
          if (current.type === "chat")
            throw new ProjectServiceError({
              category: "invalid",
              message: "Chat Projects cannot be relinked.",
            });
          const currentRevision = current.bindingHistory.at(-1);
          if (
            currentRevision === undefined ||
            currentRevision.currentBinding.canonicalRoot !== current.binding.canonicalRoot
          ) {
            throw new ProjectServiceError({
              category: "invalid",
              message: "Project binding history is inconsistent.",
            });
          }
          const binding = this.#receipts.consume({
            receiptId: command.receiptId,
            authenticatedWindowId,
            projectType: current.type,
            now: this.#now(),
          });
          project = relinkProject(current, {
            previousBindingRevision: current.bindingHistory.at(-1)?.revision ?? 0,
            binding,
            revisionId: decodeBindingRevisionId(this.#uuid()),
            actor,
            changedAt: timestamp,
          });
          kind = "project-relinked";
          eventName = "project.binding-relinked@1";
        }
      }

      this.#persistence.journal.append({
        aggregate: { aggregateType: "project", aggregateId: project.id },
        expectedVersion: command.expectedVersion,
        events: [this.#pendingEvent(eventName, { project })],
      });
      const authoritative = this.#persistence.readProject(project.id);
      if (authoritative === undefined || authoritative.version !== project.version) {
        throw this.#unavailable();
      }
      if (
        current?.type === "work" &&
        current.lifecycle === "active" &&
        authoritative.type === "work" &&
        authoritative.lifecycle === "archived"
      ) {
        for (const listener of this.#archiveListeners) {
          try {
            listener(authoritative);
          } catch {
            // The Project archive is already authoritative. Dependent services
            // independently fail closed and reconcile again after restart.
          }
        }
      }
      return decodeProjectCommandResult({ kind, project: authoritative });
    } catch (error) {
      throw this.#mapFailure(error);
    }
  }

  #assertExpectedVersion(project: Project | undefined, expected: number): void {
    const actual = project?.version ?? decodeAggregateVersion(0);
    if (actual !== expected || (project !== undefined && expected === 0)) {
      throw new ProjectServiceError({
        category: "conflict",
        message: "Project changed; reload and retry.",
        currentVersion: actual,
      });
    }
  }

  #assertMemoryExpectedVersion(memory: ProjectMemoryView, expected: number): void {
    const actual = decodeAggregateVersion(
      Math.max(
        0,
        ...memory.active.map((entry) => entry.version),
        ...memory.history.map((entry) => entry.version),
      ),
    );
    if (actual !== expected) {
      throw new ProjectServiceError({
        category: "conflict",
        message: "Project memory changed; reload and retry.",
        currentVersion: actual,
      });
    }
  }

  #requireMemoryEntry(projectId: ProjectId, entryId: ActiveMemoryEntry["id"]): MemoryEntry {
    const entry = this.#persistence.readMemoryEntry(projectId, entryId);
    if (entry === undefined || entry.projectId !== projectId) {
      throw new ProjectServiceError({
        category: "not-found",
        message: "Project memory entry was not found.",
      });
    }
    return entry;
  }

  #assertNewMemoryEntryId(projectId: ProjectId, entryId: ActiveMemoryEntry["id"]): void {
    if (this.#persistence.readMemoryEntry(projectId, entryId) !== undefined) {
      throw new ProjectServiceError({
        category: "invalid",
        message: "Project memory entry ID is already in use.",
      });
    }
  }

  #assertModeEnabled(type: ProjectType): void {
    const settings = this.#persistence.readShellSettings()?.settings ?? defaultShellSettings();
    if (!enabledModes(settings).includes(type)) {
      throw new ProjectServiceError({
        category: "unsupported",
        message: `${type} mode is disabled.`,
      });
    }
  }

  #pendingEvent(eventName: string, payload: unknown) {
    return {
      eventId: decodeEventId(this.#uuid()),
      eventName,
      eventVersion: 1,
      correlationId: decodeCorrelationId(this.#uuid()),
      actor: { kind: "local-user" as const, actorId: decodeActorId(OCTANT_LOCAL_ACTOR_ID) },
      occurredAt: decodeTimestamp(this.#clock()),
      payload,
    };
  }

  #assertReady(): void {
    try {
      const status = this.#persistence.status();
      if (status.state !== "current" || status.integrity !== "ok") throw new Error("not ready");
    } catch {
      throw this.#unavailable();
    }
  }

  #mapFailure(error: unknown): ProjectServiceError {
    if (error instanceof ProjectServiceError) return error;
    if (error instanceof ProjectPolicyRejected)
      return new ProjectServiceError({ category: "invalid", message: error.message });
    if (error instanceof MemoryPolicyRejected)
      return new ProjectServiceError({ category: "invalid", message: error.message });
    if (error instanceof BindingReceiptError)
      return new ProjectServiceError(
        decodeProjectFailure({ category: error.category, message: error.message }),
      );
    if (error instanceof ConcurrencyConflict)
      return new ProjectServiceError({
        category: "conflict",
        message: "Project changed; reload and retry.",
        currentVersion: decodeAggregateVersion(error.actualVersion),
      });
    if (error instanceof JournalWriteFailed || error instanceof ProjectionApplicationFailed)
      return this.#unavailable();
    return this.#unavailable();
  }

  #unavailable(): ProjectServiceError {
    return new ProjectServiceError({
      category: "unavailable",
      message: "Octant Project service is unavailable.",
    });
  }
}

function toSummary(project: Project): ProjectSummary {
  if (project.type === "chat") return project;
  const { bindingHistory, ...summary } = project;
  const bindingRevisionId = bindingHistory.at(-1)?.revisionId;
  if (bindingRevisionId === undefined) {
    throw new Error("Bound Project is missing a binding revision.");
  }
  return { ...summary, bindingRevisionId };
}
