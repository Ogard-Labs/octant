import {
  decodeAgentRun,
  decodeCodeCheckoutId,
  decodeCodeCheckoutIdentity,
  decodeCodeEvidenceReference,
  decodeCodeOperationId,
  decodeCodeOperationEventFrame,
  decodeProviderSessionId,
  type CodeOperationEventFrame,
  decodeCodeThread,
  decodeCodeThreadId,
  type AgentRun,
  type CodeTerminalId,
  type CodeThread,
  type CodeReviewFinding,
  type CodeReviewFindingId,
  type CodeFileId,
  type CodeTerminalLiveFrame,
  type WindowId,
} from "@octant/contracts";
import { turnBlocksInPlaceRestore } from "@octant/domain/code-policy";
import {
  REMOTE_CODE_THREAD_CONNECTORS_UNAVAILABLE,
  remoteCodeThreadPostureRefusal,
} from "@octant/domain/ssh-target-recovery";
import { describe, expect, it, vi } from "vitest";
import {
  CodeOperationService,
  CodeOperationServiceError,
  CodeOperationSnapshotRequiredError,
  type CodeOperationServiceOptions,
} from "./codeOperationService";
import { requireLinuxConfinement } from "../process/linuxConfinement";
import { ReviewFindingServiceError } from "./reviewFindingService";
import { TerminalService } from "./terminalService";
import { CodeSessionAuthorityStore } from "./codeSessionAuthorityStore";
import { Schema } from "effect";
import { DeviceId, StableHostId, RemoteSessionId } from "@octant/contracts/remote-access";
import { createAuthenticatedProductDispatch } from "../authenticatedProductRoutes";
import { CodeProjectAccess } from "../codeProjectAccess";
import { createCodeRouteHandler } from "../codeRoutes";
import { WindowAuthorityStore } from "../windowAuthorityStore";

const ids = {
  window: "11111111-1111-4111-8111-111111111111" as WindowId,
  thread: decodeCodeThreadId("22222222-2222-4222-8222-222222222222"),
  checkout: decodeCodeCheckoutId("33333333-3333-4333-8333-333333333333"),
  operation: decodeCodeOperationId("44444444-4444-4444-8444-444444444444"),
  terminal: "55555555-5555-4555-8555-555555555555" as CodeTerminalId,
};

const testRunId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const thread = (): CodeThread =>
  decodeCodeThread({
    id: ids.thread,
    projectId: "66666666-6666-4666-8666-666666666666",
    bindingRevisionId: "77777777-7777-4777-8777-777777777777",
    repositoryId: `repo_${"8".repeat(64)}`,
    checkoutId: ids.checkout,
    title: "Exact checkout",
    lifecycle: "active",
    providerInstanceId: "99999999-9999-4999-8999-999999999999",
    modelId: "model-id",
    executionPolicy: "full-access",
    permissionPersistence: "current-session",
    deliveryTarget: {
      branchIntent: "feature/exact",
      remoteName: "origin",
      proposedBaseRepository: "octant/octant",
      proposedBaseBranch: "development",
      outcomeKind: "opened-pr",
      confirmedAt: "2026-07-21T10:00:00.000Z",
    },
    version: 1,
    createdAt: "2026-07-21T10:00:00.000Z",
    updatedAt: "2026-07-21T10:00:00.000Z",
  });

describe("CodeOperationService", () => {
  it("uses authoritative window, thread, checkout, root, and credentials without returning them", async () => {
    let terminalOutputObserver: ((snapshot: any) => void) | undefined;
    const removeTerminalOutputObserver = vi.fn();
    const terminals = {
      launch: vi.fn(async () => ({
        terminalId: ids.terminal,
        status: "running" as const,
        canRerun: false,
        transcript: {
          chunks: ["private output"],
          byteLength: 14,
          truncated: false,
          characters: 14,
        },
      })),
      attach: vi.fn(),
      observe: vi.fn((_terminalId, listener) => {
        terminalOutputObserver = listener;
        return removeTerminalOutputObserver;
      }),
      write: vi.fn(),
      resize: vi.fn(),
      terminate: vi.fn(),
    };
    const evidence = {
      put: vi.fn((content: string) =>
        decodeCodeEvidenceReference({
          contentId: content.includes("TERMINAL_OK")
            ? "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
            : "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          digest: (content.includes("TERMINAL_OK") ? "b" : "a").repeat(64),
          byteLength: Buffer.byteLength(content),
        }),
      ),
      read: vi.fn(async () => "prompt"),
    };
    let activeThread = decodeCodeThread({ ...thread(), executionPolicy: "approval-gated" });
    const otherThread = decodeCodeThread({
      ...thread(),
      id: decodeCodeThreadId("12121212-1212-4212-8212-121212121212"),
      checkoutId: decodeCodeCheckoutId("34343434-3434-4434-8434-343434343434"),
      repositoryId: `repo_${"c".repeat(64)}`,
    });
    let approved = true;
    const authority = {
      readThread: vi.fn((threadId) => (threadId === otherThread.id ? otherThread : activeThread)),
      readCheckout: vi.fn((checkoutId) => {
        const owner = checkoutId === otherThread.checkoutId ? otherThread : activeThread;
        return decodeCodeCheckoutIdentity({
          id: owner.checkoutId,
          repositoryId: owner.repositoryId,
          kind: "existing-worktree",
          availability: "available",
          head: { kind: "branch", name: "feature/exact", oid: "b".repeat(40) },
          observedAt: "2026-07-21T10:00:00.000Z",
        });
      }),
      canAccessProject: vi.fn(async () => true),
      approvalContextDigest: vi.fn(async () => "a".repeat(64)),
      resolveCheckoutRoot: vi.fn(async () => ({
        checkoutRoot: "/private/exact-checkout",
        workingDirectory: "/private/exact-checkout/packages/app",
        shell: "/bin/zsh",
        credentialReferences: [{ environmentName: "TOKEN", reference: "keychain:token" }],
        environment: { TOKEN: "secret" },
      })),
    };
    const reviewFindings = { create: vi.fn(), changeState: vi.fn() };
    const turns = {
      start: vi.fn(async () => ({ state: "running" as const })),
      answerInput: vi.fn(),
      answerApproval: vi.fn(),
      cancel: vi.fn(),
    };
    const events = {
      replay: vi.fn(() => ({ status: "ok" as const, frames: [], nextCursor: 0 })),
      append: vi.fn(),
      historyForThread: vi.fn(() => ({ status: "ok" as const, frames: [] })),
    };
    const git = {
      observe: vi.fn(),
      stage: vi.fn(),
      unstage: vi.fn(),
      discard: vi.fn(),
      commit: vi.fn(),
      push: vi.fn(),
    };
    const approvals = { validate: vi.fn(async () => approved) };
    const service = new CodeOperationService({
      authority,
      approvals,
      terminals,
      repositoryTests: {
        discover: vi.fn(async () => []),
        run: vi.fn(),
        cancel: vi.fn(async () => false),
      },
      git,
      pullRequests: {
        ensure: vi.fn(),
        observeReview: vi.fn(async () => ({ status: "unavailable" as const })),
      },
      reviewFindings,
      turns,
      evidence,
      events,
    });

    const result = await service.execute(ids.window, {
      kind: "start-terminal",
      operationId: ids.operation,
      threadId: ids.thread,
      checkoutId: ids.checkout,
      terminalId: ids.terminal,
      columns: 120,
      rows: 40,
      credentialRefs: ["TOKEN"],
    });

    expect(terminals.launch).toHaveBeenCalledWith({
      terminalId: ids.terminal,
      shell: "/bin/zsh",
      cwd: "/private/exact-checkout/packages/app",
      // The bound repository, not the path, scopes this shell's saved state.
      stateScope: `repo_${"8".repeat(64)}`,
      columns: 120,
      rows: 40,
      credentialReferences: [{ environmentName: "TOKEN", reference: "keychain:token" }],
      executionPolicy: "approval-gated",
    });
    approved = false;
    await expect(
      service.execute("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as WindowId, {
        kind: "write-terminal",
        operationId: decodeCodeOperationId("abababab-abab-4bab-8bab-abababababab"),
        threadId: ids.thread,
        checkoutId: ids.checkout,
        terminalId: ids.terminal,
        data: "whoami",
      }),
    ).resolves.toMatchObject({
      kind: "operation-failed",
      failure: { category: "waiting" },
    });
    expect(terminals.write).not.toHaveBeenCalled();
    activeThread = thread();
    await expect(
      service.execute("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as WindowId, {
        kind: "write-terminal",
        operationId: decodeCodeOperationId("acacacac-acac-4cac-8cac-acacacacacac"),
        threadId: ids.thread,
        checkoutId: ids.checkout,
        terminalId: ids.terminal,
        data: "pwd",
      }),
    ).resolves.toMatchObject({
      kind: "operation-failed",
      failure: { category: "unauthorized" },
    });
    // Typing reaches a shell that is already open; the root was resolved once
    // when it opened, and re-resolving per key is what made typing crawl.
    expect(authority.resolveCheckoutRoot).toHaveBeenCalledTimes(1);
    activeThread = decodeCodeThread({ ...thread(), executionPolicy: "approval-gated" });
    expect(terminals.write).not.toHaveBeenCalled();
    approved = true;
    expect(evidence.put).toHaveBeenCalledWith("private output");
    expect(result).toEqual({
      kind: "terminal-state",
      operationId: ids.operation,
      terminalId: ids.terminal,
      state: "running",
      transcript: {
        contentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        digest: "a".repeat(64),
        byteLength: 14,
      },
    });
    expect(JSON.stringify(result)).not.toContain("/private/exact-checkout");
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(events.append).toHaveBeenCalledWith({
      threadId: ids.thread,
      operationId: ids.operation,
      expectedCursor: 0,
      event: { kind: "operation-result", result },
    });
    terminals.attach.mockReturnValue({
      terminalId: ids.terminal,
      status: "running",
      canRerun: false,
      transcript: { chunks: ["private output"], byteLength: 14, truncated: false, characters: 14 },
    });
    approved = false;
    const attached = await service.execute(ids.window, {
      kind: "attach-terminal",
      operationId: decodeCodeOperationId("47474747-4747-4474-8474-474747474747"),
      threadId: ids.thread,
      checkoutId: ids.checkout,
      terminalId: ids.terminal,
    });
    expect(attached).toMatchObject({
      kind: "terminal-state",
      terminalId: ids.terminal,
      state: "running",
    });
    expect(terminals.attach).toHaveBeenCalledWith(ids.terminal);
    await expect(
      service.readTerminal(ids.window, {
        threadId: ids.thread,
        checkoutId: ids.checkout,
        terminalId: ids.terminal,
      }),
    ).resolves.toMatchObject({ terminalId: ids.terminal, status: "running" });
    await expect(
      service.readTerminal("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as WindowId, {
        threadId: ids.thread,
        checkoutId: ids.checkout,
        terminalId: ids.terminal,
      }),
    ).rejects.toEqual(new CodeOperationServiceError("unauthorized"));
    const journalCallsBeforeInterrupt = events.append.mock.calls.length;
    await expect(
      service.interruptTerminal(ids.window, {
        threadId: ids.thread,
        checkoutId: ids.checkout,
        terminalId: ids.terminal,
      }),
    ).resolves.toMatchObject({ terminalId: ids.terminal, status: "running" });
    expect(terminals.write).toHaveBeenLastCalledWith(ids.terminal, "\u0003");
    expect(events.append).toHaveBeenCalledTimes(journalCallsBeforeInterrupt);
    terminals.write.mockClear();
    // The surface resumes from where the snapshot it was already sent ends, so
    // output between the attach and the observe is neither lost nor repeated.
    expect(terminals.observe).toHaveBeenLastCalledWith(ids.terminal, expect.any(Function), {
      afterCharacters: 14,
    });
    approved = true;
    terminalOutputObserver?.({
      text: "\nTERMINAL_OK\n",
      replace: false,
      snapshot: {
        terminalId: ids.terminal,
        status: "running",
        canRerun: false,
        transcript: {
          chunks: ["private output\nTERMINAL_OK\n"],
          byteLength: 27,
          truncated: false,
          characters: 0,
        },
      },
    });
    expect(events.append).toHaveBeenCalledWith({
      threadId: ids.thread,
      operationId: decodeCodeOperationId("47474747-4747-4474-8474-474747474747"),
      expectedCursor: 1,
      event: {
        kind: "terminal-output",
        terminalId: ids.terminal,
        content: {
          contentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          digest: "b".repeat(64),
          byteLength: 13,
        },
        replace: false,
      },
    });
    if (result.kind !== "terminal-state" || result.transcript === undefined) {
      throw new Error("Expected terminal evidence.");
    }

    events.replay.mockReturnValue({
      status: "ok",
      frames: [
        {
          threadId: ids.thread,
          operationId: ids.operation,
          cursor: 1,
          occurredAt: "2026-07-21T10:00:00.000Z",
          event: { kind: "operation-result", result },
        } as never,
      ],
      nextCursor: 1,
    });
    evidence.read.mockResolvedValueOnce("private output");
    await expect(
      service.readEvidence(ids.window, ids.thread, ids.operation, result.transcript.contentId),
    ).resolves.toEqual({ reference: result.transcript, text: "private output" });
    await expect(
      service.readEvidence(
        ids.window,
        ids.thread,
        ids.operation,
        decodeCodeEvidenceReference({
          contentId: "abababab-abab-4bab-8bab-abababababab",
          digest: "b".repeat(64),
          byteLength: 1,
        }).contentId,
      ),
    ).rejects.toEqual(new CodeOperationServiceError("unauthorized"));

    const prompt = decodeCodeEvidenceReference({
      contentId: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
      digest: "c".repeat(64),
      byteLength: 6,
    });
    const reply = decodeCodeEvidenceReference({
      contentId: "dededede-dede-4ede-8ede-dededededede",
      digest: "d".repeat(64),
      byteLength: 5,
    });
    events.replay.mockClear();
    events.replay.mockReturnValueOnce({
      status: "ok",
      frames: [
        {
          threadId: ids.thread,
          operationId: ids.operation,
          cursor: 1,
          occurredAt: "2026-07-21T10:00:00.000Z",
          event: {
            kind: "conversation-turn-started",
            providerInstanceId: "00000000-0000-4000-8000-000000000908",
            modelId: "model-a",
            sessionId: "80000000-0000-4000-8000-000000000010",
            prompt,
          },
        },
        {
          threadId: ids.thread,
          operationId: ids.operation,
          cursor: 2,
          occurredAt: "2026-07-21T10:00:01.000Z",
          event: { kind: "provider-content", channel: "message", content: reply },
        },
      ] as never,
      nextCursor: 2,
    });
    evidence.read.mockResolvedValueOnce("prompt").mockResolvedValueOnce("reply");

    await expect(
      service.readEvidenceBatch(ids.window, ids.thread, [
        { operationId: ids.operation, contentId: prompt.contentId },
        { operationId: ids.operation, contentId: reply.contentId },
      ]),
    ).resolves.toEqual([
      { operationId: ids.operation, contentId: prompt.contentId, text: "prompt" },
      { operationId: ids.operation, contentId: reply.contentId, text: "reply" },
    ]);
    expect(events.replay).toHaveBeenCalledTimes(1);

    events.replay.mockReturnValueOnce({
      status: "ok",
      frames: [
        {
          threadId: ids.thread,
          operationId: ids.operation,
          cursor: 1,
          occurredAt: "2026-07-21T10:00:00.000Z",
          event: { kind: "operation-result", result },
        } as never,
      ],
      nextCursor: 1,
    });
    await expect(
      service.execute(ids.window, {
        kind: "start-terminal",
        operationId: ids.operation,
        threadId: ids.thread,
        checkoutId: ids.checkout,
        terminalId: ids.terminal,
        columns: 120,
        rows: 40,
        credentialRefs: ["TOKEN"],
      }),
    ).resolves.toEqual(result);
    expect(terminals.launch).toHaveBeenCalledTimes(1);

    events.replay.mockReturnValue({ status: "snapshot-required", reason: "gap" } as never);
    await expect(service.subscribe(ids.window, ids.thread, ids.operation, 0, 10)).rejects.toEqual(
      new CodeOperationSnapshotRequiredError("gap"),
    );
    events.replay.mockReturnValue({ status: "ok", frames: [], nextCursor: 0 });

    await expect(
      service.execute(ids.window, {
        kind: "write-terminal",
        operationId: decodeCodeOperationId("45454545-4545-4454-8454-454545454545"),
        threadId: otherThread.id,
        checkoutId: otherThread.checkoutId,
        terminalId: ids.terminal,
        data: "whoami",
      }),
    ).resolves.toMatchObject({
      kind: "operation-failed",
      failure: { category: "unauthorized" },
    });
    expect(terminals.write).not.toHaveBeenCalled();
    terminalOutputObserver?.({
      text: "",
      replace: false,
      snapshot: {
        terminalId: ids.terminal,
        status: "exited",
        canRerun: true,
        exitCode: 0,
        transcript: {
          chunks: ["private output\nTERMINAL_OK\n"],
          byteLength: 27,
          truncated: false,
          characters: 0,
        },
      },
    });
    expect(events.append).toHaveBeenCalledWith({
      threadId: ids.thread,
      operationId: decodeCodeOperationId("47474747-4747-4474-8474-474747474747"),
      expectedCursor: 2,
      event: {
        kind: "terminal-state-changed",
        terminalId: ids.terminal,
        state: "exited",
        exitCode: 0,
      },
    });
    expect(removeTerminalOutputObserver).toHaveBeenCalledTimes(2);

    const findingId = "56565656-5656-4565-8565-565656565656" as CodeReviewFindingId;
    reviewFindings.create.mockResolvedValue({
      id: "57575757-5757-4575-8575-575757575757" as CodeReviewFindingId,
    } as CodeReviewFinding);
    await expect(
      service.execute(ids.window, {
        kind: "create-review-finding",
        operationId: decodeCodeOperationId("46464646-4646-4464-8464-464646464646"),
        threadId: ids.thread,
        checkoutId: ids.checkout,
        findingId,
        fileId: "58585858-5858-4585-8585-585858585858" as CodeFileId,
        path: "src/file.ts",
        fileDigest: "d".repeat(64),
        location: { kind: "line", line: 1 },
        severity: "warning",
        summary: "Preserve the requested identity.",
      }),
    ).resolves.toMatchObject({
      kind: "operation-failed",
      failure: { category: "stale" },
    });
    expect(reviewFindings.create).toHaveBeenCalledWith(
      ids.window,
      expect.objectContaining({ id: findingId }),
    );

    reviewFindings.changeState.mockRejectedValueOnce(new ReviewFindingServiceError("stale"));
    await expect(
      service.execute(ids.window, {
        kind: "update-review-finding",
        operationId: decodeCodeOperationId("51515151-5151-4515-8515-515151515151"),
        threadId: ids.thread,
        checkoutId: ids.checkout,
        findingId,
        expectedVersion: 1,
        state: "resolved",
      }),
    ).resolves.toMatchObject({
      kind: "operation-failed",
      failure: { category: "stale" },
    });

    git.stage.mockResolvedValueOnce({ status: "unavailable" });
    await expect(
      service.execute(ids.window, {
        kind: "stage-git",
        operationId: decodeCodeOperationId("52525252-5252-4525-8525-525252525252"),
        threadId: ids.thread,
        checkoutId: ids.checkout,
        gitOperationId: decodeCodeOperationId("53535353-5353-4535-8535-535353535353"),
        paths: ["src/file.ts"],
        expectedStateToken: "f".repeat(64),
      }),
    ).resolves.toMatchObject({
      kind: "operation-failed",
      failure: { category: "unavailable" },
    });

    activeThread = decodeCodeThread({ ...thread(), executionPolicy: "approval-gated" });
    approved = true;
    const providerOperation = decodeCodeOperationId("48484848-4848-4484-8484-484848484848");
    await expect(
      service.execute(ids.window, {
        kind: "start-provider-turn",
        operationId: providerOperation,
        threadId: ids.thread,
        checkoutId: ids.checkout,
        sessionId: "60606060-6060-4060-8060-606060606060",
        prompt: decodeCodeEvidenceReference({
          contentId: "61616161-6161-4161-8161-616161616161",
          digest: "e".repeat(64),
          byteLength: 6,
        }),
      }),
    ).resolves.toMatchObject({ kind: "provider-turn-state", state: "running" });
    expect(turns.start).toHaveBeenCalledOnce();
    expect(events.append).toHaveBeenCalledWith({
      threadId: ids.thread,
      operationId: providerOperation,
      expectedCursor: 0,
      event: {
        kind: "conversation-turn-started",
        providerInstanceId: activeThread.providerInstanceId,
        modelId: activeThread.modelId,
        sessionId: "60606060-6060-4060-8060-606060606060",
        prompt: expect.objectContaining({
          contentId: "61616161-6161-4161-8161-616161616161",
        }),
        executionPolicy: "approval-gated",
      },
    });
    expect(events.append).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: ids.thread,
        operationId: providerOperation,
        expectedCursor: 1,
        event: expect.objectContaining({ kind: "operation-result" }),
      }),
    );

    turns.answerApproval.mockResolvedValue({ state: "running" });
    approved = false;
    await expect(
      service.execute(ids.window, {
        kind: "answer-provider-approval",
        operationId: decodeCodeOperationId("49494949-4949-4494-8494-494949494949"),
        threadId: ids.thread,
        checkoutId: ids.checkout,
        approvalId: "50505050-5050-4050-8050-505050505050",
        decision: "approved",
      }),
    ).resolves.toMatchObject({ kind: "provider-turn-state", state: "running" });
    expect(turns.answerApproval).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: "50505050-5050-4050-8050-505050505050" }),
    );

    const approvalOperation = decodeCodeOperationId("47474747-4747-4474-8474-474747474747");
    const approvalTerminal = "59595959-5959-4595-8595-595959595959" as CodeTerminalId;
    events.replay.mockReturnValue({ status: "ok", frames: [], nextCursor: 0 });
    await expect(
      service.execute(ids.window, {
        kind: "start-terminal",
        operationId: approvalOperation,
        threadId: ids.thread,
        checkoutId: ids.checkout,
        terminalId: approvalTerminal,
        columns: 120,
        rows: 40,
        credentialRefs: ["TOKEN"],
      }),
    ).resolves.toMatchObject({
      kind: "operation-failed",
      failure: { category: "waiting" },
    });
    expect(events.append).toHaveBeenLastCalledWith({
      threadId: ids.thread,
      operationId: approvalOperation,
      expectedCursor: 0,
      event: { kind: "operation-state", state: "waiting" },
    });

    // The same terminal opened by the person at the window is their own act:
    // it starts without a prompt while the agent's request above stays gated.
    const userTerminalOperation = decodeCodeOperationId("48484848-4848-4484-8484-484848484848");
    const userTerminal = "58585858-5858-4585-8585-585858585858" as CodeTerminalId;
    const launchesBeforeUser = terminals.launch.mock.calls.length;
    const approvalChecksBeforeUser = approvals.validate.mock.calls.length;
    await expect(
      service.execute(
        ids.window,
        {
          kind: "start-terminal",
          operationId: userTerminalOperation,
          threadId: ids.thread,
          checkoutId: ids.checkout,
          terminalId: userTerminal,
          columns: 120,
          rows: 40,
          credentialRefs: [],
        },
        { initiator: "user" },
      ),
    ).resolves.toMatchObject({ kind: "terminal-state", state: "running" });
    expect(terminals.launch).toHaveBeenCalledTimes(launchesBeforeUser + 1);
    expect(approvals.validate).toHaveBeenCalledTimes(approvalChecksBeforeUser);

    // Vouching for a command is authority to open a shell and nothing else.
    // A durable mutation the classifier calls an edit keeps its ordinary gate
    // even when the caller labels it user-initiated.
    const findingOperation = decodeCodeOperationId("49494949-4949-4494-8494-494949494949");
    events.replay.mockReturnValue({ status: "ok", frames: [], nextCursor: 0 });
    await expect(
      service.execute(
        ids.window,
        {
          kind: "create-review-finding",
          operationId: findingOperation,
          threadId: ids.thread,
          checkoutId: ids.checkout,
          findingId: "51515151-5151-4515-8515-515151515151",
          fileId: "52525252-5252-4525-8525-525252525252",
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
          summary: "Keep this boundary strict.",
        } as never,
        { initiator: "user" },
      ),
    ).resolves.toMatchObject({ kind: "operation-failed", failure: { category: "waiting" } });

    approved = true;
    events.replay.mockReturnValue({
      status: "ok",
      frames: [
        {
          threadId: ids.thread,
          operationId: approvalOperation,
          cursor: 1,
          occurredAt: "2026-07-21T10:00:00.000Z",
          event: { kind: "operation-state", state: "waiting" },
        } as never,
      ],
      nextCursor: 1,
    });
    const resumed = await service.execute(ids.window, {
      kind: "start-terminal",
      operationId: approvalOperation,
      threadId: ids.thread,
      checkoutId: ids.checkout,
      terminalId: approvalTerminal,
      columns: 120,
      rows: 40,
      credentialRefs: ["TOKEN"],
    });
    expect(events.append).toHaveBeenLastCalledWith({
      threadId: ids.thread,
      operationId: approvalOperation,
      expectedCursor: 1,
      event: { kind: "operation-result", result: resumed },
    });
    expect(terminals.launch).toHaveBeenCalledTimes(3);

    approved = false;
    terminals.attach.mockReturnValue({
      terminalId: approvalTerminal,
      status: "running",
      canRerun: false,
      transcript: { chunks: [], byteLength: 0, truncated: false, characters: 0 },
    });
    const approvalChecksAfterStart = approvals.validate.mock.calls.length;
    const resizeOperation = decodeCodeOperationId("67676767-6767-4676-8676-676767676767");
    events.replay.mockReturnValue({ status: "ok", frames: [], nextCursor: 0 });
    await expect(
      service.execute(ids.window, {
        kind: "resize-terminal",
        operationId: resizeOperation,
        threadId: ids.thread,
        checkoutId: ids.checkout,
        terminalId: approvalTerminal,
        columns: 100,
        rows: 30,
      }),
    ).resolves.toMatchObject({ kind: "terminal-state", state: "running" });
    expect(terminals.resize).toHaveBeenCalledWith(approvalTerminal, 100, 30);
    expect(approvals.validate).toHaveBeenCalledTimes(approvalChecksAfterStart);

    events.replay.mockReturnValue({
      status: "ok",
      frames: [
        {
          threadId: ids.thread,
          operationId: approvalOperation,
          cursor: 1,
          occurredAt: "2026-07-21T10:00:00.000Z",
          event: { kind: "operation-state", state: "waiting" },
        } as never,
        {
          threadId: ids.thread,
          operationId: approvalOperation,
          cursor: 2,
          occurredAt: "2026-07-21T10:00:01.000Z",
          event: { kind: "operation-result", result: resumed },
        } as never,
      ],
      nextCursor: 2,
    });
    await expect(
      service.execute(ids.window, {
        kind: "start-terminal",
        operationId: approvalOperation,
        threadId: ids.thread,
        checkoutId: ids.checkout,
        terminalId: approvalTerminal,
        columns: 120,
        rows: 40,
        credentialRefs: ["TOKEN"],
      }),
    ).resolves.toEqual(resumed);
    expect(terminals.launch).toHaveBeenCalledTimes(3);

    events.append.mockImplementationOnce(() => {
      throw new Error("event journal unavailable");
    });
    terminalOutputObserver?.({
      text: "unpersisted output",
      replace: false,
      snapshot: {
        terminalId: approvalTerminal,
        status: "running",
        canRerun: false,
        transcript: {
          chunks: ["unpersisted output"],
          byteLength: 18,
          truncated: false,
          characters: 0,
        },
      },
    });
    expect(terminals.terminate).toHaveBeenCalledWith(approvalTerminal);
  });

  it("recovers a stale running turn only while host admission remains current", async () => {
    const providerOperation = decodeCodeOperationId("48484848-4848-4484-8484-484848484848");
    const prompt = decodeCodeEvidenceReference({
      contentId: "61616161-6161-4161-8161-616161616161",
      digest: "e".repeat(64),
      byteLength: 6,
    });
    const activeThread = decodeCodeThread({ ...thread(), executionPolicy: "approval-gated" });
    const turns = {
      start: vi.fn(async () => ({ state: "running" as const })),
      answerInput: vi.fn(),
      answerApproval: vi.fn(),
      cancel: vi.fn(),
    };
    const events = {
      append: vi.fn(),
      historyForThread: vi.fn(() => ({ status: "ok" as const, frames: [] })),
      replay: vi.fn(() => ({
        status: "ok" as const,
        frames: [
          {
            threadId: ids.thread,
            operationId: providerOperation,
            cursor: 0,
            occurredAt: "2026-07-21T10:00:00.000Z",
            event: {
              kind: "conversation-turn-started",
              providerInstanceId: activeThread.providerInstanceId,
              modelId: activeThread.modelId,
              sessionId: "60606060-6060-4060-8060-606060606060",
              prompt,
            },
          },
          {
            threadId: ids.thread,
            operationId: providerOperation,
            cursor: 1,
            occurredAt: "2026-07-21T10:00:01.000Z",
            event: {
              kind: "operation-result",
              result: {
                kind: "provider-turn-state",
                operationId: providerOperation,
                state: "running",
              },
            },
          },
        ],
        nextCursor: 2,
      })),
    };
    const evidence = {
      put: vi.fn(),
      read: vi.fn(async () => "prompt"),
    };
    const authority = {
      readThread: vi.fn(() => activeThread),
      readCheckout: vi.fn(() =>
        decodeCodeCheckoutIdentity({
          id: ids.checkout,
          repositoryId: activeThread.repositoryId,
          kind: "existing-worktree",
          availability: "available",
          head: { kind: "branch", name: "development", oid: "a".repeat(40) },
          observedAt: "2026-07-21T10:00:00.000Z",
        }),
      ),
      canAccessProject: vi.fn(async () => true),
      resolveCheckoutRoot: vi.fn(async () => ({
        checkoutRoot: "/tmp/repo",
        credentialReferences: [],
      })),
    };
    const service = new CodeOperationService({
      authority: authority as never,
      approvals: { validate: vi.fn(async () => true) },
      terminals: {
        launch: vi.fn(),
        attach: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
        terminate: vi.fn(),
      },
      repositoryTests: { run: vi.fn(), cancel: vi.fn() } as never,
      git: {
        observe: vi.fn(),
        stage: vi.fn(),
        commit: vi.fn(),
        push: vi.fn(),
      } as never,
      pullRequests: {
        createPullRequest: vi.fn(),
        observePullRequest: vi.fn(),
        mergePullRequest: vi.fn(),
      } as never,
      reviewFindings: {
        createFinding: vi.fn(),
        updateFinding: vi.fn(),
      } as never,
      turns: turns as never,
      evidence: evidence as never,
      events: events as never,
    });

    await expect(
      service.execute(ids.window, {
        kind: "start-provider-turn",
        operationId: providerOperation,
        threadId: ids.thread,
        checkoutId: ids.checkout,
        sessionId: "60606060-6060-4060-8060-606060606060",
        prompt,
      }),
    ).resolves.toMatchObject({ kind: "provider-turn-state", state: "running" });
    expect(turns.start).toHaveBeenCalledOnce();
    // Recovery must not append a second operation-result for the same receipt.
    expect(events.append).not.toHaveBeenCalled();
    turns.start.mockClear();
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    let current = true;
    evidence.read.mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return "prompt";
    });
    const pending = service.execute(
      ids.window,
      {
        kind: "start-provider-turn",
        operationId: providerOperation,
        threadId: ids.thread,
        checkoutId: ids.checkout,
        sessionId: "60606060-6060-4060-8060-606060606060",
        prompt,
      },
      { admissionCurrent: () => current },
    );
    await entered.promise;
    current = false;
    release.resolve();
    await expect(pending).resolves.toMatchObject({
      kind: "operation-failed",
      failure: { category: "unauthorized" },
    });
    expect(turns.start).not.toHaveBeenCalled();
    expect(events.append).not.toHaveBeenCalled();
  });

  it("does not relaunch a cached running turn after it has already recorded what changed", async () => {
    const providerOperation = decodeCodeOperationId("4a4a4a4a-4a4a-44a4-84a4-4a4a4a4a4a4a");
    const prompt = decodeCodeEvidenceReference({
      contentId: "63636363-6363-4363-8363-636363636363",
      digest: "a".repeat(64),
      byteLength: 6,
    });
    const activeThread = decodeCodeThread({ ...thread(), executionPolicy: "approval-gated" });
    const turns = {
      start: vi.fn(async () => ({ state: "running" as const })),
      answerInput: vi.fn(),
      answerApproval: vi.fn(),
      cancel: vi.fn(),
    };
    const events = {
      append: vi.fn(),
      historyForThread: vi.fn(() => ({ status: "ok" as const, frames: [] })),
      replay: vi.fn(() => ({
        status: "ok" as const,
        frames: [
          {
            threadId: ids.thread,
            operationId: providerOperation,
            cursor: 0,
            occurredAt: "2026-07-21T10:00:00.000Z",
            event: {
              kind: "conversation-turn-started",
              providerInstanceId: activeThread.providerInstanceId,
              modelId: activeThread.modelId,
              sessionId: "60606060-6060-4060-8060-606060606060",
              prompt,
            },
          },
          {
            threadId: ids.thread,
            operationId: providerOperation,
            cursor: 1,
            occurredAt: "2026-07-21T10:00:02.000Z",
            event: {
              kind: "conversation-turn-changed-files",
              changedFiles: {
                files: [{ path: "src/app.ts", insertions: 1, deletions: 0 }],
                total: 1,
                truncated: false,
              },
            },
          },
          {
            threadId: ids.thread,
            operationId: providerOperation,
            cursor: 2,
            occurredAt: "2026-07-21T10:00:01.000Z",
            event: {
              kind: "operation-result",
              result: {
                kind: "provider-turn-state",
                operationId: providerOperation,
                state: "running",
              },
            },
          },
        ],
        nextCursor: 3,
      })),
    };
    const evidence = {
      put: vi.fn(),
      read: vi.fn(async () => "prompt"),
    };
    const authority = {
      readThread: vi.fn(() => activeThread),
      readCheckout: vi.fn(() =>
        decodeCodeCheckoutIdentity({
          id: ids.checkout,
          repositoryId: activeThread.repositoryId,
          kind: "existing-worktree",
          availability: "available",
          head: { kind: "branch", name: "development", oid: "a".repeat(40) },
          observedAt: "2026-07-21T10:00:00.000Z",
        }),
      ),
      canAccessProject: vi.fn(async () => true),
      resolveCheckoutRoot: vi.fn(async () => ({
        checkoutRoot: "/tmp/repo",
        credentialReferences: [],
      })),
    };
    const service = new CodeOperationService({
      authority: authority as never,
      approvals: { validate: vi.fn(async () => true) },
      terminals: {
        launch: vi.fn(),
        attach: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
        terminate: vi.fn(),
      },
      repositoryTests: { run: vi.fn(), cancel: vi.fn() } as never,
      git: {
        observe: vi.fn(),
        stage: vi.fn(),
        commit: vi.fn(),
        push: vi.fn(),
      } as never,
      pullRequests: {
        createPullRequest: vi.fn(),
        observePullRequest: vi.fn(),
        mergePullRequest: vi.fn(),
      } as never,
      reviewFindings: {
        createFinding: vi.fn(),
        updateFinding: vi.fn(),
      } as never,
      turns: turns as never,
      evidence: evidence as never,
      events: events as never,
    });

    await expect(
      service.execute(ids.window, {
        kind: "start-provider-turn",
        operationId: providerOperation,
        threadId: ids.thread,
        checkoutId: ids.checkout,
        sessionId: "60606060-6060-4060-8060-606060606060",
        prompt,
      }),
    ).resolves.toMatchObject({ kind: "provider-turn-state", state: "interrupted" });
    // The change list is settlement evidence: the turn had already begun to
    // settle, so a crash before the terminal state must not launch it again.
    expect(turns.start).not.toHaveBeenCalled();
    expect(events.append).toHaveBeenCalledWith(
      expect.objectContaining({
        event: { kind: "operation-state", state: "interrupted" },
      }),
    );
  });

  it("pages a long journal to find a change list written after the first 256 frames", async () => {
    const providerOperation = decodeCodeOperationId("4b4b4b4b-4b4b-44b4-84b4-4b4b4b4b4b4b");
    const prompt = decodeCodeEvidenceReference({
      contentId: "64646464-6464-4464-8464-646464646464",
      digest: "b".repeat(64),
      byteLength: 6,
    });
    const activeThread = decodeCodeThread({ ...thread(), executionPolicy: "approval-gated" });
    const turns = {
      start: vi.fn(async () => ({ state: "running" as const })),
      answerInput: vi.fn(),
      answerApproval: vi.fn(),
      cancel: vi.fn(),
    };
    const started = {
      threadId: ids.thread,
      operationId: providerOperation,
      cursor: 0,
      occurredAt: "2026-07-21T10:00:00.000Z",
      event: {
        kind: "conversation-turn-started" as const,
        providerInstanceId: activeThread.providerInstanceId,
        modelId: activeThread.modelId,
        sessionId: "60606060-6060-4060-8060-606060606060",
        prompt,
      },
    };
    const running = {
      threadId: ids.thread,
      operationId: providerOperation,
      cursor: 1,
      occurredAt: "2026-07-21T10:00:01.000Z",
      event: {
        kind: "operation-result" as const,
        result: {
          kind: "provider-turn-state" as const,
          operationId: providerOperation,
          state: "running" as const,
        },
      },
    };
    const usage = (cursor: number) => ({
      threadId: ids.thread,
      operationId: providerOperation,
      cursor,
      occurredAt: "2026-07-21T10:00:02.000Z",
      event: { kind: "usage" as const, inputTokens: 1, outputTokens: 1 },
    });
    const firstPage = [started, running, ...Array.from({ length: 254 }, (_, i) => usage(i + 2))];
    const events = {
      append: vi.fn(),
      historyForThread: vi.fn(() => ({ status: "ok" as const, frames: [] })),
      replay: vi.fn((input: { readonly afterCursor: number }) =>
        input.afterCursor === 0
          ? { status: "ok" as const, frames: firstPage, nextCursor: 256 }
          : {
              status: "ok" as const,
              frames: [
                {
                  threadId: ids.thread,
                  operationId: providerOperation,
                  cursor: 256,
                  occurredAt: "2026-07-21T10:00:03.000Z",
                  event: {
                    kind: "conversation-turn-changed-files" as const,
                    changedFiles: {
                      files: [{ path: "src/app.ts", insertions: 1, deletions: 0 }],
                      total: 1,
                      truncated: false,
                    },
                  },
                },
              ],
              nextCursor: 257,
            },
      ),
    };
    const evidence = {
      put: vi.fn(),
      read: vi.fn(async () => "prompt"),
    };
    const authority = {
      readThread: vi.fn(() => activeThread),
      readCheckout: vi.fn(() =>
        decodeCodeCheckoutIdentity({
          id: ids.checkout,
          repositoryId: activeThread.repositoryId,
          kind: "existing-worktree",
          availability: "available",
          head: { kind: "branch", name: "development", oid: "a".repeat(40) },
          observedAt: "2026-07-21T10:00:00.000Z",
        }),
      ),
      canAccessProject: vi.fn(async () => true),
      resolveCheckoutRoot: vi.fn(async () => ({
        checkoutRoot: "/tmp/repo",
        credentialReferences: [],
      })),
    };
    const service = new CodeOperationService({
      authority: authority as never,
      approvals: { validate: vi.fn(async () => true) },
      terminals: {
        launch: vi.fn(),
        attach: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
        terminate: vi.fn(),
      },
      repositoryTests: { run: vi.fn(), cancel: vi.fn() } as never,
      git: {
        observe: vi.fn(),
        stage: vi.fn(),
        commit: vi.fn(),
        push: vi.fn(),
      } as never,
      pullRequests: {
        createPullRequest: vi.fn(),
        observePullRequest: vi.fn(),
        mergePullRequest: vi.fn(),
      } as never,
      reviewFindings: {
        createFinding: vi.fn(),
        updateFinding: vi.fn(),
      } as never,
      turns: turns as never,
      evidence: evidence as never,
      events: events as never,
    });

    await expect(
      service.execute(ids.window, {
        kind: "start-provider-turn",
        operationId: providerOperation,
        threadId: ids.thread,
        checkoutId: ids.checkout,
        sessionId: "60606060-6060-4060-8060-606060606060",
        prompt,
      }),
    ).resolves.toMatchObject({ kind: "provider-turn-state", state: "interrupted" });
    expect(turns.start).not.toHaveBeenCalled();
    expect(events.append).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedCursor: 257,
        event: { kind: "operation-state", state: "interrupted" },
      }),
    );
  });

  it("refuses to recover a stale provider turn the Project provider policy no longer accepts", async () => {
    const providerOperation = decodeCodeOperationId("49494949-4949-4494-8494-494949494949");
    const prompt = decodeCodeEvidenceReference({
      contentId: "62626262-6262-4262-8262-626262626262",
      digest: "f".repeat(64),
      byteLength: 6,
    });
    const activeThread = decodeCodeThread({ ...thread(), executionPolicy: "approval-gated" });
    const turns = {
      start: vi.fn(async () => ({ state: "running" as const })),
      answerInput: vi.fn(),
      answerApproval: vi.fn(),
      cancel: vi.fn(),
    };
    const events = {
      append: vi.fn(),
      historyForThread: vi.fn(() => ({ status: "ok" as const, frames: [] })),
      replay: vi.fn(() => ({
        status: "ok" as const,
        frames: [
          {
            threadId: ids.thread,
            operationId: providerOperation,
            cursor: 0,
            occurredAt: "2026-07-21T10:00:00.000Z",
            event: {
              kind: "conversation-turn-started",
              providerInstanceId: activeThread.providerInstanceId,
              modelId: activeThread.modelId,
              sessionId: "60606060-6060-4060-8060-606060606060",
              prompt,
            },
          },
          {
            threadId: ids.thread,
            operationId: providerOperation,
            cursor: 1,
            occurredAt: "2026-07-21T10:00:01.000Z",
            event: {
              kind: "operation-result",
              result: {
                kind: "provider-turn-state",
                operationId: providerOperation,
                state: "running",
              },
            },
          },
        ],
        nextCursor: 2,
      })),
    };
    const authority = {
      readThread: vi.fn(() => activeThread),
      readCheckout: vi.fn(() =>
        decodeCodeCheckoutIdentity({
          id: ids.checkout,
          repositoryId: activeThread.repositoryId,
          kind: "existing-worktree",
          availability: "available",
          head: { kind: "branch", name: "development", oid: "a".repeat(40) },
          observedAt: "2026-07-21T10:00:00.000Z",
        }),
      ),
      canAccessProject: vi.fn(async () => true),
      resolveCheckoutRoot: vi.fn(async () => ({
        checkoutRoot: "/tmp/repo",
        credentialReferences: [],
      })),
    };
    const service = new CodeOperationService({
      authority: authority as never,
      approvals: { validate: vi.fn(async () => true) },
      terminals: {
        launch: vi.fn(),
        attach: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
        terminate: vi.fn(),
      },
      repositoryTests: { run: vi.fn(), cancel: vi.fn() } as never,
      git: {
        observe: vi.fn(),
        stage: vi.fn(),
        commit: vi.fn(),
        push: vi.fn(),
      } as never,
      pullRequests: {
        createPullRequest: vi.fn(),
        observePullRequest: vi.fn(),
        mergePullRequest: vi.fn(),
      } as never,
      reviewFindings: {
        createFinding: vi.fn(),
        updateFinding: vi.fn(),
      } as never,
      turns: turns as never,
      evidence: { put: vi.fn(), read: vi.fn(async () => "prompt") } as never,
      events: events as never,
      // The Project's policy changed while the turn was open.
      isProviderModelAllowed: () => false,
    });

    await expect(
      service.execute(ids.window, {
        kind: "start-provider-turn",
        operationId: providerOperation,
        threadId: ids.thread,
        checkoutId: ids.checkout,
        sessionId: "60606060-6060-4060-8060-606060606060",
        prompt,
      }),
    ).resolves.toMatchObject({
      kind: "operation-failed",
      failure: {
        category: "unauthorized",
        message: "This provider or model is not allowed by this Code Project's provider policy.",
      },
    });
    // The stale turn was never resumed and no checkout work was started.
    expect(turns.start).not.toHaveBeenCalled();
    expect(authority.resolveCheckoutRoot).not.toHaveBeenCalled();
  });

  it("never discards uncommitted work on an auto-accepting thread without an approval", async () => {
    const discard = vi.fn(async () => ({ status: "applied" as const }));
    let approved = false;
    const activeThread = decodeCodeThread({
      ...thread(),
      executionPolicy: "auto-accept-edits",
    });
    const service = new CodeOperationService({
      authority: {
        readThread: vi.fn(() => activeThread),
        readCheckout: vi.fn(() =>
          decodeCodeCheckoutIdentity({
            id: ids.checkout,
            repositoryId: activeThread.repositoryId,
            kind: "existing-worktree",
            availability: "available",
            head: { kind: "branch", name: "development", oid: "a".repeat(40) },
            observedAt: "2026-07-21T10:00:00.000Z",
          }),
        ),
        canAccessProject: vi.fn(async () => true),
        approvalContextDigest: vi.fn(async () => "a".repeat(64)),
        resolveCheckoutRoot: vi.fn(async () => ({
          checkoutRoot: "/tmp/repo",
          credentialReferences: [],
        })),
      } as never,
      approvals: { validate: vi.fn(async () => approved) },
      terminals: {
        launch: vi.fn(),
        attach: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
        terminate: vi.fn(),
      } as never,
      repositoryTests: { run: vi.fn(), cancel: vi.fn() } as never,
      git: { observe: vi.fn(), stage: vi.fn(), discard, commit: vi.fn(), push: vi.fn() } as never,
      pullRequests: {
        createPullRequest: vi.fn(),
        observePullRequest: vi.fn(),
        mergePullRequest: vi.fn(),
      } as never,
      reviewFindings: { createFinding: vi.fn(), updateFinding: vi.fn() } as never,
      turns: { start: vi.fn(), answerInput: vi.fn(), answerApproval: vi.fn(), cancel: vi.fn() },
      evidence: { put: vi.fn(), read: vi.fn(async () => "prompt") } as never,
      events: {
        replay: vi.fn(() => ({ status: "ok" as const, frames: [], nextCursor: 0 })),
        append: vi.fn(),
      } as never,
    });
    const command = {
      kind: "discard-git-changes",
      operationId: ids.operation,
      threadId: ids.thread,
      checkoutId: ids.checkout,
      gitOperationId: decodeCodeOperationId("53535353-5353-4535-8535-535353535353"),
      paths: ["src/file.ts"],
      expectedStateToken: "f".repeat(64),
    } as const;

    // The posture waives project file writes. Destroying uncommitted work is
    // not one, so the host waits for a receipt rather than proceeding.
    await expect(service.execute(ids.window, command)).resolves.toMatchObject({
      kind: "operation-failed",
      failure: { category: "waiting" },
    });
    expect(discard).not.toHaveBeenCalled();

    approved = true;
    await expect(service.execute(ids.window, command)).resolves.toMatchObject({
      kind: "git-mutation-state",
      mutation: "discard",
      state: "completed",
    });
    expect(discard).toHaveBeenCalledWith({
      checkoutId: ids.checkout,
      checkoutRoot: "/tmp/repo",
      paths: ["src/file.ts"],
      expectedStateToken: "f".repeat(64),
      executionPolicy: "auto-accept-edits",
    });
  });

  describe("restoring files in place", () => {
    const restoredCheckpoint = { worktree: "c".repeat(40), index: "d".repeat(40) };
    const restoreCommand = {
      kind: "restore-git-checkpoint",
      operationId: ids.operation,
      threadId: ids.thread,
      checkoutId: ids.checkout,
      gitOperationId: decodeCodeOperationId("53535353-5353-4535-8535-535353535353"),
      checkpoint: restoredCheckpoint,
    } as const;
    const writerProject = "66666666-6666-4666-8666-666666666666";
    const otherProject = "abababab-abab-4bab-8bab-abababababab";

    function liveTurn(input: {
      readonly title?: string;
      readonly projectId?: string;
      readonly posture?: CodeThread["executionPolicy"];
      readonly checkoutRoot?: string;
      readonly threadId?: CodeThread["id"];
      readonly state?: "running" | "waiting" | "completed";
    }) {
      return {
        thread: decodeCodeThread({
          ...thread(),
          id: input.threadId ?? decodeCodeThreadId("12121212-1212-4212-8212-121212121212"),
          projectId: input.projectId ?? writerProject,
          title: input.title ?? "Rewrite the parser",
          executionPolicy: input.posture ?? "approval-gated",
        }),
        checkoutRoot: input.checkoutRoot ?? "/tmp/repo",
        state: input.state ?? "running",
      };
    }

    function restoreFixture(
      live: ReadonlyArray<ReturnType<typeof liveTurn>>,
      requester: CodeThread = thread(),
      /** Other threads on the same checkout, which may start turns of their own. */
      others: ReadonlyArray<CodeThread> = [],
    ) {
      const restoreCheckpoint = vi.fn(async () => ({
        status: "applied" as const,
        undo: { worktree: "e".repeat(40), index: "f".repeat(40) },
      }));
      const checkpoint = vi.fn(async () => ({ status: "unavailable" as const }));
      const start = vi.fn(async () => ({ state: "running" as const }));
      // The runtime has no live turn of its own to stop.
      const cancel = vi.fn(
        async (): Promise<{
          readonly state: "failed" | "interrupted";
          readonly stoppedOperationId?: typeof ids.operation;
        }> => ({ state: "failed" }),
      );
      const append = vi.fn();
      const service = new CodeOperationService({
        authority: {
          readThread: vi.fn(
            (id: CodeThread["id"]) =>
              others.find((other) => String(other.id) === String(id)) ?? requester,
          ),
          readCheckout: vi.fn(() =>
            decodeCodeCheckoutIdentity({
              id: ids.checkout,
              repositoryId: requester.repositoryId,
              kind: "existing-worktree",
              availability: "available",
              head: { kind: "branch", name: "development", oid: "a".repeat(40) },
              observedAt: "2026-07-21T10:00:00.000Z",
            }),
          ),
          canAccessProject: vi.fn(async () => true),
          approvalContextDigest: vi.fn(async () => "a".repeat(64)),
          resolveCheckoutRoot: vi.fn(async () => ({
            checkoutRoot: "/tmp/repo",
            credentialReferences: [],
          })),
        } as never,
        approvals: { validate: vi.fn(async () => true) },
        terminals: {} as never,
        repositoryTests: {} as never,
        git: { restoreCheckpoint, checkpoint } as never,
        pullRequests: {} as never,
        reviewFindings: {} as never,
        turns: {
          start,
          answerInput: vi.fn(),
          answerApproval: vi.fn(),
          cancel,
          threadsWritingIn: (checkoutRoot: string, exceptThreadId: CodeThread["id"]) =>
            live
              .filter((turn) =>
                turnBlocksInPlaceRestore(
                  {
                    threadId: String(turn.thread.id),
                    checkoutRoot: turn.checkoutRoot,
                    state: turn.state,
                    posture: turn.thread.executionPolicy,
                  },
                  { threadId: String(exceptThreadId), checkoutRoot },
                ),
              )
              .map((turn) => turn.thread),
        },
        evidence: { put: vi.fn(), read: vi.fn(async () => "Implement this.") } as never,
        events: {
          replay: vi.fn(() => ({ status: "ok" as const, frames: [], nextCursor: 0 })),
          append,
        } as never,
      });
      return { service, restoreCheckpoint, checkpoint, start, cancel, append };
    }

    it("refuses a restore while another Project's restore is overwriting the same folder", async () => {
      const otherRestorer = decodeCodeThread({
        ...thread(),
        id: decodeCodeThreadId("13131313-1313-4313-8313-131313131313"),
        projectId: otherProject,
      });
      const { service, restoreCheckpoint } = restoreFixture([], thread(), [otherRestorer]);
      const entered = Promise.withResolvers<void>();
      const overwrite = Promise.withResolvers<void>();
      restoreCheckpoint.mockImplementationOnce(async () => {
        entered.resolve();
        await overwrite.promise;
        return { status: "applied", undo: { worktree: "e".repeat(40), index: "f".repeat(40) } };
      });

      const first = service.execute(ids.window, restoreCommand);
      await entered.promise;
      await expect(
        service.execute(ids.window, {
          ...restoreCommand,
          operationId: decodeCodeOperationId("54545454-5454-4545-8545-545454545454"),
          threadId: otherRestorer.id,
        }),
      ).resolves.toMatchObject({
        kind: "operation-failed",
        failure: {
          category: "conflict",
          message:
            "Another restore is overwriting this checkout. Wait for it to finish, then restore.",
        },
      });
      expect(restoreCheckpoint).toHaveBeenCalledOnce();

      overwrite.resolve();
      await expect(first).resolves.toMatchObject({
        kind: "git-mutation-state",
        state: "completed",
      });
    });

    it("makes a turn that starts while another Project restores the same folder wait for the files", async () => {
      const writer = liveTurn({}).thread;
      const restorer = decodeCodeThread({ ...thread(), projectId: otherProject });
      const { service, restoreCheckpoint, checkpoint, start } = restoreFixture([], restorer, [
        writer,
      ]);
      const entered = Promise.withResolvers<void>();
      const overwrite = Promise.withResolvers<void>();
      restoreCheckpoint.mockImplementationOnce(async () => {
        entered.resolve();
        await overwrite.promise;
        return { status: "applied", undo: { worktree: "e".repeat(40), index: "f".repeat(40) } };
      });

      const restoring = service.execute(ids.window, restoreCommand);
      await entered.promise;
      const starting = service.execute(ids.window, { ...startProviderTurn, threadId: writer.id });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(checkpoint).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
      // The waiting turn already holds the folder, so no second overwrite starts.
      await expect(
        service.execute(ids.window, {
          ...restoreCommand,
          operationId: decodeCodeOperationId("54545454-5454-4545-8545-545454545454"),
        }),
      ).resolves.toMatchObject({
        kind: "operation-failed",
        failure: {
          category: "conflict",
          message:
            "A thread in another Project is writing in this checkout. Wait for its turn to finish or stop it, then restore.",
        },
      });

      overwrite.resolve();
      await expect(restoring).resolves.toMatchObject({
        kind: "git-mutation-state",
        state: "completed",
      });
      await expect(starting).resolves.toMatchObject({
        kind: "provider-turn-state",
        state: "running",
      });
      expect(checkpoint).toHaveBeenCalledOnce();
      expect(restoreCheckpoint).toHaveBeenCalledOnce();
    });

    it("captures no checkpoint for a turn stopped while it waited for another Project's restore", async () => {
      const writer = liveTurn({}).thread;
      const restorer = decodeCodeThread({ ...thread(), projectId: otherProject });
      const { service, restoreCheckpoint, checkpoint, start } = restoreFixture([], restorer, [
        writer,
      ]);
      const entered = Promise.withResolvers<void>();
      const overwrite = Promise.withResolvers<void>();
      restoreCheckpoint.mockImplementationOnce(async () => {
        entered.resolve();
        await overwrite.promise;
        return { status: "applied", undo: { worktree: "e".repeat(40), index: "f".repeat(40) } };
      });

      const restoring = service.execute(ids.window, restoreCommand);
      await entered.promise;
      const starting = service.execute(ids.window, { ...startProviderTurn, threadId: writer.id });
      await new Promise((resolve) => setTimeout(resolve, 0));
      await expect(
        service.execute(ids.window, {
          kind: "cancel-provider-turn",
          operationId: decodeCodeOperationId("55555555-5555-4555-8555-555555555555"),
          threadId: writer.id,
          checkoutId: ids.checkout,
        }),
      ).resolves.toMatchObject({ kind: "provider-turn-state", state: "interrupted" });

      overwrite.resolve();
      await restoring;
      await expect(starting).resolves.toMatchObject({
        kind: "provider-turn-state",
        state: "interrupted",
      });
      expect(checkpoint).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
    });

    it.each([
      { live: "another turn", stoppedOperationId: ids.operation, atStop: 1 },
      { live: "the start itself", stoppedOperationId: startProviderTurn.operationId, atStop: 0 },
    ])(
      "journals a preparing start as stopped when Stop also ends $live only if the runtime had not taken it on",
      async ({ stoppedOperationId, atStop }) => {
        const writer = liveTurn({}).thread;
        const restorer = decodeCodeThread({ ...thread(), projectId: otherProject });
        const { service, restoreCheckpoint, cancel, append } = restoreFixture([], restorer, [
          writer,
        ]);
        cancel.mockResolvedValueOnce({ state: "interrupted", stoppedOperationId });
        const entered = Promise.withResolvers<void>();
        const overwrite = Promise.withResolvers<void>();
        restoreCheckpoint.mockImplementationOnce(async () => {
          entered.resolve();
          await overwrite.promise;
          return { status: "applied", undo: { worktree: "e".repeat(40), index: "f".repeat(40) } };
        });
        const startResults = () =>
          append.mock.calls.filter(
            ([input]) =>
              String(input.operationId) === String(startProviderTurn.operationId) &&
              input.event.kind === "operation-result",
          );

        const restoring = service.execute(ids.window, restoreCommand);
        await entered.promise;
        const starting = service.execute(ids.window, { ...startProviderTurn, threadId: writer.id });
        await new Promise((resolve) => setTimeout(resolve, 0));
        await service.execute(ids.window, {
          kind: "cancel-provider-turn",
          operationId: decodeCodeOperationId("55555555-5555-4555-8555-555555555555"),
          threadId: writer.id,
          checkoutId: ids.checkout,
        });
        expect(startResults()).toHaveLength(atStop);

        overwrite.resolve();
        await restoring;
        await expect(starting).resolves.toMatchObject({
          kind: "provider-turn-state",
          state: "interrupted",
        });
        expect(startResults()).toHaveLength(1);
        expect(startResults()[0]?.[0].event.result).toMatchObject({ state: "interrupted" });
      },
    );

    it("refuses to restore while another thread is writing in the same checkout and names it", async () => {
      const { service, restoreCheckpoint } = restoreFixture([liveTurn({})]);

      await expect(service.execute(ids.window, restoreCommand)).resolves.toMatchObject({
        kind: "operation-failed",
        failure: {
          category: "conflict",
          message:
            'Another thread is writing in this checkout: "Rewrite the parser". Wait for its turn to finish or stop it, then restore.',
        },
      });
      expect(restoreCheckpoint).not.toHaveBeenCalled();
    });

    it("refuses while another thread's turn waits on an approval", async () => {
      const { service, restoreCheckpoint } = restoreFixture([liveTurn({ state: "waiting" })]);

      await expect(service.execute(ids.window, restoreCommand)).resolves.toMatchObject({
        kind: "operation-failed",
        failure: { category: "conflict" },
      });
      expect(restoreCheckpoint).not.toHaveBeenCalled();
    });

    it("does not name a writing thread that belongs to another Project", async () => {
      const { service, restoreCheckpoint } = restoreFixture([
        liveTurn({ projectId: otherProject, title: "Private plans" }),
      ]);

      const result = await service.execute(ids.window, restoreCommand);

      expect(result).toMatchObject({
        kind: "operation-failed",
        failure: {
          category: "conflict",
          message:
            "A thread in another Project is writing in this checkout. Wait for its turn to finish or stop it, then restore.",
        },
      });
      expect(JSON.stringify(result)).not.toContain("Private plans");
      expect(restoreCheckpoint).not.toHaveBeenCalled();
    });

    it("restores when the other thread's turn is a Plan turn", async () => {
      const { service, restoreCheckpoint } = restoreFixture([liveTurn({ posture: "plan" })]);

      await expect(service.execute(ids.window, restoreCommand)).resolves.toMatchObject({
        kind: "git-mutation-state",
        state: "completed",
      });
      expect(restoreCheckpoint).toHaveBeenCalledOnce();
    });

    it("restores when the other thread works in a different checkout root", async () => {
      const { service, restoreCheckpoint } = restoreFixture([
        liveTurn({ checkoutRoot: "/tmp/repo-worktree" }),
      ]);

      await expect(service.execute(ids.window, restoreCommand)).resolves.toMatchObject({
        kind: "git-mutation-state",
        state: "completed",
      });
      expect(restoreCheckpoint).toHaveBeenCalledOnce();
    });

    it("restores when the only live turn is the requesting thread's own", async () => {
      const { service, restoreCheckpoint } = restoreFixture([liveTurn({ threadId: ids.thread })]);

      await expect(service.execute(ids.window, restoreCommand)).resolves.toMatchObject({
        kind: "git-mutation-state",
        state: "completed",
      });
      expect(restoreCheckpoint).toHaveBeenCalledOnce();
    });

    it("never restores from a Plan thread", async () => {
      const planThread = decodeCodeThread({ ...thread(), executionPolicy: "plan" });
      const { service, restoreCheckpoint } = restoreFixture([], planThread);

      await expect(service.execute(ids.window, restoreCommand)).resolves.toMatchObject({
        kind: "operation-failed",
      });
      expect(restoreCheckpoint).not.toHaveBeenCalled();
    });
  });

  it("refuses a host turn revoked while its checkout checkpoint is being prepared", async () => {
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    let current = true;
    const fixture = providerTurnFixture();
    fixture.git.checkpoint.mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return { status: "failed" };
    });

    const pending = fixture.service.execute(ids.window, startProviderTurn, {
      admissionCurrent: () => current,
    });
    await entered.promise;
    current = false;
    release.resolve();

    await expect(pending).resolves.toMatchObject({
      kind: "operation-failed",
      admission: "refused",
      failure: { category: "unauthorized" },
    });
    expect(fixture.turns.start).not.toHaveBeenCalled();
    expect(fixture.events.append).not.toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({ kind: "conversation-turn-started" }),
      }),
    );
  });

  it("fails a recorded host turn revoked while its prompt is loading without starting it", async () => {
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    let current = true;
    const takeProductFeedbackForTurn = vi.fn(() => ({ attachments: [] }));
    const fixture = providerTurnFixture({ takeProductFeedbackForTurn });
    fixture.evidence.read.mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return "does this still hold?";
    });

    const pending = fixture.service.execute(ids.window, startProviderTurn, {
      admissionCurrent: () => current,
    });
    await entered.promise;
    expect(fixture.events.append).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({ kind: "conversation-turn-started" }),
      }),
    );
    current = false;
    release.resolve();

    await expect(pending).resolves.toMatchObject({
      kind: "operation-failed",
      admission: "refused",
      failure: { category: "unauthorized" },
    });
    expect(fixture.turns.start).not.toHaveBeenCalled();
    expect(takeProductFeedbackForTurn).not.toHaveBeenCalled();
    expect(fixture.events.append).toHaveBeenLastCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          kind: "operation-result",
          result: expect.objectContaining({
            kind: "operation-failed",
            admission: "refused",
            failure: expect.objectContaining({ category: "unauthorized" }),
          }),
        }),
      }),
    );
  });

  it("retains pending issue context after refused admission until a later turn starts", async () => {
    const consumeIssueContextFramed = vi.fn();
    const fixture = providerTurnFixture({ consumeIssueContextFramed });
    fixture.turns.start.mockResolvedValueOnce({
      state: "failed",
      admission: "refused",
      failure: { category: "unauthorized", message: "Turn admission is no longer current." },
    });

    await expect(fixture.service.execute(ids.window, startProviderTurn)).resolves.toMatchObject({
      kind: "provider-turn-state",
      admission: "refused",
    });
    expect(consumeIssueContextFramed).not.toHaveBeenCalled();

    await expect(
      fixture.service.execute(ids.window, {
        ...startProviderTurn,
        operationId: decodeCodeOperationId("56565656-5656-4565-8565-565656565656"),
      }),
    ).resolves.toMatchObject({ kind: "provider-turn-state", state: "running" });
    expect(consumeIssueContextFramed).toHaveBeenCalledExactlyOnceWith(String(ids.thread));
  });

  it("carries a waiting agent message in the turn's context and records it delivered only when told a provider accepted the turn", async () => {
    const waiting = [{ messageId: "message-1", text: "<framed agent message>" }];
    const carryAgentMessages = vi.fn(async () => waiting);
    const confirmAgentMessagesDelivered = vi.fn(async () => undefined);
    const fixture = providerTurnFixture({ carryAgentMessages, confirmAgentMessagesDelivered });

    await expect(fixture.service.execute(ids.window, startProviderTurn)).resolves.toMatchObject({
      kind: "provider-turn-state",
      state: "running",
    });

    expect(carryAgentMessages).toHaveBeenCalledWith(String(ids.thread));
    const start = fixture.turns.start.mock.lastCall?.[0];
    expect(start?.context).toEqual(
      expect.arrayContaining([{ kind: "user-message", text: "<framed agent message>" }]),
    );
    // A turn the runtime took on has sent nothing yet: the context is still
    // in memory, so the message stays waiting until the runtime reports the
    // provider has it.
    expect(confirmAgentMessagesDelivered).not.toHaveBeenCalled();
    start?.onContextDelivered?.();
    expect(confirmAgentMessagesDelivered).toHaveBeenCalledExactlyOnceWith(["message-1"]);
  });

  it("starts the person's turn without agent messages when they cannot be read", async () => {
    const confirmAgentMessagesDelivered = vi.fn(async () => undefined);
    const fixture = providerTurnFixture({
      carryAgentMessages: async () => {
        throw new Error("The message journal is unavailable.");
      },
      confirmAgentMessagesDelivered,
    });

    await expect(fixture.service.execute(ids.window, startProviderTurn)).resolves.toMatchObject({
      kind: "provider-turn-state",
      state: "running",
    });
    expect(confirmAgentMessagesDelivered).not.toHaveBeenCalled();
  });

  it("sends the images the journal recorded, and refuses ones no turn may claim", async () => {
    const reference = {
      attachmentId: "40000000-0000-4000-8000-000000000001",
      displayName: "shot.png",
      mediaType: "image/png" as const,
      byteLength: 3,
      digest: "b".repeat(64),
    };
    const bytes = new Uint8Array([1, 2, 3]);
    const attachments = {
      peek: (_threadId: unknown, requested: ReadonlyArray<string>) =>
        requested.every((id) => String(id) === reference.attachmentId)
          ? { status: "ok" as const, attachments: [reference] }
          : { status: "unknown" as const, attachmentId: requested[0]! },
      release: vi.fn(),
      read: vi.fn(async () => bytes),
    };
    let supported = true;
    const { service, turns, events } = providerTurnFixture({
      attachments: attachments as never,
      supportsAttachments: () => supported,
    });
    const turn = (attachmentIds: ReadonlyArray<string>, operationId: string) =>
      ({
        ...startProviderTurn,
        operationId: decodeCodeOperationId(operationId),
        attachmentIds,
      }) as never;
    const journalled = () =>
      events.append.mock.calls
        .map(([entry]) => (entry as { readonly event: { readonly kind: string } }).event)
        .filter((event) => event.kind === "conversation-turn-started");

    // An id this host never staged is refused before anything reaches the
    // provider, and before the turn's start is journalled.
    await expect(
      service.execute(
        ids.window,
        turn(["40000000-0000-4000-8000-000000000009"], "70000000-0000-4000-8000-000000000001"),
      ),
    ).resolves.toMatchObject({ kind: "operation-failed", failure: { category: "invalid" } });
    expect(turns.start).not.toHaveBeenCalled();
    expect(journalled()).toHaveLength(0);

    // A provider that cannot take a picture is told so rather than sent the
    // turn with its images silently removed.
    supported = false;
    await expect(
      service.execute(
        ids.window,
        turn([reference.attachmentId], "70000000-0000-4000-8000-000000000002"),
      ),
    ).resolves.toMatchObject({ kind: "operation-failed", failure: { category: "invalid" } });
    expect(turns.start).not.toHaveBeenCalled();

    supported = true;
    await expect(
      service.execute(
        ids.window,
        turn([reference.attachmentId], "70000000-0000-4000-8000-000000000003"),
      ),
    ).resolves.toMatchObject({ kind: "provider-turn-state", state: "running" });
    expect(turns.start).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [
          {
            attachmentId: reference.attachmentId,
            displayName: "shot.png",
            mediaType: "image/png",
            bytes,
          },
        ],
      }),
    );
    // The journal names the image by what the host measured, never its bytes.
    expect(journalled().at(-1)).toMatchObject({ attachments: [reference] });
  });

  it("refuses a Code follow-up when its Project provider policy no longer accepts it", async () => {
    const fixture = providerTurnFixture({ isProviderModelAllowed: () => false });

    await expect(fixture.service.execute(ids.window, startProviderTurn)).resolves.toMatchObject({
      kind: "operation-failed",
      failure: {
        category: "unauthorized",
        message: "This provider or model is not allowed by this Code Project's provider policy.",
      },
    });
    expect(fixture.turns.start).not.toHaveBeenCalled();
    expect(fixture.events.append).not.toHaveBeenCalled();
  });

  it("runs only a definition the server discovered for the checkout", async () => {
    const discovered = {
      id: "abcdabcd-abcd-4bcd-8bcd-abcdabcdabcd",
      name: "test",
      source: {
        kind: "package-script" as const,
        packagePath: "package.json",
        packageManager: "bun" as const,
        script: "test",
      },
      argv: ["bun", "run", "test"],
      cwd: ".",
      environmentRefs: [],
      timeoutMs: 900_000,
      artifactPaths: [],
    };
    const forged = { ...discovered, argv: ["bun", "run", "publish-secrets"] };
    const run = vi.fn(async (input: { readonly definition: unknown }) => ({
      id: testRunId,
      definition: input.definition,
      threadId: ids.thread,
      checkoutId: ids.checkout,
      checkoutRevision: "a".repeat(40),
      executionPolicy: "full-access",
      startedAt: "2026-08-15T08:00:00.000Z",
      completedAt: "2026-08-15T08:01:00.000Z",
      exitCode: 0,
      termination: "exited",
      stdout: { text: "ok", byteLength: 2, truncated: false },
      stderr: { text: "", byteLength: 0, truncated: false },
      artifacts: [],
      verdict: "passed",
      concerns: [],
    }));
    const service = new CodeOperationService({
      authority: {
        readThread: vi.fn(() => thread()),
        readCheckout: vi.fn(() =>
          decodeCodeCheckoutIdentity({
            id: ids.checkout,
            repositoryId: thread().repositoryId,
            kind: "existing-worktree",
            availability: "available",
            head: { kind: "branch", name: "development", oid: "a".repeat(40) },
            observedAt: "2026-08-15T08:00:00.000Z",
          }),
        ),
        canAccessProject: vi.fn(async () => true),
        resolveCheckoutRoot: vi.fn(async () => ({
          checkoutRoot: "/repo",
          shell: "/bin/zsh",
          credentialReferences: [],
          environment: {},
        })),
      } as never,
      approvals: { validate: vi.fn(async () => true) },
      terminals: {} as never,
      repositoryTests: { discover: vi.fn(async () => [discovered]), run, cancel: vi.fn() } as never,
      git: {} as never,
      pullRequests: {} as never,
      reviewFindings: {} as never,
      turns: {} as never,
      evidence: {
        put: vi.fn(() =>
          decodeCodeEvidenceReference({
            contentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            digest: "c".repeat(64),
            byteLength: 3,
          }),
        ),
      } as never,
      events: {
        append: vi.fn(),
        replay: vi.fn(() => ({ status: "ok" as const, frames: [], nextCursor: 0 })),
      } as never,
    });
    const command = (definition: unknown) =>
      ({
        kind: "run-repository-test",
        operationId: ids.operation,
        threadId: ids.thread,
        checkoutId: ids.checkout,
        testRunId,
        definition,
      }) as never;

    await expect(service.execute(ids.window, command(forged))).resolves.toMatchObject({
      kind: "operation-failed",
      failure: {
        category: "unauthorized",
        message: "Repository test definition was not discovered in this checkout.",
      },
    });
    expect(run).not.toHaveBeenCalled();

    await expect(service.execute(ids.window, command(discovered))).resolves.toMatchObject({
      kind: "repository-test-state",
      state: "completed",
      verdict: "passed",
    });
    expect(run).toHaveBeenCalledOnce();
  });

  it("resolves a Code turn's `#thread` mentions on the host and journals only what the user typed", async () => {
    const asked: Array<{
      threadMentionIds: ReadonlyArray<string>;
      readerThreadId: string;
      windowId: string;
    }> = [];
    const fixture = providerTurnFixture({
      resolveThreadMentionContext: async (input) => {
        asked.push({
          threadMentionIds: input.threadMentionIds.map(String),
          readerThreadId: input.readerThreadId,
          windowId: String(input.windowId),
        });
        return input.threadMentionIds.map((threadId) => ({
          kind: "resolved" as const,
          threadId,
          text: "Read-only context from other threads.\n\nReferenced thread: Release notes (chat, Recents)\nuser: ship the notes",
        }));
      },
    });

    await expect(
      fixture.service.execute(ids.window, {
        ...startProviderTurn,
        threadMentionIds: ["release-notes-thread"],
      }),
    ).resolves.toMatchObject({ kind: "provider-turn-state", state: "running" });

    // Ids only: the transcript is read by the host on this send's own window,
    // never taken from the command, and the thread reading it is the turn's own.
    expect(asked).toEqual([
      {
        threadMentionIds: ["release-notes-thread"],
        readerThreadId: String(ids.thread),
        windowId: ids.window,
      },
    ]);
    const started = fixture.turns.start.mock.calls[0]![0];
    expect((started.context ?? []).map((block) => block.text).join("\n")).toContain(
      "Referenced thread: Release notes",
    );
    // The durable message is exactly what the user typed: the prompt the
    // provider is sent, and the prompt evidence the journal records, carry no
    // trace of the thread the chip named.
    expect(started.prompt).toBe("does this still hold?");
    expect(fixture.events.append).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          kind: "conversation-turn-started",
          prompt: startProviderTurn.prompt,
        }),
      }),
    );
  });

  it("takes no restore point on a Plan turn, which may write nothing", async () => {
    const checkpoint = vi.fn(async () => ({ status: "failed" as const }));
    const planning = providerTurnFixture({
      thread: decodeCodeThread({ ...thread(), executionPolicy: "plan" }),
      git: { checkpoint } as never,
    });

    await expect(planning.service.execute(ids.window, startProviderTurn)).resolves.toMatchObject({
      kind: "provider-turn-state",
      state: "running",
    });

    // Capturing one stages the tree into a scratch index and writes trees into
    // the object database. Plan mode promises the repository is not written to,
    // and a turn that changes no file has nothing to restore anyway.
    expect(checkpoint).not.toHaveBeenCalled();

    const editing = providerTurnFixture({ git: { checkpoint } as never });
    await expect(editing.service.execute(ids.window, startProviderTurn)).resolves.toMatchObject({
      kind: "provider-turn-state",
    });
    expect(checkpoint).toHaveBeenCalledOnce();
  });

  it("forwards the thread execution policy into git mutations", async () => {
    const stage = vi.fn(async () => ({ status: "applied" as const }));
    const fixture = providerTurnFixture({
      git: { stage } as never,
    });

    await expect(
      fixture.service.execute(ids.window, {
        kind: "stage-git",
        operationId: decodeCodeOperationId("52525252-5252-4525-8525-525252525252"),
        threadId: ids.thread,
        checkoutId: ids.checkout,
        gitOperationId: decodeCodeOperationId("53535353-5353-4535-8535-535353535353"),
        paths: ["src/file.ts"],
        expectedStateToken: "f".repeat(64),
      }),
    ).resolves.toMatchObject({ kind: "git-mutation-state", state: "completed" });
    expect(stage).toHaveBeenCalledWith(
      expect.objectContaining({
        executionPolicy: "full-access",
        paths: ["src/file.ts"],
      }),
    );
  });

  it("sends snapshotted profile instructions with the Code turn", async () => {
    const fixture = providerTurnFixture({
      thread: decodeCodeThread({
        ...thread(),
        profileId: "60000000-0000-4000-8000-000000000001",
        profileContext: {
          displayName: "Reviewer",
          instructions: "Review as a skeptic.",
          approvedSkillIds: ["code-reviewer"],
        },
      }),
      resolveProfileSkills: vi.fn(async () => [
        {
          qualifiedId: "agents-skills-directory:project:code-reviewer:sha256:aa",
          displayName: "Code reviewer",
          text: "Review diffs in isolation.",
        },
      ]),
    });

    await expect(fixture.service.execute(ids.window, startProviderTurn)).resolves.toMatchObject({
      kind: "provider-turn-state",
    });
    expect(fixture.turns.start.mock.calls[0]![0].context).toEqual([
      { kind: "instructions", text: "Review as a skeptic." },
      { kind: "instructions", text: "Review diffs in isolation." },
    ]);
  });

  it("leaves a Code turn without a profile unchanged", async () => {
    const resolveProfileSkills = vi.fn(async () => [
      {
        qualifiedId: "agents-skills-directory:project:code-reviewer:sha256:aa",
        displayName: "Code reviewer",
        text: "should never load",
      },
    ]);
    const fixture = providerTurnFixture({ resolveProfileSkills });

    await expect(fixture.service.execute(ids.window, startProviderTurn)).resolves.toMatchObject({
      kind: "provider-turn-state",
    });
    expect(resolveProfileSkills).not.toHaveBeenCalled();
    expect(fixture.turns.start.mock.calls[0]![0].context).toBeUndefined();
  });

  it("does not load an approved skill the resolver refused", async () => {
    const resolveProfileSkills = vi.fn(async () => []);
    const fixture = providerTurnFixture({
      thread: decodeCodeThread({
        ...thread(),
        profileId: "60000000-0000-4000-8000-000000000001",
        profileContext: {
          displayName: "Reviewer",
          approvedSkillIds: ["missing-skill"],
        },
      }),
      resolveProfileSkills,
    });

    await expect(fixture.service.execute(ids.window, startProviderTurn)).resolves.toMatchObject({
      kind: "provider-turn-state",
    });
    expect(resolveProfileSkills).toHaveBeenCalledWith({
      approvedSkillIds: ["missing-skill"],
      threadId: String(thread().id),
      projectId: String(thread().projectId),
    });
    expect(fixture.turns.start.mock.calls[0]![0].context).toBeUndefined();
  });

  it("sends approved selected skill instructions to the Code provider", async () => {
    const fixture = providerTurnFixture({
      resolveSelectedExtensions: async () => ({
        kind: "resolved",
        context: [{ kind: "instructions", text: "Use the synthetic project review checklist." }],
      }),
    });
    const result = await fixture.service.execute(ids.window, {
      ...startProviderTurn,
      extensionSelections: [
        {
          kind: "skill",
          skillId: `agents-skills-directory:project:review:sha256:${"a".repeat(64)}`,
          packageDigest: `sha256:${"a".repeat(64)}`,
          catalogEpoch: `sha256:${"b".repeat(64)}`,
          origin: { kind: "draft", reference: "review" },
        },
      ],
    });
    expect(result.kind).toBe("provider-turn-state");
    expect(fixture.turns.start.mock.calls[0]?.[0].context).toContainEqual({
      kind: "instructions",
      text: "Use the synthetic project review checklist.",
    });
  });

  it("hands a selected MCP server's tools to the Code turn and resolves them in the turn's window", async () => {
    const tools = {
      definitions: [{ name: "notes_search", inputSchema: { type: "object" } }],
      execute: async () => ({ result: "framed notes" }),
    };
    const resolveSelectedExtensions = vi.fn(async () => ({
      kind: "resolved" as const,
      context: [],
      tools,
    }));
    const fixture = providerTurnFixture({ resolveSelectedExtensions });
    const result = await fixture.service.execute(ids.window, {
      ...startProviderTurn,
      extensionSelections: [
        {
          kind: "plugin",
          extensionId: "94000000-0000-4000-8000-000000000011",
          packageId: "94000000-0000-4000-8000-000000000012",
          componentId: "notes-server",
          packageVersion: "1.0.0",
          packageDigest: `sha256:${"a".repeat(64)}`,
          catalogEpoch: `sha256:${"b".repeat(64)}`,
          origin: { kind: "draft", reference: "notes" },
        },
      ],
    });
    expect(result.kind).toBe("provider-turn-state");
    expect(resolveSelectedExtensions).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "code", windowId: ids.window }),
    );
    expect(fixture.turns.start.mock.calls[0]?.[0].extensionTools).toBe(tools);
  });

  it("refuses a connector selected for a thread on an SSH target before any extension starts", async () => {
    // A connector's tools run on this host; a remote turn has only the
    // harness's tools on the target, so a selection used to be started and
    // then dropped from the turn without a word.
    const resolveSelectedExtensions = vi.fn(async () => ({
      kind: "resolved" as const,
      context: [],
      tools: { definitions: [], execute: async () => ({ result: "" }) },
    }));
    const fixture = providerTurnFixture({
      resolveSelectedExtensions,
      remoteRoot: true,
      thread: decodeCodeThread({ ...thread(), executionPolicy: "approval-gated" }),
    });
    const result = await fixture.service.execute(ids.window, {
      ...startProviderTurn,
      extensionSelections: [
        {
          kind: "plugin",
          extensionId: "94000000-0000-4000-8000-000000000011",
          packageId: "94000000-0000-4000-8000-000000000012",
          componentId: "notes-server",
          packageVersion: "1.0.0",
          packageDigest: `sha256:${"a".repeat(64)}`,
          catalogEpoch: `sha256:${"b".repeat(64)}`,
          origin: { kind: "draft", reference: "notes" },
        },
      ],
    });
    expect(result).toMatchObject({
      kind: "operation-failed",
      failure: { category: "unavailable", message: REMOTE_CODE_THREAD_CONNECTORS_UNAVAILABLE },
    });
    expect(resolveSelectedExtensions).not.toHaveBeenCalled();
    expect(fixture.turns.start).not.toHaveBeenCalled();
  });

  // A remote turn takes no checkpoint, so an edit made there without review
  // has no way back. Creating or raising a thread to these postures is refused,
  // but a thread created before that rule still holds one, and the turn itself
  // must refuse to run in it.
  it.each(["auto-accept-edits", "full-access"] as const)(
    "refuses a turn on a thread on an SSH target that holds %s before anything starts or is journaled",
    async (executionPolicy) => {
      const fixture = providerTurnFixture({
        remoteRoot: true,
        thread: decodeCodeThread({
          ...thread(),
          executionPolicy,
          permissionPersistence: "project-default",
        }),
      });
      const result = await fixture.service.execute(ids.window, startProviderTurn);
      expect(result).toMatchObject({
        kind: "operation-failed",
        admission: "refused",
        failure: {
          category: "unauthorized",
          message: remoteCodeThreadPostureRefusal(executionPolicy),
        },
      });
      expect(fixture.turns.start).not.toHaveBeenCalled();
      expect(fixture.events.append).not.toHaveBeenCalled();
    },
  );

  it("refuses a turn on a thread on an SSH target that this window holds in session Full access", async () => {
    const sessions = new CodeSessionAuthorityStore();
    sessions.grantFullAccess(ids.window, ids.thread);
    const fixture = providerTurnFixture({
      remoteRoot: true,
      thread: decodeCodeThread({ ...thread(), executionPolicy: "approval-gated" }),
      effectiveThread: (windowId, stored) => sessions.effectiveThread(windowId, stored),
    });
    const result = await fixture.service.execute(ids.window, startProviderTurn);
    expect(result).toMatchObject({
      kind: "operation-failed",
      failure: { message: remoteCodeThreadPostureRefusal("full-access") },
    });
    expect(fixture.turns.start).not.toHaveBeenCalled();
    expect(fixture.events.append).not.toHaveBeenCalled();
  });

  it("runs a turn that asks for approvals on a thread on an SSH target that holds Auto-accept edits", async () => {
    // The turn runs in the narrower posture it asks for, so each edit is
    // still approved; only a turn that would run unreviewed is refused.
    const fixture = providerTurnFixture({
      remoteRoot: true,
      thread: decodeCodeThread({ ...thread(), executionPolicy: "auto-accept-edits" }),
    });
    const result = await fixture.service.execute(ids.window, {
      ...startProviderTurn,
      executionPolicy: "approval-gated",
    });
    expect(result).toMatchObject({ kind: "provider-turn-state", state: "running" });
    expect(fixture.turns.start.mock.calls[0]?.[0].thread.executionPolicy).toBe("approval-gated");
  });

  it("refuses an answer that would continue a turn on a thread on an SSH target holding Auto-accept edits", async () => {
    const fixture = providerTurnFixture({
      remoteRoot: true,
      thread: decodeCodeThread({ ...thread(), executionPolicy: "auto-accept-edits" }),
    });
    const result = await fixture.service.execute(ids.window, {
      kind: "answer-provider-approval",
      operationId: decodeCodeOperationId("49494949-4949-4494-8494-494949494949"),
      threadId: ids.thread,
      checkoutId: ids.checkout,
      approvalId: "50505050-5050-4050-8050-505050505050",
      decision: "approved",
    });
    expect(result).toMatchObject({
      kind: "operation-failed",
      failure: { message: remoteCodeThreadPostureRefusal("auto-accept-edits") },
    });
    expect(fixture.turns.answerApproval).not.toHaveBeenCalled();
    expect(fixture.events.append).not.toHaveBeenCalled();
  });

  it("refuses a selected skill before Code provider execution when no material resolver exists", async () => {
    const fixture = providerTurnFixture();
    const result = await fixture.service.execute(ids.window, {
      ...startProviderTurn,
      extensionSelections: [
        {
          kind: "skill",
          skillId: `agents-skills-directory:project:review:sha256:${"a".repeat(64)}`,
          packageDigest: `sha256:${"a".repeat(64)}`,
          catalogEpoch: `sha256:${"b".repeat(64)}`,
          origin: { kind: "draft", reference: "review" },
        },
      ],
    });
    expect(result).toMatchObject({
      kind: "operation-failed",
      failure: {
        category: "unavailable",
        message: "Selected extension is unavailable for Code on this host.",
      },
    });
    expect(fixture.turns.start).not.toHaveBeenCalled();
  });

  it("keeps using the snapshotted instructions after the live profile would have changed", async () => {
    const fixture = providerTurnFixture({
      thread: decodeCodeThread({
        ...thread(),
        profileId: "60000000-0000-4000-8000-000000000001",
        profileContext: {
          displayName: "Reviewer",
          instructions: "Review as a skeptic.",
          approvedSkillIds: [],
        },
      }),
    });

    await expect(fixture.service.execute(ids.window, startProviderTurn)).resolves.toMatchObject({
      kind: "provider-turn-state",
    });
    expect(fixture.turns.start.mock.calls[0]![0].context).toEqual([
      { kind: "instructions", text: "Review as a skeptic." },
    ]);
  });

  it("does not carry a Code turn's mention context into the next turn", async () => {
    const fixture = providerTurnFixture({
      resolveThreadMentionContext: async (input) =>
        input.threadMentionIds.map((threadId) => ({
          kind: "resolved" as const,
          threadId,
          text: "Referenced thread: Release notes (chat, Recents)\nuser: ship the notes",
        })),
    });

    await fixture.service.execute(ids.window, {
      ...startProviderTurn,
      threadMentionIds: ["release-notes-thread"],
    });
    await fixture.service.execute(ids.window, {
      ...startProviderTurn,
      operationId: decodeCodeOperationId("49494949-4949-4494-8494-494949494949"),
      sessionId: "60606060-6060-4060-8060-606060606061",
    });

    // A mention is context for the turn that made it. The follow-up that named
    // no thread is sent with no mention context at all.
    const second = fixture.turns.start.mock.calls[1]![0];
    expect(second.context).toBeUndefined();
    expect(second.prompt).toBe("does this still hold?");
  });

  it("says a Code mention could not be read rather than quoting a thread the sender may not open", async () => {
    const fixture = providerTurnFixture({
      resolveThreadMentionContext: async (input) =>
        input.threadMentionIds.map((threadId) => ({ kind: "unreadable" as const, threadId })),
    });

    await fixture.service.execute(ids.window, {
      ...startProviderTurn,
      threadMentionIds: ["release-notes-thread"],
    });

    const started = fixture.turns.start.mock.calls[0]![0];
    const context = (started.context ?? []).map((block) => block.text).join("\n");
    expect(context).toContain("could not be read");
    expect(context).not.toContain("Referenced thread");
    expect(started.prompt).toBe("does this still hold?");
  });

  it("refuses a Code turn that claims to deliver a subagent result the journal does not back", async () => {
    const fixture = providerTurnFixture();
    await expect(
      fixture.service.execute(ids.window, {
        ...startProviderTurn,
        delivery: { kind: "agent-result", runId: "d6a1b000-0000-4000-8000-000000000099" },
      }),
    ).resolves.toMatchObject({
      kind: "operation-failed",
      failure: { category: "invalid" },
    });
    expect(fixture.turns.start).not.toHaveBeenCalled();
    expect(fixture.events.append).not.toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({ kind: "conversation-turn-started" }),
      }),
    );
  });

  it("replays the admitted group while deferring new siblings and admits the child's next generation separately", async () => {
    const first = codeRunFor(ids.thread);
    const second = codeRunFor(ids.thread, { id: "d6a1b000-0000-4000-8000-000000000005" });
    const third = codeRunFor(ids.thread, { id: "d6a1b000-0000-4000-8000-000000000006" });
    const runs = new Map([first, second, third].map((run) => [run.id, run]));
    const fixture = providerTurnFixture({
      recordEvents: true,
      agentRuns: { getById: (id) => runs.get(id) },
    });
    const delivery = { kind: "agent-result", runId: first.id, runIds: [first.id, second.id] };
    for (const invalid of [
      codeRunFor(String(third.id), { id: second.id }),
      { ...second, lifecycleStatus: "running" as const },
    ]) {
      runs.set(second.id, invalid);
      await expect(
        fixture.service.execute(ids.window, { ...startProviderTurn, delivery }),
      ).resolves.toMatchObject({ kind: "operation-failed", failure: { category: "invalid" } });
    }
    expect(fixture.turns.start).not.toHaveBeenCalled();
    runs.set(second.id, second);
    await expect(
      fixture.service.execute(ids.window, { ...startProviderTurn, delivery }),
    ).resolves.toMatchObject({ kind: "provider-turn-state", delivery });
    runs.set(first.id, {
      ...first,
      resultDelivery: { outcome: "delivered", settledAt: first.updatedAt },
    });
    const next = {
      ...startProviderTurn,
      operationId: decodeCodeOperationId("74747474-7474-4474-8474-747474747474"),
    };
    await expect(
      fixture.service.execute(ids.window, {
        ...next,
        delivery: { kind: "agent-result", runId: second.id, runIds: [second.id, third.id] },
      }),
    ).resolves.toMatchObject({
      kind: "provider-turn-state",
      operationId: startProviderTurn.operationId,
      delivery,
    });
    expect(fixture.turns.start).toHaveBeenCalledTimes(1);
    await expect(
      fixture.service.execute(ids.window, {
        ...next,
        delivery: { kind: "agent-result", runId: third.id },
      }),
    ).resolves.toMatchObject({ kind: "operation-failed", failure: { category: "waiting" } });
    fixture.events.append({
      threadId: ids.thread,
      operationId: startProviderTurn.operationId,
      expectedCursor: 3,
      event: { kind: "operation-state", state: "completed" },
    });
    const resumed = { ...first, generation: 2 };
    runs.set(first.id, resumed);
    await expect(
      fixture.service.execute(ids.window, { ...startProviderTurn, delivery }),
    ).resolves.toMatchObject({ kind: "operation-failed", failure: { category: "invalid" } });
    const newDelivery = {
      kind: "agent-result",
      runId: first.id,
      runGenerations: [{ runId: first.id, generation: 2 }],
    };
    await expect(
      fixture.service.execute(ids.window, { ...next, delivery: newDelivery }),
    ).resolves.toMatchObject({ kind: "provider-turn-state", delivery: newDelivery });
    expect(fixture.turns.start).toHaveBeenCalledTimes(2);
  });

  it("recovers an admitted delivery operation through the existing provider recovery path", async () => {
    const run = codeRunFor(ids.thread);
    const delivery = { kind: "agent-result" as const, runId: run.id };
    const fixture = providerTurnFixture({ recordEvents: true, agentRuns: { getById: () => run } });
    const parent = thread();
    fixture.events.append({
      threadId: ids.thread,
      operationId: startProviderTurn.operationId,
      expectedCursor: 0,
      event: {
        kind: "conversation-turn-started",
        providerInstanceId: parent.providerInstanceId,
        modelId: parent.modelId,
        sessionId: decodeProviderSessionId(startProviderTurn.sessionId),
        prompt: startProviderTurn.prompt,
        executionPolicy: parent.executionPolicy,
        delivery,
      },
    });
    fixture.events.append({
      threadId: ids.thread,
      operationId: startProviderTurn.operationId,
      expectedCursor: 1,
      event: {
        kind: "operation-result",
        result: {
          kind: "provider-turn-state",
          operationId: startProviderTurn.operationId,
          state: "running",
          delivery,
        },
      },
    });
    await expect(
      fixture.service.execute(ids.window, { ...startProviderTurn, delivery }),
    ).resolves.toMatchObject({ kind: "provider-turn-state", delivery });
    expect(fixture.turns.start).toHaveBeenCalledTimes(1);
    expect(
      fixture.events
        .historyForThread()
        .frames.filter((frame) => frame.event.kind === "conversation-turn-started"),
    ).toHaveLength(1);
  });

  it("admits a delivery turn the journaled run backs and journals its mark", async () => {
    const run = codeRunFor(ids.thread);
    const fixture = providerTurnFixture({
      agentRuns: { getById: (runId) => (String(runId) === String(run.id) ? run : undefined) },
    });
    await expect(
      fixture.service.execute(ids.window, {
        ...startProviderTurn,
        delivery: { kind: "agent-result", runId: run.id },
      }),
    ).resolves.toMatchObject({ kind: "provider-turn-state", state: "running" });
    expect(fixture.events.append).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          kind: "conversation-turn-started",
          delivery: { kind: "agent-result", runId: run.id },
        }),
      }),
    );
  });

  it("leaves a Code turn without mentions untouched by the mention resolver", async () => {
    const resolveThreadMentionContext = vi.fn(async () => []);
    const fixture = providerTurnFixture({ resolveThreadMentionContext });

    await fixture.service.execute(ids.window, startProviderTurn);

    expect(resolveThreadMentionContext).not.toHaveBeenCalled();
    expect(fixture.turns.start).toHaveBeenCalledWith({
      windowId: ids.window,
      thread: thread(),
      operationId: startProviderTurn.operationId,
      sessionId: startProviderTurn.sessionId,
      checkoutRoot: "/private/exact-checkout",
      prompt: "does this still hold?",
      // Always present: stopping a turn that is still preparing refuses it here.
      admissionCurrent: expect.any(Function),
    });
  });

  it("clamps a composer posture that exceeds the thread and records the posture the turn ran under", async () => {
    const fixture = providerTurnFixture({
      thread: decodeCodeThread({ ...thread(), executionPolicy: "approval-gated" }),
    });

    await expect(
      fixture.service.execute(ids.window, {
        ...startProviderTurn,
        executionPolicy: "full-access",
      }),
    ).resolves.toMatchObject({ kind: "provider-turn-state", state: "running" });

    expect(fixture.turns.start).toHaveBeenCalledWith(
      expect.objectContaining({
        thread: expect.objectContaining({ executionPolicy: "approval-gated" }),
      }),
    );
    expect(fixture.events.append).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          kind: "conversation-turn-started",
          executionPolicy: "approval-gated",
        }),
      }),
    );
  });

  it("keeps a Plan thread read-only even when the composer asks to write", async () => {
    const fixture = providerTurnFixture({
      thread: decodeCodeThread({ ...thread(), executionPolicy: "plan" }),
    });

    await expect(
      fixture.service.execute(ids.window, {
        ...startProviderTurn,
        executionPolicy: "auto-accept-edits",
      }),
    ).resolves.toMatchObject({ kind: "provider-turn-state", state: "running" });

    expect(fixture.turns.start).toHaveBeenCalledWith(
      expect.objectContaining({
        thread: expect.objectContaining({ executionPolicy: "plan" }),
      }),
    );
    expect(fixture.events.append).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          kind: "conversation-turn-started",
          executionPolicy: "plan",
        }),
      }),
    );
  });

  it("lets a full-access thread run one turn under auto-accept edits without raising the thread", async () => {
    const fixture = providerTurnFixture();

    await expect(
      fixture.service.execute(ids.window, {
        ...startProviderTurn,
        executionPolicy: "auto-accept-edits",
      }),
    ).resolves.toMatchObject({ kind: "provider-turn-state", state: "running" });

    expect(fixture.turns.start).toHaveBeenCalledWith(
      expect.objectContaining({
        thread: expect.objectContaining({ executionPolicy: "auto-accept-edits" }),
      }),
    );
    expect(fixture.events.append).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          kind: "conversation-turn-started",
          executionPolicy: "auto-accept-edits",
        }),
      }),
    );
  });

  it("takes no restore point when a writing thread runs one Plan message", async () => {
    const checkpoint = vi.fn(async () => ({ status: "captured" as const, snapshot: {} }));
    const fixture = providerTurnFixture({ git: { checkpoint } as never });

    await expect(
      fixture.service.execute(ids.window, { ...startProviderTurn, executionPolicy: "plan" }),
    ).resolves.toMatchObject({ kind: "provider-turn-state", state: "running" });

    expect(checkpoint).not.toHaveBeenCalled();
    expect(fixture.turns.start).toHaveBeenCalledWith(
      expect.objectContaining({
        thread: expect.objectContaining({ executionPolicy: "plan" }),
      }),
    );
  });

  it("clamps a recorded Full-access turn to a later lower thread grant", async () => {
    const fixture = providerTurnFixture({
      thread: decodeCodeThread({ ...thread(), executionPolicy: "approval-gated" }),
    });
    fixture.events.replay.mockReturnValue({
      status: "ok" as const,
      frames: [
        {
          threadId: ids.thread,
          operationId: startProviderTurn.operationId,
          cursor: 1,
          occurredAt: "2026-07-21T10:00:00.000Z",
          event: {
            kind: "conversation-turn-started" as const,
            providerInstanceId: thread().providerInstanceId,
            modelId: thread().modelId,
            sessionId: startProviderTurn.sessionId,
            prompt: startProviderTurn.prompt,
            executionPolicy: "full-access" as const,
          },
        },
      ],
      nextCursor: 1,
    } as never);

    await expect(fixture.service.execute(ids.window, startProviderTurn)).resolves.toMatchObject({
      kind: "provider-turn-state",
      state: "running",
    });

    expect(fixture.turns.start).toHaveBeenCalledWith(
      expect.objectContaining({
        thread: expect.objectContaining({ executionPolicy: "approval-gated" }),
      }),
    );
  });
});

const startProviderTurn = {
  kind: "start-provider-turn",
  operationId: decodeCodeOperationId("48484848-4848-4484-8484-484848484848"),
  threadId: ids.thread,
  checkoutId: ids.checkout,
  sessionId: "60606060-6060-4060-8060-606060606060",
  prompt: decodeCodeEvidenceReference({
    contentId: "61616161-6161-4161-8161-616161616161",
    digest: "e".repeat(64),
    byteLength: 21,
  }),
} as const;

const codeRunFor = (parentThreadId: string, overrides: Record<string, unknown> = {}): AgentRun =>
  decodeAgentRun({
    id: "d6a1b000-0000-4000-8000-000000000001",
    requestId: "d6a1b000-0000-4000-8000-000000000002",
    parentThreadId,
    depth: 0,
    role: "review",
    task: "Review the diff.",
    creationPosture: "automatic",
    executionKind: "octant-managed",
    lifecycleStatus: "completed",
    authority: {
      filesystem: true,
      shell: true,
      git: true,
      network: true,
      tools: true,
      subagents: false,
      executionPolicy: "approval-gated",
      permissionPersistence: "current-session",
    },
    routingReceipt: {
      executionResolution: {
        providerInstanceId: "99999999-9999-4999-8999-999999999999",
        modelId: "model-id",
        hostId: "local",
        executionPolicy: "approval-gated",
        permissionPersistence: "current-session",
        effectivePermissions: {
          filesystem: true,
          shell: true,
          git: true,
          network: true,
          tools: true,
          subagents: false,
        },
        source: "project-default",
        fallbackChain: ["project-default"],
        downgradeReasons: [],
      },
      selectedExecutionKind: "octant-managed",
      attemptedExecutionKind: "provider-native",
      selectedProviderInstanceId: "99999999-9999-4999-8999-999999999999",
      selectedModelId: "model-id",
      fallbackCandidates: [],
      capabilityDegradations: [],
      contextSnapshotId: "d6a1b000-0000-4000-8000-000000000004",
      effectiveAuthorityDigest: "digest-1",
      usageQuality: "provider-reported",
      hostId: "local",
      mode: "code",
    },
    workspaceReceipt: {
      kind: "code-worktree",
      mode: "code",
      projectId: "66666666-6666-4666-8666-666666666666",
      checkoutRoot: "/private/exact-checkout",
      worktreeRoot: "/private/exact-checkout/.worktrees/d6a1",
      verified: true,
    },
    resultAcknowledgement: { required: false, acknowledged: false },
    version: 4,
    createdAt: "2026-07-21T10:00:00.000Z",
    updatedAt: "2026-07-21T10:00:00.000Z",
    ...overrides,
  });

/**
 * A full-access Code thread whose provider turns can be inspected: the fake
 * turn port records exactly what the host decided to send, so a test can say
 * what the provider saw and what the journal kept, separately.
 */
function providerTurnFixture(
  options: Partial<
    Pick<
      CodeOperationServiceOptions,
      | "resolveThreadMentionContext"
      | "resolveProfileSkills"
      | "resolveSelectedExtensions"
      | "attachments"
      | "supportsAttachments"
      | "git"
      | "isProviderModelAllowed"
      | "agentRuns"
      | "consumeIssueContextFramed"
      | "carryAgentMessages"
      | "confirmAgentMessagesDelivered"
      | "takeProductFeedbackForTurn"
    >
  > & {
    readonly thread?: CodeThread;
    readonly recordEvents?: boolean;
    /** The thread's checkout is a remote root on an SSH target. */
    readonly remoteRoot?: boolean;
    /** The thread as the asking window holds it, with its session grants. */
    readonly effectiveThread?: (windowId: WindowId, thread: CodeThread) => CodeThread;
  } = {},
) {
  const {
    thread: threadOverride,
    recordEvents,
    remoteRoot,
    effectiveThread,
    ...serviceOptions
  } = options;
  const activeThread = threadOverride ?? thread();
  const turns = {
    start: vi.fn<CodeOperationServiceOptions["turns"]["start"]>(async () => ({ state: "running" })),
    answerInput: vi.fn(),
    answerApproval: vi.fn(),
    cancel: vi.fn(),
  };
  const frames: CodeOperationEventFrame[] = [];
  const events = {
    replay: vi.fn((input: Parameters<CodeOperationServiceOptions["events"]["replay"]>[0]) => {
      const replay = frames.filter(
        (frame) =>
          String(frame.operationId) === String(input.operationId) &&
          frame.cursor > input.afterCursor,
      );
      return { status: "ok" as const, frames: replay, nextCursor: replay.at(-1)?.cursor ?? 0 };
    }),
    append: vi.fn((input: Parameters<CodeOperationServiceOptions["events"]["append"]>[0]) => {
      if (recordEvents)
        frames.push(
          decodeCodeOperationEventFrame({
            threadId: input.threadId,
            operationId: input.operationId,
            event: input.event,
            cursor: input.expectedCursor + 1,
            occurredAt: "2026-07-21T10:00:00.000Z",
          }),
        );
    }),
    historyForThread: vi.fn(() => ({ status: "ok" as const, frames })),
  };
  const git = { checkpoint: vi.fn(async () => ({ status: "failed" as const })) };
  const evidence = { put: vi.fn(), read: vi.fn(async () => "does this still hold?") };
  const service = new CodeOperationService({
    authority: {
      readThread: vi.fn(() => activeThread),
      ...(effectiveThread === undefined ? {} : { effectiveThread }),
      readCheckout: vi.fn(() =>
        decodeCodeCheckoutIdentity({
          id: ids.checkout,
          repositoryId: activeThread.repositoryId,
          availability: "available",
          observedAt: "2026-07-21T10:00:00.000Z",
          ...(remoteRoot === true
            ? { kind: "remote-root", head: { kind: "none" } }
            : {
                kind: "existing-worktree",
                head: { kind: "branch", name: "feature/exact", oid: "b".repeat(40) },
              }),
        }),
      ),
      canAccessProject: vi.fn(async () => true),
      resolveCheckoutRoot: vi.fn(async () => ({
        checkoutRoot: "/private/exact-checkout",
        credentialReferences: [],
      })),
    } as never,
    terminals: {} as never,
    repositoryTests: {} as never,
    git: git as never,
    pullRequests: {} as never,
    reviewFindings: {} as never,
    turns: turns as never,
    evidence: evidence as never,
    events: events as never,
    ...serviceOptions,
  });
  return { service, turns, events, git, evidence };
}

describe("CodeOperationService terminal readers", () => {
  const second = decodeCodeOperationId("5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a");

  function readerFixture(
    evidenceOverrides: { readonly put?: (content: string) => undefined } = {},
  ) {
    let observer: ((emission: unknown) => void) | undefined;
    const removeObserver = vi.fn();
    const snapshot = (chunks: ReadonlyArray<string>) => ({
      terminalId: ids.terminal,
      status: "running" as const,
      canRerun: false,
      transcript: { chunks, byteLength: chunks.join("").length, truncated: false, characters: 0 },
    });
    const terminals = {
      launch: vi.fn(async () => snapshot(["boot"])),
      attach: vi.fn(() => snapshot(["boot"])),
      observe: vi.fn((_terminalId: unknown, listener: (emission: unknown) => void) => {
        observer = listener;
        return removeObserver;
      }),
      write: vi.fn(),
      resize: vi.fn(),
      terminate: vi.fn(),
    };
    const events = {
      replay: vi.fn(() => ({ status: "ok" as const, frames: [], nextCursor: 0 })),
      append: vi.fn(),
      historyForThread: vi.fn(() => ({ status: "ok" as const, frames: [] })),
    };
    const service = new CodeOperationService({
      authority: {
        readThread: vi.fn(() => thread()),
        readCheckout: vi.fn(() =>
          decodeCodeCheckoutIdentity({
            id: ids.checkout,
            repositoryId: `repo_${"8".repeat(64)}`,
            kind: "existing-worktree",
            availability: "available",
            head: { kind: "branch", name: "feature/exact", oid: "b".repeat(40) },
            observedAt: "2026-07-21T10:00:00.000Z",
          }),
        ),
        canAccessProject: vi.fn(async () => true),
        approvalContextDigest: vi.fn(async () => "a".repeat(64)),
        resolveCheckoutRoot: vi.fn(async () => ({
          checkoutRoot: "/private/exact-checkout",
          workingDirectory: "/private/exact-checkout",
          shell: "/bin/zsh",
          credentialReferences: [],
          environment: {},
        })),
      } as never,
      approvals: { validate: vi.fn(async () => true) } as never,
      terminals: terminals as never,
      repositoryTests: {} as never,
      git: {} as never,
      pullRequests: {} as never,
      reviewFindings: {} as never,
      turns: {} as never,
      evidence: {
        put: vi.fn(
          (content: string) =>
            evidenceOverrides.put?.(content) ??
            decodeCodeEvidenceReference({
              contentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              digest: "a".repeat(64),
              byteLength: Buffer.byteLength(content),
            }),
        ),
        read: vi.fn(async () => ""),
      } as never,
      events: events as never,
    } as CodeOperationServiceOptions);
    return {
      emit: (text: string) => observer?.({ text, replace: false, snapshot: snapshot([text]) }),
      events,
      service,
      terminals,
    };
  }

  const scope = { threadId: ids.thread, checkoutId: ids.checkout, terminalId: ids.terminal };

  function outputCursorsFor(
    events: { append: { mock: { calls: ReadonlyArray<ReadonlyArray<any>> } } },
    operationId: string,
  ): ReadonlyArray<number> {
    return events.append.mock.calls
      .map(([entry]) => entry)
      .filter(
        (entry) => entry.operationId === operationId && entry.event.kind === "terminal-output",
      )
      .map((entry) => entry.expectedCursor);
  }

  it("keeps sending a terminal's output to the reader that was already following it", async () => {
    const { emit, events, service } = readerFixture();
    await service.execute(ids.window, {
      kind: "start-terminal",
      operationId: ids.operation,
      ...scope,
      columns: 80,
      rows: 24,
      credentialRefs: [],
    });
    emit("first\n");

    await service.execute(ids.window, {
      kind: "attach-terminal",
      operationId: second,
      ...scope,
    });
    emit("second\n");

    // The first reader is still following its own operation, so the output
    // that arrived after the second surface opened reaches both of them.
    expect(outputCursorsFor(events, ids.operation)).toEqual([1, 2]);
    expect(outputCursorsFor(events, second)).toEqual([1]);
  });
  it("collects readers left behind by surfaces that stopped reading, keeping the ones still on screen", async () => {
    const { emit, events, service } = readerFixture();
    await service.execute(ids.window, {
      kind: "start-terminal",
      operationId: ids.operation,
      ...scope,
      columns: 80,
      rows: 24,
      credentialRefs: [],
    });

    // Four more surfaces open the same terminal and walk away without reading.
    const abandoned = [
      "6a6a6a6a-6a6a-4a6a-8a6a-6a6a6a6a6a6a",
      "6b6b6b6b-6b6b-4b6b-8b6b-6b6b6b6b6b6b",
      "6c6c6c6c-6c6c-4c6c-8c6c-6c6c6c6c6c6c",
      "6d6d6d6d-6d6d-4d6d-8d6d-6d6d6d6d6d6d",
    ].map((id) => decodeCodeOperationId(id));
    for (const operationId of abandoned) {
      // The surface that is still on screen keeps reading between each one.
      await service.subscribe(ids.window, ids.thread, ids.operation, 0, 16);
      await service.execute(ids.window, { kind: "attach-terminal", operationId, ...scope });
    }
    emit("still here\n");

    // The reader that kept reading survived; the ones that went quiet did not.
    expect(outputCursorsFor(events, ids.operation)).toEqual([1]);
    expect(outputCursorsFor(events, String(abandoned[0]))).toEqual([]);
    expect(outputCursorsFor(events, String(abandoned[3]))).toEqual([1]);
  });

  it("reports a shell that was never started as unavailable rather than journaling a failure", async () => {
    const { events, service } = readerFixture();
    const result = await service.execute(ids.window, {
      kind: "attach-terminal",
      operationId: ids.operation,
      ...scope,
    });
    // First open probes with an attach before starting; the answer is a state
    // the surface can act on, not an operation-failed row on the journal.
    expect(result).toMatchObject({ kind: "terminal-state", state: "unavailable" });
    expect(events.append).toHaveBeenCalledWith({
      threadId: ids.thread,
      operationId: ids.operation,
      expectedCursor: 0,
      event: { kind: "operation-result", result },
    });
  });

  it("waits for a starting shell to finish launching before attaching to it", async () => {
    const { service, terminals } = readerFixture();
    let release!: () => void;
    terminals.launch.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              terminalId: ids.terminal,
              status: "running" as const,
              canRerun: false,
              transcript: {
                chunks: ["boot"],
                byteLength: 4,
                truncated: false,
                characters: 4,
              },
            });
        }),
    );
    const start = service.execute(ids.window, {
      kind: "start-terminal",
      operationId: ids.operation,
      ...scope,
      columns: 80,
      rows: 24,
      credentialRefs: [],
    });
    await vi.waitFor(() => expect(terminals.launch).toHaveBeenCalledOnce());
    const attach = service.execute(ids.window, {
      kind: "attach-terminal",
      operationId: second,
      ...scope,
    });
    release();
    await expect(start).resolves.toMatchObject({ kind: "terminal-state", state: "running" });
    await expect(attach).resolves.toMatchObject({ kind: "terminal-state", state: "running" });
    expect(terminals.attach).toHaveBeenCalledWith(ids.terminal);
  });

  it("refuses to start a shell whose identifier is already in use", async () => {
    const { service, terminals } = readerFixture();
    await service.execute(ids.window, {
      kind: "start-terminal",
      operationId: ids.operation,
      ...scope,
      columns: 80,
      rows: 24,
      credentialRefs: [],
    });
    const again = await service.execute(ids.window, {
      kind: "start-terminal",
      operationId: second,
      ...scope,
      columns: 80,
      rows: 24,
      credentialRefs: [],
    });
    expect(again).toMatchObject({
      kind: "operation-failed",
      failure: { category: "unavailable" },
    });
    expect(terminals.launch).toHaveBeenCalledOnce();
  });

  it("restarts a shell whose settled identifier still lingers in the owner record", async () => {
    const { service, terminals } = readerFixture();
    await service.execute(ids.window, {
      kind: "start-terminal",
      operationId: ids.operation,
      ...scope,
      columns: 80,
      rows: 24,
      credentialRefs: [],
    });
    // The process is already gone but the owner record has not caught up —
    // its exit emission is delayed, or no observer ever armed to deliver it.
    terminals.attach.mockReturnValue({
      terminalId: ids.terminal,
      status: "exited",
      canRerun: true,
      exitCode: 0,
      transcript: { chunks: ["boot"], byteLength: 4, truncated: false, characters: 4 },
    } as never);

    const restarted = await service.execute(ids.window, {
      kind: "start-terminal",
      operationId: second,
      ...scope,
      columns: 80,
      rows: 24,
      credentialRefs: [],
    });
    expect(restarted).toMatchObject({ kind: "terminal-state", state: "running" });
    expect(terminals.launch).toHaveBeenCalledTimes(2);
  });

  it("stops a terminal nothing can be journaled to any more", async () => {
    const { emit, events, service, terminals } = readerFixture();
    await service.execute(ids.window, {
      kind: "start-terminal",
      operationId: ids.operation,
      ...scope,
      columns: 80,
      rows: 24,
      credentialRefs: [],
    });
    events.append.mockImplementation(() => {
      throw new Error("journal is unavailable");
    });

    emit("unjournaled\n");

    expect(terminals.terminate).toHaveBeenCalledWith(ids.terminal);
  });
  it("stops a terminal whose output cannot be stored", async () => {
    // Only the streamed output fails to store; the terminal starts normally.
    const { emit, service, terminals } = readerFixture({
      put: (content) => {
        if (content.includes("unstorable")) throw new Error("evidence is unavailable");
        return undefined;
      },
    });
    await service.execute(ids.window, {
      kind: "start-terminal",
      operationId: ids.operation,
      ...scope,
      columns: 80,
      rows: 24,
      credentialRefs: [],
    });

    emit("unstorable\n");

    expect(terminals.terminate).toHaveBeenCalledWith(ids.terminal);
  });
});

describe("CodeOperationService terminal Browser grant", () => {
  const granted = {
    status: "granted",
    grantId: "66666666-6666-4666-8666-666666666666",
    threadId: ids.thread,
    terminalId: ids.terminal,
    issuedAt: "2026-10-13T09:00:00.000Z",
  } as const;
  const references = [
    { environmentName: "OCTANT_BROWSER_MCP_URL", reference: "terminal-browser-grant:g:endpoint" },
    { environmentName: "OCTANT_BROWSER_MCP_TOKEN", reference: "terminal-browser-grant:g:token" },
  ];
  const startWithGrant = {
    kind: "start-terminal",
    operationId: ids.operation,
    threadId: ids.thread,
    checkoutId: ids.checkout,
    terminalId: ids.terminal,
    columns: 80,
    rows: 24,
    credentialRefs: [],
    browserGrant: "on",
  } as const;

  const revokeCommand = {
    kind: "revoke-terminal-browser-grant",
    operationId: ids.operation,
    threadId: ids.thread,
    checkoutId: ids.checkout,
    terminalId: ids.terminal,
  } as const;

  function grantsFixture(opening: unknown) {
    const grants = {
      open: vi.fn(async () => opening),
      abandon: vi.fn(),
      switchOff: vi.fn(),
      terminalClosed: vi.fn(),
      liveGrant: vi.fn((): unknown => undefined),
    };
    return grants;
  }

  function fixture(
    opening: unknown,
    withGrants = true,
    conditions: {
      readonly checkoutAvailability?: "available" | "unavailable";
      readonly canAccess?: boolean;
      readonly launchStatus?: "running" | "exited";
    } = {},
  ) {
    const grants = grantsFixture(opening);
    let listener: ((emission: unknown) => void) | undefined;
    const terminals = {
      launch: vi.fn(async () => ({
        terminalId: ids.terminal,
        status: conditions.launchStatus ?? ("running" as const),
        canRerun: false,
        transcript: { chunks: [], byteLength: 0, truncated: false, characters: 0 },
      })),
      attach: vi.fn(),
      observe: vi.fn((_id: unknown, next: (emission: unknown) => void) => {
        listener = next;
        return vi.fn();
      }),
      write: vi.fn(),
      resize: vi.fn(),
      terminate: vi.fn(),
    };
    const events = {
      replay: vi.fn(() => ({ status: "ok" as const, frames: [], nextCursor: 0 })),
      append: vi.fn(),
      historyForThread: vi.fn(() => ({ status: "ok" as const, frames: [] })),
    };
    const authority = {
      readThread: vi.fn(() => thread()),
      readCheckout: vi.fn(() =>
        decodeCodeCheckoutIdentity({
          id: ids.checkout,
          repositoryId: `repo_${"8".repeat(64)}`,
          kind: "existing-worktree",
          availability: conditions.checkoutAvailability ?? "available",
          head: { kind: "branch", name: "feature/exact", oid: "b".repeat(40) },
          observedAt: "2026-07-21T10:00:00.000Z",
        }),
      ),
      canAccessProject: vi.fn(async () => conditions.canAccess ?? true),
      approvalContextDigest: vi.fn(async () => "a".repeat(64)),
      resolveCheckoutRoot: vi.fn(async () => ({
        checkoutRoot: "/private/exact-checkout",
        workingDirectory: "/private/exact-checkout",
        shell: "/bin/zsh",
        credentialReferences: [],
        environment: {},
      })),
    };
    const service = new CodeOperationService({
      authority: authority as never,
      approvals: { validate: vi.fn(async () => true) } as never,
      terminals: terminals as never,
      ...(withGrants ? { terminalBrowserGrants: grants as never } : {}),
      repositoryTests: {} as never,
      git: {} as never,
      pullRequests: {} as never,
      reviewFindings: {} as never,
      turns: {} as never,
      evidence: {
        put: vi.fn(() =>
          decodeCodeEvidenceReference({
            contentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            digest: "a".repeat(64),
            byteLength: 1,
          }),
        ),
        read: vi.fn(async () => ""),
      } as never,
      events: events as never,
    } as CodeOperationServiceOptions);
    return {
      service,
      grants,
      terminals,
      authority,
      exit: () =>
        listener?.({
          text: "",
          replace: false,
          snapshot: {
            terminalId: ids.terminal,
            status: "exited",
            exitCode: 0,
            canRerun: true,
            transcript: { chunks: [], byteLength: 0, truncated: false, characters: 0 },
          },
        }),
    };
  }

  it("starts the person's terminal with the grant's two variables and reports the grant", async () => {
    const { service, grants, terminals } = fixture({
      kind: "granted",
      outcome: granted,
      credentialReferences: references,
    });

    const result = await service.execute(ids.window, startWithGrant, { initiator: "user" });

    expect(grants.open).toHaveBeenCalledWith({
      caller: "local-window",
      windowId: ids.window,
      threadId: ids.thread,
      terminalId: ids.terminal,
    });
    expect(terminals.launch).toHaveBeenCalledWith(
      expect.objectContaining({ credentialReferences: references }),
    );
    expect(result).toMatchObject({
      kind: "terminal-state",
      state: "running",
      browserGrant: granted,
    });
    expect(JSON.stringify(result)).not.toContain("terminal-browser-grant:");
  });

  it("puts the app's launcher only on a terminal started with a grant", async () => {
    const launcher = {
      directory: "/Applications/Octant.app/Contents/Resources/terminal-launcher",
      readRoots: ["/Applications/Octant.app/Contents/Resources/terminal-launcher"],
    };
    const opening = {
      kind: "granted",
      outcome: granted,
      credentialReferences: references,
      launcher,
    };
    const granting = fixture(opening);
    await granting.service.execute(ids.window, startWithGrant, { initiator: "user" });
    expect(granting.terminals.launch).toHaveBeenCalledWith(expect.objectContaining({ launcher }));

    const plain = fixture(opening);
    const { browserGrant: _off, ...withoutGrant } = startWithGrant;
    await plain.service.execute(ids.window, withoutGrant, { initiator: "user" });
    expect(plain.terminals.launch).toHaveBeenCalledWith(
      expect.not.objectContaining({ launcher: expect.anything() }),
    );
  });

  it("starts no terminal when the host refuses the grant, so it never looks as if it has one", async () => {
    const refusal = { status: "refused", reason: "not-local-window" } as const;
    const { service, grants, terminals } = fixture({ kind: "refused", outcome: refusal });

    const result = await service.execute(ids.window, startWithGrant);

    expect(grants.open).toHaveBeenCalledWith(expect.objectContaining({ caller: "remote-device" }));
    expect(terminals.launch).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      kind: "terminal-state",
      state: "unavailable",
      browserGrant: refusal,
    });
  });

  it("refuses a grant on a host that lends no Browser and starts no terminal", async () => {
    const { service, terminals } = fixture(undefined, false);
    const result = await service.execute(ids.window, startWithGrant, { initiator: "user" });
    expect(terminals.launch).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      state: "unavailable",
      browserGrant: { status: "refused", reason: "browser-unavailable" },
    });
  });

  it("asks for no grant when the start does not ask for one", async () => {
    const { service, grants, terminals } = fixture({ kind: "refused", outcome: granted });
    const { browserGrant: _off, ...plain } = startWithGrant;
    await service.execute(ids.window, plain, { initiator: "user" });
    expect(grants.open).not.toHaveBeenCalled();
    expect(terminals.launch).toHaveBeenCalledWith(
      expect.objectContaining({ credentialReferences: [] }),
    );
  });

  it("gives the grant back when the shell fails to start", async () => {
    const { service, grants, terminals } = fixture({
      kind: "granted",
      outcome: granted,
      credentialReferences: references,
    });
    terminals.launch.mockRejectedValueOnce(new Error("no shell"));
    await service.execute(ids.window, startWithGrant, { initiator: "user" });
    expect(grants.abandon).toHaveBeenCalledWith(ids.terminal);
  });

  it("tells the person a Linux host without bubblewrap needs it installed, not that the operation failed", async () => {
    const { service, terminals } = fixture({
      kind: "granted",
      outcome: granted,
      credentialReferences: references,
    });
    let missing: unknown;
    try {
      requireLinuxConfinement("/nonexistent/bwrap");
    } catch (error) {
      missing = error;
    }
    terminals.launch.mockRejectedValueOnce(missing);

    const result = await service.execute(
      ids.window,
      {
        kind: "start-terminal",
        operationId: ids.operation,
        threadId: ids.thread,
        checkoutId: ids.checkout,
        terminalId: ids.terminal,
        columns: 80,
        rows: 24,
        credentialRefs: [],
      },
      { initiator: "user" },
    );

    expect(result).toMatchObject({
      kind: "operation-failed",
      failure: {
        category: "unavailable",
        message: expect.stringContaining("sudo apt-get install -y bubblewrap"),
      },
    });
    const message = result.kind === "operation-failed" ? result.failure.message : "";
    expect(message).not.toContain("/nonexistent");
    expect(message).not.toBe("Code operation failed.");
  });

  it("ends the grant when the terminal it was minted for stops being followed", async () => {
    const { service, grants, exit } = fixture({
      kind: "granted",
      outcome: granted,
      credentialReferences: references,
    });
    await service.execute(ids.window, startWithGrant, { initiator: "user" });
    exit();
    expect(grants.terminalClosed).toHaveBeenCalledWith(ids.terminal);
  });

  it("tells a window that attaches whether the running shell holds a grant", async () => {
    const { service, grants, terminals } = fixture({
      kind: "granted",
      outcome: granted,
      credentialReferences: references,
    });
    await service.execute(ids.window, startWithGrant, { initiator: "user" });
    const running = {
      terminalId: ids.terminal,
      status: "running" as const,
      canRerun: false,
      transcript: { chunks: [], byteLength: 0, truncated: false, characters: 0 },
    };
    terminals.attach.mockReturnValue(running);
    const attach = {
      kind: "attach-terminal",
      operationId: "77777777-7777-4777-8777-777777777777",
      threadId: ids.thread,
      checkoutId: ids.checkout,
      terminalId: ids.terminal,
    } as const;

    grants.liveGrant.mockReturnValueOnce(granted);
    await expect(service.execute(ids.window, attach)).resolves.toMatchObject({
      kind: "terminal-state",
      state: "running",
      browserGrant: granted,
    });
    expect(grants.liveGrant).toHaveBeenCalledWith(ids.thread, ids.terminal);

    // Once the grant has ended the same attach says nothing about one.
    const after = await service.execute(ids.window, {
      ...attach,
      operationId: "88888888-8888-4888-8888-888888888888",
    });
    expect(after).toMatchObject({ kind: "terminal-state", state: "running" });
    expect(after).not.toHaveProperty("browserGrant");
  });

  it("switches a live grant off and reports it revoked", async () => {
    const outcome = {
      status: "revoked",
      grantId: granted.grantId,
      threadId: ids.thread,
      terminalId: ids.terminal,
      reason: "switched-off",
      revokedAt: "2026-10-13T09:01:00.000Z",
    } as const;
    const { service, grants, terminals } = fixture(undefined);
    grants.switchOff.mockResolvedValue(outcome);
    terminals.attach.mockReturnValue({
      terminalId: ids.terminal,
      status: "running",
      canRerun: false,
      transcript: { chunks: [], byteLength: 0, truncated: false, characters: 0 },
    });

    const result = await service.execute(ids.window, {
      kind: "revoke-terminal-browser-grant",
      operationId: ids.operation,
      threadId: ids.thread,
      checkoutId: ids.checkout,
      terminalId: ids.terminal,
    });

    expect(grants.switchOff).toHaveBeenCalledWith({
      windowId: ids.window,
      threadId: ids.thread,
      terminalId: ids.terminal,
    });
    expect(result).toMatchObject({
      kind: "terminal-state",
      state: "running",
      browserGrant: outcome,
    });
  });
  it("switches a grant off after the thread's checkout became unavailable", async () => {
    const outcome = {
      status: "revoked",
      grantId: granted.grantId,
      threadId: ids.thread,
      terminalId: ids.terminal,
      reason: "switched-off",
      revokedAt: "2026-10-13T09:01:00.000Z",
    } as const;
    const { service, grants, authority } = fixture(undefined, true, {
      checkoutAvailability: "unavailable",
    });
    grants.switchOff.mockResolvedValue(outcome);

    const result = await service.execute(ids.window, revokeCommand);

    expect(grants.switchOff).toHaveBeenCalledWith({
      windowId: ids.window,
      threadId: ids.thread,
      terminalId: ids.terminal,
    });
    expect(authority.resolveCheckoutRoot).not.toHaveBeenCalled();
    expect(result).toMatchObject({ kind: "terminal-state", browserGrant: outcome });
  });

  it("still refuses a window that cannot open the thread, and an unknown thread, when switching off", async () => {
    const blocked = fixture(undefined, true, {
      checkoutAvailability: "unavailable",
      canAccess: false,
    });
    expect(await blocked.service.execute(ids.window, revokeCommand)).toMatchObject({
      kind: "operation-failed",
      failure: { category: "unauthorized" },
    });
    expect(blocked.grants.switchOff).not.toHaveBeenCalled();

    const unknown = fixture(undefined);
    unknown.authority.readThread.mockReturnValue(undefined as never);
    expect(await unknown.service.execute(ids.window, revokeCommand)).toMatchObject({
      kind: "operation-failed",
      failure: { category: "invalid" },
    });
    expect(unknown.grants.switchOff).not.toHaveBeenCalled();
  });

  it("ends the grant and does not report it granted when the shell had already exited at launch", async () => {
    const revoked = {
      status: "revoked",
      grantId: granted.grantId,
      threadId: ids.thread,
      terminalId: ids.terminal,
      reason: "terminal-not-started",
      revokedAt: "2026-10-13T09:01:00.000Z",
    } as const;
    const { service, grants } = fixture(
      { kind: "granted", outcome: granted, credentialReferences: references },
      true,
      { launchStatus: "exited" },
    );
    grants.abandon.mockReturnValue(revoked);

    const result = await service.execute(ids.window, startWithGrant, { initiator: "user" });

    expect(grants.abandon).toHaveBeenCalledWith(ids.terminal);
    expect(result).toMatchObject({
      kind: "terminal-state",
      state: "exited",
      browserGrant: revoked,
    });
    expect(JSON.stringify(result)).not.toContain('"granted"');
  });
});

describe("CodeOperationService live terminal output", () => {
  const scope = { threadId: ids.thread, checkoutId: ids.checkout, terminalId: ids.terminal };
  const otherWindow = "99999999-9999-4999-8999-aaaaaaaaaaaa" as WindowId;

  function fakeShell(receiptReady: Promise<void> = Promise.resolve()) {
    let data: (value: string) => void = () => undefined;
    let exit: (event: { exitCode: number }) => void = () => undefined;
    return {
      write: vi.fn(),
      resize: vi.fn(),
      close: vi.fn(async () => undefined),
      onData: vi.fn((listener: (value: string) => void) => {
        data = listener;
        return () => undefined;
      }),
      onExit: vi.fn((listener: (event: { exitCode: number }) => void) => {
        exit = listener;
        return () => undefined;
      }),
      pause: vi.fn(),
      resume: vi.fn(),
      receiptReady,
      print: (value: string) => data(value),
      exit: (exitCode: number) => exit({ exitCode }),
    };
  }

  async function fixture(
    options: {
      readonly canAccessProject?: (windowId: WindowId) => boolean;
      readonly retainProjectAccess?: (
        windowId: WindowId,
      ) => ((projectId: CodeThread["projectId"]) => boolean) | undefined;
      /** Hold the launch open until `finishLaunch` is called. */
      readonly deferLaunch?: boolean;
    } = {},
  ) {
    let finishLaunch = () => {};
    const shell = fakeShell(
      options.deferLaunch === true
        ? new Promise<void>((resolve) => {
            finishLaunch = resolve;
          })
        : Promise.resolve(),
    );
    const evidenceTexts: string[] = [];
    const terminals = new TerminalService({
      port: { start: () => shell },
      inheritedEnvironment: {},
      credentials: { resolve: async () => "" },
    });
    let puts = 0;
    const events = {
      replay: vi.fn(() => ({ status: "ok" as const, frames: [], nextCursor: 0 })),
      append: vi.fn(),
      historyForThread: vi.fn(() => ({ status: "ok" as const, frames: [] })),
    };
    const service = new CodeOperationService({
      authority: {
        readThread: vi.fn(() => thread()),
        readCheckout: vi.fn(() =>
          decodeCodeCheckoutIdentity({
            id: ids.checkout,
            repositoryId: `repo_${"8".repeat(64)}`,
            kind: "existing-worktree",
            availability: "available",
            head: { kind: "branch", name: "feature/exact", oid: "b".repeat(40) },
            observedAt: "2026-07-21T10:00:00.000Z",
          }),
        ),
        canAccessProject: vi.fn(
          async (windowId: WindowId) => options.canAccessProject?.(windowId) ?? true,
        ),
        ...(options.retainProjectAccess === undefined
          ? {}
          : { retainProjectAccess: options.retainProjectAccess }),
        approvalContextDigest: vi.fn(async () => "a".repeat(64)),
        resolveCheckoutRoot: vi.fn(async () => ({
          checkoutRoot: "/private/exact-checkout",
          workingDirectory: "/private/exact-checkout",
          shell: "/bin/zsh",
          credentialReferences: [],
          environment: {},
        })),
      } as never,
      approvals: { validate: vi.fn(async () => true) } as never,
      terminals: terminals as never,
      repositoryTests: {} as never,
      git: {} as never,
      pullRequests: {} as never,
      reviewFindings: {} as never,
      turns: {} as never,
      evidence: {
        put: vi.fn((content: string) => {
          puts += 1;
          evidenceTexts.push(content);
          return decodeCodeEvidenceReference({
            contentId: `00000000-0000-4000-8000-${String(puts).padStart(12, "0")}`,
            digest: "a".repeat(64),
            byteLength: Buffer.byteLength(content),
          });
        }),
        read: vi.fn(async () => ""),
      } as never,
      events: events as never,
    } as CodeOperationServiceOptions);
    const launched = service.execute(ids.window, {
      kind: "start-terminal",
      operationId: ids.operation,
      ...scope,
      columns: 80,
      rows: 24,
      credentialRefs: [],
    });
    if (options.deferLaunch !== true) await launched;
    return {
      service,
      shell,
      events,
      evidenceTexts,
      launched,
      finishLaunch: () => finishLaunch(),
      evidencePuts: () => puts,
    };
  }

  /** Collects frames in the background, the way the route's stream does. */
  function follow(frames: AsyncIterable<CodeTerminalLiveFrame>) {
    const received: CodeTerminalLiveFrame[] = [];
    const finished = (async () => {
      for await (const frame of frames) received.push(frame);
    })();
    return { received, finished };
  }

  /** What a window holds after applying frames the way the terminal pane does. */
  function applied(frames: ReadonlyArray<CodeTerminalLiveFrame>): string {
    return frames.reduce((held, frame) => (frame.replace ? frame.text : held + frame.text), "");
  }

  it("refuses a window, a thread, or a terminal that is not the one the shell was started for", async () => {
    const { service } = await fixture();

    await expect(service.watchTerminal(otherWindow, scope)).rejects.toMatchObject({
      category: "unauthorized",
    });
    await expect(
      service.watchTerminal(ids.window, {
        ...scope,
        threadId: decodeCodeThreadId("22222222-2222-4222-8222-222222222223"),
      }),
    ).rejects.toMatchObject({ category: "invalid" });
    await expect(
      service.watchTerminal(ids.window, {
        ...scope,
        terminalId: "55555555-5555-4555-8555-555555555556" as CodeTerminalId,
      }),
    ).rejects.toMatchObject({ category: "unavailable" });
  });

  it("delivers output at frame rate while the store is written no faster than before", async () => {
    vi.useFakeTimers();
    try {
      const flood = async (watched: boolean) => {
        const { service, shell, evidencePuts } = await fixture();
        const live = watched
          ? follow(await service.watchTerminal(ids.window, scope))
          : { received: [], finished: Promise.resolve() };
        for (let ms = 0; ms < 1000; ms += 1) {
          shell.print("x");
          await vi.advanceTimersByTimeAsync(1);
        }
        const received = live.received.length;
        shell.exit(0);
        await vi.advanceTimersByTimeAsync(100);
        await live.finished;
        return { received, puts: evidencePuts() };
      };

      const unwatched = await flood(false);
      const watched = await flood(true);

      // One leading-edge write, then one per 50 ms window, with or without a
      // window reading live: a flooding shell reaches the evidence store's
      // 100,000-entry ceiling no sooner for being watched.
      expect(unwatched.puts).toBeLessThanOrEqual(23);
      expect(watched.puts).toBe(unwatched.puts);
      // Live frames arrive at the 16 ms window, so about three for each write.
      expect(watched.received).toBeGreaterThan(50);
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts a window with no offset from where the shell is, and resumes one that has an offset from there", async () => {
    vi.useFakeTimers();
    try {
      const { service, shell } = await fixture();
      shell.print("one\n");
      await vi.advanceTimersByTimeAsync(100);

      const first = new AbortController();
      const live = follow(
        await service.watchTerminal(ids.window, { ...scope, signal: first.signal }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(live.received).toMatchObject([{ text: "one\n", replace: true, state: "running" }]);
      const held = live.received[0]!.characters;

      shell.print("two\n");
      await vi.advanceTimersByTimeAsync(20);
      expect(applied(live.received)).toBe("one\ntwo\n");

      // The stream drops; the shell keeps printing.
      first.abort();
      await live.finished;
      const resumedFrom = live.received.at(-1)!.characters;
      shell.print("three\n");
      await vi.advanceTimersByTimeAsync(100);

      const second = new AbortController();
      const resumed = follow(
        await service.watchTerminal(ids.window, {
          ...scope,
          afterCharacters: resumedFrom,
          signal: second.signal,
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      // Only what the window missed, appended, so it holds the same bytes the
      // journal holds.
      expect(resumed.received).toMatchObject([{ text: "three\n", replace: false }]);
      expect(held).toBeLessThan(resumedFrom);
      second.abort();
      await resumed.finished;

      // An offset the host does not hold is answered with the current output.
      const stale = new AbortController();
      const behind = follow(
        await service.watchTerminal(ids.window, {
          ...scope,
          afterCharacters: 10_000_000,
          signal: stale.signal,
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(behind.received).toMatchObject([{ text: "one\ntwo\nthree\n", replace: true }]);
      stale.abort();
      await behind.finished;
    } finally {
      vi.useRealTimers();
    }
  });

  it("splits a burst of CJK output into frames that stay within the byte bound and add up to what was printed", async () => {
    vi.useFakeTimers();
    try {
      const { service, shell } = await fixture();
      const live = follow(await service.watchTerminal(ids.window, scope));
      await vi.advanceTimersByTimeAsync(0);

      // 40,000 characters is under the publish limit but about 120 KiB encoded.
      const burst = "界".repeat(40_000);
      shell.print(burst);
      await vi.advanceTimersByTimeAsync(20);

      const printed = live.received.filter((frame) => frame.text !== "");
      expect(printed.length).toBe(2);
      for (const frame of printed) {
        expect(Buffer.byteLength(frame.text, "utf8")).toBeLessThanOrEqual(64 * 1024);
      }
      expect(applied(live.received)).toBe(burst);
      expect(live.received.at(-1)?.characters).toBe(burst.length);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends a reader that falls behind where the shell is now instead of every step it missed", async () => {
    vi.useFakeTimers();
    try {
      const { service, shell } = await fixture();
      const frames = (await service.watchTerminal(ids.window, scope))[Symbol.asyncIterator]();
      const initial = await frames.next();
      expect(initial.value).toMatchObject({ replace: true });

      let printed = "";
      for (let step = 0; step < 20; step += 1) {
        const line = `line ${step}\n`;
        printed += line;
        shell.print(line);
        await vi.advanceTimersByTimeAsync(20);
      }
      shell.print("last\n");
      printed += "last\n";
      await vi.advanceTimersByTimeAsync(20);

      const received: CodeTerminalLiveFrame[] = [initial.value as CodeTerminalLiveFrame];
      for (;;) {
        const next = await frames.next();
        if (next.done === true) break;
        received.push(next.value);
        if (applied(received) === printed) break;
      }
      await frames.return?.(undefined);

      expect(applied(received)).toBe(printed);
      expect(received.length).toBeLessThan(12);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends the stream with the shell's exit and with the window's revocation", async () => {
    vi.useFakeTimers();
    try {
      const ended = await fixture();
      const exited = follow(await ended.service.watchTerminal(ids.window, scope));
      await vi.advanceTimersByTimeAsync(0);
      ended.shell.exit(3);
      await vi.advanceTimersByTimeAsync(100);
      await exited.finished;
      expect(exited.received.at(-1)).toMatchObject({ state: "exited", exitCode: 3 });

      const revoked = await fixture();
      const open = follow(await revoked.service.watchTerminal(ids.window, scope));
      await vi.advanceTimersByTimeAsync(0);
      revoked.service.revokeTerminalStreams(ids.window);
      await vi.advanceTimersByTimeAsync(0);
      await open.finished;
      expect(open.received.at(-1)).toMatchObject({ state: "running" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends the stream once the window can no longer open the thread's Project", async () => {
    vi.useFakeTimers();
    try {
      let allowed = true;
      const { service, shell } = await fixture({ canAccessProject: () => allowed });
      const live = follow(await service.watchTerminal(ids.window, scope));
      await vi.advanceTimersByTimeAsync(1_100);
      shell.print("while allowed\n");
      await vi.advanceTimersByTimeAsync(20);
      expect(applied(live.received)).toBe("while allowed\n");

      allowed = false;
      await vi.advanceTimersByTimeAsync(1_100);
      await live.finished;
      shell.print("after revocation\n");
      await vi.advanceTimersByTimeAsync(100);
      expect(applied(live.received)).toBe("while allowed\n");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a paired device's stream open past the first recheck, which no request still backs", async () => {
    vi.useFakeTimers();
    try {
      let strict = false;
      const access = new CodeProjectAccess({
        readWorkspace: () => undefined,
        hasActiveCodeProject: () => true,
        isWindowLive: () => true,
      });
      const { service, shell } = await fixture({
        canAccessProject: (windowId) =>
          !strict || access.canAccessProject(windowId, thread().projectId),
        retainProjectAccess: (windowId) => access.retain(windowId),
      });
      strict = true;
      const clientLeaves = new AbortController();
      const handler = createCodeRouteHandler({
        service: {
          watchTerminal: (windowId: WindowId, input: never) =>
            service.watchTerminal(windowId, input),
        } as never,
        windowAuthorityStore: new WindowAuthorityStore(),
      });
      const dispatch = createAuthenticatedProductDispatch({
        dispatch: (request, context) => access.run(context, () => handler(request)),
      });
      const response = await dispatch({
        principal: {
          kind: "remote-device",
          deviceId: Schema.decodeUnknownSync(DeviceId)(String(ids.window)),
          hostId: Schema.decodeUnknownSync(StableHostId)("00000000-0000-4000-8000-00000000c002"),
          credentialGeneration: 1,
          origin: "https://octant.example",
          protocolVersion: 1,
          capabilityDigest: "b".repeat(64),
          sessionId: Schema.decodeUnknownSync(RemoteSessionId)(
            "00000000-0000-4000-8000-00000000c003",
          ),
        },
        request: new Request(
          `https://octant.example/api/code/terminals/live?threadId=${ids.thread}&checkoutId=${ids.checkout}&terminalId=${ids.terminal}`,
          { signal: clientLeaves.signal },
        ),
      });
      expect(response?.status).toBe(200);
      const reader = response!.body!.getReader();
      const lines: string[] = [];
      let ended = false;
      const decoder = new TextDecoder();
      const pump = (async () => {
        for (;;) {
          const next = await reader.read();
          if (next.done) {
            ended = true;
            return;
          }
          lines.push(...decoder.decode(next.value).split("\n").filter(Boolean));
        }
      })();

      await vi.advanceTimersByTimeAsync(2_500);
      shell.print("still here\n");
      await vi.advanceTimersByTimeAsync(50);

      expect(ended).toBe(false);
      expect(lines.map((line) => JSON.parse(line).text).join("")).toContain("still here");
      clientLeaves.abort();
      await vi.advanceTimersByTimeAsync(0);
      await reader.cancel();
      await pump;
    } finally {
      vi.useRealTimers();
    }
  });

  it("journals only new output when two surfaces attach together", async () => {
    vi.useFakeTimers();
    try {
      const { service, shell, events, evidenceTexts } = await fixture();
      shell.print("one\n");
      await vi.advanceTimersByTimeAsync(100);
      const outputAppends = () =>
        events.append.mock.calls.filter(([entry]) => entry.event.kind === "terminal-output").length;
      const before = outputAppends();
      const attach = (operationId: string) =>
        service.execute(ids.window, {
          kind: "attach-terminal",
          operationId: decodeCodeOperationId(operationId),
          ...scope,
        });

      await Promise.all([
        attach("6a6a6a6a-6a6a-4a6a-8a6a-6a6a6a6a6a6a"),
        attach("6b6b6b6b-6b6b-4b6b-8b6b-6b6b6b6b6b6b"),
      ]);

      // Both surfaces were handed everything printed so far as their replay,
      // so attaching journals no output at all.
      expect(outputAppends()).toBe(before);
      evidenceTexts.length = 0;
      shell.print("two\n");
      await vi.advanceTimersByTimeAsync(100);
      expect(evidenceTexts).toEqual(["two\n"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps journaling the surface whose live stream is open when older readers are collected", async () => {
    vi.useFakeTimers();
    try {
      const { service, shell, events } = await fixture();
      const live = follow(
        await service.watchTerminal(ids.window, { ...scope, operationId: ids.operation }),
      );
      await vi.advanceTimersByTimeAsync(0);
      for (const id of [
        "6a6a6a6a-6a6a-4a6a-8a6a-6a6a6a6a6a6a",
        "6b6b6b6b-6b6b-4b6b-8b6b-6b6b6b6b6b6b",
        "6c6c6c6c-6c6c-4c6c-8c6c-6c6c6c6c6c6c",
        "6d6d6d6d-6d6d-4d6d-8d6d-6d6d6d6d6d6d",
      ]) {
        await service.execute(ids.window, {
          kind: "attach-terminal",
          operationId: decodeCodeOperationId(id),
          ...scope,
        });
      }
      shell.print("after\n");
      await vi.advanceTimersByTimeAsync(100);

      const journaled = events.append.mock.calls
        .map(([entry]) => entry)
        .filter((entry) => entry.event.kind === "terminal-output")
        .map((entry) => String(entry.operationId));
      expect(journaled).toContain(String(ids.operation));
      service.revokeTerminalStreams(ids.window);
      await live.finished;
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends a stream whose window was revoked while the shell was still launching", async () => {
    const { service, finishLaunch, launched } = await fixture({ deferLaunch: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const opening = service.watchTerminal(ids.window, scope);
    await new Promise((resolve) => setTimeout(resolve, 0));

    service.revokeTerminalStreams(ids.window);
    finishLaunch();
    await launched;

    await expect(opening).rejects.toMatchObject({ category: "unauthorized" });
  });

  it("holds each terminal to four live streams and frees one the moment its window is revoked", async () => {
    vi.useFakeTimers();
    try {
      const { service } = await fixture();
      const open = async () => {
        const frames = (await service.watchTerminal(ids.window, scope))[Symbol.asyncIterator]();
        // Taking the first frame leaves the stream stalled at its yield.
        await frames.next();
        return frames;
      };
      const streams = [await open(), await open(), await open(), await open()];
      await expect(service.watchTerminal(ids.window, scope)).rejects.toMatchObject({
        category: "unavailable",
      });

      service.revokeTerminalStreams(ids.window);
      await vi.advanceTimersByTimeAsync(0);

      // No reader had to pull again for the streams to be released.
      await expect(open()).resolves.toBeDefined();
      for (const stream of streams) await stream.return?.(undefined);
    } finally {
      vi.useRealTimers();
    }
  });
});
