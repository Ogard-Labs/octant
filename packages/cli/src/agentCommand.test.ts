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
    });
    expect(resolveAgentCliCommand("agent", [], { theme: "neon" })).toBeUndefined();
    expect(resolveAgentCliCommand("agent", [], { theme: "octant", plain: true })).toMatchObject({
      theme: "octant",
      plain: true,
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
      command: { action: "agent", threadId, json: false, plain: false, last: false, quiet: false },
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
});
