import {
  ActorId,
  CorrelationId,
  WorkThreadFailure as WorkThreadFailureSchema,
  EventId,
  UtcTimestamp,
  decodeWorkThread,
  decodeWorkThreadBootstrap,
  decodeWorkThreadCommand,
  type WorkThread,
  type WorkThreadBootstrap,
  type WorkThreadCommand,
  type WorkThreadCommandResult,
  type WorkThreadFailure,
  type WorkThreadId,
  type Project,
  type ProjectId,
  type ProviderInstance,
  type ProviderModelId,
  type ProviderProbeResult,
  type ThreadWorkingDirectory,
  type WindowId,
} from "@octant/contracts";
import { Schema } from "effect";
import { hasWorkToolAuthority } from "@octant/domain";
import {
  issueContextFailureCategory,
  prepareOptionalIssueContext,
  type GithubIssueContextService,
} from "../github/githubIssueContextService";
import {
  linearIssueContextFailureCategory,
  prepareOptionalLinearIssueContext,
  type LinearIssueContextService,
} from "../plugins/linear/linearIssueContextService";

type GithubIssueContextPort = Pick<
  GithubIssueContextService,
  | "prepare"
  | "bindCreatedThread"
  | "peekFramedForFirstTurn"
  | "consumeFramedForFirstTurn"
  | "takeFramedForFirstTurn"
>;

type LinearIssueContextPort = Pick<
  LinearIssueContextService,
  | "prepare"
  | "bindCreatedThread"
  | "peekFramedForFirstTurn"
  | "consumeFramedForFirstTurn"
  | "takeFramedForFirstTurn"
>;
import { ConcurrencyConflict, JournalWriteFailed } from "../persistence/journalErrors";
import { ProjectionApplicationFailed } from "../persistence/projection";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import { WorkThreadProjection } from "./workThreadProjection";

const decodeActorId = Schema.decodeUnknownSync(ActorId);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);
const decodeWorkThreadFailure = Schema.decodeUnknownSync(WorkThreadFailureSchema);

export interface WorkThreadServiceDependencies {
  readonly persistence: {
    readonly status: () => {
      readonly state: string;
      readonly integrity: string;
    };
    readonly readProject: (projectId: ProjectId) => Project | undefined;
    readonly readProviderInstance: (
      instanceId: WorkThread["providerInstanceId"],
    ) => ProviderInstance | undefined;
    readonly journal: {
      append: (request: {
        readonly aggregate: {
          readonly aggregateType: string;
          readonly aggregateId: string;
        };
        readonly expectedVersion: number;
        readonly events: ReadonlyArray<{
          readonly eventId: string;
          readonly eventName: string;
          readonly eventVersion: 1;
          readonly correlationId: string;
          readonly actor: {
            readonly kind: "local-user";
            readonly actorId: string;
          };
          readonly occurredAt: string;
          readonly payload: unknown;
        }>;
      }) => void;
    };
  };
  readonly projects: {
    readonly bootstrap: (authenticatedWindowId: WindowId) => Promise<{
      readonly active: ReadonlyArray<{
        readonly id: ProjectId;
        readonly type: string;
        readonly lifecycle: string;
      }>;
      readonly archived: ReadonlyArray<unknown>;
    }>;
  };
  readonly projection: WorkThreadProjection;
  readonly probeProvider?: (
    providerInstanceId: WorkThread["providerInstanceId"],
  ) => Promise<ProviderProbeResult>;
  readonly uuid: () => string;
  readonly clock: () => string;
  readonly workingDirectories: {
    readonly resolve: (
      authoritativeRoot: string,
      workingDirectory: ThreadWorkingDirectory,
    ) => Promise<string>;
  };
  readonly onWorkingDirectoryChanged: (scope: {
    readonly mode: "work";
    readonly projectId: ProjectId;
    readonly threadId: WorkThreadId;
  }) => Promise<void>;
  /**
   * Live run-state fold used by the Work board. Optional so unit tests that
   * only exercise thread CRUD need not wire turns; an absent observer leaves
   * the bootstrap runtime list empty.
   */
  readonly observeRuntime?: (threadId: WorkThreadId) =>
    | { readonly executing: boolean }
    | Promise<{ readonly executing: boolean }>;
  readonly issueContext?: GithubIssueContextPort;
  readonly linearIssueContext?: LinearIssueContextPort;
}

export class WorkThreadServiceError extends Error {
  override readonly name = "WorkThreadServiceError";

  constructor(readonly failure: WorkThreadFailure) {
    super(failure.message);
  }
}

export class WorkThreadService {
  readonly #persistence: WorkThreadServiceDependencies["persistence"];
  readonly #projects: WorkThreadServiceDependencies["projects"];
  readonly #projection: WorkThreadProjection;
  readonly #probeProvider: WorkThreadServiceDependencies["probeProvider"];
  readonly #uuid: () => string;
  readonly #clock: () => string;
  readonly #workingDirectories: WorkThreadServiceDependencies["workingDirectories"];
  readonly #onWorkingDirectoryChanged: WorkThreadServiceDependencies["onWorkingDirectoryChanged"];
  readonly #observeRuntime?: WorkThreadServiceDependencies["observeRuntime"];
  readonly #issueContext?: GithubIssueContextPort;
  readonly #linearIssueContext?: LinearIssueContextPort;

  constructor(dependencies: WorkThreadServiceDependencies) {
    this.#persistence = dependencies.persistence;
    this.#projects = dependencies.projects;
    this.#projection = dependencies.projection;
    this.#probeProvider = dependencies.probeProvider;
    this.#uuid = dependencies.uuid;
    this.#clock = dependencies.clock;
    this.#workingDirectories = dependencies.workingDirectories;
    this.#onWorkingDirectoryChanged = dependencies.onWorkingDirectoryChanged;
    if (dependencies.observeRuntime !== undefined) {
      this.#observeRuntime = dependencies.observeRuntime;
    }
    if (dependencies.issueContext !== undefined) {
      this.#issueContext = dependencies.issueContext;
    }
    if (dependencies.linearIssueContext !== undefined) {
      this.#linearIssueContext = dependencies.linearIssueContext;
    }
  }

  async bootstrap(authenticatedWindowId: WindowId): Promise<WorkThreadBootstrap> {
    this.#assertReady();
    try {
      const accessible = await this.#activeWorkProjectIds(authenticatedWindowId);
      const threads = this.#projection
        .list()
        .filter((thread) => accessible.has(String(thread.projectId)));
      const runtime = [];
      if (this.#observeRuntime !== undefined) {
        for (const thread of threads) {
          if (thread.lifecycle === "archived" || thread.lifecycle === "deleted") continue;
          const activity = await this.#observeRuntime(thread.id);
          runtime.push({ threadId: thread.id, executing: activity.executing });
        }
      }
      return decodeWorkThreadBootstrap({ threads, runtime });
    } catch (error) {
      throw this.#mapFailure(error);
    }
  }

  async execute(authenticatedWindowId: WindowId, input: unknown): Promise<WorkThreadCommandResult> {
    this.#assertReady();
    try {
      const command = decodeWorkThreadCommand(input);
      if (command.kind === "create-work-thread") {
        if (command.hostId !== "local") {
          throw this.#failure("unauthorized", "Work thread host is not authorized.");
        }
        await this.#requireAccessibleActiveWorkProject(authenticatedWindowId, command.projectId);
        await this.#requireProviderModel(command.providerInstanceId, command.modelId);
        const project = await this.#requireAccessibleActiveWorkProject(
          authenticatedWindowId,
          command.projectId,
        );
        const latestBinding = project.bindingHistory.at(-1);
        if (
          latestBinding === undefined ||
          String(latestBinding.revisionId) !== String(command.bindingRevisionId)
        ) {
          throw this.#failure("stale", "Work Project binding changed; reload and retry.");
        }
        if (project.binding.canonicalRoot.trim() === "") {
          throw this.#failure("invalid", "Work Project root is unavailable.");
        }
        const workingDirectory = command.workingDirectory ?? ("." as ThreadWorkingDirectory);
        try {
          await this.#workingDirectories.resolve(project.binding.canonicalRoot, workingDirectory);
        } catch {
          throw this.#failure("invalid", "Work working directory is unavailable.");
        }
        if (this.#projection.read(command.threadId) !== undefined) {
          throw this.#failure("invalid", "Work thread already exists.");
        }
        if (command.issueContext !== undefined && command.linearIssueContext !== undefined) {
          throw this.#failure(
            "invalid",
            "Choose either a GitHub issue or a Linear issue, not both.",
          );
        }
        const preparedIssue = await prepareOptionalIssueContext(
          this.#issueContext,
          command.issueContext,
          new AbortController().signal,
        );
        if (preparedIssue.status === "refused") {
          throw this.#failure(
            issueContextFailureCategory(preparedIssue.reason),
            preparedIssue.message,
          );
        }
        const preparedLinearIssue = await prepareOptionalLinearIssueContext(
          this.#linearIssueContext,
          command.linearIssueContext,
          new AbortController().signal,
        );
        if (preparedLinearIssue.status === "refused") {
          throw this.#failure(
            linearIssueContextFailureCategory(preparedLinearIssue.reason),
            preparedLinearIssue.message,
          );
        }
        const created = decodeWorkThread({
          id: command.threadId,
          projectId: command.projectId,
          title: command.title,
          lifecycle: "active",
          providerInstanceId: command.providerInstanceId,
          modelId: command.modelId,
          bindingRevisionId: command.bindingRevisionId,
          workingDirectory,
          version: 1,
          createdAt: decodeTimestamp(this.#clock()),
          updatedAt: decodeTimestamp(this.#clock()),
        });
        this.#append(created.id, 0, "work.thread-created@1", {
          kind: "thread-created",
          thread: created,
        });
        this.#projection.apply({ kind: "thread-created", thread: created });
        if (preparedIssue.status === "ready" && command.issueContext !== undefined) {
          try {
            this.#issueContext?.bindCreatedThread({
              threadId: String(created.id),
              framed: preparedIssue.framed,
              request: command.issueContext,
            });
          } catch {
            // The thread is already journaled; taint recording must not invert create.
          }
        }
        if (preparedLinearIssue.status === "ready" && command.linearIssueContext !== undefined) {
          try {
            this.#linearIssueContext?.bindCreatedThread({
              threadId: String(created.id),
              framed: preparedLinearIssue.framed,
              request: command.linearIssueContext,
            });
          } catch {
            // The thread is already journaled; taint recording must not invert create.
          }
        }
        return { kind: "thread-created", thread: created };
      }

      const current = this.#projection.read(command.threadId);
      if (current === undefined || current.lifecycle === "deleted") {
        throw this.#failure("invalid", "Work thread was not found.");
      }
      const project = await this.#requireAccessibleActiveWorkProject(
        authenticatedWindowId,
        current.projectId,
      );
      const bindingRevision = project.bindingHistory.at(-1);
      if (
        current.bindingRevisionId !== undefined &&
        bindingRevision?.revisionId !== current.bindingRevisionId
      ) {
        throw this.#failure("stale", "Work Project binding changed; reload and retry.");
      }
      if (current.version !== command.expectedVersion) {
        throw this.#failure("stale", "Work thread changed; reload and retry.");
      }
      if (command.kind === "confirm-work-thread-completion") {
        if (current.lifecycle !== "active") {
          throw this.#failure("invalid", "Only an active Work thread can confirm completion.");
        }
        if (current.completionConfirmed === true) {
          throw this.#failure("invalid", "Work thread completion was already confirmed.");
        }
        if (command.deliveryTarget !== current.title) {
          throw this.#failure(
            "invalid",
            "Work completion must identify the current delivery target.",
          );
        }
        const confirmed = decodeWorkThread({
          ...current,
          completionConfirmed: true,
          completionEvidence: {
            deliveryTarget: command.deliveryTarget,
            satisfactionEvidence: command.satisfactionEvidence,
          },
          version: command.expectedVersion + 1,
          updatedAt: decodeTimestamp(this.#clock()),
        });
        this.#append(current.id, command.expectedVersion, "work.thread-completion-confirmed@1", {
          kind: "thread-completion-confirmed",
          thread: confirmed,
        });
        this.#projection.apply({
          kind: "thread-completion-confirmed",
          thread: confirmed,
        });
        return { kind: "thread-completion-confirmed", thread: confirmed };
      }
      if (command.kind === "change-work-thread-provider") {
        await this.#requireProviderModel(command.providerInstanceId, command.modelId);
      } else if (command.kind === "change-work-thread-working-directory") {
        try {
          await this.#workingDirectories.resolve(
            project.binding.canonicalRoot,
            command.workingDirectory,
          );
        } catch {
          throw this.#failure("invalid", "Work working directory is unavailable.");
        }
      } else if (
        command.kind === "change-work-thread-lifecycle" &&
        current.lifecycle === command.lifecycle
      ) {
        throw this.#failure("invalid", "Work thread already has that lifecycle.");
      }
      const updatedAt = decodeTimestamp(this.#clock());
      const updated = decodeWorkThread(
        command.kind === "rename-work-thread"
          ? {
              ...current,
              title: command.title,
              version: command.expectedVersion + 1,
              updatedAt,
            }
          : command.kind === "change-work-thread-lifecycle"
            ? {
                ...lifecycleUpdate(current, command.lifecycle),
                lifecycle: command.lifecycle,
                version: command.expectedVersion + 1,
                updatedAt,
              }
            : command.kind === "change-work-thread-provider"
              ? {
                  ...current,
                  providerInstanceId: command.providerInstanceId,
                  modelId: command.modelId,
                  providerHandoff: {
                    previousProviderInstanceId: current.providerInstanceId,
                    previousModelId: current.modelId,
                    nextProviderInstanceId: command.providerInstanceId,
                    nextModelId: command.modelId,
                    changedAt: updatedAt,
                  },
                  version: command.expectedVersion + 1,
                  updatedAt,
                }
              : {
                  ...current,
                  workingDirectory: command.workingDirectory,
                  bindingRevisionId: bindingRevision?.revisionId,
                  version: command.expectedVersion + 1,
                  updatedAt,
                },
      );
      this.#append(current.id, command.expectedVersion, "work.thread-updated@1", {
        kind: "thread-updated",
        thread: updated,
      });
      this.#projection.apply({ kind: "thread-updated", thread: updated });
      if (command.kind === "change-work-thread-working-directory") {
        await this.#onWorkingDirectoryChanged({
          mode: "work",
          projectId: current.projectId,
          threadId: current.id,
        }).catch(() => undefined);
      }
      return { kind: "thread-updated", thread: updated };
    } catch (error) {
      throw this.#mapFailure(error);
    }
  }

  #assertReady(): void {
    const status = this.#persistence.status();
    if (status.state !== "current" || status.integrity !== "ok") {
      throw this.#failure("unavailable", "Octant Work thread service is unavailable.");
    }
  }

  async #requireAccessibleActiveWorkProject(
    authenticatedWindowId: WindowId,
    projectId: ProjectId,
  ): Promise<Extract<Project, { readonly type: "work" }>> {
    const activeWorkProjects = await this.#activeWorkProjectIds(authenticatedWindowId);
    if (!activeWorkProjects.has(String(projectId))) {
      throw this.#failure("unauthorized", "Work Project is unavailable for this window.");
    }
    const project = this.#persistence.readProject(projectId);
    if (project?.type !== "work" || project.lifecycle !== "active") {
      throw this.#failure("unauthorized", "Work Project is unavailable for this window.");
    }
    return project;
  }

  async #activeWorkProjectIds(authenticatedWindowId: WindowId): Promise<Set<string>> {
    const bootstrap = await this.#projects.bootstrap(authenticatedWindowId);
    return new Set(
      bootstrap.active
        .filter((project) => project.type === "work" && project.lifecycle === "active")
        .map((project) => String(project.id)),
    );
  }

  async #requireProviderModel(
    providerInstanceId: WorkThread["providerInstanceId"],
    modelId: ProviderModelId,
  ): Promise<void> {
    const provider = this.#persistence.readProviderInstance(providerInstanceId);
    if (provider === undefined || !provider.enabled) {
      throw this.#failure("unavailable", "Selected Work provider is unavailable.");
    }
    if (this.#probeProvider === undefined) return;
    let probe: ProviderProbeResult;
    try {
      probe = await this.#probeProvider(providerInstanceId);
    } catch {
      throw this.#failure("unavailable", "Selected Work provider is unavailable.");
    }
    const selectedModel = probe.models.find((model) => String(model.id) === String(modelId));
    const modelAvailable = selectedModel !== undefined;
    if (probe.readiness !== "ready" && !(probe.readiness === "degraded" && modelAvailable)) {
      throw this.#failure(
        probe.readiness === "unauthenticated"
          ? "unauthorized"
          : probe.readiness === "incompatible"
            ? "unsupported"
            : "unavailable",
        "Selected Work provider is not ready.",
      );
    }
    if (!modelAvailable) {
      throw this.#failure("invalid", "Selected Work model is unavailable.");
    }
    if (
      !hasWorkToolAuthority(provider.driverKind, selectedModel, probe.verifiedToolModelIds ?? [])
    ) {
      throw this.#failure("unsupported", "Selected Work model has no verified tool authority.");
    }
    const refreshedProvider = this.#persistence.readProviderInstance(providerInstanceId);
    if (
      refreshedProvider === undefined ||
      !refreshedProvider.enabled ||
      refreshedProvider.version !== provider.version ||
      refreshedProvider.driverKind !== provider.driverKind
    ) {
      throw this.#failure("unavailable", "Selected Work provider changed; reload and retry.");
    }
  }

  #append(
    threadId: WorkThreadId,
    expectedVersion: number,
    eventName:
      | "work.thread-created@1"
      | "work.thread-updated@1"
      | "work.thread-completion-confirmed@1",
    payload: unknown,
  ): void {
    this.#persistence.journal.append({
      aggregate: {
        aggregateType: "work-thread",
        aggregateId: String(threadId),
      },
      expectedVersion,
      events: [
        {
          eventId: decodeEventId(this.#uuid()),
          eventName,
          eventVersion: 1,
          correlationId: decodeCorrelationId(this.#uuid()),
          actor: {
            kind: "local-user",
            actorId: decodeActorId(OCTANT_LOCAL_ACTOR_ID),
          },
          occurredAt: decodeTimestamp(this.#clock()),
          payload,
        },
      ],
    });
  }

  #mapFailure(error: unknown): WorkThreadServiceError {
    if (error instanceof WorkThreadServiceError) return error;
    if (error instanceof ConcurrencyConflict) {
      return this.#failure("stale", "Work thread changed; reload and retry.");
    }
    if (error instanceof JournalWriteFailed || error instanceof ProjectionApplicationFailed) {
      return this.#failure("unavailable", "Octant Work thread service is unavailable.");
    }
    return this.#failure("unavailable", "Octant Work thread service is unavailable.");
  }

  #failure(category: WorkThreadFailure["category"], message: string): WorkThreadServiceError {
    return new WorkThreadServiceError(decodeWorkThreadFailure({ category, message }));
  }
}

function lifecycleUpdate(
  current: WorkThread,
  lifecycle: Extract<
    WorkThreadCommand,
    { readonly kind: "change-work-thread-lifecycle" }
  >["lifecycle"],
): WorkThread {
  if (current.lifecycle !== "archived" || lifecycle !== "active") return current;
  const {
    completionConfirmed: _completionConfirmed,
    completionEvidence: _completionEvidence,
    ...reactivated
  } = current;
  return reactivated as WorkThread;
}
