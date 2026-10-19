import { PassThrough, Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import * as agentThreads from "./agentThread";
import * as siteApprovals from "./agentSiteApprovals";
import type { LocalControlRequest, OpenedLocalControlSession } from "./localControl";
import { NativeHarnessApproval, WORK_TURN_CAPABILITIES, decodeHostAnswer } from "@octant/contracts";
import {
  decidePendingApproval,
  lineSource,
  resolveAgentCliCommand,
  runAgentCliCommand,
} from "./agentCommand";

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

/**
 * The routes the terminal walks to open an existing Chat thread in its window
 * before it reads the thread's harness session; undefined for any other route.
 */
function chatThreadOpening(
  threadId: string,
  request: LocalControlRequest,
): { status: number; body: unknown } | undefined {
  if (request.path === "/api/projects/bootstrap") {
    return { status: 200, body: { active: [], archived: [], availability: [], memory: [] } };
  }
  if (request.path === "/api/shell/bootstrap")
    return { status: 200, body: { workspaceVersion: 1 } };
  if (request.path === "/api/shell/commands") return { status: 200, body: {} };
  if (request.path === `/api/chat/threads/${threadId}`) {
    const now = "2026-10-09T09:00:00.000Z";
    return {
      status: 200,
      body: {
        thread: {
          id: threadId,
          title: "Plain question",
          lifecycle: "active",
          providerInstanceId: "50000000-0000-4000-8000-000000000001",
          modelId: "loopback-model",
          researchEnabled: false,
          researchRouting: "automatic",
          personalityInstructions: "Be brief.",
          version: 1,
          createdAt: now,
          updatedAt: now,
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
  return undefined;
}

function sink() {
  const chunks: string[] = [];
  return { write: (chunk: string) => chunks.push(chunk), text: () => chunks.join("") };
}

describe("octant agent command line", () => {
  it.each([{ threadId: "existing" }, { last: true }])(
    "refuses a model override while attaching to an existing thread",
    async (attachment) => {
      const stderr = sink();
      const seen: LocalControlRequest[] = [];
      const code = await runAgentCliCommand({
        command: {
          action: "agent",
          mode: "chat",
          model: "API/model",
          prompt: "Do not send",
          json: true,
          plain: false,
          quiet: true,
          last: false,
          ...attachment,
        },
        session: session((request) => {
          seen.push(request);
          return { status: 404, body: {} };
        }),
        stdin: Readable.from([]),
        stdout: sink(),
        stderr,
      });
      expect(code).toBe(1);
      expect(stderr.text()).toContain("--model selects a new thread");
      expect(seen).toEqual([]);
    },
  );

  it.each(
    [false, true].flatMap((json) =>
      (["refused", "accepted", "delayed", "unavailable"] as const).map((outcome) => ({
        json,
        outcome,
      })),
    ),
  )(
    "follows only the new turn when send resolves $outcome during polling (json=$json)",
    async ({ json, outcome }) => {
      const threadId = "60000000-0000-4000-8000-000000000001";
      const stdout = sink();
      const stderr = sink();
      const send =
        Promise.withResolvers<Awaited<ReturnType<agentThreads.AgentThreadPort["send"]>>>();
      let resolvedDuringPoll = false;
      let reads = 0;
      const sendPrompt = vi.fn(() => send.promise);
      const port = vi.spyOn(agentThreads, "agentThreadPort").mockReturnValue({
        mode: "chat",
        threadId,
        send: sendPrompt,
        interrupt: async () => ({ kind: "nothing-running" }),
        read: async () => {
          reads += 1;
          if (outcome === "unavailable" && reads === 1) return undefined;
          if (reads === 2) {
            resolvedDuringPoll = true;
            if (outcome === "refused")
              send.resolve({ kind: "refused", message: "Request body is too large." });
            if (outcome === "accepted" || outcome === "unavailable") send.resolve({ kind: "sent" });
          }
          if (outcome === "delayed" && reads === 4) {
            expect(stdout.text()).toContain("New");
            send.resolve({ kind: "sent" });
          }
          return {
            id: threadId,
            mode: "chat",
            title: "Earlier conversation",
            providerInstanceId: "profile",
            modelId: "model",
            version: 1,
            workItems: [],
            turns: [
              {
                id: reads <= 2 ? "earlier" : "new",
                at: "now",
                prompt: reads <= 2 ? "old" : "new",
                reply:
                  reads <= 2
                    ? "Earlier reply"
                    : outcome === "delayed" && reads === 3
                      ? "New"
                      : "New reply",
                replyAt: "now",
                outcome: outcome === "delayed" && reads === 3 ? "streaming" : "completed",
              },
            ],
          };
        },
      });
      try {
        const code = await runAgentCliCommand({
          command: {
            action: "agent",
            mode: "chat",
            threadId,
            prompt: "new",
            json,
            plain: true,
            quiet: true,
            last: false,
          },
          session: session((request) => {
            if (request.path.startsWith("/api/native-harness/sessions/")) {
              return { status: 200, body: { view: null } };
            }
            return chatThreadOpening(threadId, request) ?? { status: 200, body: [] };
          }),
          stdin: Readable.from([]),
          stdout,
          stderr,
          pollIntervalMs: 1,
        });
        expect(resolvedDuringPoll).toBe(outcome !== "unavailable");
        expect(code).toBe(outcome === "refused" || outcome === "unavailable" ? 1 : 0);
        if (outcome === "unavailable") {
          expect(sendPrompt).not.toHaveBeenCalled();
          expect(stdout.text()).not.toContain("Earlier reply");
          expect(stderr.text()).toContain("could not be read before sending");
          return;
        }
        expect(stdout.text()).not.toContain("Earlier reply");
        if (outcome === "refused") {
          expect(stdout.text()).not.toContain('"kind":"outcome"');
          expect(stderr.text()).toBe("Request body is too large.\n");
        } else {
          expect(stdout.text()).toContain("New");
          expect(stdout.text()).toContain("reply");
          expect(stderr.text()).toBe("");
        }
      } finally {
        port.mockRestore();
      }
    },
  );

  it.each(["session", "sites", "thread", "pending", "missing"] as const)(
    "does not answer, deny or interrupt an earlier interaction when send is refused during %s polling",
    async (stage) => {
      const threadId = "60000000-0000-4000-8000-000000000001";
      const now = "2026-10-19T12:00:00.000Z";
      const send =
        Promise.withResolvers<Awaited<ReturnType<agentThreads.AgentThreadPort["send"]>>>();
      const refuse = () => send.resolve({ kind: "refused", message: "New prompt refused." });
      const stdout = sink();
      const stderr = sink();
      const interrupt = vi.fn(async () => ({ kind: "interrupted" as const }));
      const answer = vi.fn(async () => ({ kind: "answered" as const }));
      const mutations: LocalControlRequest[] = [];
      let reads = 0;
      const port = vi.spyOn(agentThreads, "agentThreadPort").mockReturnValue({
        threadId,
        mode: "chat",
        send: () => send.promise,
        interrupt,
        answerQuestion: answer,
        read: async () => {
          reads += 1;
          if (
            (stage === "thread" && reads === 2) ||
            ((stage === "pending" || stage === "missing") && reads === 3)
          )
            refuse();
          return {
            id: threadId,
            mode: "chat",
            title: "Earlier conversation",
            providerInstanceId: "profile",
            modelId: "model",
            version: 1,
            workItems: [],
            turns:
              stage === "missing" && reads === 2
                ? []
                : [
                    {
                      id: reads === 1 || stage === "pending" ? "earlier" : "new",
                      at: now,
                      prompt: "old",
                      reply: "",
                      replyAt: now,
                      outcome: "waiting",
                    },
                  ],
            pendingQuestion: { id: "old-question", prompt: "Earlier question?", options: [] },
          };
        },
      });
      const sites = vi
        .spyOn(siteApprovals, "listAgentSiteApprovals")
        .mockImplementation(async () => {
          if (stage === "sites") refuse();
          return stage === "sites" || stage === "pending"
            ? [
                {
                  mode: "work",
                  id: "40000000-0000-4000-8000-000000000001",
                  threadId,
                  origin: "https://docs.example.com",
                },
              ]
            : [];
        });
      try {
        const code = await runAgentCliCommand({
          command: {
            action: "agent",
            mode: "chat",
            threadId,
            prompt: "new",
            json: false,
            plain: true,
            quiet: true,
            last: false,
          },
          session: session((request) => {
            const opening = chatThreadOpening(threadId, request);
            if (opening !== undefined) return opening;
            if (request.path === `/api/native-harness/sessions/${threadId}`) {
              if (stage === "session") refuse();
              return {
                status: 200,
                body: {
                  view: {
                    session: {
                      id: "00000000-0000-4000-8000-000000000010",
                      threadId,
                      mode: "chat",
                      leadSlotId: "default",
                      lead: {
                        hostId: "00000000-0000-4000-8000-0000000000aa",
                        providerInstanceId: "00000000-0000-4000-8000-000000000001",
                        modelId: "model",
                      },
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
                    activatedFollowUpIds: [],
                    questions:
                      stage === "session" || stage === "pending"
                        ? [
                            {
                              id: "00000000-0000-4000-8000-000000000080",
                              prompt: "Earlier harness question?",
                              options: [],
                              status: "pending",
                              askedAt: now,
                            },
                          ]
                        : [],
                    approvals:
                      stage === "session" || stage === "pending"
                        ? [
                            {
                              id: "00000000-0000-4000-8000-000000000081",
                              toolName: "bash",
                              summary: "Earlier approval",
                              approvalClass: "shell-commands",
                              status: "pending",
                              askedAt: now,
                            },
                          ]
                        : [],
                  },
                },
              };
            }
            if (request.method === "POST") mutations.push(request);
            return { status: 200, body: {} };
          }),
          stdin: Readable.from([]),
          stdout,
          stderr,
          pollIntervalMs: 1,
        });
        expect(code).toBe(1);
        expect(stderr.text()).toBe("New prompt refused.\n");
        expect(mutations).toEqual([]);
        expect(interrupt).not.toHaveBeenCalled();
        expect(answer).not.toHaveBeenCalled();
        expect(stdout.text()).not.toContain("Earlier");
        expect(stdout.text()).not.toContain("Browser wants");
      } finally {
        port.mockRestore();
        sites.mockRestore();
      }
    },
  );

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

  it("opens the thread in the terminal's window before it reads the thread's harness session", async () => {
    const stdout = sink();
    const seen: string[] = [];
    const threadId = "60000000-0000-4000-8000-000000000001";
    const code = await runAgentCliCommand({
      command: { action: "harness-session", threadId, json: false },
      session: session((request) => {
        seen.push(`${request.method} ${request.path}`);
        return chatThreadOpening(threadId, request) ?? { status: 200, body: { view: null } };
      }),
      stdin: process.stdin,
      stdout,
      stderr: sink(),
    });
    expect(code).toBe(0);
    expect(stdout.text()).toContain("no native harness session");
    const opened = seen.indexOf("POST /api/shell/commands");
    const read = seen.indexOf(`GET /api/native-harness/sessions/${threadId}`);
    expect(opened).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(opened);
  });

  it("says why when the thread to read is not on this host", async () => {
    const stderr = sink();
    const code = await runAgentCliCommand({
      command: { action: "harness-session", threadId: "missing", json: false },
      session: session((request) =>
        request.path === "/api/projects/bootstrap"
          ? { status: 200, body: { active: [], archived: [], availability: [], memory: [] } }
          : { status: 404, body: { message: "Thread not found." } },
      ),
      stdin: process.stdin,
      stdout: sink(),
      stderr,
    });
    expect(code).toBe(1);
    expect(stderr.text()).toContain("Thread not found.");
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
        const opening = chatThreadOpening(threadId, request);
        if (opening !== undefined) return opening;
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

  it("lists the goal's criteria with their check, evidence and state, not only a count", async () => {
    const stdout = sink();
    const threadId = "00000000-0000-4000-8000-000000000020";
    const goal = {
      id: "00000000-0000-4000-8000-000000000051",
      threadId,
      revisionId: "00000000-0000-4000-8000-000000000052",
      objective: "Ship the parser",
      status: "active",
      budget: {},
      usage: { tokensUsed: 0, elapsedMs: 0, turnsUsed: 0 },
      evidence: [],
      criteria: [
        {
          id: "c1",
          text: "Tests pass",
          check: "bun run test",
          status: "met",
          evidence: {
            kind: "test",
            referenceId: "goal-check:c1",
            summary: "Exited 0 after 41 passing tests",
            observedAt: "2026-10-02T12:30:00.000Z",
          },
        },
        { id: "c2", text: "Docs updated", status: "unmet" },
        {
          id: "c3",
          text: "Build is clean",
          check: "bun run build",
          status: "unmet",
          evidence: {
            kind: "test",
            referenceId: "goal-check:c3",
            summary: "Exited 1: type error in lexer.ts",
            observedAt: "2026-10-02T12:40:00.000Z",
          },
        },
      ],
      createdAt: "2026-10-02T12:00:00.000Z",
      updatedAt: "2026-10-02T12:00:00.000Z",
      version: 3,
    };
    const commands: unknown[] = [];
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
        const opening = chatThreadOpening(threadId, request);
        if (opening !== undefined) return opening;
        if (request.path.startsWith("/api/goals?")) {
          return { status: 200, body: { goal, history: [] } };
        }
        if (request.path === "/api/goals/commands") commands.push(request.body);
        return { status: 404, body: {} };
      }),
      stdin: Readable.from(["/goal\n", "/quit\n"]),
      stdout,
      stderr: sink(),
    });
    expect(code).toBe(0);
    expect(stdout.text()).toContain("Goal (active): Ship the parser · 1 of 3 criteria met");
    expect(stdout.text()).toMatch(/met\s+c1\s+Tests pass\n\s+check: bun run test\n/);
    expect(stdout.text()).toContain(
      "evidence (test, 2026-10-02T12:30:00.000Z): Exited 0 after 41 passing tests",
    );
    expect(stdout.text()).toMatch(
      /unmet\s+c2\s+Docs updated\n\s+check: confirmed by a person\n\s+evidence: none yet/,
    );
    expect(stdout.text()).toContain(
      "evidence (test, 2026-10-02T12:40:00.000Z): Exited 1: type error in lexer.ts",
    );
    // Reading the ledger sends no command.
    expect(commands).toEqual([]);
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
        const opening = chatThreadOpening(threadId, request);
        if (opening !== undefined) return opening;
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
  it.each([
    ["sends the answer", false, false],
    ["asks again when the host could not take the first answer", true, false],
    ["refuses before sending when its transcript is unavailable", false, true],
  ] as const)(
    "asks about the site a Work turn's Browser call is waiting on and %s",
    async (_outcome, unavailableFirst, unavailableTranscript) => {
      const threadId = "00000000-0000-4000-8000-000000000101";
      const projectId = "20000000-0000-4000-8000-000000000001";
      const approvalId = "40000000-0000-4000-8000-000000000001";
      const stdout = sink();
      const stopped = new AbortController();
      const decisions: unknown[] = [];
      let settled = false;
      let started = false;
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
          if (request.path === `/api/work/turns/transcript/${threadId}`) {
            return unavailableTranscript
              ? { status: 503, body: {} }
              : {
                  status: 200,
                  body: {
                    threadId,
                    turns: started
                      ? [
                          {
                            requestId: "70000000-0000-4000-8000-000000000001",
                            turnId: "80000000-0000-4000-8000-000000000001",
                            threadId,
                            projectId,
                            authority: {
                              hostId: "local",
                              projectId,
                              bindingRevisionId: "66666666-6666-4666-8666-666666666666",
                              workingDirectory: ".",
                              confinementPosture: "project-root-confined",
                              providerInstanceId: "10000000-0000-4000-8000-000000000001",
                              modelId: "frontier-large",
                            },
                            status: "running",
                            prompt: "Check the docs site",
                            transcript: [],
                            capabilities: WORK_TURN_CAPABILITIES,
                            version: 1,
                            acceptedAt: "2026-10-09T12:00:00.000Z",
                            updatedAt: "2026-10-09T12:00:00.000Z",
                          },
                        ]
                      : [],
                  },
                };
          }
          if (request.path === "/api/browser/approvals") {
            if ((request.body as { kind?: unknown }).kind === "decide") {
              decisions.push(request.body);
              if (unavailableFirst && decisions.length === 1) {
                return { status: 503, body: { message: "Browser approval is unavailable." } };
              }
              settled = true;
              stopped.abort();
              return { status: 200, body: { accepted: true } };
            }
            return {
              status: 200,
              body: settled
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
            if (request.path === "/api/work/turns") started = true;
            return { status: 200, body: {} };
          }
          return { status: 404, body: {} };
        }),
        stdin: Readable.from(["y\n", "y\n"]),
        stdout,
        stderr: sink(),
        pollIntervalMs: 5,
        signal: stopped.signal,
      });
      expect(code).toBe(1);
      if (unavailableTranscript) {
        expect(started).toBe(false);
        expect(decisions).toEqual([]);
        return;
      }
      expect(stdout.text()).toContain("! Browser wants to open https://docs.example.com");
      expect(decisions).toEqual(
        Array.from({ length: unavailableFirst ? 2 : 1 }, () => ({
          kind: "decide",
          approvalId,
          decision: "approved",
        })),
      );
    },
  );
});

describe("octant agent helper agents", () => {
  const threadId = "00000000-0000-4000-8000-000000000301";
  const runId = "72000000-0000-4000-8000-000000000001";
  const now = "2026-10-16T09:00:00.000Z";
  const row = {
    runId,
    requestId: "71000000-0000-4000-8000-000000000001",
    parentThreadId: threadId,
    parentThreadTitle: "Plan the parser",
    mode: "chat",
    role: "research",
    task: "Find where the lexer handles escapes",
    lifecycleStatus: "running",
    executionKind: "octant-managed",
    authority: {
      filesystem: false,
      shell: false,
      git: false,
      network: false,
      tools: true,
      subagents: false,
      executionPolicy: "approval-gated",
      permissionPersistence: "current-session",
    },
    workspaceKind: "chat-virtual",
    usageQuality: "unavailable",
    route: {
      requestedProviderInstanceId: "50000000-0000-4000-8000-000000000001",
      requestedModelId: "loopback-model",
      executionProviderInstanceId: "50000000-0000-4000-8000-000000000001",
      executionModelId: "loopback-model",
      poolDerived: false,
    },
    resultAcknowledgement: { required: false, acknowledged: false },
    version: 3,
    createdAt: now,
    updatedAt: now,
  };

  function hostSession(posted: LocalControlRequest[] = []) {
    return session((request) => {
      const opened = chatThreadOpening(threadId, request);
      if (opened !== undefined) return opened;
      if (request.path.startsWith("/api/agent-runs/center")) {
        return { status: 200, body: { items: [row] } };
      }
      if (request.path.startsWith("/api/agent-runs/results")) {
        return { status: 200, body: { runId, packets: [], truncated: false } };
      }
      if (request.path.startsWith("/api/agent-runs/conversation")) {
        return {
          status: 200,
          body: {
            runId,
            parentThreadId: threadId,
            executionKind: "octant-managed",
            modelId: "loopback-model",
            lifecycleStatus: "running",
            status: "live",
            entries: [
              { sequence: 1, kind: "assistant", text: "Reading the lexer.", occurredAt: now },
            ],
            truncated: false,
          },
        };
      }
      if (request.path === "/api/agent-runs/steer") {
        posted.push(request);
        return { status: 200, body: { kind: "run-updated" } };
      }
      if (request.path.startsWith("/api/native-harness/sessions/")) {
        return { status: 200, body: { view: null } };
      }
      return { status: 404, body: {} };
    });
  }

  async function harness(
    command: { readonly child?: string; readonly json: boolean },
    posted: LocalControlRequest[] = [],
  ) {
    const stdout = sink();
    const stderr = sink();
    const code = await runAgentCliCommand({
      command: { action: "harness-agents", threadId, ...command },
      session: hostSession(posted),
      stdin: Readable.from([]),
      stdout,
      stderr,
    });
    return { code, stdout: stdout.text(), stderr: stderr.text() };
  }

  it("parses the harness agents form with an optional helper", () => {
    expect(resolveAgentCliCommand("harness", ["agents", threadId], {})).toEqual({
      action: "harness-agents",
      threadId,
      json: false,
    });
    expect(resolveAgentCliCommand("harness", ["agents", threadId, "1"], { json: true })).toEqual({
      action: "harness-agents",
      threadId,
      child: "1",
      json: true,
    });
    expect(resolveAgentCliCommand("harness", ["agents"], {})).toBeUndefined();
  });

  it("lists the thread's helpers, and as JSON the host's own rows", async () => {
    const plain = await harness({ json: false });
    expect(plain.code).toBe(0);
    expect(plain.stdout).toContain("1. [72000000] working · research · loopback-model");
    expect(plain.stdout).toContain("Find where the lexer handles escapes");
    const json = await harness({ json: true });
    expect(JSON.parse(json.stdout.trim())).toMatchObject({ children: [{ runId, task: row.task }] });
  });

  it("shows one helper's brief, live text and how to reply", async () => {
    const result = await harness({ child: "1", json: false });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Brief: Find where the lexer handles escapes");
    expect(result.stdout).toContain("Reading the lexer.");
    expect(result.stdout).toContain("Steer it with: /agent <n> <message>");
    expect((await harness({ child: "7", json: false })).code).toBe(1);
  });

  it("lists, shows and steers helpers from the prompt loop", async () => {
    const posted: LocalControlRequest[] = [];
    const stdout = sink();
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
      session: hostSession(posted),
      stdin: Readable.from(["/agents\n", "/agent 1\n", "/agent 1 use sqlite\n", "/quit\n"]),
      stdout,
      stderr: sink(),
    });
    expect(code).toBe(0);
    expect(stdout.text()).toContain("1. [72000000] working");
    expect(stdout.text()).toContain("Reading the lexer.");
    expect(stdout.text()).toContain("Sent to the helper; it reads it at its next step.");
    expect(posted[0]).toMatchObject({
      body: { runId, expectedVersion: 3, message: "use sqlite" },
    });
  });
});

describe("octant agent Chat lead question", () => {
  const threadId = "00000000-0000-4000-8000-000000000201";
  const turnId = "61000000-0000-4000-8000-000000000001";
  const attemptId = "62000000-0000-4000-8000-000000000001";
  const now = "2026-10-16T09:00:00.000Z";

  /** The Chat thread as the host reads it: parked on a question, then finished. */
  function chatView(state: "parked" | "answered") {
    const digest = "a".repeat(64);
    const base = chatThreadOpening(threadId, { path: `/api/chat/threads/${threadId}` } as never);
    const thread = (base?.body as { thread: Record<string, unknown> }).thread;
    return {
      thread: { ...thread, version: 4 },
      turns: [
        {
          id: turnId,
          threadId,
          sequence: 1,
          userMessageRef: {
            contentId: "63000000-0000-4000-8000-000000000001",
            digest,
            byteLength: 4,
          },
          attachmentIds: [],
          attempts: [
            {
              id: attemptId,
              turnId,
              threadId,
              providerInstanceId: "50000000-0000-4000-8000-000000000001",
              providerSessionId: "64000000-0000-4000-8000-000000000001",
              modelId: "loopback-model",
              contextManifestId: "65000000-0000-4000-8000-000000000001",
              outcome: state === "parked" ? "waiting" : "completed",
              responseRefs: [],
              citationIds: [],
              ...(state === "parked"
                ? {
                    pendingQuestion: {
                      requestId: "call_1",
                      prompt: "Which database?",
                      options: [
                        { label: "sqlite", description: "one file, no server" },
                        { label: "postgres" },
                      ],
                    },
                  }
                : {}),
              createdAt: now,
              updatedAt: now,
            },
          ],
          createdAt: now,
        },
      ],
      lastSequence: 2,
      contents: [
        {
          contentId: "63000000-0000-4000-8000-000000000001",
          role: "user",
          body: "plan",
          digest,
          byteLength: 4,
        },
      ],
      attachments: [],
      citations: [],
      workItems: [],
      workListVersion: 0,
      followUpVersion: 0,
    };
  }

  async function run(options: { readonly json: boolean; readonly typed: string }) {
    const stdout = sink();
    const stderr = sink();
    const posted: Array<{ readonly kind?: string; readonly [key: string]: unknown }> = [];
    let answered = false;
    let sent = false;
    const code = await runAgentCliCommand({
      command: {
        action: "agent",
        threadId,
        prompt: "plan",
        json: options.json,
        plain: true,
        last: false,
        quiet: false,
        mode: "chat",
      },
      session: session((request) => {
        if (request.path === `/api/chat/threads/${threadId}` && sent) {
          return { status: 200, body: chatView(answered ? "answered" : "parked") };
        }
        const opened = chatThreadOpening(threadId, request);
        if (opened !== undefined) return opened;
        if (request.path === "/api/chat/commands") {
          const body = request.body as { kind?: string };
          posted.push(body);
          if (body.kind === "send-chat-turn") sent = true;
          if (body.kind === "answer-chat-turn-question" || body.kind === "interrupt-chat-turn") {
            answered = true;
          }
          return { status: 200, body: {} };
        }
        if (request.path.startsWith("/api/native-harness/sessions/")) {
          return { status: 200, body: { view: null } };
        }
        return { status: 200, body: [] };
      }),
      stdin: Readable.from([options.typed]),
      stdout,
      stderr,
      pollIntervalMs: 5,
    });
    return { code, stdout: stdout.text(), stderr: stderr.text(), posted };
  }

  it("shows the question with numbered options and sends the picked option as the answer", async () => {
    const result = await run({ json: false, typed: "2\n" });
    expect(result.stdout).toContain("? Which database?");
    expect(result.stdout).toContain("  1. sqlite — one file, no server");
    expect(result.stdout).toContain("  2. postgres");
    expect(result.posted.filter((body) => body.kind === "answer-chat-turn-question")).toEqual([
      {
        kind: "answer-chat-turn-question",
        threadId,
        expectedVersion: 4,
        turnId,
        attemptId,
        requestId: "call_1",
        answer: "postgres",
      },
    ]);
    expect(result.code).toBe(0);
  });

  it("stops the parked turn when stdin ends before an answer, instead of waiting forever", async () => {
    const result = await run({ json: false, typed: "" });
    expect(result.stderr).toContain("Input ended before the question was answered");
    expect(result.posted.map((body) => body.kind)).toContain("interrupt-chat-turn");
    expect(result.posted.map((body) => body.kind)).not.toContain("answer-chat-turn-question");
  });

  it("asks again after a blank line rather than leaving the turn parked", async () => {
    const result = await run({ json: false, typed: "\n2\n" });
    expect(result.stdout.match(/\? Which database\?/g)).toHaveLength(2);
    expect(result.posted.filter((body) => body.kind === "answer-chat-turn-question")).toMatchObject(
      [{ answer: "postgres" }],
    );
  });

  it("emits the question as a JSON line and reads the answer from stdin", async () => {
    const result = await run({ json: true, typed: "use sqlite\n" });
    const lines = result.stdout
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as { kind: string; question?: { prompt: string } });
    expect(lines.find((line) => line.kind === "question")?.question).toMatchObject({
      id: "call_1",
      prompt: "Which database?",
      options: ["sqlite", "postgres"],
      status: "pending",
    });
    expect(result.posted.find((body) => body.kind === "answer-chat-turn-question")).toMatchObject({
      answer: "use sqlite",
    });
  });
});

describe("octant agent approval prompt", () => {
  const threadId = "00000000-0000-4000-8000-000000000101";
  const leadRequest = {
    id: "00000000-0000-4000-8000-000000000081",
    toolName: "bash",
    summary: "bash: bun run test",
    approvalClass: "shell-commands",
    status: "pending",
    askedAt: "2026-10-13T12:06:00.000Z",
  };
  const childSource = {
    runId: "00000000-0000-4000-8000-000000000091",
    providerInstanceId: "10000000-0000-4000-8000-000000000001",
    modelId: "frontier-large",
  };

  async function answer(raw: unknown, typed: string) {
    const stdout = sink();
    const sent: LocalControlRequest[] = [];
    await decidePendingApproval(
      {
        command: { json: false },
        stdout,
        session: session((request) => {
          sent.push(request);
          return { status: 200, body: {} };
        }),
      },
      threadId,
      decodeHostAnswer(NativeHarnessApproval)(raw),
      { next: async () => typed },
    );
    return { prompt: stdout.text(), sent };
  }

  it("closes the prompt with a note when the web answers first, and keeps the next typed line", async () => {
    const stdout = sink();
    const sent: LocalControlRequest[] = [];
    const stdin = new PassThrough();
    const lines = lineSource(stdin);
    let settled = false;
    const view = () => ({
      session: {
        id: "00000000-0000-4000-8000-000000000010",
        threadId,
        mode: "code",
        leadSlotId: "default",
        lead: {
          hostId: "00000000-0000-4000-8000-0000000000aa",
          providerInstanceId: "00000000-0000-4000-8000-000000000001",
          modelId: "frontier-large",
        },
        status: "idle",
        turnsRun: 1,
        cutovers: 0,
        startedAt: "2026-10-13T12:00:00.000Z",
        updatedAt: "2026-10-13T12:00:00.000Z",
        version: 2,
      },
      routes: [],
      turns: [],
      reductions: [],
      interventions: [],
      activatedFollowUpIds: [],
      questions: [],
      approvals: [
        settled
          ? { ...leadRequest, status: "approved", settledAt: "2026-10-13T12:07:00.000Z" }
          : leadRequest,
      ],
    });
    try {
      const deciding = decidePendingApproval(
        {
          command: { json: false },
          stdout,
          pollIntervalMs: 5,
          session: session((request) => {
            sent.push(request);
            return { status: 200, body: { view: view() } };
          }),
        },
        threadId,
        decodeHostAnswer(NativeHarnessApproval)(leadRequest),
        lines,
      );
      settled = true;
      await deciding;

      expect(stdout.text()).toContain("allow? [y]es");
      expect(stdout.text()).toContain("(answered elsewhere)");
      // The decision stays with the web: nothing is posted from here.
      expect(sent.filter((request) => request.method === "POST")).toEqual([]);
      stdin.write("next prompt\n");
      await expect(lines.next()).resolves.toBe("next prompt");
    } finally {
      lines.close();
    }
  });

  it("offers a lead's request an answer for the whole session and sends it", async () => {
    const { prompt, sent } = await answer(leadRequest, "a");
    expect(prompt).toContain("[a]lways this session");
    expect(sent).toMatchObject([{ body: { decision: "approve-always" } }]);
  });

  it("prints why a marked thread asks and what marked it before the question", async () => {
    const { prompt } = await answer(
      {
        ...leadRequest,
        singleUse: true,
        outsideContent: {
          sourceCount: 3,
          sources: [
            {
              sourceLabel: "web-fetch",
              ingestionCount: 2,
              firstIngestedAt: "2026-10-13T11:00:00.000Z",
              lastIngestedAt: "2026-10-13T11:30:00.000Z",
            },
          ],
        },
      },
      "n",
    );
    expect(prompt).toContain("This thread took in outside content, so this call is approved once.");
    expect(prompt).toContain("- Web pages: Read 2 times");
    expect(prompt).toContain("and 2 more sources");
    expect(prompt.indexOf("Web pages")).toBeLessThan(prompt.indexOf("allow?"));
  });

  it("prints no outside content note for a clean thread", async () => {
    const { prompt } = await answer(leadRequest, "n");
    expect(prompt).not.toContain("outside content");
  });

  it.each([
    ["a child's request", { ...leadRequest, source: childSource }],
    ["a request after the thread took in outside content", { ...leadRequest, singleUse: true }],
  ])(
    "offers %s only allow and deny, and refuses an answer for the whole session",
    async (_name, raw) => {
      const { prompt, sent } = await answer(raw, "a");
      expect(prompt).toContain("allow? [y]es / [n]o >");
      expect(prompt).not.toContain("[a]lways");
      expect(sent).toMatchObject([{ body: { decision: "deny" } }]);
      const allowed = await answer(raw, "y");
      expect(allowed.sent).toMatchObject([{ body: { decision: "approve" } }]);
    },
  );

  const markedCommand = {
    ...leadRequest,
    singleUse: true,
    commandHosts: [
      { host: "registry.example.com", port: 443, from: "thread-rule", preselected: true },
      { host: "mirror.example.com", port: 8443, from: "project-rule", preselected: true },
      { host: "cdn.example.com", port: 443, from: "proposal", preselected: false },
    ],
  };

  it("lists a marked thread's command hosts and sends the ticked ones on y", async () => {
    const { prompt, sent } = await answer(markedCommand, "y");
    expect(prompt).toContain("[x] 1. registry.example.com:443  thread rule");
    expect(prompt).toContain("[x] 2. mirror.example.com:8443  Project rule");
    expect(prompt).toContain("[ ] 3. cdn.example.com:443  proposal");
    expect(prompt).not.toContain("[a]lways");
    expect(sent).toEqual([
      expect.objectContaining({
        body: {
          approvalId: markedCommand.id,
          decision: "approve",
          commandHosts: [
            { host: "registry.example.com", port: 443 },
            { host: "mirror.example.com", port: 8443 },
          ],
        },
      }),
    ]);
  });

  it.each([
    ["y 3", [{ host: "cdn.example.com", port: 443 }]],
    [
      "yes 1, 3",
      [
        { host: "registry.example.com", port: 443 },
        { host: "cdn.example.com", port: 443 },
      ],
    ],
    ["y none", []],
  ])("sends only the hosts the person chose with %j", async (typed, hosts) => {
    const { sent } = await answer(markedCommand, typed);
    expect(sent).toEqual([
      expect.objectContaining({
        body: { approvalId: markedCommand.id, decision: "approve", commandHosts: hosts },
      }),
    ]);
  });

  it.each(["y 4", "y 0", "y registry.example.com", "n", "a"])(
    "refuses the command and sends no host when the answer is %j",
    async (typed) => {
      const { sent } = await answer(markedCommand, typed);
      expect(sent).toEqual([
        expect.objectContaining({ body: { approvalId: markedCommand.id, decision: "deny" } }),
      ]);
    },
  );

  it("sends no host for an approval that lists none", async () => {
    const { prompt, sent } = await answer(leadRequest, "y 1");
    expect(prompt).not.toContain("[x]");
    expect(sent).toEqual([
      expect.objectContaining({ body: { approvalId: leadRequest.id, decision: "deny" } }),
    ]);
    const allowed = await answer(leadRequest, "y");
    expect(allowed.sent[0]?.body).toEqual({ approvalId: leadRequest.id, decision: "approve" });
  });
});
