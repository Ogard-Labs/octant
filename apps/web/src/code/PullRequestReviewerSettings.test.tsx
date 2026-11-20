import type { PullRequestReviewClient } from "@octant/client-runtime/pull-request-review-client";
import {
  GithubRepositoryName,
  GithubRepositoryOwner,
  decodeCodeReviewFinding,
  decodeCodeThreadId,
  decodeProjectId,
  decodeProviderInstanceId,
  decodeProviderModelId,
  decodePullRequestReviewId,
  decodePullRequestReviewerId,
  type CodeReviewFindingAssessment,
  type ProviderRegistrySnapshot,
  type PullRequestReviewProjectView,
  type PullRequestReviewPullRequestView,
  type PullRequestReviewRunRecord,
  type PullRequestReviewTarget,
  type PullRequestReviewThreadView,
} from "@octant/contracts";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import { codeClient, ids, scope } from "./CodeDeliveryPane.test-fixtures";
import { CodeReviewPane } from "./CodeReviewPane";
import {
  ProjectPullRequestReviewerSection,
  PullRequestHandBackSwitch,
  ThreadPullRequestReviewerSection,
  reviewerRouteOptions,
} from "./PullRequestReviewerSettings";

const NOW = "2026-11-20T12:00:00.000Z";
const PROJECT_ID = decodeProjectId("20000000-0000-4000-8000-000000000001");
const THREAD_ID = decodeCodeThreadId("30000000-0000-4000-8000-000000000001");
const WORKER_PROVIDER = decodeProviderInstanceId("60000000-0000-4000-8000-000000000001");
const REVIEWER_PROVIDER = decodeProviderInstanceId("60000000-0000-4000-8000-000000000002");
const WORKER_MODEL = decodeProviderModelId("claude-sonnet-4-5");
const REVIEWER_MODEL = decodeProviderModelId("gpt-5.3-codex");
const REVIEWER_ID = decodePullRequestReviewerId("octant/second-model-pull-request-reviewer");
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);

const TARGET: PullRequestReviewTarget = {
  projectId: PROJECT_ID,
  repositoryOwner: Schema.decodeUnknownSync(GithubRepositoryOwner)("ogard-labs"),
  repositoryName: Schema.decodeUnknownSync(GithubRepositoryName)("octant"),
  number: 42,
};

const SNAPSHOT = {
  instances: [
    { id: WORKER_PROVIDER, displayName: "Claude", enabled: true },
    { id: REVIEWER_PROVIDER, displayName: "Codex", enabled: true },
  ],
  catalogs: [
    {
      instanceId: WORKER_PROVIDER,
      models: [{ id: WORKER_MODEL, displayName: "Claude Sonnet 4.5" }],
    },
    {
      instanceId: REVIEWER_PROVIDER,
      models: [{ id: REVIEWER_MODEL, displayName: "GPT-5.3 Codex" }],
    },
  ],
  observedStates: [],
} as unknown as ProviderRegistrySnapshot;

function makeAgentFinding() {
  return decodeCodeReviewFinding({
    id: ids.finding,
    threadId: scope.threadId,
    checkoutId: scope.checkoutId,
    fileId: ids.file,
    path: "src/auth.ts",
    fileDigest: "d".repeat(64),
    anchor: {
      kind: "captured-diff",
      reviewOperationId: ids.operation,
      diff: {
        contentId: "72000000-0000-4000-8000-000000000001",
        digest: "d".repeat(64),
        byteLength: 64,
      },
      revision: {
        kind: "branch",
        head: HEAD_A,
        baseRef: "origin/main",
      },
      side: "modified",
      capturedAt: NOW,
    },
    location: { kind: "line", line: 12 },
    severity: "error",
    author: {
      kind: "agent",
      providerInstanceId: REVIEWER_PROVIDER,
      sessionId: "reviewer-session-1",
    },
    provenance: {
      kind: "pull-request-reviewer",
      reviewerId: String(REVIEWER_ID),
      reviewId: "73000000-0000-4000-8000-000000000001",
      runId: "74000000-0000-4000-8000-000000000001",
      providerInstanceId: REVIEWER_PROVIDER,
      modelId: REVIEWER_MODEL,
      effort: "high",
      headSha: HEAD_A,
    },
    summary: "Guest role bypasses owner check.",
    state: "open",
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function makeClient(overrides?: {
  readonly projectView?: PullRequestReviewProjectView;
  readonly threadView?: PullRequestReviewThreadView;
  readonly prView?: PullRequestReviewPullRequestView;
}): PullRequestReviewClient {
  let projectView: PullRequestReviewProjectView = overrides?.projectView ?? {
    settings: {
      projectId: PROJECT_ID,
      enabled: false,
      postSummaryComment: false,
      version: 0 as never,
    },
    offeredReviewers: [{ reviewerId: REVIEWER_ID, displayName: "Second-model PR reviewer" }],
  };
  let threadView: PullRequestReviewThreadView = overrides?.threadView ?? {
    override: { threadId: THREAD_ID, mode: "inherit", version: 0 as never },
    projectSettings: projectView.settings,
    effective: {
      enabled: false,
      reviewerId: REVIEWER_ID,
      postSummaryComment: false,
      sendBlockingFindingsToWorker: false,
    },
    offeredReviewers: projectView.offeredReviewers,
  };
  let prView: PullRequestReviewPullRequestView = overrides?.prView ?? {
    settings: {
      target: TARGET,
      sendBlockingFindingsToWorker: false,
      version: 0 as never,
    },
    effective: threadView.effective,
    handBackAttempts: 0,
  };

  return {
    queryProject: vi.fn(async () => projectView),
    updateProject: vi.fn(async (command) => {
      projectView = {
        ...projectView,
        settings: {
          projectId: command.projectId,
          enabled: command.enabled,
          ...(command.reviewerId === undefined ? {} : { reviewerId: command.reviewerId }),
          ...(command.route === null || command.route === undefined
            ? {}
            : { route: command.route }),
          postSummaryComment: command.postSummaryComment,
          version: ((projectView.settings.version as number) + 1) as never,
        },
      };
      return projectView;
    }),
    queryThread: vi.fn(async () => threadView),
    updateThread: vi.fn(async (command) => {
      threadView = {
        ...threadView,
        override: {
          threadId: command.threadId,
          mode: command.mode,
          ...(command.route === null || command.route === undefined
            ? {}
            : { route: command.route }),
          version: ((threadView.override.version as number) + 1) as never,
        },
      };
      return threadView;
    }),
    queryPullRequest: vi.fn(async () => prView),
    updatePullRequest: vi.fn(async (command) => {
      prView = {
        ...prView,
        settings: {
          target: command.target,
          sendBlockingFindingsToWorker: command.sendBlockingFindingsToWorker,
          version: ((prView.settings.version as number) + 1) as never,
        },
      };
      return prView;
    }),
  };
}

describe("second-model pull request reviewer UI", () => {
  it("renders agent findings with provenance, stale anchors, unavailable banners, and lets the person select findings to prepare a correction request via keyboard", async () => {
    const finding = makeAgentFinding();
    const assessments: ReadonlyArray<CodeReviewFindingAssessment> = [
      {
        finding,
        anchorState: "outdated",
        explanation:
          "The checkout or compared revision changed. This finding stays on its original side and line.",
      },
    ];
    const unavailableReview: PullRequestReviewRunRecord = {
      reviewId: decodePullRequestReviewId("75000000-0000-4000-8000-000000000001"),
      reviewerId: REVIEWER_ID,
      target: TARGET,
      threadId: scope.threadId,
      headSha: HEAD_B,
      status: "refused",
      findingIds: [],
      summaryCommentPosted: false,
      handedBackToWorker: false,
      reason: "spend-ceiling",
      detail: "Thread spend ceiling reached; no fallback model was called.",
      startedAt: NOW as never,
      completedAt: NOW as never,
    };
    const onPrepareCorrection = vi.fn(async () => undefined);

    const { rerender } = render(
      <div data-theme="light">
        <CodeReviewPane
          assessments={assessments}
          client={codeClient()}
          createFindingId={() => ids.finding as never}
          createOperationId={() => ids.operation as never}
          executionPolicy="full-access"
          findings={[finding]}
          latestPullRequestReview={unavailableReview}
          onPrepareCorrection={onPrepareCorrection}
          scope={scope}
        />
      </div>,
    );

    expect(screen.getByText("Reviewer unavailable")).toBeVisible();
    expect(screen.getByText("Thread spend ceiling reached")).toBeVisible();
    expect(screen.getByText(/no fallback model was called/i)).toBeVisible();
    expect(screen.getByText("Agent review")).toBeVisible();
    expect(screen.getByText("Blocking")).toBeVisible();
    expect(screen.getByText("Stale anchor")).toBeVisible();
    expect(
      screen.getByText(/Second-model reviewer · gpt-5.3-codex \(high effort\) · head aaaaaaa/),
    ).toBeVisible();

    // Keyboard-accessible selection -> Prepare correction draft.
    const checkbox = screen.getByRole("checkbox", {
      name: /Select finding: Guest role bypasses owner check\./i,
    });
    checkbox.focus();
    expect(checkbox).toHaveFocus();
    fireEvent.click(checkbox);

    const prepareButton = screen.getByRole("button", { name: "Prepare correction draft" });
    expect(prepareButton).toBeEnabled();
    prepareButton.focus();
    expect(prepareButton).toHaveFocus();
    fireEvent.click(prepareButton);

    await waitFor(() =>
      expect(onPrepareCorrection).toHaveBeenCalledWith([
        { findingId: finding.id, expectedVersion: finding.version },
      ]),
    );

    // Renders stale review banner cleanly in dark mode too.
    rerender(
      <div data-theme="dark">
        <CodeReviewPane
          assessments={assessments}
          client={codeClient()}
          createFindingId={() => ids.finding as never}
          createOperationId={() => ids.operation as never}
          executionPolicy="full-access"
          findings={[finding]}
          latestPullRequestReview={{
            ...unavailableReview,
            status: "stale",
            headSha: HEAD_A,
            currentHeadSha: HEAD_B,
            reason: undefined,
          }}
          onPrepareCorrection={onPrepareCorrection}
          scope={scope}
        />
      </div>,
    );
    expect(screen.getByText("Stale review")).toBeVisible();
    expect(screen.getByText(/moved to bbbbbbb/i)).toBeVisible();
  });

  it("keeps Project review off by default with no default model, suggests a different provider from the worker, and keeps comment posting opt-in", async () => {
    const options = reviewerRouteOptions({
      snapshot: SNAPSHOT,
      current: undefined,
      workerProviderInstanceId: WORKER_PROVIDER,
      emptyOption: { id: "none", label: "Off — pick a reviewer model" },
    });
    expect(options[0]?.label).toBe("Off — pick a reviewer model");
    expect(options[1]?.label).toContain("Codex · GPT-5.3 Codex (Suggested · different provider)");
    expect(options[2]?.label).toBe("Claude · Claude Sonnet 4.5");

    const client = makeClient();
    render(
      <ProjectPullRequestReviewerSection
        client={client}
        projectId={PROJECT_ID}
        providerSnapshot={SNAPSHOT}
        workerProviderInstanceId={WORKER_PROVIDER}
      />,
    );

    await waitFor(() =>
      expect(client.queryProject).toHaveBeenCalledWith(PROJECT_ID, expect.anything()),
    );
    const reviewSwitch = screen.getByRole("switch", { name: "Review pushed PR heads" });
    const commentSwitch = screen.getByRole("switch", { name: "Post findings as a PR comment" });
    expect(reviewSwitch).toHaveAttribute("aria-checked", "false");
    expect(reviewSwitch).toHaveAttribute("aria-disabled", "true");
    expect(commentSwitch).toHaveAttribute("aria-checked", "false");

    // Turning on comment posting works independently and journals through the client.
    commentSwitch.focus();
    expect(commentSwitch).toHaveFocus();
    fireEvent.click(commentSwitch);
    await waitFor(() =>
      expect(client.updateProject).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: PROJECT_ID,
          enabled: false,
          postSummaryComment: true,
        }),
      ),
    );
  });

  it("renders per-thread override and per-PR blocking-findings hand-back toggle off by default and persists toggles via keyboard", async () => {
    const client = makeClient();
    render(
      <>
        <ThreadPullRequestReviewerSection
          client={client}
          providerSnapshot={SNAPSHOT}
          threadId={THREAD_ID}
          workerProviderInstanceId={WORKER_PROVIDER}
        />
        <PullRequestHandBackSwitch client={client} target={TARGET} threadId={THREAD_ID} />
      </>,
    );

    await waitFor(() =>
      expect(client.queryPullRequest).toHaveBeenCalledWith(
        { target: TARGET, threadId: THREAD_ID },
        expect.anything(),
      ),
    );

    const handBackSwitch = screen.getByRole("switch", {
      name: "Send blocking findings to the worker",
    });
    expect(handBackSwitch).toHaveAttribute("aria-checked", "false");
    handBackSwitch.focus();
    expect(handBackSwitch).toHaveFocus();
    fireEvent.click(handBackSwitch);

    await waitFor(() =>
      expect(client.updatePullRequest).toHaveBeenCalledWith({
        target: TARGET,
        sendBlockingFindingsToWorker: true,
      }),
    );
  });
});
