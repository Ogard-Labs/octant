import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  decodeCodeBootstrap,
  decodeCodeThreadView,
  decodeCodeOperationResult,
  decodeCodeOperationEventFrame,
  decodeCodeReviewFinding,
  decodeCodeReviewCorrectionPrepared,
  decodeCodeConversationTurn,
  decodeCodeConversationPage,
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
  composerThreadDrafts.clearAll();
  localStorage.clear();
});
afterEach(() => {
  composerThreadDrafts.clearAll();
});

function fixture(busy: boolean) {
  const client = codeClient({ evidence: patch });
  const queue = queueTestHost();
  let finding: CodeReviewFinding | undefined;
  const anchor = {
    kind: "captured-diff",
    reviewOperationId: ids.operation,
    diff: {
      contentId: ids.content,
      digest: "a".repeat(64),
      byteLength: patch.length,
      truncated: false,
    },
    revision: { kind: "working-tree", stateToken: "b".repeat(64) },
    side: "original",
    capturedAt: now,
  };
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
    status: "completed",
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
      turns: busy
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
          location: { kind: "line", line: 4 },
          anchor: { ...anchor, reviewOperationId: command.reviewOperationId },
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
