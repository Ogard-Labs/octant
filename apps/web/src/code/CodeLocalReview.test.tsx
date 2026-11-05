import { createHash, webcrypto } from "node:crypto";
import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  decodeCodeBootstrap,
  decodeCodeOperationId,
  decodeCodeThreadView,
  decodeCodeOperationResult,
  decodeCodeOperationEventFrame,
  decodeCodeReviewFinding,
  decodeCodeReviewCorrectionPrepared,
  decodeCodeConversationTurn,
  decodeCodeConversationPage,
  decodeCodeTurnReviewCapture,
  type CodeTurnReviewCapture,
  type CodeReviewFinding,
} from "@octant/contracts";
import { codeClient, ids, scope } from "./CodeDeliveryPane.test-fixtures";
import { CodeThreadWorkspace } from "./CodeThreadWorkspace";
import { useCodeController, createCodeReadCursorStore } from "./useCodeController";
import { DockReviewTool } from "../shell/DockReviewTool";
import {
  composerThreadDrafts,
  COMPOSER_THREAD_DRAFTS_STORAGE_KEY,
} from "../composer/composerThreadDraftStore";
import { queueTestHost } from "../messageQueue/queueTestHost.test-fixture";
import type { CodeReviewFileRequest } from "./codeReviewNavigation";

const now = "2026-11-02T12:00:00.000Z";
const patch =
  "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -4 +4 @@\n-old value\n+new value\n";
const provider = "10000000-0000-4000-8000-000000000101";
const view = decodeCodeThreadView({
  thread: {
    id: ids.thread,
    checkoutId: ids.checkout,
    projectId: ids.thread,
    bindingRevisionId: ids.file,
    repositoryId: `repo_${"a".repeat(64)}`,
    title: "Correct the implementation",
    lifecycle: "active",
    providerInstanceId: provider,
    modelId: "model-a",
    executionPolicy: "plan",
    permissionPersistence: "current-session",
    deliveryTarget: {
      branchIntent: "feature/change",
      remoteName: "origin",
      proposedBaseRepository: "octant/octant",
      proposedBaseBranch: "main",
      outcomeKind: "local-implementation",
      confirmedAt: now,
    },
    version: 1,
    createdAt: now,
    updatedAt: now,
  },
  checkout: {
    id: ids.checkout,
    repositoryId: `repo_${"a".repeat(64)}`,
    kind: "existing-worktree",
    availability: "available",
    head: { kind: "branch", name: "feature/change", oid: "a".repeat(40) },
    observedAt: now,
  },
  lastSequence: 1,
});
const bootstrap = decodeCodeBootstrap({
  threads: [view.thread],
  checkouts: [view.checkout],
  settings: {
    defaultExecutionPolicy: "plan",
    defaultPermissionPersistence: "current-session",
    requireGitRepository: true,
    defaultDiffLayout: "unified",
    version: 1,
    updatedAt: now,
  },
  activity: [],
  runtime: [],
});

beforeEach(() => {
  if (globalThis.crypto.subtle === undefined) vi.stubGlobal("crypto", webcrypto);
  composerThreadDrafts.clearAll();
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  composerThreadDrafts.clearAll();
});

function fixture(busy: boolean, captured = false) {
  const text = captured ? patch + "@@ -12 +12 @@\n-  same edge text  \n+same edge text\n" : patch;
  const client = codeClient({ evidence: text });
  const queue = queueTestHost();
  let finding: CodeReviewFinding | undefined;
  const anchor = {
    kind: "captured-diff",
    reviewOperationId: ids.operation,
    diff: {
      contentId: ids.content,
      digest: createHash("sha256").update(text).digest("hex"),
      byteLength: Buffer.byteLength(text),
      truncated: false,
    },
    revision: { kind: "working-tree", stateToken: "b".repeat(64) },
    side: "original",
    capturedAt: now,
  };
  const firstCapture = decodeCodeTurnReviewCapture({
    checkoutId: ids.checkout,
    version: 1,
    cursor: 10,
    baseline: "c".repeat(40),
    tree: "d".repeat(40),
    diff: anchor.diff,
    changedFiles: {
      files: [{ path: "src/app.ts", insertions: 2, deletions: 2 }],
      total: 1,
      truncated: false,
    },
    capturedAt: now,
    final: false,
  });
  let latestCapture = firstCapture;
  const capturedTexts = new Map([[String(anchor.diff.contentId), text]]);
  if (captured)
    client.operationContent = vi.fn(async (_thread, _operation, contentId) =>
      new TextEncoder().encode(capturedTexts.get(String(contentId)) ?? "unavailable"),
    );
  let prepared = decodeCodeReviewCorrectionPrepared({
    threadId: ids.thread,
    checkoutId: ids.checkout,
    text: "Please correct the selected finding.\nsrc/app.ts original line 4; captured compared regions only, not the whole file.\n4: old value\nOther findings and full files omitted.",
    references: [
      {
        threadId: ids.thread,
        checkoutId: ids.checkout,
        findingId: ids.finding,
        version: 1,
        anchorDigest: "e".repeat(64),
      },
    ],
    omissions: ["Other findings and full files omitted."],
  });
  const completed = decodeCodeConversationTurn({
    operationId: ids.operation,
    checkoutId: ids.checkout,
    providerInstanceId: provider,
    modelId: "model-a",
    sessionId: ids.git,
    prompt: anchor.diff,
    assistant: [],
    status: captured ? "incomplete" : "completed",
    ...(captured
      ? {
          reviewPreview: {
            status: "ready",
            capture: firstCapture,
            explanation: "Later edits may be uncaptured.",
          },
        }
      : {}),
    startedAt: now,
    updatedAt: now,
    changedFiles: {
      files: [{ path: "src/app.ts", insertions: 1, deletions: 1 }],
      total: 1,
      truncated: false,
    },
  });
  client.bootstrap = vi.fn(async () => bootstrap);
  client.navigation = vi.fn(async () => ({ threads: [view.thread], activity: [], runtime: [] }));
  client.thread = vi.fn(async () => view);
  client.subscribe = vi.fn(async function* () {});
  const { changedFiles: _changed, ...prior } = completed;
  client.conversation = vi.fn(async () =>
    decodeCodeConversationPage({
      version: 3,
      threadId: scope.threadId,
      turns: captured
        ? [
            {
              ...completed,
              reviewPreview: {
                status: "ready",
                capture: latestCapture,
                explanation: "Later edits may be uncaptured.",
              },
            },
          ]
        : busy
          ? [completed, { ...prior, operationId: ids.git, status: "incomplete" }]
          : [completed],
      nextCursor: 0,
      hasMore: false,
    }),
  );
  client.subscribeOperation = vi.fn(async function* (_thread, operationId) {
    if (!busy)
      yield decodeCodeOperationEventFrame({
        threadId: ids.thread,
        operationId,
        cursor: 1,
        occurredAt: now,
        event: { kind: "operation-state", state: "completed" },
      });
  });
  client.executeOperation = vi.fn(async (command) => {
    if (command.kind === "observe-turn-review")
      return decodeCodeOperationResult({
        kind: "turn-review-preview",
        operationId: command.operationId,
        turnOperationId: command.turnOperationId,
        ...scope,
        preview: {
          status: "ready",
          capture: latestCapture,
          settled: false,
          explanation: "Later edits may be uncaptured; this is not exclusive authorship.",
        },
      });
    if (command.kind === "observe-git")
      return decodeCodeOperationResult({
        kind: "git-observed",
        operationId: command.operationId,
        gitOperationId: ids.git,
        head: view.checkout.head,
        status: [{ path: "src/app.ts", index: " ", worktree: "M" }],
        changedPaths: ["src/app.ts"],
        insertions: 1,
        deletions: 1,
        diff: anchor.diff,
        remotes: [],
        worktrees: [],
        upstream: null,
        stateToken: "b".repeat(64),
      });
    if (command.kind === "prepare-review-target")
      return decodeCodeOperationResult({
        kind: "review-target-state",
        operationId: command.operationId,
        target: {
          fileId: ids.file,
          path: "src/app.ts",
          fileDigest: "d".repeat(64),
          location: { kind: "line", line: command.line },
          anchor: {
            ...anchor,
            reviewOperationId: command.reviewOperationId,
            ...(captured
              ? {
                  revision: {
                    kind: "turn-capture",
                    operationId: ids.operation,
                    captureCursor: command.captureCursor,
                    version: 1,
                    baseline: firstCapture.baseline,
                    tree: firstCapture.tree,
                  },
                }
              : {}),
          },
        },
        anchorState: "current",
        explanation: "This captured revision still matches.",
      });
    if (command.kind === "create-review-finding") {
      finding = decodeCodeReviewFinding({
        id: command.findingId,
        threadId: ids.thread,
        checkoutId: ids.checkout,
        fileId: command.fileId,
        path: command.path,
        fileDigest: command.fileDigest,
        anchor: command.anchor,
        location: command.location,
        severity: command.severity,
        summary: command.summary,
        author: { kind: "local-user", actorId: ids.approval },
        provenance: { kind: "manual" },
        state: "open",
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      prepared = decodeCodeReviewCorrectionPrepared({
        ...prepared,
        references: prepared.references.map((ref) => ({ ...ref, findingId: finding!.id })),
      });
      return decodeCodeOperationResult({
        kind: "review-finding-state",
        operationId: command.operationId,
        finding,
      });
    }
    if (command.kind === "list-review-findings")
      return decodeCodeOperationResult({
        kind: "review-findings-state",
        operationId: command.operationId,
        ...scope,
        findings:
          finding === undefined
            ? []
            : [
                {
                  finding,
                  anchorState: "current",
                  explanation: "The finding remains open until you resolve it yourself.",
                },
              ],
        truncated: false,
      });
    if (command.kind === "prepare-review-correction")
      return decodeCodeOperationResult({
        kind: "review-correction-prepared",
        operationId: command.operationId,
        prepared,
      });
    return decodeCodeOperationResult({
      kind: "provider-turn-state",
      operationId: command.operationId,
      state: "running",
    });
  });
  const readCursorStore = createCodeReadCursorStore();
  function Surface() {
    const controller = useCodeController({
      client,
      activeThreadId: scope.threadId,
      readCursorStore,
      navigationRefreshMs: 0,
    });
    const [request, setRequest] = useState<CodeReviewFileRequest>();
    return (
      <>
        <CodeThreadWorkspace
          controller={controller}
          threadId={scope.threadId}
          messageQueueClient={queue}
          onOpenReview={setRequest}
        />
        {request === undefined ? null : (
          <DockReviewTool
            client={client}
            view={view}
            threadId={scope.threadId}
            requestedCodeReviewFile={request}
          />
        )}
      </>
    );
  }
  return {
    client,
    queue,
    firstCapture,
    text,
    publishCapture: (capture: CodeTurnReviewCapture, capturedText: string) => {
      latestCapture = capture;
      capturedTexts.set(String(capture.diff.contentId), capturedText);
    },
    get prepared() {
      return prepared;
    },
    Surface,
  };
}

it.each([false, true])(
  "opens a receipt line, saves a Plan finding, appends an unsent preserved draft, then uses ordinary send/queue (busy=%s)",
  async (busy) => {
    const f = fixture(busy);
    composerThreadDrafts.write("code", ids.thread, {
      text: "A",
      caretIndex: 1,
      stagedDropped: false,
    });
    const mounted = render(<f.Surface />);
    const user = userEvent.setup();
    const composer = await screen.findByRole("textbox", { name: "Follow-up message" });
    fireEvent.change(composer, { target: { value: "AB", selectionStart: 1 } });
    await selectFinding(user);
    await user.click(screen.getByRole("button", { name: "Prepare correction draft" }));
    await waitFor(() => {
      const notices = screen.queryAllByRole("status").map((node) => node.textContent ?? "");
      expect(
        notices.some((text) => text.includes("Added to this task’s saved draft")),
        notices.join("; "),
      ).toBe(true);
    });
    expect(composer).toHaveValue(`AB\n\n${f.prepared.text}`);
    expect(composerThreadDrafts.read("code", ids.thread)?.reviewFindingReferences).toEqual(
      f.prepared.references,
    );
    expect(
      JSON.parse(localStorage.getItem(COMPOSER_THREAD_DRAFTS_STORAGE_KEY)!)[`code:${ids.thread}`]
        .reviewFindingReferences,
    ).toEqual(f.prepared.references);
    expect(
      vi
        .mocked(f.client.executeOperation)
        .mock.calls.some(([command]) => command.kind === "start-provider-turn"),
    ).toBe(false);
    expect(f.queue.execute).not.toHaveBeenCalled();
    if (busy) {
      await user.click(screen.getByRole("button", { name: "Queue message" }));
      await waitFor(() => expect(f.queue.execute).toHaveBeenCalledOnce());
      expect(f.queue.execute.mock.calls[0]?.[0]).toMatchObject({
        kind: "enqueue",
        payload: { mode: "code", reviewFindingReferences: f.prepared.references },
      });
    } else {
      mounted.unmount();
      render(<f.Surface />);
      const reopened = await screen.findByRole("textbox", { name: "Follow-up message" });
      expect(reopened).toHaveValue(`AB\n\n${f.prepared.text}`);
      fireEvent.change(reopened, { target: { value: "Person edited this correction request." } });
      await user.click(screen.getByRole("button", { name: "Send follow-up" }));
      await waitFor(() =>
        expect(
          vi
            .mocked(f.client.executeOperation)
            .mock.calls.some(([command]) => command.kind === "start-provider-turn"),
        ).toBe(true),
      );
      const sent = vi
        .mocked(f.client.executeOperation)
        .mock.calls.find(([command]) => command.kind === "start-provider-turn")?.[0];
      expect(sent).toMatchObject({ reviewFindingReferences: f.prepared.references });
      expect(f.client.putEvidence).toHaveBeenCalledWith(
        scope.threadId,
        "Person edited this correction request.",
      );
    }
  },
);

it.each(["timeout", "client changed", "bad bytes"] as const)(
  "does not publish an unavailable or retired captured body after %s",
  async (reason) => {
    const first = fixture(true, true);
    const held = Promise.withResolvers<Uint8Array>();
    const entered = Promise.withResolvers<void>();
    let readSignal: AbortSignal | undefined;
    first.client.operationContent = vi.fn(async (_thread, _operation, _content, signal) => {
      readSignal = signal;
      entered.resolve();
      return reason === "bad bytes"
        ? new TextEncoder().encode(first.text.replace("new value", "bad value"))
        : held.promise;
    });
    const originalRequest = {
      checkoutId: scope.checkoutId,
      path: "src/app.ts",
      receiptOperationId: decodeCodeOperationId(ids.operation),
      turnCapture: first.firstCapture,
    };
    const mounted = render(
      <DockReviewTool
        client={first.client}
        view={view}
        threadId={scope.threadId}
        requestedCodeReviewFile={originalRequest}
      />,
    );
    try {
      await entered.promise;
      if (reason === "timeout") {
        // Reopen under the controlled clock so the real read boundary owns this deadline.
        mounted.unmount();
        vi.useFakeTimers();
        const controlled = render(
          <DockReviewTool
            client={first.client}
            view={view}
            threadId={scope.threadId}
            requestedCodeReviewFile={originalRequest}
          />,
        );
        try {
          await act(async () => vi.advanceTimersByTimeAsync(20_000));
          expect(screen.getByText(/captured version could not be read/)).toBeVisible();
          expect(screen.getByRole("button", { name: "Retry captured view" })).toBeEnabled();
          await act(async () => held.resolve(new TextEncoder().encode(first.text)));
          expect(screen.queryByRole("heading", { name: "Turn capture 1" })).not.toBeInTheDocument();
        } finally {
          controlled.unmount();
          vi.useRealTimers();
        }
      } else if (reason === "client changed") {
        const second = fixture(true, true);
        const text = second.text.replace("new value", "new owner");
        const capture = decodeCodeTurnReviewCapture({
          ...second.firstCapture,
          version: 2,
          cursor: 20,
          diff: {
            contentId: ids.git,
            byteLength: Buffer.byteLength(text),
            digest: createHash("sha256").update(text).digest("hex"),
          },
        });
        second.publishCapture(capture, text);
        mounted.rerender(
          <DockReviewTool
            client={second.client}
            view={view}
            threadId={scope.threadId}
            requestedCodeReviewFile={{ ...originalRequest, turnCapture: capture }}
          />,
        );
        await screen.findByRole("heading", { name: "Turn capture 2" });
        expect(readSignal?.aborted).toBe(true);
        await act(async () => held.resolve(new TextEncoder().encode(first.text)));
        expect(screen.queryByRole("heading", { name: "Turn capture 1" })).not.toBeInTheDocument();
        expect(screen.getByText("new owner")).toBeVisible();
      } else {
        await screen.findByText(/captured version could not be read/);
        expect(screen.queryByRole("heading", { name: "Turn capture 1" })).not.toBeInTheDocument();
        expect(
          vi
            .mocked(first.client.executeOperation)
            .mock.calls.some(([command]) => command.kind === "observe-git"),
        ).toBe(false);
      }
      expect(first.queue.execute).not.toHaveBeenCalled();
    } finally {
      held.resolve(new TextEncoder().encode(first.text));
      mounted.unmount();
    }
  },
);

it("keeps a live captured version and its selected anchor through metadata reconnect and edge-whitespace filtering before explicitly viewing a newer version", async () => {
  const f = fixture(true, true);
  composerThreadDrafts.write("code", ids.thread, {
    text: "A",
    caretIndex: 1,
    stagedDropped: false,
  });
  const mounted = render(<f.Surface />);
  const user = userEvent.setup();
  try {
    const composer = await screen.findByRole("textbox", { name: "Follow-up message" });
    fireEvent.change(composer, { target: { value: "AB", selectionStart: 1 } });
    await selectFinding(user);
    await screen.findByRole("heading", { name: /^Turn capture 1$/ });
    expect(
      vi
        .mocked(f.client.executeOperation)
        .mock.calls.some(([command]) => command.kind === "observe-git"),
    ).toBe(false);
    const selected = vi
      .mocked(f.client.executeOperation)
      .mock.calls.filter(([command]) => command.kind === "prepare-review-target");
    expect(selected.at(-1)?.[0]).toMatchObject({
      reviewOperationId: ids.operation,
      captureCursor: 10,
      side: "original",
      line: 4,
    });
    const stack = mounted.container.querySelector<HTMLElement>(".unified-diff");
    if (stack === null) throw new Error("captured diff missing");
    stack.scrollTop = 47;
    expect(stack.querySelectorAll('tr[data-kind="removed"]')).toHaveLength(2);
    await user.click(screen.getByRole("checkbox", { name: "Ignore edge whitespace" }));
    expect(stack.querySelectorAll('tr[data-kind="removed"]')).toHaveLength(1);
    expect(
      vi
        .mocked(f.client.executeOperation)
        .mock.calls.filter(([command]) => command.kind === "prepare-review-target"),
    ).toHaveLength(selected.length);
    const contentReads = vi.mocked(f.client.operationContent).mock.calls.length;
    const nextText = f.text.replace("new value", "later edit");
    const next = decodeCodeTurnReviewCapture({
      ...f.firstCapture,
      cursor: 20,
      version: 2,
      tree: "e".repeat(40),
      diff: {
        contentId: ids.git,
        digest: createHash("sha256").update(nextText).digest("hex"),
        byteLength: Buffer.byteLength(nextText),
        truncated: false,
      },
    });
    f.publishCapture(next, nextText);
    await user.click(screen.getByRole("button", { name: "Reconnect updates" }));
    await screen.findByRole("button", { name: "View newer capture" });
    expect(screen.getByRole("heading", { name: /^Turn capture 1$/ })).toBeVisible();
    expect(stack.scrollTop).toBe(47);
    expect(vi.mocked(f.client.operationContent).mock.calls).toHaveLength(contentReads);
    expect(
      vi
        .mocked(f.client.executeOperation)
        .mock.calls.filter(([command]) => command.kind === "prepare-review-target"),
    ).toHaveLength(selected.length);
    expect(
      vi
        .mocked(f.client.executeOperation)
        .mock.calls.find(([command]) => command.kind === "create-review-finding")?.[0],
    ).toMatchObject({
      anchor: { revision: { kind: "turn-capture", captureCursor: 10, version: 1 } },
    });
    await user.click(screen.getByRole("button", { name: "View newer capture" }));
    await screen.findByRole("heading", { name: /^Turn capture 2$/ });
    expect(vi.mocked(f.client.operationContent).mock.calls).toHaveLength(contentReads + 1);
    expect(screen.getByRole("checkbox", { name: "Ignore edge whitespace" })).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "Select finding: Keep the original behavior." }),
    ).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Prepare correction draft" }));
    await waitFor(() =>
      expect(composerThreadDrafts.read("code", ids.thread)?.reviewFindingReferences).toEqual(
        f.prepared.references,
      ),
    );
    expect(composerThreadDrafts.read("code", ids.thread)?.text).toBe(`AB\n\n${f.prepared.text}`);
    expect(f.queue.execute).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(f.client.executeOperation)
        .mock.calls.some(([command]) => command.kind === "start-provider-turn"),
    ).toBe(false);
    await user.click(screen.getByRole("button", { name: "Queue message" }));
    expect(f.queue.execute.mock.calls[0]?.[0]).toMatchObject({
      kind: "enqueue",
      payload: { reviewFindingReferences: f.prepared.references },
    });
  } finally {
    mounted.unmount();
  }
});

async function selectFinding(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Review src/app.ts" }));
  await user.click(
    await screen.findByRole("button", { name: "Comment on src/app.ts original line 4" }),
  );
  await user.type(
    await screen.findByRole("textbox", { name: "Finding summary" }),
    "Keep the original behavior.",
  );
  await user.click(screen.getByRole("button", { name: "Add local finding" }));
  await user.click(
    await screen.findByRole("checkbox", { name: "Select finding: Keep the original behavior." }),
  );
}

it.each(["timeout", "unmount"] as const)(
  "does not append a late correction prepare after %s",
  async (reason) => {
    const f = fixture(false);
    const original = f.client.executeOperation;
    const held = Promise.withResolvers<Awaited<ReturnType<typeof original>>>();
    let request: Parameters<typeof original>[0] | undefined;
    f.client.executeOperation = vi.fn((command, signal) => {
      if (command.kind === "prepare-review-correction") {
        request = command;
        return held.promise;
      }
      return original(command, signal);
    });
    composerThreadDrafts.write("code", ids.thread, {
      text: "AB",
      caretIndex: 1,
      stagedDropped: false,
    });
    const mounted = render(<f.Surface />);
    const user = userEvent.setup();
    await screen.findByRole("textbox", { name: "Follow-up message" });
    await selectFinding(user);
    if (reason === "timeout") vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole("button", { name: "Prepare correction draft" }));
      expect(request?.kind).toBe("prepare-review-correction");
      if (reason === "timeout") {
        await act(async () => vi.advanceTimersByTimeAsync(20_000));
        expect(screen.getByText(/correction draft could not be prepared/)).toBeVisible();
        expect(screen.getByRole("button", { name: "Prepare correction draft" })).toBeEnabled();
      } else mounted.unmount();
      await act(async () =>
        held.resolve(
          decodeCodeOperationResult({
            kind: "review-correction-prepared",
            operationId: request!.operationId,
            prepared: f.prepared,
          }),
        ),
      );
      expect(composerThreadDrafts.read("code", ids.thread)?.text).toBe("AB");
      expect(
        composerThreadDrafts.read("code", ids.thread)?.reviewFindingReferences,
      ).toBeUndefined();
      expect(f.queue.execute).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  },
);
