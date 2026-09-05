/**
 * Draws the `octant agent` terminal screen once, from a fixed thread and
 * harness session, and prints the frame. A reproducible look at the layout
 * without a host: `bun scripts/agent-tui-preview.ts [light|dark]`. OpenTUI
 * needs Bun (or Node 26.4+), which is why this is a script and not a vitest.
 */
import * as tui from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { mountAgentScreen } from "../packages/cli/src/agentTui";
import { paletteFor } from "../packages/cli/src/agentTuiModel";

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const threadId = u(20);
const digest = "d".repeat(64);
const content = (id: string, role: string, body: string) => ({
  contentId: id,
  role,
  body,
  digest,
  byteLength: body.length,
});
const ref = (id: string) => ({ contentId: id, digest, byteLength: 1 });
const attempt = (n: number, turn: string, outcome: string, refId: string, at: string) => ({
  id: u(n),
  turnId: turn,
  threadId,
  providerInstanceId: u(1),
  providerSessionId: u(n + 100),
  modelId: "frontier-large",
  contextManifestId: u(n + 200),
  outcome,
  responseRefs: [ref(refId)],
  citationIds: [],
  createdAt: at,
  updatedAt: at,
});
const thread = {
  thread: {
    id: threadId,
    title: "Parser cleanup",
    lifecycle: "active",
    providerInstanceId: u(1),
    modelId: "frontier-large",
    researchEnabled: false,
    researchRouting: "automatic",
    personalityInstructions: "Be brief.",
    version: 3,
    createdAt: "2026-09-05T11:00:00.000Z",
    updatedAt: "2026-09-05T11:35:00.000Z",
  },
  turns: [
    {
      id: u(31),
      threadId,
      sequence: 1,
      userMessageRef: ref(u(41)),
      attachmentIds: [],
      createdAt: "2026-09-05T11:30:00.000Z",
      attempts: [attempt(51, u(31), "completed", u(42), "2026-09-05T11:30:05.000Z")],
    },
    {
      id: u(32),
      threadId,
      sequence: 2,
      userMessageRef: ref(u(43)),
      attachmentIds: [],
      createdAt: "2026-09-05T11:35:00.000Z",
      attempts: [attempt(52, u(32), "streaming", u(44), "2026-09-05T11:35:01.000Z")],
    },
  ],
  lastSequence: 12,
  contents: [
    content(
      u(41),
      "user",
      "Fix the download button on the hero. It takes 100% width on mobile and looks wrong; fix it for every size.",
    ),
    content(
      u(42),
      "assistant",
      "Done. The button now uses the shared size scale and stays inline on small screens.",
    ),
    content(u(43), "user", "Now add tests."),
    content(u(44), "assistant", "Reading the existing test setup"),
  ],
  attachments: [],
  citations: [],
  workItems: [],
  workListVersion: 0,
  followUpVersion: 0,
};
const lead = { hostId: u(170), providerInstanceId: u(1), modelId: "frontier-large" };
const session = {
  session: {
    id: u(10),
    threadId,
    mode: "chat",
    leadSlotId: "default",
    lead,
    status: "running",
    turnsRun: 1,
    cutovers: 0,
    startedAt: "2026-09-05T11:30:00.000Z",
    updatedAt: "2026-09-05T11:35:00.000Z",
    version: 2,
  },
  routes: [],
  turns: [
    {
      turnId: u(61),
      sessionId: u(10),
      sequence: 1,
      job: "lead",
      route: {
        kind: "primary",
        job: "lead",
        slotId: "default",
        candidate: lead,
        decidedAt: "2026-09-05T11:30:00.000Z",
        rejected: [],
      },
      toolCalls: 3,
      stopReason: "end-of-turn",
      usage: { inputTokens: 27400, outputTokens: 3900 },
      startedAt: "2026-09-05T11:30:00.000Z",
      endedAt: "2026-09-05T11:31:27.000Z",
    },
  ],
  reductions: [],
  interventions: [],
  followUps: {
    turnId: u(61),
    suggestions: [{ id: u(71), title: "Add tests", prompt: "Write tests.", target: "new-thread" }],
  },
  activatedFollowUpIds: [],
  questions: [
    {
      id: u(81),
      prompt: "Which database should the tests use?",
      options: ["sqlite", "postgres"],
      status: "pending",
      askedAt: "2026-09-05T11:35:10.000Z",
    },
  ],
};
const fakeSession = {
  kind: "opened",
  windowId: "w",
  send: async (request: { path: string }) =>
    request.path.includes("/chat/threads/")
      ? { status: 200, body: thread }
      : { status: 200, body: { view: session } },
  close: async () => undefined,
} as never;

const mode = (process.argv[2] ?? "dark") as "light" | "dark";
const setup = await createTestRenderer({ width: 100, height: 34 });
const screen = mountAgentScreen(tui, setup.renderer, paletteFor("octant", mode), {
  session: fakeSession,
  threadId,
  pollIntervalMs: 60_000,
});
await screen.refresh();
await setup.renderOnce();
await setup.renderOnce();
console.log(setup.captureCharFrame());
setup.renderer.destroy();
process.exit(0);
