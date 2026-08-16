import { describe, expect, it } from "vitest";
import {
  CODE_OPERATION_COMMAND_KINDS,
  decodeCodeConversationPage,
  decodeCodeOperationCommand,
  decodeCodeOperationEventFrame,
  decodeCodeOperationApprovalReceipt,
  decodeCodeOperationApprovalRequest,
  decodeCodeOperationResult,
  decodeCodeReviewFinding,
  decodeCodeReviewFindingUpdated,
  decodeCodeThreadOperationalMetadata,
  decodeCodeThreadOperationalMetadataView,
  decodeCodeBoardStatus,
  decodeCodeBoardQuery,
  decodeCodeBoardCard,
  decodeCodeBoardView,
  decodeCodeFileOpenResultEnvelope,
  decodeCodeFollowUpCommand,
  decodeCodeThreadFollowUp,
  decodeCodeThreadFollowUpUpdated,
  decodeCodeThreadFollowUpView,
  decodeCodeTerminalInspection,
  decodeCodeTerminalInspectionRequest,
} from "./codeOperations";
import { MAX_THREAD_MENTIONS_PER_TURN } from "./threadMentionIdentity";

const ids = {
  operation: "10000000-0000-4000-8000-000000000001",
  resourceOperation: "10000000-0000-4000-8000-000000000002",
  thread: "20000000-0000-4000-8000-000000000001",
  checkout: "30000000-0000-4000-8000-000000000001",
  terminal: "40000000-0000-4000-8000-000000000001",
  testRun: "50000000-0000-4000-8000-000000000001",
  git: "60000000-0000-4000-8000-000000000001",
  finding: "70000000-0000-4000-8000-000000000001",
  content: "80000000-0000-4000-8000-000000000001",
  providerInstance: "90000000-0000-4000-8000-000000000001",
  providerSession: "a0000000-0000-4000-8000-000000000001",
  definition: "b0000000-0000-4000-8000-000000000001",
  approval: "c0000000-0000-4000-8000-000000000001",
} as const;

const scope = {
  operationId: ids.operation,
  threadId: ids.thread,
  checkoutId: ids.checkout,
} as const;

const definition = {
  id: ids.definition,
  name: "Unit tests",
  source: {
    kind: "package-script",
    packagePath: "package.json",
    packageManager: "bun",
    script: "test:unit",
  },
  argv: ["bun", "run", "test:unit"],
  cwd: ".",
  environmentRefs: ["TEST_DATABASE_URL"],
  timeoutMs: 60_000,
  artifactPaths: [],
} as const;

describe("Code operation contracts", () => {
  it("strictly decodes a non-mutating terminal inspection request and result", () => {
    const request = {
      threadId: ids.thread,
      checkoutId: ids.checkout,
      terminalId: ids.terminal,
    } as const;
    expect(decodeCodeTerminalInspectionRequest(request)).toEqual(request);
    expect(decodeCodeTerminalInspection({ terminalId: ids.terminal, state: "running" })).toEqual({
      terminalId: ids.terminal,
      state: "running",
    });
    expect(() =>
      decodeCodeTerminalInspectionRequest({ ...request, operationId: ids.operation }),
    ).toThrow();
    expect(() =>
      decodeCodeTerminalInspection({ terminalId: ids.terminal, state: "missing" }),
    ).toThrow();
  });

  it("strictly decodes a host-issued operation approval request and receipt", () => {
    const request = {
      effect: {
        kind: "operation",
        command: {
          kind: "start-terminal",
          ...scope,
          terminalId: ids.terminal,
          columns: 120,
          rows: 40,
          credentialRefs: [],
        },
      },
    } as const;
    expect(decodeCodeOperationApprovalRequest(request)).toEqual(request);
    expect(decodeCodeOperationApprovalReceipt({ approvalId: ids.approval })).toEqual({
      approvalId: ids.approval,
    });
    expect(() => decodeCodeOperationApprovalRequest({ ...request, summary: "spoofed" })).toThrow();
    expect(() =>
      decodeCodeOperationApprovalRequest({
        effect: { kind: "operation", command: { kind: "observe-git", ...scope } },
      }),
    ).toThrow();
  });

  it("decodes a core Apple action as a bounded one-shot approval effect", () => {
    const request = decodeCodeOperationApprovalRequest({
      effect: {
        kind: "apple-action",
        request: {
          actionId: "d0000000-0000-4000-8000-000000000001",
          correlationId: "d0000000-0000-4000-8000-000000000002",
          authority: {
            hostId: "d0000000-0000-4000-8000-000000000003",
            mode: "code",
            projectId: "d0000000-0000-4000-8000-000000000004",
            providerInstanceId: "d0000000-0000-4000-8000-000000000005",
            extension: { kind: "core" },
          },
          threadId: "d0000000-0000-4000-8000-000000000006",
          checkoutId: "d0000000-0000-4000-8000-000000000007",
          kind: "build",
          platform: "ios",
          scheme: "Fixture",
          simulatorId: "d0000000-0000-4000-8000-000000000008",
          projectPath: "Fixture.xcodeproj",
          timeoutMs: 120000,
          approval: {
            kind: "approved",
            approvalId: "d0000000-0000-4000-8000-000000000009",
          },
        },
      },
    });
    expect(request.effect.kind).toBe("apple-action");
  });

  it("decodes the complete closed command surface", () => {
    const commands = [
      {
        kind: "start-terminal",
        ...scope,
        terminalId: ids.terminal,
        columns: 120,
        rows: 40,
        credentialRefs: ["GITHUB_TOKEN"],
      },
      { kind: "attach-terminal", ...scope, terminalId: ids.terminal },
      { kind: "write-terminal", ...scope, terminalId: ids.terminal, data: "bun test\n" },
      { kind: "resize-terminal", ...scope, terminalId: ids.terminal, columns: 140, rows: 44 },
      { kind: "stop-terminal", ...scope, terminalId: ids.terminal },
      { kind: "run-repository-test", ...scope, testRunId: ids.testRun, definition },
      { kind: "cancel-repository-test", ...scope, testRunId: ids.testRun },
      { kind: "observe-git", ...scope, gitOperationId: ids.git, maxDiffBytes: 262_144 },
      {
        kind: "stage-git",
        ...scope,
        gitOperationId: ids.git,
        paths: ["src/index.ts"],
        expectedStateToken: "a".repeat(64),
      },
      {
        kind: "commit-git",
        ...scope,
        gitOperationId: ids.git,
        message: "Implement operation contracts",
        stagedSummary: [{ path: "src/index.ts", index: "M", worktree: " " }],
        expectedStateToken: "a".repeat(64),
      },
      {
        kind: "push-git",
        ...scope,
        gitOperationId: ids.git,
        remote: "origin",
        localRef: "refs/heads/feature/contracts",
        remoteRef: "refs/heads/feature/contracts",
        expectedHeadOid: "b".repeat(40),
        expectedStateToken: "a".repeat(64),
        confirmation: {
          remote: "origin",
          refspec: "refs/heads/feature/contracts:refs/heads/feature/contracts",
        },
        authorization: { kind: "approved", approvalId: ids.approval },
      },
      {
        kind: "create-pull-request",
        ...scope,
        title: "Add operation contracts",
        body: "Strict provider-neutral operation schemas.",
        idempotencyKey: "pr-create-001",
        authorization: { kind: "full-access" },
      },
      { kind: "observe-pull-request", ...scope, maxDiffBytes: 262_144 },
      {
        kind: "merge-pull-request",
        ...scope,
        idempotencyKey: "pr-merge-001",
        expectedHeadSha: "c".repeat(40),
        mergeMethod: "squash",
        confirmation: {
          number: 42,
          baseRepository: "octocat/octant",
          baseBranch: "development",
          headBranch: "feature/contracts",
          mergeMethod: "squash",
          expectedHeadSha: "c".repeat(40),
        },
        authorization: { kind: "approved", approvalId: ids.approval },
      },
      {
        kind: "create-review-finding",
        ...scope,
        findingId: ids.finding,
        fileId: "d0000000-0000-4000-8000-000000000001",
        path: "src/index.ts",
        fileDigest: "d".repeat(64),
        location: { kind: "selection", startLine: 4, startColumn: 1, endLine: 4, endColumn: 12 },
        severity: "warning",
        summary: "Keep this boundary strict.",
      },
      {
        kind: "update-review-finding",
        ...scope,
        findingId: ids.finding,
        expectedVersion: 1,
        state: "resolved",
      },
      {
        kind: "start-provider-turn",
        ...scope,
        sessionId: ids.providerSession,
        prompt: { contentId: ids.content, digest: "d".repeat(64), byteLength: 42 },
      },
      {
        kind: "answer-provider-input",
        ...scope,
        requestId: "question-1",
        response: { contentId: ids.content, digest: "d".repeat(64), byteLength: 42 },
      },
      {
        kind: "answer-provider-approval",
        ...scope,
        approvalId: ids.approval,
        decision: "approved",
      },
      { kind: "cancel-provider-turn", ...scope },
    ] as const;

    expect(commands.map((command) => decodeCodeOperationCommand(command))).toEqual(commands);
    expect(commands.map((command) => command.kind)).toEqual(CODE_OPERATION_COMMAND_KINDS);
  });

  it("rejects authority escape hatches, secrets, absolute paths, and unbounded payloads", () => {
    const validStage = {
      kind: "stage-git",
      ...scope,
      gitOperationId: ids.git,
      paths: ["src/index.ts"],
      expectedStateToken: "a".repeat(64),
    };
    for (const invalid of [
      { ...validStage, paths: ["/private/repository/secret.ts"] },
      { ...validStage, paths: ["."] },
      { ...validStage, paths: ["--all"] },
      { ...validStage, force: true },
      {
        kind: "merge-pull-request",
        ...scope,
        idempotencyKey: "pr-merge-bad",
        expectedHeadSha: "c".repeat(40),
        mergeMethod: "squash",
        confirmation: {
          number: 42,
          baseRepository: "octocat/octant",
          baseBranch: "development",
          headBranch: "feature/contracts",
          mergeMethod: "merge",
          expectedHeadSha: "c".repeat(40),
        },
        authorization: { kind: "full-access" },
      },
      {
        kind: "replay-code-operation",
        operationId: ids.operation,
        threadId: ids.thread,
        resourceOperationId: ids.resourceOperation,
        afterCursor: 4,
        limit: 100,
      },
      {
        kind: "start-terminal",
        ...scope,
        terminalId: ids.terminal,
        columns: 80,
        rows: 24,
        credentialRefs: [],
        environment: { TOKEN: "secret" },
      },
      {
        kind: "start-provider-turn",
        ...scope,
        providerInstanceId: ids.providerInstance,
        modelId: "provider/model",
        sessionId: ids.providerSession,
        prompt: { contentId: ids.content, digest: "d".repeat(64), byteLength: 42 },
        executionPolicy: "approval-gated",
        permissionPersistence: "current-session",
        driverKind: "codex",
        providerPayload: { token: "secret" },
      },
      {
        kind: "create-pull-request",
        ...scope,
        title: "PR",
        body: "body",
        idempotencyKey: "pr-1",
        authorization: { kind: "full-access" },
        headRemote: "evil",
        headBranch: "evil",
        baseRepository: "other/repo",
        baseBranch: "main",
      },
      {
        kind: "create-review-finding",
        ...scope,
        findingId: ids.finding,
        fileId: "d0000000-0000-4000-8000-000000000001",
        path: "src/index.ts",
        fileDigest: "d".repeat(64),
        location: { kind: "line", line: 1 },
        severity: "warning",
        summary: "Finding",
        author: {
          kind: "agent",
          providerInstanceId: ids.providerInstance,
          sessionId: "session-1",
        },
        provenance: { kind: "provider", sourceId: ids.operation },
      },
      { kind: "update-review-finding", ...scope, findingId: ids.finding, state: "resolved" },
      { kind: "write-terminal", ...scope, terminalId: ids.terminal, data: "x".repeat(65_537) },
    ])
      expect(() => decodeCodeOperationCommand(invalid)).toThrow();
  });

  it("carries a Code turn's `#thread` mentions as ids the host resolves itself", () => {
    const turn = {
      kind: "start-provider-turn",
      ...scope,
      sessionId: ids.providerSession,
      prompt: { contentId: ids.content, digest: "d".repeat(64), byteLength: 42 },
    } as const;

    // A `#thread` mention travels as the id of a thread the server re-checks
    // at turn time, never as transcript text the browser resolved.
    expect(decodeCodeOperationCommand({ ...turn, threadMentionIds: [ids.thread] })).toMatchObject({
      threadMentionIds: [ids.thread],
    });

    expect(() =>
      decodeCodeOperationCommand({
        ...turn,
        threadMentionIds: Array.from(
          { length: MAX_THREAD_MENTIONS_PER_TURN + 1 },
          () => ids.thread,
        ),
      }),
    ).toThrow();
  });

  it("decodes typed results without exposing checkout paths or raw process output", () => {
    const observation = {
      kind: "git-observed",
      operationId: ids.operation,
      gitOperationId: ids.git,
      head: { kind: "branch", name: "feature/contracts", oid: "b".repeat(40) },
      stateToken: "a".repeat(64),
      status: [{ path: "src/index.ts", index: "M", worktree: " " }],
      changedPaths: ["src/index.ts"],
      diff: { contentId: ids.content, digest: "d".repeat(64), byteLength: 2048, truncated: false },
      remotes: [
        {
          name: "origin",
          fetch: {
            kind: "network",
            url: "https://github.com/octant/octant.git",
          },
          push: {
            kind: "network",
            url: "ssh://git@github.com/octant/octant.git",
          },
        },
      ],
      upstream: { remote: "origin", mergeRef: "refs/heads/feature/contracts" },
      worktrees: [
        {
          checkoutId: ids.checkout,
          head: { kind: "branch", name: "feature/contracts", oid: "b".repeat(40) },
          state: "active",
        },
      ],
    } as const;

    expect(decodeCodeOperationResult(observation)).toEqual(observation);
    expect(
      decodeCodeOperationResult({
        ...observation,
        remotes: [{ name: "local", fetch: { kind: "local" }, push: { kind: "local" } }],
      }),
    ).toMatchObject({ remotes: [{ name: "local", fetch: { kind: "local" } }] });
    expect(() =>
      decodeCodeOperationResult({ ...observation, checkoutRoot: "/private/repository" }),
    ).toThrow();
    expect(() =>
      decodeCodeOperationResult({
        kind: "terminal-state",
        operationId: ids.operation,
        terminalId: ids.terminal,
        state: "running",
        output: "raw output",
      }),
    ).toThrow();
    expect(() =>
      decodeCodeOperationResult({
        ...observation,
        diff: { ...observation.diff, byteLength: 64 * 1024 * 1024 + 1 },
      }),
    ).toThrow();
    expect(() =>
      decodeCodeOperationResult({
        ...observation,
        head: { kind: "branch", name: "x".repeat(256), oid: "b".repeat(40) },
      }),
    ).toThrow();
    expect(() =>
      decodeCodeOperationResult({
        kind: "operation-failed",
        operationId: ids.operation,
        failure: { category: "failed", message: "x".repeat(8_193) },
      }),
    ).toThrow();
  });

  it("enforces state-specific terminal, test, and pull-request results", () => {
    const terminal = {
      kind: "terminal-state",
      operationId: ids.operation,
      terminalId: ids.terminal,
    } as const;
    expect(decodeCodeOperationResult({ ...terminal, state: "running" })).toEqual({
      ...terminal,
      state: "running",
    });
    expect(decodeCodeOperationResult({ ...terminal, state: "exited", exitCode: 0 })).toEqual({
      ...terminal,
      state: "exited",
      exitCode: 0,
    });
    expect(decodeCodeOperationResult({ ...terminal, state: "exited", exitCode: null })).toEqual({
      ...terminal,
      state: "exited",
      exitCode: null,
    });
    expect(() =>
      decodeCodeOperationResult({ ...terminal, state: "running", exitCode: 0 }),
    ).toThrow();
    expect(() => decodeCodeOperationResult({ ...terminal, state: "exited" })).toThrow();

    const test = {
      kind: "repository-test-state",
      operationId: ids.operation,
      testRunId: ids.testRun,
      concerns: [],
    } as const;
    expect(
      decodeCodeOperationResult({ ...test, state: "completed", verdict: "passed" }),
    ).toMatchObject({ state: "completed", verdict: "passed" });
    expect(() => decodeCodeOperationResult({ ...test, state: "completed" })).toThrow();
    expect(() =>
      decodeCodeOperationResult({ ...test, state: "running", verdict: "passed" }),
    ).toThrow();

    const pullRequestIdentity = {
      number: 42,
      url: "https://github.com/octant/octant/pull/42",
      headRepository: "octocat/octant",
      headBranch: "feature/contracts",
      baseRepository: "octant/octant",
      baseBranch: "development",
    } as const;
    expect(
      decodeCodeOperationResult({
        kind: "pull-request-state",
        operationId: ids.operation,
        state: "created",
        ...pullRequestIdentity,
      }),
    ).toMatchObject({ state: "created", number: 42 });
    expect(() =>
      decodeCodeOperationResult({
        kind: "pull-request-state",
        operationId: ids.operation,
        state: "created",
      }),
    ).toThrow();
    expect(() =>
      decodeCodeOperationResult({
        kind: "pull-request-state",
        operationId: ids.operation,
        state: "unavailable",
        ...pullRequestIdentity,
      }),
    ).toThrow();

    const evidence = { contentId: ids.content, digest: "d".repeat(64), byteLength: 42 } as const;
    const observedReview = {
      kind: "pull-request-review",
      operationId: ids.operation,
      state: "observed",
      freshness: "stale",
      ambiguous: true,
      staleSections: ["checks", "reviews"],
      number: 182,
      url: "https://github.com/octant/octant/pull/182",
      title: "Deliver Code panes",
      pullRequestState: "open",
      baseRepository: "octant/octant",
      baseBranch: "development",
      headRepository: "octocat",
      headBranch: "feature/delivery",
      author: "octocat",
      matchesDeliveryBranch: true,
      description: evidence,
      diff: evidence,
      commits: [{ oid: "a".repeat(40), messageHeadline: "feat: deliver", author: "octocat" }],
      files: [{ path: "apps/web/src/code/CodePullRequestPane.tsx", additions: 12, deletions: 3 }],
      checks: [{ name: "web tests", state: "pending" }],
      reviews: [{ author: "reviewer", state: "changes-requested", body: "Tighten the guardrail." }],
      comments: [{ author: "octocat", body: "Ready for review." }],
    } as const;
    expect(decodeCodeOperationResult(observedReview)).toMatchObject({
      kind: "pull-request-review",
      state: "observed",
      ambiguous: true,
      staleSections: ["checks", "reviews"],
    });
    expect(
      decodeCodeOperationResult({
        kind: "pull-request-review",
        operationId: ids.operation,
        state: "none",
        freshness: "fresh",
      }),
    ).toMatchObject({ state: "none" });
    expect(() =>
      decodeCodeOperationResult({ ...observedReview, staleSections: ["checks", "checks"] }),
    ).toThrow();
  });

  it("uses monotonically increasing resource cursors and opaque evidence in events", () => {
    const frame = {
      threadId: ids.thread,
      operationId: ids.operation,
      cursor: 5,
      occurredAt: "2026-07-21T12:00:00.000Z",
      event: {
        kind: "provider-content",
        channel: "reasoning",
        content: { contentId: ids.content, digest: "d".repeat(64), byteLength: 123 },
      },
    } as const;
    expect(decodeCodeOperationEventFrame(frame)).toEqual(frame);
    expect(() => decodeCodeOperationEventFrame({ ...frame, cursor: 0 })).toThrow();
    expect(() =>
      decodeCodeOperationEventFrame({ ...frame, event: { ...frame.event, text: "raw reasoning" } }),
    ).toThrow();
    expect(
      decodeCodeOperationEventFrame({
        ...frame,
        event: { kind: "terminal-output", terminalId: ids.terminal, content: frame.event.content },
      }).event,
    ).toMatchObject({ kind: "terminal-output", replace: false });
    expect(
      decodeCodeOperationEventFrame({
        ...frame,
        event: {
          kind: "terminal-state-changed",
          terminalId: ids.terminal,
          state: "exited",
          exitCode: 0,
        },
      }).event,
    ).toMatchObject({ kind: "terminal-state-changed", state: "exited", exitCode: 0 });
  });

  it("decodes a versioned conversation page without raw provider payloads", () => {
    const prompt = { contentId: ids.content, digest: "d".repeat(64), byteLength: 42 };
    const started = {
      threadId: ids.thread,
      operationId: ids.operation,
      cursor: 1,
      occurredAt: "2026-07-21T12:00:00.000Z",
      event: {
        kind: "conversation-turn-started",
        providerInstanceId: ids.providerInstance,
        modelId: "model-one",
        sessionId: ids.providerSession,
        prompt,
      },
    } as const;
    expect(decodeCodeOperationEventFrame(started)).toEqual(started);

    const page = {
      version: 2,
      threadId: ids.thread,
      turns: [
        {
          operationId: ids.operation,
          providerInstanceId: ids.providerInstance,
          modelId: "model-one",
          sessionId: ids.providerSession,
          prompt,
          assistant: [prompt],
          status: "completed",
          startedAt: "2026-07-21T12:00:00.000Z",
          updatedAt: "2026-07-21T12:01:00.000Z",
        },
      ],
      nextCursor: 81,
      hasMore: false,
    } as const;
    expect(decodeCodeConversationPage(page)).toEqual(page);
    expect(() =>
      decodeCodeConversationPage({ ...page, turns: [{ ...page.turns[0], providerPayload: {} }] }),
    ).toThrow();
    // A page is read at exactly the version this build knows. Version 1 had no
    // attachments, so accepting one would render a turn while dropping the
    // images the user attached to it.
    expect(() => decodeCodeConversationPage({ ...page, version: 1 })).toThrow();
    expect(() => decodeCodeConversationPage({ ...page, version: 3 })).toThrow();
  });

  it("owns the strict durable review-finding entity and journal event", () => {
    const finding = {
      id: ids.finding,
      threadId: ids.thread,
      checkoutId: ids.checkout,
      fileId: "d0000000-0000-4000-8000-000000000001",
      path: "src/index.ts",
      fileDigest: "d".repeat(64),
      location: {
        kind: "selection",
        startLine: 4,
        startColumn: 1,
        endLine: 4,
        endColumn: 12,
      },
      severity: "warning",
      author: { kind: "agent", providerInstanceId: ids.providerInstance, sessionId: "session-1" },
      provenance: { kind: "provider", sourceId: ids.operation },
      summary: "Keep this boundary strict.",
      state: "open",
      version: 1,
      createdAt: "2026-07-21T12:00:00.000Z",
      updatedAt: "2026-07-21T12:00:00.000Z",
    } as const;

    expect(decodeCodeReviewFinding(finding)).toEqual(finding);
    expect(decodeCodeReviewFindingUpdated({ kind: "review-finding-updated", finding })).toEqual({
      kind: "review-finding-updated",
      finding,
    });
    expect(() =>
      decodeCodeReviewFinding({ ...finding, path: "/private/repository/file" }),
    ).toThrow();
    expect(() =>
      decodeCodeReviewFinding({
        ...finding,
        author: { ...finding.author, token: "secret" },
      }),
    ).toThrow();
  });

  it("strictly decodes the journal-rebuildable thread operational metadata view", () => {
    const metadata = {
      threadId: ids.thread,
      checkoutId: ids.checkout,
      outcomeKind: "opened-pr",
      worktree: {
        kind: "available",
        checkoutId: ids.checkout,
        path: "/home/ubuntu/wt/thread",
        head: { kind: "branch", name: "feature/x", oid: "a".repeat(40) },
      },
      changedFiles: {
        kind: "observed",
        freshness: "fresh",
        changedPathCount: 2,
        stagedCount: 1,
        committedAhead: 3,
        workingTreeClean: false,
      },
      linkedPullRequest: {
        kind: "linked",
        freshness: "stale",
        number: 42,
        url: "https://github.com/acme/repo/pull/42",
        baseRepository: "acme/repo",
        baseBranch: "development",
        headBranch: "feature/x",
        state: "open",
        matchesDeliveryBranch: true,
      },
      checks: { freshness: "stale", state: "unknown" },
      reviewState: { freshness: "stale", state: "unknown" },
      childAgents: {
        active: 1,
        completed: 2,
        failed: 0,
        unacknowledgedResults: 0,
        latestSummary: "Refactoring parser",
        latestActivityAt: "2026-07-21T12:05:00.000Z",
      },
      lastMeaningfulActivityAt: "2026-07-21T12:05:00.000Z",
      githubFreshness: "stale",
      deliverySatisfaction: "waiting",
      recovery: {
        kind: "recovering",
        reasons: ["project-projection-missing"],
      },
      rebuiltFromJournal: true,
    } as const;

    expect(decodeCodeThreadOperationalMetadata(metadata)).toEqual(metadata);

    const view = {
      version: 1,
      threads: [
        metadata,
        {
          ...metadata,
          threadId: ids.resourceOperation,
          worktree: { kind: "unavailable", checkoutId: ids.checkout },
          changedFiles: { kind: "unavailable" },
          linkedPullRequest: { kind: "none", freshness: "fresh" },
          checks: { freshness: "fresh", state: "passing" },
          reviewState: { freshness: "fresh", state: "approved" },
          childAgents: { active: 0, completed: 0, failed: 0, unacknowledgedResults: 0 },
          lastMeaningfulActivityAt: null,
          githubFreshness: "fresh",
          deliverySatisfaction: "pending",
          recovery: { kind: "ok" },
          rebuiltFromJournal: false,
        },
      ],
    } as const;
    expect(decodeCodeThreadOperationalMetadataView(view)).toEqual(view);

    // Duplicate thread ids are rejected.
    expect(() =>
      decodeCodeThreadOperationalMetadataView({ ...view, threads: [metadata, metadata] }),
    ).toThrow();
    // Stale must be a known freshness literal.
    expect(() =>
      decodeCodeThreadOperationalMetadata({ ...metadata, githubFreshness: "unknown" }),
    ).toThrow();
    // Recovery reasons must be non-empty and unique.
    expect(() =>
      decodeCodeThreadOperationalMetadata({
        ...metadata,
        recovery: { kind: "recovering", reasons: [] },
      }),
    ).toThrow();
    expect(() =>
      decodeCodeThreadOperationalMetadata({
        ...metadata,
        recovery: {
          kind: "recovering",
          reasons: ["project-projection-missing", "project-projection-missing"],
        },
      }),
    ).toThrow();
    // Excess properties are rejected.
    expect(() => decodeCodeThreadOperationalMetadata({ ...metadata, unexpected: true })).toThrow();
  });
});

const boardIds = {
  thread: "20000000-0000-4000-8000-0000000000a1",
  other: "20000000-0000-4000-8000-0000000000a2",
  project: "20000000-0000-4000-8000-0000000000a3",
  checkout: "20000000-0000-4000-8000-0000000000a4",
  provider: "20000000-0000-4000-8000-0000000000a5",
} as const;

function boardCard(overrides: Record<string, unknown> = {}) {
  return {
    threadId: boardIds.thread,
    projectId: boardIds.project,
    checkoutId: boardIds.checkout,
    title: "Board thread",
    status: "waiting",
    outcomeKind: "opened-pr",
    deliverySatisfaction: "waiting",
    providerInstanceId: boardIds.provider,
    modelId: "model-a",
    executing: false,
    worktree: {
      kind: "available",
      checkoutId: boardIds.checkout,
      path: "/home/ubuntu/wt/thread",
      head: { kind: "branch", name: "feature/x", oid: "a".repeat(40) },
    },
    changedFiles: { kind: "unavailable" },
    linkedPullRequest: { kind: "none", freshness: "fresh" },
    checks: { freshness: "fresh", state: "unknown" },
    reviewState: { freshness: "fresh", state: "unknown" },
    childAgents: { active: 0, completed: 0, failed: 0, unacknowledgedResults: 0 },
    recovery: { kind: "ok" },
    githubFreshness: "fresh",
    unread: false,
    followUp: false,
    lastMeaningfulActivityAt: null,
    ...overrides,
  } as const;
}

describe("Code file open contracts", () => {
  const fileId = "e0000000-0000-4000-8000-000000000001";
  const metadata = {
    identity: { device: "16777234", inode: "123456" },
    byteLength: 7,
    modifiedNanoseconds: "123000000000",
    digest: "d".repeat(64),
  };

  it("decodes every strict open result variant with the resolved file identity", () => {
    for (const result of [
      {
        status: "editable",
        fileId,
        metadata,
        content: { contentId: ids.content, digest: "e".repeat(64), byteLength: 7 },
      },
      { status: "read-only", fileId, metadata, reason: "oversized" },
      { status: "interrupted", fileId, rescanRequired: true },
      { status: "failed", fileId, failure: { category: "unavailable", code: "helper-failed" } },
    ] as const) {
      expect(decodeCodeFileOpenResultEnvelope({ kind: "code-file-open-result", result })).toEqual({
        kind: "code-file-open-result",
        result,
      });
    }
  });

  it("rejects excess fields, private paths, and unknown read-only reasons", () => {
    expect(() =>
      decodeCodeFileOpenResultEnvelope({
        kind: "code-file-open-result",
        result: { status: "read-only", fileId, metadata, reason: "too-large" },
      }),
    ).toThrow();
    expect(() =>
      decodeCodeFileOpenResultEnvelope({
        kind: "code-file-open-result",
        result: {
          status: "editable",
          fileId,
          metadata,
          content: { contentId: ids.content, digest: "e".repeat(64), byteLength: 7 },
          rootPath: "/private/repo",
        },
      }),
    ).toThrow();
  });
});

describe("Code board contracts", () => {
  it("decodes the four board statuses and rejects unknown ones", () => {
    for (const status of ["ready", "in-progress", "waiting", "done"] as const) {
      expect(decodeCodeBoardStatus(status)).toBe(status);
    }
    expect(() => decodeCodeBoardStatus("blocked")).toThrow();
  });

  it("decodes a minimal default query (all statuses implied) and a fully specified query", () => {
    expect(decodeCodeBoardQuery({ version: 1 })).toEqual({ version: 1 });

    const full = {
      version: 1,
      text: "parser",
      statuses: ["ready", "in-progress", "waiting", "done"],
      projectIds: [boardIds.project],
      providerInstanceIds: [boardIds.provider],
      deliveryTargets: ["opened-pr", "merged-pr"],
      pullRequest: "open",
      checks: "passing",
      followUp: "only",
    } as const;
    expect(decodeCodeBoardQuery(full)).toEqual(full);
  });

  it("rejects duplicate or unknown query filter values and excess properties", () => {
    expect(() => decodeCodeBoardQuery({ version: 1, statuses: ["ready", "ready"] })).toThrow();
    expect(() => decodeCodeBoardQuery({ version: 1, statuses: ["blocked"] })).toThrow();
    expect(() => decodeCodeBoardQuery({ version: 1, pullRequest: "reopened" })).toThrow();
    expect(() => decodeCodeBoardQuery({ version: 1, checks: "green" })).toThrow();
    expect(() => decodeCodeBoardQuery({ version: 1, followUp: "maybe" })).toThrow();
    expect(() => decodeCodeBoardQuery({ version: 1, unexpected: true })).toThrow();
  });

  it("strictly decodes a board card composed of runtime-derived metadata", () => {
    const card = boardCard({
      status: "done",
      deliverySatisfaction: "done",
      blockingReason: "Waiting on CI",
      unread: true,
      followUp: true,
      lastMeaningfulActivityAt: "2026-07-21T12:05:00.000Z",
    });
    expect(decodeCodeBoardCard(card)).toEqual(card);

    // Status must be a known board status.
    expect(() => decodeCodeBoardCard({ ...boardCard(), status: "blocked" })).toThrow();
    // Excess properties are rejected.
    expect(() => decodeCodeBoardCard({ ...boardCard(), extra: 1 })).toThrow();
  });

  it("strictly decodes a board view and rejects duplicate cards", () => {
    const view = {
      version: 1,
      query: { version: 1, statuses: ["ready", "in-progress", "waiting", "done"] },
      cards: [boardCard(), boardCard({ threadId: boardIds.other })],
      generatedAt: "2026-07-21T12:05:00.000Z",
    } as const;
    expect(decodeCodeBoardView(view)).toEqual(view);

    expect(() => decodeCodeBoardView({ ...view, cards: [boardCard(), boardCard()] })).toThrow();
  });
});

describe("Code thread follow-up contracts", () => {
  const openFollowUp = {
    threadId: ids.thread,
    state: "open",
    origin: "automatic",
    reason: "Approval requested: git-push",
    triggerSequence: 7,
    acknowledgedThroughSequence: 0,
    createdAt: "2026-07-21T12:05:00.000Z",
  } as const;

  it("strictly decodes an open and a completed follow-up marker", () => {
    expect(decodeCodeThreadFollowUp(openFollowUp)).toEqual(openFollowUp);

    const completed = {
      ...openFollowUp,
      state: "completed",
      acknowledgedThroughSequence: 7,
      completedAt: "2026-07-21T12:10:00.000Z",
    } as const;
    expect(decodeCodeThreadFollowUp(completed)).toEqual(completed);

    // Reason cannot be empty; excess properties are rejected.
    expect(() => decodeCodeThreadFollowUp({ ...openFollowUp, reason: "  " })).toThrow();
    expect(() => decodeCodeThreadFollowUp({ ...openFollowUp, extra: 1 })).toThrow();
  });

  it("decodes manual and automatic open commands and completion commands", () => {
    const open = {
      kind: "open-code-follow-up",
      threadId: ids.thread,
      expectedVersion: 0,
      reason: "Revisit after review",
      origin: "manual",
      triggerSequence: 3,
    } as const;
    expect(decodeCodeFollowUpCommand(open)).toEqual(open);

    const complete = {
      kind: "complete-code-follow-up",
      threadId: ids.thread,
      expectedVersion: 1,
      acknowledgedThroughSequence: 3,
    } as const;
    expect(decodeCodeFollowUpCommand(complete)).toEqual(complete);

    expect(() => decodeCodeFollowUpCommand({ ...open, origin: "provider" })).toThrow();
  });

  it("decodes the follow-up updated event and per-thread view", () => {
    expect(
      decodeCodeThreadFollowUpUpdated({ kind: "code-follow-up-updated", followUp: openFollowUp }),
    ).toEqual({ kind: "code-follow-up-updated", followUp: openFollowUp });

    const view = { threadId: ids.thread, followUpVersion: 2, followUp: openFollowUp } as const;
    expect(decodeCodeThreadFollowUpView(view)).toEqual(view);

    // The marker is absent until first opened.
    const empty = { threadId: ids.thread, followUpVersion: 0 } as const;
    expect(decodeCodeThreadFollowUpView(empty)).toEqual(empty);
  });
});
