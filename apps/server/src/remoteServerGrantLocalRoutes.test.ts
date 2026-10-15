import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeRemoteServerGrantResult, decodeWindowId, type WindowId } from "@octant/contracts";
import { decideRemoteServerGrant } from "@octant/domain";
import { bindPrincipalRouteContext } from "./principalRouteContext";
import { createRemoteServerGrantLocalRouteHandler } from "./remoteServerGrantLocalRoutes";
import type { RemoteServerGrantOpenInput } from "./remote/remoteServerGrantService";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";

const windowId = decodeWindowId("11111111-1111-4111-8111-111111111111");
const body = JSON.stringify({
  kind: "open-remote-server-grant",
  requestId: randomUUID(),
  source: { surface: "running-services", listenerId: `lsn_${"0".repeat(32)}` },
});

function store(): WindowAuthorityStore {
  return {
    authenticate: (capability: string): WindowId => {
      if (capability !== "capability") throw new WindowAuthorityError("unauthorized", "No window.");
      return windowId;
    },
  } as unknown as WindowAuthorityStore;
}

function setup() {
  const asked: Array<Pick<RemoteServerGrantOpenInput, "principal" | "scopeId">> = [];
  const handler = createRemoteServerGrantLocalRouteHandler({
    windowAuthorityStore: store(),
    grants: {
      open: async (input) => {
        asked.push({ principal: input.principal, scopeId: input.scopeId });
        const decision = decideRemoteServerGrant({
          actor: "local-user",
          listener: { status: "not-listed" },
        });
        return {
          kind: "answered",
          result: decodeRemoteServerGrantResult({
            kind: "remote-server-grant-refused",
            requestId: input.request.requestId,
            refusal: {
              reason: decision.kind === "refuse" ? decision.refusal.reason : "not-found",
              message: "Refused.",
            },
          }),
        };
      },
    },
  });
  return { handler, asked };
}

function post(headers: Record<string, string> = {}): Request {
  return new Request("http://127.0.0.1/api/server-proxy/grants", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

describe("grant route on the loopback listener", () => {
  it("answers a local window with the local-principal refusal", async () => {
    const { handler, asked } = setup();
    const response = await handler(post({ "x-octant-window-capability": "capability" }));
    expect(response?.status).toBe(200);
    const result = decodeRemoteServerGrantResult(await response?.json());
    expect(result.kind === "remote-server-grant-refused" && result.refusal.reason).toBe(
      "local-principal",
    );
    expect(asked).toEqual([{ principal: { kind: "local-window" }, scopeId: windowId }]);
  });

  it("refuses an unauthenticated caller before asking for a grant", async () => {
    const { handler, asked } = setup();
    expect((await handler(post()))?.status).toBe(401);
    expect(asked).toEqual([]);
  });

  it("refuses a request bound to a paired device", async () => {
    const { handler, asked } = setup();
    const request = post({ "x-octant-window-capability": "capability" });
    bindPrincipalRouteContext(request, {
      principal: {
        kind: "remote-device",
        deviceId: "22222222-2222-4222-8222-222222222222",
      } as never,
      scopeId: windowId,
    });
    expect((await handler(request))?.status).toBe(403);
    expect(asked).toEqual([]);
  });

  it("leaves every other path alone", async () => {
    const { handler } = setup();
    expect(await handler(new Request("http://127.0.0.1/api/server-proxy/other"))).toBeUndefined();
  });
});
