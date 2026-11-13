import type { DeviceId, RemoteSessionId, StableHostId } from "@octant/contracts/remote-access";
import {
  AGENT_GRANT_ROUTES,
  decodeWindowId,
  type AgentAccessCommand,
  type EventActor,
} from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { createRemoteDevicePrincipal } from "../clientPrincipal";
import { bindPrincipalRouteContext } from "../principalRouteContext";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { AGENT_ACCESS_ORIGIN } from "./agentAccessSession";
import { createAgentGrantRouteHandler, createAgentGrantRouteSlot } from "./agentGrantRoutes";

const capability = `${"G".repeat(42)}A`;
const windowId = decodeWindowId("61000000-0000-4000-8000-000000000001");
const deviceId = "61000000-0000-4000-8000-000000000002";
const grantId = "61000000-0000-4000-8000-000000000003";

function principal(origin: string) {
  return createRemoteDevicePrincipal({
    hostId: "61000000-0000-4000-8000-000000000004" as StableHostId,
    deviceId: deviceId as DeviceId,
    credentialGeneration: 1,
    origin,
    protocolVersion: 1,
    capabilityDigest: "c".repeat(64),
    sessionId: "61000000-0000-4000-8000-000000000005" as RemoteSessionId,
  });
}

function request(
  path: string,
  init: { method?: string; body?: unknown; from?: "window" | "phone" | "agent" } = {},
): Request {
  const from = init.from ?? "window";
  const made = new Request(`http://127.0.0.1:13773${path}`, {
    method: init.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(from === "window" ? { "x-octant-window-capability": capability } : {}),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  if (from !== "window") {
    bindPrincipalRouteContext(made, {
      principal: principal(from === "agent" ? AGENT_ACCESS_ORIGIN : "https://phone.example"),
      scopeId: decodeWindowId(deviceId),
    });
  }
  return made;
}

function routes() {
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: 0 });
  const executed: Array<{ command: AgentAccessCommand; actor: EventActor }> = [];
  const stopped: string[] = [];
  const handler = createAgentGrantRouteHandler({
    windowAuthorityStore: store,
    now: () => 0,
    stopRunningTurns: async (id) => {
      stopped.push(id);
    },
    service: {
      list: () => [],
      attributions: () => [
        { threadId: "t-1", grantId: grantId as never, agentName: "Home bot", mode: "code" },
      ],
      turnAttributions: () => [
        { threadId: "t-1", turnKey: "61000000-0000-4000-8000-0000000000aa", agentName: "Home bot" },
      ],
      execute: (command, actor) => {
        executed.push({ command, actor });
        return { kind: "done" };
      },
    },
  });
  return { handler, executed, stopped };
}

describe("agent grant routes", () => {
  it("names the threads each agent started for a local window and a paired phone", async () => {
    const { handler } = routes();
    for (const from of ["window", "phone"] as const) {
      const response = await handler(request(AGENT_GRANT_ROUTES.threads, { from }));
      expect(response?.status).toBe(200);
      expect(await response?.json()).toEqual({
        threads: [{ threadId: "t-1", grantId, agentName: "Home bot", mode: "code" }],
        turns: [
          {
            threadId: "t-1",
            turnKey: "61000000-0000-4000-8000-0000000000aa",
            agentName: "Home bot",
          },
        ],
      });
    }
  });

  it("lets a paired phone revoke a grant, journaled as that device, and stops its turns when asked", async () => {
    const { handler, executed, stopped } = routes();
    const response = await handler(
      request(AGENT_GRANT_ROUTES.revoke, {
        method: "POST",
        from: "phone",
        body: { grantId, stopRunningTurns: true },
      }),
    );
    expect(response?.status).toBe(200);
    expect(executed).toEqual([
      {
        command: { kind: "revoke", grantId, stopRunningTurns: true },
        actor: { kind: "remote-device", actorId: deviceId, deviceId },
      },
    ]);
    expect(stopped).toEqual([grantId]);
  });

  it("refuses an outside agent, even one that reached the route, and changes nothing", async () => {
    const { handler, executed } = routes();
    for (const [path, method] of [
      [AGENT_GRANT_ROUTES.grants, "GET"],
      [AGENT_GRANT_ROUTES.threads, "GET"],
      [AGENT_GRANT_ROUTES.revoke, "POST"],
    ] as const) {
      const response = await handler(
        request(path, {
          method,
          from: "agent",
          ...(method === "POST" ? { body: { grantId, stopRunningTurns: false } } : {}),
        }),
      );
      expect(response?.status).toBe(403);
    }
    expect(executed).toEqual([]);
  });

  it("refuses a caller with no window capability or bound device", async () => {
    const { handler } = routes();
    const response = await handler(
      new Request(`http://127.0.0.1:13773${AGENT_GRANT_ROUTES.grants}`),
    );
    expect(response?.status).toBe(401);
  });

  it("answers nothing until the remote wiring binds the handler", async () => {
    const slot = createAgentGrantRouteSlot();
    expect(await slot.routes(request(AGENT_GRANT_ROUTES.grants))).toBeUndefined();
    slot.bind(routes().handler);
    expect((await slot.routes(request(AGENT_GRANT_ROUTES.grants)))?.status).toBe(200);
  });
});
