import * as tui from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { mountAgentScreen } from "../packages/cli/src/agentTui";
import { paletteFor } from "../packages/cli/src/agentTuiModel";
const now = "2026-11-16T12:00:00.000Z";
const threadId = "60000000-0000-4000-8000-000000000001";
const waitingThreadId = "60000000-0000-4000-8000-000000000002";
const providerId = "50000000-0000-4000-8000-000000000001";
const thread = {
  id: threadId,
  title: "Terminal smoke",
  lifecycle: "active",
  providerInstanceId: providerId,
  modelId: "test-model",
  modelOptionValues: { reasoning: "high" },
  researchEnabled: false,
  researchRouting: "automatic",
  personalityInstructions: "Be brief.",
  version: 1,
  createdAt: now,
  updatedAt: now,
};
let approvalPending = false;
let decisions = 0;
let refuseChatThreadOpen: string | undefined;
const approval = {
  id: "70000000-0000-4000-8000-000000000001",
  toolName: "bash",
  summary: "Review this command",
  approvalClass: "command",
  status: "pending",
  askedAt: now,
};
const session = {
  kind: "opened" as const,
  windowId: "test",
  close: async () => {},
  send: async ({ path, body }: { path: string; body?: unknown }) => {
    if (path === "/api/projects/bootstrap")
      return { status: 200, body: { active: [], archived: [], availability: [], memory: [] } };
    if (path === "/api/shell/bootstrap") return { status: 200, body: { workspaceVersion: 1 } };
    if (path === "/api/shell/commands") return { status: 200, body: {} };
    if (path.endsWith("/approvals")) {
      if ((body as { decision?: string })?.decision !== "approve")
        throw new Error("Unexpected approval decision");
      decisions++;
      approvalPending = false;
      return {
        status: 200,
        body: {
          kind: "approval-decided",
          approval: { ...approval, status: "approved", settledAt: now },
        },
      };
    }
    if (path.startsWith("/api/native-harness/sessions/"))
      return {
        status: 200,
        body: {
          view: approvalPending
            ? {
                session: {
                  id: "71000000-0000-4000-8000-000000000001",
                  threadId,
                  mode: "chat",
                  leadSlotId: "lead",
                  lead: { hostId: "local", providerInstanceId: providerId, modelId: "test-model" },
                  status: "waiting-approval",
                  detail: "Review this command",
                  turnsRun: 0,
                  cutovers: 0,
                  startedAt: now,
                  updatedAt: now,
                  version: 1,
                },
                routes: [],
                turns: [],
                reductions: [],
                interventions: [],
                activatedFollowUpIds: [],
                questions: [],
                approvals: [approval],
              }
            : null,
        },
      };
    if (path.startsWith("/api/chat/threads/")) {
      const openedId = path.slice("/api/chat/threads/".length);
      if (openedId === refuseChatThreadOpen)
        return { status: 403, body: { message: "Thread open refused." } };
      return {
        status: 200,
        body: {
          thread: {
            ...thread,
            id: openedId,
            title: openedId === waitingThreadId ? "Waiting task" : thread.title,
          },
          turns: [],
          lastSequence: 1,
          contents: [],
          attachments: [],
          citations: [],
          workItems: [],
          workListVersion: 0,
          followUpVersion: 0,
        },
      };
    }
    if (path === "/api/chat/navigation")
      return {
        status: 200,
        body: {
          threads: [
            {
              id: threadId,
              title: thread.title,
              providerInstanceId: providerId,
              updatedAt: now,
              lastSequence: 1,
              followUpOpen: false,
              awaitingInput: true,
            },
            {
              id: waitingThreadId,
              title: "Waiting task",
              providerInstanceId: providerId,
              updatedAt: "2026-11-16T12:01:00.000Z",
              lastSequence: 1,
              followUpOpen: false,
              awaitingInput: true,
            },
          ],
        },
      };
    return { status: 404, body: { message: "Unavailable" } };
  },
};
for (const width of [70, 80, 100, 160]) {
  const test = await createTestRenderer({ width, height: 24 });
  try {
    const screen = mountAgentScreen(tui, test.renderer, paletteFor(undefined, "dark"), {
      session,
      threadId,
    });
    await screen.refresh();
    await test.renderOnce();
    const frame = test.captureCharFrame();
    if (!frame.includes("Octant")) throw new Error("Missing terminal header");
    if (width >= 100 && !frame.includes("Threads")) throw new Error("Missing sidebar");
    if (width >= 140 && !frame.includes("Context and usage")) throw new Error("Missing info panel");
    const running = screen.run();
    if (width === 160) {
      if (!frame.includes("high")) throw new Error("Configured reasoning effort missing");
      test.mockInput.pressKey("b", { ctrl: true });
      test.mockInput.pressKey("g", { ctrl: true });
      await test.renderOnce();
      const hidden = test.captureCharFrame();
      if (hidden.includes("Threads") || hidden.includes("Context and usage"))
        throw new Error("Wide panels did not hide");
      test.mockInput.pressKey("b", { ctrl: true });
      test.mockInput.pressKey("g", { ctrl: true });
    }
    if (width === 70) {
      test.mockInput.pressKey("b", { ctrl: true });
      await test.waitForFrame((frame) => frame.includes("Threads"));
      test.mockInput.pressKey("b", { ctrl: true });
      test.mockInput.pressKey("g", { ctrl: true });
      await test.waitForFrame((frame) => frame.includes("Context and usage"));
      test.mockInput.pressKey("g", { ctrl: true });
    }
    test.mockInput.pressKey("p", { ctrl: true });
    await test.waitForFrame((frame) => frame.includes("Command palette"));
    await test.mockInput.typeText("diff");
    test.mockInput.pressEnter();
    await test.waitForFrame((frame) =>
      frame.includes("Checkout review is available on Code threads."),
    );
    if (width === 100) {
      approvalPending = true;
      await screen.refresh();
      await test.waitForFrame((frame) => frame.includes("Review this command"));
      await test.mockInput.typeText("y");
      test.mockInput.pressEnter();
      await test.waitFor(() => decisions === 1);
      await screen.refresh();
      await test.renderOnce();
      if (test.captureCharFrame().includes("Review this command"))
        throw new Error("Settled approval stayed visible");
      approvalPending = true;
      await screen.refresh();
      await test.mockInput.typeText("y");
      approvalPending = false;
      await screen.refresh();
      test.mockInput.pressEnter();
      await test.waitForFrame((frame) =>
        frame.includes("request changed or was answered elsewhere"),
      );
      if (decisions !== 1) throw new Error("A stale approval answer was submitted");
    }
    if (width === 160) {
      await test.mockInput.typeText("unsent text stays here");
      test.mockInput.pressKey("j", { ctrl: true });
      await test.waitForFrame((next) => next.split("\n", 1)[0]?.includes("Waiting task") === true);
      if (!test.captureCharFrame().includes("unsent text stays here"))
        throw new Error("Ctrl+J replaced the unsent composer text");
      refuseChatThreadOpen = threadId;
      test.mockInput.pressKey("j", { ctrl: true });
      await test.waitForFrame((next) => next.includes("Thread open refused."));
      if (!test.captureCharFrame().includes("unsent text stays here"))
        throw new Error("A refused Ctrl+J navigation replaced the unsent composer text");
    }
    test.mockInput.pressCtrlC();
    await running;
    console.log(`Rendered ${width}x24`);
  } finally {
    test.renderer.destroy();
  }
}

const codeThreadId = "66000000-0000-4000-8000-000000000001";
const waitingCodeThreadId = "66000000-0000-4000-8000-000000000002";
const codeProjectId = "67000000-0000-4000-8000-000000000001";
const codeBindingId = "68000000-0000-4000-8000-000000000001";
const checkoutId = "69000000-0000-4000-8000-000000000001";
const repositoryId = `repo_${"a".repeat(64)}`;
const codeCheckout = {
  id: checkoutId,
  repositoryId,
  kind: "existing-worktree",
  availability: "available",
  head: { kind: "branch", name: "main", oid: "b".repeat(40) },
  observedAt: now,
};
const codeThread = (id: string, title: string) => ({
  id,
  projectId: codeProjectId,
  bindingRevisionId: codeBindingId,
  repositoryId,
  checkoutId,
  title,
  lifecycle: "active",
  providerInstanceId: providerId,
  modelId: "test-model",
  executionPolicy: "approval-gated",
  permissionPersistence: "current-session",
  deliveryTarget: {
    branchIntent: "feature/smoke",
    remoteName: "origin",
    proposedBaseRepository: "octant/octant",
    proposedBaseBranch: "main",
    outcomeKind: "local-implementation",
    confirmedAt: now,
  },
  version: 1,
  createdAt: now,
  updatedAt: now,
});
const codeThreads = [
  codeThread(codeThreadId, "Code task A"),
  codeThread(waitingCodeThreadId, "Code task B"),
];
const codeProject = {
  id: codeProjectId,
  name: "Terminal smoke",
  type: "code",
  lifecycle: "active",
  pinned: false,
  rank: "1/2",
  version: 1,
  createdAt: now,
  updatedAt: now,
  binding: { canonicalRoot: "/home/test/repo" },
  bindingRevisionId: codeBindingId,
  codeAccessPersistence: "current-session",
};
let pendingCodeRequests = true;
let requestListUnavailable = false;
let checkoutReadRefused = false;
let codeAnswers = 0;
let otherCodeCommands = 0;
const codeRequest = (id: string, title: string) => ({
  mode: "code",
  projectId: codeProjectId,
  threadId: id,
  threadTitle: title,
  requestedAt: now,
  kind: "approval",
  text: `Approve ${title}?`,
  answer: {
    threadId: id,
    checkoutId,
    approvalId:
      id === codeThreadId
        ? "6a000000-0000-4000-8000-000000000001"
        : "6a000000-0000-4000-8000-000000000002",
  },
});
const codeSession = {
  kind: "opened" as const,
  windowId: "test",
  workspace: "none" as const,
  close: async () => {},
  send: async (request: { path: string; method?: string; body?: unknown }) => {
    if (request.path === "/api/projects/bootstrap")
      return {
        status: 200,
        body: { active: [codeProject], archived: [], availability: [], memory: [] },
      };
    if (request.path === "/api/code/bootstrap")
      return {
        status: 200,
        body: {
          settings: {
            defaultExecutionPolicy: "approval-gated",
            defaultPermissionPersistence: "current-session",
            version: 1,
            updatedAt: now,
          },
          threads: codeThreads,
          checkouts: [codeCheckout],
        },
      };
    if (request.path === "/api/code/navigation")
      return {
        status: 200,
        body: {
          threads: codeThreads,
          runtime: pendingCodeRequests
            ? codeThreads.map((entry) => ({
                threadId: entry.id,
                executing: false,
                awaitingInput: true,
              }))
            : [],
        },
      };
    if (request.path === "/api/code/board") return { status: 404, body: {} };
    if (request.path === "/api/pending-requests")
      return requestListUnavailable
        ? { status: 503, body: {} }
        : {
            status: 200,
            body: {
              requests: pendingCodeRequests
                ? codeThreads.map((entry) => codeRequest(entry.id, entry.title))
                : [],
            },
          };
    if (request.path.startsWith("/api/native-harness/sessions/"))
      return { status: 200, body: { view: null } };
    if (request.path.startsWith("/api/code/threads/") && !request.path.includes("/conversation"))
      return {
        status: 200,
        body: {
          thread: codeThreads.find((entry) => request.path.endsWith(entry.id)),
          checkout: codeCheckout,
          lastSequence: 1,
        },
      };
    if (request.path.includes("/conversation/window"))
      return {
        status: 200,
        body: {
          version: 1,
          threadId: request.path.includes(waitingCodeThreadId) ? waitingCodeThreadId : codeThreadId,
          turns: [],
          hasEarlier: false,
          hasLater: false,
        },
      };
    if (request.path === "/api/code/commands") {
      const body = request.body as { kind?: string; operationId?: string; gitOperationId?: string };
      if (body.kind === "answer-provider-approval") {
        codeAnswers++;
        pendingCodeRequests = false;
        return { status: 200, body: { kind: "provider-turn-state", state: "running" } };
      }
      if (body.kind !== "observe-git") otherCodeCommands++;
      if (checkoutReadRefused)
        return { status: 403, body: { message: "Checkout snapshot refused." } };
      return {
        status: 200,
        body: {
          kind: "git-observed",
          operationId: body.operationId,
          gitOperationId: body.gitOperationId,
          head: { kind: "branch", name: "main", oid: "b".repeat(40) },
          stateToken: "a".repeat(64),
          status: [],
          changedPaths: ["src/a.ts"],
          diff: {
            contentId: "6b000000-0000-4000-8000-000000000001",
            digest: "c".repeat(64),
            byteLength: 36,
            truncated: false,
          },
          remotes: [],
          upstream: null,
          worktrees: [],
        },
      };
    }
    if (request.path === "/api/code/evidence/batch") {
      const body = request.body as {
        threadId: string;
        items: ReadonlyArray<{ operationId: string; contentId: string }>;
      };
      return {
        status: 200,
        body: {
          threadId: body.threadId,
          items: body.items.map((item) => ({
            ...item,
            text: "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
          })),
        },
      };
    }
    return { status: 404, body: {} };
  },
};
const codeRender = await createTestRenderer({ width: 120, height: 30 });
try {
  const screen = mountAgentScreen(tui, codeRender.renderer, paletteFor(undefined, "dark"), {
    session: codeSession,
    threadId: codeThreadId,
    mode: "code",
    quiet: true,
  });
  await screen.refresh();
  await codeRender.renderOnce();
  const running = screen.run();
  await codeRender.waitForFrame((frame) => frame.includes("Approve Code task A?"));
  await codeRender.mockInput.typeText("y");
  codeRender.mockInput.pressKey("j", { ctrl: true });
  await codeRender.waitForFrame(
    (frame) => frame.split("\n", 1)[0]?.includes("Code task B") === true,
  );
  codeRender.mockInput.pressEnter();
  await codeRender.renderOnce();
  if (codeAnswers !== 0) throw new Error("Switching threads submitted a provider approval.");

  pendingCodeRequests = false;
  await screen.refresh();
  await codeRender.mockInput.typeText("/files");
  codeRender.mockInput.pressEnter();
  await codeRender.waitForFrame((frame) => frame.includes("src/a.ts"));
  codeRender.mockInput.typeText("/files");
  codeRender.mockInput.pressEnter();
  checkoutReadRefused = true;
  await codeRender.mockInput.typeText("/files");
  codeRender.mockInput.pressEnter();
  await codeRender.waitForFrame((frame) => frame.includes("Checkout snapshot refused."));

  checkoutReadRefused = false;
  pendingCodeRequests = true;
  requestListUnavailable = false;
  await screen.refresh();
  await codeRender.mockInput.typeText("y");
  requestListUnavailable = true;
  await screen.refresh();
  codeRender.mockInput.pressEnter();
  await codeRender.waitForFrame((frame) => frame.includes("Provider requests are unavailable"));
  if (codeAnswers !== 0 || otherCodeCommands !== 0)
    throw new Error("A stale approval was submitted after request refresh failed.");
  requestListUnavailable = false;
  pendingCodeRequests = false;
  await screen.refresh();
  codeRender.mockInput.pressEnter();
  await codeRender.waitForFrame((frame) =>
    frame.includes("request changed or was answered elsewhere"),
  );
  if (codeAnswers !== 0 || otherCodeCommands !== 0)
    throw new Error("A failed request read converted its draft into a prompt.");
  codeRender.mockInput.pressCtrlC();
  await running;
} finally {
  codeRender.renderer.destroy();
}

// Measure a growing 2,000-line reply across ordinary, block, newline, and table boundaries.
let reply = Array.from(
  { length: 2000 },
  (_, index) => `Line ${index}: **terminal** streaming acceptance`,
).join("\n");
const turnId = "61000000-0000-4000-8000-000000000001";
const promptRef = {
  contentId: "63000000-0000-4000-8000-000000000001",
  digest: "a".repeat(64),
  byteLength: 4,
};
const replyRef = {
  contentId: "63000000-0000-4000-8000-000000000002",
  digest: "b".repeat(64),
  byteLength: reply.length,
};
const streamSession = {
  ...session,
  send: async (request: { path: string }) => {
    if (!request.path.startsWith("/api/chat/threads/")) return session.send(request);
    return {
      status: 200,
      body: {
        thread,
        turns: [
          {
            id: turnId,
            threadId,
            sequence: 1,
            userMessageRef: promptRef,
            attachmentIds: [],
            createdAt: now,
            attempts: [
              {
                id: "62000000-0000-4000-8000-000000000001",
                turnId,
                threadId,
                providerInstanceId: providerId,
                providerSessionId: "64000000-0000-4000-8000-000000000001",
                modelId: "test-model",
                contextManifestId: "65000000-0000-4000-8000-000000000001",
                outcome: "streaming",
                responseRefs: [replyRef],
                citationIds: [],
                createdAt: now,
                updatedAt: now,
              },
            ],
          },
        ],
        lastSequence: 2,
        contents: [
          { ...promptRef, role: "user", body: "plan" },
          { ...replyRef, role: "assistant", body: reply },
        ],
        attachments: [],
        citations: [],
        workItems: [],
        workListVersion: 0,
        followUpVersion: 0,
      },
    };
  },
};
const initialReply = reply;
reply = [
  ...Array.from({ length: 31 }, (_, index) => `Before table ${index + 1}`),
  "| State | Change |",
  "| --- | --- |",
  "| ready | updated |",
  "",
  "```ts",
  'const pipe = "|";',
  "```",
].join("\n");
replyRef.byteLength = reply.length;
const tableRender = await createTestRenderer({ width: 120, height: 45 });
try {
  const screen = mountAgentScreen(tui, tableRender.renderer, paletteFor(undefined, "dark"), {
    session: streamSession,
    threadId,
    quiet: true,
  });
  await screen.refresh();
  await tableRender.renderOnce();
  const frame = tableRender.captureCharFrame();
  if (!frame.includes("┌") || !frame.includes("│ ready"))
    throw new Error("A streaming table crossing the 32-line boundary was not formatted.");
  if (!frame.includes('const pipe = "|";') || frame.includes("| --- |"))
    throw new Error("Fenced streaming source was not kept literal.");
  console.log("Rendered streaming table boundary and fenced source");
} finally {
  tableRender.renderer.destroy();
}
reply = initialReply;
replyRef.byteLength = reply.length;
const perf = await createTestRenderer({ width: 160, height: 45 });
try {
  const screen = mountAgentScreen(tui, perf.renderer, paletteFor(undefined, "dark"), {
    session: streamSession,
    threadId,
    quiet: true,
  });
  const samples: number[] = [];
  const deltas = [
    " delta",
    "\n\n## Streaming section\n\nA new paragraph follows.\n",
    "\n- Streaming item\n- Another item\n",
    "\n| State | Change |\n| --- | --- |\n| ready | updated |\n",
  ];
  for (let i = 0; i < 25; i++) {
    reply += deltas[i % deltas.length] ?? " delta";
    const start = performance.now();
    await screen.refresh();
    await perf.renderOnce();
    if (i >= 5) samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const p95 = samples[Math.ceil(samples.length * 0.95) - 1] ?? Infinity;
  console.log(`2,000-line streaming refresh/render p95: ${p95.toFixed(2)}ms`);
  if (process.argv.includes("--benchmark") && p95 > 16)
    throw new Error("Streaming frame budget exceeded.");
} finally {
  perf.renderer.destroy();
}
