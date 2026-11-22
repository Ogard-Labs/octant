import {
  decodeProjectId,
  decodeProviderInstanceId,
  decodeProviderModelId,
  decodePullRequestReviewerId,
  type ProviderExecutionPolicy,
} from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  authorizePullRequestReviewSettingChange,
  decidePullRequestReviewHandBack,
  decidePullRequestReviewerAction,
  evaluatePullRequestReviewHeadCurrency,
  pullRequestReviewerExecutionPolicy,
  pullRequestReviewTargetKey,
  rankPullRequestReviewerRoutes,
  resolveEffectivePullRequestReviewConfig,
  shouldStartPullRequestReviewForHead,
  type PullRequestReviewerActionKind,
} from "./pullRequestReviewPolicy";

const DEFAULT_REVIEWER = decodePullRequestReviewerId("octant/second-model-pull-request-reviewer");
const PROVIDER_A = decodeProviderInstanceId("11111111-1111-4111-8111-111111111111");
const PROVIDER_B = decodeProviderInstanceId("22222222-2222-4222-8222-222222222222");
const MODEL_A = decodeProviderModelId("claude-sonnet-4-5");
const MODEL_B = decodeProviderModelId("gpt-5.3-codex");
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);

const ALL_EXECUTION_POLICIES: ReadonlyArray<ProviderExecutionPolicy> = [
  "plan",
  "approval-gated",
  "full-access",
];

const MUTATING_ACTIONS: ReadonlyArray<PullRequestReviewerActionKind> = [
  "edit-file",
  "write-file",
  "delete-file",
  "shell-write",
  "git-write",
  "forge-write",
  "forge-review",
  "spawn-child-run",
];

const READ_ONLY_ACTIONS: ReadonlyArray<PullRequestReviewerActionKind> = [
  "read-file",
  "read-diff",
  "search-files",
  "read-git-status",
];

describe("pull request review domain policy", () => {
  it("refuses every write, shell write, forge write, forge review, and child-run action at every guardrail level including Full access", () => {
    for (const threadExecutionPolicy of ALL_EXECUTION_POLICIES) {
      expect(pullRequestReviewerExecutionPolicy(threadExecutionPolicy)).toEqual({
        executionPolicy: "plan",
        role: "research",
        readOnly: true,
        filesystemWrite: false,
        shellWrite: false,
        gitWrite: false,
        forgeWrite: false,
        allowChildRuns: false,
      });

      for (const action of MUTATING_ACTIONS) {
        expect(decidePullRequestReviewerAction({ threadExecutionPolicy, action })).toEqual({
          allowed: false,
          reason: "plan-read-only-gate",
        });
      }

      for (const action of READ_ONLY_ACTIONS) {
        expect(decidePullRequestReviewerAction({ threadExecutionPolicy, action })).toEqual({
          allowed: true,
        });
      }
    }
  });

  it("marks a review stale whenever the PR head moves or becomes unreadable", () => {
    expect(
      evaluatePullRequestReviewHeadCurrency({
        reviewedHeadSha: HEAD_A,
        currentHeadSha: HEAD_A,
      }),
    ).toEqual({ status: "current" });

    expect(
      evaluatePullRequestReviewHeadCurrency({
        reviewedHeadSha: HEAD_A,
        currentHeadSha: HEAD_B,
      }),
    ).toEqual({ status: "stale", currentHeadSha: HEAD_B });

    expect(
      evaluatePullRequestReviewHeadCurrency({
        reviewedHeadSha: HEAD_A,
        currentHeadSha: undefined,
      }),
    ).toEqual({ status: "stale" });
  });

  it("allows setting changes from a local window or host-person-paired device and refuses hub-introduced or restricted devices", () => {
    expect(authorizePullRequestReviewSettingChange("local-window")).toEqual({ allowed: true });
    expect(authorizePullRequestReviewSettingChange("person-paired-device")).toEqual({
      allowed: true,
    });
    expect(authorizePullRequestReviewSettingChange("remote-device")).toEqual({
      allowed: false,
      reason: "host-person-required",
    });
  });

  it("stays off by default, requires an explicit reviewer model with no silent default, and respects thread overrides and plugin effectiveness", () => {
    const offByDefault = resolveEffectivePullRequestReviewConfig({
      projectEnabled: false,
      postSummaryComment: false,
      threadMode: "inherit",
      sendBlockingFindingsToWorker: false,
      defaultReviewerId: DEFAULT_REVIEWER,
      reviewerOffered: true,
    });
    expect(offByDefault.enabled).toBe(false);
    expect(offByDefault.unavailableReason).toBeUndefined();

    const missingModel = resolveEffectivePullRequestReviewConfig({
      projectEnabled: true,
      postSummaryComment: false,
      threadMode: "inherit",
      sendBlockingFindingsToWorker: false,
      defaultReviewerId: DEFAULT_REVIEWER,
      reviewerOffered: true,
    });
    expect(missingModel.enabled).toBe(false);
    expect(missingModel.unavailableReason).toBe("no-route-configured");

    const disabledPlugin = resolveEffectivePullRequestReviewConfig({
      projectEnabled: true,
      projectRoute: { providerInstanceId: PROVIDER_B, modelId: MODEL_B },
      postSummaryComment: true,
      threadMode: "inherit",
      sendBlockingFindingsToWorker: true,
      defaultReviewerId: DEFAULT_REVIEWER,
      reviewerOffered: false,
    });
    expect(disabledPlugin.enabled).toBe(false);
    expect(disabledPlugin.unavailableReason).toBe("not-effective");

    const threadDisabled = resolveEffectivePullRequestReviewConfig({
      projectEnabled: true,
      projectRoute: { providerInstanceId: PROVIDER_B, modelId: MODEL_B },
      postSummaryComment: false,
      threadMode: "disabled",
      sendBlockingFindingsToWorker: false,
      defaultReviewerId: DEFAULT_REVIEWER,
      reviewerOffered: true,
    });
    expect(threadDisabled.enabled).toBe(false);

    const threadEnabledWithOwnRoute = resolveEffectivePullRequestReviewConfig({
      projectEnabled: false,
      postSummaryComment: false,
      threadMode: "enabled",
      threadRoute: { providerInstanceId: PROVIDER_A, modelId: MODEL_A, effort: "high" },
      sendBlockingFindingsToWorker: true,
      defaultReviewerId: DEFAULT_REVIEWER,
      reviewerOffered: true,
    });
    expect(threadEnabledWithOwnRoute).toMatchObject({
      enabled: true,
      route: { providerInstanceId: PROVIDER_A, modelId: MODEL_A, effort: "high" },
      sendBlockingFindingsToWorker: true,
    });
  });

  it("starts at most one review per pushed head after the worker turn settles", () => {
    const reviewed = new Set<string>([HEAD_A]);

    expect(
      shouldStartPullRequestReviewForHead({
        headSha: HEAD_B,
        reviewedHeadShas: reviewed,
        workerTurnActive: true,
      }),
    ).toEqual({ start: false, reason: "worker-turn-active" });

    expect(
      shouldStartPullRequestReviewForHead({
        headSha: HEAD_A,
        reviewedHeadShas: reviewed,
        workerTurnActive: false,
      }),
    ).toEqual({ start: false, reason: "already-reviewed" });

    expect(
      shouldStartPullRequestReviewForHead({
        headSha: HEAD_B,
        reviewedHeadShas: reviewed,
        inFlightHeadSha: HEAD_B,
        workerTurnActive: false,
      }),
    ).toEqual({ start: false, reason: "already-in-flight" });

    expect(
      shouldStartPullRequestReviewForHead({
        headSha: HEAD_B,
        reviewedHeadShas: reviewed,
        workerTurnActive: false,
      }),
    ).toEqual({ start: true });
  });

  it("caps blocking-finding hand-backs at three under Strict and leaves them uncapped outside Strict", () => {
    expect(
      decidePullRequestReviewHandBack({
        sendBlockingFindingsToWorker: false,
        blockingFindingCount: 2,
        strict: false,
        attemptsUsed: 0,
      }),
    ).toEqual({ action: "disabled" });

    expect(
      decidePullRequestReviewHandBack({
        sendBlockingFindingsToWorker: true,
        blockingFindingCount: 0,
        strict: true,
        attemptsUsed: 0,
      }),
    ).toEqual({ action: "none" });

    expect(
      decidePullRequestReviewHandBack({
        sendBlockingFindingsToWorker: true,
        blockingFindingCount: 1,
        strict: true,
        attemptsUsed: 2,
      }),
    ).toEqual({ action: "hand-back", attempt: 3 });

    expect(
      decidePullRequestReviewHandBack({
        sendBlockingFindingsToWorker: true,
        blockingFindingCount: 1,
        strict: true,
        attemptsUsed: 3,
      }),
    ).toEqual({ action: "attempt-limit", maxAttempts: 3 });

    expect(
      decidePullRequestReviewHandBack({
        sendBlockingFindingsToWorker: true,
        blockingFindingCount: 1,
        strict: false,
        attemptsUsed: 10,
      }),
    ).toEqual({ action: "hand-back", attempt: 11 });
  });

  it("suggests providers different from the worker first while still keeping the worker's own provider selectable", () => {
    const ranked = rankPullRequestReviewerRoutes({
      workerProviderInstanceId: PROVIDER_A,
      candidates: [
        {
          providerInstanceId: PROVIDER_A,
          providerDisplayName: "Anthropic",
          modelId: MODEL_A,
          modelDisplayName: "Claude Sonnet 4.5",
        },
        {
          providerInstanceId: PROVIDER_B,
          providerDisplayName: "OpenAI",
          modelId: MODEL_B,
          modelDisplayName: "GPT-5.3 Codex",
        },
      ],
    });

    expect(ranked.map((item) => [item.providerDisplayName, item.suggested])).toEqual([
      ["OpenAI", true],
      ["Anthropic", false],
    ]);
  });

  it("normalizes pull request target keys case-insensitively by repository owner and name", () => {
    const projectId = decodeProjectId("33333333-3333-4333-8333-333333333333");
    const first = pullRequestReviewTargetKey({
      projectId,
      repositoryOwner: "Ogard-Labs" as never,
      repositoryName: "Octant" as never,
      number: 42,
    });
    const second = pullRequestReviewTargetKey({
      projectId,
      repositoryOwner: "ogard-labs" as never,
      repositoryName: "octant" as never,
      number: 42,
    });
    expect(first).toBe(second);
  });
});
