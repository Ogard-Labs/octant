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

function handler(options: { readonly authorized: boolean } = { authorized: true }) {
  const projection = new AgentMessageProjection();
  projection.apply(sent as never);
  return {
    handle: createAgentMessageRouteHandler({
      windowAuthorityStore: {
        authenticate: (capability: string) => {
          if (!options.authorized || capability === "") throw new Error("unauthorized");
          return "00000000-0000-4000-8000-000000000001" as never;
        },
      } as never,
      projection,
    }),
    projection,
  };
}

describe("the agent message facts route", () => {
  it("serves the messaging facts with no bodies for an authenticated window", async () => {
    const { handle } = handler();
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
