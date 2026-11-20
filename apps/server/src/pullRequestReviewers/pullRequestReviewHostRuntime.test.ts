import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GithubRepositoryName,
  GithubRepositoryOwner,
  PULL_REQUEST_REVIEW_USAGE_AGGREGATE_TYPE,
  decodeCodeCheckoutId,
  decodeCodeCheckoutIdentity,
  decodeCodeEvidenceReference,
  decodeCodeOperationEventFrame,
  decodeCodeRelativePath,
  decodeCodeRepositoryId,
  decodeCodeThread,
  decodeCodeThreadId,
  decodeProjectId,
  decodeProviderInstance,
  decodeProviderInstanceId,
  decodeProviderModelId,
  decodeProviderObservedState,
  decodeUtcTimestamp,
  decodeWindowId,
  type CodeOperationEventFrame,
  type CodeReviewFinding,
  type CodeThread,
  type EventActor,
  type ProviderModel,
  type ProviderModelOptionValues,
  type ProviderRuntimeEvent,
  type PullRequestReviewRoute,
  type PullRequestReviewTarget,
} from "@octant/contracts";
import type { ProviderDriver } from "@octant/provider-sdk/driver";
import { Effect, Schema, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { CodeOperationService } from "../code/codeOperationService";
import type { GhCommandPort } from "../code/ghPullRequestPort";
import { ReviewFindingService } from "../code/reviewFindingService";
import { TurnMetricsStore } from "../metrics/turnMetricsStore";
import { Journal } from "../persistence/journal";
import { MIGRATIONS, applyMigrations } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { codexModelOptionSettings } from "../providers/codexDriver";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import { createPullRequestReviewHostRuntime } from "./pullRequestReviewHostRuntime";
import { PullRequestReviewerRegistry } from "./pullRequestReviewerRegistry";
import { PullRequestReviewService } from "./pullRequestReviewService";
import {
  SECOND_MODEL_PULL_REQUEST_REVIEWER_DISPLAY_NAME,
  SECOND_MODEL_PULL_REQUEST_REVIEWER_ID,
  createSecondModelPullRequestReviewer,
} from "./secondModelPullRequestReviewer";

const WINDOW_ID = decodeWindowId("11000000-0000-4000-8000-000000000001");
const PROJECT_ID = decodeProjectId("22000000-0000-4000-8000-000000000001");
const THREAD_ID = decodeCodeThreadId("33000000-0000-4000-8000-000000000001");
const CHECKOUT_ID = decodeCodeCheckoutId("44000000-0000-4000-8000-000000000001");
const REPO_ID = decodeCodeRepositoryId(`repo_${"a".repeat(64)}`);
const WORKER_PROVIDER_ID = decodeProviderInstanceId("55000000-0000-4000-8000-000000000001");
const REVIEWER_PROVIDER_ID = decodeProviderInstanceId("55000000-0000-4000-8000-000000000002");
const WORKER_MODEL_ID = decodeProviderModelId("claude-sonnet-4-5");
const CODEX_MODEL_ID = decodeProviderModelId("gpt-5.3-codex");
const HEAD_SHA = "1".repeat(40);
const OTHER_LOCAL_HEAD = "2".repeat(40);
const BASE_SHA = "9".repeat(40);
const LOCAL_ACTOR: EventActor = { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID as never };

const TARGET: PullRequestReviewTarget = {
  projectId: PROJECT_ID,
  repositoryOwner: Schema.decodeUnknownSync(GithubRepositoryOwner)("ogard-labs"),
  repositoryName: Schema.decodeUnknownSync(GithubRepositoryName)("octant"),
  number: 77,
};

const MAIN_DIFF = [
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

const RELEASE_DIFF = [
  "diff --git a/src/releaseGuard.ts b/src/releaseGuard.ts",
  "--- a/src/releaseGuard.ts",
  "+++ b/src/releaseGuard.ts",
  "@@ -1,3 +1,4 @@",
  " export function releaseReady(flag: boolean) {",
  "+  return true;",
  "   return flag;",
  " }",
  "",
].join("\n");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeThread(baseBranch = "main"): CodeThread {
  return decodeCodeThread({
    id: THREAD_ID,
    projectId: PROJECT_ID,
    bindingRevisionId: "66000000-0000-4000-8000-000000000001",
    repositoryId: REPO_ID,
    checkoutId: CHECKOUT_ID,
    title: "Harden auth gate",
    providerInstanceId: WORKER_PROVIDER_ID,
    modelId: WORKER_MODEL_ID,
    executionPolicy: "full-access",
    permissionPersistence: "current-session",
    lifecycle: "active",
    deliveryTarget: {
      remoteName: "origin",
      proposedBaseRepository: "ogard-labs/octant",
      proposedBaseBranch: baseBranch,
      branchIntent: "feature/harden-auth",
      outcomeKind: "opened-pr",
      confirmedAt: "2026-11-20T10:00:00.000Z",
    },
    version: 1,
    createdAt: "2026-11-20T10:00:00.000Z",
    updatedAt: "2026-11-20T10:00:00.000Z",
  });
}

function makeCodexObservedState() {
  return decodeProviderObservedState({
    instanceId: REVIEWER_PROVIDER_ID,
    readiness: "ready",
    processState: "running",
    capabilities: Object.fromEntries(
      [
        "streaming",
        "resume",
        "interruption",
        "approvals",
        "userQuestions",
        "reasoning",
        "usage",
        "toolActivity",
        "fileChanges",
        "diffs",
        "taskProgress",
        "nativeChildAgents",
        "nativeAttachments",
        "nativeWebResearch",
        "appManagedTools",
        "citations",
        "harnessAutoReview",
      ].map((name) => [name, "supported"]),
    ),
    models: [
      {
        id: CODEX_MODEL_ID,
        displayName: "GPT-5.3 Codex",
        reasoning: "supported",
        inputModalities: ["text"],
        source: "discovered",
        verification: "verified",
        options: [
          {
            id: "reasoning",
            displayName: "Reasoning",
            kind: "selection",
            values: ["low", "medium", "high"],
          },
          {
            id: "service-tier",
            displayName: "Service tier",
            kind: "selection",
            values: ["default", "fast"],
          },
        ],
      },
    ],
    observedAt: "2026-11-20T10:00:00.000Z",
  });
}

function makeFakeGhCommand(options: {
  readonly baseBranch: string;
  readonly headSha: string;
  readonly diff: string;
}): GhCommandPort {
  return {
    run: async (args) => {
      const joined = args.join(" ");
      if (
        args[0] === "pr" &&
        args[1] === "view" &&
        args.includes("state,headRefName,baseRefName,headRefOid")
      ) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            state: "OPEN",
            headRefName: "feature/harden-auth",
            baseRefName: options.baseBranch,
            headRefOid: options.headSha,
          }),
        };
      }
      if (args[0] === "pr" && args[1] === "view") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            number: TARGET.number,
            url: `https://github.com/ogard-labs/octant/pull/${TARGET.number}`,
            title: "Harden auth gate",
            state: "OPEN",
            isDraft: false,
            body: "Tighten check.",
            baseRefName: options.baseBranch,
            headRefName: "feature/harden-auth",
            headRefOid: options.headSha,
            headRepositoryOwner: { login: "ogard-labs" },
            headRepository: { name: "octant" },
            author: { login: "henrik" },
            mergeable: "MERGEABLE",
            updatedAt: "2026-11-20T10:00:00.000Z",
            commits: [{ oid: options.headSha, messageHeadline: "Harden auth", authors: [] }],
            files: [],
            statusCheckRollup: [],
            reviews: [],
            comments: [],
          }),
        };
      }
      if (args[0] === "pr" && args[1] === "diff") {
        return { exitCode: 0, stdout: options.diff };
      }
      return { exitCode: 1, stdout: "", stderr: `unexpected gh call: ${joined}` };
    },
  };
}

function makeProductionHarness(options: {
  readonly localHeadSha: string;
  readonly localBaseBranch?: string;
  readonly localDiff?: string;
  readonly ghBaseBranch: string;
  readonly ghDiff: string;
  readonly replyText: string;
  readonly reportUsage?: boolean;
  readonly tickClockOnOperationFrame?: boolean;
}) {
  const dir = mkdtempSync(join(tmpdir(), "octant-pr-review-runtime-"));
  dirs.push(dir);
  let tickMs = Date.parse("2026-11-20T10:00:00.000Z");
  const clock = () => new Date(tickMs).toISOString();
  const advanceClock = (ms: number) => {
    tickMs += ms;
  };
  const db = openSqlite(join(dir, "octant.sqlite3"));
  applyMigrations(db, MIGRATIONS, clock);
  const registries = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection: db,
    registry: registries.events,
    projections: registries.projections,
    clock,
  });
  const turnMetrics = new TurnMetricsStore({
    journal,
    uuid: randomUUID,
    actor: { kind: "system", actorId: OCTANT_LOCAL_ACTOR_ID as never },
    clock,
  });

  const thread = makeThread(options.localBaseBranch ?? "main");
  const storedEvidence = new Map<string, string>();
  const framesByOperation = new Map<string, CodeOperationEventFrame[]>();
  const savedFindings = new Map<string, CodeReviewFinding>();
  let localReviewRunCalls = 0;

  const codeOperationService = new CodeOperationService({
    authority: {
      readThread: (id) => (String(id) === String(THREAD_ID) ? thread : undefined),
      readCheckout: (id) =>
        String(id) === String(CHECKOUT_ID)
          ? decodeCodeCheckoutIdentity({
              id: CHECKOUT_ID,
              repositoryId: REPO_ID,
              kind: "existing-worktree",
              availability: "available",
              head: { kind: "branch", name: "feature/harden-auth", oid: options.localHeadSha },
              observedAt: clock(),
            })
          : undefined,
      canAccessProject: async () => true,
      approvalContextDigest: async () => "a".repeat(64),
      resolveCheckoutRoot: async () => ({
        checkoutRoot: dir,
        workingDirectory: dir,
        shell: "/bin/zsh",
        credentialReferences: [],
        environment: {},
      }),
    },
    approvals: { validate: async () => true },
    terminals: {
      launch: async () => {
        throw new Error("unused");
      },
      attach: () => {
        throw new Error("unused");
      },
      write: async () => {
        throw new Error("unused");
      },
      resize: async () => {
        throw new Error("unused");
      },
      terminate: async () => {
        throw new Error("unused");
      },
    },
    repositoryTests: {
      discover: async () => [],
      run: async () => {
        throw new Error("unused");
      },
      cancel: async () => false,
    },
    git: {
      observe: async () => ({
        status: "ready",
        stateToken: "token-1",
        head: { kind: "branch", name: "feature/harden-auth", oid: options.localHeadSha },
        statusEntries: [],
        diff: "",
        diffTruncated: false,
      }),
      compareBranch: async ({ baseRef }) => {
        localReviewRunCalls += 1;
        return {
          status: "ready",
          head: options.localHeadSha,
          base: BASE_SHA,
          baseRef,
          ahead: 1,
          behind: 0,
          mergeability: "clean",
        };
      },
      readBranchDiff: async () => ({
        status: "ready",
        diff: options.localDiff ?? MAIN_DIFF,
        diffTruncated: false,
        paths: [decodeCodeRelativePath("src/auth.ts")],
      }),
      stage: async () => {
        throw new Error("unused");
      },
      unstage: async () => {
        throw new Error("unused");
      },
      discard: async () => {
        throw new Error("unused");
      },
      commit: async () => {
        throw new Error("unused");
      },
      push: async () => {
        throw new Error("unused");
      },
    },
    pullRequests: {
      ensure: async () => ({ status: "unavailable", code: "pr-observation-unavailable" }),
      observeReview: async () => ({ status: "unavailable" }),
    },
    reviewFindings: {
      create: async () => {
        throw new Error("unused");
      },
      changeState: async () => {
        throw new Error("unused");
      },
    },
    turns: {
      start: async () => ({ state: "running" }),
      answerInput: async () => ({ state: "failed" }),
      answerApproval: async () => ({ state: "failed" }),
      cancel: async () => ({ state: "interrupted" }),
    },
    evidence: {
      put: (content, meta) => {
        const contentId = randomUUID();
        storedEvidence.set(contentId, content);
        return decodeCodeEvidenceReference({
          contentId,
          digest: createHash("sha256").update(content).digest("hex"),
          byteLength: Buffer.byteLength(content),
          ...(meta?.truncated === true ? { truncated: true } : {}),
        });
      },
      read: async (reference) => storedEvidence.get(String(reference.contentId)),
    },
    events: {
      append: (entry) => {
        const key = `${String(entry.threadId)}:${String(entry.operationId)}`;
        const existing = framesByOperation.get(key) ?? [];
        const occurredAt = decodeUtcTimestamp(clock());
        const frame = decodeCodeOperationEventFrame({
          threadId: entry.threadId,
          operationId: entry.operationId,
          cursor: existing.length + 1,
          occurredAt,
          event: entry.event,
        });
        existing.push(frame);
        framesByOperation.set(key, existing);
        if (options.tickClockOnOperationFrame === true) {
          // Simulate wall clock advancing between operation persistence and finding creation.
          advanceClock(30_000);
        }
        return frame;
      },
      replay: ({ threadId, operationId, afterCursor, limit }) => {
        const key = `${String(threadId)}:${String(operationId)}`;
        const frames = (framesByOperation.get(key) ?? [])
          .filter((frame) => frame.cursor > afterCursor)
          .slice(0, limit);
        return { status: "ok", frames, nextCursor: frames.at(-1)?.cursor ?? afterCursor };
      },
      historyForThread: () => ({ status: "ok", frames: [] }),
      summaryForThread: () => ({ status: "ok", frames: [] }),
    },
  });

  // Real production ReviewFindingService: refuses unanchored fallback files (`resolve: () => undefined`)
  // and validates every anchored finding via `codeOperationService.resolveReviewTarget`.
  const reviewFindingService = new ReviewFindingService({
    persistence: {
      journal: {
        append: (input: Parameters<Journal["append"]>[0]) => {
          const batch = input as {
            readonly events: ReadonlyArray<{
              readonly payload?: { readonly finding?: CodeReviewFinding };
            }>;
          };
          const finding = batch.events[0]?.payload?.finding;
          if (finding !== undefined) {
            savedFindings.set(String(finding.id), finding);
          }
          return journal.append(input);
        },
      },
      readCodeThread: (id) => (String(id) === String(THREAD_ID) ? thread : undefined),
      readReviewFinding: (id) => savedFindings.get(String(id)),
      readReviewFindings: (id) =>
        [...savedFindings.values()].filter((finding) => String(finding.threadId) === String(id)),
    },
    access: { canAccessProject: async () => true },
    files: {
      resolve: () => undefined,
      resolveDiff: async (windowId, input) => {
        if (input.anchor === undefined || input.location.kind !== "line") return undefined;
        try {
          return await codeOperationService.resolveReviewTarget(windowId, {
            threadId: input.threadId,
            checkoutId: input.checkoutId,
            reviewOperationId: input.anchor.reviewOperationId,
            ...(input.anchor.revision.kind === "turn-capture"
              ? { captureCursor: input.anchor.revision.captureCursor }
              : {}),
            path: input.path,
            side: input.anchor.side,
            line: input.location.line,
          });
        } catch {
          return undefined;
        }
      },
    },
    uuid: randomUUID,
    clock,
  });

  const capturedStarts: Array<{
    readonly modelId: string;
    readonly modelOptionValues?: ProviderModelOptionValues;
  }> = [];
  const observedState = makeCodexObservedState();
  const codexModel: ProviderModel | undefined = observedState.models[0];
  if (codexModel === undefined) throw new Error("Expected Codex model in test fixture");
  const providerInstance = decodeProviderInstance({
    id: REVIEWER_PROVIDER_ID,
    displayName: "Codex Reviewer",
    driverKind: "codex",
    configuration: { kind: "codex-cli", binaryPath: "/usr/local/bin/codex" },
    environmentPolicy: "inherit-host",
    enabled: true,
    version: 1,
    createdAt: "2026-11-20T10:00:00.000Z",
    updatedAt: "2026-11-20T10:00:00.000Z",
  });

  // Build a real streaming driver that publishes via `connection.subscribe` once `send` runs.
  let activeSessionId: string | undefined;
  let queuedEvents: ProviderRuntimeEvent[] = [];
  let closed = false;
  let flushEvents: (() => void) | undefined;
  const streamingDriver: ProviderDriver = {
    kind: "codex",
    probe: () => Effect.succeed(observedState),
    acquire: () =>
      Effect.succeed({
        start: (input: {
          readonly sessionId: string;
          readonly modelId: string;
          readonly modelOptionValues?: ProviderModelOptionValues;
        }) =>
          Effect.sync(() => {
            activeSessionId = String(input.sessionId);
            queuedEvents = [];
            closed = false;
            capturedStarts.push({
              modelId: String(input.modelId),
              ...(input.modelOptionValues === undefined
                ? {}
                : { modelOptionValues: input.modelOptionValues }),
            });
          }),
        send: (input: { readonly sessionId: string }) =>
          Effect.sync(() => {
            activeSessionId = String(input.sessionId);
            const sessionId = activeSessionId as never;
            queuedEvents.push(
              { kind: "text-delta", sessionId, text: options.replyText } as never,
              ...(options.reportUsage === false
                ? []
                : [{ kind: "usage", sessionId, inputTokens: 800, outputTokens: 120 } as never]),
              { kind: "completed", sessionId } as never,
            );
            closed = true;
            flushEvents?.();
          }),
        stop: () => Effect.void,
        subscribe: Effect.succeed(
          Stream.async<ProviderRuntimeEvent>((emit) => {
            const flush = () => {
              for (const event of queuedEvents.splice(0)) {
                void emit.single(event);
              }
              if (closed) void emit.end();
            };
            flushEvents = flush;
            flush();
          }),
        ),
      } as never),
  };

  const ceilingEvents: string[] = [];
  const host = createPullRequestReviewHostRuntime({
    ghCommand: makeFakeGhCommand({
      baseBranch: options.ghBaseBranch,
      headSha: HEAD_SHA,
      diff: options.ghDiff,
    }),
    providerDataDirectory: dir,
    connection: db,
    journal,
    clock,
    readProviderInstances: () => [providerInstance],
    observedProviderState: (id) =>
      String(id) === String(REVIEWER_PROVIDER_ID) ? observedState : undefined,
    isProviderModelAllowed: () => true,
    createDriver: () => streamingDriver,
    executeOperation: (windowId, command) => codeOperationService.execute(windowId, command),
    readOperationEvidence: async (windowId, threadId, operationId, contentId) => {
      const read = await codeOperationService.readEvidence(
        windowId,
        threadId,
        operationId,
        contentId as never,
      );
      return { text: read.text };
    },
    resolveReviewTarget: (windowId, input, admissionCurrent) =>
      codeOperationService.resolveReviewTarget(windowId, input, admissionCurrent),
    retainPullRequestDiff: (windowId, input) =>
      codeOperationService.retainPullRequestDiff(windowId, input),
    createFinding: (input, actor) =>
      reviewFindingService.create(WINDOW_ID, input, undefined, actor),
    spendCeiling: {
      admit: () => {
        ceilingEvents.push("admit");
        return { status: "admitted" } as never;
      },
      settle: () => {
        ceilingEvents.push("settle");
      },
      abandon: () => {
        ceilingEvents.push("abandon");
      },
    },
    turnMetrics,
  });

  const registry = new PullRequestReviewerRegistry();
  registry.register({
    reviewerId: SECOND_MODEL_PULL_REQUEST_REVIEWER_ID,
    displayName: SECOND_MODEL_PULL_REQUEST_REVIEWER_DISPLAY_NAME,
    activation: () => ({ installed: true, trusted: true, enabled: true }),
    reviewer: createSecondModelPullRequestReviewer(),
  });

  const service = new PullRequestReviewService({
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
      isWorkerTurnActive: () => false,
      isStrict: () => false,
      maxStrictHandBackAttempts: () => 3,
      markOutsideContent: () => true,
      startWorkerTurn: async () => true,
    },
    runtime: host.runtime,
    uuid: randomUUID,
    clock,
  });

  const configureRoute = async (route: PullRequestReviewRoute) => {
    const updated = await service.updateProjectSettings(
      WINDOW_ID,
      {
        projectId: PROJECT_ID,
        enabled: true,
        reviewerId: SECOND_MODEL_PULL_REQUEST_REVIEWER_ID,
        route,
        postSummaryComment: false,
      },
      "local-window",
      LOCAL_ACTOR,
    );
    expect(updated.status).toBe("ok");
  };

  return {
    service,
    journal,
    savedFindings,
    framesByOperation,
    capturedStarts,
    codexModel,
    ceilingEvents,
    localReviewRunCalls: () => localReviewRunCalls,
    configureRoute,
  };
}

describe("pull request review host runtime integration with ReviewFindingService", () => {
  it("persists local review findings via ReviewFindingService even when the wall clock advances after review-run", async () => {
    const harness = makeProductionHarness({
      localHeadSha: HEAD_SHA,
      ghBaseBranch: "main",
      ghDiff: MAIN_DIFF,
      tickClockOnOperationFrame: true,
      replyText: JSON.stringify({
        findings: [
          {
            path: "src/auth.ts",
            line: 2,
            side: "modified",
            severity: "error",
            summary: "Guest role must not bypass owner authorization.",
          },
        ],
      }),
    });
    await harness.configureRoute({
      providerInstanceId: REVIEWER_PROVIDER_ID,
      modelId: CODEX_MODEL_ID,
      effort: "high",
    });

    const record = await harness.service.reviewPullRequestHead({
      target: TARGET,
      threadId: THREAD_ID,
      headSha: HEAD_SHA,
      baseRef: "main",
      baseSha: BASE_SHA,
      state: "open",
    });

    expect({ status: record?.status, detail: record?.detail }).toEqual({
      status: "completed",
      detail: undefined,
    });
    expect(record?.findingIds).toHaveLength(1);
    expect(harness.localReviewRunCalls()).toBe(1);
    const finding = [...harness.savedFindings.values()][0];
    expect(finding).toBeDefined();
    expect(finding?.author.kind).toBe("agent");
    expect(finding?.provenance.kind).toBe("pull-request-reviewer");
    expect(finding?.anchor?.kind).toBe("captured-diff");
    // Anchor capturedAt matches the persisted operation-result frame occurredAt,
    // NOT the +30s wall clock when the finding was later created.
    const frames = [...harness.framesByOperation.values()].flat();
    expect(finding?.anchor?.capturedAt).toBe(frames[0]?.occurredAt);
    expect(finding?.createdAt).not.toBe(finding?.anchor?.capturedAt);
  });

  it("retains the GitHub PR diff fallback so ReviewFindingService accepts anchored findings when local HEAD differs", async () => {
    const harness = makeProductionHarness({
      localHeadSha: OTHER_LOCAL_HEAD,
      ghBaseBranch: "main",
      ghDiff: MAIN_DIFF,
      replyText: JSON.stringify({
        findings: [
          {
            path: "src/auth.ts",
            line: 2,
            side: "modified",
            severity: "error",
            summary: "Fallback GitHub diff finding must persist with a verified anchor.",
          },
        ],
      }),
    });
    await harness.configureRoute({
      providerInstanceId: REVIEWER_PROVIDER_ID,
      modelId: CODEX_MODEL_ID,
    });

    const record = await harness.service.reviewPullRequestHead({
      target: TARGET,
      threadId: THREAD_ID,
      headSha: HEAD_SHA,
      baseRef: "main",
      state: "open",
    });

    expect({ status: record?.status, detail: record?.detail }).toEqual({
      status: "completed",
      detail: undefined,
    });
    expect(record?.findingIds).toHaveLength(1);
    const finding = [...harness.savedFindings.values()][0];
    expect(finding?.path).toBe("src/auth.ts");
    expect(finding?.anchor?.kind).toBe("captured-diff");
    expect(finding?.anchor?.revision.kind).toBe("branch");
    if (finding?.anchor?.revision.kind === "branch") {
      expect(finding.anchor.revision.head).toBe(HEAD_SHA);
      expect(finding.anchor.revision.baseRef).toBe("main");
    }
  });

  it("falls back to the retained GitHub PR diff when a PR is retargeted to another base branch with unchanged HEAD", async () => {
    const harness = makeProductionHarness({
      localHeadSha: HEAD_SHA,
      localBaseBranch: "main",
      localDiff: MAIN_DIFF,
      ghBaseBranch: "release",
      ghDiff: RELEASE_DIFF,
      replyText: JSON.stringify({
        findings: [
          {
            path: "src/releaseGuard.ts",
            line: 2,
            side: "modified",
            severity: "error",
            summary: "Release guard unconditionally returns true.",
          },
        ],
      }),
    });
    await harness.configureRoute({
      providerInstanceId: REVIEWER_PROVIDER_ID,
      modelId: CODEX_MODEL_ID,
    });

    const record = await harness.service.reviewPullRequestHead({
      target: TARGET,
      threadId: THREAD_ID,
      headSha: HEAD_SHA,
      baseRef: "release",
      state: "open",
    });

    expect({ status: record?.status, detail: record?.detail }).toEqual({
      status: "completed",
      detail: undefined,
    });
    // Local review-run against `main` must be skipped for a PR retargeted to `release`.
    expect(harness.localReviewRunCalls()).toBe(0);
    expect(record?.findingIds).toHaveLength(1);
    const finding = [...harness.savedFindings.values()][0];
    expect(finding?.path).toBe("src/releaseGuard.ts");
    expect(finding?.anchor?.revision.kind).toBe("branch");
    if (finding?.anchor?.revision.kind === "branch") {
      expect(finding.anchor.revision.baseRef).toBe("release");
    }
  });

  it("translates reviewer effort into Codex's declared reasoning catalog option and refuses unsupported effort values", async () => {
    const harness = makeProductionHarness({
      localHeadSha: HEAD_SHA,
      ghBaseBranch: "main",
      ghDiff: MAIN_DIFF,
      replyText: JSON.stringify({ findings: [] }),
    });
    await harness.configureRoute({
      providerInstanceId: REVIEWER_PROVIDER_ID,
      modelId: CODEX_MODEL_ID,
      effort: "high",
    });

    const record = await harness.service.reviewPullRequestHead({
      target: TARGET,
      threadId: THREAD_ID,
      headSha: HEAD_SHA,
      baseRef: "main",
      state: "open",
    });

    expect({ status: record?.status, detail: record?.detail }).toEqual({
      status: "completed",
      detail: undefined,
    });
    expect(harness.capturedStarts).toHaveLength(1);
    const startOptions = harness.capturedStarts[0]?.modelOptionValues;
    expect(startOptions).toEqual({ reasoning: "high" });
    // Prove the real Codex driver translates these options into `model_reasoning_effort`.
    expect(codexModelOptionSettings(harness.codexModel, startOptions ?? {})).toEqual({
      config: { model_reasoning_effort: "high" },
    });

    // Unsupported effort value must be refused rather than silently dropped.
    const unsupportedHarness = makeProductionHarness({
      localHeadSha: HEAD_SHA,
      ghBaseBranch: "main",
      ghDiff: MAIN_DIFF,
      replyText: JSON.stringify({ findings: [] }),
    });
    await unsupportedHarness.configureRoute({
      providerInstanceId: REVIEWER_PROVIDER_ID,
      modelId: CODEX_MODEL_ID,
      effort: "ultra",
    });
    const refused = await unsupportedHarness.service.reviewPullRequestHead({
      target: TARGET,
      threadId: THREAD_ID,
      headSha: HEAD_SHA,
      baseRef: "main",
      state: "open",
    });
    expect(refused?.status).toBe("refused");
    expect(refused?.reason).toBe("route-refused");
    expect(unsupportedHarness.capturedStarts).toHaveLength(0);
  });

  it("records an explicit unreported usage row in the journal when a completed review reports no usage", async () => {
    const harness = makeProductionHarness({
      localHeadSha: HEAD_SHA,
      ghBaseBranch: "main",
      ghDiff: MAIN_DIFF,
      replyText: JSON.stringify({ findings: [] }),
      reportUsage: false,
    });
    await harness.configureRoute({
      providerInstanceId: REVIEWER_PROVIDER_ID,
      modelId: CODEX_MODEL_ID,
    });

    const record = await harness.service.reviewPullRequestHead({
      target: TARGET,
      threadId: THREAD_ID,
      headSha: HEAD_SHA,
      baseRef: "main",
      state: "open",
    });

    expect({ status: record?.status, detail: record?.detail }).toEqual({
      status: "completed",
      detail: undefined,
    });
    expect(harness.ceilingEvents).toEqual(["admit", "settle"]);
    const usageEvents = harness.journal.replayAggregateType({
      aggregateType: PULL_REQUEST_REVIEW_USAGE_AGGREGATE_TYPE,
      afterSequence: 0,
      limit: 100,
    });
    expect(usageEvents).toHaveLength(1);
    const reconciliation = (
      usageEvents[0]?.payload as {
        readonly reconciliation?: { readonly providerReported?: boolean };
      }
    )?.reconciliation;
    expect(reconciliation?.providerReported).toBe(false);
  });
});
