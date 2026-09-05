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
});
