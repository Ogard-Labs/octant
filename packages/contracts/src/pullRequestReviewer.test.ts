import { describe, expect, it } from "vitest";
import { decodeCodeReviewFinding } from "./codeOperations";
import { decodeExtensionContentDigest, decodeExtensionPackageManifest } from "./extensions";
import {
  decodePullRequestReviewDiffSnapshot,
  decodePullRequestReviewFindingProposal,
  decodePullRequestReviewOutcome,
  decodePullRequestReviewProjectSettingsCommand,
  decodePullRequestReviewPullRequestSettingsCommand,
  decodePullRequestReviewRequest,
  decodePullRequestReviewRunRecord,
  decodePullRequestReviewThreadOverrideCommand,
  decodePullRequestReviewerId,
} from "./pullRequestReviewer";

const UUID_1 = "11111111-1111-4111-8111-111111111111";
const UUID_2 = "22222222-2222-4222-8222-222222222222";
const UUID_3 = "33333333-3333-4333-8333-333333333333";
const UUID_4 = "44444444-4444-4444-8444-444444444444";
const UUID_5 = "55555555-5555-4555-8555-555555555555";
const UUID_6 = "66666666-6666-4666-8666-666666666666";
const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const FILE_DIGEST = "c".repeat(64);

const validRequest = {
  reviewId: UUID_1,
  target: {
    projectId: UUID_2,
    repositoryOwner: "ogard-labs",
    repositoryName: "octant",
    number: 42,
  },
  threadId: UUID_3,
  checkoutId: UUID_4,
  headSha: HEAD_SHA,
  baseRef: "refs/heads/main",
  baseSha: BASE_SHA,
  workerRoute: {
    providerInstanceId: UUID_5,
    modelId: "claude-sonnet-4-5",
  },
  configuredRoute: {
    providerInstanceId: UUID_6,
    modelId: "gpt-5.3-codex",
    effort: "high",
  },
  optIns: {
    postSummaryComment: false,
    sendBlockingFindingsToWorker: false,
  },
};

describe("pull request reviewer contracts", () => {
  it("decodes a valid pull request review request and rejects unknown properties", () => {
    const decoded = decodePullRequestReviewRequest(validRequest);
    expect(decoded.headSha).toBe(HEAD_SHA);
    expect(decoded.configuredRoute?.effort).toBe("high");

    expect(() =>
      decodePullRequestReviewRequest({ ...validRequest, extraField: "not-allowed" }),
    ).toThrow();
  });

  it("refuses malformed head commit SHAs and invalid reviewer ids", () => {
    expect(() =>
      decodePullRequestReviewRequest({ ...validRequest, headSha: "not-a-sha" }),
    ).toThrow();
    expect(() => decodePullRequestReviewerId("Invalid Uppercase")).toThrow();
    expect(decodePullRequestReviewerId("example.review/static-check")).toBe(
      "example.review/static-check",
    );
  });

  it("decodes bounded diff snapshots and finding proposals without accepting NUL bytes", () => {
    const snapshot = decodePullRequestReviewDiffSnapshot({
      headSha: HEAD_SHA,
      baseRef: "refs/heads/main",
      reviewOperationId: UUID_1,
      files: [
        {
          fileId: UUID_2,
          path: "src/index.ts",
          fileDigest: FILE_DIGEST,
          status: "modified",
          patch: "@@ -1,1 +1,1 @@\n-old\n+new\n",
        },
      ],
    });
    expect(snapshot.files).toHaveLength(1);

    const proposal = decodePullRequestReviewFindingProposal({
      path: "src/index.ts",
      location: { kind: "line", line: 12 },
      severity: "error",
      summary: "Null dereference when request body is empty.",
    });
    expect(proposal.severity).toBe("error");

    expect(() =>
      decodePullRequestReviewFindingProposal({
        path: "src/index.ts",
        location: { kind: "line", line: 12 },
        severity: "error",
        summary: "bad\u0000byte",
      }),
    ).toThrow();
  });

  it("decodes every settled pull request review outcome variant strictly", () => {
    expect(
      decodePullRequestReviewOutcome({
        status: "completed",
        findingIds: [UUID_1],
        runId: UUID_2,
        summaryCommentPosted: false,
        handedBackToWorker: false,
      }),
    ).toMatchObject({ status: "completed" });

    expect(
      decodePullRequestReviewOutcome({
        status: "stale",
        currentHeadSha: BASE_SHA,
      }),
    ).toEqual({ status: "stale", currentHeadSha: BASE_SHA });

    expect(
      decodePullRequestReviewOutcome({
        status: "refused",
        reason: "no-route-configured",
        detail: "Pick a reviewer model before running pull request review.",
      }),
    ).toMatchObject({ status: "refused", reason: "no-route-configured" });

    expect(() =>
      decodePullRequestReviewOutcome({
        status: "refused",
        reason: "unknown-reason",
        detail: "Nope",
      }),
    ).toThrow();
  });

  it("accepts a pull-request-reviewer component in an extension package manifest", () => {
    const manifest = decodeExtensionPackageManifest({
      manifestVersion: 1,
      extensionId: UUID_1,
      packageId: UUID_2,
      slug: "example-pr-reviewer",
      displayName: "Example PR Reviewer",
      version: "1.0.0",
      digest: decodeExtensionContentDigest(`sha256:${"d".repeat(64)}`),
      source: { kind: "bundled", sourceRef: "app:example-pr-reviewer" },
      provenance: { publisher: "Octant", reviewed: true },
      license: { kind: "spdx", identifier: "MIT" },
      compatibility: {
        platforms: ["macos", "linux"],
        modes: ["code"],
        providerFamilies: [],
      },
      declaredCapabilities: [],
      primaryComponentId: "example-reviewer",
      components: [
        {
          id: "example-reviewer",
          kind: "pull-request-reviewer",
          displayName: "Example PR Reviewer",
          declaredCapabilities: [],
        },
      ],
    });
    expect(manifest.components[0]?.kind).toBe("pull-request-reviewer");
  });

  it("round-trips a CodeReviewFinding with an agent author and pull request reviewer provenance", () => {
    const raw = {
      id: UUID_1,
      threadId: UUID_3,
      checkoutId: UUID_4,
      fileId: UUID_2,
      path: "src/index.ts",
      fileDigest: FILE_DIGEST,
      anchor: {
        kind: "captured-diff",
        reviewOperationId: UUID_5,
        diff: {
          contentId: UUID_6,
          digest: FILE_DIGEST,
          byteLength: 128,
        },
        revision: {
          kind: "branch",
          head: HEAD_SHA,
          base: BASE_SHA,
          baseRef: "origin/main",
        },
        side: "modified",
        capturedAt: "2026-11-20T10:00:00.000Z",
      },
      location: { kind: "line", line: 12 },
      severity: "error",
      author: {
        kind: "agent",
        providerInstanceId: UUID_6,
        sessionId: "reviewer-session-1",
      },
      provenance: {
        kind: "pull-request-reviewer",
        reviewerId: "octant/second-model-pull-request-reviewer",
        reviewId: UUID_1,
        runId: UUID_2,
        providerInstanceId: UUID_6,
        modelId: "gpt-5.3-codex",
        effort: "high",
        headSha: HEAD_SHA,
      },
      summary: "Missing bounds check before indexing the payload.",
      state: "open",
      version: 1,
      createdAt: "2026-11-20T10:01:00.000Z",
      updatedAt: "2026-11-20T10:01:00.000Z",
    };

    const decoded = decodeCodeReviewFinding(raw);
    expect(decoded.author).toEqual({
      kind: "agent",
      providerInstanceId: UUID_6,
      sessionId: "reviewer-session-1",
    });
    expect(decoded.provenance).toEqual({
      kind: "pull-request-reviewer",
      reviewerId: "octant/second-model-pull-request-reviewer",
      reviewId: UUID_1,
      runId: UUID_2,
      providerInstanceId: UUID_6,
      modelId: "gpt-5.3-codex",
      effort: "high",
      headSha: HEAD_SHA,
    });
    expect(decodeCodeReviewFinding(JSON.parse(JSON.stringify(decoded)))).toEqual(decoded);

    expect(() =>
      decodeCodeReviewFinding({
        ...raw,
        provenance: { ...raw.provenance, headSha: "not-a-sha" },
      }),
    ).toThrow();
  });

  it("decodes project, thread override, per-PR settings commands and run records strictly", () => {
    const projectCommand = decodePullRequestReviewProjectSettingsCommand({
      projectId: UUID_2,
      enabled: true,
      reviewerId: "octant/second-model-pull-request-reviewer",
      route: { providerInstanceId: UUID_6, modelId: "gpt-5.3-codex", effort: "medium" },
      postSummaryComment: false,
    });
    expect(projectCommand.enabled).toBe(true);
    expect(projectCommand.postSummaryComment).toBe(false);

    const threadCommand = decodePullRequestReviewThreadOverrideCommand({
      threadId: UUID_3,
      mode: "disabled",
      route: null,
    });
    expect(threadCommand.mode).toBe("disabled");

    const prCommand = decodePullRequestReviewPullRequestSettingsCommand({
      target: validRequest.target,
      sendBlockingFindingsToWorker: true,
    });
    expect(prCommand.sendBlockingFindingsToWorker).toBe(true);

    const record = decodePullRequestReviewRunRecord({
      reviewId: UUID_1,
      reviewerId: "octant/second-model-pull-request-reviewer",
      target: validRequest.target,
      threadId: UUID_3,
      headSha: HEAD_SHA,
      status: "refused",
      findingIds: [],
      summaryCommentPosted: false,
      handedBackToWorker: false,
      reason: "spend-ceiling",
      detail: "Thread spend ceiling reached before starting the review.",
      startedAt: "2026-11-20T10:00:00.000Z",
      completedAt: "2026-11-20T10:00:01.000Z",
    });
    expect(record.reason).toBe("spend-ceiling");
  });
});
