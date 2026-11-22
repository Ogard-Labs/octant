import { describe, expect, it, vi } from "vitest";
import * as agentThreads from "./agentThread";
import type { AgentThreadSnapshot } from "./agentThread";
import { readAgentThreadState } from "./agentStart";
import type { LocalControlRequest, OpenedLocalControlSession } from "./localControl";

const threadId = "00000000-0000-4000-8000-000000000001";
const projectId = "00000000-0000-4000-8000-000000000002";
const requestId = "00000000-0000-4000-8000-000000000003";

describe("terminal thread status", () => {
  it("reports a pending Work request as waiting instead of idle", async () => {
    const requests: LocalControlRequest[] = [];
    const session: OpenedLocalControlSession = {
      kind: "opened",
      windowId: "test",
      close: async () => undefined,
      send: async (request) => {
        requests.push(request);
        if (request.path === "/api/pending-requests") {
          return {
            status: 200,
            body: {
              requests: [
                {
                  kind: "approval",
                  mode: "work",
                  projectId,
                  threadId,
                  threadTitle: "Task",
                  requestedAt: "2026-11-16T12:00:00.000Z",
                  text: "Run the command?",
                  answer: { requestId, expectedVersion: 4 },
                },
              ],
            },
          };
        }
        return { status: 404, body: {} };
      },
    };
    const snapshot: AgentThreadSnapshot = {
      id: threadId,
      mode: "work",
      title: "Task",
      projectId,
      providerInstanceId: "provider",
      modelId: "model",
      version: 4,
      turns: [],
      workItems: [],
    };
    const port = vi.spyOn(agentThreads, "agentThreadPort").mockReturnValue({
      mode: "work",
      threadId,
      read: async () => snapshot,
      send: async () => ({ kind: "sent" }),
      interrupt: async () => ({ kind: "nothing-running" }),
    });

    const result = await readAgentThreadState(session, {
      threadId,
      mode: "work",
      projectName: "Project",
    });

    expect(port).toHaveBeenCalledWith(session, "work", threadId);
    expect(result).toMatchObject({
      kind: "read",
      state: {
        status: "waiting-for-person",
        waitingInOctant: [{ kind: "approval", text: "Run the command?" }],
      },
    });
    expect(requests.map(({ path }) => path)).toContain("/api/pending-requests");
    port.mockRestore();
  });

  it("reports a pending Code approval as waiting instead of idle", async () => {
    const session: OpenedLocalControlSession = {
      kind: "opened",
      windowId: "test",
      close: async () => undefined,
      send: async (request) =>
        request.path === "/api/pending-requests"
          ? {
              status: 200,
              body: {
                requests: [
                  {
                    kind: "approval",
                    mode: "code",
                    projectId,
                    threadId,
                    threadTitle: "Task",
                    requestedAt: "2026-11-16T12:00:00.000Z",
                    text: "Allow the command?",
                    answer: { threadId, checkoutId: projectId, approvalId: requestId },
                  },
                ],
              },
            }
          : { status: 404, body: {} },
    };
    const snapshot: AgentThreadSnapshot = {
      id: threadId,
      mode: "code",
      title: "Task",
      projectId,
      providerInstanceId: "provider",
      modelId: "model",
      version: 4,
      turns: [],
      workItems: [],
    };
    const port = vi.spyOn(agentThreads, "agentThreadPort").mockReturnValue({
      mode: "code",
      threadId,
      read: async () => snapshot,
      send: async () => ({ kind: "sent" }),
      interrupt: async () => ({ kind: "nothing-running" }),
    });

    const result = await readAgentThreadState(session, { threadId, mode: "code" });

    expect(result).toMatchObject({
      kind: "read",
      state: {
        status: "waiting-for-person",
        waitingInOctant: [{ kind: "approval", text: "Allow the command?" }],
      },
    });
    port.mockRestore();
  });
});
