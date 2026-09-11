import {
  ActorId,
  CorrelationId,
  EventId,
  ProviderSessionId,
  UtcTimestamp,
  WORK_TURN_CAPABILITIES,
  decodeCancelWorkTurnCommand,
  decodeWorkThreadTranscript,
  decodeWorkTurnCancelResult,
  decodeWorkTurnFailure,
  decodeWorkTurnLookupResult,
  decodeWorkTurnRequestId,
  decodeWorkTurnState,
  decodeStartWorkThreadTurnCommand,
  type MentionableThreadId,
  type WorkAttachmentId,
  type WorkAttachmentMediaType,
  type WorkAttachmentReference,
  type WorkThread,
  type WorkThreadId,
  type WorkThreadTranscript,
  type WorkTurnCancelResult,
  type WorkTurnLookupResult,
  type WorkTurnRequestId,
  type WorkTurnState,
  type WorkTurnStreamFrame,
  type Project,
  type ProjectId,
  type ProviderAttachmentInput,
  type ProviderContextBlock,
  type ProviderInstance,
  type ThreadTaskProgressList,
  type ThreadWorkingDirectory,
  type WindowId,
} from "@octant/contracts";
import {
  BROWSER_SELECTION_GUIDANCE,
  isBrowserUseSelection,
  validateBrowserUseSelection,
} from "@octant/plugin-host/browser-use";
import type { ProviderDriver } from "@octant/provider-sdk/driver";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import type {
  NativeHarnessTurnAdmission,
  NativeHarnessTurnScope,
} from "../harness/nativeHarnessTurnObserver";
import {
  decideWorkTurnAuthority,
  FILE_MENTION_UNREADABLE_CONTEXT,
  THREAD_MENTION_UNREADABLE_CONTEXT,
} from "@octant/domain";
import {
  planWorkTurnContext,
  WORK_TURN_SAFE_INPUT_TOKENS,
  type WorkTurnContextContribution,
} from "./workTurnContext";
import type { WorkTurnWrittenFiles } from "@octant/contracts/work-turns";
import { decodeSpendCeilingReservationId, type SpendCeilingService } from "../spendCeilingService";
import { Schema } from "effect";
import { ConcurrencyConflict, JournalWriteFailed } from "../persistence/journalErrors";
import { ProjectionApplicationFailed } from "../persistence/projection";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import type { WorkTurnFileObserver } from "./workTurnFileObserver";
import type { WorkProjectStatusFiles } from "./workProjectStatusFiles";
import {
  DEFAULT_WORK_STATUS_STALE_AFTER_DAYS,
  WORK_AGENTS_FILE_NAME,
  WORK_STATUS_FILE_NAME,
  decideWorkResumeBrief,
  isWorkStatusDate,
  parseWorkStatus,
  type WorkResumeBriefReason,
} from "@octant/domain/work-project-status-policy";
import {
  WorkAttachmentInvalid,
  WorkAttachmentTooLarge,
  type WorkAttachmentStore,
} from "./workAttachmentStore";
import type { FramedExternalContent } from "../context/externalContentFraming";
import type { WorkTurnProjection } from "./workTurnProjection";
import {
  WorkTurnRuntime,
  type WorkTurnRuntimeOutcome,
  type WorkTurnRuntimePort,
} from "./workTurnRuntime";
import { WorkTurnLiveStore } from "./workTurnLiveStore";

const decodeActorId = Schema.decodeUnknownSync(ActorId);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeProviderSessionId = Schema.decodeUnknownSync(ProviderSessionId);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

/**
 * The standing rule for every Work turn, plus the resume brief when the
 * status has gone quiet or a date is close. Says what to do with `STATUS.md`,
 * never what the status is; the file itself is in the context beside it.
 */
function statusUpkeepInstruction(reasons: ReadonlyArray<WorkResumeBriefReason>): string {
  const standing = `This Project keeps its standing brief in ${WORK_AGENTS_FILE_NAME} and its current state in ${WORK_STATUS_FILE_NAME} at the top of the folder; both are in your context. Before you finish this task, update ${WORK_STATUS_FILE_NAME}: revise "Current status", add or resolve dated lines under "Follow-ups" and "Deadlines" (one per line, "- YYYY-MM-DD what"), and set the "Last updated:" line to today. Do not rewrite ${WORK_AGENTS_FILE_NAME}.`;
  if (reasons.length === 0) return standing;
  const why = [
    reasons.includes("stale") ? "the status has not been updated for a while" : undefined,
    reasons.includes("overdue") ? "at least one deadline or follow-up date has passed" : undefined,
    reasons.includes("due-soon") ? "a deadline or follow-up is due within days" : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(", and ");
  return `${standing}\n\nTake stock first: ${why}. Before starting the request, briefly summarize where this work stands from ${WORK_STATUS_FILE_NAME} — current status, open follow-ups, and deadlines with their dates — then ask the person what has happened since and what they need to follow up on. Update ${WORK_STATUS_FILE_NAME} with their answer before continuing with the request.`;
}

export class WorkTurnServiceError extends Error {
  override readonly name = "WorkTurnServiceError";
  constructor(
    readonly failure: {
      readonly category:
        | "invalid"
        | "unauthorized"
        | "unavailable"
        | "unsupported"
        | "interrupted"
        | "failed"
        | "stale";
      readonly message: string;
    },
  ) {
    super(failure.message);
  }
}

export interface WorkTurnServiceDependencies {
  readonly persistence: {
    readonly status: () => { readonly state: string; readonly integrity: string };
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
          readonly actor: { readonly kind: "local-user"; readonly actorId: string };
          readonly occurredAt: string;
          readonly payload: unknown;
        }>;
      }) => void;
    };
  };
  readonly threads: {
    readonly bootstrap: (windowId: WindowId) => Promise<{
      readonly threads: ReadonlyArray<WorkThread>;
    }>;
    readonly read: (windowId: WindowId, threadId: WorkThreadId) => Promise<WorkThread | undefined>;
  };
  readonly projects: {
    readonly bootstrap: (windowId: WindowId) => Promise<{
      readonly active: ReadonlyArray<{
        readonly id: ProjectId;
        readonly type: string;
        readonly lifecycle: string;
      }>;
    }>;
  };
  readonly projection: WorkTurnProjection;
  readonly workingDirectories: {
    readonly resolve: (
      authoritativeRoot: string,
      workingDirectory: ThreadWorkingDirectory,
    ) => Promise<string>;
  };
  readonly resolveDriver: (
    providerInstanceId: WorkThread["providerInstanceId"],
  ) => ProviderDriver | undefined;
  readonly attachments?: WorkAttachmentStore;
  /**
   * Whether the selected provider and model honestly accept images. The host
   * refuses a turn that names attachments when this is false, rather than
   * sending the prompt with its pictures quietly removed.
   */
  readonly supportsAttachments?: (input: {
    readonly providerInstanceId: WorkThread["providerInstanceId"];
    readonly modelId: WorkThread["modelId"];
  }) => boolean;
  readonly turnRuntime?: WorkTurnRuntimePort;
  /**
   * The app-managed tools a Work turn may offer its provider. Absent on a host
   * that composes none, which sends the turn with no tools rather than
   * pretending a provider can reach the folder.
   */
  readonly resolveAppManagedTools?: (input: {
    readonly thread: WorkThread;
    readonly projectRoot: string;
    readonly windowId: WindowId;
    readonly computerUseSelection?: import("@octant/contracts/extensions").ExtensionSelection;
  }) => AppManagedToolSet | undefined;
  /** The harness around a turn: stable instructions in front, the reply observed after. */
  /**
   * A person asked the thread for a turn. Fires once the thread and its
   * Project are known to be reachable from this window and before the turn
   * starts, so a completed or snoozed thread comes back the moment it is
   * spoken to. A throw refuses the turn: a thread left completed or snoozed
   * while its turn ran would be a half-applied state.
   */
  readonly onTurnRequested?: (threadId: WorkThreadId) => void;
  readonly spendCeiling?: {
    readonly admit: SpendCeilingService["admit"];
    readonly settle: SpendCeilingService["settle"];
  };
  readonly nativeHarness?: {
    readonly contextFor: (scope: NativeHarnessTurnScope) => ReadonlyArray<ProviderContextBlock>;
    /** Absent means every turn is admitted. */
    readonly admitTurn?: (scope: NativeHarnessTurnScope) => NativeHarnessTurnAdmission;
    readonly turnStarted: (scope: NativeHarnessTurnScope) => void;
    readonly turnCompleted: (
      input: NativeHarnessTurnScope & { readonly text: string; readonly toolCalls: number },
    ) => Promise<void>;
  };
  /**
   * Watches the bound folder for the length of a turn. Absent on a host that
   * cannot watch, which records no written files rather than guessing at them.
   */
  readonly turnFileObserver?: WorkTurnFileObserver;
  /**
   * The Project's `AGENTS.md` and `STATUS.md` (`docs/decisions/0118`). Absent
   * on a host that keeps no brief files, which sends the turn with only its
   * own transcript as before.
   */
  readonly projectStatusFiles?: WorkProjectStatusFiles;
  /** Days before a status counts as stale and a new task opens by taking stock. */
  readonly statusStaleAfterDays?: number;
  /**
   * Resolves the `#thread` mentions a Work turn names. Absent on a host that
   * cannot re-derive Open authority, which reports every mention unread rather
   * than inventing transcript.
   */
  readonly resolveThreadMentionContext?: (input: {
    readonly threadMentionIds: ReadonlyArray<MentionableThreadId>;
    readonly windowId: WindowId;
  }) => Promise<ReadonlyArray<ProviderContextBlock>>;
  /**
   * Resolves the `@file` mentions a Work turn names against the bound Project
   * root. Out-of-root paths are refused before any read.
   */
  readonly resolveFileMentionContext?: (input: {
    readonly fileMentionPaths: ReadonlyArray<string>;
    readonly windowId: WindowId;
    readonly threadId: WorkThreadId;
  }) => Promise<ReadonlyArray<ProviderContextBlock>>;
  readonly takeIssueContextFramed?: (threadId: string) => FramedExternalContent | undefined;
  readonly peekIssueContextFramed?: (threadId: string) => FramedExternalContent | undefined;
  readonly consumeIssueContextFramed?: (threadId: string) => void;
  readonly uuid: () => string;
  readonly clock: () => string;
  readonly expectedHostId?: string;
  /**
   * Token budget the Work turn planner uses. Tests inject a tight budget to
   * prove oversized file mentions refuse; production uses the conservative
   * default until this thread's model reports a window.
   */
  readonly safeInputBudgetTokens?: number;
  readonly liveUpdates?: WorkTurnLiveStore;
}

export class WorkTurnService {
  readonly #persistence: WorkTurnServiceDependencies["persistence"];
  readonly #threads: WorkTurnServiceDependencies["threads"];
  readonly #projects: WorkTurnServiceDependencies["projects"];
  readonly #projection: WorkTurnProjection;
  readonly #workingDirectories: WorkTurnServiceDependencies["workingDirectories"];
  readonly #resolveDriver: WorkTurnServiceDependencies["resolveDriver"];
  readonly #attachments: WorkAttachmentStore | undefined;
  readonly #supportsAttachments: WorkTurnServiceDependencies["supportsAttachments"];
  readonly #turnRuntime: WorkTurnRuntimePort;
  readonly #resolveAppManagedTools: WorkTurnServiceDependencies["resolveAppManagedTools"];
  readonly #nativeHarness: WorkTurnServiceDependencies["nativeHarness"];
  readonly #spendCeiling: WorkTurnServiceDependencies["spendCeiling"];
  readonly #spendReservations = new Map<
    string,
    ReturnType<typeof decodeSpendCeilingReservationId>
  >();
  readonly #onTurnRequested: WorkTurnServiceDependencies["onTurnRequested"];
  readonly #turnFileObserver: WorkTurnFileObserver | undefined;
  readonly #projectStatusFiles: WorkProjectStatusFiles | undefined;
  readonly #statusStaleAfterDays: number;
  readonly #resolveThreadMentionContext: WorkTurnServiceDependencies["resolveThreadMentionContext"];
  readonly #resolveFileMentionContext: WorkTurnServiceDependencies["resolveFileMentionContext"];
  readonly #takeIssueContextFramed: WorkTurnServiceDependencies["takeIssueContextFramed"];
  readonly #peekIssueContextFramed: WorkTurnServiceDependencies["peekIssueContextFramed"];
  readonly #consumeIssueContextFramed: WorkTurnServiceDependencies["consumeIssueContextFramed"];
  readonly #uuid: () => string;
  readonly #clock: () => string;
  readonly #expectedHostId: string;
  readonly #safeInputBudgetTokens: number;
  readonly #liveUpdates: WorkTurnLiveStore;
  readonly #controllers = new Map<string, AbortController>();
  readonly #inflight = new Map<string, Promise<void>>();
  readonly #liveResponses = new Map<string, string>();
  readonly #liveTasks = new Map<string, ThreadTaskProgressList>();

  constructor(dependencies: WorkTurnServiceDependencies) {
    this.#persistence = dependencies.persistence;
    this.#threads = dependencies.threads;
    this.#projects = dependencies.projects;
    this.#projection = dependencies.projection;
    this.#workingDirectories = dependencies.workingDirectories;
    this.#resolveDriver = dependencies.resolveDriver;
    this.#attachments = dependencies.attachments;
    this.#supportsAttachments = dependencies.supportsAttachments;
    this.#turnRuntime = dependencies.turnRuntime ?? new WorkTurnRuntime();
    this.#resolveAppManagedTools = dependencies.resolveAppManagedTools;
    this.#nativeHarness = dependencies.nativeHarness;
    this.#spendCeiling = dependencies.spendCeiling;
    this.#onTurnRequested = dependencies.onTurnRequested;
    this.#turnFileObserver = dependencies.turnFileObserver;
    this.#projectStatusFiles = dependencies.projectStatusFiles;
    this.#statusStaleAfterDays =
      dependencies.statusStaleAfterDays ?? DEFAULT_WORK_STATUS_STALE_AFTER_DAYS;
    this.#resolveThreadMentionContext = dependencies.resolveThreadMentionContext;
    this.#resolveFileMentionContext = dependencies.resolveFileMentionContext;
    if (dependencies.takeIssueContextFramed !== undefined) {
      this.#takeIssueContextFramed = dependencies.takeIssueContextFramed;
    }
    if (dependencies.peekIssueContextFramed !== undefined) {
      this.#peekIssueContextFramed = dependencies.peekIssueContextFramed;
    }
    if (dependencies.consumeIssueContextFramed !== undefined) {
      this.#consumeIssueContextFramed = dependencies.consumeIssueContextFramed;
    }
    this.#uuid = dependencies.uuid;
    this.#clock = dependencies.clock;
    this.#expectedHostId = dependencies.expectedHostId ?? "local";
    this.#safeInputBudgetTokens = dependencies.safeInputBudgetTokens ?? WORK_TURN_SAFE_INPUT_TOKENS;
    this.#liveUpdates = dependencies.liveUpdates ?? new WorkTurnLiveStore();
  }

  async startFirstTurn(
    authenticatedWindowId: WindowId,
    input: unknown,
  ): Promise<WorkTurnLookupResult> {
    this.#assertReady();
    const command = decodeStartWorkThreadTurnCommand(input);
    const existing = this.#projection.lookup(command.requestId);
    if (existing !== undefined) {
      return this.#lookupMatching(command, existing);
    }

    const thread = await this.#threads.read(authenticatedWindowId, command.threadId);
    const admission =
      thread === undefined
        ? undefined
        : this.#nativeHarness?.admitTurn?.({
            threadId: String(thread.id),
            mode: "work",
            providerInstanceId: thread.providerInstanceId,
            modelId: thread.modelId,
            projectId: thread.projectId,
          });
    if (admission?.kind === "paused") {
      throw this.#failure(
        "unavailable",
        `${admission.status === "paused-by-advisor" ? "The advisor paused this thread" : "This thread is paused"}: ${admission.detail} Resume the harness session to continue.`,
      );
    }
    const projectBootstrap = await this.#projects.bootstrap(authenticatedWindowId);
    const accessible = projectBootstrap.active.some(
      (project) =>
        project.type === "work" &&
        project.lifecycle === "active" &&
        String(project.id) === String(command.authority.projectId),
    );
    if (!accessible) {
      throw this.#failure("unauthorized", "Work Project is unavailable for this window.");
    }
    if (thread !== undefined) this.#onTurnRequested?.(thread.id);
    const project = this.#persistence.readProject(command.authority.projectId);
    const decision = decideWorkTurnAuthority({
      authority: command.authority,
      expectedHostId: this.#expectedHostId,
      project:
        project === undefined
          ? undefined
          : {
              type: project.type,
              lifecycle: project.lifecycle,
              bindingHistory: project.type === "work" ? project.bindingHistory : [],
              binding:
                project.type === "work"
                  ? { canonicalRoot: project.binding.canonicalRoot }
                  : { canonicalRoot: "" },
            },
      thread:
        thread === undefined
          ? undefined
          : {
              projectId: String(thread.projectId),
              lifecycle: thread.lifecycle,
              providerInstanceId: String(thread.providerInstanceId),
              modelId: String(thread.modelId),
              bindingRevisionId:
                thread.bindingRevisionId === undefined
                  ? undefined
                  : String(thread.bindingRevisionId),
              workingDirectory:
                thread.workingDirectory === undefined ? undefined : String(thread.workingDirectory),
            },
    });
    if (decision.kind === "deny") {
      throw this.#failure(decision.category, decision.message);
    }
    if (project?.type !== "work") {
      throw this.#failure("unauthorized", "Work Project is unavailable for this turn.");
    }

    let projectRoot: string;
    try {
      projectRoot = await this.#workingDirectories.resolve(
        project.binding.canonicalRoot,
        command.authority.workingDirectory,
      );
    } catch {
      throw this.#failure("invalid", "Work working directory is unavailable.");
    }

    const provider = this.#persistence.readProviderInstance(command.authority.providerInstanceId);
    if (provider === undefined || !provider.enabled) {
      throw this.#failure("unavailable", "Selected Work provider is unavailable.");
    }
    const driver = this.#resolveDriver(command.authority.providerInstanceId);
    if (driver === undefined) {
      throw this.#failure("unavailable", "Selected provider cannot start a Work turn.");
    }

    const starting = this.#startingAttachments(command.threadId, command.attachmentIds);
    if (starting.status === "unknown") {
      throw this.#failure("invalid", "An image attached to this turn is no longer staged.");
    }
    if (starting.attachments.length > 0 && !this.#modelReadsImages(command.authority)) {
      throw this.#failure(
        "unsupported",
        "The selected model does not support images. Choose a vision model, or remove the attachments.",
      );
    }
    const attachmentInputs = await this.#attachmentInputs(command.threadId, starting.attachments);
    if (attachmentInputs === undefined) {
      throw this.#failure("unavailable", "An image attached to this turn is unavailable.");
    }

    const acceptedAt = decodeTimestamp(this.#clock());
    const providerSessionId = decodeProviderSessionId(this.#uuid());
    const planned = planWorkTurnContext({
      threadId: command.threadId,
      providerInstanceId: command.authority.providerInstanceId,
      modelId: command.authority.modelId,
      uuid: this.#uuid,
      createdAt: this.#clock(),
      safeInputBudget: this.#safeInputBudgetTokens,
      contributions: [
        ...(await this.#projectBriefContributions(project, command.threadId)),
        ...this.#priorTranscriptContributions(command.threadId),
        ...(await this.#threadMentionContributions(
          command.threadMentionIds,
          authenticatedWindowId,
        )),
        ...(await this.#fileMentionContributions(
          command.fileMentionPaths,
          authenticatedWindowId,
          command.threadId,
        )),
        ...this.#issueContextContribution(command.threadId),
        {
          text: command.prompt,
          sourceKind: "message",
          referenceId: `prompt:${command.turnId}`,
          category: "current-request",
          posture: "required",
          block: { kind: "user-message", text: command.prompt },
        },
      ],
    });
    if (planned.kind === "blocked") {
      throw this.#failure("invalid", planned.message);
    }

    const spendReservationId = decodeSpendCeilingReservationId(this.#uuid());
    const spendAdmission = this.#spendCeiling?.admit({
      reservationId: spendReservationId,
      threadId: String(command.threadId),
      threadType: "work-thread",
      projectId: String(command.authority.projectId),
      turnUpperBoundTokens: this.#safeInputBudgetTokens,
    });
    if (spendAdmission?.status === "refused") {
      throw this.#failure("unavailable", spendAdmission.refusal.message);
    }
    if (spendAdmission !== undefined && spendAdmission.reservedTokens > 0) {
      this.#spendReservations.set(String(command.requestId), spendReservationId);
    }

    try {
      this.#append(command.requestId, 0, "work.turn-accepted@1", {
        kind: "turn-accepted",
        requestId: command.requestId,
        threadId: command.threadId,
        turnId: command.turnId,
        projectId: command.authority.projectId,
        authority: command.authority,
        providerSessionId,
        prompt: command.prompt,
        ...(starting.attachments.length === 0 ? {} : { attachments: starting.attachments }),
        capabilities: WORK_TURN_CAPABILITIES,
        acceptedAt,
      });
    } catch (error) {
      this.#settleSpendReservation(command.requestId);
      if (error instanceof ConcurrencyConflict) {
        const duplicate = this.#projection.lookup(command.requestId);
        if (duplicate !== undefined) return this.#lookupMatching(command, duplicate);
        throw this.#failure("stale", "Work turn already exists.");
      }
      throw this.#mapFailure(error);
    }
    this.#consumeIssueContextFramed?.(String(command.threadId));

    const accepted = this.#projection.lookup(command.requestId);
    if (accepted === undefined) {
      this.#settleSpendReservation(command.requestId);
      throw this.#failure("unavailable", "Work turn acceptance could not be projected.");
    }
    if (starting.attachments.length > 0) {
      this.#attachments?.release(
        command.threadId,
        starting.attachments.map((attachment) => attachment.attachmentId),
      );
    }

    const controller = new AbortController();
    this.#controllers.set(String(command.requestId), controller);
    const launch = this.#runTurn({
      command,
      ...(thread === undefined ? {} : { thread }),
      windowId: authenticatedWindowId,
      providerSessionId,
      projectRoot,
      projectCanonicalRoot: project.binding.canonicalRoot,
      driver,
      attachments: attachmentInputs,
      context: planned.context,
      signal: controller.signal,
    }).finally(() => {
      this.#settleSpendReservation(command.requestId);
      this.#controllers.delete(String(command.requestId));
      this.#inflight.delete(String(command.requestId));
      this.#liveResponses.delete(String(command.requestId));
      this.#liveTasks.delete(String(command.requestId));
    });
    this.#inflight.set(String(command.requestId), launch);
    return decodeWorkTurnLookupResult({ kind: "accepted", turn: this.#withLive(accepted) });
  }

  async lookupFirstTurn(
    authenticatedWindowId: WindowId,
    requestIdInput: string,
  ): Promise<WorkTurnLookupResult> {
    this.#assertReady();
    const requestId = decodeWorkTurnRequestId(requestIdInput);
    const turn = this.#projection.lookup(requestId);
    if (turn === undefined) {
      return decodeWorkTurnLookupResult({
        kind: "not-created",
        requestId,
        message: "Work turn was not created.",
      });
    }
    await this.#assertThreadAccess(authenticatedWindowId, turn.threadId, turn.projectId);
    return decodeWorkTurnLookupResult({ kind: "accepted", turn: this.#withLive(turn) });
  }

  async cancelFirstTurn(
    authenticatedWindowId: WindowId,
    input: unknown,
  ): Promise<WorkTurnCancelResult> {
    this.#assertReady();
    const command = decodeCancelWorkTurnCommand(input);
    const turn = this.#projection.lookup(command.requestId);
    if (turn === undefined) {
      throw this.#failure("invalid", "Work turn was not found.");
    }
    await this.#assertThreadAccess(authenticatedWindowId, turn.threadId, turn.projectId);
    if (
      String(turn.threadId) !== String(command.threadId) ||
      String(turn.turnId) !== String(command.turnId)
    ) {
      throw this.#failure("invalid", "Work turn identity does not match.");
    }
    if (turn.status === "completed" || turn.status === "cancelled" || turn.status === "failed") {
      return decodeWorkTurnCancelResult({
        kind: "turn-already-terminal",
        requestId: turn.requestId,
        threadId: turn.threadId,
        turnId: turn.turnId,
        status: turn.status,
      });
    }
    this.#controllers.get(String(command.requestId))?.abort();
    this.#settleSpendReservation(command.requestId);
    this.#persistUpdate(turn, {
      status: "cancelled",
      ...(turn.response === undefined ? {} : { response: turn.response }),
    });
    const cancelled = this.#projection.lookup(turn.requestId);
    if (cancelled !== undefined) this.#liveUpdates.settle(turn.threadId, cancelled);
    return decodeWorkTurnCancelResult({
      kind: "turn-cancelled",
      requestId: turn.requestId,
      threadId: turn.threadId,
      turnId: turn.turnId,
      status: "cancelled",
    });
  }

  async transcript(
    authenticatedWindowId: WindowId,
    threadId: WorkThreadId,
  ): Promise<WorkThreadTranscript> {
    this.#assertReady();
    const thread = await this.#threads.read(authenticatedWindowId, threadId);
    if (thread === undefined) {
      throw this.#failure("unauthorized", "Work thread is unavailable for this window.");
    }
    return decodeWorkThreadTranscript({
      threadId,
      turns: this.#projection.listForThread(threadId).map((turn) => this.#withLive(turn)),
      liveCursor: this.#liveUpdates.head(threadId),
    });
  }

  async *subscribe(
    authenticatedWindowId: WindowId,
    threadId: WorkThreadId,
    afterSequence: number,
    signal: AbortSignal,
  ): AsyncGenerator<WorkTurnStreamFrame> {
    this.#assertReady();
    const thread = await this.#threads.read(authenticatedWindowId, threadId);
    if (thread === undefined) {
      throw this.#failure("unauthorized", "Work thread is unavailable for this window.");
    }
    yield* this.#liveUpdates.subscribe({ threadId, afterSequence, signal });
  }

  closeLiveUpdates(): void {
    this.#liveUpdates.close();
  }

  #withLive(turn: WorkTurnState): WorkTurnState {
    const live = this.#liveResponses.get(String(turn.requestId));
    if (live === undefined || turn.status === "completed" || turn.status === "cancelled") {
      return turn;
    }
    return decodeWorkTurnState({
      ...turn,
      status: turn.status === "accepted" ? "running" : turn.status,
      response: live,
      transcript: [
        { role: "user", text: turn.prompt },
        { role: "assistant", text: live, status: "running" },
      ],
    });
  }

  async #runTurn(input: {
    readonly command: ReturnType<typeof decodeStartWorkThreadTurnCommand>;
    readonly thread?: WorkThread;
    readonly windowId: WindowId;
    readonly providerSessionId: ProviderSessionId;
    readonly projectRoot: string;
    /** The Project's bound root, where `STATUS.md` lives; the turn may run in a subfolder. */
    readonly projectCanonicalRoot: string;
    readonly driver: ProviderDriver;
    readonly attachments: ReadonlyArray<ProviderAttachmentInput>;
    readonly context: ReadonlyArray<ProviderContextBlock>;
    readonly signal: AbortSignal;
  }): Promise<void> {
    const current = this.#projection.lookup(input.command.requestId);
    if (current === undefined) return;
    this.#persistUpdate(current, { status: "running" });

    // Watching starts before the provider does, so a file written in the first
    // moments of the turn is seen. The provider writes with its own tools
    // inside the bound folder and never calls the mutation service, so this is
    // the only way the host learns what a turn produced.
    const observation = this.#turnFileObserver?.observe(input.projectRoot);

    const appManagedTools =
      input.thread === undefined
        ? undefined
        : this.#resolveAppManagedTools?.({
            thread: input.thread,
            projectRoot: input.projectRoot,
            windowId: input.windowId,
            ...(input.command.computerUseSelection === undefined
              ? {}
              : { computerUseSelection: input.command.computerUseSelection }),
          });
    if (
      input.command.computerUseSelection !== undefined &&
      !appManagedTools?.definitions.some((definition) => definition.name === "octant_computer")
    ) {
      this.#persistUpdate(current, {
        status: "failed",
        failure: {
          category: "unsupported",
          message:
            "Computer use is unavailable for this provider or task. Check Computer use in Settings.",
        },
      });
      return;
    }
    const browserSelections =
      input.command.extensionSelections?.filter(isBrowserUseSelection) ?? [];
    if (
      browserSelections.length > 1 ||
      browserSelections.some((selection) => !validateBrowserUseSelection(selection))
    ) {
      this.#persistUpdate(current, {
        status: "failed",
        failure: { category: "unavailable", message: "Browser selection is invalid or stale." },
      });
      return;
    }
    if (browserSelections.length > 0) {
      if (
        !appManagedTools?.definitions.some((definition) => definition.name === "octant_browser")
      ) {
        this.#persistUpdate(current, {
          status: "failed",
          failure: {
            category: "unsupported",
            message: "The selected Browser is unavailable for this provider or task.",
          },
        });
        return;
      }
      input = {
        ...input,
        context: [...input.context, { kind: "instructions", text: BROWSER_SELECTION_GUIDANCE }],
      };
    }
    // Work does not yet have an approved skill-material resolver. Refuse an
    // explicit skill selection before provider execution instead of silently
    // dropping the instruction the person chose. Host-owned Browser selections
    // remain valid because Browser is already composed through app-managed
    // tools above.
    if (input.command.extensionSelections?.some((selection) => !isBrowserUseSelection(selection))) {
      this.#persistUpdate(current, {
        status: "failed",
        failure: {
          category: "unavailable",
          message: "Selected skill context is unavailable for Work on this host.",
        },
      });
      return;
    }
    const harnessScope: NativeHarnessTurnScope | undefined =
      input.thread === undefined
        ? undefined
        : {
            threadId: String(input.thread.id),
            mode: "work",
            providerInstanceId: input.thread.providerInstanceId,
            modelId: input.thread.modelId,
            projectId: input.thread.projectId,
          };
    if (harnessScope !== undefined) this.#nativeHarness?.turnStarted(harnessScope);
    const harnessContext =
      harnessScope === undefined ? [] : (this.#nativeHarness?.contextFor(harnessScope) ?? []);
    const outcome = await this.#turnRuntime.run({
      command: input.command,
      providerSessionId: input.providerSessionId,
      projectRoot: input.projectRoot,
      driver: input.driver,
      signal: input.signal,
      ...(appManagedTools === undefined ? {} : { appManagedTools }),
      ...(input.attachments.length === 0 ? {} : { attachments: input.attachments }),
      ...(harnessContext.length + input.context.length === 0
        ? {}
        : { context: [...harnessContext, ...input.context] }),
      onDelta: (response) => {
        const projected = this.#projection.lookup(input.command.requestId);
        if (
          input.signal.aborted ||
          (projected?.status !== "accepted" && projected?.status !== "running")
        ) {
          return;
        }
        const previous = this.#liveResponses.get(String(input.command.requestId)) ?? "";
        this.#liveResponses.set(String(input.command.requestId), response);
        const delta = response.startsWith(previous) ? response.slice(previous.length) : response;
        this.#liveUpdates.appendResponse(input.command.threadId, input.command.requestId, delta);
      },
      onTasks: (tasks) => {
        if (input.signal.aborted) return;
        this.#liveTasks.set(String(input.command.requestId), tasks);
        this.#liveUpdates.appendTasks(input.command.threadId, input.command.requestId, tasks);
      },
    });
    const wroteFiles = observation?.finish();
    const latest = this.#projection.lookup(input.command.requestId);
    if (latest === undefined) return;
    if (latest.status === "cancelled") {
      // Cancelling settles the turn, but files the provider wrote before it
      // stopped are still on disk. Returning without recording them told the
      // person the folder was untouched when it was not.
      if (wroteFiles !== undefined) {
        const settledTasks = this.#liveTasks.get(String(input.command.requestId));
        this.#persistUpdate(latest, {
          status: "cancelled",
          ...(latest.response === undefined ? {} : { response: latest.response }),
          wroteFiles,
          ...(settledTasks === undefined ? {} : { tasks: settledTasks }),
        });
        const settledCancel = this.#projection.lookup(input.command.requestId);
        if (settledCancel !== undefined) {
          this.#liveUpdates.settle(input.command.threadId, settledCancel);
        }
      }
      return;
    }
    if (
      outcome.kind === "completed" &&
      harnessScope !== undefined &&
      this.#nativeHarness !== undefined
    ) {
      await this.#nativeHarness
        .turnCompleted({ ...harnessScope, text: outcome.response, toolCalls: 0 })
        .catch(() => undefined);
    }
    const live = this.#liveResponses.get(String(input.command.requestId));
    this.#persistOutcome(
      live === undefined ? latest : decodeWorkTurnState({ ...latest, response: live }),
      outcome,
      wroteFiles,
      this.#liveTasks.get(String(input.command.requestId)),
    );
    if (outcome.kind === "completed" && wroteFiles !== undefined) {
      await this.#backfillStatus(input.projectCanonicalRoot, input.thread, wroteFiles);
    }
    const settled = this.#projection.lookup(input.command.requestId);
    if (settled !== undefined) this.#liveUpdates.settle(input.command.threadId, settled);
  }

  #settleSpendReservation(requestId: WorkTurnRequestId | string): void {
    const reservationId = this.#spendReservations.get(String(requestId));
    if (reservationId === undefined) return;
    this.#spendReservations.delete(String(requestId));
    this.#spendCeiling?.settle({ reservationId });
  }

  #issueContextContribution(threadId: WorkThreadId): ReadonlyArray<WorkTurnContextContribution> {
    const framed =
      this.#peekIssueContextFramed?.(String(threadId)) ??
      this.#takeIssueContextFramed?.(String(threadId));
    if (framed === undefined) return [];
    return [
      {
        text: framed.text,
        sourceKind: "message",
        referenceId: `github-issue:${String(threadId)}`,
        category: "workspace-context",
        posture: "required",
        block: { kind: "user-message", text: framed.text },
      },
    ];
  }

  /**
   * The Project's brief, ahead of everything the thread itself remembers.
   *
   * `AGENTS.md` and `STATUS.md` are read from the bound root on every turn, so
   * a task started two weeks later knows where the work stands without the
   * person re-explaining. A Project that has neither file gets them seeded
   * here, on its first task, so an older Project joins without a migration.
   * When the status is stale or a dated line is overdue or near, the turn is
   * also told to take stock first — summarize, ask what happened, update the
   * file — before doing what it was asked.
   */
  async #projectBriefContributions(
    project: Extract<Project, { readonly type: "work" }>,
    threadId: WorkThreadId,
  ): Promise<ReadonlyArray<WorkTurnContextContribution>> {
    const files = this.#projectStatusFiles;
    if (files === undefined) return [];
    const root = project.binding.canonicalRoot;
    const today = this.#today();
    try {
      await files.seed(root, project.name, today);
    } catch {
      // A folder that refuses the seed still gets whatever it already has.
    }
    let snapshot;
    try {
      snapshot = await files.read(root);
    } catch {
      return [];
    }
    const contributions: WorkTurnContextContribution[] = [];
    const fileBlock = (name: string, text: string): WorkTurnContextContribution => ({
      text,
      sourceKind: "file",
      referenceId: `project-brief:${name}:${String(threadId)}`,
      category: "workspace-context",
      posture: "compressible",
      block: {
        kind: "user-message",
        text: `Contents of ${name} at the top of this Project's folder:\n\n${text}`,
      },
    });
    if (snapshot.agents !== undefined) {
      contributions.push(fileBlock(WORK_AGENTS_FILE_NAME, snapshot.agents.text));
    }
    if (snapshot.status !== undefined) {
      contributions.push(fileBlock(WORK_STATUS_FILE_NAME, snapshot.status.text));
    }
    const instruction = statusUpkeepInstruction(
      snapshot.status === undefined
        ? []
        : decideWorkResumeBrief(
            parseWorkStatus(snapshot.status.text, today),
            today,
            this.#statusStaleAfterDays,
          ),
    );
    contributions.push({
      text: instruction,
      sourceKind: "instruction",
      referenceId: `project-brief:instruction:${String(threadId)}`,
      category: "octant-policy",
      posture: "required",
      block: { kind: "instructions", text: instruction },
    });
    return contributions;
  }

  /**
   * When a turn changed files but left `STATUS.md` alone, record the change
   * there itself. Octant asserts only what it observed — which paths, in which
   * task — never what the change meant; that sentence is the agent's or the
   * person's to write.
   */
  async #backfillStatus(
    canonicalRoot: string,
    thread: WorkThread | undefined,
    wroteFiles: WorkTurnWrittenFiles,
  ): Promise<void> {
    const files = this.#projectStatusFiles;
    if (files === undefined) return;
    const changed = wroteFiles.paths.filter((path) => path !== WORK_STATUS_FILE_NAME);
    if (changed.length === 0 || wroteFiles.paths.includes(WORK_STATUS_FILE_NAME)) return;
    try {
      await files.appendRecentChange(canonicalRoot, {
        date: this.#today(),
        taskTitle: thread?.title ?? "Task",
        paths: changed,
        truncated: wroteFiles.truncated,
      });
    } catch {
      // The turn already happened; a status file that cannot be written is
      // reported by its absence on the Project page, not by failing the turn.
    }
  }

  #today() {
    const date = this.#clock().slice(0, 10);
    if (!isWorkStatusDate(date)) throw new Error("Host clock did not produce a calendar date.");
    return date;
  }

  #priorTranscriptContributions(
    threadId: WorkThreadId,
  ): ReadonlyArray<WorkTurnContextContribution> {
    const contributions: WorkTurnContextContribution[] = [];
    for (const turn of this.#projection.listForThread(threadId)) {
      for (const [index, entry] of turn.transcript.entries()) {
        if (entry.text.trim() === "") continue;
        contributions.push({
          text: entry.text,
          sourceKind: "message",
          referenceId: `${String(turn.requestId)}:${entry.role}:${String(index)}`,
          category: "conversation",
          posture: "compressible",
          block: {
            kind: entry.role === "assistant" ? "assistant-message" : "user-message",
            text: entry.text,
          },
        });
      }
    }
    return contributions;
  }

  async #threadMentionContributions(
    threadMentionIds: ReadonlyArray<MentionableThreadId> | undefined,
    windowId: WindowId,
  ): Promise<ReadonlyArray<WorkTurnContextContribution>> {
    if (threadMentionIds === undefined || threadMentionIds.length === 0) return [];
    const unreadable = (): ReadonlyArray<WorkTurnContextContribution> =>
      threadMentionIds.map((threadId, index) => ({
        text: THREAD_MENTION_UNREADABLE_CONTEXT,
        sourceKind: "message",
        referenceId: `thread-mention-unread:${String(threadId)}:${String(index)}`,
        category: "workspace-context",
        posture: "compressible",
        block: { kind: "user-message", text: THREAD_MENTION_UNREADABLE_CONTEXT },
      }));
    const resolve = this.#resolveThreadMentionContext;
    if (resolve === undefined) return unreadable();
    try {
      const blocks = await resolve({ threadMentionIds, windowId });
      return blocks.map((block, index) => ({
        text: block.text,
        sourceKind: "message",
        referenceId: `thread-mention:${String(threadMentionIds[index] ?? index)}`,
        category: "workspace-context",
        posture: "compressible",
        block,
      }));
    } catch {
      return unreadable();
    }
  }

  async #fileMentionContributions(
    fileMentionPaths: ReadonlyArray<string> | undefined,
    windowId: WindowId,
    threadId: WorkThreadId,
  ): Promise<ReadonlyArray<WorkTurnContextContribution>> {
    if (fileMentionPaths === undefined || fileMentionPaths.length === 0) return [];
    const unreadable = (): ReadonlyArray<WorkTurnContextContribution> =>
      fileMentionPaths.map((path, index) => ({
        text: FILE_MENTION_UNREADABLE_CONTEXT,
        sourceKind: "file",
        referenceId: `file-mention-unread:${path}:${String(index)}`,
        category: "workspace-context",
        posture: "required",
        block: { kind: "user-message", text: FILE_MENTION_UNREADABLE_CONTEXT },
      }));
    const resolve = this.#resolveFileMentionContext;
    if (resolve === undefined) return unreadable();
    try {
      const blocks = await resolve({ fileMentionPaths, windowId, threadId });
      return blocks.map((block, index) => ({
        text: block.text,
        sourceKind: "file",
        referenceId: `file-mention:${fileMentionPaths[index] ?? String(index)}`,
        category: "workspace-context",
        posture: "required",
        block,
      }));
    } catch {
      return unreadable();
    }
  }

  #persistOutcome(
    turn: WorkTurnState,
    outcome: WorkTurnRuntimeOutcome,
    // Recorded on every settled outcome, not only a completed one: a turn that
    // failed or was interrupted may still have written a file, and leaving that
    // out would tell the person the folder is untouched when it is not.
    wroteFiles?: WorkTurnWrittenFiles,
    // The provider's task list survived only in process-local state while the
    // turn ran; settling is the last chance to journal it for replay.
    tasks?: ThreadTaskProgressList,
  ): void {
    const written = wroteFiles === undefined ? {} : { wroteFiles };
    const recordedTasks = tasks === undefined ? {} : { tasks };
    if (outcome.kind === "completed") {
      this.#persistUpdate(turn, {
        status: "completed",
        response: outcome.response,
        ...written,
        ...recordedTasks,
      });
      return;
    }
    if (outcome.kind === "cancelled") {
      this.#persistUpdate(turn, {
        status: "cancelled",
        ...(turn.response === undefined ? {} : { response: turn.response }),
        ...written,
        ...recordedTasks,
      });
      return;
    }
    this.#persistUpdate(turn, {
      status: outcome.kind === "waiting" ? "waiting" : "failed",
      ...(turn.response === undefined ? {} : { response: turn.response }),
      ...written,
      ...recordedTasks,
      failure: outcome.failure,
    });
  }

  #persistUpdate(
    turn: WorkTurnState,
    update: {
      readonly status: "running" | "completed" | "cancelled" | "failed" | "waiting";
      readonly response?: string;
      readonly wroteFiles?: WorkTurnWrittenFiles;
      readonly failure?: WorkTurnState["failure"];
      readonly tasks?: ThreadTaskProgressList;
    },
  ): void {
    const latest = this.#projection.lookup(turn.requestId) ?? turn;
    const updatedAt = decodeTimestamp(this.#clock());
    const response = update.response ?? latest.response;
    const tasks = update.tasks ?? latest.tasks;
    const transcript = [
      { role: "user" as const, text: latest.prompt },
      ...(response === undefined && update.status === "running"
        ? [{ role: "assistant" as const, text: "", status: "running" as const }]
        : response === undefined
          ? []
          : [
              {
                role: "assistant" as const,
                text: response,
                status: update.status,
              },
            ]),
    ];
    try {
      this.#append(latest.requestId, latest.version, "work.turn-updated@1", {
        kind: "turn-updated",
        requestId: latest.requestId,
        threadId: latest.threadId,
        turnId: latest.turnId,
        status: update.status,
        ...(response === undefined ? {} : { response }),
        transcript,
        ...(update.wroteFiles === undefined ? {} : { wroteFiles: update.wroteFiles }),
        ...(update.failure === undefined ? {} : { failure: update.failure }),
        ...(tasks === undefined ? {} : { tasks }),
        updatedAt,
      });
    } catch {
      // Projection/journal failures after acceptance are retained as waiting so
      // reconnect can surface an honest interrupted/recovery state.
    }
  }

  #append(
    requestId: WorkTurnRequestId,
    expectedVersion: number,
    eventName: "work.turn-accepted@1" | "work.turn-updated@1",
    payload: unknown,
  ): void {
    this.#persistence.journal.append({
      aggregate: {
        aggregateType: "work-turn",
        aggregateId: String(requestId),
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
    if (eventName === "work.turn-accepted@1") {
      this.#projection.apply(payload as never);
    } else {
      this.#projection.apply(payload as never);
    }
  }

  #lookupMatching(
    command: ReturnType<typeof decodeStartWorkThreadTurnCommand>,
    existing: WorkTurnState,
  ): WorkTurnLookupResult {
    if (
      String(existing.threadId) !== String(command.threadId) ||
      String(existing.turnId) !== String(command.turnId) ||
      existing.prompt !== command.prompt ||
      !sameAttachmentIds(existing.attachments, command.attachmentIds)
    ) {
      throw this.#failure("stale", "Work turn request identity conflict.");
    }
    return decodeWorkTurnLookupResult({ kind: "accepted", turn: existing });
  }

  /**
   * Accept one image for a thread's next turn.
   *
   * Authority is the thread's own: whoever may send this thread a turn may
   * attach a picture to it. Nothing the renderer claims about the bytes is
   * kept — the store re-derives the name, size, and digest the journal will
   * later record from what it actually wrote.
   */
  async stageAttachment(
    authenticatedWindowId: WindowId,
    input: {
      readonly threadId: WorkThreadId;
      readonly attachmentId: WorkAttachmentId;
      readonly displayName: string;
      readonly mediaType: WorkAttachmentMediaType;
      readonly bytes: Uint8Array;
      readonly signal?: AbortSignal;
    },
  ): Promise<WorkAttachmentReference> {
    const attachments = await this.#authorizeAttachment(authenticatedWindowId, input.threadId);
    try {
      return await attachments.stage(input);
    } catch (error) {
      throw this.#failure(
        error instanceof WorkAttachmentTooLarge || error instanceof WorkAttachmentInvalid
          ? "invalid"
          : "failed",
        error instanceof WorkAttachmentTooLarge || error instanceof WorkAttachmentInvalid
          ? error.message
          : "Work attachment could not be staged.",
      );
    }
  }

  async discardAttachment(
    authenticatedWindowId: WindowId,
    threadId: WorkThreadId,
    attachmentId: WorkAttachmentId,
  ): Promise<void> {
    const attachments = await this.#authorizeAttachment(authenticatedWindowId, threadId);
    try {
      await attachments.discard(threadId, attachmentId);
    } catch {
      throw this.#failure("failed", "Work attachment could not be discarded.");
    }
  }

  async #authorizeAttachment(
    authenticatedWindowId: WindowId,
    threadId: WorkThreadId,
  ): Promise<WorkAttachmentStore> {
    this.#assertReady();
    const thread = await this.#threads.read(authenticatedWindowId, threadId);
    if (thread === undefined) {
      throw this.#failure("unauthorized", "Work thread is unavailable for this window.");
    }
    if (this.#attachments === undefined) {
      throw this.#failure("unavailable", "Work attachments are unavailable.");
    }
    return this.#attachments;
  }

  #startingAttachments(
    threadId: WorkThreadId,
    attachmentIds: ReadonlyArray<WorkAttachmentId> | undefined,
  ):
    | { readonly status: "ok"; readonly attachments: ReadonlyArray<WorkAttachmentReference> }
    | { readonly status: "unknown" } {
    if (attachmentIds === undefined || attachmentIds.length === 0) {
      return { status: "ok", attachments: [] };
    }
    if (this.#attachments === undefined) return { status: "unknown" };
    const peeked = this.#attachments.peek(threadId, attachmentIds);
    if (peeked.status !== "ok") return { status: "unknown" };
    return { status: "ok", attachments: peeked.attachments };
  }

  async #attachmentInputs(
    threadId: WorkThreadId,
    references: ReadonlyArray<WorkAttachmentReference>,
  ): Promise<ReadonlyArray<ProviderAttachmentInput> | undefined> {
    if (references.length === 0) return [];
    if (this.#attachments === undefined) return undefined;
    const inputs: ProviderAttachmentInput[] = [];
    for (const reference of references) {
      let bytes: Uint8Array;
      try {
        bytes = await this.#attachments.read(threadId, reference);
      } catch {
        return undefined;
      }
      inputs.push({
        attachmentId: String(reference.attachmentId),
        displayName: reference.displayName,
        mediaType: reference.mediaType,
        bytes,
      });
    }
    return inputs;
  }

  #modelReadsImages(authority: {
    readonly providerInstanceId: WorkThread["providerInstanceId"];
    readonly modelId: WorkThread["modelId"];
  }): boolean {
    return this.#supportsAttachments?.(authority) === true;
  }

  async #assertThreadAccess(
    windowId: WindowId,
    threadId: WorkThreadId,
    projectId: ProjectId,
  ): Promise<void> {
    const thread = await this.#threads.read(windowId, threadId);
    if (thread === undefined || String(thread.projectId) !== String(projectId)) {
      throw this.#failure("unauthorized", "Work turn is unavailable for this window.");
    }
  }

  #assertReady(): void {
    const status = this.#persistence.status();
    if (status.state !== "current" || status.integrity !== "ok") {
      throw this.#failure("unavailable", "Octant Work turn service is unavailable.");
    }
  }

  #mapFailure(error: unknown): WorkTurnServiceError {
    if (error instanceof WorkTurnServiceError) return error;
    if (error instanceof ConcurrencyConflict) {
      return this.#failure("stale", "Work turn changed; reload and retry.");
    }
    if (error instanceof JournalWriteFailed || error instanceof ProjectionApplicationFailed) {
      return this.#failure("unavailable", "Octant Work turn service is unavailable.");
    }
    return this.#failure("unavailable", "Octant Work turn service is unavailable.");
  }

  #failure(
    category: WorkTurnServiceError["failure"]["category"],
    message: string,
  ): WorkTurnServiceError {
    return new WorkTurnServiceError(decodeWorkTurnFailure({ category, message }));
  }
}

function sameAttachmentIds(
  recorded: ReadonlyArray<WorkAttachmentReference> | undefined,
  named: ReadonlyArray<WorkAttachmentId> | undefined,
): boolean {
  const left = recorded?.map((attachment) => String(attachment.attachmentId)) ?? [];
  const right = named?.map((attachmentId) => String(attachmentId)) ?? [];
  if (left.length !== right.length) return false;
  return left.every((id, index) => id === right[index]);
}
