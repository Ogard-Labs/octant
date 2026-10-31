import { describe, expect, it, vi } from "vitest";
import { createRemoteDevicePrincipal } from "./clientPrincipal";
import { bindPrincipalRouteContext } from "./principalRouteContext";
import { createTerminalSessionRouteHandler } from "./terminalSessionRoutes";
import { WindowAuthorityStore } from "./windowAuthorityStore";

const windowId = "10000000-0000-4000-8000-000000000001" as never;
const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const projectId = "10000000-0000-4000-8000-0000000000aa";

function fixture() {
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: Date.now() });
  const list = vi.fn(async () => [
    {
      provider: "claude" as const,
      sessionId: "0b4c1f2e-1111-4111-8111-111111111111" as never,
      title: "Upload test flake",
      updatedAt: "2026-10-30T09:00:00.000Z" as never,
    },
  ]);
  const handler = createTerminalSessionRouteHandler({
    windowAuthorityStore: store,
    imports: { list, history: () => undefined },
    readProject: () =>
      ({ type: "code", lifecycle: "active", binding: { canonicalRoot: "/repo" } }) as never,
  });
  return { handler, list };
}

function listRequest(): Request {
  return new Request("http://127.0.0.1/api/terminal-sessions/list", {
    method: "POST",
    headers: {
      origin: "null",
      "content-type": "application/json",
      "x-octant-window-capability": capability,
    },
    body: JSON.stringify({ projectId }),
  });
}

describe("terminal session routes", () => {
  it("lists the sessions in the Project's own folder for a local window", async () => {
    const { handler, list } = fixture();

    const response = await handler(listRequest());

    expect(response?.status).toBe(200);
    expect(list).toHaveBeenCalledWith("/repo");
    expect(await response?.json()).toMatchObject({
      sessions: [{ provider: "claude", title: "Upload test flake" }],
    });
  });

  it("refuses a paired device before reading any session", async () => {
    const { handler, list } = fixture();
    const request = listRequest();
    bindPrincipalRouteContext(request, {
      principal: createRemoteDevicePrincipal({
        hostId: "host-remote" as never,
        deviceId: "device-remote" as never,
        credentialGeneration: 1,
        origin: "http://127.0.0.1",
        protocolVersion: 1,
        capabilityDigest: "a".repeat(64),
        sessionId: "session-remote" as never,
      }),
      scopeId: "10000000-0000-4000-8000-000000000002" as never,
    });

    const response = await handler(request);

    expect(response?.status).toBe(403);
    expect(list).not.toHaveBeenCalled();
  });
});
