import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  CodeDigest,
  CodeFileId,
  CodeOperationId,
  CodeRelativePath,
  decodeAgentRunId,
  decodeCodeReviewFinding,
  decodeCodeReviewFindingId,
  decodeProviderInstanceId,
  decodeProviderModelId,
  type CodeReviewFinding,
} from "@octant/contracts";
import {
  decodePullRequestReviewRequest,
  decodePullRequestReviewerId,
} from "@octant/plugin-api/pull-request-reviewer";
import { fakePullRequestReviewer } from "./fakePullRequestReviewer.test-support";
import { PullRequestReviewerRegistry } from "./pullRequestReviewerRegistry";

const APP_PATH = Schema.decodeUnknownSync(CodeRelativePath)("src/app.ts");
const REVIEW_OP_ID = Schema.decodeUnknownSync(CodeOperationId)(
  "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
);
const FILE_ID = Schema.decodeUnknownSync(CodeFileId)("99999999-9999-4999-8999-999999999999");
const FILE_DIGEST = Schema.decodeUnknownSync(CodeDigest)("d".repeat(64));

const REVIEW_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const THREAD_ID = "33333333-3333-4333-8333-333333333333";
const CHECKOUT_ID = "44444444-4444-4444-8444-444444444444";
const WORKER_PROVIDER_ID = "55555555-5555-4555-8555-555555555555";
const REVIEWER_PROVIDER_ID = "66666666-6666-4666-8666-666666666666";
const RUN_ID = "77777777-7777-4777-8777-777777777777";
const FOREIGN_RUN_ID = "88888888-8888-4888-8888-888888888888";
const FINDING_ID_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FINDING_ID_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const UNKNOWN_FINDING_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const HEAD_SHA = "a".repeat(40);
const MOVED_HEAD_SHA = "b".repeat(40);
const BASE_SHA = "c".repeat(40);
const NOW = "2026-11-20T08:00:00.000Z";

const REVIEWER_ID = decodePullRequestReviewerId("example.pr-review/reviewer");

function makeRequest(overrides?: Partial<Record<string, unknown>>) {
  return decodePullRequestReviewRequest({
    reviewId: REVIEW_ID,
    target: {
      projectId: PROJECT_ID,
      repositoryOwner: "ogard-labs",
      repositoryName: "octant",
      number: 99,
    },
    threadId: THREAD_ID,
    checkoutId: CHECKOUT_ID,
    headSha: HEAD_SHA,
    baseRef: "refs/heads/main",
    baseSha: BASE_SHA,
    workerRoute: {
      providerInstanceId: WORKER_PROVIDER_ID,
      modelId: "claude-sonnet-4-5",
    },
    configuredRoute: {
      providerInstanceId: REVIEWER_PROVIDER_ID,
      modelId: "gpt-5.3-codex",
      effort: "high",
    },
    optIns: {
      postSummaryComment: false,
      sendBlockingFindingsToWorker: false,
    },
    ...overrides,
  });
}

function makeRecordedFinding(
  id: string,
  severity: "note" | "warning" | "error",
  summary: string,
): CodeReviewFinding {
  return decodeCodeReviewFinding({
    id,
    threadId: THREAD_ID,
    checkoutId: CHECKOUT_ID,
    fileId: FILE_ID,
    path: "src/app.ts",
    fileDigest: FILE_DIGEST,
    location: { kind: "line", line: 10 },
    severity,
    author: {
      kind: "agent",
      providerInstanceId: REVIEWER_PROVIDER_ID,
      sessionId: "review-session-1",
    },
    provenance: {
      kind: "provider",
      sourceId: RUN_ID,
    },
    summary,
    state: "open",
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

describe("pull request reviewer registry and host port", () => {
  it("withholds inactive, released, or colliding reviewers and never invokes them", async () => {
    const registry = new PullRequestReviewerRegistry();
    let enabled = false;
    const fake = fakePullRequestReviewer(async () => ({
      status: "completed",
      findingIds: [],
    }));
    const first = registry.register({
      reviewerId: REVIEWER_ID,
      displayName: "Example",
      activation: () => ({ installed: true, trusted: true, enabled }),
      reviewer: fake.reviewer,
    });
    expect(first.kind).toBe("registered");
    expect(registry.list()).toEqual([]);

    const disabledOutcome = await registry.run({
      reviewerId: REVIEWER_ID,
      request: makeRequest(),
      signal: new AbortController().signal,
      delegates: { readCurrentHeadSha: async () => HEAD_SHA },
    });
    expect(disabledOutcome).toMatchObject({ status: "refused", reason: "not-effective" });
    expect(fake.calls).toHaveLength(0);

    // Turning it on makes it offered; registering a colliding id withholds both.
    enabled = true;
    expect(registry.list().map((entry) => entry.reviewerId)).toEqual([REVIEWER_ID]);
    const collider = registry.register({
      reviewerId: REVIEWER_ID,
      displayName: "Collider",
      activation: () => ({ installed: true, trusted: true, enabled: true }),
      reviewer: fake.reviewer,
    });
    expect(collider.kind).toBe("registered");
    expect(registry.list()).toEqual([]);

    if (collider.kind === "registered") collider.release();
    expect(registry.list().map((entry) => entry.reviewerId)).toEqual([REVIEWER_ID]);

    if (first.kind === "registered") first.release();
    expect(registry.list()).toEqual([]);
  });

  it("mediates a full review run and exposes only bounded capability methods without formal forge review actions", async () => {
    const registry = new PullRequestReviewerRegistry();
    const postedComments: Array<string> = [];
    const handedBack: Array<ReadonlyArray<CodeReviewFinding>> = [];
    const observedPortKeys: Array<string> = [];

    const fake = fakePullRequestReviewer(async (_request, host) => {
      observedPortKeys.push(...Object.keys(host).sort());
      const diff = await host.readPullRequestDiff();
      expect(diff.status).toBe("ready");

      const turn = await host.runReadOnlyReviewTurn({
        prompt: "Review the diff for correctness bugs.",
      });
      expect(turn.status).toBe("completed");
      if (turn.status !== "completed") {
        return { status: "failed", detail: "expected completed turn" };
      }

      const recorded = await host.recordFindings({
        runId: turn.runId,
        findings: [
          {
            path: APP_PATH,
            location: { kind: "line", line: 10 },
            severity: "error",
            summary: "Missing authorization check before mutation.",
          },
          {
            path: APP_PATH,
            location: { kind: "line", line: 22 },
            severity: "warning",
            summary: "Consider narrowing retry timeout.",
          },
        ],
      });
      expect(recorded.status).toBe("recorded");
      if (recorded.status !== "recorded") {
        return { status: "failed", detail: "expected recorded findings" };
      }

      const comment = await host.postSummaryComment({
        body: "Found 1 blocking issue and 1 warning.",
      });
      expect(comment).toEqual({ status: "posted", commentId: "comment-1" });

      // A second summary comment in the same review run is refused.
      expect(await host.postSummaryComment({ body: "Second comment" })).toEqual({
        status: "refused",
        reason: "already-posted",
      });

      // Handing back a non-blocking warning is refused; blocking errors succeed once.
      const warningId = recorded.findings[1]?.id;
      const errorId = recorded.findings[0]?.id;
      expect(warningId).toBeDefined();
      expect(errorId).toBeDefined();
      if (warningId === undefined || errorId === undefined) {
        return { status: "failed", detail: "missing finding ids" };
      }

      expect(await host.handBackBlockingFindings({ findingIds: [warningId] })).toEqual({
        status: "refused",
        reason: "no-blocking-findings",
      });
      expect(await host.handBackBlockingFindings({ findingIds: [errorId] })).toEqual({
        status: "handed-back",
        attempt: 1,
      });
      expect(await host.handBackBlockingFindings({ findingIds: [errorId] })).toEqual({
        status: "refused",
        reason: "already-handed-back",
      });

      return {
        status: "completed",
        findingIds: recorded.findings.map((finding) => finding.id),
        runId: turn.runId,
      };
    });

    registry.register({
      reviewerId: REVIEWER_ID,
      displayName: "Example",
      activation: () => ({ installed: true, trusted: true, enabled: true }),
      reviewer: fake.reviewer,
    });

    const outcome = await registry.run({
      reviewerId: REVIEWER_ID,
      request: makeRequest({
        optIns: { postSummaryComment: true, sendBlockingFindingsToWorker: true },
      }),
      signal: new AbortController().signal,
      delegates: {
        readCurrentHeadSha: async () => HEAD_SHA,
        readPullRequestDiff: async () => ({
          status: "ready",
          diff: {
            headSha: HEAD_SHA,
            baseRef: "refs/heads/main",
            baseSha: BASE_SHA,
            reviewOperationId: REVIEW_OP_ID,
            files: [
              {
                fileId: FILE_ID,
                path: APP_PATH,
                fileDigest: FILE_DIGEST,
                status: "modified",
                patch: "@@ -10,1 +10,2 @@\n+mutate();\n",
              },
            ],
          },
        }),
        runReadOnlyReviewTurn: async () => ({
          status: "completed",
          runId: decodeAgentRunId(RUN_ID),
          providerInstanceId: decodeProviderInstanceId(REVIEWER_PROVIDER_ID),
          modelId: decodeProviderModelId("gpt-5.3-codex"),
          sessionId: "review-session-1",
          text: "Structured findings",
        }),
        recordFindings: async ({ proposals, runReceipt }) => {
          expect(runReceipt?.runId).toBe(RUN_ID);
          expect(runReceipt?.providerInstanceId).toBe(REVIEWER_PROVIDER_ID);
          return {
            status: "recorded",
            findings: proposals.map((proposal, index) =>
              makeRecordedFinding(
                index === 0 ? FINDING_ID_1 : FINDING_ID_2,
                proposal.severity,
                proposal.summary,
              ),
            ),
          };
        },
        isPostSummaryCommentEnabled: () => true,
        postSummaryComment: async ({ body }) => {
          postedComments.push(body);
          return { status: "posted", commentId: "comment-1" };
        },
        isSendBlockingFindingsEnabled: () => true,
        handBackBlockingFindings: async ({ findings }) => {
          handedBack.push(findings);
          return { status: "handed-back", attempt: 1 };
        },
      },
    });

    expect(observedPortKeys).toEqual([
      "handBackBlockingFindings",
      "isHeadCurrent",
      "postSummaryComment",
      "readPullRequestDiff",
      "recordFindings",
      "runReadOnlyReviewTurn",
    ]);
    expect(postedComments).toEqual(["Found 1 blocking issue and 1 warning."]);
    expect(handedBack).toHaveLength(1);
    expect(handedBack[0]?.map((finding) => finding.id)).toEqual([FINDING_ID_1]);
    expect(outcome).toEqual({
      status: "completed",
      findingIds: [FINDING_ID_1, FINDING_ID_2],
      runId: RUN_ID,
      summaryCommentPosted: true,
      handedBackToWorker: true,
    });
  });

  it("keeps summary comments and worker hand-back disabled by default even when delegates exist", async () => {
    const registry = new PullRequestReviewerRegistry();
    let commentDelegateCalled = false;
    let handBackDelegateCalled = false;

    const fake = fakePullRequestReviewer(async (_request, host) => {
      const recorded = await host.recordFindings({
        findings: [
          {
            path: APP_PATH,
            location: { kind: "line", line: 10 },
            severity: "error",
            summary: "Blocking defect.",
          },
        ],
      });
      if (recorded.status !== "recorded") {
        return { status: "failed", detail: "expected recording" };
      }
      expect(await host.postSummaryComment({ body: "Summary" })).toEqual({ status: "disabled" });
      expect(
        await host.handBackBlockingFindings({
          findingIds: recorded.findings.map((finding) => finding.id),
        }),
      ).toEqual({ status: "disabled" });
      return {
        status: "completed",
        findingIds: recorded.findings.map((finding) => finding.id),
        // Even if a plugin falsely claims it posted or handed back, the host reports the truth.
        summaryCommentPosted: true,
        handedBackToWorker: true,
      };
    });

    registry.register({
      reviewerId: REVIEWER_ID,
      displayName: "Example",
      activation: () => ({ installed: true, trusted: true, enabled: true }),
      reviewer: fake.reviewer,
    });

    const outcome = await registry.run({
      reviewerId: REVIEWER_ID,
      request: makeRequest(),
      signal: new AbortController().signal,
      delegates: {
        readCurrentHeadSha: async () => HEAD_SHA,
        recordFindings: async () => ({
          status: "recorded",
          findings: [makeRecordedFinding(FINDING_ID_1, "error", "Blocking defect.")],
        }),
        postSummaryComment: async () => {
          commentDelegateCalled = true;
          return { status: "posted" };
        },
        handBackBlockingFindings: async () => {
          handBackDelegateCalled = true;
          return { status: "handed-back", attempt: 1 };
        },
      },
    });

    expect(commentDelegateCalled).toBe(false);
    expect(handBackDelegateCalled).toBe(false);
    expect(outcome).toEqual({
      status: "completed",
      findingIds: [FINDING_ID_1],
      summaryCommentPosted: false,
      handedBackToWorker: false,
    });
  });

  it("refuses forged run ids and unknown finding ids from a reviewer plugin", async () => {
    const registry = new PullRequestReviewerRegistry();
    const fake = fakePullRequestReviewer(async (_request, host) => {
      const forged = await host.recordFindings({
        runId: decodeAgentRunId(FOREIGN_RUN_ID),
        findings: [
          {
            path: APP_PATH,
            location: { kind: "line", line: 10 },
            severity: "error",
            summary: "Forged run.",
          },
        ],
      });
      expect(forged).toMatchObject({ status: "refused", reason: "unknown-run" });

      const unknownHandBack = await host.handBackBlockingFindings({
        findingIds: [decodeCodeReviewFindingId(UNKNOWN_FINDING_ID)],
      });
      expect(unknownHandBack).toEqual({ status: "refused", reason: "unknown-finding" });

      // Attempting to smuggle an unrecorded finding id in the final outcome fails closed.
      return {
        status: "completed",
        findingIds: [decodeCodeReviewFindingId(UNKNOWN_FINDING_ID)],
      };
    });

    registry.register({
      reviewerId: REVIEWER_ID,
      displayName: "Example",
      activation: () => ({ installed: true, trusted: true, enabled: true }),
      reviewer: fake.reviewer,
    });

    const outcome = await registry.run({
      reviewerId: REVIEWER_ID,
      request: makeRequest(),
      signal: new AbortController().signal,
      delegates: {
        readCurrentHeadSha: async () => HEAD_SHA,
        isSendBlockingFindingsEnabled: () => true,
      },
    });
    expect(outcome.status).toBe("failed");
  });

  it("records a stale outcome and blocks publication when the pull request head moves before or during review", async () => {
    const registry = new PullRequestReviewerRegistry();
    let currentHead = MOVED_HEAD_SHA;
    const fake = fakePullRequestReviewer(async (_request, host) => {
      const turn = await host.runReadOnlyReviewTurn({ prompt: "Review head" });
      expect(turn).toMatchObject({ status: "refused", reason: "head-stale" });
      const record = await host.recordFindings({
        findings: [
          {
            path: APP_PATH,
            location: { kind: "line", line: 1 },
            severity: "error",
            summary: "Should never be recorded on a stale head.",
          },
        ],
      });
      expect(record).toEqual({ status: "stale", currentHeadSha: MOVED_HEAD_SHA });
      // Even if a plugin ignores staleness and claims completion, the host overrides it to stale.
      return { status: "completed", findingIds: [] };
    });

    registry.register({
      reviewerId: REVIEWER_ID,
      displayName: "Example",
      activation: () => ({ installed: true, trusted: true, enabled: true }),
      reviewer: fake.reviewer,
    });

    // Head already moved before start -> reviewer is never invoked.
    const beforeStart = await registry.run({
      reviewerId: REVIEWER_ID,
      request: makeRequest(),
      signal: new AbortController().signal,
      delegates: { readCurrentHeadSha: async () => currentHead },
    });
    expect(beforeStart).toEqual({ status: "stale", currentHeadSha: MOVED_HEAD_SHA });
    expect(fake.calls).toHaveLength(0);

    // Head starts current, then moves while the read-only turn runs -> recorded as stale.
    currentHead = HEAD_SHA;
    let recordDelegateCalled = false;
    const movedDuringRun = await registry.run({
      reviewerId: REVIEWER_ID,
      request: makeRequest(),
      signal: new AbortController().signal,
      delegates: {
        readCurrentHeadSha: async () => currentHead,
        runReadOnlyReviewTurn: async () => {
          currentHead = MOVED_HEAD_SHA;
          return {
            status: "completed",
            runId: decodeAgentRunId(RUN_ID),
            providerInstanceId: decodeProviderInstanceId(REVIEWER_PROVIDER_ID),
            modelId: decodeProviderModelId("gpt-5.3-codex"),
            sessionId: "review-session-1",
            text: "Late result",
          };
        },
        recordFindings: async () => {
          recordDelegateCalled = true;
          return { status: "recorded", findings: [] };
        },
      },
    });
    expect(recordDelegateCalled).toBe(false);
    expect(movedDuringRun).toEqual({ status: "stale", currentHeadSha: MOVED_HEAD_SHA });
  });

  it("refuses further host calls and withholds completion if the plugin is disabled mid-review", async () => {
    const registry = new PullRequestReviewerRegistry();
    let enabled = true;

    const fake = fakePullRequestReviewer(async (_request, host) => {
      const turn = await host.runReadOnlyReviewTurn({ prompt: "Review head" });
      expect(turn).toMatchObject({ status: "refused", reason: "not-effective" });
      const record = await host.recordFindings({
        findings: [
          {
            path: APP_PATH,
            location: { kind: "line", line: 1 },
            severity: "note",
            summary: "Should not record after disable.",
          },
        ],
      });
      expect(record).toEqual({ status: "refused", reason: "not-effective" });
      return { status: "completed", findingIds: [] };
    });

    registry.register({
      reviewerId: REVIEWER_ID,
      displayName: "Example",
      activation: () => ({ installed: true, trusted: true, enabled }),
      reviewer: fake.reviewer,
    });

    const outcome = await registry.run({
      reviewerId: REVIEWER_ID,
      request: makeRequest(),
      signal: new AbortController().signal,
      delegates: {
        readCurrentHeadSha: async () => HEAD_SHA,
        runReadOnlyReviewTurn: async () => {
          enabled = false;
          return {
            status: "completed",
            runId: decodeAgentRunId(RUN_ID),
            providerInstanceId: decodeProviderInstanceId(REVIEWER_PROVIDER_ID),
            modelId: decodeProviderModelId("gpt-5.3-codex"),
            sessionId: "review-session-1",
            text: "Result after disable",
          };
        },
      },
    });

    expect(outcome).toMatchObject({ status: "refused", reason: "not-effective" });
  });

  it("surfaces honest turn refusals without fallback and turns unexpected plugin throws into failed outcomes", async () => {
    const registry = new PullRequestReviewerRegistry();
    const refusing = fakePullRequestReviewer(async (_request, host) => {
      const turn = await host.runReadOnlyReviewTurn({ prompt: "Review head" });
      if (turn.status === "refused") {
        return { status: "refused", reason: turn.reason, detail: turn.detail };
      }
      return { status: "completed", findingIds: [] };
    });

    const refusingId = decodePullRequestReviewerId("example.pr-review/refusing");
    const crashingId = decodePullRequestReviewerId("example.pr-review/crashing");
    registry.register({
      reviewerId: refusingId,
      displayName: "Refusing",
      activation: () => ({ installed: true, trusted: true, enabled: true }),
      reviewer: refusing.reviewer,
    });
    registry.register({
      reviewerId: crashingId,
      displayName: "Crashing",
      activation: () => ({ installed: true, trusted: true, enabled: true }),
      reviewer: fakePullRequestReviewer(async () => {
        throw new Error("internal stack detail that must not leak");
      }).reviewer,
    });

    const refused = await registry.run({
      reviewerId: refusingId,
      request: makeRequest(),
      signal: new AbortController().signal,
      delegates: {
        readCurrentHeadSha: async () => HEAD_SHA,
        runReadOnlyReviewTurn: async () => ({
          status: "refused",
          reason: "spend-ceiling",
          detail: "The thread reached its spend ceiling.",
        }),
      },
    });
    expect(refused).toEqual({
      status: "refused",
      reason: "spend-ceiling",
      detail: "The thread reached its spend ceiling.",
    });

    const crashed = await registry.run({
      reviewerId: crashingId,
      request: makeRequest(),
      signal: new AbortController().signal,
      delegates: { readCurrentHeadSha: async () => HEAD_SHA },
    });
    expect(crashed.status).toBe("failed");
    if (crashed.status === "failed") {
      expect(crashed.detail).not.toContain("internal stack detail");
    }
  });
});
