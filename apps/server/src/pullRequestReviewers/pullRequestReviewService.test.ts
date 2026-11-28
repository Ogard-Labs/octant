import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodeDigest,
  GithubRepositoryName,
  GithubRepositoryOwner,
  decodeCodeCheckoutId,
  decodeCodeEvidenceContentId,
  decodeCodeFileId,
  decodeCodeOperationId,
  decodeCodeRelativePath,
  decodeCodeRepositoryId,
  decodeCodeReviewFinding,
  decodeCodeThread,
  decodeCodeThreadId,
  decodeProjectId,
  decodeProviderInstanceId,
  decodeProviderModelId,
  decodePullRequestReviewDiffSnapshot,
  decodeUtcTimestamp,
  decodeWindowId,
  type CodeReviewFinding,
  type CodeThread,
  type EventActor,
  type ProviderRuntimeEvent,
  type PullRequestReviewRoute,
  type PullRequestReviewTarget,
  type TurnUsage,
} from "@octant/contracts";
import { settleSpendCeilingReservation } from "@octant/domain";
import { Effect, Schema, Stream } from "effect";
import type { ProviderDriver } from "@octant/provider-sdk/driver";
import { afterEach, describe, expect, it } from "vitest";
import { PullRequestLinkService } from "../code/pullRequestLinkService";
import { TurnMetricsStore } from "../metrics/turnMetricsStore";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import { PullRequestReviewerRegistry } from "./pullRequestReviewerRegistry";
import {
  PullRequestReviewService,
  type PullRequestReviewDiffCapture,
  type PullRequestReviewHostRuntimePort,
  type PullRequestReviewRouteInspection,
  type PullRequestReviewTurnExecutionInput,
  type PullRequestReviewTurnExecutionResult,
} from "./pullRequestReviewService";
import {
  SECOND_MODEL_PULL_REQUEST_REVIEWER_DISPLAY_NAME,
  SECOND_MODEL_PULL_REQUEST_REVIEWER_ID,
  createSecondModelPullRequestReviewer,
} from "./secondModelPullRequestReviewer";

const NOW = "2026-11-20T12:00:00.000Z";
const WINDOW_ID = decodeWindowId("10000000-0000-4000-8000-000000000001");
const PROJECT_ID = decodeProjectId("20000000-0000-4000-8000-000000000001");
const THREAD_ID = decodeCodeThreadId("30000000-0000-4000-8000-000000000001");
const CHECKOUT_ID = decodeCodeCheckoutId("40000000-0000-4000-8000-000000000001");
const REPO_ID = decodeCodeRepositoryId(`repo_${"5".repeat(64)}`);
const WORKER_PROVIDER_ID = decodeProviderInstanceId("60000000-0000-4000-8000-000000000001");
const REVIEWER_PROVIDER_ID = decodeProviderInstanceId("60000000-0000-4000-8000-000000000002");
const WORKER_MODEL_ID = decodeProviderModelId("claude-sonnet-4-5");
const REVIEWER_MODEL_ID = decodeProviderModelId("gpt-5.3-codex");
const HEAD_1 = "a".repeat(40);
const HEAD_2 = "b".repeat(40);
const HEAD_3 = "c".repeat(40);
const HEAD_4 = "d".repeat(40);
const BASE_SHA = "9".repeat(40);
const LOCAL_ACTOR: EventActor = { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID as never };

const TARGET: PullRequestReviewTarget = {
  projectId: PROJECT_ID,
  repositoryOwner: Schema.decodeUnknownSync(GithubRepositoryOwner)("ogard-labs"),
  repositoryName: Schema.decodeUnknownSync(GithubRepositoryName)("octant"),
  number: 42,
};

const REVIEWER_ROUTE: PullRequestReviewRoute = {
  providerInstanceId: REVIEWER_PROVIDER_ID,
  modelId: REVIEWER_MODEL_ID,
  effort: "high",
};

const SAMPLE_DIFF = [
  "diff --git a/src/auth.ts b/src/auth.ts",
  "--- a/src/auth.ts",
  "+++ b/src/auth.ts",
  "@@ -1,3 +1,4 @@",
  " export function allow(role: string) {",
  "+  if (role === 'guest') return true;",
  "   return role === 'owner';",
  " }",
  "",
].join("\n");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeThread(executionPolicy: CodeThread["executionPolicy"] = "full-access"): CodeThread {
  return decodeCodeThread({
    id: THREAD_ID,
    projectId: PROJECT_ID,
    bindingRevisionId: "51000000-0000-4000-8000-000000000001",
    repositoryId: REPO_ID,
    checkoutId: CHECKOUT_ID,
    title: "Tighten auth check",
    providerInstanceId: WORKER_PROVIDER_ID,
    modelId: WORKER_MODEL_ID,
    executionPolicy,
    permissionPersistence: "current-session",
    lifecycle: "active",
    deliveryTarget: {
      remoteName: "origin",
      proposedBaseRepository: "ogard-labs/octant",
      proposedBaseBranch: "main",
      branchIntent: "feature/auth",
      outcomeKind: "opened-pr",
      confirmedAt: NOW,
    },
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function makeDiffCapture(headSha: string): PullRequestReviewDiffCapture {
  const operationId = decodeCodeOperationId("70000000-0000-4000-8000-000000000001");
  const diffDigest = Schema.decodeUnknownSync(CodeDigest)(
    createHash("sha256").update(SAMPLE_DIFF).digest("hex"),
  );
  return {
    snapshot: decodePullRequestReviewDiffSnapshot({
      headSha,
      baseRef: "origin/main",
      baseSha: BASE_SHA,
      reviewOperationId: operationId,
      files: [
        {
          fileId: decodeCodeFileId("71000000-0000-4000-8000-000000000001"),
          path: decodeCodeRelativePath("src/auth.ts"),
          fileDigest: diffDigest,
          status: "modified",
          patch: SAMPLE_DIFF,
        },
      ],
    }),
    retained: {
      operationId,
      evidence: {
        contentId: decodeCodeEvidenceContentId("72000000-0000-4000-8000-000000000001"),
        digest: diffDigest,
        byteLength: Buffer.byteLength(SAMPLE_DIFF),
      },
      revision: {
        kind: "branch",
        head: headSha,
        base: BASE_SHA,
        baseRef: "origin/main",
      },
      capturedAt: decodeUtcTimestamp(NOW),
      text: SAMPLE_DIFF,
    },
  };
}

function createHarness(options?: {
  readonly pluginEnabled?: () => boolean;
  readonly strict?: () => boolean;
  readonly workerTurnActive?: () => boolean;
  readonly currentHeadSha?: () => string | undefined;
  readonly inspectRoute?: () => PullRequestReviewRouteInspection;
  readonly executeReadOnlyTurn?: (
    input: PullRequestReviewTurnExecutionInput,
  ) => Promise<PullRequestReviewTurnExecutionResult>;
  readonly markOutsideContent?: () => boolean;
  readonly spendCeilingAdmit?: () =>
    | { readonly status: "admitted" }
    | { readonly status: "refused" };
  readonly useDriverDirectly?: boolean;
  readonly turnTimeoutMs?: number;
  readonly onPostSummaryComment?: () => void;
  readonly onStartWorkerTurn?: () => void;
  readonly failAppendOnEventName?: () => string | undefined;
}) {
  const dir = mkdtempSync(join(tmpdir(), "octant-pr-review-service-"));
  dirs.push(dir);
  const connection = openSqlite(join(dir, "octant.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => NOW);
  const registries = createPhase1RuntimeRegistries();
  const rawJournal = new Journal({
    connection,
    registry: registries.events,
    projections: registries.projections,
    clock: () => NOW,
  });
  const journal: Pick<Journal, "append" | "replayAggregateType"> = {
    append: (input: Parameters<Journal["append"]>[0]) => {
      const failEventName = options?.failAppendOnEventName?.();
      const batch = input as { readonly events: ReadonlyArray<{ readonly eventName: string }> };
      if (
        failEventName !== undefined &&
        batch.events.some((event) => event.eventName === failEventName)
      ) {
        throw new Error(`Simulated crash before journaling ${failEventName}`);
      }
      return rawJournal.append(input);
    },
    replayAggregateType: (aggregateType) => rawJournal.replayAggregateType(aggregateType),
  };

  let counter = 0;
  const uuid = () => `80000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
  const turnMetrics = new TurnMetricsStore({
    journal: rawJournal,
    uuid,
    actor: { kind: "system", actorId: OCTANT_LOCAL_ACTOR_ID as never },
    clock: () => NOW,
  });

  const registry = new PullRequestReviewerRegistry();
  let pluginActive = true;
  registry.register({
    reviewerId: SECOND_MODEL_PULL_REQUEST_REVIEWER_ID,
    displayName: SECOND_MODEL_PULL_REQUEST_REVIEWER_DISPLAY_NAME,
    activation: () => ({
      installed: true,
      trusted: true,
      enabled: options?.pluginEnabled ? options.pluginEnabled() : pluginActive,
    }),
    reviewer: createSecondModelPullRequestReviewer(),
  });

  const thread = makeThread("full-access");
  const recordedFindings: CodeReviewFinding[] = [];
  const postedComments: Array<{ readonly target: PullRequestReviewTarget; readonly body: string }> =
    [];
  const outsideMarks: Array<{ readonly threadId: string; readonly sourceLabel: string }> = [];
  const workerWakes: Array<{ readonly threadId: string; readonly text: string }> = [];
  const notifications: Array<{ readonly threadId: string; readonly reason: string }> = [];
  const recordedUsages: Array<{ readonly threadId: string; readonly usage?: TurnUsage }> = [];
  const ceilingEvents: string[] = [];
  const settledTokens: Array<number | undefined> = [];
  let turnCalls = 0;

  const runtime: PullRequestReviewHostRuntimePort = {
    scratchRoot: dir,
    readCurrentHeadSha: async () => (options?.currentHeadSha ? options.currentHeadSha() : HEAD_1),
    capturePullRequestDiff: async ({ headSha }) => ({
      status: "ready",
      capture: makeDiffCapture(headSha),
    }),
    inspectRoute: () => options?.inspectRoute?.() ?? { status: "ready" },
    ...(options?.useDriverDirectly === true
      ? {}
      : {
          executeReadOnlyTurn: async (input) => {
            turnCalls += 1;
            if (options?.executeReadOnlyTurn !== undefined) {
              return options.executeReadOnlyTurn(input);
            }
            return {
              status: "completed",
              sessionId: `review-session-${turnCalls}`,
              text: JSON.stringify({
                findings: [
                  {
                    path: "src/auth.ts",
                    line: 2,
                    side: "modified",
                    severity: "error",
                    summary: "Guests must not be granted owner access.",
                  },
                ],
              }),
              usage: { inputTokens: 1200, outputTokens: 180 },
            };
          },
        }),
    postSummaryComment: async ({ target, body }) => {
      postedComments.push({ target, body });
      options?.onPostSummaryComment?.();
      return { status: "posted", commentId: `comment-${postedComments.length}` };
    },
    findings: {
      create: async (input) => {
        const created = decodeCodeReviewFinding({
          ...input,
          state: "open",
          version: 1,
          createdAt: NOW,
          updatedAt: NOW,
        });
        recordedFindings.push(created);
        return created;
      },
    },
    spendCeiling: {
      admit: () => {
        const decision = options?.spendCeilingAdmit?.() ?? { status: "admitted" };
        ceilingEvents.push(`admit:${decision.status}`);
        return decision as never;
      },
      settle: (input) => {
        ceilingEvents.push("settle");
        settledTokens.push(input.observedTokens);
      },
      abandon: () => {
        ceilingEvents.push("abandon");
      },
    },
    turnMetrics,
    recordUsage: ({ threadId, usage }) => {
      recordedUsages.push({
        threadId: String(threadId),
        ...(usage === undefined ? {} : { usage }),
      });
    },
  };

  const pullRequestLinks = new PullRequestLinkService({
    journal: rawJournal,
    uuid,
    clock: () => NOW,
  });

  const makeService = (serviceOptions?: { readonly withLinks?: boolean }) =>
    new PullRequestReviewService({
      registry,
      journal,
      ...(serviceOptions?.withLinks === true ? { pullRequestLinks } : {}),
      authority: {
        canAccessProject: () => true,
        authorizePullRequest: async (_windowId, requestedTarget) => {
          const link =
            serviceOptions?.withLinks === true
              ? pullRequestLinks.resolveLink({
                  projectId: requestedTarget.projectId,
                  repositoryOwner: requestedTarget.repositoryOwner,
                  repositoryName: requestedTarget.repositoryName,
                  number: requestedTarget.number,
                })
              : undefined;
          return {
            status: "authorized",
            linkedThreadIds: [String(THREAD_ID)],
            ...(link?.pullRequestNodeId === undefined
              ? {}
              : { pullRequestNodeId: link.pullRequestNodeId }),
          };
        },
      },
      threads: {
        readThread: (id) => (String(id) === String(THREAD_ID) ? thread : undefined),
        isWorkerTurnActive: () => options?.workerTurnActive?.() ?? false,
        isStrict: () => options?.strict?.() ?? false,
        maxStrictHandBackAttempts: () => 3,
        markOutsideContent: (threadId, _ref, sourceLabel) => {
          outsideMarks.push({ threadId: String(threadId), sourceLabel });
          return options?.markOutsideContent?.() ?? true;
        },
        startWorkerTurn: async (threadId, text) => {
          workerWakes.push({ threadId: String(threadId), text });
          options?.onStartWorkerTurn?.();
          return true;
        },
        notifyPerson: async (threadId, reason) => {
          notifications.push({ threadId: String(threadId), reason });
        },
      },
      runtime,
      uuid,
      clock: () => NOW,
      ...(options?.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: options.turnTimeoutMs }),
    });

  const service = makeService();
  return {
    service,
    makeService,
    pullRequestLinks,
    turnMetrics,
    recordedFindings,
    postedComments,
    outsideMarks,
    workerWakes,
    notifications,
    recordedUsages,
    ceilingEvents,
    settledTokens,
    getTurnCalls: () => turnCalls,
    setPluginActive: (active: boolean) => {
      pluginActive = active;
    },
  };
}

describe("second-model pull request reviewer service", () => {
  it("stays off by default, creates agent-authored findings with reviewer provenance, records spend under the thread, and posts zero GitHub comments when opt-ins are off", async () => {
    const h = createHarness();

    // Off by default: observing a PR head does nothing.
    const skipped = await h.service.reviewPullRequestHead({
      target: TARGET,
      threadId: THREAD_ID,
      headSha: HEAD_1,
      baseRef: "origin/main",
      baseSha: BASE_SHA,
      state: "open",
    });
    expect(skipped).toBeUndefined();
    expect(h.getTurnCalls()).toBe(0);

    // Turning on without a model is refused (no default model).
    const noModel = await h.service.updateProjectSettings(
      WINDOW_ID,
      { projectId: PROJECT_ID, enabled: true, postSummaryComment: false },
      "local-window",
      LOCAL_ACTOR,
    );
    expect(noModel).toMatchObject({ status: "refused", reason: "no-route-configured" });

    // Enable with an explicit reviewer route, summary comment & hand-back still off.
    const updated = await h.service.updateProjectSettings(
      WINDOW_ID,
      {
        projectId: PROJECT_ID,
        enabled: true,
        route: REVIEWER_ROUTE,
        postSummaryComment: false,
      },
      "local-window",
      LOCAL_ACTOR,
    );
    expect(updated.status).toBe("ok");

    const record = await h.service.reviewPullRequestHead({
      target: TARGET,
      threadId: THREAD_ID,
      headSha: HEAD_1,
      baseRef: "origin/main",
      baseSha: BASE_SHA,
      state: "open",
    });

    expect(record?.status).toBe("completed");
    expect(record?.findingIds).toHaveLength(1);
    expect(record?.summaryCommentPosted).toBe(false);
    expect(record?.handedBackToWorker).toBe(false);

    // Finding carries agent author, reviewer provenance, digest, and diff anchor.
    expect(h.recordedFindings).toHaveLength(1);
    const finding = h.recordedFindings[0];
    expect(finding?.author).toEqual({
      kind: "agent",
      providerInstanceId: REVIEWER_PROVIDER_ID,
      sessionId: "review-session-1",
    });
    expect(finding?.provenance).toMatchObject({
      kind: "pull-request-reviewer",
      reviewerId: String(SECOND_MODEL_PULL_REQUEST_REVIEWER_ID),
      providerInstanceId: REVIEWER_PROVIDER_ID,
      modelId: REVIEWER_MODEL_ID,
      effort: "high",
      headSha: HEAD_1,
    });
    expect(finding?.anchor?.revision).toEqual({
      kind: "branch",
      head: HEAD_1,
      base: BASE_SHA,
      baseRef: "origin/main",
    });

    // Spend ceiling, usage ledger, and turn metrics are all recorded under the parent thread.
    expect(h.ceilingEvents).toEqual(["admit:admitted", "settle"]);
    expect(h.recordedUsages).toEqual([
      { threadId: String(THREAD_ID), usage: { inputTokens: 1200, outputTokens: 180 } },
    ]);
    const threadTurns = h.turnMetrics.forThread(String(THREAD_ID));
    expect(threadTurns).toHaveLength(1);
    expect(threadTurns[0]?.modelId).toBe(REVIEWER_MODEL_ID);

    // Both opt-ins are off by default: zero PR comments and zero automatic worker wakes.
    expect(h.postedComments).toHaveLength(0);
    expect(h.workerWakes).toHaveLength(0);
  });

  it("runs at most once per head SHA even under repeated pushes and across restart, and waits until the worker turn settles", async () => {
    let workerBusy = true;
    const h = createHarness({ workerTurnActive: () => workerBusy });
    await h.service.updateProjectSettings(
      WINDOW_ID,
      { projectId: PROJECT_ID, enabled: true, route: REVIEWER_ROUTE, postSummaryComment: false },
      "local-window",
      LOCAL_ACTOR,
    );

    // Worker turn still running: defers.
    expect(
      await h.service.reviewPullRequestHead({
        target: TARGET,
        threadId: THREAD_ID,
        headSha: HEAD_1,
        baseRef: "origin/main",
        state: "open",
      }),
    ).toBeUndefined();
    expect(h.getTurnCalls()).toBe(0);

    // Worker settles: runs once.
    workerBusy = false;
    const first = await h.service.reviewPullRequestHead({
      target: TARGET,
      threadId: THREAD_ID,
      headSha: HEAD_1,
      baseRef: "origin/main",
      state: "open",
    });
    expect(first?.status).toBe("completed");
    expect(h.getTurnCalls()).toBe(1);

    // Repeated observations / pushes of the same head SHA do nothing.
    expect(
      await h.service.reviewPullRequestHead({
        target: TARGET,
        threadId: THREAD_ID,
        headSha: HEAD_1,
        baseRef: "origin/main",
        state: "open",
      }),
    ).toBeUndefined();
    expect(h.getTurnCalls()).toBe(1);

    // After restart, replayed journal still remembers HEAD_1 was reviewed.
    const restarted = h.makeService();
    expect(
      await restarted.reviewPullRequestHead({
        target: TARGET,
        threadId: THREAD_ID,
        headSha: HEAD_1,
        baseRef: "origin/main",
        state: "open",
      }),
    ).toBeUndefined();
    expect(h.getTurnCalls()).toBe(1);
  });

  it("records a stale review and posts neither a comment nor a worker wake when the PR head moves mid-review", async () => {
    let head = HEAD_1;
    const h = createHarness({
      currentHeadSha: () => head,
      executeReadOnlyTurn: async () => {
        // Head moves while the model is reviewing HEAD_1.
        head = HEAD_2;
        return {
          status: "completed",
          sessionId: "stale-session",
          text: JSON.stringify({
            findings: [
              { path: "src/auth.ts", line: 2, severity: "error", summary: "Stale finding." },
            ],
          }),
        };
      },
    });
    await h.service.updateProjectSettings(
      WINDOW_ID,
      { projectId: PROJECT_ID, enabled: true, route: REVIEWER_ROUTE, postSummaryComment: true },
      "local-window",
      LOCAL_ACTOR,
    );
    await h.service.updatePullRequestSettings(
      WINDOW_ID,
      { target: TARGET, sendBlockingFindingsToWorker: true },
      "local-window",
      LOCAL_ACTOR,
    );

    const record = await h.service.reviewPullRequestHead({
      target: TARGET,
      threadId: THREAD_ID,
      headSha: HEAD_1,
      baseRef: "origin/main",
      state: "open",
    });

    expect(record?.status).toBe("stale");
    expect(record?.currentHeadSha).toBe(HEAD_2);
    expect(h.recordedFindings).toHaveLength(0);
    expect(h.postedComments).toHaveLength(0);
    expect(h.workerWakes).toHaveLength(0);
  });

  it("posts at most one plain summary comment when postSummaryComment is enabled and never performs a formal GitHub review", async () => {
    const h = createHarness();
    await h.service.updateProjectSettings(
      WINDOW_ID,
      { projectId: PROJECT_ID, enabled: true, route: REVIEWER_ROUTE, postSummaryComment: true },
      "local-window",
      LOCAL_ACTOR,
    );

    const record = await h.service.reviewPullRequestHead({
      target: TARGET,
      threadId: THREAD_ID,
      headSha: HEAD_1,
      baseRef: "origin/main",
      state: "open",
    });

    expect(record?.status).toBe("completed");
    expect(record?.summaryCommentPosted).toBe(true);
    expect(h.postedComments).toHaveLength(1);
    expect(h.postedComments[0]?.body).toContain("Second-model review");
    expect(h.postedComments[0]?.body).toContain("does not approve or request changes");
  });

  it("wakes the worker through the outside-content-marked path and enforces the 3-attempt cap under Strict while leaving non-Strict uncapped", async () => {
    let head = HEAD_1;
    let strict = true;
    const h = createHarness({
      currentHeadSha: () => head,
      strict: () => strict,
    });
    await h.service.updateProjectSettings(
      WINDOW_ID,
      { projectId: PROJECT_ID, enabled: true, route: REVIEWER_ROUTE, postSummaryComment: false },
      "local-window",
      LOCAL_ACTOR,
    );
    await h.service.updatePullRequestSettings(
      WINDOW_ID,
      { target: TARGET, sendBlockingFindingsToWorker: true },
      "local-window",
      LOCAL_ACTOR,
    );

    // Three heads under Strict -> 3 hand-backs succeed, each marked as outside content first.
    for (const sha of [HEAD_1, HEAD_2, HEAD_3]) {
      head = sha;
      const run = await h.service.reviewPullRequestHead({
        target: TARGET,
        threadId: THREAD_ID,
        headSha: sha,
        baseRef: "origin/main",
        state: "open",
      });
      expect(run?.handedBackToWorker).toBe(true);
    }
    expect(h.workerWakes).toHaveLength(3);
    expect(h.outsideMarks.every((mark) => mark.sourceLabel === "pull-request-review")).toBe(true);
    expect(h.workerWakes[0]?.text).toContain("Never force-push");
    expect(h.workerWakes[0]?.text).toContain("BEGIN OUTSIDE CONTENT (pull-request-review)");

    // 4th head under Strict hits the 3-attempt cap and notifies the person instead of waking the worker.
    head = HEAD_4;
    const capped = await h.service.reviewPullRequestHead({
      target: TARGET,
      threadId: THREAD_ID,
      headSha: HEAD_4,
      baseRef: "origin/main",
      state: "open",
    });
    expect(capped?.handedBackToWorker).toBe(false);
    expect(h.workerWakes).toHaveLength(3);
    expect(h.notifications).toHaveLength(1);

    // Outside Strict, a 5th head is NOT capped and wakes the worker cleanly.
    strict = false;
    const head5 = "e".repeat(40);
    head = head5;
    const uncapped = await h.service.reviewPullRequestHead({
      target: TARGET,
      threadId: THREAD_ID,
      headSha: head5,
      baseRef: "origin/main",
      state: "open",
    });
    expect(uncapped?.handedBackToWorker).toBe(true);
    expect(h.workerWakes).toHaveLength(4);
  });

  it("records explicit unavailable reasons without silent fallback for no-account, spend-ceiling, and disabled plugin", async () => {
    const noAccount = createHarness({
      inspectRoute: () => ({
        status: "refused",
        reason: "no-account",
        detail: "Reviewer account is signed out.",
      }),
    });
    await noAccount.service.updateProjectSettings(
      WINDOW_ID,
      { projectId: PROJECT_ID, enabled: true, route: REVIEWER_ROUTE, postSummaryComment: false },
      "local-window",
      LOCAL_ACTOR,
    );
    const noAccountRun = await noAccount.service.reviewPullRequestHead({
      target: TARGET,
      threadId: THREAD_ID,
      headSha: HEAD_1,
      baseRef: "origin/main",
      state: "open",
    });
    expect(noAccountRun).toMatchObject({
      status: "refused",
      reason: "no-account",
      detail: "Reviewer account is signed out.",
    });
    expect(noAccount.getTurnCalls()).toBe(0);

    const ceiling = createHarness({
      spendCeilingAdmit: () => ({ status: "refused" }),
    });
    await ceiling.service.updateProjectSettings(
      WINDOW_ID,
      { projectId: PROJECT_ID, enabled: true, route: REVIEWER_ROUTE, postSummaryComment: false },
      "local-window",
      LOCAL_ACTOR,
    );
    const ceilingRun = await ceiling.service.reviewPullRequestHead({
      target: TARGET,
      threadId: THREAD_ID,
      headSha: HEAD_1,
      baseRef: "origin/main",
      state: "open",
    });
    expect(ceilingRun).toMatchObject({ status: "refused", reason: "spend-ceiling" });
    expect(ceiling.getTurnCalls()).toBe(0);

    const disabled = createHarness({ pluginEnabled: () => false });
    await disabled.service.updateProjectSettings(
      WINDOW_ID,
      { projectId: PROJECT_ID, enabled: true, route: REVIEWER_ROUTE, postSummaryComment: false },
      "local-window",
      LOCAL_ACTOR,
    );
    const disabledRun = await disabled.service.reviewPullRequestHead({
      target: TARGET,
      threadId: THREAD_ID,
      headSha: HEAD_1,
      baseRef: "origin/main",
      state: "open",
    });
    expect(disabledRun).toMatchObject({ status: "refused", reason: "not-effective" });
    expect(disabled.getTurnCalls()).toBe(0);
  });

  it("interrupts the running provider fiber, awaits connection stop before returning, and preserves partial usage on cancellation", async () => {
    let activeSessionId: string | undefined;
    let sendStarted: (() => void) | undefined;
    const sendReady = new Promise<void>((resolve) => {
      sendStarted = resolve;
    });
    let stopStarted = false;
    let stopCompleted = false;
    let fiberInterrupted = false;
    const pendingEvents: ProviderRuntimeEvent[] = [];
    let flushPending: (() => void) | undefined;

    const hangingDriver: ProviderDriver = {
      kind: "codex",
      probe: () => Effect.die("unused"),
      acquire: () =>
        Effect.succeed({
          start: (input: { readonly sessionId: string }) =>
            Effect.sync(() => {
              activeSessionId = String(input.sessionId);
            }),
          send: () =>
            Effect.sync(() => {
              pendingEvents.push({
                kind: "usage",
                sessionId: activeSessionId as never,
                inputTokens: 450,
                outputTokens: 60,
              } as never);
              flushPending?.();
              sendStarted?.();
            }),
          stop: () =>
            Effect.promise(async () => {
              stopStarted = true;
              await new Promise((resolve) => setTimeout(resolve, 15));
              stopCompleted = true;
            }),
          subscribe: Effect.succeed(
            Stream.async<ProviderRuntimeEvent>((emit) => {
              const flush = () => {
                for (const event of pendingEvents.splice(0)) {
                  void emit.single(event);
                }
              };
              flushPending = flush;
              flush();
              return Effect.sync(() => {
                fiberInterrupted = true;
              });
            }),
          ),
        } as never),
    };

    const h = createHarness({
      useDriverDirectly: true,
      inspectRoute: () => ({ status: "ready", driver: hangingDriver }),
    });
    await h.service.updateProjectSettings(
      WINDOW_ID,
      { projectId: PROJECT_ID, enabled: true, route: REVIEWER_ROUTE, postSummaryComment: false },
      "local-window",
      LOCAL_ACTOR,
    );

    const runPromise = h.service.reviewPullRequestHead({
      target: TARGET,
      threadId: THREAD_ID,
      headSha: HEAD_1,
      baseRef: "origin/main",
      state: "open",
    });

    await sendReady;
    // Wait a tick for the usage event to be consumed before aborting.
    await new Promise((resolve) => setTimeout(resolve, 10));
    h.service.dispose();

    const result = await runPromise;
    expect(result?.status).toBe("cancelled");
    expect(fiberInterrupted).toBe(true);
    expect(stopStarted).toBe(true);
    expect(stopCompleted).toBe(true);
    // Partial usage from the interrupted turn is settled and recorded, not abandoned.
    expect(h.ceilingEvents).toEqual(["admit:admitted", "settle"]);
    expect(h.recordedUsages).toEqual([
      { threadId: String(THREAD_ID), usage: { inputTokens: 450, outputTokens: 60 } },
    ]);
  });

  it("records no overrun for a review whose output, thinking included, fits its reservation", async () => {
    // A provider reports thinking as part of output, so 1,000 input and 400
    // output (300 of it thinking) is 1,400 tokens, inside a 1,500 reservation.
    const h = createHarness({
      executeReadOnlyTurn: async () => ({
        status: "completed",
        sessionId: "review-session-reasoning",
        text: JSON.stringify({ findings: [] }),
        usage: { inputTokens: 1000, outputTokens: 400, reasoningTokens: 300 },
      }),
    });
    await h.service.updateProjectSettings(
      WINDOW_ID,
      { projectId: PROJECT_ID, enabled: true, route: REVIEWER_ROUTE, postSummaryComment: false },
      "local-window",
      LOCAL_ACTOR,
    );

    await h.service.reviewPullRequestHead({
      target: TARGET,
      threadId: THREAD_ID,
      headSha: HEAD_1,
      baseRef: "origin/main",
      state: "open",
    });

    expect(h.settledTokens).toEqual([1400]);
    expect(settleSpendCeilingReservation({ reservedTokens: 1500, observedTokens: 1400 }).kind).toBe(
      "committed",
    );
    expect(h.recordedUsages).toEqual([
      {
        threadId: String(THREAD_ID),
        usage: { inputTokens: 1000, outputTokens: 400, reasoningTokens: 300 },
      },
    ]);
  });

  it("never repeats a GitHub summary comment or worker hand-back when the host restarts before recording run completion", async () => {
    // 1. Crash right after posting the summary comment, before `run-recorded`.
    let failOnRunRecorded = true;
    const commentCrash = createHarness({
      failAppendOnEventName: () =>
        failOnRunRecorded ? "pull-request-review.run-recorded@1" : undefined,
    });
    await commentCrash.service.updateProjectSettings(
      WINDOW_ID,
      { projectId: PROJECT_ID, enabled: true, route: REVIEWER_ROUTE, postSummaryComment: true },
      "local-window",
      LOCAL_ACTOR,
    );
    await expect(
      commentCrash.service.reviewPullRequestHead({
        target: TARGET,
        threadId: THREAD_ID,
        headSha: HEAD_1,
        baseRef: "origin/main",
        state: "open",
      }),
    ).rejects.toThrow("Simulated crash");
    expect(commentCrash.postedComments).toHaveLength(1);
    expect(commentCrash.getTurnCalls()).toBe(1);

    // Host restarts on the same journal and re-observes the same PR head.
    failOnRunRecorded = false;
    const restartedAfterComment = commentCrash.makeService();
    const afterCommentRestart = await restartedAfterComment.reviewPullRequestHead({
      target: TARGET,
      threadId: THREAD_ID,
      headSha: HEAD_1,
      baseRef: "origin/main",
      state: "open",
    });
    expect(afterCommentRestart).toBeUndefined();
    expect(commentCrash.postedComments).toHaveLength(1);
    expect(commentCrash.getTurnCalls()).toBe(1);
    const commentView = await restartedAfterComment.queryPullRequestSettings(
      WINDOW_ID,
      TARGET,
      THREAD_ID,
    );
    expect(commentView.status).toBe("ok");
    if (commentView.status === "ok") {
      expect(commentView.view.latestReview?.status).toBe("failed");
      expect(commentView.view.latestReview?.summaryCommentPosted).toBe(true);
    }

    // 2. Crash right after waking the worker, before `run-recorded`.
    let failWakeOnRunRecorded = true;
    const wakeCrash = createHarness({
      strict: () => true,
      failAppendOnEventName: () =>
        failWakeOnRunRecorded ? "pull-request-review.run-recorded@1" : undefined,
    });
    await wakeCrash.service.updateProjectSettings(
      WINDOW_ID,
      { projectId: PROJECT_ID, enabled: true, route: REVIEWER_ROUTE, postSummaryComment: false },
      "local-window",
      LOCAL_ACTOR,
    );
    await wakeCrash.service.updatePullRequestSettings(
      WINDOW_ID,
      { target: TARGET, sendBlockingFindingsToWorker: true },
      "local-window",
      LOCAL_ACTOR,
    );
    await expect(
      wakeCrash.service.reviewPullRequestHead({
        target: TARGET,
        threadId: THREAD_ID,
        headSha: HEAD_1,
        baseRef: "origin/main",
        state: "open",
      }),
    ).rejects.toThrow("Simulated crash");
    expect(wakeCrash.workerWakes).toHaveLength(1);
    expect(wakeCrash.getTurnCalls()).toBe(1);

    // Host restarts on the same journal and re-observes the same PR head.
    failWakeOnRunRecorded = false;
    const restartedAfterWake = wakeCrash.makeService();
    const afterWakeRestart = await restartedAfterWake.reviewPullRequestHead({
      target: TARGET,
      threadId: THREAD_ID,
      headSha: HEAD_1,
      baseRef: "origin/main",
      state: "open",
    });
    expect(afterWakeRestart).toBeUndefined();
    expect(wakeCrash.workerWakes).toHaveLength(1);
    expect(wakeCrash.getTurnCalls()).toBe(1);
    const wakeView = await restartedAfterWake.queryPullRequestSettings(
      WINDOW_ID,
      TARGET,
      THREAD_ID,
    );
    expect(wakeView.status).toBe("ok");
    if (wakeView.status === "ok") {
      expect(wakeView.view.handBackAttempts).toBe(1);
      expect(wakeView.view.latestReview?.handedBackToWorker).toBe(true);
    }
  });

  it("settles reservations and records unreported spend when reviews complete or time out without reported usage", async () => {
    // 1. Completed review with no provider usage reported.
    const noUsageCompleted = createHarness({
      executeReadOnlyTurn: async () => ({
        status: "completed",
        sessionId: "no-usage-session",
        text: JSON.stringify({ findings: [] }),
      }),
    });
    await noUsageCompleted.service.updateProjectSettings(
      WINDOW_ID,
      { projectId: PROJECT_ID, enabled: true, route: REVIEWER_ROUTE, postSummaryComment: false },
      "local-window",
      LOCAL_ACTOR,
    );
    const completed = await noUsageCompleted.service.reviewPullRequestHead({
      target: TARGET,
      threadId: THREAD_ID,
      headSha: HEAD_1,
      baseRef: "origin/main",
      state: "open",
    });
    expect(completed?.status).toBe("completed");
    expect(noUsageCompleted.ceilingEvents).toEqual(["admit:admitted", "settle"]);
    expect(noUsageCompleted.recordedUsages).toEqual([{ threadId: String(THREAD_ID) }]);

    // 2. Driver turn that times out without ever emitting a usage event.
    const slowDriver: ProviderDriver = {
      kind: "codex",
      probe: () => Effect.die("unused"),
      acquire: () =>
        Effect.succeed({
          start: () => Effect.void,
          send: () => Effect.void,
          stop: () => Effect.void,
          subscribe: Effect.succeed(Stream.never),
        } as never),
    };
    const timedOut = createHarness({
      useDriverDirectly: true,
      turnTimeoutMs: 40,
      inspectRoute: () => ({ status: "ready", driver: slowDriver }),
    });
    await timedOut.service.updateProjectSettings(
      WINDOW_ID,
      { projectId: PROJECT_ID, enabled: true, route: REVIEWER_ROUTE, postSummaryComment: false },
      "local-window",
      LOCAL_ACTOR,
    );
    const failed = await timedOut.service.reviewPullRequestHead({
      target: TARGET,
      threadId: THREAD_ID,
      headSha: HEAD_1,
      baseRef: "origin/main",
      state: "open",
    });
    expect(failed?.status).toBe("failed");
    expect(timedOut.ceilingEvents).toEqual(["admit:admitted", "settle"]);
    expect(timedOut.recordedUsages).toEqual([{ threadId: String(THREAD_ID) }]);
  });

  it("fails reviews on prose, truncated JSON, or missing findings array without publishing a clean summary comment", async () => {
    const malformedReplies = [
      "Looks good to me! No issues found.",
      '{"findings":[{"path":"src/auth.ts","line":2',
      '{"issues":[]}',
    ];
    for (const [index, reply] of malformedReplies.entries()) {
      const h = createHarness({
        executeReadOnlyTurn: async () => ({
          status: "completed",
          sessionId: `malformed-${index}`,
          text: reply,
          usage: { inputTokens: 300, outputTokens: 40 },
        }),
      });
      await h.service.updateProjectSettings(
        WINDOW_ID,
        { projectId: PROJECT_ID, enabled: true, route: REVIEWER_ROUTE, postSummaryComment: true },
        "local-window",
        LOCAL_ACTOR,
      );
      const run = await h.service.reviewPullRequestHead({
        target: TARGET,
        threadId: THREAD_ID,
        headSha: HEAD_1,
        baseRef: "origin/main",
        state: "open",
      });
      expect(run?.status).toBe("failed");
      expect(run?.summaryCommentPosted).toBe(false);
      expect(h.postedComments).toHaveLength(0);
      expect(h.recordedFindings).toHaveLength(0);
    }

    // Inside a valid `{ findings: [...] }` envelope, invalid entries are selectively skipped while valid ones still persist.
    const mixed = createHarness({
      executeReadOnlyTurn: async () => ({
        status: "completed",
        sessionId: "mixed-valid-envelope",
        text: JSON.stringify({
          findings: [
            { path: "src/does-not-exist.ts", line: 1, severity: "error", summary: "Skip me" },
            {
              path: "src/auth.ts",
              line: 2,
              side: "modified",
              severity: "error",
              summary: "Keep valid finding inside valid envelope.",
            },
          ],
        }),
        usage: { inputTokens: 300, outputTokens: 40 },
      }),
    });
    await mixed.service.updateProjectSettings(
      WINDOW_ID,
      { projectId: PROJECT_ID, enabled: true, route: REVIEWER_ROUTE, postSummaryComment: true },
      "local-window",
      LOCAL_ACTOR,
    );
    const mixedRun = await mixed.service.reviewPullRequestHead({
      target: TARGET,
      threadId: THREAD_ID,
      headSha: HEAD_1,
      baseRef: "origin/main",
      state: "open",
    });
    expect(mixedRun?.status).toBe("completed");
    expect(mixed.recordedFindings).toHaveLength(1);
    expect(mixed.postedComments).toHaveLength(1);
  });

  it("keeps a newer completed review as the latest review on both PR and thread queries after restarting past an earlier interrupted review", async () => {
    let headSha = HEAD_1;
    let failOnRunRecorded = true;
    const h = createHarness({
      currentHeadSha: () => headSha,
      failAppendOnEventName: () =>
        failOnRunRecorded ? "pull-request-review.run-recorded@1" : undefined,
    });
    await h.service.updateProjectSettings(
      WINDOW_ID,
      { projectId: PROJECT_ID, enabled: true, route: REVIEWER_ROUTE, postSummaryComment: false },
      "local-window",
      LOCAL_ACTOR,
    );

    // Review A starts on HEAD_1 and crashes before recording completion.
    await expect(
      h.service.reviewPullRequestHead({
        target: TARGET,
        threadId: THREAD_ID,
        headSha: HEAD_1,
        baseRef: "origin/main",
        state: "open",
      }),
    ).rejects.toThrow("Simulated crash");

    // First restart: Review A is recovered as failed, then Review B completes on HEAD_2.
    failOnRunRecorded = false;
    headSha = HEAD_2;
    const afterFirstRestart = h.makeService();
    const reviewB = await afterFirstRestart.reviewPullRequestHead({
      target: TARGET,
      threadId: THREAD_ID,
      headSha: HEAD_2,
      baseRef: "origin/main",
      state: "open",
    });
    expect(reviewB?.status).toBe("completed");
    expect(reviewB?.headSha).toBe(HEAD_2);

    // Second restart: hydrating the earlier interrupted Review A must NOT overwrite Review B.
    const afterSecondRestart = h.makeService();
    const prView = await afterSecondRestart.queryPullRequestSettings(WINDOW_ID, TARGET, THREAD_ID);
    expect(prView.status).toBe("ok");
    if (prView.status === "ok") {
      expect(prView.view.latestReview?.reviewId).toBe(reviewB?.reviewId);
      expect(prView.view.latestReview?.headSha).toBe(HEAD_2);
      expect(prView.view.latestReview?.status).toBe("completed");
    }

    const threadView = await afterSecondRestart.queryThreadSettings(WINDOW_ID, THREAD_ID);
    expect(threadView.status).toBe("ok");
    if (threadView.status === "ok") {
      expect(threadView.view.latestReview?.reviewId).toBe(reviewB?.reviewId);
      expect(threadView.view.latestReview?.headSha).toBe(HEAD_2);
      expect(threadView.view.latestReview?.status).toBe("completed");
    }
  });

  it("keeps reviews and per-PR settings across a repository rename and never shares them when a different pull request reuses the old repository name", async () => {
    let currentHead = HEAD_1;
    const h = createHarness({ currentHeadSha: () => currentHead });
    const beforeRename: PullRequestReviewTarget = {
      projectId: PROJECT_ID,
      repositoryOwner: Schema.decodeUnknownSync(GithubRepositoryOwner)("acme"),
      repositoryName: Schema.decodeUnknownSync(GithubRepositoryName)("app"),
      number: 9,
    };
    const afterRename: PullRequestReviewTarget = {
      projectId: PROJECT_ID,
      repositoryOwner: Schema.decodeUnknownSync(GithubRepositoryOwner)("acme"),
      repositoryName: Schema.decodeUnknownSync(GithubRepositoryName)("application"),
      number: 9,
    };

    await h.pullRequestLinks.recordObservation({
      projectId: PROJECT_ID,
      repositoryOwner: "acme",
      repositoryName: "app",
      number: 9,
      pullRequestNodeId: "PR_kwDO_app9",
      baseRepositoryNodeId: "R_kgDO_app",
      threadIds: [THREAD_ID],
    });

    const service = h.makeService({ withLinks: true });
    await service.updateProjectSettings(
      WINDOW_ID,
      { projectId: PROJECT_ID, enabled: true, route: REVIEWER_ROUTE, postSummaryComment: false },
      "local-window",
      LOCAL_ACTOR,
    );
    await service.updatePullRequestSettings(
      WINDOW_ID,
      { target: beforeRename, sendBlockingFindingsToWorker: true },
      "local-window",
      LOCAL_ACTOR,
    );
    const review = await service.reviewPullRequestHead({
      target: beforeRename,
      threadId: THREAD_ID,
      headSha: HEAD_1,
      baseRef: "origin/main",
      state: "open",
    });
    expect(review?.status).toBe("completed");

    // Rename acme/app -> acme/application on the same linked PR node ID.
    await h.pullRequestLinks.recordObservation({
      projectId: PROJECT_ID,
      repositoryOwner: "acme",
      repositoryName: "application",
      lookupRepositoryOwner: "acme",
      lookupRepositoryName: "app",
      number: 9,
      pullRequestNodeId: "PR_kwDO_app9",
      baseRepositoryNodeId: "R_kgDO_app",
      threadIds: [THREAD_ID],
    });

    // A different pull request reuses acme/app#9 with a different GitHub node ID.
    await h.pullRequestLinks.recordObservation({
      projectId: PROJECT_ID,
      repositoryOwner: "acme",
      repositoryName: "app",
      number: 9,
      pullRequestNodeId: "PR_kwDO_reused9",
      baseRepositoryNodeId: "R_kgDO_reused",
      threadIds: [THREAD_ID],
    });

    const renamedView = await service.queryPullRequestSettings(WINDOW_ID, afterRename, THREAD_ID);
    expect(renamedView.status).toBe("ok");
    if (renamedView.status === "ok") {
      expect(renamedView.view.settings.sendBlockingFindingsToWorker).toBe(true);
      expect(renamedView.view.latestReview?.reviewId).toBe(review?.reviewId);
    }

    // Reviewing the same head under the renamed coordinates must deduplicate.
    expect(
      await service.reviewPullRequestHead({
        target: afterRename,
        threadId: THREAD_ID,
        headSha: HEAD_1,
        baseRef: "origin/main",
        state: "open",
      }),
    ).toBeUndefined();

    const reusedView = await service.queryPullRequestSettings(WINDOW_ID, beforeRename, THREAD_ID);
    expect(reusedView.status).toBe("ok");
    if (reusedView.status === "ok") {
      expect(reusedView.view.settings.sendBlockingFindingsToWorker).toBe(false);
      expect(reusedView.view.latestReview).toBeUndefined();
    }

    // Replaying from the journal preserves both the renamed PR's history and isolation.
    const restarted = h.makeService({ withLinks: true });
    const replayedRenamed = await restarted.queryPullRequestSettings(
      WINDOW_ID,
      afterRename,
      THREAD_ID,
    );
    expect(replayedRenamed.status).toBe("ok");
    if (replayedRenamed.status === "ok") {
      expect(replayedRenamed.view.settings.sendBlockingFindingsToWorker).toBe(true);
      expect(replayedRenamed.view.latestReview?.reviewId).toBe(review?.reviewId);
    }
    const replayedReused = await restarted.queryPullRequestSettings(
      WINDOW_ID,
      beforeRename,
      THREAD_ID,
    );
    expect(replayedReused.status).toBe("ok");
    if (replayedReused.status === "ok") {
      expect(replayedReused.view.settings.sendBlockingFindingsToWorker).toBe(false);
      expect(replayedReused.view.latestReview).toBeUndefined();
    }

    // A new head on the renamed PR continues cleanly.
    currentHead = HEAD_2;
    const nextReview = await restarted.reviewPullRequestHead({
      target: afterRename,
      threadId: THREAD_ID,
      headSha: HEAD_2,
      baseRef: "origin/main",
      state: "open",
    });
    expect(nextReview?.status).toBe("completed");
  });

  it("replays legacy coordinate-keyed reviews and per-PR settings across a rename without version conflicts and isolates reused names", async () => {
    let currentHead = HEAD_1;
    const h = createHarness({ currentHeadSha: () => currentHead });
    const beforeRename: PullRequestReviewTarget = {
      projectId: PROJECT_ID,
      repositoryOwner: Schema.decodeUnknownSync(GithubRepositoryOwner)("acme"),
      repositoryName: Schema.decodeUnknownSync(GithubRepositoryName)("app"),
      number: 9,
    };
    const afterRename: PullRequestReviewTarget = {
      projectId: PROJECT_ID,
      repositoryOwner: Schema.decodeUnknownSync(GithubRepositoryOwner)("acme"),
      repositoryName: Schema.decodeUnknownSync(GithubRepositoryName)("application"),
      number: 9,
    };

    // Record legacy PR settings and a legacy review BEFORE any PR link or node ID exists.
    await h.service.updateProjectSettings(
      WINDOW_ID,
      { projectId: PROJECT_ID, enabled: true, route: REVIEWER_ROUTE, postSummaryComment: false },
      "local-window",
      LOCAL_ACTOR,
    );
    await h.service.updatePullRequestSettings(
      WINDOW_ID,
      { target: beforeRename, sendBlockingFindingsToWorker: true },
      "local-window",
      LOCAL_ACTOR,
    );
    const legacyReview = await h.service.reviewPullRequestHead({
      target: beforeRename,
      threadId: THREAD_ID,
      headSha: HEAD_1,
      baseRef: "origin/main",
      state: "open",
    });
    expect(legacyReview?.status).toBe("completed");

    // Link is created, backfilled with a GitHub node ID, and renamed to acme/application#9.
    await h.pullRequestLinks.recordObservation({
      projectId: PROJECT_ID,
      repositoryOwner: "acme",
      repositoryName: "app",
      number: 9,
      threadIds: [THREAD_ID],
    });
    await h.pullRequestLinks.recordObservation({
      projectId: PROJECT_ID,
      repositoryOwner: "acme",
      repositoryName: "application",
      lookupRepositoryOwner: "acme",
      lookupRepositoryName: "app",
      number: 9,
      pullRequestNodeId: "PR_kwDO_legacy9",
      baseRepositoryNodeId: "R_kgDO_legacy",
      threadIds: [THREAD_ID],
    });
    // Another PR later reuses acme/app#9 with a distinct node ID.
    await h.pullRequestLinks.recordObservation({
      projectId: PROJECT_ID,
      repositoryOwner: "acme",
      repositoryName: "app",
      number: 9,
      pullRequestNodeId: "PR_kwDO_new9",
      baseRepositoryNodeId: "R_kgDO_new",
      threadIds: [THREAD_ID],
    });

    const replayed = h.makeService({ withLinks: true });
    const renamedView = await replayed.queryPullRequestSettings(WINDOW_ID, afterRename, THREAD_ID);
    expect(renamedView.status).toBe("ok");
    if (renamedView.status === "ok") {
      expect(renamedView.view.settings.sendBlockingFindingsToWorker).toBe(true);
      expect(renamedView.view.latestReview?.reviewId).toBe(legacyReview?.reviewId);
    }

    const reusedView = await replayed.queryPullRequestSettings(WINDOW_ID, beforeRename, THREAD_ID);
    expect(reusedView.status).toBe("ok");
    if (reusedView.status === "ok") {
      expect(reusedView.view.settings.sendBlockingFindingsToWorker).toBe(false);
      expect(reusedView.view.latestReview).toBeUndefined();
    }

    // Updating settings and reviewing a new head on the renamed PR after legacy replay must not hit version conflicts.
    const updated = await replayed.updatePullRequestSettings(
      WINDOW_ID,
      { target: afterRename, sendBlockingFindingsToWorker: false },
      "local-window",
      LOCAL_ACTOR,
    );
    expect(updated.status).toBe("ok");
    currentHead = HEAD_2;
    const secondReview = await replayed.reviewPullRequestHead({
      target: afterRename,
      threadId: THREAD_ID,
      headSha: HEAD_2,
      baseRef: "origin/main",
      state: "open",
    });
    expect(secondReview?.status).toBe("completed");

    const afterRestart = h.makeService({ withLinks: true });
    const finalView = await afterRestart.queryPullRequestSettings(
      WINDOW_ID,
      afterRename,
      THREAD_ID,
    );
    expect(finalView.status).toBe("ok");
    if (finalView.status === "ok") {
      expect(finalView.view.settings.sendBlockingFindingsToWorker).toBe(false);
      expect(finalView.view.latestReview?.reviewId).toBe(secondReview?.reviewId);
    }
  });
});
