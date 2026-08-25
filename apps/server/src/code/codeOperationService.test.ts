import {
  decodeCodeCheckoutId,
  decodeCodeCheckoutIdentity,
  decodeCodeEvidenceReference,
  decodeCodeOperationId,
  decodeCodeThread,
  decodeCodeThreadId,
  type CodeTerminalId,
  type CodeThread,
  type CodeReviewFinding,
  type CodeReviewFindingId,
  type CodeFileId,
  type WindowId,
} from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  CodeOperationService,
  CodeOperationServiceError,
  CodeOperationSnapshotRequiredError,
  type CodeOperationServiceOptions,
} from "./codeOperationService";
import { ReviewFindingServiceError } from "./reviewFindingService";

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

  it("recovers a stale running provider-turn result by reconstructing the runtime turn", async () => {
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
    });
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
    const asked: Array<{ threadMentionIds: ReadonlyArray<string>; windowId: string }> = [];
    const fixture = providerTurnFixture({
      resolveThreadMentionContext: async (input) => {
        asked.push({
          threadMentionIds: input.threadMentionIds.map(String),
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
    // never taken from the command.
    expect(asked).toEqual([{ threadMentionIds: ["release-notes-thread"], windowId: ids.window }]);
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

  it("gives a forked thread the conversation it branched from, on the host's own reading", async () => {
    const resolveForkHandoff = vi.fn(async () => "Forked from: user asked about the loader.");
    const fixture = providerTurnFixture({
      thread: decodeCodeThread({
        ...thread(),
        forkedFrom: {
          threadId: "b0000000-0000-4000-8000-0000000000ff",
          throughOperationId: "c0000000-0000-4000-8000-0000000000ff",
        },
      }),
      resolveForkHandoff,
    });

    await expect(fixture.service.execute(ids.window, startProviderTurn)).resolves.toMatchObject({
      kind: "provider-turn-state",
      state: "running",
    });

    // The origin comes from the thread record, never from the command, so a
    // renderer cannot choose what history a turn is given. The asking turn is
    // named too: its own start is already journalled, so the resolver cannot
    // tell a first turn from a later one without it.
    expect(resolveForkHandoff).toHaveBeenCalledWith({
      threadId: thread().id,
      origin: {
        threadId: "b0000000-0000-4000-8000-0000000000ff",
        throughOperationId: "c0000000-0000-4000-8000-0000000000ff",
      },
      windowId: ids.window,
      operationId: startProviderTurn.operationId,
    });
    const started = fixture.turns.start.mock.calls[0]![0];
    expect((started.context ?? []).map((block) => block.text).join("\n")).toContain(
      "Forked from: user asked about the loader.",
    );
    // The durable message stays exactly what the user typed.
    expect(started.prompt).toBe("does this still hold?");
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

  it("sends a thread that was never forked without asking for a handoff", async () => {
    const resolveForkHandoff = vi.fn(async () => "should never be read");
    const fixture = providerTurnFixture({ resolveForkHandoff });

    await expect(fixture.service.execute(ids.window, startProviderTurn)).resolves.toMatchObject({
      kind: "provider-turn-state",
    });

    expect(resolveForkHandoff).not.toHaveBeenCalled();
    expect(fixture.turns.start.mock.calls[0]![0].context).toBeUndefined();
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

  it("leaves a Code turn without mentions untouched by the mention resolver", async () => {
    const resolveThreadMentionContext = vi.fn(async () => []);
    const fixture = providerTurnFixture({ resolveThreadMentionContext });

    await fixture.service.execute(ids.window, startProviderTurn);

    expect(resolveThreadMentionContext).not.toHaveBeenCalled();
    expect(fixture.turns.start).toHaveBeenCalledWith({
      windowId: ids.window,
      thread: thread(),
      sessionId: startProviderTurn.sessionId,
      checkoutRoot: "/private/exact-checkout",
      prompt: "does this still hold?",
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
      | "resolveForkHandoff"
      | "attachments"
      | "supportsAttachments"
      | "git"
    >
  > & { readonly thread?: CodeThread } = {},
) {
  const { thread: threadOverride, ...serviceOptions } = options;
  const activeThread = threadOverride ?? thread();
  const turns = {
    start: vi.fn(
      async (_input: Parameters<CodeOperationServiceOptions["turns"]["start"]>[0]) =>
        ({ state: "running" }) as const,
    ),
    answerInput: vi.fn(),
    answerApproval: vi.fn(),
    cancel: vi.fn(),
  };
  const events = {
    replay: vi.fn(() => ({ status: "ok" as const, frames: [], nextCursor: 0 })),
    append: vi.fn(),
  };
  const service = new CodeOperationService({
    authority: {
      readThread: vi.fn(() => activeThread),
      readCheckout: vi.fn(() =>
        decodeCodeCheckoutIdentity({
          id: ids.checkout,
          repositoryId: activeThread.repositoryId,
          kind: "existing-worktree",
          availability: "available",
          head: { kind: "branch", name: "feature/exact", oid: "b".repeat(40) },
          observedAt: "2026-07-21T10:00:00.000Z",
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
    git: {} as never,
    pullRequests: {} as never,
    reviewFindings: {} as never,
    turns: turns as never,
    evidence: { put: vi.fn(), read: vi.fn(async () => "does this still hold?") } as never,
    events: events as never,
    ...serviceOptions,
  });
  return { service, turns, events };
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
