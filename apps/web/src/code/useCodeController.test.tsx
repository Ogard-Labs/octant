import {
  CodeClientSnapshotRequiredError,
  type CodeClient,
} from "@octant/client-runtime/code-client";
import type {
  CodeBootstrap,
  CodeCommand,
  CodeCommandResult,
  CodeThreadId,
  CodeThreadView,
} from "@octant/contracts/code";
import { decodeProjectId } from "@octant/contracts/projects";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useCodeController } from "./useCodeController";

const now = "2026-07-21T12:00:00.000Z";
const ids = {
  bindingRevision: "30000000-0000-4000-8000-000000000001",
  checkout: "40000000-0000-4000-8000-000000000001",
  project: decodeProjectId("20000000-0000-4000-8000-000000000001"),
  provider: "50000000-0000-4000-8000-000000000001",
  thread: "10000000-0000-4000-8000-000000000001" as CodeThreadId,
} as const;
const repositoryId = `repo_${"a".repeat(64)}`;

describe("useCodeController", () => {
  it("keeps execute stable across controller state updates", async () => {
    const client = fakeClient();
    const { result } = renderHook(() => useCodeController({ client }));

    const execute = result.current.execute;
    await act(async () => {
      await result.current.execute({
        kind: "update-code-settings",
        expectedVersion: 1 as never,
        defaultExecutionPolicy: "approval-gated",
        defaultPermissionPersistence: "current-session",
      });
    });

    expect(result.current.execute).toBe(execute);
  });

  it("preserves bootstrap after retrieving worktree remote facts", async () => {
    const client = fakeClient({
      execute: vi.fn(async (command: CodeCommand): Promise<CodeCommandResult> => {
        if (command.kind === "get-worktree-remote-facts") {
          return {
            kind: "worktree-remote-facts-retrieved",
            projectId: command.projectId,
            facts: { remotes: ["origin"], defaultRemote: "origin" },
          };
        }
        return command as unknown as CodeCommandResult;
      }),
    });
    const { result } = renderHook(() => useCodeController({ client }));
    await waitFor(() => expect(result.current.bootstrap).toBeDefined());

    await act(async () => {
      await result.current.execute({ kind: "get-worktree-remote-facts", projectId: ids.project });
    });

    expect(result.current.bootstrap).toBeDefined();
  });

  it("updates new-thread defaults with the observed settings version", async () => {
    const client = fakeClient({
      execute: vi.fn(
        async () =>
          ({
            kind: "settings-updated",
            settings: {
              ...bootstrap().settings,
              defaultExecutionPolicy: "plan",
              version: 2,
            },
          }) as never,
      ),
    });
    const { result } = renderHook(() => useCodeController({ client }));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => {
      await result.current.updateSettings({
        defaultExecutionPolicy: "plan",
        defaultPermissionPersistence: "current-session",
      });
    });
    expect(client.execute).toHaveBeenCalledWith({
      kind: "update-code-settings",
      expectedVersion: 1,
      defaultExecutionPolicy: "plan",
      defaultPermissionPersistence: "current-session",
    });
    expect(result.current.bootstrap?.settings.defaultExecutionPolicy).toBe("plan");
  });

  it("returns the server-resolved worktree source preview without projecting it and forwards the signal", async () => {
    const previewed = {
      kind: "worktree-source-previewed",
      preview: {
        kind: "origin",
        remoteName: "origin",
        branch: "development",
        resolvedHead: "a".repeat(40),
        fetchedAt: now,
      },
    } as never;
    const client = fakeClient({ execute: vi.fn(async () => previewed) });
    const { result } = renderHook(() => useCodeController({ client }));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const before = result.current.bootstrap;
    const signal = new AbortController().signal;

    let returned: CodeCommandResult | undefined;
    await act(async () => {
      returned = await result.current.execute(
        {
          kind: "preview-code-worktree-source",
          projectId: ids.project,
          bindingRevisionId: ids.bindingRevision,
          repositoryId,
          refIntent: "refs/heads/development",
          startFromOrigin: true,
          remoteName: "origin",
        } as CodeCommand,
        signal,
      );
    });

    expect(returned).toEqual(previewed);
    expect(client.execute).toHaveBeenCalledWith(expect.any(Object), signal);
    expect(result.current.bootstrap).toEqual(before);
  });

  it("projects a managed-thread-created result into both threads and checkouts", async () => {
    const managedCheckoutId = "40000000-0000-4000-8000-000000000009";
    const managedCheckout = {
      id: managedCheckoutId as never,
      repositoryId: repositoryId as never,
      kind: "managed-worktree",
      availability: "available",
      head: { kind: "branch", name: "octant/managed" as never, oid: "a".repeat(40) as never },
      ownershipReceiptId: "50000000-0000-4000-8000-000000000009" as never,
      observedAt: now as never,
    };
    const managedThread = { ...thread(1), checkoutId: managedCheckoutId as never };
    const client = fakeClient({
      execute: vi.fn(
        async () =>
          ({
            kind: "managed-thread-created",
            thread: managedThread,
            checkout: managedCheckout,
            provenance: {
              receiptId: "50000000-0000-4000-8000-000000000009",
              mode: "origin",
              branch: "development",
              resolvedHead: "a".repeat(40),
              remoteName: "origin",
              fetchedAt: now,
            },
          }) as never,
      ),
    });
    const { result } = renderHook(() => useCodeController({ client }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let returned: CodeCommandResult | undefined;
    await act(async () => {
      returned = await result.current.execute({
        kind: "create-managed-code-thread",
      } as unknown as CodeCommand);
    });

    expect(returned?.kind).toBe("managed-thread-created");
    expect(result.current.bootstrap?.checkouts.some((c) => c.id === managedCheckoutId)).toBe(true);
    expect(result.current.bootstrap?.threads.some((t) => t.checkoutId === managedCheckoutId)).toBe(
      true,
    );
  });

  it("F4: exposes the typed actionable failure from a rejected managed creation", async () => {
    const client = fakeClient({
      execute: vi.fn(async () => {
        throw {
          category: "conflict",
          message:
            "The delivery branch already exists. Choose a different delivery branch and retry.",
        };
      }),
    });
    const { result } = renderHook(() => useCodeController({ client }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let returned: CodeCommandResult | undefined;
    await act(async () => {
      returned = await result.current.execute({
        kind: "create-managed-code-thread",
      } as unknown as CodeCommand);
    });

    expect(returned).toBeUndefined();
    expect(result.current.lastExecuteError.current).toEqual({
      category: "conflict",
      message: "The delivery branch already exists. Choose a different delivery branch and retry.",
    });
  });

  it("installs a server-prepared checkout before thread creation", async () => {
    const prepared = { ...checkout(), id: "40000000-0000-4000-8000-000000000002" as never };
    const client = fakeClient({
      execute: vi.fn(
        async () =>
          ({
            kind: "checkout-prepared",
            bindingRevisionId: ids.bindingRevision,
            checkout: prepared,
          }) as never,
      ),
    });
    const { result } = renderHook(() => useCodeController({ client }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.execute({
        kind: "prepare-code-project-checkout",
        projectId: ids.project as never,
      });
    });

    expect(result.current.bootstrap?.checkouts).toContainEqual(prepared);
  });

  it("bootstraps authoritative navigation and activates a thread through codeClient only", async () => {
    const client = fakeClient();
    const { result, unmount } = renderHook(() =>
      useCodeController({ activeThreadId: ids.thread, client, reconnectDelayMs: 60_000 }),
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));
    await waitFor(() => expect(result.current.activeView?.thread.id).toBe(ids.thread));

    expect(result.current.navigation).toEqual([
      expect.objectContaining({
        lifecycle: "active",
        projectId: ids.project,
        threadId: ids.thread,
        title: "Controller foundation",
      }),
    ]);
    expect(client.bootstrap).toHaveBeenCalledOnce();
    expect(client.thread).toHaveBeenCalledWith(ids.thread);
    expect(client.thread).toHaveBeenCalledTimes(1);
    expect(client.subscribe).toHaveBeenCalledWith(ids.thread, 1, expect.any(AbortSignal));
    unmount();
  });

  it("does not refetch an unchanged thread after a finite empty replay", async () => {
    const client = fakeClient({ subscribe: vi.fn(async function* () {}) });
    const { result, unmount } = renderHook(() =>
      useCodeController({ activeThreadId: ids.thread, client, reconnectDelayMs: 60_000 }),
    );

    await waitFor(() => expect(result.current.activeView?.thread.id).toBe(ids.thread));
    await waitFor(() => expect(client.subscribe).toHaveBeenCalledOnce());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(client.thread).toHaveBeenCalledOnce();
    unmount();
  });

  it("recovers a replay gap from a snapshot without dropping the pending draft", async () => {
    const gap = deferred<void>();
    const recovered = view(2);
    const client = fakeClient({
      subscribe: vi.fn(() => gapStream(gap.promise)),
      thread: vi.fn().mockResolvedValueOnce(view(1)).mockResolvedValue(recovered),
    });
    const { result, unmount } = renderHook(() =>
      useCodeController({ activeThreadId: ids.thread, client, reconnectDelayMs: 60_000 }),
    );
    await waitFor(() => expect(result.current.activeView?.lastSequence).toBe(1));

    act(() => result.current.setPendingDraft("Keep this prompt"));
    await act(async () => gap.resolve());

    await waitFor(() => expect(result.current.activeView?.lastSequence).toBe(2));
    expect(result.current.pendingDraft).toBe("Keep this prompt");
    expect(client.thread).toHaveBeenCalledTimes(2);
    unmount();
  });

  it("reloads authoritative state after a stale command and preserves the draft", async () => {
    const client = fakeClient({
      bootstrap: vi.fn().mockResolvedValueOnce(bootstrap()).mockResolvedValue(bootstrap(2)),
      execute: vi.fn(async () => {
        throw { category: "stale", message: "Thread changed elsewhere." };
      }),
    });
    const { result, unmount } = renderHook(() =>
      useCodeController({ client, reconnectDelayMs: 60_000 }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => result.current.setPendingDraft("Do not discard"));

    await act(async () => {
      await result.current.execute({
        kind: "change-code-thread-lifecycle",
        threadId: ids.thread,
        expectedVersion: 1 as never,
        lifecycle: "archived",
      });
    });

    expect(result.current.status).toBe("ready");
    expect(result.current.bootstrap?.threads[0]?.version).toBe(2);
    expect(result.current.pendingDraft).toBe("Do not discard");
    expect(client.bootstrap).toHaveBeenCalledTimes(2);
    unmount();
  });

  it("clears the previous active view while a different thread is loading", async () => {
    const nextThreadId = "10000000-0000-4000-8000-000000000002" as CodeThreadId;
    const nextView = deferred<CodeThreadView>();
    const client = fakeClient({
      thread: vi.fn((threadId) =>
        threadId === ids.thread ? Promise.resolve(view(1)) : nextView.promise,
      ),
    });
    const { result, rerender, unmount } = renderHook(
      ({ activeThreadId }) =>
        useCodeController({
          ...(activeThreadId === undefined ? {} : { activeThreadId }),
          client,
          reconnectDelayMs: 60_000,
        }),
      { initialProps: { activeThreadId: ids.thread } },
    );
    await waitFor(() => expect(result.current.activeView?.thread.id).toBe(ids.thread));

    rerender({ activeThreadId: nextThreadId });

    expect(result.current.activeView).toBeUndefined();
    nextView.resolve({ ...view(1), thread: { ...thread(1), id: nextThreadId } });
    await waitFor(() => expect(result.current.activeView?.thread.id).toBe(nextThreadId));
    unmount();
  });

  it("stages prompt evidence and starts a provider turn for follow-ups", async () => {
    const operationId = "70000000-0000-4000-8000-000000000001";
    const contentId = "60000000-0000-4000-8000-000000000001";
    const putEvidence = vi.fn(async () => ({
      contentId,
      digest: "a".repeat(64),
      byteLength: 11,
    }));
    const executeOperation = vi.fn(async () => ({
      kind: "provider-turn-state",
      operationId,
      state: "running",
    }));
    async function* initialFrames() {
      yield {
        threadId: ids.thread,
        operationId,
        cursor: 1,
        occurredAt: now,
        event: {
          kind: "operation-result",
          result: {
            kind: "provider-turn-state",
            operationId,
            state: "running",
          },
        },
      };
    }
    async function* completionFrames() {
      yield {
        threadId: ids.thread,
        operationId,
        cursor: 2,
        occurredAt: now,
        event: {
          kind: "provider-content",
          channel: "message",
          content: { contentId, digest: "b".repeat(64), byteLength: 5 },
        },
      };
      yield {
        threadId: ids.thread,
        operationId,
        cursor: 3,
        occurredAt: now,
        event: { kind: "operation-state", state: "completed" },
      };
    }
    const subscribeOperation = vi.fn((_threadId, _operationId, cursor) =>
      cursor === 0 ? initialFrames() : completionFrames(),
    );
    const client = fakeClient({
      putEvidence: putEvidence as never,
      executeOperation: executeOperation as never,
      subscribeOperation: subscribeOperation as never,
      operationContent: vi.fn(async () => new TextEncoder().encode("hello")),
    });
    const { result } = renderHook(() =>
      useCodeController({ activeThreadId: ids.thread, client, reconnectDelayMs: 60_000 }),
    );
    await waitFor(() => expect(result.current.activeView?.thread.id).toBe(ids.thread));

    let ok = false;
    await act(async () => {
      ok = await result.current.sendFollowUp("check tests");
    });

    expect(ok).toBe(true);
    expect(putEvidence).toHaveBeenCalledWith(ids.thread, "check tests");
    // A follow-up that names no thread sends exactly the command it always
    // did: mention plumbing adds nothing to the ordinary path.
    expect(executeOperation).toHaveBeenCalledWith({
      kind: "start-provider-turn",
      operationId: expect.any(String),
      threadId: ids.thread,
      checkoutId: ids.checkout,
      sessionId: expect.any(String),
      prompt: {
        contentId,
        digest: "a".repeat(64),
        byteLength: 11,
      },
    });
    expect(result.current.conversation.map((message) => message.text)).toEqual([
      "check tests",
      "hello",
    ]);
    expect(result.current.conversation).toEqual([
      expect.objectContaining({
        role: "user",
        providerInstanceId: ids.provider,
        modelId: "model-a",
      }),
      expect.objectContaining({
        role: "assistant",
        providerInstanceId: ids.provider,
        modelId: "model-a",
      }),
    ]);
    expect(subscribeOperation).toHaveBeenCalledTimes(2);
    expect(result.current.turnStatus).toBe("idle");
  });

  it("names a follow-up's mentioned threads on the turn without staging them as the message", async () => {
    const operationId = "70000000-0000-4000-8000-000000000002";
    const putEvidence = vi.fn(async () => ({
      contentId: "60000000-0000-4000-8000-000000000002",
      digest: "a".repeat(64),
      byteLength: 21,
    }));
    const executeOperation = vi.fn(async () => ({
      kind: "provider-turn-state",
      operationId,
      state: "running",
    }));
    async function* completedFrames() {
      yield {
        threadId: ids.thread,
        operationId,
        cursor: 1,
        occurredAt: now,
        event: { kind: "operation-state", state: "completed" },
      };
    }
    const client = fakeClient({
      putEvidence: putEvidence as never,
      executeOperation: executeOperation as never,
      subscribeOperation: vi.fn(() => completedFrames()) as never,
    });
    const { result } = renderHook(() =>
      useCodeController({ activeThreadId: ids.thread, client, reconnectDelayMs: 60_000 }),
    );
    await waitFor(() => expect(result.current.activeView?.thread.id).toBe(ids.thread));

    await act(async () => {
      await result.current.sendFollowUp("does this still hold?", ["release-notes-thread" as never]);
    });

    // The prompt evidence the journal records as the user's message is exactly
    // what they typed; the mention is named alongside it so the host can read
    // that thread itself, for this turn only.
    expect(putEvidence).toHaveBeenCalledWith(ids.thread, "does this still hold?");
    expect(executeOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "start-provider-turn",
        threadMentionIds: ["release-notes-thread"],
      }),
    );
    expect(result.current.conversation.filter((message) => message.role === "user")[0]?.text).toBe(
      "does this still hold?",
    );
  });

  it("collects tool activity and reasoning from the turn stream for the transcript", async () => {
    const operationId = "70000000-0000-4000-8000-000000000061";
    const contentId = "60000000-0000-4000-8000-000000000061";
    async function* frames() {
      yield {
        threadId: ids.thread,
        operationId,
        cursor: 1,
        occurredAt: now,
        event: {
          kind: "tool-activity",
          toolCallId: "call-1",
          toolName: "Bash",
          state: "running",
          summary: "bun run verify",
        },
      };
      yield {
        threadId: ids.thread,
        operationId,
        cursor: 2,
        occurredAt: now,
        event: {
          kind: "provider-content",
          channel: "reasoning",
          content: { contentId, digest: "b".repeat(64), byteLength: 5 },
        },
      };
      yield {
        threadId: ids.thread,
        operationId,
        cursor: 3,
        occurredAt: now,
        event: {
          kind: "tool-activity",
          toolCallId: "call-1",
          toolName: "Bash",
          state: "completed",
          summary: "bun run verify",
        },
      };
      yield {
        threadId: ids.thread,
        operationId,
        cursor: 4,
        occurredAt: now,
        event: { kind: "operation-state", state: "completed" },
      };
    }
    const client = fakeClient({
      putEvidence: vi.fn(async () => ({ contentId, digest: "a".repeat(64), byteLength: 4 })) as never,
      executeOperation: vi.fn(async () => ({
        kind: "provider-turn-state",
        operationId,
        state: "running",
      })) as never,
      subscribeOperation: vi.fn(() => frames()) as never,
      operationContent: vi.fn(async () => new TextEncoder().encode("plan.")),
    });
    const { result } = renderHook(() =>
      useCodeController({ activeThreadId: ids.thread, client, reconnectDelayMs: 60_000 }),
    );
    await waitFor(() => expect(result.current.activeView?.thread.id).toBe(ids.thread));

    await act(async () => {
      await result.current.sendFollowUp("run it");
    });

    // The host is told which operation to run; activity is keyed by that same
    // client-minted id, which is also what the live message carries.
    const startedOperationId = result.current.conversation.find(
      (message) => message.role === "assistant",
    )?.operationId;
    expect(startedOperationId).toBeDefined();
    const activity = result.current.turnActivity.get(String(startedOperationId));
    // The tool row reflects the last state the host reported, not one row per
    // state change, and reasoning stays out of the assistant message text.
    expect(activity?.rows).toEqual([
      { kind: "tool", id: "call-1", toolName: "Bash", state: "completed", summary: "bun run verify" },
    ]);
    expect(activity?.reasoning).toBe("plan.");
    expect(
      result.current.conversation.find((message) => message.role === "assistant")?.text,
    ).not.toContain("plan.");
  });

  it("sends a queued follow-up once the running turn settles, and forgets a cancelled one", async () => {
    const operationId = "70000000-0000-4000-8000-000000000041";
    const putEvidence = vi.fn(async () => ({
      contentId: "60000000-0000-4000-8000-000000000041",
      digest: "a".repeat(64),
      byteLength: 5,
    }));
    const executeOperation = vi.fn(async () => ({
      kind: "provider-turn-state",
      operationId,
      state: "running",
    }));
    // The first turn stays open until the test releases it, which is what lets
    // the queue be observed while a turn is genuinely running.
    let settleFirstTurn = () => {};
    const firstTurnSettled = new Promise<void>((resolve) => {
      settleFirstTurn = resolve;
    });
    let subscriptions = 0;
    async function* frames() {
      subscriptions += 1;
      if (subscriptions === 1) await firstTurnSettled;
      yield {
        threadId: ids.thread,
        operationId,
        cursor: 1,
        occurredAt: now,
        event: { kind: "operation-state", state: "completed" },
      };
    }
    const client = fakeClient({
      putEvidence: putEvidence as never,
      executeOperation: executeOperation as never,
      subscribeOperation: vi.fn(() => frames()) as never,
    });
    const { result } = renderHook(() =>
      useCodeController({ activeThreadId: ids.thread, client, reconnectDelayMs: 60_000 }),
    );
    await waitFor(() => expect(result.current.activeView?.thread.id).toBe(ids.thread));

    const running = result.current.sendFollowUp("running turn");
    await waitFor(() => expect(result.current.turnStatus).toBe("running"));

    // Queue two follow-ups the way the composer does while a turn runs, then
    // cancel the second: only the first must ever reach the host.
    let cancelledId = "";
    act(() => {
      result.current.queueFollowUp("first queued");
      cancelledId = result.current.queueFollowUp("second queued")?.id ?? "";
    });
    expect(result.current.queuedFollowUps.map((turn) => turn.prompt)).toEqual([
      "first queued",
      "second queued",
    ]);
    expect(executeOperation).toHaveBeenCalledTimes(1);
    act(() => {
      result.current.cancelQueuedFollowUp(cancelledId);
    });

    await act(async () => {
      settleFirstTurn();
      await running;
    });

    await waitFor(() => expect(result.current.queuedFollowUps).toEqual([]));
    expect(putEvidence).toHaveBeenCalledWith(ids.thread, "first queued");
    expect(putEvidence).not.toHaveBeenCalledWith(ids.thread, "second queued");
    expect(executeOperation).toHaveBeenCalledTimes(2);
  });

  it("settles a waiting provider turn and keeps the prompt available for retry", async () => {
    const operationId = "70000000-0000-4000-8000-000000000031";
    async function* waitingFrames() {
      yield {
        threadId: ids.thread,
        operationId,
        cursor: 1,
        occurredAt: now,
        event: { kind: "operation-state", state: "waiting" },
      };
    }
    const subscribeOperation = vi.fn(() => waitingFrames());
    const client = fakeClient({
      executeOperation: vi.fn(async () => ({
        kind: "provider-turn-state",
        operationId,
        state: "running",
      })) as never,
      subscribeOperation: subscribeOperation as never,
    });
    const { result } = renderHook(() =>
      useCodeController({ activeThreadId: ids.thread, client, reconnectDelayMs: 60_000 }),
    );
    await waitFor(() => expect(result.current.activeView?.thread.id).toBe(ids.thread));

    let ok = true;
    await act(async () => {
      ok = await result.current.sendFollowUp("approve this turn");
    });

    expect(ok).toBe(false);
    expect(subscribeOperation).toHaveBeenCalledOnce();
    expect(result.current.turnStatus).toBe("failed");
    expect(result.current.turnError).toMatch(/waiting for approval, input, or recovery/i);
    expect(result.current.pendingDraft).toBe("approve this turn");
  });

  it("keeps a prompt editable when the provider turn cannot start", async () => {
    const client = fakeClient({
      executeOperation: vi.fn(async () => ({
        kind: "operation-failed",
        failure: { category: "unavailable", message: "Provider is offline." },
      })) as never,
    });
    const { result } = renderHook(() =>
      useCodeController({ activeThreadId: ids.thread, client, reconnectDelayMs: 60_000 }),
    );
    await waitFor(() => expect(result.current.activeView?.thread.id).toBe(ids.thread));
    act(() => result.current.setPendingDraft("retry this prompt"));

    let ok = true;
    await act(async () => {
      ok = await result.current.sendFollowUp("retry this prompt");
    });

    expect(ok).toBe(false);
    expect(result.current.pendingDraft).toBe("retry this prompt");
    expect(result.current.conversation).toEqual([]);
    expect(result.current.turnError).toBe("Provider is offline.");
  });

  it("does not start a stale provider turn after navigating away during evidence upload", async () => {
    const evidence = deferred<{
      contentId: string;
      digest: string;
      byteLength: number;
    }>();
    const executeOperation = vi.fn();
    const client = fakeClient({
      putEvidence: vi.fn(() => evidence.promise) as never,
      executeOperation: executeOperation as never,
    });
    const { result, rerender } = renderHook(
      ({ activeThreadId }) =>
        useCodeController({
          ...(activeThreadId === undefined ? {} : { activeThreadId }),
          client,
          reconnectDelayMs: 60_000,
        }),
      { initialProps: { activeThreadId: ids.thread as CodeThreadId | undefined } },
    );
    await waitFor(() => expect(result.current.activeView?.thread.id).toBe(ids.thread));

    let sent: Promise<boolean> | undefined;
    act(() => {
      sent = result.current.sendFollowUp("Do not send this after navigation");
    });
    await waitFor(() => expect(client.putEvidence).toHaveBeenCalledOnce());
    rerender({ activeThreadId: undefined });
    evidence.resolve({
      contentId: "60000000-0000-4000-8000-000000000022",
      digest: "d".repeat(64),
      byteLength: 33,
    });

    await expect(sent).resolves.toBe(false);
    expect(executeOperation).not.toHaveBeenCalled();
  });

  it("durably starts a first provider turn before its thread is active", async () => {
    const contentId = "60000000-0000-4000-8000-000000000021";
    const putEvidence = vi.fn(async () => ({
      contentId,
      digest: "c".repeat(64),
      byteLength: 17,
    }));
    const executeOperation = vi.fn(async (command) => ({
      kind: "provider-turn-state" as const,
      operationId: command.operationId,
      state: "running" as const,
    }));
    const client = fakeClient({
      putEvidence: putEvidence as never,
      executeOperation: executeOperation as never,
    });
    const { result } = renderHook(() => useCodeController({ client }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let started = false;
    await act(async () => {
      started = await result.current.startThreadTurn({
        threadId: ids.thread,
        checkoutId: ids.checkout as never,
        prompt: "Persist this first prompt",
      });
    });

    expect(started).toBe(true);
    expect(putEvidence).toHaveBeenCalledWith(ids.thread, "Persist this first prompt");
    expect(executeOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "start-provider-turn",
        threadId: ids.thread,
        checkoutId: ids.checkout,
        prompt: { contentId, digest: "c".repeat(64), byteLength: 17 },
      }),
    );
    expect(result.current.conversation).toEqual([]);
  });

  it("restores a failed first-turn prompt when its newly created thread becomes active", async () => {
    const client = fakeClient({
      executeOperation: vi.fn(async () => ({
        kind: "operation-failed",
        operationId: "70000000-0000-4000-8000-000000000023",
        failure: { category: "unavailable", message: "Provider is offline." },
      })) as never,
    });
    const { result, rerender } = renderHook(
      ({ activeThreadId }) =>
        useCodeController({
          ...(activeThreadId === undefined ? {} : { activeThreadId }),
          client,
          reconnectDelayMs: 60_000,
        }),
      { initialProps: { activeThreadId: undefined as CodeThreadId | undefined } },
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.startThreadTurn({
        threadId: ids.thread,
        checkoutId: ids.checkout as never,
        prompt: "Keep this first prompt",
      });
    });
    rerender({ activeThreadId: ids.thread });

    await waitFor(() => expect(result.current.activeView?.thread.id).toBe(ids.thread));
    expect(result.current.pendingDraft).toBe("Keep this first prompt");
    expect(result.current.turnError).toBe("Provider is offline.");
  });

  it("hydrates authoritative conversation evidence after reload", async () => {
    const promptId = "60000000-0000-4000-8000-000000000010";
    const replyId = "60000000-0000-4000-8000-000000000011";
    const operationId = "70000000-0000-4000-8000-000000000010";
    const conversation = vi.fn(async () => ({
      version: 1 as const,
      threadId: ids.thread,
      turns: [
        {
          operationId,
          providerInstanceId: ids.provider,
          modelId: "model-before-rebind",
          sessionId: "80000000-0000-4000-8000-000000000010",
          prompt: { contentId: promptId, digest: "a".repeat(64), byteLength: 11 },
          assistant: [{ contentId: replyId, digest: "b".repeat(64), byteLength: 12 }],
          status: "failed" as const,
          startedAt: now,
          updatedAt: now,
        },
      ],
      nextCursor: 42,
      hasMore: false,
    }));
    const operationContent = vi.fn(async (_threadId, _operationId, contentId) =>
      new TextEncoder().encode(contentId === promptId ? "check tests" : "tests failed"),
    );
    const client = fakeClient({ conversation: conversation as never, operationContent });
    const { result, unmount } = renderHook(() =>
      useCodeController({ activeThreadId: ids.thread, client, reconnectDelayMs: 60_000 }),
    );

    await waitFor(() =>
      expect(result.current.conversation.map((message) => message.text)).toEqual([
        "check tests",
        "tests failed",
      ]),
    );
    expect(result.current.conversation[1]).toMatchObject({
      operationId,
      providerInstanceId: ids.provider,
      modelId: "model-before-rebind",
      status: "failed",
    });
    expect(conversation).toHaveBeenCalledWith(ids.thread, 0, 50);
    expect(operationContent).toHaveBeenCalledTimes(2);
    unmount();
  });

  it("refreshes the active conversation when the first provider turn completes", async () => {
    const promptId = "60000000-0000-4000-8000-000000000020";
    const replyId = "60000000-0000-4000-8000-000000000021";
    const operationId = "70000000-0000-4000-8000-000000000020";
    const conversation = vi
      .fn()
      .mockResolvedValueOnce({
        version: 1,
        threadId: ids.thread,
        turns: [
          {
            operationId,
            providerInstanceId: ids.provider,
            modelId: "model-a",
            sessionId: "80000000-0000-4000-8000-000000000020",
            prompt: { contentId: promptId, digest: "a".repeat(64), byteLength: 47 },
            assistant: [],
            status: "incomplete",
            startedAt: now,
            updatedAt: now,
          },
        ],
        nextCursor: 1,
        hasMore: false,
      })
      .mockResolvedValueOnce({
        version: 1,
        threadId: ids.thread,
        turns: [
          {
            operationId,
            providerInstanceId: ids.provider,
            modelId: "model-a",
            sessionId: "80000000-0000-4000-8000-000000000020",
            prompt: { contentId: promptId, digest: "a".repeat(64), byteLength: 47 },
            assistant: [],
            status: "incomplete",
            startedAt: now,
            updatedAt: now,
          },
        ],
        nextCursor: 1,
        hasMore: false,
      })
      .mockResolvedValue({
        version: 1,
        threadId: ids.thread,
        turns: [
          {
            operationId,
            providerInstanceId: ids.provider,
            modelId: "model-a",
            sessionId: "80000000-0000-4000-8000-000000000020",
            prompt: { contentId: promptId, digest: "a".repeat(64), byteLength: 47 },
            assistant: [{ contentId: replyId, digest: "b".repeat(64), byteLength: 10 }],
            status: "completed",
            startedAt: now,
            updatedAt: now,
          },
        ],
        nextCursor: 1,
        hasMore: false,
      });
    async function* completionStream(signal: AbortSignal) {
      yield {
        threadId: ids.thread,
        sequence: 2,
        event: { kind: "thread-updated", thread: thread(2) },
      } as never;
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    }
    const client = fakeClient({
      conversation: conversation as never,
      operationContent: vi.fn(async (_threadId, _operationId, contentId) =>
        new TextEncoder().encode(
          contentId === promptId ? "Reply exactly PROJECT_OK" : "PROJECT_OK",
        ),
      ),
      subscribe: vi.fn((_threadId, _cursor, signal) => completionStream(signal)),
      thread: vi.fn().mockResolvedValueOnce(view(1)).mockResolvedValue(view(2)),
    });
    const { result, unmount } = renderHook(() =>
      useCodeController({ activeThreadId: ids.thread, client, reconnectDelayMs: 60_000 }),
    );

    await waitFor(() => expect(result.current.turnStatus).toBe("running"));
    await waitFor(() =>
      expect(result.current.conversation.at(-1)).toMatchObject({
        role: "assistant",
        status: "completed",
        text: "PROJECT_OK",
      }),
    );
    expect(conversation).toHaveBeenCalledTimes(4);
    expect(conversation).toHaveBeenNthCalledWith(3, ids.thread, 0, 1);
    expect(result.current.turnStatus).toBe("idle");
    unmount();
  });

  it("streams visible content from an already-running first provider turn", async () => {
    const promptId = "60000000-0000-4000-8000-000000000030";
    const liveId = "60000000-0000-4000-8000-000000000031";
    const operationId = "70000000-0000-4000-8000-000000000030";
    const conversation = vi.fn(async () => ({
      version: 1 as const,
      threadId: ids.thread,
      turns: [
        {
          operationId,
          providerInstanceId: ids.provider,
          modelId: "model-a",
          sessionId: "80000000-0000-4000-8000-000000000030",
          prompt: { contentId: promptId, digest: "a".repeat(64), byteLength: 25 },
          assistant: [],
          status: "incomplete" as const,
          startedAt: now,
          updatedAt: now,
        },
      ],
      nextCursor: 1,
      hasMore: false,
    }));
    async function* operationFrames(signal: AbortSignal) {
      yield {
        threadId: ids.thread,
        operationId,
        cursor: 2,
        occurredAt: now,
        event: {
          kind: "provider-content",
          channel: "message",
          content: { contentId: liveId, digest: "b".repeat(64), byteLength: 14 },
        },
      } as never;
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    }
    const client = fakeClient({
      conversation: conversation as never,
      operationContent: vi.fn(async (_threadId, _operationId, contentId) =>
        new TextEncoder().encode(
          contentId === promptId ? "Start this first turn" : "LIVE_REPLY_OK",
        ),
      ),
      subscribeOperation: vi.fn((_threadId, _operationId, _cursor, signal) =>
        operationFrames(signal),
      ),
    });
    const { result, unmount } = renderHook(() =>
      useCodeController({ activeThreadId: ids.thread, client, reconnectDelayMs: 60_000 }),
    );

    await waitFor(() =>
      expect(result.current.conversation.at(-1)).toMatchObject({
        role: "assistant",
        text: "LIVE_REPLY_OK",
        status: "incomplete",
      }),
    );
    expect(result.current.turnStatus).toBe("running");
    unmount();
  });

  it("keeps the Code thread usable when conversation replay is temporarily unavailable", async () => {
    const client = fakeClient({
      conversation: vi.fn(async () => Promise.reject(new Error("offline"))),
    });
    const { result, unmount } = renderHook(() =>
      useCodeController({ activeThreadId: ids.thread, client, reconnectDelayMs: 60_000 }),
    );

    await waitFor(() => expect(result.current.activeView?.thread.id).toBe(ids.thread));
    await waitFor(() =>
      expect(result.current.turnError).toBe("Conversation history could not be loaded."),
    );
    expect(result.current.status).toBe("ready");
    unmount();
  });

  it("surfaces a durable open follow-up on navigation, independent of unread and runtime", async () => {
    const client = fakeClient({ readFollowUp: vi.fn(async () => followUpView(true) as never) });
    const { result } = renderHook(() => useCodeController({ client }));

    await waitFor(() => expect(result.current.navigation[0]?.followUp).toBe(true));
  });

  it("marks a manual follow-up with a strictly newer trigger sequence", async () => {
    const executeFollowUp = vi.fn(async () => ({ kind: "code-follow-up-updated" }) as never);
    const client = fakeClient({
      readFollowUp: vi.fn(async () => followUpView(false) as never),
      executeFollowUp,
    });
    const { result } = renderHook(() => useCodeController({ activeThreadId: ids.thread, client }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.markFollowUp(ids.thread);
    });

    expect(executeFollowUp).toHaveBeenCalledWith({
      kind: "open-code-follow-up",
      threadId: ids.thread,
      expectedVersion: 0,
      reason: "Marked for follow-up",
      origin: "manual",
      triggerSequence: 1,
    });
  });

  it("completes an open follow-up explicitly against its current trigger", async () => {
    const executeFollowUp = vi.fn(async () => ({ kind: "code-follow-up-updated" }) as never);
    const client = fakeClient({
      readFollowUp: vi.fn(async () => followUpView(true) as never),
      executeFollowUp,
    });
    const { result } = renderHook(() => useCodeController({ activeThreadId: ids.thread, client }));
    await waitFor(() => expect(result.current.navigation[0]?.followUp).toBe(true));

    await act(async () => {
      await result.current.completeFollowUp(ids.thread);
    });

    expect(executeFollowUp).toHaveBeenCalledWith({
      kind: "complete-code-follow-up",
      threadId: ids.thread,
      expectedVersion: 2,
      acknowledgedThroughSequence: 5,
    });
  });

  it("does not complete a follow-up that is not open", async () => {
    const executeFollowUp = vi.fn(async () => ({ kind: "code-follow-up-updated" }) as never);
    const client = fakeClient({
      readFollowUp: vi.fn(async () => followUpView(false) as never),
      executeFollowUp,
    });
    const { result } = renderHook(() => useCodeController({ activeThreadId: ids.thread, client }));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      const completed = await result.current.completeFollowUp(ids.thread);
      expect(completed).toBe(false);
    });

    expect(executeFollowUp).not.toHaveBeenCalled();
  });
});

function fakeClient(overrides: Partial<CodeClient> = {}): CodeClient {
  return {
    bootstrap: vi.fn(async () => bootstrap()),
    queryBoard: vi.fn(),
    conversation: vi.fn(async () => ({
      version: 1 as const,
      threadId: ids.thread,
      turns: [],
      nextCursor: 0,
      hasMore: false,
    })),
    content: vi.fn(),
    operationContent: vi.fn(),
    execute: vi.fn(async (command: CodeCommand) => command as unknown as CodeCommandResult),
    executeOperation: vi.fn(),
    inspectTerminal: vi.fn(),
    putEvidence: vi.fn(async () => ({
      contentId: "60000000-0000-4000-8000-000000000001" as never,
      digest: "a".repeat(64),
      byteLength: 4,
    })),
    save: vi.fn(),
    openFile: vi.fn(),
    subscribe: vi.fn((_threadId, _cursor, signal) => idleStream(signal)),
    subscribeOperation: vi.fn(),
    thread: vi.fn(async () => view(1)),
    readFollowUp: vi.fn(async (threadId) => ({ threadId, followUpVersion: 0 }) as never),
    executeFollowUp: vi.fn(
      async () =>
        ({
          kind: "code-follow-up-updated",
          followUp: openFollowUp(),
        }) as never,
    ),
    ...overrides,
  };
}

function followUpView(open: boolean): unknown {
  return {
    threadId: ids.thread,
    followUpVersion: open ? 2 : 0,
    ...(open ? { followUp: openFollowUp() } : {}),
  };
}

function openFollowUp() {
  return {
    threadId: ids.thread,
    state: "open" as const,
    origin: "automatic" as const,
    reason: "Approval requested",
    triggerSequence: 5,
    acknowledgedThroughSequence: 0,
    createdAt: now,
  };
}

function bootstrap(version = 1): CodeBootstrap {
  return {
    checkouts: [checkout()],
    settings: {
      defaultExecutionPolicy: "approval-gated",
      defaultPermissionPersistence: "current-session",
      updatedAt: now as never,
      version: 1 as never,
    },
    threads: [thread(version)],
  };
}

function view(sequence: number): CodeThreadView {
  return { checkout: checkout(), lastSequence: sequence as never, thread: thread(sequence) };
}

function checkout(): CodeThreadView["checkout"] {
  return {
    id: ids.checkout as never,
    repositoryId: repositoryId as never,
    kind: "existing-worktree",
    availability: "available",
    head: { kind: "branch", name: "development" as never, oid: "a".repeat(40) as never },
    observedAt: now as never,
  };
}

function thread(version: number): CodeThreadView["thread"] {
  return {
    id: ids.thread,
    projectId: ids.project as never,
    bindingRevisionId: ids.bindingRevision as never,
    repositoryId: repositoryId as never,
    checkoutId: ids.checkout as never,
    title: "Controller foundation",
    lifecycle: "active",
    providerInstanceId: ids.provider as never,
    modelId: "model-a" as never,
    executionPolicy: "approval-gated",
    permissionPersistence: "current-session",
    deliveryTarget: {
      branchIntent: "feature/controller",
      remoteName: "origin",
      proposedBaseRepository: "octocat/octant",
      proposedBaseBranch: "development",
      outcomeKind: "opened-pr",
      confirmedAt: now as never,
    },
    version: version as never,
    createdAt: now as never,
    updatedAt: now as never,
  };
}

async function* idleStream(signal: AbortSignal) {
  await new Promise<void>((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
  yield* [];
}

async function* gapStream(gap: Promise<void>) {
  await gap;
  yield* [];
  throw new CodeClientSnapshotRequiredError(ids.thread, 1, 3);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
