import { decodeUtcTimestamp } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { approvalDecisionBody, chosenCommandHosts, preselectedCommandHosts } from "./agentHost";
import {
  approvalPanelOutsideContent,
  approvalPanelHosts,
  APPROVAL_PANEL_HOST_ROWS,
  paletteFor,
  readTuiApprovalAnswer,
  retryFooterText,
  statusLineFrom,
  tasksFrom,
  toolLines,
  transcriptFrom,
} from "./agentTuiModel";

const threadId = "00000000-0000-4000-8000-000000000020";

const thread = {
  id: threadId,
  mode: "chat",
  title: "Parser",
  providerInstanceId: "00000000-0000-4000-8000-000000000001",
  modelId: "frontier-large",
  version: 3,
  turns: [
    {
      id: "t1",
      at: "2026-09-05T11:30:00.000Z",
      prompt: "Fix the parser.",
      reply: "Done.",
      replyAt: "2026-09-05T11:30:05.000Z",
      outcome: "completed",
    },
    {
      id: "t2",
      at: "2026-09-05T11:35:00.000Z",
      prompt: "Now add tests.",
      reply: "Writing",
      replyAt: "2026-09-05T11:35:01.000Z",
      outcome: "streaming",
    },
  ],
  workItems: [],
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

  it("leaves the follow-up suggestion block out of the reply, since the panel lists those", () => {
    const withBlock = {
      ...(thread as unknown as { turns: ReadonlyArray<Record<string, unknown>> }),
      turns: [
        {
          id: "t1",
          at: "2026-09-05T11:30:00.000Z",
          prompt: "Fix the parser.",
          reply:
            'Done.\n\n```octant-follow-ups\n{"suggestions":[{"title":"Tests","prompt":"Add tests.","target":"new-thread"}]}\n```',
          replyAt: "2026-09-05T11:30:05.000Z",
          outcome: "completed",
        },
      ],
    } as never;
    const entries = transcriptFrom(withBlock, null);
    expect(entries[1]).toMatchObject({ kind: "lead", text: "Done.\n\n" });
  });

  it("sums the footer from the harness session and takes its colours from the app theme", () => {
    expect(statusLineFrom(thread, session)).toBe(
      "Running · frontier-large · 1 turns · ↑ 1.2k in · ↓ 300 out",
    );
    const dark = paletteFor("octant", "dark");
    const light = paletteFor("octant", "light");
    expect(dark.background).not.toBe(light.background);
    expect(dark.accent).toMatch(/^#/);
    expect(paletteFor(undefined, "dark").text).toMatch(/^#/);
  });

  it("words the footer's figures exactly as the web composer's stats line does", () => {
    const measured = {
      session: {
        status: "running",
        lead: { modelId: "gpt-5.6-luna" },
        turnsRun: 1,
        cutovers: 0,
        usage: { inputTokens: 48_000, outputTokens: 3_100, cacheReadInputTokens: 44_160 },
        metrics: {
          turns: 1,
          measuredTurns: 1,
          precision: "exact",
          decodeOutputTokens: 410,
          decodeMs: 10_000,
          toolMs: 0,
          timeToFirstTokenTotalMs: 900,
        },
      },
      turns: [
        {
          toolCalls: 0,
          route: { kind: "primary", candidate: { modelId: "gpt-5.6-luna" } },
          stopReason: "end-turn",
          usage: { inputTokens: 48_000, outputTokens: 3_100, cacheReadInputTokens: 44_160 },
          startedAt: "2026-09-05T11:30:00.000Z",
          endedAt: "2026-09-05T11:31:27.000Z",
        },
      ],
      questions: [],
    } as never;
    expect(statusLineFrom(undefined, measured)).toBe(
      "Running · gpt-5.6-luna · 1 turns · ↑ 48k in · ↓ 3.1k out · cache 92% · 41 tok/s · 0.9 s first token · $0.01 est.",
    );
  });

  it("marks an approximate footer speed and leaves out what was never reported", () => {
    const approximate = {
      session: {
        status: "running",
        lead: { modelId: "frontier-large" },
        turnsRun: 2,
        cutovers: 0,
        usage: { inputTokens: 5_000, outputTokens: 900 },
        metrics: {
          turns: 2,
          measuredTurns: 1,
          precision: "approximate",
          decodeOutputTokens: 300,
          decodeMs: 20_000,
          toolMs: 4_000,
          timeToFirstTokenTotalMs: 2_400,
        },
      },
      turns: [],
      questions: [],
    } as never;
    expect(statusLineFrom(undefined, approximate)).toBe(
      "Running · frontier-large · 2 turns · ↑ 5k in · ↓ 900 out · ~15 tok/s · 2.4 s first token",
    );
  });

  it("shows no figures for a session whose provider reported no usage", () => {
    const silent = {
      session: { status: "idle", lead: { modelId: "local-model" }, turnsRun: 1, cutovers: 0 },
      turns: [],
      questions: [],
    } as never;
    expect(statusLineFrom(undefined, silent)).toBe("Idle · local-model · 1 turns");
  });

  it("puts the same retry sentence in the footer, counted down from the announcement", () => {
    const announcedAt = "2026-10-06T12:00:00.000Z";
    expect(
      retryFooterText(
        {
          retrying: {
            attempt: 2,
            maxAttempts: 5,
            delayMs: 4_000,
            reason: "unavailable",
            announcedAt: decodeUtcTimestamp(announcedAt),
          },
        },
        Date.parse(announcedAt) + 1_000,
      ),
    ).toMatchInlineSnapshot(`"Provider busy, retrying 2/5 in 3 s"`);
    expect(retryFooterText({ retrying: undefined }, Date.parse(announcedAt))).toBeUndefined();
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
      { name: "read", summary: "a.ts", status: "ok", duration: "120ms", filetype: "typescript" },
      { name: "edit", summary: "a.ts", status: "ok", duration: "90ms", filetype: "typescript" },
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

describe("approval panel outside content", () => {
  const source = (sourceLabel: string) => ({
    sourceLabel,
    ingestionCount: 2,
    firstIngestedAt: decodeUtcTimestamp("2026-09-05T11:00:00.000Z"),
    lastIngestedAt: decodeUtcTimestamp("2026-09-05T11:30:00.000Z"),
  });

  it("keeps the note to the reason and one run of source names however many sources there are", () => {
    const text = approvalPanelOutsideContent({
      sourceCount: 11,
      sources: [
        "web-fetch",
        "bash",
        "read",
        "grep",
        "glob",
        "mcp-tool",
        "canvas",
        "octant_browser",
      ].map(source),
    });
    const lines = text.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("This thread took in outside content");
    expect(lines[1]).toContain("Web pages (2x)");
    expect(lines[1]).toContain("Pages seen in the browser (2x)");
    expect(lines[1]).toContain("and 3 more");
  });
});

describe("the approval panel's host list", () => {
  const approval = {
    id: "00000000-0000-4000-8000-000000000081",
    commandHosts: [
      { host: "registry.example.com", port: 443, from: "thread-rule", preselected: true },
      { host: "cdn.example.com", port: 443, from: "proposal", preselected: false },
    ],
  } as never;

  /** Types each line in turn and returns what y would then send. */
  const typeLines = (...lines: ReadonlyArray<string>) => {
    let ticked = preselectedCommandHosts(approval);
    for (const line of lines) {
      const answer = readTuiApprovalAnswer(line, approval, ticked, false);
      if (answer.kind === "tick") ticked = answer.ticked;
      else if (answer.kind === "decide") {
        return approvalDecisionBody(
          approval,
          answer.decision,
          chosenCommandHosts(approval, ticked),
        );
      }
    }
    return undefined;
  };

  it("sends the hosts the host preselected when the person allows straight away", () => {
    expect(typeLines("y")).toMatchObject({
      decision: "approve",
      commandHosts: [{ host: "registry.example.com", port: 443 }],
    });
  });

  it("toggles hosts by number and sends exactly the ticked ones", () => {
    expect(typeLines("1", "2", "y")).toMatchObject({
      commandHosts: [{ host: "cdn.example.com", port: 443 }],
    });
    expect(typeLines("none", "y")).toMatchObject({ decision: "approve", commandHosts: [] });
  });

  it("ignores a number the list does not have and sends no host with a denial", () => {
    expect(readTuiApprovalAnswer("3", approval, new Set([0]), false)).toEqual({ kind: "unknown" });
    expect(readTuiApprovalAnswer("a", approval, new Set([0]), false)).toEqual({ kind: "unknown" });
    expect(typeLines("2", "n")).toEqual({
      approvalId: (approval as { id: string }).id,
      decision: "deny",
    });
  });
});

describe("the approval panel's long host list", () => {
  const hosts = Array.from({ length: 192 }, (_entry, index) => ({
    host: `host${String(index + 1)}.example.com`,
    port: 443,
    from: index < 128 ? "thread-rule" : "proposal",
    preselected: index < 128,
  }));
  const approval = { id: "00000000-0000-4000-8000-000000000082", commandHosts: hosts } as never;

  it("shows one bounded page and names every ticked host it leaves off", () => {
    const ticked = preselectedCommandHosts(approval);
    const first = approvalPanelHosts(approval, ticked, 0);
    expect(first.rows).toHaveLength(APPROVAL_PANEL_HOST_ROWS);
    expect(first.rows[0]).toBe("[x] 1. host1.example.com:443  thread rule");
    expect(first.summary).toBe(
      "hosts 1–8 of 192 · 128 ticked, also 9–128 · > next page · < previous",
    );
    const last = approvalPanelHosts(approval, new Set([0, 2, 4, 6, 8, 10, 12, 14, 191]), 99);
    expect(last.page).toBe(23);
    expect(last.rows).toHaveLength(APPROVAL_PANEL_HOST_ROWS);
    expect(last.rows.at(-1)).toBe("[x] 192. host192.example.com:443  proposal");
    expect(last.summary).toContain("9 ticked, also 1, 3, 5, 7, 9, 11 and 2 more runs");
  });

  it("pages with > and <, keeps numbers working across pages, and sends only the ticked hosts", () => {
    let ticked = new Set<number>([0]);
    let page = 0;
    for (const line of [">", ">", "20", "<", "1", "<", "<"]) {
      const answer = readTuiApprovalAnswer(line, approval, ticked, false);
      if (answer.kind === "page")
        page = approvalPanelHosts(approval, ticked, page + answer.step).page;
      if (answer.kind === "tick") ticked = new Set(answer.ticked);
    }
    expect(page).toBe(0);
    expect(approvalPanelHosts(approval, ticked, page).summary).toContain("1 ticked, also 20");
    expect(chosenCommandHosts(approval, ticked)).toEqual([
      { host: "host20.example.com", port: 443 },
    ]);
  });

  it("shows a short list whole, with no summary", () => {
    const short = { commandHosts: hosts.slice(0, 3) } as never;
    expect(approvalPanelHosts(short, new Set([0]), 4)).toEqual({
      rows: [
        "[x] 1. host1.example.com:443  thread rule",
        "[ ] 2. host2.example.com:443  thread rule",
        "[ ] 3. host3.example.com:443  thread rule",
      ],
      page: 0,
    });
  });
});
