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
  MAX_PULL_REQUEST_REVIEW_FINDINGS_PER_RUN,
  decodePullRequestReviewRequest,
  decodePullRequestReviewerId,
  type PullRequestReviewHostPort,
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

  it("rechecks effectiveness, opt-ins, and cancellation after awaiting head currency before invoking delegates", async () => {
    // Case A: opt-ins switched off while checkHead is pending.
    {
      const registry = new PullRequestReviewerRegistry();
      let commentOptIn = true;
      let handBackOptIn = true;
      let commentDelegateCalls = 0;
      let handBackDelegateCalls = 0;
      let headReads = 0;

      const fake = fakePullRequestReviewer(async (_request, host) => {
        const recorded = await host.recordFindings({
          findings: [
            {
              path: APP_PATH,
              location: { kind: "line", line: 5 },
              severity: "error",
              summary: "Blocking defect.",
            },
          ],
        });
        expect(recorded.status).toBe("recorded");
        if (recorded.status !== "recorded") return { status: "failed", detail: "record failed" };

        expect(await host.postSummaryComment({ body: "Summary" })).toEqual({ status: "disabled" });
        expect(
          await host.handBackBlockingFindings({
            findingIds: recorded.findings.map((finding) => finding.id),
          }),
        ).toEqual({ status: "disabled" });

        return { status: "completed", findingIds: recorded.findings.map((finding) => finding.id) };
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
          readCurrentHeadSha: async () => {
            headReads += 1;
            // Read 1: initial registry check; Reads 2-3: recordFindings before/after;
            // Read 4: postSummaryComment checkHead; Read 5: handBackBlockingFindings checkHead.
            if (headReads === 4) commentOptIn = false;
            if (headReads === 5) handBackOptIn = false;
            return HEAD_SHA;
          },
          recordFindings: async () => ({
            status: "recorded",
            findings: [makeRecordedFinding(FINDING_ID_1, "error", "Blocking defect.")],
          }),
          isPostSummaryCommentEnabled: () => commentOptIn,
          postSummaryComment: async () => {
            commentDelegateCalls += 1;
            return { status: "posted" };
          },
          isSendBlockingFindingsEnabled: () => handBackOptIn,
          handBackBlockingFindings: async () => {
            handBackDelegateCalls += 1;
            return { status: "handed-back", attempt: 1 };
          },
        },
      });

      expect(commentDelegateCalls).toBe(0);
      expect(handBackDelegateCalls).toBe(0);
      expect(outcome).toMatchObject({
        status: "completed",
        summaryCommentPosted: false,
        handedBackToWorker: false,
      });
    }

    // Case B: reviewer disabled while checkHead is pending during postSummaryComment.
    {
      const registry = new PullRequestReviewerRegistry();
      let enabled = true;
      let commentDelegateCalls = 0;
      let headReads = 0;

      const fake = fakePullRequestReviewer(async (_request, host) => {
        expect(await host.postSummaryComment({ body: "Summary" })).toEqual({
          status: "refused",
          reason: "not-effective",
        });
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
        request: makeRequest({
          optIns: { postSummaryComment: true, sendBlockingFindingsToWorker: false },
        }),
        signal: new AbortController().signal,
        delegates: {
          readCurrentHeadSha: async () => {
            headReads += 1;
            if (headReads === 2) enabled = false;
            return HEAD_SHA;
          },
          isPostSummaryCommentEnabled: () => true,
          postSummaryComment: async () => {
            commentDelegateCalls += 1;
            return { status: "posted" };
          },
        },
      });

      expect(commentDelegateCalls).toBe(0);
      expect(outcome).toMatchObject({ status: "refused", reason: "not-effective" });
    }

    // Case C: cancellation arrives while checkHead is pending during postSummaryComment.
    {
      const registry = new PullRequestReviewerRegistry();
      const abort = new AbortController();
      let commentDelegateCalls = 0;
      let headReads = 0;

      const fake = fakePullRequestReviewer(async (_request, host) => {
        expect(await host.postSummaryComment({ body: "Summary" })).toEqual({
          status: "unavailable",
          reason: "unavailable",
        });
        return { status: "completed", findingIds: [] };
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
          optIns: { postSummaryComment: true, sendBlockingFindingsToWorker: false },
        }),
        signal: abort.signal,
        delegates: {
          readCurrentHeadSha: async () => {
            headReads += 1;
            if (headReads === 2) abort.abort();
            return HEAD_SHA;
          },
          isPostSummaryCommentEnabled: () => true,
          postSummaryComment: async () => {
            commentDelegateCalls += 1;
            return { status: "posted" };
          },
        },
      });

      expect(commentDelegateCalls).toBe(0);
      expect(outcome).toEqual({ status: "cancelled" });
    }
  });

  it("synchronously reserves single-comment, single-hand-back, and per-run finding budgets across concurrent calls", async () => {
    const registry = new PullRequestReviewerRegistry();
    let commentDelegateCalls = 0;
    let handBackDelegateCalls = 0;
    let totalProposalsSent = 0;
    let nextFinding = 0;

    const makeUuid = (index: number) =>
      `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`;

    const proposals = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        path: APP_PATH,
        location: { kind: "line" as const, line: index + 1 },
        severity: "error" as const,
        summary: `Finding ${index + 1}`,
      }));

    const fake = fakePullRequestReviewer(async (_request, host) => {
      // Two concurrent batches of 40 exceed the 64-finding per-run cap.
      const halfPlus = Math.floor(MAX_PULL_REQUEST_REVIEW_FINDINGS_PER_RUN / 2) + 8;
      const [batchA, batchB] = await Promise.all([
        host.recordFindings({ findings: proposals(halfPlus) }),
        host.recordFindings({ findings: proposals(halfPlus) }),
      ]);
      expect(batchA.status).toBe("recorded");
      expect(batchB).toEqual({ status: "refused", reason: "limit-exceeded" });
      if (batchA.status !== "recorded") return { status: "failed", detail: "expected batchA" };
      const firstId = batchA.findings[0]?.id;
      if (firstId === undefined) return { status: "failed", detail: "missing finding id" };

      // Concurrent summary comment posts: only one reaches the delegate.
      const [commentA, commentB] = await Promise.all([
        host.postSummaryComment({ body: "Comment A" }),
        host.postSummaryComment({ body: "Comment B" }),
      ]);
      expect(commentA).toEqual({ status: "posted", commentId: "c-1" });
      expect(commentB).toEqual({ status: "refused", reason: "already-posted" });

      // Concurrent hand-backs: only one reaches the delegate.
      const [handBackA, handBackB] = await Promise.all([
        host.handBackBlockingFindings({ findingIds: [firstId] }),
        host.handBackBlockingFindings({ findingIds: [firstId] }),
      ]);
      expect(handBackA).toEqual({ status: "handed-back", attempt: 1 });
      expect(handBackB).toEqual({ status: "refused", reason: "already-handed-back" });

      return {
        status: "completed",
        findingIds: batchA.findings.map((finding) => finding.id),
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
        readCurrentHeadSha: async () => {
          await Promise.resolve();
          return HEAD_SHA;
        },
        recordFindings: async ({ proposals: incoming }) => {
          await Promise.resolve();
          totalProposalsSent += incoming.length;
          return {
            status: "recorded",
            findings: incoming.map((proposal) => {
              nextFinding += 1;
              return makeRecordedFinding(
                makeUuid(nextFinding),
                proposal.severity,
                proposal.summary,
              );
            }),
          };
        },
        isPostSummaryCommentEnabled: () => true,
        postSummaryComment: async () => {
          await Promise.resolve();
          commentDelegateCalls += 1;
          return { status: "posted", commentId: "c-1" };
        },
        isSendBlockingFindingsEnabled: () => true,
        handBackBlockingFindings: async () => {
          await Promise.resolve();
          handBackDelegateCalls += 1;
          return { status: "handed-back", attempt: 1 };
        },
      },
    });

    expect(totalProposalsSent).toBeLessThanOrEqual(MAX_PULL_REQUEST_REVIEW_FINDINGS_PER_RUN);
    expect(commentDelegateCalls).toBe(1);
    expect(handBackDelegateCalls).toBe(1);
    expect(outcome).toMatchObject({
      status: "completed",
      summaryCommentPosted: true,
      handedBackToWorker: true,
    });
  });

  it("reports cancellation rather than staleness when aborted during initial or final head reads", async () => {
    // Initial head read aborted.
    {
      const registry = new PullRequestReviewerRegistry();
      const abort = new AbortController();
      const fake = fakePullRequestReviewer(async () => ({ status: "completed", findingIds: [] }));
      registry.register({
        reviewerId: REVIEWER_ID,
        displayName: "Example",
        activation: () => ({ installed: true, trusted: true, enabled: true }),
        reviewer: fake.reviewer,
      });

      const outcome = await registry.run({
        reviewerId: REVIEWER_ID,
        request: makeRequest(),
        signal: abort.signal,
        delegates: {
          readCurrentHeadSha: async () => {
            abort.abort();
            throw new Error("aborted");
          },
        },
      });
      expect(outcome).toEqual({ status: "cancelled" });
      expect(fake.calls).toHaveLength(0);
    }

    // Final head read aborted after reviewer returned.
    {
      const registry = new PullRequestReviewerRegistry();
      const abort = new AbortController();
      let headReads = 0;
      const fake = fakePullRequestReviewer(async () => ({ status: "completed", findingIds: [] }));
      registry.register({
        reviewerId: REVIEWER_ID,
        displayName: "Example",
        activation: () => ({ installed: true, trusted: true, enabled: true }),
        reviewer: fake.reviewer,
      });

      const outcome = await registry.run({
        reviewerId: REVIEWER_ID,
        request: makeRequest(),
        signal: abort.signal,
        delegates: {
          readCurrentHeadSha: async () => {
            headReads += 1;
            if (headReads === 2) {
              abort.abort();
              throw new Error("aborted");
            }
            return HEAD_SHA;
          },
        },
      });
      expect(outcome).toEqual({ status: "cancelled" });
    }
  });

  it("latches staleness when head lookup throws or when comment or hand-back delegates report stale", async () => {
    // Case A: readCurrentHeadSha throws mid-review (not aborted) -> latches stale and blocks later calls.
    {
      const registry = new PullRequestReviewerRegistry();
      let headReads = 0;
      let commentDelegateCalls = 0;

      const fake = fakePullRequestReviewer(async (_request, host) => {
        expect(await host.isHeadCurrent()).toBe(false);
        expect(await host.postSummaryComment({ body: "Summary" })).toEqual({ status: "stale" });
        return { status: "completed", findingIds: [] };
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
          optIns: { postSummaryComment: true, sendBlockingFindingsToWorker: false },
        }),
        signal: new AbortController().signal,
        delegates: {
          readCurrentHeadSha: async () => {
            headReads += 1;
            if (headReads === 2) throw new Error("transient git failure");
            return HEAD_SHA;
          },
          isPostSummaryCommentEnabled: () => true,
          postSummaryComment: async () => {
            commentDelegateCalls += 1;
            return { status: "posted" };
          },
        },
      });

      expect(commentDelegateCalls).toBe(0);
      expect(outcome).toEqual({ status: "stale" });
    }

    // Case B: postSummaryComment delegate reports stale -> latches stale and overrides completion.
    {
      const registry = new PullRequestReviewerRegistry();
      let handBackDelegateCalls = 0;

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
        if (recorded.status !== "recorded") return { status: "failed", detail: "record failed" };

        expect(await host.postSummaryComment({ body: "Summary" })).toEqual({
          status: "stale",
          currentHeadSha: MOVED_HEAD_SHA,
        });
        // Latched staleness now prevents hand-back from invoking its delegate.
        expect(
          await host.handBackBlockingFindings({
            findingIds: recorded.findings.map((finding) => finding.id),
          }),
        ).toEqual({ status: "stale", currentHeadSha: MOVED_HEAD_SHA });

        return { status: "completed", findingIds: recorded.findings.map((finding) => finding.id) };
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
          recordFindings: async () => ({
            status: "recorded",
            findings: [makeRecordedFinding(FINDING_ID_1, "error", "Blocking defect.")],
          }),
          isPostSummaryCommentEnabled: () => true,
          postSummaryComment: async () => ({ status: "stale", currentHeadSha: MOVED_HEAD_SHA }),
          isSendBlockingFindingsEnabled: () => true,
          handBackBlockingFindings: async () => {
            handBackDelegateCalls += 1;
            return { status: "handed-back", attempt: 1 };
          },
        },
      });

      expect(handBackDelegateCalls).toBe(0);
      expect(outcome).toEqual({ status: "stale", currentHeadSha: MOVED_HEAD_SHA });
    }

    // Case C: handBackBlockingFindings delegate reports stale -> latches stale and overrides completion.
    {
      const registry = new PullRequestReviewerRegistry();
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
        if (recorded.status !== "recorded") return { status: "failed", detail: "record failed" };

        expect(
          await host.handBackBlockingFindings({
            findingIds: recorded.findings.map((finding) => finding.id),
          }),
        ).toEqual({ status: "stale", currentHeadSha: MOVED_HEAD_SHA });

        return { status: "completed", findingIds: recorded.findings.map((finding) => finding.id) };
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
          optIns: { postSummaryComment: false, sendBlockingFindingsToWorker: true },
        }),
        signal: new AbortController().signal,
        delegates: {
          readCurrentHeadSha: async () => HEAD_SHA,
          recordFindings: async () => ({
            status: "recorded",
            findings: [makeRecordedFinding(FINDING_ID_1, "error", "Blocking defect.")],
          }),
          isSendBlockingFindingsEnabled: () => true,
          handBackBlockingFindings: async () => ({
            status: "stale",
            currentHeadSha: MOVED_HEAD_SHA,
          }),
        },
      });

      expect(outcome).toEqual({ status: "stale", currentHeadSha: MOVED_HEAD_SHA });
    }
  });

  it("withdraws authority from an in-flight reviewer when replaced by a new registration under the same id", async () => {
    const registry = new PullRequestReviewerRegistry();
    let commentDelegateCalls = 0;

    const replacement = fakePullRequestReviewer(async () => ({
      status: "completed",
      findingIds: [],
    }));
    const original = fakePullRequestReviewer(async (_request, host) => {
      const turn = await host.runReadOnlyReviewTurn({ prompt: "Review head" });
      expect(turn).toMatchObject({ status: "refused", reason: "not-effective" });
      expect(await host.postSummaryComment({ body: "From superseded reviewer" })).toEqual({
        status: "refused",
        reason: "not-effective",
      });
      return { status: "completed", findingIds: [] };
    });

    const firstRegistration = registry.register({
      reviewerId: REVIEWER_ID,
      displayName: "Original",
      activation: () => ({ installed: true, trusted: true, enabled: true }),
      reviewer: original.reviewer,
    });
    expect(firstRegistration.kind).toBe("registered");

    const outcome = await registry.run({
      reviewerId: REVIEWER_ID,
      request: makeRequest({
        optIns: { postSummaryComment: true, sendBlockingFindingsToWorker: false },
      }),
      signal: new AbortController().signal,
      delegates: {
        readCurrentHeadSha: async () => HEAD_SHA,
        runReadOnlyReviewTurn: async () => {
          // Release original and immediately register a replacement under the same id.
          if (firstRegistration.kind === "registered") firstRegistration.release();
          registry.register({
            reviewerId: REVIEWER_ID,
            displayName: "Replacement",
            activation: () => ({ installed: true, trusted: true, enabled: true }),
            reviewer: replacement.reviewer,
          });
          return {
            status: "completed",
            runId: decodeAgentRunId(RUN_ID),
            providerInstanceId: decodeProviderInstanceId(REVIEWER_PROVIDER_ID),
            modelId: decodeProviderModelId("gpt-5.3-codex"),
            sessionId: "review-session-1",
            text: "Late turn result",
          };
        },
        isPostSummaryCommentEnabled: () => true,
        postSummaryComment: async () => {
          commentDelegateCalls += 1;
          return { status: "posted" };
        },
      },
    });

    expect(commentDelegateCalls).toBe(0);
    expect(outcome).toMatchObject({ status: "refused", reason: "not-effective" });

    // The replacement registration itself can now run cleanly.
    const nextOutcome = await registry.run({
      reviewerId: REVIEWER_ID,
      request: makeRequest(),
      signal: new AbortController().signal,
      delegates: { readCurrentHeadSha: async () => HEAD_SHA },
    });
    expect(nextOutcome).toMatchObject({ status: "completed", findingIds: [] });
    expect(replacement.calls).toHaveLength(1);
  });

  it("revokes the host port as soon as review settles so retained handles cannot act afterwards", async () => {
    const registry = new PullRequestReviewerRegistry();
    let capturedPort: PullRequestReviewHostPort | undefined;
    let delegateCallsAfterSettlement = 0;
    let settled = false;

    const fake = fakePullRequestReviewer(async (_request, host) => {
      capturedPort = host;
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
      if (recorded.status !== "recorded") return { status: "failed", detail: "record failed" };
      return { status: "completed", findingIds: recorded.findings.map((finding) => finding.id) };
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
        readCurrentHeadSha: async () => {
          if (settled) delegateCallsAfterSettlement += 1;
          return HEAD_SHA;
        },
        readPullRequestDiff: async () => {
          if (settled) delegateCallsAfterSettlement += 1;
          return { status: "unavailable", reason: "unavailable" };
        },
        runReadOnlyReviewTurn: async () => {
          if (settled) delegateCallsAfterSettlement += 1;
          return { status: "cancelled" };
        },
        recordFindings: async () => {
          if (settled) delegateCallsAfterSettlement += 1;
          return {
            status: "recorded",
            findings: [makeRecordedFinding(FINDING_ID_1, "error", "Blocking defect.")],
          };
        },
        isPostSummaryCommentEnabled: () => true,
        postSummaryComment: async () => {
          if (settled) delegateCallsAfterSettlement += 1;
          return { status: "posted" };
        },
        isSendBlockingFindingsEnabled: () => true,
        handBackBlockingFindings: async () => {
          if (settled) delegateCallsAfterSettlement += 1;
          return { status: "handed-back", attempt: 1 };
        },
      },
    });
    settled = true;

    expect(outcome).toMatchObject({ status: "completed", findingIds: [FINDING_ID_1] });
    expect(capturedPort).toBeDefined();
    if (capturedPort === undefined) return;

    expect(await capturedPort.isHeadCurrent()).toBe(false);
    expect(await capturedPort.readPullRequestDiff()).toEqual({
      status: "unavailable",
      reason: "not-effective",
    });
    expect(await capturedPort.runReadOnlyReviewTurn({ prompt: "Late turn" })).toMatchObject({
      status: "refused",
      reason: "not-effective",
    });
    expect(
      await capturedPort.recordFindings({
        findings: [
          {
            path: APP_PATH,
            location: { kind: "line", line: 1 },
            severity: "note",
            summary: "Late finding.",
          },
        ],
      }),
    ).toEqual({ status: "refused", reason: "not-effective" });
    expect(await capturedPort.postSummaryComment({ body: "Late comment" })).toEqual({
      status: "refused",
      reason: "not-effective",
    });
    expect(
      await capturedPort.handBackBlockingFindings({
        findingIds: [decodeCodeReviewFindingId(FINDING_ID_1)],
      }),
    ).toEqual({ status: "refused", reason: "not-effective" });
    expect(delegateCallsAfterSettlement).toBe(0);
  });

  it("releases in-flight comment and hand-back reservations when a delegate rejects so caught retries can succeed", async () => {
    const registry = new PullRequestReviewerRegistry();
    let commentAttempts = 0;
    let handBackAttempts = 0;

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
      if (recorded.status !== "recorded") return { status: "failed", detail: "record failed" };
      const findingIds = recorded.findings.map((finding) => finding.id);

      // First comment attempt rejects before posting; reviewer catches and retries.
      await expect(host.postSummaryComment({ body: "Summary" })).rejects.toThrow("transient error");
      expect(await host.postSummaryComment({ body: "Summary" })).toEqual({
        status: "posted",
        commentId: "comment-retry-1",
      });
      // Once posted, a third attempt is still refused as already-posted.
      expect(await host.postSummaryComment({ body: "Duplicate" })).toEqual({
        status: "refused",
        reason: "already-posted",
      });

      // First hand-back attempt rejects before waking; reviewer catches and retries.
      await expect(host.handBackBlockingFindings({ findingIds })).rejects.toThrow("transient wake");
      expect(await host.handBackBlockingFindings({ findingIds })).toEqual({
        status: "handed-back",
        attempt: 1,
      });
      // Once handed back, a third attempt is still refused as already-handed-back.
      expect(await host.handBackBlockingFindings({ findingIds })).toEqual({
        status: "refused",
        reason: "already-handed-back",
      });

      return { status: "completed", findingIds };
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
        recordFindings: async () => ({
          status: "recorded",
          findings: [makeRecordedFinding(FINDING_ID_1, "error", "Blocking defect.")],
        }),
        isPostSummaryCommentEnabled: () => true,
        postSummaryComment: async () => {
          commentAttempts += 1;
          if (commentAttempts === 1) throw new Error("transient error");
          return { status: "posted", commentId: "comment-retry-1" };
        },
        isSendBlockingFindingsEnabled: () => true,
        handBackBlockingFindings: async () => {
          handBackAttempts += 1;
          if (handBackAttempts === 1) throw new Error("transient wake");
          return { status: "handed-back", attempt: 1 };
        },
      },
    });

    expect(commentAttempts).toBe(2);
    expect(handBackAttempts).toBe(2);
    expect(outcome).toEqual({
      status: "completed",
      findingIds: [FINDING_ID_1],
      summaryCommentPosted: true,
      handedBackToWorker: true,
    });
  });
});
