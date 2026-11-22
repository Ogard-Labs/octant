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
let codeQuestionMode = false;
let codeAnswers = 0;
let codeAnswerCalls = 0;
let otherCodeCommands = 0;
const answeredCodeThreads: string[] = [];
const stagedCodeTexts: string[] = [];
const startedCodeThreads: Array<string | undefined> = [];
const codeRequest = (id: string, title: string) =>
  codeQuestionMode
    ? {
        mode: "code",
        projectId: codeProjectId,
        threadId: id,
        threadTitle: title,
        requestedAt: now,
        kind: "question",
        text: `Answer ${title}?`,
        options: [{ label: "Proceed" }],
        answer: {
          threadId: id,
          checkoutId,
          requestId:
            id === codeThreadId
              ? "6a000000-0000-4000-8000-000000000003"
              : "6a000000-0000-4000-8000-000000000004",
        },
      }
    : {
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
      };
const codeSession = {
  kind: "opened" as const,
  windowId: "test",
  workspace: "none" as const,
  close: async () => {},
  send: async (request: { path: string; method?: string; body?: unknown; bytes?: Uint8Array }) => {
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
    if (request.path === "/api/code/evidence") {
      codeAnswerCalls++;
      if (request.bytes !== undefined)
        stagedCodeTexts.push(new TextDecoder().decode(request.bytes));
      return {
        status: 200,
        body: {
          contentId: "6a000000-0000-4000-8000-000000000005",
          digest: "d".repeat(64),
          byteLength: 9,
        },
      };
    }
    if (request.path === "/api/code/commands") {
      const body = request.body as {
        kind?: string;
        operationId?: string;
        gitOperationId?: string;
        threadId?: string;
      };
      if (body.kind === "answer-provider-approval" || body.kind === "answer-provider-input") {
        codeAnswerCalls++;
        codeAnswers++;
        if (body.threadId !== undefined) answeredCodeThreads.push(body.threadId);
        pendingCodeRequests = false;
        return { status: 200, body: { kind: "provider-turn-state", state: "running" } };
      }
      if (body.kind !== "observe-git") otherCodeCommands++;
      if (body.kind === "start-provider-turn") {
        startedCodeThreads.push(body.threadId);
        return { status: 200, body: { kind: "provider-turn-state", state: "running" } };
      }
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
  const clearComposer = async () => {
    codeRender.mockInput.pressKey("u", { ctrl: true });
    codeRender.mockInput.pressKey("k", { ctrl: true });
    await codeRender.renderOnce();
  };
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

  await clearComposer();
  pendingCodeRequests = true;
  codeQuestionMode = true;
  requestListUnavailable = false;
  await screen.refresh();
  await codeRender.waitForFrame((frame) => frame.includes("Answer Code task B?"));
  await codeRender.mockInput.typeText("/tmp/file");
  requestListUnavailable = true;
  await screen.refresh();
  codeRender.mockInput.pressEnter();
  await codeRender.waitForFrame(
    (frame) => frame.includes("Provider requests are unavailable") && frame.includes("/tmp/file"),
  );
  if (codeAnswerCalls !== 0 || otherCodeCommands !== 0)
    throw new Error("A slash-prefixed draft reached a provider answer or prompt.");

  await clearComposer();
  await codeRender.mockInput.typeText("/next-waiting");
  codeRender.mockInput.pressEnter();
  await codeRender.waitForFrame(
    (frame) => frame.split("\n", 1)[0]?.includes("Code task A") === true,
  );
  if (codeAnswerCalls !== 0 || otherCodeCommands !== 0)
    throw new Error("A local command submitted a provider answer or prompt.");

  codeQuestionMode = false;
  pendingCodeRequests = false;
  requestListUnavailable = false;
  await screen.refresh();
  await clearComposer();
  await codeRender.mockInput.typeText("ordinary draft before request");
  await codeRender.waitForFrame((frame) => frame.includes("│ ordinary draft before request"));
  pendingCodeRequests = true;
  await screen.refresh();
  await codeRender.waitForFrame((frame) => frame.includes("Approve Code task A?"));
  codeRender.mockInput.pressKey("j", { ctrl: true });
  await codeRender.waitForFrame(
    (frame) =>
      frame.split("\n", 1)[0]?.includes("Code task B") === true &&
      frame.includes("│ ordinary draft before request"),
  );
  codeRender.mockInput.pressEnter();
  await codeRender.waitForFrame(
    (frame) =>
      frame.includes("Review or clear this draft before answering") &&
      frame.includes("│ ordinary draft before request"),
  );
  if (codeAnswerCalls !== 0 || codeAnswers !== 0 || otherCodeCommands !== 0)
    throw new Error(
      "A draft typed before the request approved or prompted the destination thread.",
    );

  await clearComposer();
  await codeRender.mockInput.typeText("y");
  codeRender.mockInput.pressEnter();
  await codeRender.waitForFrame(() => codeAnswers === 1);
  if (answeredCodeThreads.at(-1) !== waitingCodeThreadId)
    throw new Error("A replacement answer did not target the destination request.");
  codeRender.mockInput.pressCtrlC();
  await running;
} finally {
  codeRender.renderer.destroy();
}
console.log("Rendered draft provenance and slash-prefixed request-read refusal");

refuseChatThreadOpen = undefined;
const followUpSuggestionId = "72000000-0000-4000-8000-000000000001";
const followUpSuggestion = {
  id: followUpSuggestionId,
  title: "Add tests",
  prompt: "Write tests.",
  target: "new-thread",
};
const followUpThreadSession = {
  session: {
    id: "71000000-0000-4000-8000-000000000001",
    threadId,
    mode: "chat",
    leadSlotId: "lead",
    lead: { hostId: "local", providerInstanceId: providerId, modelId: "test-model" },
    status: "idle",
    turnsRun: 1,
    cutovers: 0,
    startedAt: now,
    updatedAt: now,
    version: 1,
  },
  routes: [],
  turns: [],
  reductions: [],
  interventions: [],
  followUps: {
    turnId: "73000000-0000-4000-8000-000000000001",
    suggestions: [followUpSuggestion],
  },
  activatedFollowUpIds: [],
  questions: [],
  approvals: [],
};
const followUpGoal = {
  id: "74000000-0000-4000-8000-000000000001",
  threadId,
  revisionId: "75000000-0000-4000-8000-000000000001",
  objective: "Ship the parser",
  status: "active",
  budget: {},
  usage: { tokensUsed: 0, elapsedMs: 0, turnsUsed: 0 },
  evidence: [],
  criteria: [{ id: "c1", text: "Tests pass", status: "unmet" }],
  createdAt: now,
  updatedAt: now,
  version: 1,
};
let activatedFollowUps = 0;
const sentChatPrompts: Array<{ readonly threadId?: unknown; readonly prompt?: unknown }> = [];
const followUpSession = {
  ...session,
  send: async (request: { path: string; body?: unknown }) => {
    if (request.path.endsWith("/follow-ups/preview"))
      return {
        status: 200,
        body: {
          preview: {
            suggestion: followUpSuggestion,
            wouldCreate: { kind: "new-thread", mode: "chat", title: "Add tests" },
          },
        },
      };
    if (request.path.endsWith("/follow-ups/activate")) {
      activatedFollowUps++;
      return {
        status: 200,
        body: {
          kind: "follow-up-activated",
          suggestionId: followUpSuggestionId,
          created: {
            kind: "new-thread",
            mode: "chat",
            title: "Add tests",
            threadId: "76000000-0000-4000-8000-000000000001",
          },
        },
      };
    }
    if (request.path.startsWith("/api/native-harness/sessions/"))
      return { status: 200, body: { view: followUpThreadSession } };
    if (request.path.startsWith("/api/goals?"))
      return { status: 200, body: { goal: followUpGoal, history: [] } };
    if (request.path === "/api/chat/commands") {
      const body = request.body as { readonly threadId?: unknown; readonly prompt?: unknown };
      sentChatPrompts.push({ threadId: body.threadId, prompt: body.prompt });
      return { status: 200, body: { kind: "chat-turn-accepted" } };
    }
    return session.send(request);
  },
};
const followUpRender = await createTestRenderer({ width: 120, height: 30 });
const followUpScreen = mountAgentScreen(
  tui,
  followUpRender.renderer,
  paletteFor(undefined, "dark"),
  { session: followUpSession, threadId },
);
try {
  await followUpScreen.refresh();
  await followUpRender.renderOnce();
  const running = followUpScreen.run();
  try {
    await followUpRender.waitForFrame((frame) => frame.includes("Octant"));
    for (const prompt of ["Summarize what remains", "yes"]) {
      await followUpRender.mockInput.typeText("/next 1");
      followUpRender.mockInput.pressEnter();
      await followUpRender.waitForFrame((frame) => frame.includes("Write tests."));
      await followUpRender.mockInput.typeText("/goal");
      followUpRender.mockInput.pressEnter();
      await followUpRender.waitForFrame((frame) => frame.includes("Ship the parser"));
      await followUpRender.mockInput.typeText(prompt);
      followUpRender.mockInput.pressEnter();
      const expectedPrompts = prompt === "yes" ? 2 : 1;
      await followUpRender.waitFor(
        () =>
          sentChatPrompts.length === expectedPrompts ||
          followUpRender.captureCharFrame().includes("Left as a suggestion."),
      );
      if (sentChatPrompts.length !== expectedPrompts)
        throw new Error("A follow-up preview consumed a prompt after /goal.");
    }
    if (
      sentChatPrompts[0]?.threadId !== threadId ||
      sentChatPrompts[0]?.prompt !== "Summarize what remains" ||
      sentChatPrompts[1]?.threadId !== threadId ||
      sentChatPrompts[1]?.prompt !== "yes" ||
      activatedFollowUps !== 0
    )
      throw new Error("A dismissed follow-up preview consumed an ordinary prompt.");
  } finally {
    followUpRender.mockInput.pressCtrlC();
    await running;
  }
} finally {
  followUpRender.renderer.destroy();
}
console.log("Rendered follow-up dismissal after commands");

for (const hasPendingRequest of [false, true]) {
  pendingCodeRequests = hasPendingRequest;
  requestListUnavailable = true;
  codeQuestionMode = false;
  codeAnswers = 0;
  codeAnswerCalls = 0;
  otherCodeCommands = 0;
  answeredCodeThreads.length = 0;
  stagedCodeTexts.length = 0;
  startedCodeThreads.length = 0;
  const recoveryRender = await createTestRenderer({ width: 120, height: 30 });
  const recoveryScreen = mountAgentScreen(
    tui,
    recoveryRender.renderer,
    paletteFor(undefined, "dark"),
    {
      session: codeSession,
      threadId: codeThreadId,
      mode: "code",
      quiet: true,
    },
  );
  let running: Promise<void> | undefined;
  try {
    await recoveryScreen.refresh();
    await recoveryRender.renderOnce();
    running = recoveryScreen.run();
    await recoveryRender.waitForFrame((frame) =>
      frame.includes("Provider requests are unavailable"),
    );
    await recoveryRender.mockInput.typeText("/tmp/file");
    recoveryRender.mockInput.pressEnter();
    await recoveryRender.waitForFrame(
      (frame) =>
        frame.includes("Provider requests are unavailable") &&
        frame.includes("Review or clear the draft before answering") &&
        frame.includes("/tmp/file"),
    );
    if (codeAnswerCalls !== 0 || codeAnswers !== 0 || otherCodeCommands !== 0)
      throw new Error("A first request-read refusal submitted a provider command.");

    requestListUnavailable = false;
    await recoveryScreen.refresh();
    if (hasPendingRequest) {
      await recoveryRender.waitForFrame((frame) => frame.includes("Approve Code task A?"));
      recoveryRender.mockInput.pressEnter();
      await recoveryRender.waitForFrame(
        (frame) =>
          frame.includes("A request appeared after this draft") && frame.includes("/tmp/file"),
      );
      if (codeAnswerCalls !== 0 || codeAnswers !== 0 || otherCodeCommands !== 0)
        throw new Error("A draft from a failed first read answered a newly visible request.");
      recoveryRender.mockInput.pressKey("u", { ctrl: true });
      recoveryRender.mockInput.pressKey("k", { ctrl: true });
      await recoveryRender.renderOnce();
      await recoveryRender.mockInput.typeText("y");
      recoveryRender.mockInput.pressEnter();
      await recoveryRender.waitFor(() => codeAnswers === 1);
      if (answeredCodeThreads[0] !== codeThreadId)
        throw new Error("A replacement approval answer reached the wrong thread.");
    } else {
      recoveryRender.mockInput.pressEnter();
      await recoveryRender.waitFor(() => startedCodeThreads.length > 0);
      if (
        codeAnswers !== 0 ||
        stagedCodeTexts.length !== 1 ||
        stagedCodeTexts[0] !== "/tmp/file" ||
        startedCodeThreads.length !== 1 ||
        startedCodeThreads[0] !== codeThreadId
      )
        throw new Error("Recovery did not submit the preserved text as the ordinary prompt.");
    }
  } finally {
    if (running !== undefined) {
      recoveryRender.mockInput.pressCtrlC();
      await running;
    }
    recoveryRender.renderer.destroy();
    pendingCodeRequests = false;
    requestListUnavailable = false;
    codeQuestionMode = false;
    codeAnswers = 0;
    codeAnswerCalls = 0;
    otherCodeCommands = 0;
    answeredCodeThreads.length = 0;
    stagedCodeTexts.length = 0;
    startedCodeThreads.length = 0;
  }
}
console.log("Rendered first request-read refusal recovery");

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
reply = [
  ...Array.from({ length: 30 }, (_, index) => `Before fenced table ${index + 1}`),
  "```text",
  "literal source",
  "| literal | source |",
  "| --- | --- |",
  "| preserved | true |",
  "```",
].join("\n");
replyRef.byteLength = reply.length;
const fencedTableRender = await createTestRenderer({ width: 120, height: 45 });
try {
  const screen = mountAgentScreen(tui, fencedTableRender.renderer, paletteFor(undefined, "dark"), {
    session: streamSession,
    threadId,
    quiet: true,
  });
  await screen.refresh();
  await fencedTableRender.renderOnce();
  const frame = fencedTableRender.captureCharFrame();
  if (
    !frame.includes("| literal | source |") ||
    !frame.includes("| --- | --- |") ||
    !frame.includes("| preserved | true |") ||
    frame.includes("│ literal │")
  )
    throw new Error("A fenced table at a streaming block boundary was reformatted.");
  console.log("Rendered fenced literal table in a later streaming block");
} finally {
  fencedTableRender.renderer.destroy();
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

// A Work questionnaire is answered in the terminal one question at a time and
// submitted whole through the Work request route the app's thread view uses.
const workThreadId = "6c000000-0000-4000-8000-000000000001";
const workProjectId = "6c000000-0000-4000-8000-000000000002";
const workRequestId = "6c000000-0000-4000-8000-000000000003";
let workQuestionPending = true;
let workApprovalPending = false;
let workSecretPending = false;
const workSecretId = "6c000000-0000-4000-8000-000000000006";
const workApprovalId = "6c000000-0000-4000-8000-000000000005";
// Long wrapped plan lines: the target level and the y/n line must stay in view at 80x24.
const workPlan = Array.from(
  { length: 30 },
  (_, i) =>
    `Step ${String(i + 1)}: ${"update the export pipeline and its tests ".repeat(4).trim()}`,
).join("\n");
const workAnswers: unknown[] = [];
const workQuestionnaire = {
  questions: [
    {
      id: "format",
      prompt: "Which export format?",
      selection: "single",
      options: [
        { id: "pdf", label: "PDF", recommended: true },
        { id: "md", label: "Markdown" },
      ],
      allowCustom: false,
    },
    {
      id: "extras",
      prompt: "Which extras?",
      selection: "multiple",
      options: [
        { id: "toc", label: "Contents" },
        { id: "index", label: "Index" },
      ],
    },
  ],
};
const workSession = {
  kind: "opened" as const,
  windowId: "test",
  close: async () => {},
  send: async (request: { path: string; method?: string; body?: unknown }) => {
    if (request.path === "/api/projects/bootstrap")
      return { status: 200, body: { active: [], archived: [], availability: [], memory: [] } };
    if (request.path === "/api/work/threads/bootstrap")
      return {
        status: 200,
        body: {
          threads: [
            {
              id: workThreadId,
              projectId: workProjectId,
              title: "Export report",
              lifecycle: "active",
              providerInstanceId: providerId,
              modelId: "test-model",
              version: 1,
              createdAt: now,
              updatedAt: now,
            },
          ],
        },
      };
    if (request.path === `/api/work/turns/transcript/${workThreadId}`)
      return { status: 200, body: { threadId: workThreadId, turns: [] } };
    if (request.path.startsWith("/api/native-harness/sessions/"))
      return { status: 200, body: { view: null } };
    if (request.path === "/api/pending-requests")
      return {
        status: 200,
        body: {
          requests: workSecretPending
            ? [
                {
                  mode: "work",
                  projectId: workProjectId,
                  threadId: workThreadId,
                  threadTitle: "Export report",
                  requestedAt: now,
                  kind: "question",
                  text: "Paste the export API token",
                  options: [],
                  secret: true,
                  answer: { requestId: workSecretId, expectedVersion: 1 },
                },
              ]
            : workApprovalPending
              ? [
                  {
                    mode: "work",
                    projectId: workProjectId,
                    threadId: workThreadId,
                    threadTitle: "Export report",
                    requestedAt: now,
                    kind: "approval",
                    text: "Start implementing",
                    answer: { requestId: workApprovalId, expectedVersion: 1 },
                  },
                ]
              : workQuestionPending
                ? [
                    {
                      mode: "work",
                      projectId: workProjectId,
                      threadId: workThreadId,
                      threadTitle: "Export report",
                      requestedAt: now,
                      kind: "question",
                      text: "Choose the export",
                      options: [],
                      answer: { requestId: workRequestId, expectedVersion: 2 },
                    },
                  ]
                : [],
        },
      };
    if (request.path === `/api/work/requests?projectId=${workProjectId}&threadId=${workThreadId}`)
      return {
        status: 200,
        body: {
          requests: workSecretPending
            ? [
                {
                  requestId: workSecretId,
                  projectId: workProjectId,
                  threadId: workThreadId,
                  providerInstanceId: providerId,
                  providerSessionId: "6c000000-0000-4000-8000-000000000004",
                  providerRequestId: "request-3",
                  detail: {
                    kind: "user-input",
                    prompt: "Paste the export API token",
                    options: [],
                    secret: true,
                  },
                  status: "pending",
                  requestedAt: now,
                  version: 1,
                },
              ]
            : workApprovalPending
              ? [
                  {
                    requestId: workApprovalId,
                    projectId: workProjectId,
                    threadId: workThreadId,
                    providerInstanceId: providerId,
                    providerSessionId: "6c000000-0000-4000-8000-000000000004",
                    providerRequestId: "request-2",
                    detail: {
                      kind: "approval",
                      action: "Leave Plan",
                      description: "Start implementing",
                      levelChange: { to: "auto-accept-edits", plan: workPlan },
                    },
                    status: "pending",
                    requestedAt: now,
                    version: 1,
                  },
                ]
              : workQuestionPending
                ? [
                    {
                      requestId: workRequestId,
                      projectId: workProjectId,
                      threadId: workThreadId,
                      providerInstanceId: providerId,
                      providerSessionId: "6c000000-0000-4000-8000-000000000004",
                      providerRequestId: "request-1",
                      detail: {
                        kind: "user-input",
                        prompt: "Choose the export",
                        options: [],
                        questionnaire: workQuestionnaire,
                      },
                      status: "pending",
                      requestedAt: now,
                      version: 2,
                    },
                  ]
                : [],
        },
      };
    if (request.path === "/api/work/requests/commands") {
      workAnswers.push(request.body);
      workQuestionPending = false;
      workSecretPending = false;
      return { status: 200, body: { kind: "work-request-resolved" } };
    }
    return { status: 404, body: { message: "Unavailable" } };
  },
};
const workRender = await createTestRenderer({ width: 120, height: 30 });
try {
  const screen = mountAgentScreen(tui, workRender.renderer, paletteFor(undefined, "dark"), {
    session: workSession,
    threadId: workThreadId,
    mode: "work",
    quiet: true,
  });
  await screen.refresh();
  const running = screen.run();
  await workRender.waitForFrame((frame) => frame.includes("Question 1 of 2: Which export format?"));
  if (!workRender.captureCharFrame().includes("1. PDF (recommended)"))
    throw new Error("The questionnaire's options were not shown.");
  await workRender.mockInput.typeText("Word");
  workRender.mockInput.pressEnter();
  await workRender.waitForFrame((frame) => frame.includes("Choose one option by number."));
  await workRender.mockInput.typeText("2");
  workRender.mockInput.pressEnter();
  await workRender.waitForFrame((frame) => frame.includes("Question 2 of 2: Which extras?"));
  if (workAnswers.length !== 0) throw new Error("A partial questionnaire was submitted.");
  await workRender.mockInput.typeText("1,2");
  workRender.mockInput.pressEnter();
  await workRender.waitForFrame((frame) => frame.includes("Add a comment for the agent"));
  if (workAnswers.length !== 0) throw new Error("Answers were sent before the comment step.");
  // "?" is a comment Work accepts, not the key list, while a questionnaire waits.
  await workRender.mockInput.typeText("?");
  workRender.mockInput.pressEnter();
  await workRender.waitFor(() => workAnswers.length === 1);
  await workRender.waitForFrame((frame) => !frame.includes("Which extras?"));
  if (
    JSON.stringify(workAnswers[0]) !==
    JSON.stringify({
      kind: "resolve-work-request",
      requestId: workRequestId,
      expectedVersion: 2,
      resolution: {
        kind: "user-input",
        answer: {
          version: 1,
          answers: [
            { questionId: "format", selectedOptionIds: ["md"] },
            { questionId: "extras", selectedOptionIds: ["toc", "index"] },
          ],
          comment: "?",
        },
      },
    })
  )
    throw new Error(`Unexpected questionnaire answer: ${JSON.stringify(workAnswers[0])}`);
  workRender.mockInput.pressCtrlC();
  await running;
  console.log("Answered a Work questionnaire one question at a time");
} finally {
  workRender.renderer.destroy();
}

const approvalRender = await createTestRenderer({ width: 80, height: 24 });
try {
  workApprovalPending = true;
  const screen = mountAgentScreen(tui, approvalRender.renderer, paletteFor(undefined, "dark"), {
    session: workSession,
    threadId: workThreadId,
    mode: "work",
    quiet: true,
  });
  await screen.refresh();
  await approvalRender.renderOnce();
  const frame = approvalRender.captureCharFrame();
  for (const expected of ["Allowing moves this thread to Accept edits.", "y allow · n deny"])
    if (!frame.includes(expected))
      throw new Error(`The Plan approval at 80x24 is missing "${expected}".\n${frame}`);
  const running = screen.run();
  // Page Up as a terminal sends it; the mock names no PAGE_UP key.
  for (let page = 0; page < 12; page++) approvalRender.mockInput.pressKey("\x1b[5~");
  await approvalRender.waitForFrame((next) => next.includes("Step 1:"));
  approvalRender.mockInput.pressCtrlC();
  await running;
  console.log("Rendered a Plan approval's level and y/n line under a long plan at 80x24");
} finally {
  workApprovalPending = false;
  approvalRender.renderer.destroy();
}

// A secret question is answered in the masked entry: what is typed or pasted
// never appears on screen, and goes only as the command's secretAnswer.
const secretRender = await createTestRenderer({ width: 100, height: 24 });
try {
  workAnswers.length = 0;
  const screen = mountAgentScreen(tui, secretRender.renderer, paletteFor(undefined, "dark"), {
    session: workSession,
    threadId: workThreadId,
    mode: "work",
    quiet: true,
  });
  await screen.refresh();
  const running = screen.run();
  // An unsent draft survives the masked entry, even a click on the composer and Ctrl+U.
  await secretRender.mockInput.typeText("draft keeps");
  workSecretPending = true;
  await screen.refresh();
  await secretRender.waitForFrame((frame) => frame.includes("Paste the export API token"));
  await secretRender.mockMouse.click(20, 20);
  secretRender.mockInput.pressKey("u", { ctrl: true });
  await secretRender.mockInput.typeText("zq7x-");
  // A pasted secret keeps its line breaks; Backspace removes a whole emoji.
  secretRender.mockInput.pasteBracketedText("live\r\n1234🔑");
  secretRender.mockInput.pressBackspace();
  await secretRender.waitForFrame((frame) => frame.includes("14 characters typed."));
  if (!secretRender.captureCharFrame().includes("draft keeps"))
    throw new Error("The masked entry changed the composer draft.");
  const typedFrame = secretRender.captureCharFrame();
  if (typedFrame.includes("zq7x") || typedFrame.includes("live") || typedFrame.includes("1234"))
    throw new Error(`The secret was shown while typed.\n${typedFrame}`);
  secretRender.mockInput.pressEnter();
  await secretRender.waitFor(() => workAnswers.length === 1);
  if (
    JSON.stringify(workAnswers[0]) !==
    JSON.stringify({
      kind: "resolve-work-request",
      requestId: workSecretId,
      expectedVersion: 1,
      resolution: { kind: "user-input", secret: true },
      secretAnswer: "zq7x-live\n1234",
    })
  )
    throw new Error("The secret was not sent only as secretAnswer.");
  await secretRender.waitForFrame((frame) => !frame.includes("Paste the export API token"));
  const sentFrame = secretRender.captureCharFrame();
  if (sentFrame.includes("zq7x") || sentFrame.includes("live") || sentFrame.includes("1234"))
    throw new Error(`The secret appeared after it was sent.\n${sentFrame}`);
  secretRender.mockInput.pressCtrlC();
  await running;
  console.log("Answered a secret Work question without showing it");
} finally {
  workSecretPending = false;
  secretRender.renderer.destroy();
}
