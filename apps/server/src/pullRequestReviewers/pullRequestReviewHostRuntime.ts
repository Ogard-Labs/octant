import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  ActorId,
  CodeDigest,
  CodeGitOperationId,
  MAX_PULL_REQUEST_REVIEW_DIFF_FILES,
  MAX_PULL_REQUEST_REVIEW_FILE_PATCH_BYTES,
  PULL_REQUEST_REVIEW_REQUEST_SHAPE,
  PULL_REQUEST_REVIEW_USAGE_AGGREGATE_TYPE,
  decodeCodeOperationId,
  decodeCodeRelativePath,
  decodePullRequestReviewDiffSnapshot,
  decodeUtcTimestamp,
  type CodeOperationCommand,
  type CodeOperationResult,
  type CodeProjectPullRequestRow,
  type CodeReviewFinding,
  type CodeThread,
  type CodeThreadId,
  type EventActor,
  type ProjectId,
  type ProviderInstance,
  type ProviderInstanceId,
  type ProviderModelId,
  type ProviderObservedState,
  type PullRequestReviewDiffFile,
  type PullRequestReviewTarget,
  type WindowId,
} from "@octant/contracts";
import { parseUnifiedDiff } from "@octant/domain";
import type { PullRequestReviewSummaryCommentResult } from "@octant/plugin-api/pull-request-reviewer";
import type { ProviderDriver } from "@octant/provider-sdk/driver";
import { Schema } from "effect";
import { deriveCodeFileId } from "../code/codeFileIdentity";
import { GhPullRequestActionPort } from "../code/ghPullRequestActionPort";
import { GhPullRequestPort, createGhCommandPort } from "../code/ghPullRequestPort";
import type { Journal } from "../persistence/journal";
import type { SqliteConnection } from "../persistence/sqlitePort";
import { ROUTINE_HOST_SCOPE_ID } from "../routineHostScope";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import { recordOneShotUsage } from "../shield/shieldUsageLedger";
import type { SpendCeilingService } from "../spendCeilingService";
import type { TurnMetricsStore } from "../metrics/turnMetricsStore";
import type {
  ObservedPullRequestHead,
  PullRequestReviewDiffCapture,
  PullRequestReviewHostRuntimePort,
  PullRequestReviewService,
} from "./pullRequestReviewService";

const decodeActorId = Schema.decodeUnknownSync(ActorId);
const decodeCodeDigest = Schema.decodeUnknownSync(CodeDigest);
const decodeCodeGitOperationId = Schema.decodeUnknownSync(CodeGitOperationId);
const encoder = new TextEncoder();

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function truncatePatch(text: string): { readonly patch: string; readonly truncated: boolean } {
  if (encoder.encode(text).byteLength <= MAX_PULL_REQUEST_REVIEW_FILE_PATCH_BYTES) {
    return { patch: text, truncated: false };
  }
  let bytes = 0;
  const kept: string[] = [];
  for (const ch of text) {
    const size = encoder.encode(ch).byteLength;
    if (bytes + size > MAX_PULL_REQUEST_REVIEW_FILE_PATCH_BYTES) break;
    kept.push(ch);
    bytes += size;
  }
  return { patch: kept.join(""), truncated: true };
}

function unifiedDiffToFiles(
  thread: CodeThread,
  diffText: string,
): { readonly files: ReadonlyArray<PullRequestReviewDiffFile>; readonly truncated: boolean } {
  const parsed = parseUnifiedDiff(diffText);
  const limited = parsed.slice(0, MAX_PULL_REQUEST_REVIEW_DIFF_FILES);
  const files: PullRequestReviewDiffFile[] = [];
  for (const entry of limited) {
    if (entry.binary) continue;
    let relativePath;
    try {
      relativePath = decodeCodeRelativePath(entry.path);
    } catch {
      continue;
    }
    const patchBody = entry.hunks
      .map((hunk) => {
        const heading = hunk.heading.length > 0 ? ` ${hunk.heading}` : "";
        const header = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@${heading}`;
        const lines = hunk.lines.map(
          (line) =>
            `${line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "}${line.text}`,
        );
        return [header, ...lines].join("\n");
      })
      .join("\n");
    const bounded = truncatePatch(patchBody);
    const status =
      entry.change === "created"
        ? "added"
        : entry.change === "deleted" || entry.change === "renamed" || entry.change === "modified"
          ? entry.change
          : "modified";
    files.push({
      fileId: deriveCodeFileId(thread.id, thread.checkoutId, String(relativePath)),
      path: relativePath,
      fileDigest: decodeCodeDigest(sha256(patchBody)),
      status,
      patch: bounded.patch,
      ...(bounded.truncated ? { truncated: true } : {}),
    });
  }
  return { files, truncated: parsed.length > MAX_PULL_REQUEST_REVIEW_DIFF_FILES };
}

export interface CreatePullRequestReviewHostRuntimeOptions {
  readonly ghExecutable?: string | undefined;
  readonly providerDataDirectory: string;
  readonly connection: SqliteConnection;
  readonly journal: Journal;
  readonly readProviderInstances: () => ReadonlyArray<ProviderInstance>;
  readonly observedProviderState: (
    instanceId: ProviderInstanceId,
  ) => ProviderObservedState | undefined;
  readonly isProviderModelAllowed: (input: {
    readonly projectId: ProjectId;
    readonly providerInstanceId: ProviderInstanceId;
    readonly modelId: ProviderModelId;
  }) => boolean;
  readonly createDriver: (instance: ProviderInstance) => ProviderDriver | undefined;
  readonly executeOperation: (
    windowId: WindowId,
    command: CodeOperationCommand,
  ) => Promise<CodeOperationResult>;
  readonly readOperationEvidence: (
    windowId: WindowId,
    threadId: CodeThreadId,
    operationId: CodeOperationCommand["operationId"],
    contentId: string,
  ) => Promise<{ readonly text: string }>;
  readonly createFinding: (
    input: Omit<CodeReviewFinding, "state" | "version" | "createdAt" | "updatedAt">,
    actor: EventActor,
  ) => Promise<CodeReviewFinding>;
  readonly spendCeiling: Pick<SpendCeilingService, "admit" | "settle" | "abandon">;
  readonly turnMetrics: Pick<TurnMetricsStore, "record">;
}

export interface PullRequestReviewRuntimeWiring {
  readonly runtime: PullRequestReviewHostRuntimePort;
  readonly observeSnapshotRows: (
    service: PullRequestReviewService,
    rows: ReadonlyArray<CodeProjectPullRequestRow>,
  ) => Promise<void>;
}

export function createPullRequestReviewHostRuntime(
  options: CreatePullRequestReviewHostRuntimeOptions,
): PullRequestReviewRuntimeWiring {
  const scratchRoot = join(options.providerDataDirectory, "pull-request-review-scratch");
  mkdirSync(scratchRoot, { recursive: true });

  const ghCommand =
    options.ghExecutable === undefined
      ? undefined
      : (() => {
          try {
            return createGhCommandPort({ ghPath: options.ghExecutable });
          } catch {
            return undefined;
          }
        })();
  const ghActions =
    ghCommand === undefined ? undefined : new GhPullRequestActionPort({ command: ghCommand });
  const ghPullRequest =
    ghCommand === undefined
      ? undefined
      : new GhPullRequestPort({ command: ghCommand, resolveTarget: async () => undefined });

  const readCurrentHeadSha = async (
    target: PullRequestReviewTarget,
    signal: AbortSignal,
  ): Promise<string | undefined> => {
    if (ghActions === undefined) return undefined;
    const summary = await ghActions.summary(
      {
        owner: String(target.repositoryOwner),
        name: String(target.repositoryName),
        number: target.number,
      },
      signal,
    );
    if (summary.status !== "read" || summary.state !== "open") return undefined;
    return summary.headSha;
  };

  const runtime: PullRequestReviewHostRuntimePort = {
    scratchRoot,
    readCurrentHeadSha,

    capturePullRequestDiff: async (input, signal) => {
      const currentHead = await readCurrentHeadSha(input.target, signal);
      if (currentHead !== input.headSha) {
        return currentHead === undefined
          ? { status: "stale" }
          : { status: "stale", currentHeadSha: currentHead };
      }

      // First try capturing a real `run-reviewed` operation on the thread's
      // checkout so findings carry host-verified diff anchors compatible with
      // `list-review-findings` and `prepare-review-correction`.
      const operationId = decodeCodeOperationId(randomUUID());
      try {
        const result = await options.executeOperation(ROUTINE_HOST_SCOPE_ID, {
          kind: "review-run",
          operationId,
          threadId: input.thread.id,
          checkoutId: input.thread.checkoutId,
          gitOperationId: decodeCodeGitOperationId(randomUUID()),
          maxDiffBytes: 1_048_576,
        });
        if (result.kind === "run-reviewed" && result.outcome.head === input.headSha) {
          const read = await options.readOperationEvidence(
            ROUTINE_HOST_SCOPE_ID,
            input.thread.id,
            operationId,
            String(result.outcome.diff.contentId),
          );
          const { files, truncated } = unifiedDiffToFiles(input.thread, read.text);
          const capturedAt = decodeUtcTimestamp(new Date().toISOString());
          const capture: PullRequestReviewDiffCapture = {
            snapshot: decodePullRequestReviewDiffSnapshot({
              headSha: input.headSha,
              baseRef: result.outcome.baseRef,
              ...(result.outcome.base === undefined ? {} : { baseSha: result.outcome.base }),
              reviewOperationId: operationId,
              files,
              ...(truncated || result.outcome.diff.truncated === true ? { truncated: true } : {}),
            }),
            retained: {
              operationId,
              evidence: result.outcome.diff,
              revision: {
                kind: "branch",
                head: result.outcome.head,
                ...(result.outcome.base === undefined ? {} : { base: result.outcome.base }),
                baseRef: result.outcome.baseRef,
              },
              capturedAt,
              text: read.text,
            },
          };
          return { status: "ready", capture };
        }
      } catch {
        // Fall through to host-observed PR diff below when local checkout head differs.
      }

      if (ghPullRequest === undefined) return { status: "unavailable" };
      const observed = await ghPullRequest.observeReviewByIdentity(
        {
          owner: String(input.target.repositoryOwner),
          name: String(input.target.repositoryName),
          number: input.target.number,
          maxDiffBytes: 1_048_576,
        },
        signal,
      );
      if (observed.status !== "observed") return { status: "unavailable" };
      const observedHeadSha = observed.pullRequest.headSha;
      if (observedHeadSha.length === 0) return { status: "unavailable" };
      if (observedHeadSha !== input.headSha) {
        return { status: "stale", currentHeadSha: observedHeadSha };
      }
      const { files, truncated } = unifiedDiffToFiles(input.thread, observed.diff);
      return {
        status: "ready",
        capture: {
          snapshot: decodePullRequestReviewDiffSnapshot({
            headSha: observedHeadSha,
            baseRef: input.baseRef,
            ...(input.baseSha === undefined ? {} : { baseSha: input.baseSha }),
            reviewOperationId: operationId,
            files,
            ...(truncated || observed.diffTruncated ? { truncated: true } : {}),
          }),
        },
      };
    },

    inspectRoute: ({ route, projectId }) => {
      const instance = options
        .readProviderInstances()
        .find((candidate) => String(candidate.id) === String(route.providerInstanceId));
      if (instance === undefined || !instance.enabled) {
        return {
          status: "refused",
          reason: "no-account",
          detail:
            "The configured reviewer provider account is missing or disabled. Octant will not fall back silently.",
        };
      }
      const state = options.observedProviderState(instance.id);
      if (
        state !== undefined &&
        (state.readiness === "unauthenticated" ||
          state.readiness === "unavailable" ||
          state.readiness === "incompatible")
      ) {
        return {
          status: "refused",
          reason: "no-account",
          detail: `The configured reviewer account (${instance.displayName}) is ${state.readiness}. Octant will not fall back silently.`,
        };
      }
      if (
        !options.isProviderModelAllowed({
          projectId,
          providerInstanceId: route.providerInstanceId,
          modelId: route.modelId,
        })
      ) {
        return {
          status: "refused",
          reason: "route-refused",
          detail: `The reviewer model ${String(route.modelId)} is not allowed for this Project. Octant will not fall back silently.`,
        };
      }
      const driver = options.createDriver(instance);
      if (driver === undefined) {
        return {
          status: "refused",
          reason: "no-account",
          detail: `No driver is available for reviewer account ${instance.displayName}.`,
        };
      }
      return { status: "ready", driver };
    },

    postSummaryComment: async (
      { target, body },
      signal,
    ): Promise<PullRequestReviewSummaryCommentResult> => {
      if (ghActions === undefined) {
        return { status: "unavailable", reason: "unavailable" };
      }
      const result = await ghActions.comment(
        {
          owner: String(target.repositoryOwner),
          name: String(target.repositoryName),
          number: target.number,
          body,
        },
        signal,
      );
      if (result.status === "done") return { status: "posted" };
      if (result.status === "unavailable") {
        return { status: "unavailable", reason: result.reason };
      }
      return { status: "refused", reason: "not-authorized" };
    },

    findings: {
      create: (input) =>
        options.createFinding(input, {
          kind: "system",
          actorId: decodeActorId(OCTANT_LOCAL_ACTOR_ID),
        }),
    },

    spendCeiling: options.spendCeiling,
    turnMetrics: options.turnMetrics,

    recordUsage: ({ threadId, providerInstanceId, modelId, usage }) => {
      recordOneShotUsage(
        {
          connection: options.connection,
          journal: options.journal,
          clock: () => new Date().toISOString(),
          uuid: randomUUID,
        },
        {
          threadId: String(threadId),
          providerInstanceId,
          modelId,
          usage,
          aggregateType: PULL_REQUEST_REVIEW_USAGE_AGGREGATE_TYPE,
          requestShape: PULL_REQUEST_REVIEW_REQUEST_SHAPE,
        },
      );
    },
  };

  const observeSnapshotRows = async (
    service: PullRequestReviewService,
    rows: ReadonlyArray<CodeProjectPullRequestRow>,
  ): Promise<void> => {
    if (ghActions === undefined) return;
    const observations: ObservedPullRequestHead[] = [];
    for (const row of rows) {
      if (row.state !== "open") continue;
      const linked = row.linkedThreads[0];
      if (linked === undefined) continue;
      const target: PullRequestReviewTarget = {
        projectId: row.projectId,
        repositoryOwner: row.repositoryOwner,
        repositoryName: row.repositoryName,
        number: row.number,
      };
      const controller = new AbortController();
      const headSha = await readCurrentHeadSha(target, controller.signal).catch(() => undefined);
      if (headSha === undefined) continue;
      observations.push({
        target,
        threadId: linked.threadId,
        headSha,
        baseRef: row.baseBranch,
        state: row.draft ? "draft" : "open",
      });
    }
    if (observations.length > 0) {
      await service.observePullRequests(observations);
    }
  };

  return { runtime, observeSnapshotRows };
}
