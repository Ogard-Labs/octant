import { createHash } from "node:crypto";
import {
  ActorId,
  AggregateId,
  AggregateVersion,
  CodeDigest,
  CorrelationId,
  EventId,
  PULL_REQUEST_REVIEW_AGGREGATE_TYPES,
  PULL_REQUEST_REVIEW_EVENT_NAMES,
  PullRequestReviewProjectSettingsEvent,
  PullRequestReviewPullRequestSettingsEvent,
  PullRequestReviewRunRecordedEvent,
  PullRequestReviewThreadOverrideEvent,
  UtcTimestamp,
  decodeAgentRunId,
  decodeCodeReviewFindingId,
  decodeProviderSessionId,
  decodePullRequestReviewId,
  decodePullRequestReviewProjectView,
  decodePullRequestReviewPullRequestView,
  decodePullRequestReviewRequest,
  decodePullRequestReviewRunRecord,
  decodePullRequestReviewThreadView,
  type AgentRunId,
  type CodeReviewDiffAnchor,
  type CodeReviewFinding,
  type CodeThread,
  type CodeThreadId,
  type EventActor,
  type ProjectId,
  type ProviderInstanceId,
  type ProviderModelId,
  type PullRequestReviewDiffSnapshot,
  type PullRequestReviewEffectiveConfig,
  type PullRequestReviewFindingProposal,
  type PullRequestReviewOutcome,
  type PullRequestReviewProjectSettings,
  type PullRequestReviewProjectSettingsCommand,
  type PullRequestReviewProjectView,
  type PullRequestReviewPullRequestSettings,
  type PullRequestReviewPullRequestSettingsCommand,
  type PullRequestReviewPullRequestView,
  type PullRequestReviewRoute,
  type PullRequestReviewRunRecord,
  type PullRequestReviewTarget,
  type PullRequestReviewThreadOverride,
  type PullRequestReviewThreadOverrideCommand,
  type PullRequestReviewThreadView,
  type PullRequestReviewTurnRefusalReason,
  type PullRequestReviewerId,
  type TurnUsage,
  type WindowId,
} from "@octant/contracts";
import {
  PULL_REQUEST_REVIEW_STRICT_MAX_HAND_BACK_ATTEMPTS,
  authorizePullRequestReviewSettingChange,
  decidePullRequestReviewHandBack,
  evaluatePullRequestReviewHeadCurrency,
  parseUnifiedDiff,
  pullRequestReviewTargetKey,
  pullRequestReviewerExecutionPolicy,
  resolveEffectivePullRequestReviewConfig,
  shouldStartPullRequestReviewForHead,
  type PrincipalKind,
} from "@octant/domain";
import type {
  PullRequestReviewDiffResult,
  PullRequestReviewHandBackResult,
  PullRequestReviewRecordFindingsResult,
  PullRequestReviewSummaryCommentResult,
  PullRequestReviewTurnInput,
  PullRequestReviewTurnResult,
} from "@octant/plugin-api/pull-request-reviewer";
import type { ProviderDriver } from "@octant/provider-sdk/driver";
import { Effect, Fiber, Schema, Stream } from "effect";
import { deriveCodeFileId } from "../code/codeFileIdentity";
import { retainedReviewTarget, type RetainedCodeReview } from "../code/codeReviewComparison";
import type { EventRegistry } from "../persistence/eventRegistry";
import type { Journal } from "../persistence/journal";
import { replayAggregateTypesInOrder } from "../persistence/journalHydration";
import { subscribeThenSend } from "../providers/providerEventDelivery";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import { decodeSpendCeilingReservationId, type SpendCeilingService } from "../spendCeilingService";
import type { TurnMetricsStore } from "../metrics/turnMetricsStore";
import type { PullRequestReviewerRegistry } from "./pullRequestReviewerRegistry";
import { SECOND_MODEL_PULL_REQUEST_REVIEWER_ID } from "./secondModelPullRequestReviewer";

const decodeActorId = Schema.decodeUnknownSync(ActorId);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeCodeDigest = Schema.decodeUnknownSync(CodeDigest);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

const REVIEW_TURN_TIMEOUT_MS = 120_000;
const MAX_REVIEW_TURN_TEXT_CHARS = 64 * 1024;
const OUTSIDE_CONTENT_SOURCE_LABEL = "pull-request-review";

export function registerPullRequestReviewEvents(registry: EventRegistry): EventRegistry {
  return registry
    .register(
      PULL_REQUEST_REVIEW_EVENT_NAMES.projectSettingsUpdated,
      1,
      PullRequestReviewProjectSettingsEvent,
    )
    .register(
      PULL_REQUEST_REVIEW_EVENT_NAMES.threadOverrideUpdated,
      1,
      PullRequestReviewThreadOverrideEvent,
    )
    .register(
      PULL_REQUEST_REVIEW_EVENT_NAMES.pullRequestSettingsUpdated,
      1,
      PullRequestReviewPullRequestSettingsEvent,
    )
    .register(PULL_REQUEST_REVIEW_EVENT_NAMES.runRecorded, 1, PullRequestReviewRunRecordedEvent);
}

/** Observed PR snapshot fact handed in when PR metadata refreshes or a worker turn settles. */
export interface ObservedPullRequestHead {
  readonly target: PullRequestReviewTarget;
  readonly threadId: CodeThreadId;
  readonly headSha: string;
  readonly baseRef: string;
  readonly baseSha?: string;
  readonly state: "open" | "draft" | "closed" | "merged";
}

export interface PullRequestReviewRouteInspection {
  readonly status: "ready" | "refused";
  readonly driver?: ProviderDriver;
  readonly reason?: PullRequestReviewTurnRefusalReason;
  readonly detail?: string;
}

export interface PullRequestReviewDiffCapture {
  readonly snapshot: PullRequestReviewDiffSnapshot;
  readonly retained?: RetainedCodeReview;
  readonly anchorByPath?: ReadonlyMap<string, CodeReviewDiffAnchor>;
}

export interface PullRequestReviewThreadPort {
  readThread(threadId: CodeThreadId): CodeThread | undefined;
  isWorkerTurnActive(threadId: CodeThreadId): boolean;
  isStrict(threadId: CodeThreadId): boolean;
  maxStrictHandBackAttempts(): number;
  markOutsideContent(
    threadId: CodeThreadId,
    contentReference: string,
    sourceLabel: string,
  ): boolean;
  startWorkerTurn(threadId: CodeThreadId, text: string): Promise<boolean>;
  notifyPerson?(threadId: CodeThreadId, reason: string): Promise<void>;
}

export interface PullRequestReviewAuthorityPort {
  canAccessProject(windowId: WindowId, projectId: ProjectId): boolean | Promise<boolean>;
  authorizePullRequest(
    windowId: WindowId,
    target: PullRequestReviewTarget,
  ): Promise<
    | { readonly status: "authorized"; readonly linkedThreadIds: ReadonlyArray<string> }
    | { readonly status: "not-authorized" }
    | { readonly status: "disconnected" }
  >;
}

export interface PullRequestReviewFindingWriter {
  create(
    input: Omit<CodeReviewFinding, "state" | "version" | "createdAt" | "updatedAt">,
  ): Promise<CodeReviewFinding>;
}

export interface PullRequestReviewTurnExecutionInput {
  readonly route: PullRequestReviewRoute;
  readonly thread: CodeThread;
  readonly prompt: string;
  readonly systemInstructions?: string;
  readonly signal: AbortSignal;
}

export type PullRequestReviewTurnExecutionResult =
  | {
      readonly status: "completed";
      readonly sessionId: string;
      readonly text: string;
      readonly usage?: TurnUsage;
    }
  | {
      readonly status: "refused";
      readonly reason: PullRequestReviewTurnRefusalReason;
      readonly detail: string;
    }
  | { readonly status: "cancelled" }
  | { readonly status: "failed"; readonly detail: string; readonly usage?: TurnUsage };

export interface PullRequestReviewHostRuntimePort {
  readCurrentHeadSha(
    target: PullRequestReviewTarget,
    signal: AbortSignal,
  ): Promise<string | undefined>;
  capturePullRequestDiff(
    input: {
      readonly target: PullRequestReviewTarget;
      readonly thread: CodeThread;
      readonly headSha: string;
      readonly baseRef: string;
      readonly baseSha?: string;
    },
    signal: AbortSignal,
  ): Promise<
    | { readonly status: "ready"; readonly capture: PullRequestReviewDiffCapture }
    | { readonly status: "stale"; readonly currentHeadSha?: string }
    | { readonly status: "unavailable" }
  >;
  inspectRoute(input: {
    readonly route: PullRequestReviewRoute;
    readonly projectId: ProjectId;
  }): PullRequestReviewRouteInspection;
  /** Optional override for tests; production executes directly on the inspected ProviderDriver at Plan's read-only gate. */
  executeReadOnlyTurn?: (
    input: PullRequestReviewTurnExecutionInput,
  ) => Promise<PullRequestReviewTurnExecutionResult>;
  /** Scratch directory outside the Project when executing a read-only turn on a ProviderDriver. */
  readonly scratchRoot: string;
  postSummaryComment(
    input: { readonly target: PullRequestReviewTarget; readonly body: string },
    signal: AbortSignal,
  ): Promise<PullRequestReviewSummaryCommentResult>;
  readonly findings: PullRequestReviewFindingWriter;
  readonly spendCeiling?: Pick<SpendCeilingService, "admit" | "settle" | "abandon">;
  readonly turnMetrics?: Pick<TurnMetricsStore, "record">;
  readonly recordUsage?: (input: {
    readonly threadId: CodeThreadId;
    readonly projectId: ProjectId;
    readonly providerInstanceId: ProviderInstanceId;
    readonly modelId: ProviderModelId;
    readonly usage: TurnUsage;
  }) => void;
}

export type PullRequestReviewSettingResult<TView> =
  | { readonly status: "ok"; readonly view: TView }
  | {
      readonly status: "refused";
      readonly reason: "not-authorized" | "not-found" | "no-route-configured";
      readonly message: string;
    };

interface RunFold {
  version: number;
  readonly records: PullRequestReviewRunRecord[];
  readonly reviewedHeadShas: Set<string>;
  handBackAttempts: number;
}

interface InFlightReview {
  readonly headSha: string;
  readonly abort: AbortController;
}

function localSystemActor(): EventActor {
  return { kind: "system", actorId: decodeActorId(OCTANT_LOCAL_ACTOR_ID) };
}

/** Deterministic RFC 4122 UUID derived from a pull request target key for journal aggregate identity. */
function targetAggregateId(key: string) {
  const bytes = Buffer.from(
    createHash("sha256").update(`pr-review:${key}`).digest().subarray(0, 16),
  );
  const versionByte = bytes[6] ?? 0;
  const variantByte = bytes[8] ?? 0;
  bytes[6] = (versionByte & 0x0f) | 0x50;
  bytes[8] = (variantByte & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return decodeAggregateId(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`,
  );
}

function defaultProjectSettings(projectId: ProjectId): PullRequestReviewProjectSettings {
  return {
    projectId,
    enabled: false,
    postSummaryComment: false,
    version: decodeAggregateVersion(0),
  };
}

function defaultThreadOverride(threadId: CodeThreadId): PullRequestReviewThreadOverride {
  return {
    threadId,
    mode: "inherit",
    version: decodeAggregateVersion(0),
  };
}

function defaultPullRequestSettings(
  target: PullRequestReviewTarget,
): PullRequestReviewPullRequestSettings {
  return {
    target,
    sendBlockingFindingsToWorker: false,
    version: decodeAggregateVersion(0),
  };
}

function formatHandBackTurnText(input: {
  readonly target: PullRequestReviewTarget;
  readonly headSha: string;
  readonly findings: ReadonlyArray<CodeReviewFinding>;
  readonly attempt: number;
  readonly maxStrictAttempts?: number;
}): string {
  const shortSha = input.headSha.slice(0, 7);
  const attemptNote =
    input.maxStrictAttempts === undefined
      ? `Automatic review hand-back attempt ${input.attempt}.`
      : `Automatic review hand-back attempt ${input.attempt} of ${input.maxStrictAttempts}.`;
  const bullets = input.findings.map((finding) => {
    const loc =
      finding.location.kind === "line"
        ? `line ${finding.location.line}`
        : `lines ${finding.location.startLine}-${finding.location.endLine}`;
    return `- [${finding.severity}] ${String(finding.path)} (${loc}): ${finding.summary}`;
  });
  return [
    "Octant rules for this pull request:",
    "- Never force-push or rewrite pushed history.",
    "- Merge the base branch instead of rebasing if needed.",
    "- Verify fixes locally and push a new commit to the pull request branch.",
    "",
    `The second-model pull request reviewer reported ${input.findings.length} blocking ${input.findings.length === 1 ? "finding" : "findings"} on ${String(input.target.repositoryOwner)}/${String(input.target.repositoryName)}#${input.target.number} at head ${shortSha}. ${attemptNote}`,
    "",
    "--- BEGIN OUTSIDE CONTENT (pull-request-review) ---",
    ...bullets,
    "--- END OUTSIDE CONTENT ---",
  ].join("\n");
}

async function runDriverReadOnlyTurn(input: {
  readonly driver: ProviderDriver;
  readonly route: PullRequestReviewRoute;
  readonly scratchRoot: string;
  readonly sessionId: string;
  readonly prompt: string;
  readonly systemInstructions?: string;
  readonly signal: AbortSignal;
}): Promise<PullRequestReviewTurnExecutionResult> {
  const sessionId = decodeProviderSessionId(input.sessionId);
  const modelOptionValues =
    input.route.effort === undefined
      ? undefined
      : { effort: input.route.effort, reasoningEffort: input.route.effort };
  const program = Effect.gen(function* () {
    const connection = yield* input.driver.acquire({
      instanceId: input.route.providerInstanceId,
      projectRoot: input.scratchRoot,
      mode: "code",
    });
    yield* Effect.addFinalizer(() =>
      connection.stop(sessionId).pipe(Effect.catchAll(() => Effect.void)),
    );
    // Plan's read-only gate is enforced regardless of the parent thread's level,
    // with zero tools and single-use isolation.
    yield* connection.start({
      sessionId,
      modelId: input.route.modelId,
      executionPolicy: "plan",
      singleUse: true,
      tools: [],
      ...(modelOptionValues === undefined ? {} : { modelOptionValues }),
    });

    let text = "";
    let completed = false;
    let interrupted = false;
    let failureMessage: string | undefined;
    let usage: TurnUsage | undefined;

    const collected = yield* subscribeThenSend({
      connection,
      consume: (events) =>
        events.pipe(
          Stream.filter((event) => event.sessionId === sessionId),
          Stream.takeUntil(
            (event) =>
              event.kind === "completed" || event.kind === "failed" || event.kind === "interrupted",
          ),
          Stream.runForEach((event) =>
            Effect.sync(() => {
              if (event.kind === "text-delta" && text.length < MAX_REVIEW_TURN_TEXT_CHARS) {
                text += event.text;
              }
              if (event.kind === "completed") completed = true;
              if (event.kind === "interrupted") interrupted = true;
              if (event.kind === "failed") failureMessage = event.failure.message;
              if (event.kind === "usage") {
                usage = {
                  inputTokens: event.inputTokens,
                  outputTokens: event.outputTokens,
                  ...(event.reasoningTokens === undefined
                    ? {}
                    : { reasoningTokens: event.reasoningTokens }),
                  ...(event.cacheReadInputTokens === undefined
                    ? {}
                    : { cacheReadInputTokens: event.cacheReadInputTokens }),
                  ...(event.cacheWriteInputTokens === undefined
                    ? {}
                    : { cacheWriteInputTokens: event.cacheWriteInputTokens }),
                  ...(event.costUsd === undefined ? {} : { costUsd: event.costUsd }),
                };
              }
            }),
          ),
        ),
      send: connection.send({
        sessionId,
        prompt: input.prompt,
        context:
          input.systemInstructions === undefined
            ? []
            : [{ kind: "instructions", text: input.systemInstructions }],
        attachments: [],
        tools: [],
      }),
    });

    yield* Fiber.join(collected);
    if (failureMessage !== undefined) {
      return {
        status: "failed" as const,
        detail: failureMessage,
        ...(usage === undefined ? {} : { usage }),
      };
    }
    if (interrupted) return { status: "cancelled" as const };
    if (!completed) {
      return {
        status: "failed" as const,
        detail: "The reviewer turn ended without completing.",
        ...(usage === undefined ? {} : { usage }),
      };
    }
    return {
      status: "completed" as const,
      sessionId: String(sessionId),
      text,
      ...(usage === undefined ? {} : { usage }),
    };
  });

  if (input.signal.aborted) return { status: "cancelled" };
  try {
    const running = Effect.runPromise(
      Effect.scoped(program).pipe(
        Effect.timeoutTo({
          duration: REVIEW_TURN_TIMEOUT_MS,
          onTimeout: (): PullRequestReviewTurnExecutionResult => ({
            status: "failed",
            detail: "The pull request review turn timed out.",
          }),
          onSuccess: (value: PullRequestReviewTurnExecutionResult) => value,
        }),
      ),
    );
    const aborted = new Promise<PullRequestReviewTurnExecutionResult>((resolve) => {
      if (input.signal.aborted) {
        resolve({ status: "cancelled" });
        return;
      }
      input.signal.addEventListener("abort", () => resolve({ status: "cancelled" }), {
        once: true,
      });
    });
    return await Promise.race([running, aborted]);
  } catch {
    return {
      status: "failed",
      detail: "The configured reviewer provider could not be reached.",
    };
  }
}

export interface PullRequestReviewServiceOptions {
  readonly registry: PullRequestReviewerRegistry;
  readonly journal: Pick<Journal, "append" | "replayAggregateType">;
  readonly authority: PullRequestReviewAuthorityPort;
  readonly threads: PullRequestReviewThreadPort;
  readonly runtime: PullRequestReviewHostRuntimePort;
  readonly uuid: () => string;
  readonly clock?: () => string;
  readonly defaultReviewerId?: PullRequestReviewerId;
}

/**
 * Host service owning journaled pull request reviewer settings, per-head
 * deduplication, host-mediated read-only execution through
 * `PullRequestReviewerRegistry`, spend/metrics accounting, and Review pane
 * status queries.
 */
export class PullRequestReviewService {
  readonly #registry: PullRequestReviewerRegistry;
  readonly #journal: Pick<Journal, "append" | "replayAggregateType">;
  readonly #authority: PullRequestReviewAuthorityPort;
  readonly #threads: PullRequestReviewThreadPort;
  readonly #runtime: PullRequestReviewHostRuntimePort;
  readonly #uuid: () => string;
  readonly #clock: () => string;
  readonly #defaultReviewerId: PullRequestReviewerId;

  readonly #projectSettings = new Map<string, PullRequestReviewProjectSettings>();
  readonly #threadOverrides = new Map<string, PullRequestReviewThreadOverride>();
  readonly #prSettings = new Map<string, PullRequestReviewPullRequestSettings>();
  readonly #runs = new Map<string, RunFold>();
  readonly #latestByThread = new Map<string, PullRequestReviewRunRecord>();
  readonly #inFlightByTarget = new Map<string, InFlightReview>();

  constructor(options: PullRequestReviewServiceOptions) {
    this.#registry = options.registry;
    this.#journal = options.journal;
    this.#authority = options.authority;
    this.#threads = options.threads;
    this.#runtime = options.runtime;
    this.#uuid = options.uuid;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#defaultReviewerId = options.defaultReviewerId ?? SECOND_MODEL_PULL_REQUEST_REVIEWER_ID;
    this.#hydrate();
  }

  #offeredReviewers() {
    return this.#registry.list().map((entry) => ({
      reviewerId: entry.reviewerId,
      displayName: entry.displayName,
    }));
  }

  #projectSettingsFor(projectId: ProjectId): PullRequestReviewProjectSettings {
    return this.#projectSettings.get(String(projectId)) ?? defaultProjectSettings(projectId);
  }

  #threadOverrideFor(threadId: CodeThreadId): PullRequestReviewThreadOverride {
    return this.#threadOverrides.get(String(threadId)) ?? defaultThreadOverride(threadId);
  }

  #prSettingsFor(target: PullRequestReviewTarget): PullRequestReviewPullRequestSettings {
    return (
      this.#prSettings.get(pullRequestReviewTargetKey(target)) ?? defaultPullRequestSettings(target)
    );
  }

  #runFoldFor(target: PullRequestReviewTarget): RunFold {
    const key = pullRequestReviewTargetKey(target);
    const existing = this.#runs.get(key);
    if (existing !== undefined) return existing;
    const created: RunFold = {
      version: 0,
      records: [],
      reviewedHeadShas: new Set<string>(),
      handBackAttempts: 0,
    };
    this.#runs.set(key, created);
    return created;
  }

  #effectiveConfigFor(input: {
    readonly projectId: ProjectId;
    readonly threadId?: CodeThreadId;
    readonly target?: PullRequestReviewTarget;
  }): PullRequestReviewEffectiveConfig {
    const project = this.#projectSettingsFor(input.projectId);
    const thread =
      input.threadId === undefined ? undefined : this.#threadOverrideFor(input.threadId);
    const pr = input.target === undefined ? undefined : this.#prSettingsFor(input.target);
    const reviewerId = project.reviewerId ?? this.#defaultReviewerId;
    return resolveEffectivePullRequestReviewConfig({
      projectEnabled: project.enabled,
      projectReviewerId: project.reviewerId,
      projectRoute: project.route,
      postSummaryComment: project.postSummaryComment,
      threadMode: thread?.mode ?? "inherit",
      threadRoute: thread?.route,
      sendBlockingFindingsToWorker: pr?.sendBlockingFindingsToWorker ?? false,
      defaultReviewerId: this.#defaultReviewerId,
      reviewerOffered: this.#registry.has(reviewerId),
    });
  }

  async queryProjectSettings(
    windowId: WindowId,
    projectId: ProjectId,
  ): Promise<PullRequestReviewSettingResult<PullRequestReviewProjectView>> {
    if (!(await this.#authority.canAccessProject(windowId, projectId))) {
      return {
        status: "refused",
        reason: "not-authorized",
        message: "This window cannot access that Code Project.",
      };
    }
    return {
      status: "ok",
      view: decodePullRequestReviewProjectView({
        settings: this.#projectSettingsFor(projectId),
        offeredReviewers: this.#offeredReviewers(),
      }),
    };
  }

  async updateProjectSettings(
    windowId: WindowId,
    command: PullRequestReviewProjectSettingsCommand,
    principalKind: PrincipalKind,
    actor: EventActor,
  ): Promise<PullRequestReviewSettingResult<PullRequestReviewProjectView>> {
    if (!authorizePullRequestReviewSettingChange(principalKind).allowed) {
      return {
        status: "refused",
        reason: "not-authorized",
        message:
          "Pull request reviewer settings may only be changed from a local window or a device paired by the host's person.",
      };
    }
    if (!(await this.#authority.canAccessProject(windowId, command.projectId))) {
      return {
        status: "refused",
        reason: "not-authorized",
        message: "This window cannot access that Code Project.",
      };
    }
    const existing = this.#projectSettingsFor(command.projectId);
    const route = command.route === null ? undefined : (command.route ?? existing.route);
    // No default model: stays off until a provider and model are picked.
    if (command.enabled && route === undefined) {
      return {
        status: "refused",
        reason: "no-route-configured",
        message: "Pick a reviewer provider and model before turning pull request reviews on.",
      };
    }
    const reviewerId = command.reviewerId ?? existing.reviewerId ?? this.#defaultReviewerId;
    const occurredAt = decodeTimestamp(this.#clock());
    const nextVersion = decodeAggregateVersion(existing.version + 1);
    const payload = {
      kind: "pull-request-review-project-settings-updated" as const,
      projectId: command.projectId,
      enabled: command.enabled,
      reviewerId,
      ...(route === undefined ? {} : { route }),
      postSummaryComment: command.postSummaryComment,
    };
    this.#journal.append({
      aggregate: {
        aggregateType: PULL_REQUEST_REVIEW_AGGREGATE_TYPES.projectSettings,
        aggregateId: decodeAggregateId(String(command.projectId)),
      },
      expectedVersion: existing.version,
      events: [
        {
          eventId: decodeEventId(this.#uuid()),
          eventName: PULL_REQUEST_REVIEW_EVENT_NAMES.projectSettingsUpdated,
          eventVersion: 1,
          correlationId: decodeCorrelationId(this.#uuid()),
          actor,
          occurredAt,
          payload,
        },
      ],
    });
    const updated: PullRequestReviewProjectSettings = {
      projectId: command.projectId,
      enabled: command.enabled,
      reviewerId,
      ...(route === undefined ? {} : { route }),
      postSummaryComment: command.postSummaryComment,
      version: nextVersion,
      updatedAt: occurredAt,
    };
    this.#projectSettings.set(String(command.projectId), updated);
    return {
      status: "ok",
      view: decodePullRequestReviewProjectView({
        settings: updated,
        offeredReviewers: this.#offeredReviewers(),
      }),
    };
  }

  async queryThreadSettings(
    windowId: WindowId,
    threadId: CodeThreadId,
  ): Promise<PullRequestReviewSettingResult<PullRequestReviewThreadView>> {
    const thread = this.#threads.readThread(threadId);
    if (thread === undefined) {
      return { status: "refused", reason: "not-found", message: "Code thread was not found." };
    }
    if (!(await this.#authority.canAccessProject(windowId, thread.projectId))) {
      return {
        status: "refused",
        reason: "not-authorized",
        message: "This window cannot access that Code thread's Project.",
      };
    }
    const latestReview = this.#latestByThread.get(String(threadId));
    return {
      status: "ok",
      view: decodePullRequestReviewThreadView({
        override: this.#threadOverrideFor(threadId),
        projectSettings: this.#projectSettingsFor(thread.projectId),
        effective: this.#effectiveConfigFor({ projectId: thread.projectId, threadId }),
        ...(latestReview === undefined ? {} : { latestReview }),
        offeredReviewers: this.#offeredReviewers(),
      }),
    };
  }

  async updateThreadOverride(
    windowId: WindowId,
    command: PullRequestReviewThreadOverrideCommand,
    principalKind: PrincipalKind,
    actor: EventActor,
  ): Promise<PullRequestReviewSettingResult<PullRequestReviewThreadView>> {
    if (!authorizePullRequestReviewSettingChange(principalKind).allowed) {
      return {
        status: "refused",
        reason: "not-authorized",
        message:
          "Pull request reviewer overrides may only be changed from a local window or a device paired by the host's person.",
      };
    }
    const thread = this.#threads.readThread(command.threadId);
    if (thread === undefined) {
      return { status: "refused", reason: "not-found", message: "Code thread was not found." };
    }
    if (!(await this.#authority.canAccessProject(windowId, thread.projectId))) {
      return {
        status: "refused",
        reason: "not-authorized",
        message: "This window cannot access that Code thread's Project.",
      };
    }
    const existing = this.#threadOverrideFor(command.threadId);
    const project = this.#projectSettingsFor(thread.projectId);
    const route = command.route === null ? undefined : (command.route ?? existing.route);
    if (command.mode === "enabled" && (route ?? project.route) === undefined) {
      return {
        status: "refused",
        reason: "no-route-configured",
        message: "Pick a reviewer provider and model before turning review on for this thread.",
      };
    }
    const occurredAt = decodeTimestamp(this.#clock());
    const nextVersion = decodeAggregateVersion(existing.version + 1);
    const payload = {
      kind: "pull-request-review-thread-override-updated" as const,
      threadId: command.threadId,
      mode: command.mode,
      ...(route === undefined ? {} : { route }),
    };
    this.#journal.append({
      aggregate: {
        aggregateType: PULL_REQUEST_REVIEW_AGGREGATE_TYPES.threadOverride,
        aggregateId: decodeAggregateId(String(command.threadId)),
      },
      expectedVersion: existing.version,
      events: [
        {
          eventId: decodeEventId(this.#uuid()),
          eventName: PULL_REQUEST_REVIEW_EVENT_NAMES.threadOverrideUpdated,
          eventVersion: 1,
          correlationId: decodeCorrelationId(this.#uuid()),
          actor,
          occurredAt,
          payload,
        },
      ],
    });
    const updated: PullRequestReviewThreadOverride = {
      threadId: command.threadId,
      mode: command.mode,
      ...(route === undefined ? {} : { route }),
      version: nextVersion,
      updatedAt: occurredAt,
    };
    this.#threadOverrides.set(String(command.threadId), updated);
    const latestReview = this.#latestByThread.get(String(command.threadId));
    return {
      status: "ok",
      view: decodePullRequestReviewThreadView({
        override: updated,
        projectSettings: project,
        effective: this.#effectiveConfigFor({
          projectId: thread.projectId,
          threadId: command.threadId,
        }),
        ...(latestReview === undefined ? {} : { latestReview }),
        offeredReviewers: this.#offeredReviewers(),
      }),
    };
  }

  async queryPullRequestSettings(
    windowId: WindowId,
    target: PullRequestReviewTarget,
    threadId?: CodeThreadId,
  ): Promise<PullRequestReviewSettingResult<PullRequestReviewPullRequestView>> {
    const auth = await this.#authority.authorizePullRequest(windowId, target);
    if (auth.status !== "authorized") {
      return {
        status: "refused",
        reason: "not-authorized",
        message: "This window cannot access that pull request.",
      };
    }
    const fold = this.#runFoldFor(target);
    const latestReview = fold.records.at(-1);
    return {
      status: "ok",
      view: decodePullRequestReviewPullRequestView({
        settings: this.#prSettingsFor(target),
        effective: this.#effectiveConfigFor({
          projectId: target.projectId,
          ...(threadId === undefined ? {} : { threadId }),
          target,
        }),
        ...(latestReview === undefined ? {} : { latestReview }),
        handBackAttempts: fold.handBackAttempts,
      }),
    };
  }

  async updatePullRequestSettings(
    windowId: WindowId,
    command: PullRequestReviewPullRequestSettingsCommand,
    principalKind: PrincipalKind,
    actor: EventActor,
  ): Promise<PullRequestReviewSettingResult<PullRequestReviewPullRequestView>> {
    if (!authorizePullRequestReviewSettingChange(principalKind).allowed) {
      return {
        status: "refused",
        reason: "not-authorized",
        message:
          "Pull request review hand-back settings may only be changed from a local window or a device paired by the host's person.",
      };
    }
    const auth = await this.#authority.authorizePullRequest(windowId, command.target);
    if (auth.status !== "authorized") {
      return {
        status: "refused",
        reason: "not-authorized",
        message: "This window cannot access that pull request.",
      };
    }
    const key = pullRequestReviewTargetKey(command.target);
    const existing = this.#prSettingsFor(command.target);
    const occurredAt = decodeTimestamp(this.#clock());
    const nextVersion = decodeAggregateVersion(existing.version + 1);
    const payload = {
      kind: "pull-request-review-pr-settings-updated" as const,
      target: command.target,
      sendBlockingFindingsToWorker: command.sendBlockingFindingsToWorker,
    };
    this.#journal.append({
      aggregate: {
        aggregateType: PULL_REQUEST_REVIEW_AGGREGATE_TYPES.pullRequestSettings,
        aggregateId: targetAggregateId(key),
      },
      expectedVersion: existing.version,
      events: [
        {
          eventId: decodeEventId(this.#uuid()),
          eventName: PULL_REQUEST_REVIEW_EVENT_NAMES.pullRequestSettingsUpdated,
          eventVersion: 1,
          correlationId: decodeCorrelationId(this.#uuid()),
          actor,
          occurredAt,
          payload,
        },
      ],
    });
    const updated: PullRequestReviewPullRequestSettings = {
      target: command.target,
      sendBlockingFindingsToWorker: command.sendBlockingFindingsToWorker,
      version: nextVersion,
      updatedAt: occurredAt,
    };
    this.#prSettings.set(key, updated);
    const fold = this.#runFoldFor(command.target);
    const latestReview = fold.records.at(-1);
    return {
      status: "ok",
      view: decodePullRequestReviewPullRequestView({
        settings: updated,
        effective: this.#effectiveConfigFor({
          projectId: command.target.projectId,
          target: command.target,
        }),
        ...(latestReview === undefined ? {} : { latestReview }),
        handBackAttempts: fold.handBackAttempts,
      }),
    };
  }

  /**
   * Observes one or more linked open pull requests and starts at most one
   * review per pushed head SHA after the worker thread's turn settles.
   */
  async observePullRequests(
    observations: ReadonlyArray<ObservedPullRequestHead>,
  ): Promise<ReadonlyArray<PullRequestReviewRunRecord>> {
    const records: PullRequestReviewRunRecord[] = [];
    for (const observation of observations) {
      const record = await this.reviewPullRequestHead(observation);
      if (record !== undefined) records.push(record);
    }
    return records;
  }

  /**
   * Runs or skips review for one observed PR head. Returns the recorded run
   * record when an invocation (or explicit unavailable refusal) was journaled,
   * or `undefined` when review is off, deferred while the worker turn runs, or
   * already completed/in-flight for this head SHA.
   */
  async reviewPullRequestHead(
    observation: ObservedPullRequestHead,
  ): Promise<PullRequestReviewRunRecord | undefined> {
    if (observation.state !== "open" && observation.state !== "draft") return undefined;
    const thread = this.#threads.readThread(observation.threadId);
    if (thread === undefined || thread.lifecycle !== "active" || thread.completedAt !== undefined) {
      return undefined;
    }

    const targetKey = pullRequestReviewTargetKey(observation.target);
    const fold = this.#runFoldFor(observation.target);
    const existingInFlight = this.#inFlightByTarget.get(targetKey);

    // If a newer head arrived while an older review is still running, abort
    // the older invocation so it settles as stale/cancelled without publishing.
    if (existingInFlight !== undefined && existingInFlight.headSha !== observation.headSha) {
      existingInFlight.abort.abort();
      this.#inFlightByTarget.delete(targetKey);
    }

    const startDecision = shouldStartPullRequestReviewForHead({
      headSha: observation.headSha,
      reviewedHeadShas: fold.reviewedHeadShas,
      inFlightHeadSha: this.#inFlightByTarget.get(targetKey)?.headSha,
      workerTurnActive: this.#threads.isWorkerTurnActive(observation.threadId),
    });
    if (!startDecision.start) return undefined;

    const effective = this.#effectiveConfigFor({
      projectId: observation.target.projectId,
      threadId: observation.threadId,
      target: observation.target,
    });
    const reviewerId = effective.reviewerId ?? this.#defaultReviewerId;

    if (!effective.enabled) {
      if (effective.unavailableReason === undefined) {
        return undefined;
      }
      // Review is turned on, but cannot run (e.g., disabled/untrusted plugin
      // or no model picked). Record the explicit reason without silent fallback.
      const startedAt = decodeTimestamp(this.#clock());
      const refusedRecord = decodePullRequestReviewRunRecord({
        reviewId: decodePullRequestReviewId(this.#uuid()),
        reviewerId,
        target: observation.target,
        threadId: observation.threadId,
        headSha: observation.headSha,
        status: "refused",
        ...(effective.route === undefined ? {} : { route: effective.route }),
        findingIds: [],
        summaryCommentPosted: false,
        handedBackToWorker: false,
        reason: effective.unavailableReason,
        detail:
          effective.unavailableDetail ??
          "The pull request reviewer is unavailable and will not fall back silently.",
        startedAt,
        completedAt: startedAt,
      });
      this.#recordRun(observation.target, refusedRecord);
      return refusedRecord;
    }

    const abort = new AbortController();
    this.#inFlightByTarget.set(targetKey, { headSha: observation.headSha, abort });
    const reviewId = decodePullRequestReviewId(this.#uuid());
    const startedAt = decodeTimestamp(this.#clock());
    let lastCapture: PullRequestReviewDiffCapture | undefined;
    let handBackAttemptNumber: number | undefined;

    try {
      const request = decodePullRequestReviewRequest({
        reviewId,
        target: observation.target,
        threadId: thread.id,
        checkoutId: thread.checkoutId,
        headSha: observation.headSha,
        baseRef: observation.baseRef,
        ...(observation.baseSha === undefined ? {} : { baseSha: observation.baseSha }),
        workerRoute: {
          providerInstanceId: thread.providerInstanceId,
          modelId: thread.modelId,
        },
        ...(effective.route === undefined ? {} : { configuredRoute: effective.route }),
        optIns: {
          postSummaryComment: effective.postSummaryComment,
          sendBlockingFindingsToWorker: effective.sendBlockingFindingsToWorker,
        },
      });

      const outcome: PullRequestReviewOutcome = await this.#registry.run({
        reviewerId,
        request,
        signal: abort.signal,
        delegates: {
          readCurrentHeadSha: (signal) =>
            this.#runtime.readCurrentHeadSha(observation.target, signal),

          readPullRequestDiff: async (signal): Promise<PullRequestReviewDiffResult> => {
            const captured = await this.#runtime.capturePullRequestDiff(
              {
                target: observation.target,
                thread,
                headSha: observation.headSha,
                baseRef: observation.baseRef,
                ...(observation.baseSha === undefined ? {} : { baseSha: observation.baseSha }),
              },
              signal,
            );
            if (captured.status === "stale") {
              return captured.currentHeadSha === undefined
                ? { status: "stale" }
                : { status: "stale", currentHeadSha: captured.currentHeadSha };
            }
            if (captured.status === "unavailable") {
              return { status: "unavailable", reason: "unavailable" };
            }
            lastCapture = captured.capture;
            return { status: "ready", diff: captured.capture.snapshot };
          },

          runReadOnlyReviewTurn: async (
            input: PullRequestReviewTurnInput,
            signal: AbortSignal,
          ): Promise<PullRequestReviewTurnResult> => {
            const route = effective.route;
            if (route === undefined) {
              return {
                status: "refused",
                reason: "no-route-configured",
                detail: "No reviewer model is configured.",
              };
            }
            // Domain policy enforces Plan's read-only gate at every level.
            pullRequestReviewerExecutionPolicy(thread.executionPolicy);

            const inspection = this.#runtime.inspectRoute({
              route,
              projectId: thread.projectId,
            });
            if (inspection.status === "refused") {
              return {
                status: "refused",
                reason: inspection.reason ?? "route-refused",
                detail:
                  inspection.detail ??
                  "The configured reviewer route is unavailable. Octant will not fall back silently.",
              };
            }

            const reservationId = decodeSpendCeilingReservationId(this.#uuid());
            if (this.#runtime.spendCeiling !== undefined) {
              const admitted = this.#runtime.spendCeiling.admit({
                reservationId,
                threadId: String(thread.id),
                threadType: "code-thread",
                projectId: String(thread.projectId),
                countsAsTurn: true,
              });
              if (admitted.status === "refused") {
                return {
                  status: "refused",
                  reason: "spend-ceiling",
                  detail:
                    "This thread's spend ceiling was reached, so the pull request review did not run.",
                };
              }
            }

            const turnStartedAt = this.#clock();
            const turnStartedMs = Date.now();
            const runId: AgentRunId = decodeAgentRunId(this.#uuid());
            const sessionId = this.#uuid();
            let result: PullRequestReviewTurnExecutionResult;
            try {
              if (this.#runtime.executeReadOnlyTurn !== undefined) {
                result = await this.#runtime.executeReadOnlyTurn({
                  route,
                  thread,
                  prompt: input.prompt,
                  ...(input.systemInstructions === undefined
                    ? {}
                    : { systemInstructions: input.systemInstructions }),
                  signal,
                });
              } else if (inspection.driver !== undefined) {
                result = await runDriverReadOnlyTurn({
                  driver: inspection.driver,
                  route,
                  scratchRoot: this.#runtime.scratchRoot,
                  sessionId,
                  prompt: input.prompt,
                  ...(input.systemInstructions === undefined
                    ? {}
                    : { systemInstructions: input.systemInstructions }),
                  signal,
                });
              } else {
                this.#runtime.spendCeiling?.abandon({ reservationId });
                return {
                  status: "refused",
                  reason: "no-account",
                  detail: "The configured reviewer provider driver is unavailable.",
                };
              }
            } catch {
              this.#runtime.spendCeiling?.abandon({ reservationId });
              return {
                status: "failed",
                detail: "The reviewer turn failed unexpectedly.",
              };
            }

            const turnEndedAt = this.#clock();
            const durationMs = Math.max(0, Date.now() - turnStartedMs);
            if (result.status === "completed") {
              const observedTokens =
                result.usage === undefined
                  ? undefined
                  : result.usage.inputTokens +
                    result.usage.outputTokens +
                    (result.usage.reasoningTokens ?? 0);
              this.#runtime.spendCeiling?.settle({
                reservationId,
                ...(observedTokens === undefined ? {} : { observedTokens }),
              });
              if (result.usage !== undefined) {
                this.#runtime.recordUsage?.({
                  threadId: thread.id,
                  projectId: thread.projectId,
                  providerInstanceId: route.providerInstanceId,
                  modelId: route.modelId,
                  usage: result.usage,
                });
              }
              this.#recordTurnMetrics({
                thread,
                route,
                startedAt: turnStartedAt,
                endedAt: turnEndedAt,
                durationMs,
                stopReason: "completed",
                ...(result.usage === undefined ? {} : { usage: result.usage }),
              });
              return {
                status: "completed",
                runId,
                providerInstanceId: route.providerInstanceId,
                modelId: route.modelId,
                sessionId: result.sessionId,
                text: result.text,
              };
            }

            if (result.status === "failed") {
              if (result.usage !== undefined) {
                const observedTokens =
                  result.usage.inputTokens +
                  result.usage.outputTokens +
                  (result.usage.reasoningTokens ?? 0);
                this.#runtime.spendCeiling?.settle({ reservationId, observedTokens });
                this.#runtime.recordUsage?.({
                  threadId: thread.id,
                  projectId: thread.projectId,
                  providerInstanceId: route.providerInstanceId,
                  modelId: route.modelId,
                  usage: result.usage,
                });
              } else {
                this.#runtime.spendCeiling?.abandon({ reservationId });
              }
              this.#recordTurnMetrics({
                thread,
                route,
                startedAt: turnStartedAt,
                endedAt: turnEndedAt,
                durationMs,
                stopReason: "failed",
                ...(result.usage === undefined ? {} : { usage: result.usage }),
              });
              return { status: "failed", detail: result.detail };
            }

            this.#runtime.spendCeiling?.abandon({ reservationId });
            if (result.status === "refused") {
              return { status: "refused", reason: result.reason, detail: result.detail };
            }
            return { status: "cancelled" };
          },

          recordFindings: async ({
            proposals,
            runReceipt,
          }): Promise<PullRequestReviewRecordFindingsResult> => {
            if (lastCapture === undefined) {
              return {
                status: "refused",
                reason: "unavailable",
                detail: "No host-verified diff snapshot was captured for this review.",
              };
            }
            if (runReceipt === undefined) {
              return {
                status: "refused",
                reason: "unknown-run",
                detail: "Agent review findings require a verified host review turn receipt.",
              };
            }
            const route = effective.route;
            const created: CodeReviewFinding[] = [];
            for (const proposal of proposals) {
              const resolved = this.#resolveFindingForProposal({
                thread,
                capture: lastCapture,
                proposal,
              });
              if (resolved === undefined) continue;
              const finding = await this.#runtime.findings.create({
                id: decodeCodeReviewFindingId(this.#uuid()),
                threadId: thread.id,
                checkoutId: thread.checkoutId,
                fileId: resolved.fileId,
                path: resolved.path,
                fileDigest: resolved.fileDigest,
                ...(resolved.anchor === undefined ? {} : { anchor: resolved.anchor }),
                location: resolved.location,
                severity: proposal.severity,
                summary: proposal.summary,
                author: {
                  kind: "agent",
                  providerInstanceId: runReceipt.providerInstanceId,
                  sessionId: runReceipt.sessionId,
                },
                provenance: {
                  kind: "pull-request-reviewer",
                  reviewerId: String(reviewerId),
                  reviewId: String(reviewId),
                  runId: String(runReceipt.runId),
                  providerInstanceId: runReceipt.providerInstanceId,
                  modelId: runReceipt.modelId,
                  ...(route?.effort === undefined ? {} : { effort: route.effort }),
                  headSha: observation.headSha,
                },
              });
              created.push(finding);
            }
            return { status: "recorded", findings: created };
          },

          isPostSummaryCommentEnabled: () =>
            this.#projectSettingsFor(observation.target.projectId).postSummaryComment,

          postSummaryComment: ({ body }, signal) =>
            this.#runtime.postSummaryComment({ target: observation.target, body }, signal),

          isSendBlockingFindingsEnabled: () =>
            this.#prSettingsFor(observation.target).sendBlockingFindingsToWorker,

          handBackBlockingFindings: async ({
            findings,
          }): Promise<PullRequestReviewHandBackResult> => {
            const strict = this.#threads.isStrict(thread.id);
            const maxStrictAttempts = this.#threads.maxStrictHandBackAttempts();
            const decision = decidePullRequestReviewHandBack({
              sendBlockingFindingsToWorker: this.#prSettingsFor(observation.target)
                .sendBlockingFindingsToWorker,
              blockingFindingCount: findings.length,
              strict,
              attemptsUsed: fold.handBackAttempts,
              maxStrictAttempts,
            });
            if (decision.action === "disabled") return { status: "disabled" };
            if (decision.action === "none") {
              return { status: "refused", reason: "no-blocking-findings" };
            }
            if (decision.action === "attempt-limit") {
              await this.#threads
                .notifyPerson?.(
                  thread.id,
                  `Second-model PR review hand-back stopped on pull request #${observation.target.number} after ${decision.maxAttempts} attempts under Strict.`,
                )
                .catch(() => undefined);
              return { status: "attempt-limit" };
            }

            // Mark outside content BEFORE waking the worker, identical to Auto-fix/Watch.
            const marked = this.#threads.markOutsideContent(
              thread.id,
              `${OUTSIDE_CONTENT_SOURCE_LABEL}:${this.#uuid()}`,
              OUTSIDE_CONTENT_SOURCE_LABEL,
            );
            if (!marked) {
              return { status: "refused", reason: "unmarked" };
            }

            const text = formatHandBackTurnText({
              target: observation.target,
              headSha: observation.headSha,
              findings,
              attempt: decision.attempt,
              ...(strict ? { maxStrictAttempts } : {}),
            });
            const started = await this.#threads.startWorkerTurn(thread.id, text).catch(() => false);
            if (!started) {
              return { status: "refused", reason: "turn-refused" };
            }
            handBackAttemptNumber = decision.attempt;
            return { status: "handed-back", attempt: decision.attempt };
          },
        },
      });

      const completedAt = decodeTimestamp(this.#clock());
      const record = this.#outcomeToRecord({
        reviewId,
        reviewerId,
        target: observation.target,
        threadId: thread.id,
        headSha: observation.headSha,
        ...(effective.route === undefined ? {} : { route: effective.route }),
        outcome,
        startedAt,
        completedAt,
        ...(handBackAttemptNumber === undefined ? {} : { handBackAttempt: handBackAttemptNumber }),
      });
      this.#recordRun(observation.target, record);
      return record;
    } finally {
      const current = this.#inFlightByTarget.get(targetKey);
      if (current?.abort === abort) {
        this.#inFlightByTarget.delete(targetKey);
      }
    }
  }

  #resolveFindingForProposal(input: {
    readonly thread: CodeThread;
    readonly capture: PullRequestReviewDiffCapture;
    readonly proposal: PullRequestReviewFindingProposal;
  }):
    | {
        readonly fileId: CodeReviewFinding["fileId"];
        readonly path: CodeReviewFinding["path"];
        readonly fileDigest: CodeReviewFinding["fileDigest"];
        readonly location: CodeReviewFinding["location"];
        readonly anchor?: CodeReviewDiffAnchor;
      }
    | undefined {
    const file = input.capture.snapshot.files.find(
      (candidate) => String(candidate.path) === String(input.proposal.path),
    );
    if (file === undefined) return undefined;
    const side = input.proposal.side ?? "modified";

    if (input.capture.retained !== undefined && input.proposal.location.kind === "line") {
      const exact = retainedReviewTarget(input.capture.retained, {
        threadId: input.thread.id,
        checkoutId: input.thread.checkoutId,
        path: String(file.path),
        side,
        line: input.proposal.location.line,
      });
      if (exact !== undefined) {
        return {
          fileId: exact.target.fileId,
          path: exact.target.path,
          fileDigest: exact.target.fileDigest,
          location: exact.target.location,
          anchor: exact.target.anchor,
        };
      }
      // If the model named a nearby line outside the diff hunk, snap to the
      // nearest real hunk line on the same side when available, otherwise use
      // the snapshot's file digest without fabricating an invalid anchor.
      const parsed = parseUnifiedDiff(input.capture.retained.text).find(
        (candidate) => candidate.path === String(file.path),
      );
      if (parsed !== undefined && !parsed.binary) {
        const firstLine = parsed.hunks[0]?.lines.find((line) =>
          side === "modified" ? line.newNumber !== undefined : line.oldNumber !== undefined,
        );
        const snappedLine = side === "modified" ? firstLine?.newNumber : firstLine?.oldNumber;
        if (snappedLine !== undefined) {
          const snapped = retainedReviewTarget(input.capture.retained, {
            threadId: input.thread.id,
            checkoutId: input.thread.checkoutId,
            path: String(file.path),
            side,
            line: snappedLine,
          });
          if (snapped !== undefined) {
            return {
              fileId: snapped.target.fileId,
              path: snapped.target.path,
              fileDigest: snapped.target.fileDigest,
              location: snapped.target.location,
              anchor: snapped.target.anchor,
            };
          }
        }
      }
    }

    const fallbackAnchor = input.capture.anchorByPath?.get(String(file.path));
    return {
      fileId: deriveCodeFileId(input.thread.id, input.thread.checkoutId, String(file.path)),
      path: file.path,
      fileDigest: decodeCodeDigest(file.fileDigest),
      location: input.proposal.location,
      ...(fallbackAnchor === undefined ? {} : { anchor: fallbackAnchor }),
    };
  }

  #recordTurnMetrics(input: {
    readonly thread: CodeThread;
    readonly route: PullRequestReviewRoute;
    readonly startedAt: string;
    readonly endedAt: string;
    readonly durationMs: number;
    readonly stopReason: "completed" | "failed";
    readonly usage?: TurnUsage;
  }): void {
    if (this.#runtime.turnMetrics === undefined) return;
    try {
      this.#runtime.turnMetrics.record({
        threadId: String(input.thread.id),
        mode: "code",
        projectId: input.thread.projectId,
        providerInstanceId: input.route.providerInstanceId,
        modelId: input.route.modelId,
        stopReason: input.stopReason === "completed" ? "end-of-turn" : "failed",
        ...(input.usage === undefined ? {} : { usage: input.usage }),
        metrics: {
          precision: "unavailable",
          wallMs: Math.max(0, Math.round(input.durationMs)),
        },
        diagnostics: {
          toolCalls: 0,
          toolFailures: 0,
        },
        startedAt: decodeTimestamp(input.startedAt),
        endedAt: decodeTimestamp(input.endedAt),
      });
    } catch {
      // Turn metrics recording must never discard a completed review.
    }
  }

  #outcomeToRecord(input: {
    readonly reviewId: PullRequestReviewRunRecord["reviewId"];
    readonly reviewerId: PullRequestReviewerId;
    readonly target: PullRequestReviewTarget;
    readonly threadId: CodeThreadId;
    readonly headSha: string;
    readonly route?: PullRequestReviewRoute;
    readonly outcome: PullRequestReviewOutcome;
    readonly startedAt: PullRequestReviewRunRecord["startedAt"];
    readonly completedAt: PullRequestReviewRunRecord["startedAt"];
    readonly handBackAttempt?: number;
  }): PullRequestReviewRunRecord {
    const base = {
      reviewId: input.reviewId,
      reviewerId: input.reviewerId,
      target: input.target,
      threadId: input.threadId,
      headSha: input.headSha,
      ...(input.route === undefined ? {} : { route: input.route }),
      startedAt: input.startedAt,
      completedAt: input.completedAt,
    };
    switch (input.outcome.status) {
      case "completed":
        return decodePullRequestReviewRunRecord({
          ...base,
          status: "completed",
          findingIds: input.outcome.findingIds,
          ...(input.outcome.runId === undefined ? {} : { runId: input.outcome.runId }),
          summaryCommentPosted: input.outcome.summaryCommentPosted === true,
          handedBackToWorker: input.outcome.handedBackToWorker === true,
          ...(input.handBackAttempt === undefined
            ? {}
            : { handBackAttempt: input.handBackAttempt }),
        });
      case "stale": {
        const currency = evaluatePullRequestReviewHeadCurrency({
          reviewedHeadSha: input.headSha,
          currentHeadSha: input.outcome.currentHeadSha,
        });
        return decodePullRequestReviewRunRecord({
          ...base,
          status: "stale",
          ...(currency.status === "stale" && currency.currentHeadSha !== undefined
            ? { currentHeadSha: currency.currentHeadSha }
            : {}),
          findingIds: [],
          summaryCommentPosted: false,
          handedBackToWorker: false,
          detail:
            "The pull request head moved while the review was running, so this review is stale.",
        });
      }
      case "refused":
        return decodePullRequestReviewRunRecord({
          ...base,
          status: "refused",
          findingIds: [],
          summaryCommentPosted: false,
          handedBackToWorker: false,
          reason: input.outcome.reason,
          detail: input.outcome.detail,
        });
      case "cancelled":
        return decodePullRequestReviewRunRecord({
          ...base,
          status: "cancelled",
          findingIds: [],
          summaryCommentPosted: false,
          handedBackToWorker: false,
        });
      case "failed":
        return decodePullRequestReviewRunRecord({
          ...base,
          status: "failed",
          findingIds: [],
          summaryCommentPosted: false,
          handedBackToWorker: false,
          detail: input.outcome.detail,
        });
    }
  }

  #recordRun(target: PullRequestReviewTarget, record: PullRequestReviewRunRecord): void {
    const key = pullRequestReviewTargetKey(target);
    const fold = this.#runFoldFor(target);
    const occurredAt = decodeTimestamp(this.#clock());
    this.#journal.append({
      aggregate: {
        aggregateType: PULL_REQUEST_REVIEW_AGGREGATE_TYPES.run,
        aggregateId: targetAggregateId(key),
      },
      expectedVersion: decodeAggregateVersion(fold.version),
      events: [
        {
          eventId: decodeEventId(this.#uuid()),
          eventName: PULL_REQUEST_REVIEW_EVENT_NAMES.runRecorded,
          eventVersion: 1,
          correlationId: decodeCorrelationId(this.#uuid()),
          actor: localSystemActor(),
          occurredAt,
          payload: {
            kind: "pull-request-review-run-recorded",
            record,
          },
        },
      ],
    });
    fold.version += 1;
    fold.records.push(record);
    if (record.status !== "cancelled") {
      fold.reviewedHeadShas.add(record.headSha);
    }
    if (record.handedBackToWorker) {
      fold.handBackAttempts += 1;
    }
    this.#latestByThread.set(String(record.threadId), record);
  }

  #hydrate(): void {
    const envelopes = replayAggregateTypesInOrder(this.#journal, [
      PULL_REQUEST_REVIEW_AGGREGATE_TYPES.projectSettings,
      PULL_REQUEST_REVIEW_AGGREGATE_TYPES.threadOverride,
      PULL_REQUEST_REVIEW_AGGREGATE_TYPES.pullRequestSettings,
      PULL_REQUEST_REVIEW_AGGREGATE_TYPES.run,
    ]);
    for (const envelope of envelopes) {
      if (envelope.eventName === PULL_REQUEST_REVIEW_EVENT_NAMES.projectSettingsUpdated) {
        const payload = envelope.payload as PullRequestReviewProjectSettingsEvent;
        const previous = this.#projectSettings.get(String(payload.projectId));
        this.#projectSettings.set(String(payload.projectId), {
          projectId: payload.projectId,
          enabled: payload.enabled,
          ...(payload.reviewerId === undefined ? {} : { reviewerId: payload.reviewerId }),
          ...(payload.route === undefined ? {} : { route: payload.route }),
          postSummaryComment: payload.postSummaryComment,
          version: decodeAggregateVersion((previous?.version ?? 0) + 1),
          updatedAt: decodeTimestamp(envelope.occurredAt),
        });
      } else if (envelope.eventName === PULL_REQUEST_REVIEW_EVENT_NAMES.threadOverrideUpdated) {
        const payload = envelope.payload as PullRequestReviewThreadOverrideEvent;
        const previous = this.#threadOverrides.get(String(payload.threadId));
        this.#threadOverrides.set(String(payload.threadId), {
          threadId: payload.threadId,
          mode: payload.mode,
          ...(payload.route === undefined ? {} : { route: payload.route }),
          version: decodeAggregateVersion((previous?.version ?? 0) + 1),
          updatedAt: decodeTimestamp(envelope.occurredAt),
        });
      } else if (
        envelope.eventName === PULL_REQUEST_REVIEW_EVENT_NAMES.pullRequestSettingsUpdated
      ) {
        const payload = envelope.payload as PullRequestReviewPullRequestSettingsEvent;
        const key = pullRequestReviewTargetKey(payload.target);
        const previous = this.#prSettings.get(key);
        this.#prSettings.set(key, {
          target: payload.target,
          sendBlockingFindingsToWorker: payload.sendBlockingFindingsToWorker,
          version: decodeAggregateVersion((previous?.version ?? 0) + 1),
          updatedAt: decodeTimestamp(envelope.occurredAt),
        });
      } else if (envelope.eventName === PULL_REQUEST_REVIEW_EVENT_NAMES.runRecorded) {
        const payload = envelope.payload as PullRequestReviewRunRecordedEvent;
        const fold = this.#runFoldFor(payload.record.target);
        fold.version += 1;
        fold.records.push(payload.record);
        if (payload.record.status !== "cancelled") {
          fold.reviewedHeadShas.add(payload.record.headSha);
        }
        if (payload.record.handedBackToWorker) {
          fold.handBackAttempts += 1;
        }
        this.#latestByThread.set(String(payload.record.threadId), payload.record);
      }
    }
  }

  /** Stops all in-flight reviews on host shutdown. */
  dispose(): void {
    for (const active of this.#inFlightByTarget.values()) {
      active.abort.abort();
    }
    this.#inFlightByTarget.clear();
  }
}

export { PULL_REQUEST_REVIEW_STRICT_MAX_HAND_BACK_ATTEMPTS };
