import * as tui from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { mountAgentScreen } from "../packages/cli/src/agentTui";
import { paletteFor } from "../packages/cli/src/agentTuiModel";
const now = "2026-11-16T12:00:00.000Z";
const threadId = "60000000-0000-4000-8000-000000000001";
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
    if (path.startsWith("/api/chat/threads/"))
      return {
        status: 200,
        body: {
          thread,
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
    if (path === "/api/chat/navigation")
      return { status: 200, body: { threads: [], lastSequence: 0 } };
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
    test.mockInput.pressCtrlC();
    await running;
    console.log(`Rendered ${width}x24`);
  } finally {
    test.renderer.destroy();
  }
}

// Measure a growing 2,000-line reply with the actual native renderer.
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
const perf = await createTestRenderer({ width: 160, height: 45 });
try {
  const screen = mountAgentScreen(tui, perf.renderer, paletteFor(undefined, "dark"), {
    session: streamSession,
    threadId,
    quiet: true,
  });
  const samples: number[] = [];
  for (let i = 0; i < 25; i++) {
    reply += " delta";
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
