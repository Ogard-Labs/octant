import { describe, expect, it } from "vitest";
import { paletteFor, statusLineFrom, tasksFrom, toolLines, transcriptFrom } from "./agentTuiModel";

const threadId = "00000000-0000-4000-8000-000000000020";
const content = (id: string, body: string) => ({
  contentId: id,
  role: "user",
  body,
  digest: "d",
  byteLength: body.length,
});
const attempt = (outcome: string, ref: string, at: string) => ({
  id: "00000000-0000-4000-8000-0000000000a1",
  outcome,
  responseRefs: [{ contentId: ref }],
  createdAt: at,
});

const thread = {
  thread: { id: threadId, title: "Parser", modelId: "frontier-large", version: 3 },
  turns: [
    {
      createdAt: "2026-09-05T11:30:00.000Z",
      userMessageRef: { contentId: "c1" },
      attempts: [attempt("completed", "r1", "2026-09-05T11:30:05.000Z")],
    },
    {
      createdAt: "2026-09-05T11:35:00.000Z",
      userMessageRef: { contentId: "c2" },
      attempts: [attempt("streaming", "r2", "2026-09-05T11:35:01.000Z")],
    },
  ],
  contents: [
    content("c1", "Fix the parser."),
    content("r1", "Done."),
    content("c2", "Now add tests."),
    content("r2", "Writing"),
  ],
} as never;

const session = {
  session: {
    status: "running",
    lead: { modelId: "frontier-large" },
    turnsRun: 1,
    cutovers: 0,
  },
  turns: [
    {
      toolCalls: 3,
      route: { kind: "primary", candidate: { modelId: "frontier-large" } },
      stopReason: "end-turn",
      usage: { inputTokens: 1200, outputTokens: 300 },
      startedAt: "2026-09-05T11:30:00.000Z",
      endedAt: "2026-09-05T11:31:27.000Z",
    },
  ],
  questions: [],
} as never;

describe("agent terminal UI model", () => {
  it("lays the conversation out as you/lead turns and attaches the harness record to the finished one", () => {
    const entries = transcriptFrom(thread, session);
    expect(entries.map((entry) => entry.kind)).toEqual(["you", "lead", "you", "lead"]);
    expect(entries[0]).toMatchObject({ kind: "you", text: "Fix the parser." });
    expect(entries[1]).toMatchObject({
      kind: "lead",
      text: "Done.",
      outcome: "completed",
      actions: { toolCalls: 3, model: "frontier-large", route: "primary", duration: "1m 27s" },
    });
    expect(entries[3]).toMatchObject({ kind: "lead", text: "Writing", outcome: "streaming" });
    expect((entries[3] as { actions?: unknown }).actions).toBeUndefined();
  });

  it("sums the footer from the harness session and takes its colours from the app theme", () => {
    expect(statusLineFrom(thread, session)).toBe(
      "running · frontier-large · 1 turns · 1.2k in · 300 out",
    );
    const dark = paletteFor("octant", "dark");
    const light = paletteFor("octant", "light");
    expect(dark.background).not.toBe(light.background);
    expect(dark.accent).toMatch(/^#/);
    expect(paletteFor(undefined, "dark").text).toMatch(/^#/);
  });

  it("turns the turn's calls into tree lines and counts its edits and failures", () => {
    const base = (session as { turns: ReadonlyArray<Record<string, unknown>> }).turns[0] ?? {};
    const record = {
      ...base,
      toolCalls: 6,
      tools: [
        { name: "read", summary: "read: a.ts", status: "ok", durationMs: 120 },
        { name: "edit", summary: "edit: a.ts", status: "ok", durationMs: 90 },
        { name: "bash", summary: "bash: bun test", status: "failed", durationMs: 12400 },
      ],
    };
    const entries = transcriptFrom(thread, {
      ...(session as Record<string, unknown>),
      turns: [record],
    } as never);
    expect(entries[1]).toMatchObject({
      actions: { toolCalls: 6, edits: 1, failed: 1, tools: toolLines(record.tools as never) },
    });
    expect(toolLines(record.tools as never)).toEqual([
      { name: "read", summary: "a.ts", status: "ok", duration: "120ms" },
      { name: "edit", summary: "a.ts", status: "ok", duration: "90ms" },
      { name: "bash", summary: "bun test", status: "failed", duration: "12.4s" },
    ]);
    expect(
      tasksFrom({
        ...(thread as Record<string, unknown>),
        workItems: [
          { title: "Done one", status: "completed", position: 0 },
          { title: "Doing", status: "in-progress", position: 1 },
          { title: "Later", status: "pending", position: 2 },
        ],
      } as never),
    ).toEqual({
      done: 1,
      total: 3,
      items: [
        { title: "Doing", status: "in-progress" },
        { title: "Later", status: "pending" },
      ],
    });
  });
});
