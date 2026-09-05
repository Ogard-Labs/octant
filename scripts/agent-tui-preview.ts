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
  workItems: [
    "Audit the hero section for every breakpoint",
    "Move button sizes onto the shared scale",
    "Redesign blog archive and article layouts",
    "Redesign the gallery with previews and detail pages",
    "Redesign documentation layout and mobile controls",
    "Redesign download and guided setup journeys",
    "Review every remaining page",
    "Add restrained page transitions with reduced-motion support",
    "Update typography and content",
  ].map((title, index) => ({
    id: u(300 + index),
    threadId,
    title,
    position: index,
    origin: "agent",
    version: 1,
    status: index < 2 ? "completed" : index === 2 ? "in-progress" : "pending",
    createdAt: "2026-09-05T11:30:00.000Z",
    updatedAt: "2026-09-05T11:30:00.000Z",
  })),
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
      toolCalls: 80,
      stopReason: "end-of-turn",
      usage: { inputTokens: 27400, outputTokens: 3900, costUsd: 0.61 },
      tools: [
        ["read", "read: apps/webapp/src/routes/download.tsx", "ok", 120],
        ["grep", "grep: hero-download", "ok", 340],
        ["edit", "edit: apps/webapp/src/routes/download.tsx", "ok", 90],
        ["bash", "bash: bun run typecheck", "failed", 12400],
        ["edit", "edit: apps/webapp/src/routes/download.tsx", "ok", 80],
        ["bash", "bash: bun run typecheck", "ok", 1700],
      ].map(([name, summary, status, durationMs], index) => ({
        name,
        summary,
        status,
        durationMs,
        at: `2026-09-05T11:30:${String(10 + index).padStart(2, "0")}.000Z`,
      })),
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
  activeTools: [
    ["read", "read: vitest.config.ts", "ok", 60],
    ["glob", "glob: apps/webapp/src/**/*.test.tsx", "ok", 210],
    ["read", "read: apps/webapp/src/routes/download.test.tsx", "ok", 0],
  ].map(([name, summary, status, durationMs], index) => ({
    name,
    summary,
    status,
    durationMs,
    at: `2026-09-05T11:35:0${index + 2}.000Z`,
  })),
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
const setup = await createTestRenderer({ width: 108, height: 50 });
const screen = mountAgentScreen(tui, setup.renderer, paletteFor("octant", mode), {
  session: fakeSession,
  threadId,
  pollIntervalMs: 60_000,
});
await screen.refresh();
await setup.renderOnce();
await setup.renderOnce();
const htmlPath = process.argv[3];
if (htmlPath === undefined) {
  console.log(setup.captureCharFrame());
} else {
  // A colour-true picture of the frame, for a look without a terminal.
  const frame = setup.captureSpans();
  const css = (rgba: { r: number; g: number; b: number }) =>
    `rgb(${Math.round(rgba.r * 255)} ${Math.round(rgba.g * 255)} ${Math.round(rgba.b * 255)})`;
  const escape = (text: string) =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const rows = frame.lines
    .map((line) =>
      line.spans
        .map(
          (span) =>
            `<span style="color:${css(span.fg)};background:${css(span.bg)};${(span.attributes & tui.TextAttributes.BOLD) !== 0 ? "font-weight:600;" : ""}${(span.attributes & tui.TextAttributes.DIM) !== 0 ? "opacity:.72;" : ""}">${escape(span.text)}</span>`,
        )
        .join(""),
    )
    .join("\n");
  const ground = css(frame.lines[0]?.spans[0]?.bg ?? { r: 0, g: 0, b: 0 });
  await Bun.write(
    htmlPath,
    `<!doctype html><meta charset="utf-8"><title>octant agent</title><body style="margin:0;background:#101010;display:grid;place-items:center;min-height:100vh"><pre style="margin:24px;padding:18px 22px;border-radius:14px;background:${ground};font:14px/1.38 'JetBrains Mono','SF Mono',Menlo,monospace;box-shadow:0 30px 80px rgba(0,0,0,.6)">${rows}</pre></body>`,
  );
  console.log(`wrote ${htmlPath}`);
}
setup.renderer.destroy();
process.exit(0);
