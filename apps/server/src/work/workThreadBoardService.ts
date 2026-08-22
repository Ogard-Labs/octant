import {
  decodeThreadWorkingDirectory,
  decodeWorkBoardView,
  MAX_WORK_BOARD_CARD_SUMMARY_BYTES,
  UtcTimestamp,
  type CodeThreadId,
  type ProjectId,
  type ThreadGoalStatus,
  type WorkBoardCard,
  type WorkBoardQuery,
  type WorkBoardStatus,
  type WorkBoardView,
  type WorkThread,
  type WorkThreadId,
  type WorkTurnState,
  type WorkPromotionProposalId,
} from "@octant/contracts";
import { Schema } from "effect";
import {
  compareThreadBoardActivityDescending,
  deriveThreadBoardStatus,
} from "@octant/domain/thread-board-policy";
import { evaluateWorkDeliverySatisfaction } from "@octant/domain/work-delivery-policy";
import { joinWorkThreadBoardPullRequests } from "../code/threadBoardPullRequestJoin";
import type { ThreadBoardPullRequestSnapshot } from "../code/threadBoardPullRequestJoin";
import type { WorkPromotionEntry } from "./workPromotionProjection";

const ALL_BOARD_STATUSES: readonly WorkBoardStatus[] = ["ready", "in-progress", "waiting", "done"];
const DEFAULT_WORKING_DIRECTORY = decodeThreadWorkingDirectory(".");
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

/**
 * A non-archived Work thread the board should resolve, plus the permission-
 * and projection-filtered context the card needs. Follow-up never influences
 * runtime status. Client unread is not a server card field.
 */
export interface WorkBoardThread {
  readonly thread: WorkThread;
  readonly project: { readonly id: ProjectId; readonly name: string };
  readonly projectProjectionPresent: boolean;
  readonly bindingRevisionCurrent: boolean;
  readonly followUp: boolean;
}

export interface WorkBoardThreadSource {
  list(): readonly WorkBoardThread[] | Promise<readonly WorkBoardThread[]>;
}

export interface WorkBoardRuntimeActivity {
  readonly executing: boolean;
  readonly awaitingInput: boolean;
  readonly interrupted: boolean;
  readonly blockingReason?: string;
}

export interface WorkBoardRuntimeSource {
  observe(threadId: WorkThreadId): WorkBoardRuntimeActivity | Promise<WorkBoardRuntimeActivity>;
}

export interface WorkBoardEvidence {
  readonly artifacts: WorkBoardCard["artifacts"];
  readonly citations: WorkBoardCard["citations"];
  readonly goal: WorkBoardCard["goal"];
  readonly childRuns: WorkBoardCard["childRuns"];
  readonly activeRequest: WorkBoardCard["activeRequest"];
  readonly staleEvidence: boolean;
  readonly lastMeaningfulActivityAt: string | null;
}

export interface WorkBoardEvidenceSource {
  forThread(entry: WorkBoardThread): WorkBoardEvidence | Promise<WorkBoardEvidence>;
}

/**
 * Derive board activity from the thread's latest provider turn, a pending
 * request, and child-run activity.
 *
 * Only the latest turn speaks for provider activity. A newer turn supersedes
 * every older one, so a stale running or waiting row cannot pin an idle thread.
 * Child runs that are still queued, starting, or running keep the thread in
 * progress; a child waiting for input is an authoritative wait.
 */
export function boardRuntimeActivityFromTurnsAndSignals(input: {
  readonly turns: ReadonlyArray<{
    readonly status: WorkTurnState["status"];
    readonly failure?: WorkTurnState["failure"];
    readonly transcript: WorkTurnState["transcript"];
  }>;
  readonly pendingRequest: boolean;
  readonly childActive: number;
  readonly childWaiting: number;
}): WorkBoardRuntimeActivity {
  const latest = input.turns.at(-1);
  const interrupted = latest !== undefined && turnInterrupted(latest);
  const turnExecuting =
    latest !== undefined && (latest.status === "accepted" || latest.status === "running");
  const turnWaiting = latest !== undefined && latest.status === "waiting" && !interrupted;
  const executing = turnExecuting || input.childActive > 0;
  const awaitingInput = input.pendingRequest || turnWaiting || input.childWaiting > 0;
  const waiting = awaitingInput || interrupted;
  return {
    executing,
    awaitingInput,
    interrupted,
    ...(waiting && !executing
      ? {
          blockingReason: awaitingInput
            ? "Runtime work is waiting for a decision or input."
            : "The last agent turn was interrupted.",
        }
      : {}),
  };
}

function turnInterrupted(turn: {
  readonly failure?: WorkTurnState["failure"];
  readonly transcript: WorkTurnState["transcript"];
}): boolean {
  if (turn.failure?.category === "interrupted") return true;
  return turn.transcript.some(
    (entry) => entry.role === "assistant" && entry.status === "interrupted",
  );
}

export interface WorkBoardPullRequestSource {
  snapshot(): ThreadBoardPullRequestSnapshot | Promise<ThreadBoardPullRequestSnapshot>;
}

export interface WorkBoardPromotionSource {
  snapshot(): ReadonlyMap<WorkPromotionProposalId, WorkPromotionEntry> | Promise<
    ReadonlyMap<WorkPromotionProposalId, WorkPromotionEntry>
  >;
}

export interface WorkBoardCodeThreadSource {
  list(): ReadonlyArray<{ readonly id: CodeThreadId; readonly projectId: ProjectId }> | Promise<
    ReadonlyArray<{ readonly id: CodeThreadId; readonly projectId: ProjectId }>
  >;
}

export interface WorkThreadBoardServiceDependencies {
  readonly threads: WorkBoardThreadSource;
  readonly evidence: WorkBoardEvidenceSource;
  readonly runtime: WorkBoardRuntimeSource;
  readonly pullRequests: WorkBoardPullRequestSource;
  readonly promotions: WorkBoardPromotionSource;
  readonly codeThreads: WorkBoardCodeThreadSource;
  readonly clock?: () => string;
}

/**
 * Resolves the shared, runtime-derived Work Thread Board read model. It
 * composes rebuildable Work projections with live turn/request/child-run
 * activity and the domain status derivation to produce one ordered card per
 * non-archived Work thread that matches the active query.
 */
export class WorkThreadBoardService {
  readonly #threads: WorkBoardThreadSource;
  readonly #evidence: WorkBoardEvidenceSource;
  readonly #runtime: WorkBoardRuntimeSource;
  readonly #pullRequests: WorkBoardPullRequestSource;
  readonly #promotions: WorkBoardPromotionSource;
  readonly #codeThreads: WorkBoardCodeThreadSource;
  readonly #clock: () => string;

  constructor(dependencies: WorkThreadBoardServiceDependencies) {
    this.#threads = dependencies.threads;
    this.#evidence = dependencies.evidence;
    this.#runtime = dependencies.runtime;
    this.#pullRequests = dependencies.pullRequests;
    this.#promotions = dependencies.promotions;
    this.#codeThreads = dependencies.codeThreads;
    this.#clock = dependencies.clock ?? (() => new Date().toISOString());
  }

  async query(query: WorkBoardQuery): Promise<WorkBoardView> {
    const boardThreads = await this.#threads.list();
    const [pullRequestSnapshot, promotions, codeThreads] = await Promise.all([
      this.#pullRequests.snapshot(),
      this.#promotions.snapshot(),
      this.#codeThreads.list(),
    ]);
    const cards: WorkBoardCard[] = [];
    for (const entry of boardThreads) {
      if (entry.thread.lifecycle === "archived" || entry.thread.lifecycle === "deleted") continue;
      const evidence = await this.#evidence.forThread(entry);
      const activity = await this.#observeRuntime(entry.thread.id);
      cards.push(
        buildCard(entry, evidence, activity, {
          pullRequestSnapshot,
          promotions,
          codeThreads,
        }),
      );
    }

    const appliedStatuses = query.statuses ?? ALL_BOARD_STATUSES;
    const filtered = cards.filter((card) => matchesQuery(card, query, appliedStatuses));
    filtered.sort((a, b) =>
      compareThreadBoardActivityDescending(
        { lastMeaningfulActivityAtMs: activityMs(a) },
        { lastMeaningfulActivityAtMs: activityMs(b) },
      ),
    );

    return decodeWorkBoardView({
      version: 1,
      query: { ...query, statuses: [...appliedStatuses] },
      cards: filtered,
      generatedAt: this.#clock(),
    });
  }

  async #observeRuntime(threadId: WorkThreadId): Promise<WorkBoardRuntimeActivity> {
    try {
      return await this.#runtime.observe(threadId);
    } catch {
      return { executing: false, awaitingInput: false, interrupted: false };
    }
  }
}

function buildCard(
  entry: WorkBoardThread,
  evidence: WorkBoardEvidence,
  activity: WorkBoardRuntimeActivity,
  pullRequestContext: {
    readonly pullRequestSnapshot: ThreadBoardPullRequestSnapshot;
    readonly promotions: ReadonlyMap<WorkPromotionProposalId, WorkPromotionEntry>;
    readonly codeThreads: ReadonlyArray<{ readonly id: CodeThreadId; readonly projectId: ProjectId }>;
  },
): WorkBoardCard {
  const pullRequestSummaries = joinWorkThreadBoardPullRequests({
    workProjectId: entry.thread.projectId,
    promotions: pullRequestContext.promotions,
    codeThreads: pullRequestContext.codeThreads,
    snapshot: pullRequestContext.pullRequestSnapshot,
  });
  const recovery = recoveryFrom(entry);
  const deliverySatisfaction = evaluateWorkDeliverySatisfaction({
    completionConfirmed: entry.thread.completionConfirmed === true,
    ...(entry.thread.completionEvidence === undefined
      ? {}
      : { completionEvidence: entry.thread.completionEvidence }),
    currentDeliveryTarget: entry.thread.title,
    childAgents: {
      active: evidence.childRuns.active,
      unacknowledgedResults: evidence.childRuns.unacknowledgedResults,
    },
    evidenceFreshness: evidence.staleEvidence ? "stale" : "fresh",
  });
  const derivation = deriveThreadBoardStatus({
    deliverySatisfaction,
    executing: activity.executing,
    awaitingInput: activity.awaitingInput,
    interrupted: activity.interrupted,
    recovering: recovery.kind === "recovering",
  });
  const blockingReason = activity.blockingReason ?? waitingReasonLabel(derivation.reason);
  const lastActivity = latestTimestamp(entry.thread.updatedAt, evidence.lastMeaningfulActivityAt);
  const workingDirectory = entry.thread.workingDirectory ?? DEFAULT_WORKING_DIRECTORY;
  return {
    threadId: entry.thread.id,
    projectId: entry.project.id,
    title: entry.thread.title,
    status: derivation.status,
    statusReason: derivation.reason,
    deliveryTarget: entry.thread.title,
    deliverySatisfaction,
    providerInstanceId: entry.thread.providerInstanceId,
    modelId: entry.thread.modelId,
    executing: activity.executing,
    binding: {
      kind: "bound",
      workingDirectory,
      ...(entry.thread.bindingRevisionId === undefined
        ? {}
        : { bindingRevisionId: entry.thread.bindingRevisionId }),
    },
    activeRequest: evidence.activeRequest,
    artifacts: evidence.artifacts,
    citations: evidence.citations,
    goal: evidence.goal,
    childRuns: evidence.childRuns,
    pullRequestSummaries,
    recovery,
    staleEvidence: evidence.staleEvidence,
    ...(blockingReason === undefined ? {} : { blockingReason }),
    followUp: entry.followUp,
    lastMeaningfulActivityAt: lastActivity === null ? null : decodeTimestamp(lastActivity),
  };
}

function recoveryFrom(entry: WorkBoardThread): WorkBoardCard["recovery"] {
  const reasons: Array<"project-projection-missing" | "binding-revision-mismatch"> = [];
  if (!entry.projectProjectionPresent) reasons.push("project-projection-missing");
  if (!entry.bindingRevisionCurrent) reasons.push("binding-revision-mismatch");
  const first = reasons[0];
  if (first === undefined) return { kind: "ok" };
  return {
    kind: "recovering",
    reasons: [first, ...reasons.slice(1)],
  };
}

function waitingReasonLabel(reason: WorkBoardCard["statusReason"]): string | undefined {
  switch (reason) {
    case "recovering":
      return "This thread is recovering its Project or operation history.";
    case "awaiting-input":
      return "Runtime work is waiting for a decision or input.";
    case "interrupted":
      return "The last agent turn was interrupted.";
    case "delivery-waiting":
      return "Delivery evidence is stale or ambiguous.";
    default:
      return undefined;
  }
}

function matchesQuery(
  card: WorkBoardCard,
  query: WorkBoardQuery,
  appliedStatuses: readonly WorkBoardStatus[],
): boolean {
  if (!appliedStatuses.includes(card.status)) return false;
  if (query.projectIds !== undefined && !query.projectIds.includes(card.projectId)) return false;
  if (
    query.providerInstanceIds !== undefined &&
    !query.providerInstanceIds.includes(card.providerInstanceId)
  ) {
    return false;
  }
  if (!matchesFollowUp(card, query.followUp)) return false;
  if (!matchesPendingRequest(card, query.pendingRequest)) return false;
  if (query.text !== undefined && !matchesText(card, query.text)) return false;
  return true;
}

function matchesFollowUp(card: WorkBoardCard, filter: WorkBoardQuery["followUp"]): boolean {
  if (filter === undefined || filter === "any") return true;
  return filter === "only" ? card.followUp : !card.followUp;
}

function matchesPendingRequest(
  card: WorkBoardCard,
  filter: WorkBoardQuery["pendingRequest"],
): boolean {
  if (filter === undefined || filter === "any") return true;
  const pending = card.activeRequest.kind === "pending";
  return filter === "only" ? pending : !pending;
}

function matchesText(card: WorkBoardCard, text: string): boolean {
  const needle = text.trim().toLowerCase();
  if (needle === "") return true;
  const haystacks = [card.title, card.deliveryTarget];
  if (card.binding.kind === "bound") haystacks.push(card.binding.workingDirectory);
  if (card.goal.kind === "present") haystacks.push(card.goal.objective);
  if (card.activeRequest.kind === "pending") haystacks.push(card.activeRequest.summary);
  if (card.artifacts.latestDisplayName !== undefined) {
    haystacks.push(card.artifacts.latestDisplayName);
  }
  return haystacks.some((value) => value.toLowerCase().includes(needle));
}

function activityMs(card: WorkBoardCard): number | null {
  if (card.lastMeaningfulActivityAt === null) return null;
  const parsed = Date.parse(card.lastMeaningfulActivityAt);
  return Number.isFinite(parsed) ? parsed : null;
}

function latestTimestamp(left: string, right: string | null): string {
  if (right === null) return left;
  return left.localeCompare(right) >= 0 ? left : right;
}

export interface WorkBoardEvidenceFacts {
  readonly turns: ReadonlyArray<{ readonly updatedAt: string }>;
  readonly pendingRequests: ReadonlyArray<{
    readonly status: string;
    readonly requestedAt: string;
    readonly detail:
      | { readonly kind: "approval"; readonly action: string }
      | { readonly kind: "user-input"; readonly prompt: string };
  }>;
  readonly artifacts: ReadonlyArray<{ readonly displayName: string; readonly sequence: number }>;
  readonly citations: ReadonlyArray<{ readonly availability: string }>;
  readonly goal: {
    readonly status: ThreadGoalStatus;
    readonly objective: string;
    readonly updatedAt: string;
  } | null;
  readonly childRuns: ReadonlyArray<{
    readonly lifecycleStatus: string;
    readonly task: string;
    readonly updatedAt: string;
    readonly resultAcknowledgement: { readonly required: boolean; readonly acknowledged: boolean };
  }>;
}

/**
 * Compose Work-specific card facts from rebuildable projections. Unread is
 * never a server card field; follow-up is supplied by the thread source.
 */
export function composeWorkBoardEvidence(facts: WorkBoardEvidenceFacts): WorkBoardEvidence {
  const pending = facts.pendingRequests.find((request) => request.status === "pending");
  const artifacts = [...facts.artifacts].sort((left, right) => right.sequence - left.sequence);
  const latestArtifact = artifacts[0];
  const latestDisplayName =
    latestArtifact === undefined ? undefined : clipWorkBoardSummary(latestArtifact.displayName);
  let citationCount = 0;
  let staleCount = 0;
  for (const source of facts.citations) {
    citationCount += 1;
    if (source.availability === "stale") staleCount += 1;
  }
  let childActive = 0;
  let childCompleted = 0;
  let childFailed = 0;
  let unacknowledgedResults = 0;
  let latestChild: { readonly task: string; readonly updatedAt: string } | undefined;
  for (const run of facts.childRuns) {
    if (
      run.lifecycleStatus === "queued" ||
      run.lifecycleStatus === "starting" ||
      run.lifecycleStatus === "running" ||
      run.lifecycleStatus === "waiting"
    ) {
      childActive += 1;
    } else if (run.lifecycleStatus === "completed") {
      childCompleted += 1;
    } else if (run.lifecycleStatus === "failed") {
      childFailed += 1;
    }
    if (
      (run.lifecycleStatus === "completed" || run.lifecycleStatus === "failed") &&
      run.resultAcknowledgement.required &&
      !run.resultAcknowledgement.acknowledged
    ) {
      unacknowledgedResults += 1;
    }
    if (latestChild === undefined || run.updatedAt >= latestChild.updatedAt) {
      latestChild = { task: run.task, updatedAt: run.updatedAt };
    }
  }
  const timestamps = [
    ...facts.turns.map((turn) => turn.updatedAt),
    ...facts.pendingRequests.map((request) => request.requestedAt),
    ...(facts.goal === null ? [] : [facts.goal.updatedAt]),
    ...(latestChild === undefined ? [] : [latestChild.updatedAt]),
  ];
  let lastMeaningfulActivityAt: string | null = null;
  for (const stamp of timestamps) {
    lastMeaningfulActivityAt =
      lastMeaningfulActivityAt === null ? stamp : latestTimestamp(stamp, lastMeaningfulActivityAt);
  }
  const goalObjective =
    facts.goal === null ? undefined : clipWorkBoardSummary(facts.goal.objective);
  const latestSummary =
    latestChild === undefined ? undefined : clipWorkBoardSummary(latestChild.task);
  const requestSummary =
    pending === undefined
      ? undefined
      : clipWorkBoardSummary(
          pending.detail.kind === "approval" ? pending.detail.action : pending.detail.prompt,
        );
  return {
    artifacts: {
      count: artifacts.length,
      ...(latestDisplayName === undefined ? {} : { latestDisplayName }),
    },
    citations: { count: citationCount, staleCount },
    goal:
      facts.goal === null || goalObjective === undefined
        ? { kind: "none" }
        : {
            kind: "present",
            status: facts.goal.status,
            objective: goalObjective,
          },
    childRuns: {
      active: childActive,
      completed: childCompleted,
      failed: childFailed,
      unacknowledgedResults,
      ...(latestSummary === undefined ? {} : { latestSummary }),
    },
    activeRequest:
      pending === undefined
        ? { kind: "none" }
        : {
            kind: "pending",
            requestKind: pending.detail.kind,
            summary: requestSummary ?? "Pending request",
          },
    staleEvidence: staleCount > 0,
    lastMeaningfulActivityAt,
  };
}

const summaryEncoder = new TextEncoder();

export function clipWorkBoardSummary(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (summaryEncoder.encode(trimmed).byteLength <= MAX_WORK_BOARD_CARD_SUMMARY_BYTES) {
    return trimmed;
  }
  let end = trimmed.length;
  while (
    end > 0 &&
    summaryEncoder.encode(trimmed.slice(0, end)).byteLength > MAX_WORK_BOARD_CARD_SUMMARY_BYTES
  ) {
    end -= 1;
  }
  const clipped = trimmed.slice(0, end).trim();
  return clipped === "" ? undefined : clipped;
}
