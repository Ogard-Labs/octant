import { describe, expect, it } from "vitest";
import { MAX_OPEN_AGENT_MESSAGES_PER_SENDER } from "@octant/domain";
import { AgentMessageProjection } from "./agentMessageProjection";
import { createAgentMessageRouteHandler } from "./agentMessageRoutes";

const sent = {
  kind: "message-sent",
  messageId: "10000000-0000-4000-8000-000000000001",
  correlationId: "20000000-0000-4000-8000-000000000001",
  senderThreadId: "chat-0000-0000-4000-8000-00000000000a",
  recipientThreadId: "code-0000-0000-4000-8000-00000000000b",
  bodyReference: { contentReference: "am-10000000-0000-4000-8000-000000000001", byteLength: 12 },
  occurredAt: "2026-09-10T12:00:00.000Z",
};

const refusedBeforeAdmission = {
  kind: "message-refused",
  messageId: "10000000-0000-4000-8000-000000000002",
  correlationId: "20000000-0000-4000-8000-000000000002",
  refuseReason: "unauthorized",
  senderThreadId: "code-0000-0000-4000-8000-00000000000c",
  recipientThreadId: "code-0000-0000-4000-8000-0000000000ff",
  occurredAt: "2026-09-10T12:01:00.000Z",
};

function handler(
  options: {
    readonly authorized?: boolean;
    readonly mayOpen?: (threadId: string) => boolean;
  } = {},
) {
  const authorized = options.authorized ?? true;
  const projection = new AgentMessageProjection();
  projection.apply(sent as never);
  projection.apply(refusedBeforeAdmission as never);
  return {
    handle: createAgentMessageRouteHandler({
      windowAuthorityStore: {
        authenticate: (capability: string) => {
          if (!authorized || capability === "") throw new Error("unauthorized");
          return "00000000-0000-4000-8000-000000000001" as never;
        },
      } as never,
      projection,
      windowCanOpenThread: async (_windowId, threadId) =>
        (options.mayOpen ?? (() => true))(threadId),
    }),
    projection,
  };
}

describe("the agent message facts route", () => {
  it("serves the messaging facts with no bodies for an authenticated window", async () => {
    const { handle } = handler({ mayOpen: (threadId) => threadId === sent.senderThreadId });
    const response = await handle(
      new Request("http://127.0.0.1:52600/api/agent-messages", {
        method: "GET",
        headers: { "x-octant-window-capability": "wc" },
      }),
    );
    expect(response?.status).toBe(200);
    const facts = (await response?.json()) as {
      readonly openInFlight: number;
      readonly maxOpenInFlightPerSender: number;
      readonly delivered: number;
      readonly refused: number;
      readonly recent: ReadonlyArray<{ readonly state: string }>;
    };
    expect(facts).toEqual({
      openInFlight: 1,
      maxOpenInFlightPerSender: MAX_OPEN_AGENT_MESSAGES_PER_SENDER,
      delivered: 0,
      refused: 0,
      recent: [],
    });
  });

  it("shows a window a refusal, with its reason, only for a sender thread it may open", async () => {
    const read = async (mayOpen: (threadId: string) => boolean) => {
      const response = await handler({ mayOpen }).handle(
        new Request("http://127.0.0.1:52600/api/agent-messages", {
          method: "GET",
          headers: { "x-octant-window-capability": "wc" },
        }),
      );
      return (await response?.json()) as {
        readonly refused: number;
        readonly openInFlight: number;
        readonly recent: ReadonlyArray<{
          readonly refuseReason: string;
          readonly recipientThreadId: string;
        }>;
      };
    };

    const opener = await read((threadId) => threadId === refusedBeforeAdmission.senderThreadId);
    expect(opener.refused).toBe(1);
    expect(opener.recent).toEqual([
      expect.objectContaining({
        refuseReason: "unauthorized",
        recipientThreadId: refusedBeforeAdmission.recipientThreadId,
      }),
    ]);
    expect(opener.openInFlight).toBe(0);

    const stranger = await read(() => false);
    expect(stranger).toMatchObject({ refused: 0, openInFlight: 0, recent: [] });
  });

  it("refuses an unauthenticated window", async () => {
    const { handle } = handler({ authorized: false });
    const response = await handle(
      new Request("http://127.0.0.1:52600/api/agent-messages", { method: "GET" }),
    );
    expect(response?.status).toBe(401);
  });

  it("leaves every other path and method to the next handler", async () => {
    const { handle } = handler();
    expect(
      await handle(new Request("http://127.0.0.1:52600/api/agents", { method: "GET" })),
    ).toBeUndefined();
    expect(
      (await handle(new Request("http://127.0.0.1:52600/api/agent-messages", { method: "DELETE" })))
        ?.status,
    ).toBe(405);
  });
});
