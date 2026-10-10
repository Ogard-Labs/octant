import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { LocalControlRequest, OpenedLocalControlSession } from "./localControl";
import { resolveAgentCliCommand, runAgentCliCommand } from "./agentCommand";

function session(
  answer: (request: LocalControlRequest) => { status: number; body: unknown },
): OpenedLocalControlSession {
  return {
    kind: "opened",
    windowId: "window",
    send: async (request) => answer(request),
    close: async () => undefined,
  };
}

function sink() {
  const chunks: string[] = [];
  return { write: (chunk: string) => chunks.push(chunk), text: () => chunks.join("") };
}

describe("octant agent command line", () => {
  it("parses the agent and harness forms and refuses unknown flags", () => {
    expect(resolveAgentCliCommand("agent", [], { prompt: "hi", json: true })).toEqual({
      action: "agent",
      prompt: "hi",
      json: true,
      plain: false,
      last: false,
      quiet: false,
      mode: "auto",
    });
    expect(resolveAgentCliCommand("agent", [], { theme: "neon" })).toBeUndefined();
    expect(resolveAgentCliCommand("agent", [], { theme: "octant", plain: true })).toMatchObject({
      theme: "octant",
      plain: true,
    });
    expect(resolveAgentCliCommand("agent", [], { model: "lm studio/gemma" })).toMatchObject({
      model: "lm studio/gemma",
    });
    expect(resolveAgentCliCommand("agent", ["extra"], {})).toBeUndefined();
    expect(resolveAgentCliCommand("agent", [], { bogus: true })).toBeUndefined();
    expect(resolveAgentCliCommand("harness", ["slots"], {})).toEqual({
      action: "harness-slots",
      json: false,
    });
    expect(resolveAgentCliCommand("harness", ["session", "t-1"], { json: true })).toEqual({
      action: "harness-session",
      threadId: "t-1",
      json: true,
    });
    expect(resolveAgentCliCommand("harness", ["session"], {})).toBeUndefined();
  });

  it("prints the host's slots and job bindings from the same route the app reads", async () => {
    const stdout = sink();
    const stderr = sink();
    const seen: string[] = [];
    const code = await runAgentCliCommand({
      command: { action: "harness-slots", json: false },
      session: session((request) => {
        seen.push(`${request.method} ${request.path}`);
        return {
          status: 200,
          body: {
            settings: {
              configuration: {
                slots: [
                  {
                    id: "default",
                    candidates: [
                      {
                        hostId: "00000000-0000-4000-8000-0000000000aa",
                        providerInstanceId: "00000000-0000-4000-8000-000000000001",
                        modelId: "frontier-large",
                      },
                    ],
                  },
                ],
                jobSlots: [{ job: "lead", slotId: "default" }],
              },
              version: 1,
              updatedAt: "2026-09-05T12:00:00.000Z",
            },
          },
        };
      }),
      stdin: process.stdin,
      stdout,
      stderr,
    });
    expect(code).toBe(0);
    expect(seen).toEqual(["GET /api/native-harness/routing"]);
    expect(stdout.text()).toContain("default");
    expect(stdout.text()).toContain("primary  frontier-large");
    expect(stdout.text()).toContain("lead → default");
  });

  it("reports a thread without a harness session plainly", async () => {
    const stdout = sink();
    const code = await runAgentCliCommand({
      command: { action: "harness-session", threadId: "t-1", json: false },
      session: session(() => ({ status: 200, body: { view: null } })),
      stdin: process.stdin,
      stdout,
      stderr: sink(),
    });
    expect(code).toBe(0);
    expect(stdout.text()).toContain("no native harness session");
  });

  it("takes a suggested follow-up from the terminal only after a yes and names the created thread", async () => {
    const stdout = sink();
    const seen: string[] = [];
    const threadId = "00000000-0000-4000-8000-000000000020";
    const suggestionId = "00000000-0000-4000-8000-000000000041";
    const view = {
      session: {
        id: "00000000-0000-4000-8000-000000000010",
        threadId,
        mode: "chat",
        leadSlotId: "default",
        lead: {
          hostId: "00000000-0000-4000-8000-0000000000aa",
          providerInstanceId: "00000000-0000-4000-8000-000000000001",
          modelId: "frontier-large",
        },
        status: "idle",
        turnsRun: 1,
        cutovers: 0,
        startedAt: "2026-09-05T12:00:00.000Z",
        updatedAt: "2026-09-05T12:00:00.000Z",
        version: 2,
      },
      routes: [],
      turns: [],
      reductions: [],
      interventions: [],
      followUps: {
        turnId: "00000000-0000-4000-8000-000000000031",
        suggestions: [
          { id: suggestionId, title: "Add tests", prompt: "Write tests.", target: "new-thread" },
        ],
      },
      activatedFollowUpIds: [],
      questions: [],
    };
    const code = await runAgentCliCommand({
      command: {
        action: "agent",
        threadId,
        json: false,
        plain: false,
        last: false,
        quiet: false,
        mode: "chat",
      },
      session: session((request) => {
        seen.push(`${request.method} ${request.path}`);
        if (request.path.endsWith("/follow-ups/preview")) {
          return {
            status: 200,
            body: {
              preview: {
                suggestion: view.followUps.suggestions[0],
                wouldCreate: { kind: "new-thread", mode: "chat", title: "Add tests" },
              },
            },
          };
        }
        if (request.path.endsWith("/follow-ups/activate")) {
          return {
            status: 200,
            body: {
              kind: "follow-up-activated",
              suggestionId,
              created: {
                kind: "new-thread",
                mode: "chat",
                title: "Add tests",
                threadId: "00000000-0000-4000-8000-000000000077",
              },
            },
          };
        }
        return { status: 200, body: { view } };
      }),
      stdin: Readable.from(["/next 1\n", "n\n", "/next 1\n", "y\n", "/quit\n"]),
      stdout,
      stderr: sink(),
    });
    expect(code).toBe(0);
    expect(seen.filter((entry) => entry.endsWith("/activate"))).toHaveLength(1);
    expect(stdout.text()).toContain("Left as a suggestion.");
    expect(stdout.text()).toContain("Created chat thread 00000000-0000-4000-8000-000000000077");
  });

  it("refuses to overwrite a goal another screen revised first and shows the newer one", async () => {
    const stdout = sink();
    const stderr = sink();
    const threadId = "00000000-0000-4000-8000-000000000020";
    const goal = (version: number, objective: string) => ({
      id: "00000000-0000-4000-8000-000000000051",
      threadId,
      revisionId: "00000000-0000-4000-8000-000000000052",
      objective,
      status: "active",
      budget: {},
      usage: { tokensUsed: 0, elapsedMs: 0, turnsUsed: 0 },
      evidence: [],
      criteria: [
        { id: "c1", text: "Tests pass", status: "met" },
        { id: "c2", text: "Docs updated", status: "unmet" },
      ],
      createdAt: "2026-10-02T12:00:00.000Z",
      updatedAt: "2026-10-02T12:00:00.000Z",
      version,
    });
    let reads = 0;
    const revisions: unknown[] = [];
    const code = await runAgentCliCommand({
      command: {
        action: "agent",
        threadId,
        json: false,
        plain: true,
        last: false,
        quiet: false,
        mode: "chat",
      },
      session: session((request) => {
        if (request.path.startsWith("/api/goals?")) {
          reads += 1;
          // The second read is after another screen revised the goal.
          return {
            status: 200,
            body: {
              goal: reads === 1 ? goal(3, "Ship the parser") : goal(4, "Ship the lexer"),
              history: [],
            },
          };
        }
        if (request.path === "/api/goals/commands") {
          revisions.push(request.body);
          return {
            status: 409,
            body: { error: "Goal version conflict; reload and retry.", category: "stale" },
          };
        }
        return { status: 404, body: {} };
      }),
      stdin: Readable.from(["/goal revise Ship the parser and its docs\n", "/quit\n"]),
      stdout,
      stderr,
    });
    expect(code).toBe(0);
    expect(revisions).toMatchObject([
      { kind: "revise-thread-goal", expectedVersion: 3, objective: "Ship the parser and its docs" },
    ]);
    expect(stderr.text()).toContain("nothing was revised");
    expect(stderr.text()).toContain("Goal (active): Ship the lexer · 1 of 2 criteria met");
  });
  it("asks about the site a Work turn's Browser call is waiting on and sends the answer", async () => {
    const threadId = "00000000-0000-4000-8000-000000000101";
    const projectId = "20000000-0000-4000-8000-000000000001";
    const approvalId = "40000000-0000-4000-8000-000000000001";
    const stdout = sink();
    const stopped = new AbortController();
    const decisions: unknown[] = [];
    const code = await runAgentCliCommand({
      command: {
        action: "agent",
        threadId,
        prompt: "Check the docs site",
        json: false,
        plain: true,
        last: false,
        quiet: false,
        mode: "work",
      },
      session: session((request) => {
        if (request.path === "/api/projects/bootstrap") {
          return {
            status: 200,
            body: {
              active: [
                {
                  id: projectId,
                  name: "Docs",
                  type: "work",
                  lifecycle: "active",
                  pinned: false,
                  rank: "1/2",
                  version: 1,
                  createdAt: "2026-10-09T12:00:00.000Z",
                  updatedAt: "2026-10-09T12:00:00.000Z",
                  binding: { canonicalRoot: "/nonexistent/docs" },
                  bindingRevisionId: "66666666-6666-4666-8666-666666666666",
                },
              ],
              archived: [],
              availability: [],
              memory: [],
            },
          };
        }
        if (request.path === "/api/shell/bootstrap") {
          return { status: 200, body: { workspaceVersion: 1 } };
        }
        if (request.path === "/api/work/threads/bootstrap") {
          return {
            status: 200,
            body: {
              threads: [
                {
                  id: threadId,
                  projectId,
                  title: "Docs check",
                  lifecycle: "active",
                  providerInstanceId: "10000000-0000-4000-8000-000000000001",
                  modelId: "frontier-large",
                  version: 1,
                  createdAt: "2026-10-09T12:00:00.000Z",
                  updatedAt: "2026-10-09T12:00:00.000Z",
                },
              ],
            },
          };
        }
        if (request.path === "/api/browser/approvals") {
          if ((request.body as { kind?: unknown }).kind === "decide") {
            decisions.push(request.body);
            stopped.abort();
            return { status: 200, body: { accepted: true } };
          }
          return {
            status: 200,
            body:
              decisions.length > 0
                ? []
                : [
                    {
                      approvalId,
                      threadId,
                      mode: "work",
                      origin: "https://docs.example.com",
                      requestedAt: "2026-10-09T12:00:01.000Z",
                    },
                  ],
          };
        }
        if (request.path.startsWith("/api/native-harness/sessions/")) {
          return { status: 200, body: { view: null } };
        }
        if (request.path === "/api/shell/commands" || request.path === "/api/work/turns") {
          return { status: 200, body: {} };
        }
        return { status: 404, body: {} };
      }),
      stdin: Readable.from(["y\n"]),
      stdout,
      stderr: sink(),
      pollIntervalMs: 5,
      signal: stopped.signal,
    });
    expect(code).toBe(1);
    expect(stdout.text()).toContain("! Browser wants to open https://docs.example.com");
    expect(decisions).toEqual([{ kind: "decide", approvalId, decision: "approved" }]);
  });
});
