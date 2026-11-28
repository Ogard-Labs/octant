import { createHash } from "node:crypto";
import {
  ActorId,
  AggregateId,
  AggregateVersion,
  CODE_PULL_REQUEST_LINK_AGGREGATE,
  CorrelationId,
  EventId,
  UtcTimestamp,
  decodeAgentRunId,
  decodeCodeThreadId,
  type CodeThread,
  type CodeThreadId,
  type EventActor,
  type ProjectId,
  type PullRequestReviewRoute,
  type PullRequestReviewTarget,
  type TurnUsage,
  type WindowId,
} from "@octant/contracts";
import {
  MAX_PULL_REQUEST_GUIDE_ANCHORS,
  MAX_PULL_REQUEST_GUIDE_OUTPUT_BYTES,
  MAX_PULL_REQUEST_GUIDE_STOPS,
  MAX_PULL_REQUEST_GUIDE_TITLE_CHARS,
  MAX_PULL_REQUEST_GUIDE_WHY_BYTES,
  PULL_REQUEST_GUIDE_AGGREGATE_TYPE,
  PULL_REQUEST_GUIDE_EVENT_NAMES,
  PullRequestGuideRecordedEvent,
  PullRequestGuideRunFailedEvent,
  PullRequestGuideRunStartedEvent,
  decodePullRequestGuideId,
  decodePullRequestGuideStop,
  decodePullRequestGuideView,
  type PullRequestGuide,
  type PullRequestGuideFailureReason,
  type PullRequestGuideRequester,
  type PullRequestGuideStop,
  type PullRequestGuideView,
} from "@octant/contracts/pull-request-guide";
import { parsePullRequestReviewLegacyTargetKey } from "@octant/domain";
import {
  emptyPullRequestLinkRegistryState,
  resolvePullRequestLink,
  type PullRequestLinkRegistryState,
} from "@octant/domain/pull-request-identity-policy";
import type { PullRequestGuideStopProposal } from "@octant/plugin-api/pull-request-guide-writer";
import type { PullRequestGuideWriterRegistry } from "./pullRequestGuideWriterRegistry";
import type {
  PullRequestReviewDiffSnapshot,
  PullRequestReviewTurnResult,
} from "@octant/plugin-api/pull-request-reviewer";
import { Schema } from "effect";
import {
  decodePullRequestLinkEnvelopeEvent,
  type PullRequestLinkReader,
} from "../code/pullRequestLinkService";
import type { EventRegistry } from "../persistence/eventRegistry";
import type { Journal } from "../persistence/journal";
import { replayAggregateTypesInOrder } from "../persistence/journalHydration";
import {
  pullRequestLinkBucketKey,
  resolvePullRequestReviewIdentity,
  stepPullRequestLinkReplay,
  type ResolvedPullRequestReviewIdentity,
} from "../pullRequestReviewers/pullRequestReviewIdentity";
import {
  runDriverReadOnlyTurn,
  type PullRequestReviewHostRuntimePort,
  type PullRequestReviewTurnExecutionResult,
} from "../pullRequestReviewers/pullRequestReviewService";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import { decodeSpendCeilingReservationId } from "../spendCeilingService";

const decodeActorId = Schema.decodeUnknownSync(ActorId);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);
const encoder = new TextEncoder();
const GUIDE_TURN_TIMEOUT_MS = 120_000;

export function registerPullRequestGuideEvents(registry: EventRegistry): EventRegistry {
  return registry
    .register(PULL_REQUEST_GUIDE_EVENT_NAMES.runStarted, 1, PullRequestGuideRunStartedEvent)
    .register(PULL_REQUEST_GUIDE_EVENT_NAMES.recorded, 1, PullRequestGuideRecordedEvent)
    .register(PULL_REQUEST_GUIDE_EVENT_NAMES.runFailed, 1, PullRequestGuideRunFailedEvent);
}

/** The head-side line ranges each hunk of a file's patch covers. */
function headRanges(patch: string): ReadonlyArray<readonly [number, number]> {
  const ranges: Array<readonly [number, number]> = [];
  for (const match of patch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(match[1]);
    const length = match[2] === undefined ? 1 : Number(match[2]);
    if (length > 0) ranges.push([start, start + length - 1]);
  }
  return ranges;
}

function cutUtf8(value: string, maxBytes: number): string {
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  let bytes = 0;
  let kept = "";
  for (const ch of value) {
    bytes += encoder.encode(ch).byteLength;
    if (bytes > maxBytes) break;
    kept += ch;
  }
  return kept;
}

/**
 * Holds a writer's stops to the guide limits. An anchor whose path is not a
 * file the diff changes at this head, or whose lines fall outside every hunk
 * on the head side, is dropped; its stop stays and reads as unanchored.
 */
export function validateGuideStops(
  proposals: ReadonlyArray<PullRequestGuideStopProposal>,
  diff: Pick<PullRequestReviewDiffSnapshot, "files">,
): ReadonlyArray<PullRequestGuideStop> {
  const rangesByPath = new Map(
    diff.files
      .filter((file) => file.status !== "deleted")
      .map((file) => [String(file.path), headRanges(file.patch ?? "")] as const),
  );
  const stops: PullRequestGuideStop[] = [];
  for (const proposal of proposals) {
    if (stops.length >= MAX_PULL_REQUEST_GUIDE_STOPS) break;
    const title = [...proposal.title.replaceAll("\u0000", "").trim()]
      .slice(0, MAX_PULL_REQUEST_GUIDE_TITLE_CHARS)
      .join("");
    if (title.length === 0) continue;
    const anchors = proposal.anchors
      .filter((anchor) => {
        const ranges = rangesByPath.get(anchor.path);
        return (
          ranges !== undefined &&
          Number.isInteger(anchor.startLine) &&
          Number.isInteger(anchor.endLine) &&
          anchor.startLine >= 1 &&
          anchor.endLine >= anchor.startLine &&
          ranges.some(([start, end]) => anchor.startLine <= end && anchor.endLine >= start)
        );
      })
      .slice(0, MAX_PULL_REQUEST_GUIDE_ANCHORS);
    try {
      stops.push(
        decodePullRequestGuideStop({
          id: `stop-${stops.length + 1}`,
          title,
          why: cutUtf8(
            proposal.why.replaceAll("\u0000", "").trim(),
            MAX_PULL_REQUEST_GUIDE_WHY_BYTES,
          ),
          needsDecision: proposal.needsDecision,
          anchors,
        }),
      );
    } catch {
      // A stop the contract cannot hold is left out rather than guessed at.
    }
  }
  return stops;
}

/** A deterministic UUID for one pull-request link's guide aggregate. */
function guideAggregateId(linkId: string) {
  const bytes = Buffer.from(
    createHash("sha256").update(`pr-guide:${linkId}`).digest().subarray(0, 16),
  );
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return decodeAggregateId(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`,
  );
}

interface GuideFold {
  guide: PullRequestGuide | undefined;
  guideOrder: number;
  /** The newest failure and the head it was for; a push leaves it behind. */
  lastFailure:
    | { readonly reason: PullRequestGuideFailureReason; readonly headSha: string | undefined }
    | undefined;
  failureOrder: number;
  readonly started: Map<string, PullRequestGuideRunStartedEvent>;
}

export type PullRequestGuideRunResult =
  | { readonly status: "recorded"; readonly guide: PullRequestGuide }
  | { readonly status: "failed"; readonly reason: PullRequestGuideFailureReason };

export type PullRequestGuideRefusal =
  | "not-authorized"
  | "not-effective"
  | "no-model"
  | "running"
  | "no-thread"
  | "unavailable";

export type PullRequestGuideStartResult =
  | {
      readonly status: "started";
      readonly target: PullRequestReviewTarget;
      readonly headSha: string;
      readonly done: Promise<PullRequestGuideRunResult>;
    }
  | { readonly status: "refused"; readonly reason: PullRequestGuideRefusal };

export type PullRequestGuideReadResult =
  | { readonly status: "read"; readonly view: PullRequestGuideView }
  | { readonly status: "refused"; readonly reason: "not-authorized" };

/** The thread's own linked pull request, as the pull-request switches resolve it. */
export type ThreadPullRequestResolution =
  | {
      readonly status: "resolved";
      readonly target: PullRequestReviewTarget;
      readonly pullRequestNodeId?: string;
    }
  | { readonly status: "refused"; readonly reason: string }
  | { readonly status: "unavailable"; readonly reason: string };

export interface PullRequestGuideServiceOptions {
  readonly journal: Pick<Journal, "append" | "replayAggregateType">;
  readonly pullRequestLinks?: PullRequestLinkReader;
  readonly authority: {
    authorizePullRequest(
      windowId: WindowId,
      target: PullRequestReviewTarget,
    ): Promise<
      | {
          readonly status: "authorized";
          readonly linkedThreadIds: ReadonlyArray<string>;
          readonly canonicalTarget?: PullRequestReviewTarget;
          readonly pullRequestNodeId?: string;
        }
      | { readonly status: "not-authorized" }
      | { readonly status: "disconnected" }
    >;
    threadPullRequest(
      windowId: WindowId,
      threadId: CodeThreadId,
    ): Promise<ThreadPullRequestResolution>;
  };
  readonly readThread: (threadId: CodeThreadId) => CodeThread | undefined;
  /** The Project's guide model, picked by the person; there is no default. */
  readonly guideRoute: (projectId: ProjectId) => PullRequestReviewRoute | undefined;
  readonly runtime: Pick<
    PullRequestReviewHostRuntimePort,
    | "readCurrentHeadSha"
    | "capturePullRequestDiff"
    | "inspectRoute"
    | "executeReadOnlyTurn"
    | "scratchRoot"
    | "spendCeiling"
    | "recordUsage"
  >;
  readonly writers: PullRequestGuideWriterRegistry;
  readonly uuid: () => string;
  readonly clock?: () => string;
  readonly turnTimeoutMs?: number;
}

/**
 * Review guides: one read-only model run per request, written for one pull
 * request head and journaled on the link's `pull-request-guide` aggregate.
 * A person starts a run from a local window; an agent starts one only for its
 * own thread's pull request, after the tool's ask. One run per link at a time,
 * and each reserves spend under the thread it is charged to.
 */
export class PullRequestGuideService {
  readonly #options: PullRequestGuideServiceOptions;
  readonly #clock: () => string;
  readonly #folds = new Map<string, GuideFold>();
  readonly #aggregateVersions = new Map<string, number>();
  readonly #running = new Map<string, AbortController>();
  #eventOrder = 0;

  constructor(options: PullRequestGuideServiceOptions) {
    this.#options = options;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#hydrate();
  }

  #resolveIdentity(
    target: PullRequestReviewTarget,
    authority?: {
      readonly canonicalTarget?: PullRequestReviewTarget;
      readonly pullRequestNodeId?: string;
    },
  ): ResolvedPullRequestReviewIdentity {
    const resolved = resolvePullRequestReviewIdentity({
      target,
      pullRequestLinks: this.#options.pullRequestLinks,
      canonicalTarget: authority?.canonicalTarget,
      pullRequestNodeId: authority?.pullRequestNodeId,
    });
    for (const fromKey of resolved.adoptKeys) {
      this.#mergeFolds(fromKey, resolved.bucketKey);
    }
    return resolved;
  }

  #mergeFolds(fromKey: string, toKey: string): void {
    if (fromKey === toKey) return;
    const source = this.#folds.get(fromKey);
    if (source !== undefined) {
      const dest = this.#folds.get(toKey);
      if (dest === undefined) {
        this.#folds.set(toKey, source);
      } else {
        if (
          source.guide !== undefined &&
          (dest.guide === undefined || source.guideOrder >= dest.guideOrder)
        ) {
          dest.guide = source.guide;
          dest.guideOrder = source.guideOrder;
        }
        if (
          source.lastFailure !== undefined &&
          (dest.lastFailure === undefined || source.failureOrder >= dest.failureOrder)
        ) {
          dest.lastFailure = source.lastFailure;
          dest.failureOrder = source.failureOrder;
        }
        // A newer guide clears an older failure carried from the other bucket.
        if (dest.guide !== undefined && dest.guideOrder > dest.failureOrder) {
          dest.lastFailure = undefined;
        }
        for (const [id, started] of source.started) {
          if (!dest.started.has(id)) dest.started.set(id, started);
        }
      }
      this.#folds.delete(fromKey);
    }
    const running = this.#running.get(fromKey);
    if (running !== undefined) {
      if (!this.#running.has(toKey)) this.#running.set(toKey, running);
      this.#running.delete(fromKey);
    }
  }

  async read(
    windowId: WindowId,
    target: PullRequestReviewTarget,
    headSha: string | undefined,
  ): Promise<PullRequestGuideReadResult> {
    const authority = await this.#options.authority.authorizePullRequest(windowId, target);
    if (authority.status !== "authorized") return { status: "refused", reason: "not-authorized" };
    const resolved = this.#resolveIdentity(target, authority);
    return { status: "read", view: this.#view(resolved.bucketKey, resolved.target, headSha) };
  }

  /** The guide of the thread's own pull request, judged stale against the forge's current head. */
  async readForThread(
    windowId: WindowId,
    threadId: CodeThreadId,
    signal: AbortSignal,
  ): Promise<
    | {
        readonly status: "read";
        readonly target: PullRequestReviewTarget;
        readonly view: PullRequestGuideView;
      }
    | { readonly status: "refused"; readonly reason: string }
  > {
    const own = await this.#options.authority.threadPullRequest(windowId, threadId);
    if (own.status !== "resolved") return { status: "refused", reason: own.reason };
    const resolved = this.#resolveIdentity(own.target, own);
    const head = await this.#options.runtime.readCurrentHeadSha(resolved.target, signal);
    return {
      status: "read",
      target: resolved.target,
      view: this.#view(resolved.bucketKey, resolved.target, head),
    };
  }

  async writeForPerson(
    windowId: WindowId,
    target: PullRequestReviewTarget,
  ): Promise<PullRequestGuideStartResult> {
    const authority = await this.#options.authority.authorizePullRequest(windowId, target);
    if (authority.status !== "authorized") {
      return {
        status: "refused",
        reason: authority.status === "disconnected" ? "unavailable" : "not-authorized",
      };
    }
    const resolved = this.#resolveIdentity(target, authority);
    if (this.#options.writers.resolve() === undefined) {
      return { status: "refused", reason: "not-effective" };
    }
    if (this.#options.guideRoute(resolved.target.projectId) === undefined) {
      return { status: "refused", reason: "no-model" };
    }
    const thread = authority.linkedThreadIds
      .map((id) => this.#options.readThread(decodeCodeThreadId(id)))
      .find((candidate) => candidate !== undefined && candidate.lifecycle === "active");
    if (thread === undefined) return { status: "refused", reason: "no-thread" };
    return this.#start(resolved, thread, { kind: "person" });
  }

  /**
   * Starts a guide run on the thread's own pull request. `confirm` is the
   * tool's ask below Full access; it runs after the cheap refusals, so the
   * person is never asked about a run that could not start.
   */
  async writeForThread(
    windowId: WindowId,
    threadId: CodeThreadId,
    confirm: ((target: PullRequestReviewTarget) => Promise<boolean>) | undefined,
    signal?: AbortSignal,
  ): Promise<
    | PullRequestGuideStartResult
    | { readonly status: "refused"; readonly reason: string }
    | { readonly status: "not-confirmed" }
  > {
    const own = await this.#options.authority.threadPullRequest(windowId, threadId);
    if (own.status !== "resolved") return { status: "refused", reason: own.reason };
    const resolved = this.#resolveIdentity(own.target, own);
    const thread = this.#options.readThread(threadId);
    if (thread === undefined) return { status: "refused", reason: "no-thread" };
    if (this.#options.writers.resolve() === undefined) {
      return { status: "refused", reason: "not-effective" };
    }
    if (this.#options.guideRoute(resolved.target.projectId) === undefined) {
      return { status: "refused", reason: "no-model" };
    }
    if (this.#running.has(resolved.bucketKey)) {
      return { status: "refused", reason: "running" };
    }
    if (confirm !== undefined && !(await confirm(resolved.target)))
      return { status: "not-confirmed" };
    if (signal?.aborted === true) return { status: "refused", reason: "cancelled" };
    return this.#start(resolved, thread, { kind: "agent", threadId }, signal);
  }

  dispose(): void {
    for (const controller of this.#running.values()) controller.abort();
    this.#running.clear();
  }

  #view(
    bucketKey: string,
    target: PullRequestReviewTarget,
    headSha: string | undefined,
  ): PullRequestGuideView {
    const fold = this.#folds.get(bucketKey);
    const guide = fold?.guide;
    return decodePullRequestGuideView({
      ...(guide === undefined ? {} : { guide }),
      stale: guide !== undefined && headSha !== undefined && guide.headSha !== headSha,
      running: this.#running.has(bucketKey),
      ...(fold?.lastFailure === undefined ||
      (headSha !== undefined &&
        fold.lastFailure.headSha !== undefined &&
        fold.lastFailure.headSha !== headSha)
        ? {}
        : { lastFailure: fold.lastFailure.reason }),
      modelPicked: this.#options.guideRoute(target.projectId) !== undefined,
    });
  }

  async #start(
    identity: ResolvedPullRequestReviewIdentity,
    thread: CodeThread,
    requestedBy: PullRequestGuideRequester,
    signal?: AbortSignal,
  ): Promise<PullRequestGuideStartResult> {
    const { target, bucketKey, writeKey } = identity;
    const activeWriter = this.#options.writers.resolve();
    if (activeWriter === undefined) return { status: "refused", reason: "not-effective" };
    const route = this.#options.guideRoute(target.projectId);
    if (route === undefined) return { status: "refused", reason: "no-model" };
    if (this.#running.has(bucketKey)) return { status: "refused", reason: "running" };
    const controller = new AbortController();
    // The agent's turn being stopped stops the billed run it started.
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    // Claimed before the first await, so a second click cannot start a twin.
    this.#running.set(bucketKey, controller);
    const headSha = await this.#options.runtime
      .readCurrentHeadSha(target, controller.signal)
      .catch(() => undefined);
    const release = () => {
      signal?.removeEventListener("abort", abort);
      for (const [key, active] of this.#running) {
        if (active === controller) this.#running.delete(key);
      }
    };
    if (this.#options.writers.resolve(activeWriter.writerId) === undefined) {
      release();
      return { status: "refused", reason: "not-effective" };
    }
    if (headSha === undefined) {
      release();
      return { status: "refused", reason: "unavailable" };
    }
    const guideId = decodePullRequestGuideId(this.#options.uuid());
    const reservationId = decodeSpendCeilingReservationId(this.#options.uuid());
    try {
      this.#append(bucketKey, writeKey, PULL_REQUEST_GUIDE_EVENT_NAMES.runStarted, {
        kind: "pull-request-guide-run-started",
        guideId,
        linkId: writeKey,
        headSha,
        providerInstanceId: route.providerInstanceId,
        modelId: route.modelId,
        requestedBy,
        reservationId,
      });
    } catch {
      // Nothing ran, and the link must not stay "running" for good.
      release();
      return { status: "refused", reason: "unavailable" };
    }
    // `done` never rejects: a person's run is not awaited, and a journal that
    // closed under it (shutdown) must not leave the link running.
    const done = this.#run({
      target,
      bucketKey,
      writeKey,
      thread,
      route,
      writerId: activeWriter.writerId,
      headSha,
      guideId,
      reservationId,
      controller,
    })
      .catch((): PullRequestGuideRunResult => ({ status: "failed", reason: "unavailable" }))
      .then((result) => {
        if (result.status === "failed") {
          try {
            const latest = this.#resolveIdentity(target);
            this.#append(
              latest.bucketKey,
              latest.writeKey,
              PULL_REQUEST_GUIDE_EVENT_NAMES.runFailed,
              {
                kind: "pull-request-guide-run-failed",
                guideId,
                reason: result.reason,
              },
            );
          } catch {
            // The run is over either way; a restart drops an unfinished run.
          }
        }
        return result;
      })
      .finally(release);
    return { status: "started", target, headSha, done };
  }

  async #run(input: {
    readonly target: PullRequestReviewTarget;
    readonly bucketKey: string;
    readonly writeKey: string;
    readonly thread: CodeThread;
    readonly route: PullRequestReviewRoute;
    readonly writerId: string;
    readonly headSha: string;
    readonly guideId: PullRequestGuide["guideId"];
    readonly reservationId: ReturnType<typeof decodeSpendCeilingReservationId>;
    readonly controller: AbortController;
  }): Promise<PullRequestGuideRunResult> {
    const { runtime } = this.#options;
    const { target, thread, route, writerId, headSha, reservationId } = input;
    const signal = input.controller.signal;
    const spend = runtime.spendCeiling;
    if (
      spend?.admit({
        reservationId,
        threadId: String(thread.id),
        threadType: "code-thread",
        projectId: String(thread.projectId),
        countsAsTurn: true,
      }).status === "refused"
    ) {
      return { status: "failed", reason: "spend-ceiling" };
    }
    let diff: PullRequestReviewDiffSnapshot | undefined;
    let usage: TurnUsage | undefined;
    let turnStarted = false;
    let oversized = false;
    let outcome: Awaited<ReturnType<PullRequestGuideWriterRegistry["run"]>>;
    try {
      outcome = await this.#options.writers.run({
        writerId,
        request: { target, headSha, baseRef: thread.deliveryTarget.proposedBaseBranch },
        host: {
          readPullRequestDiff: async (diffSignal) => {
            const captured = await runtime.capturePullRequestDiff(
              { target, thread, headSha, baseRef: thread.deliveryTarget.proposedBaseBranch },
              diffSignal ?? signal,
            );
            if (captured.status === "stale") return { status: "stale" };
            if (captured.status === "unavailable") {
              return { status: "unavailable", reason: "unavailable" };
            }
            diff = captured.capture.snapshot;
            return { status: "ready", diff };
          },
          runReadOnlyGuideTurn: async (turn, turnSignal): Promise<PullRequestReviewTurnResult> => {
            if (turnStarted) {
              return { status: "refused", reason: "capacity", detail: "A guide run has one turn." };
            }
            const inspection = runtime.inspectRoute({ route, projectId: thread.projectId });
            if (inspection.status === "refused") {
              return {
                status: "refused",
                reason: inspection.reason ?? "route-refused",
                detail: inspection.detail ?? "The guide model is unavailable.",
              };
            }
            turnStarted = true;
            const sessionId = this.#options.uuid();
            const turnInput = {
              route,
              thread,
              prompt: turn.prompt,
              ...(turn.systemInstructions === undefined
                ? {}
                : { systemInstructions: turn.systemInstructions }),
              signal: turnSignal ?? signal,
            };
            let result: PullRequestReviewTurnExecutionResult;
            if (runtime.executeReadOnlyTurn !== undefined) {
              result = await runtime.executeReadOnlyTurn(turnInput);
            } else if (inspection.driver !== undefined) {
              result = await runDriverReadOnlyTurn({
                ...turnInput,
                driver: inspection.driver,
                ...(inspection.modelOptionValues === undefined
                  ? {}
                  : { modelOptionValues: inspection.modelOptionValues }),
                scratchRoot: runtime.scratchRoot,
                sessionId,
                timeoutMs: this.#options.turnTimeoutMs ?? GUIDE_TURN_TIMEOUT_MS,
              });
            } else {
              turnStarted = false;
              return { status: "refused", reason: "no-account", detail: "No guide driver." };
            }
            if (result.status === "refused") {
              turnStarted = false;
              return result;
            }
            usage = result.usage;
            if (result.status !== "completed") return result;
            if (encoder.encode(result.text).byteLength > MAX_PULL_REQUEST_GUIDE_OUTPUT_BYTES) {
              oversized = true;
              return { status: "failed", detail: "The guide was longer than 16 KB." };
            }
            return {
              status: "completed",
              runId: decodeAgentRunId(this.#options.uuid()),
              providerInstanceId: route.providerInstanceId,
              modelId: route.modelId,
              sessionId: result.sessionId,
              text: result.text,
            };
          },
        },
        signal,
      });
    } finally {
      // Settled or abandoned however the writer ends, a throw included, so a
      // failed run never keeps its reservation against the thread's ceiling.
      if (turnStarted) {
        spend?.settle({
          reservationId,
          ...(usage === undefined
            ? {}
            : { observedTokens: usage.inputTokens + usage.outputTokens }),
        });
        // Spend the provider did not report is still recorded, so it is never free.
        runtime.recordUsage?.({
          threadId: thread.id,
          projectId: thread.projectId,
          providerInstanceId: route.providerInstanceId,
          modelId: route.modelId,
          ...(usage === undefined ? {} : { usage }),
        });
      } else {
        spend?.abandon({ reservationId });
      }
    }
    if (oversized || outcome.status === "invalid-output") {
      return { status: "failed", reason: "invalid-output" };
    }
    if (outcome.status === "cancelled" || signal.aborted) {
      return { status: "failed", reason: "cancelled" };
    }
    if (outcome.status === "stale") return { status: "failed", reason: "head-stale" };
    if (outcome.status !== "written") return { status: "failed", reason: "unavailable" };
    const currentHead = await runtime.readCurrentHeadSha(target, signal).catch(() => undefined);
    // GitHub not answering is not a push.
    if (currentHead === undefined) return { status: "failed", reason: "unavailable" };
    if (currentHead !== headSha) return { status: "failed", reason: "head-stale" };
    // Re-check activation bound to the exact writer registration right before
    // persisting so disabling or replacing the plugin during the final head
    // lookup still withholds publication.
    if (!outcome.stillEffective()) return { status: "failed", reason: "unavailable" };
    const stops = validateGuideStops(outcome.stops, diff ?? { files: [] });
    // A guide with no stop says nothing, and recording it would replace the
    // saved one: a diff GitHub failed to give, or a reply whose every stop was
    // malformed, keeps what the person had.
    if (stops.length === 0) return { status: "failed", reason: "invalid-output" };
    const latest = this.#resolveIdentity(target);
    this.#append(latest.bucketKey, latest.writeKey, PULL_REQUEST_GUIDE_EVENT_NAMES.recorded, {
      kind: "pull-request-guide-recorded",
      guideId: input.guideId,
      headSha,
      stops,
      ...(usage === undefined ? {} : { usage }),
    });
    const guide = this.#folds.get(latest.bucketKey)?.guide;
    return guide === undefined
      ? { status: "failed", reason: "unavailable" }
      : { status: "recorded", guide };
  }

  #fold(bucketKey: string): GuideFold {
    let fold = this.#folds.get(bucketKey);
    if (fold === undefined) {
      fold = {
        guide: undefined,
        guideOrder: 0,
        lastFailure: undefined,
        failureOrder: 0,
        started: new Map(),
      };
      this.#folds.set(bucketKey, fold);
    }
    return fold;
  }

  #append(
    bucketKey: string,
    writeKey: string,
    eventName: string,
    payload:
      | PullRequestGuideRunStartedEvent
      | PullRequestGuideRecordedEvent
      | PullRequestGuideRunFailedEvent,
  ): void {
    const fold = this.#fold(bucketKey);
    const aggregateId = guideAggregateId(writeKey);
    const expectedVersion = decodeAggregateVersion(
      this.#aggregateVersions.get(String(aggregateId)) ?? 0,
    );
    const occurredAt = decodeTimestamp(this.#clock());
    const actor: EventActor = { kind: "system", actorId: decodeActorId(OCTANT_LOCAL_ACTOR_ID) };
    this.#options.journal.append({
      aggregate: {
        aggregateType: PULL_REQUEST_GUIDE_AGGREGATE_TYPE,
        aggregateId,
      },
      expectedVersion,
      events: [
        {
          eventId: decodeEventId(this.#options.uuid()),
          eventName,
          eventVersion: 1,
          correlationId: decodeCorrelationId(this.#options.uuid()),
          actor,
          occurredAt,
          payload,
        },
      ],
    });
    this.#aggregateVersions.set(String(aggregateId), expectedVersion + 1);
    this.#eventOrder += 1;
    this.#apply(fold, payload, occurredAt, this.#eventOrder);
  }

  #apply(
    fold: GuideFold,
    payload:
      | PullRequestGuideRunStartedEvent
      | PullRequestGuideRecordedEvent
      | PullRequestGuideRunFailedEvent,
    occurredAt: string,
    order: number,
  ): void {
    if (payload.kind === "pull-request-guide-run-started") {
      fold.started.set(String(payload.guideId), payload);
      return;
    }
    const started = fold.started.get(String(payload.guideId));
    fold.started.delete(String(payload.guideId));
    if (payload.kind === "pull-request-guide-run-failed") {
      fold.lastFailure = { reason: payload.reason, headSha: started?.headSha };
      fold.failureOrder = order;
      return;
    }
    if (started === undefined) return;
    // One guide per head: a rewrite for the same head replaces it.
    fold.guide = {
      guideId: payload.guideId,
      headSha: payload.headSha,
      providerInstanceId: started.providerInstanceId,
      modelId: started.modelId,
      stops: payload.stops,
      recordedAt: decodeTimestamp(occurredAt),
    };
    fold.guideOrder = order;
    fold.lastFailure = undefined;
  }

  #hydrate(): void {
    let linkState: PullRequestLinkRegistryState = emptyPullRequestLinkRegistryState();
    let replayOrder = 0;

    for (const envelope of replayAggregateTypesInOrder(this.#options.journal, [
      CODE_PULL_REQUEST_LINK_AGGREGATE,
      PULL_REQUEST_GUIDE_AGGREGATE_TYPE,
    ])) {
      replayOrder += 1;
      const sequence = envelope.globalSequence ?? replayOrder;
      this.#eventOrder = Math.max(this.#eventOrder, sequence);

      if (envelope.aggregateType === CODE_PULL_REQUEST_LINK_AGGREGATE) {
        const decoded = decodePullRequestLinkEnvelopeEvent(envelope.eventName, envelope.payload);
        if (decoded === undefined) continue;
        const stepped = stepPullRequestLinkReplay(linkState, decoded, sequence);
        linkState = stepped.nextState;
        for (const migration of stepped.migrations) {
          this.#mergeFolds(migration.fromKey, migration.toKey);
        }
        continue;
      }

      const aggregateKey = String(envelope.aggregateId);
      this.#aggregateVersions.set(
        aggregateKey,
        (this.#aggregateVersions.get(aggregateKey) ?? 0) + 1,
      );
      const payload = envelope.payload as
        | PullRequestGuideRunStartedEvent
        | PullRequestGuideRecordedEvent
        | PullRequestGuideRunFailedEvent;
      let bucketKey: string | undefined;
      if (payload.kind === "pull-request-guide-run-started") {
        const legacy = parsePullRequestReviewLegacyTargetKey(payload.linkId);
        if (legacy !== undefined) {
          const link = resolvePullRequestLink(linkState, legacy);
          bucketKey = link !== undefined ? pullRequestLinkBucketKey(link) : payload.linkId;
        } else {
          bucketKey = payload.linkId;
        }
      } else {
        bucketKey = [...this.#folds.entries()].find(([, fold]) =>
          fold.started.has(String(payload.guideId)),
        )?.[0];
      }
      if (bucketKey === undefined) continue;
      this.#apply(this.#fold(bucketKey), payload, envelope.occurredAt, sequence);
    }
    // A run cut off by a restart is not repeated; it simply is no longer running.
    for (const fold of this.#folds.values()) fold.started.clear();
  }
}
