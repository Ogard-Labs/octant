import {
  ActorId,
  CorrelationId,
  WorkThreadFailure as WorkThreadFailureSchema,
  EventId,
  UtcTimestamp,
  decodeWorkThread,
  decodeWorkThreadBootstrap,
  decodeWorkThreadNavigation,
  decodeWorkThreadCommand,
  type WorkThread,
  type WorkThreadBootstrap,
  type WorkThreadNavigation,
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
  completedThreadArchiveDue,
  decideCompleteThread,
  decideSnoozeThread,
} from "@octant/domain/thread-completion-policy";
import type {
  CompletedThreadArchiveInput,
  CompletedThreadArchiveOutcome,
} from "../completedThreadArchiveSweep";
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
            readonly kind: "local-user" | "system";
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
  readonly observeRuntime?: (
    threadId: WorkThreadId,
  ) => WorkThreadRuntimeActivity | Promise<WorkThreadRuntimeActivity>;
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
          runtime.push({
            threadId: thread.id,
            executing: activity.executing,
            // Carried only when true, so an idle row's payload stays as it was.
            ...(activity.awaitingInput === true ? { awaitingInput: true } : {}),
          });
        }
      }
      return decodeWorkThreadBootstrap({ threads, runtime });
    } catch (error) {
      throw this.#mapFailure(error);
    }
  }

  /**
   * Reads one Machine-owned Work thread without rescanning every Project root.
   * Root availability is revalidated at command admission; opening durable
   * transcript state needs only the active Project and thread projections.
   */
  async read(
    _authenticatedWindowId: WindowId,
    threadId: WorkThreadId,
  ): Promise<WorkThread | undefined> {
    this.#assertReady();
    const thread = this.#projection.read(threadId);
    if (thread === undefined) return undefined;
    const project = this.#persistence.readProject(thread.projectId);
    return thread.lifecycle === "active" &&
      project?.type === "work" &&
      project.lifecycle === "active"
      ? thread
      : undefined;
  }

  /**
   * Reads the Work sidebar from rebuildable thread and Project projections.
   * Root validation belongs to bootstrap and command admission; performing it
   * here would turn an ordinary sidebar tick into filesystem observation.
   */
  async navigation(_authenticatedWindowId: WindowId): Promise<WorkThreadNavigation> {
    this.#assertReady();
    try {
      const threads = this.#projection.list().filter((thread) => {
        const project = this.#persistence.readProject(thread.projectId);
        return (
          project?.type === "work" &&
          project.lifecycle === "active" &&
          thread.lifecycle === "active"
        );
      });
      const runtime = [];
      for (const thread of threads) {
        const activity =
          this.#observeRuntime === undefined
            ? { executing: false }
            : await this.#observeRuntime(thread.id);
        runtime.push({
          threadId: thread.id,
          executing: activity.executing,
          // Carried only when true, so an idle row's payload stays as it was.
          ...(activity.awaitingInput === true ? { awaitingInput: true } : {}),
        });
      }
      return decodeWorkThreadNavigation({ threads, runtime });
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
      // Completing or snoozing hides the row, so the host decides from the
      // runtime it observes — never from what the renderer believed a moment
      // ago — whether hiding it would hide work in flight.
      const restSignals =
        command.kind === "complete-work-thread" || command.kind === "snooze-work-thread"
          ? await this.#restSignals(current.id)
          : undefined;
      const updatedAt = decodeTimestamp(this.#clock());
      if (command.kind === "complete-work-thread" && restSignals !== undefined) {
        const decision = decideCompleteThread({ lifecycle: current.lifecycle, ...restSignals });
        if (decision.status === "refused") {
          throw this.#failure("invalid", WORK_COMPLETE_REFUSALS[decision.reason]);
        }
      }
      if (command.kind === "snooze-work-thread" && restSignals !== undefined) {
        const decision = decideSnoozeThread({
          lifecycle: current.lifecycle,
          awaitingInput: restSignals.awaitingInput,
          until: command.until,
          now: updatedAt,
        });
        if (decision.status === "refused") {
          throw this.#failure("invalid", WORK_SNOOZE_REFUSALS[decision.reason]);
        }
      }
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
            : command.kind === "complete-work-thread"
              ? // Completing is "I'm done here": any snooze would keep the row
                // out of the Completed shelf, so it goes.
                {
                  ...withoutThreadRest(current),
                  completedAt: updatedAt,
                  version: command.expectedVersion + 1,
                  updatedAt,
                }
              : command.kind === "reopen-work-thread" || command.kind === "wake-work-thread"
                ? {
                    ...withoutThreadRest(current),
                    version: command.expectedVersion + 1,
                    updatedAt,
                  }
                : command.kind === "snooze-work-thread"
                  ? {
                      ...withoutThreadRest(current),
                      snooze: {
                        until: command.until,
                        at: updatedAt,
                        // A turn running now is what "something happened"
                        // means later: its end wakes the thread early.
                        ...(restSignals?.executing === true ? { duringTurn: true } : {}),
                      },
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

  /**
   * A person sending the thread a turn is re-engaging with it: a completed
   * thread comes back to the active list and a snoozed one wakes, the same
   * way an explicit Reopen or Wake would. Journals nothing for a thread that
   * was already in play.
   */
  noteTurnRequested(threadId: WorkThreadId): void {
    const current = this.#projection.read(threadId);
    if (current === undefined) return;
    if (current.completedAt === undefined && current.snooze === undefined) return;
    const updated = decodeWorkThread({
      ...withoutThreadRest(current),
      version: current.version + 1,
      updatedAt: decodeTimestamp(this.#clock()),
    });
    this.#append(current.id, current.version, "work.thread-updated@1", {
      kind: "thread-updated",
      thread: updated,
    });
    this.#projection.apply({ kind: "thread-updated", thread: updated });
  }

  /**
   * Archive one completed thread on the host's own timer. Re-reads the thread
   * and re-decides from the authoritative record, so a thread reopened between
   * the sweep's read and this call is left alone rather than archived on stale
   * evidence. Archiving keeps everything; it only leaves the shelves.
   */
  archiveCompletedThread(
    threadId: WorkThreadId,
    input: CompletedThreadArchiveInput,
  ): CompletedThreadArchiveOutcome {
    const current = this.#projection.read(threadId);
    if (current === undefined) return { status: "skipped", reason: "not-found" };
    if (
      !completedThreadArchiveDue({
        lifecycle: current.lifecycle,
        completedAt: current.completedAt,
        afterDays: input.afterDays,
        now: input.now,
      })
    ) {
      return { status: "skipped", reason: "not-due" };
    }
    const updated = decodeWorkThread({
      ...current,
      lifecycle: "archived",
      version: current.version + 1,
      updatedAt: decodeTimestamp(this.#clock()),
    });
    this.#append(
      current.id,
      current.version,
      "work.thread-updated@1",
      { kind: "thread-updated", thread: updated },
      "system",
    );
    this.#projection.apply({ kind: "thread-updated", thread: updated });
    return { status: "archived" };
  }

  /**
   * What the runtime says about the thread's live work. A runtime that cannot
   * be observed leaves the thread eligible to rest, the same reading the
   * board takes when it keeps such a thread visible.
   */
  async #restSignals(
    threadId: WorkThreadId,
  ): Promise<{ readonly executing: boolean; readonly awaitingInput: boolean }> {
    if (this.#observeRuntime === undefined) return { executing: false, awaitingInput: false };
    try {
      const activity = await this.#observeRuntime(threadId);
      return { executing: activity.executing, awaitingInput: activity.awaitingInput === true };
    } catch {
      return { executing: false, awaitingInput: false };
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
    // Everything a person asks for is theirs; only the host's own timer
    // writes as the system, so a journal reader can tell the two apart.
    actorKind: "local-user" | "system" = "local-user",
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
          actor:
            actorKind === "system"
              ? { kind: "system", actorId: decodeActorId(OCTANT_LOCAL_ACTOR_ID) }
              : { kind: "local-user", actorId: decodeActorId(OCTANT_LOCAL_ACTOR_ID) },
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

/** The live signals the board folds; `awaitingInput` is absent from older observers. */
export interface WorkThreadRuntimeActivity {
  readonly executing: boolean;
  readonly awaitingInput?: boolean;
}

const WORK_COMPLETE_REFUSALS = {
  archived: "An archived thread cannot be completed.",
  executing: "Wait for the running turn to finish before completing this thread.",
  "awaiting-input": "This thread is waiting on you; answer it before completing it.",
} as const;

const WORK_SNOOZE_REFUSALS = {
  archived: "An archived thread cannot be snoozed.",
  "awaiting-input": "This thread is waiting on you; answer it before snoozing it.",
  "wake-time-not-in-future": "Pick a wake time that is still ahead.",
} as const;

/**
 * A thread back in play carries neither rest: completion and snooze are
 * dropped rather than stored as "not any more", so a thread that was never
 * put away and one that came back are the same record.
 */
function withoutThreadRest<T extends Pick<WorkThread, "completedAt" | "snooze">>(
  thread: T,
): Omit<T, "completedAt" | "snooze"> {
  const { completedAt: _completedAt, snooze: _snooze, ...rest } = thread;
  return rest;
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
