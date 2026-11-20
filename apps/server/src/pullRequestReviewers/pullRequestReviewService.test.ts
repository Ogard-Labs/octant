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
  type PullRequestReviewRoute,
  type PullRequestReviewTarget,
  type TurnUsage,
} from "@octant/contracts";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
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
}) {
  const dir = mkdtempSync(join(tmpdir(), "octant-pr-review-service-"));
  dirs.push(dir);
  const connection = openSqlite(join(dir, "octant.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => NOW);
  const registries = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: registries.events,
    projections: registries.projections,
    clock: () => NOW,
  });

  let counter = 0;
  const uuid = () => `80000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
  const turnMetrics = new TurnMetricsStore({
    journal,
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
  const recordedUsages: Array<{ readonly threadId: string; readonly usage: TurnUsage }> = [];
  const ceilingEvents: string[] = [];
  let turnCalls = 0;

  const runtime: PullRequestReviewHostRuntimePort = {
    scratchRoot: dir,
    readCurrentHeadSha: async () => (options?.currentHeadSha ? options.currentHeadSha() : HEAD_1),
    capturePullRequestDiff: async ({ headSha }) => ({
      status: "ready",
      capture: makeDiffCapture(headSha),
    }),
    inspectRoute: () => options?.inspectRoute?.() ?? { status: "ready" },
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
    postSummaryComment: async ({ target, body }) => {
      postedComments.push({ target, body });
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
      settle: () => {
        ceilingEvents.push("settle");
      },
      abandon: () => {
        ceilingEvents.push("abandon");
      },
    },
    turnMetrics,
    recordUsage: ({ threadId, usage }) => {
      recordedUsages.push({ threadId: String(threadId), usage });
    },
  };

  const makeService = () =>
    new PullRequestReviewService({
      registry,
      journal,
      authority: {
        canAccessProject: () => true,
        authorizePullRequest: async () => ({
          status: "authorized",
          linkedThreadIds: [String(THREAD_ID)],
        }),
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
          return true;
        },
        notifyPerson: async (threadId, reason) => {
          notifications.push({ threadId: String(threadId), reason });
        },
      },
      runtime,
      uuid,
      clock: () => NOW,
    });

  const service = makeService();
  return {
    service,
    makeService,
    turnMetrics,
    recordedFindings,
    postedComments,
    outsideMarks,
    workerWakes,
    notifications,
    recordedUsages,
    ceilingEvents,
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
});
