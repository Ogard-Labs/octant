import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeWindowId } from "@octant/contracts";
import { CredentialRequests } from "./credentialRequests";
import { createCredentialRequestRoutes } from "./credentialRequestRoutes";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { linearCredentialOperation } from "../plugins/linear/linearCredentialOperation";
import { bindPrincipalRouteContext } from "../principalRouteContext";
import { classifyProductAction } from "../authenticatedProductRoutes";

const services: CredentialRequests[] = [];
afterEach(() => {
  for (const service of services) service.close();
  services.length = 0;
});
function setup() {
  const store = new WindowAuthorityStore();
  const capability = randomBytes(32).toString("base64url");
  const windowId = decodeWindowId("00000000-0000-4000-8000-000000000001");
  store.register({ windowId, capability, now: Date.now() });
  const fetch = vi.fn(
    async (_request: Request) => new Response('{"data":{"viewer":{"id":"account"}}}'),
  );
  const service = new CredentialRequests({
    fetch,
    resolveLinked: async () => ({ status: "read", value: "fixture-linked-token" }),
  });
  services.push(service);
  const pending = service.request({
    windowId: String(windowId),
    threadId: "thread",
    operation: linearCredentialOperation,
    current: () => store.listWindowIds().includes(windowId),
    signal: new AbortController().signal,
  });
  const id = service.view(String(windowId), "thread").requests[0]?.id;
  const route = createCredentialRequestRoutes(service, store);
  const request = (body?: unknown, token = capability) =>
    new Request(
      `http://127.0.0.1/api/credential-requests${body === undefined ? "?threadId=thread" : ""}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers: { "x-octant-window-capability": token, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
  return { store, windowId, fetch, pending, id, route, request };
}
describe("credential request routes", () => {
  it("authenticates the card and accepts one private submission with no echoed value", async () => {
    const h = setup();
    expect((await h.route(h.request(undefined, "wrong")))?.status).toBe(401);
    expect(await (await h.route(h.request()))?.json()).toMatchObject({
      requests: [{ state: "pending", consumer: "Linear" }],
    });
    const answer = await h.route(h.request({ id: h.id, action: "allow", secret: "token-private" }));
    expect(await answer?.json()).toEqual({ status: "accepted" });
    expect(await h.pending).toEqual({ status: "used" });
    expect(h.fetch.mock.calls[0]?.[0].headers.get("authorization")).toBe("token-private");
    expect(h.fetch.mock.calls[0]?.[0].redirect).toBe("error");
  });
  it("rejects remote principals, arbitrary destinations and oversized submissions", async () => {
    const h = setup();
    const remote = h.request({ id: h.id, action: "allow", secret: "token" });
    bindPrincipalRouteContext(remote, {
      principal: { kind: "remote-device" } as never,
      scopeId: h.windowId,
    });
    expect((await h.route(remote))?.status).toBe(403);
    expect(classifyProductAction(remote)).toBeUndefined();
    expect(
      (
        await h.route(
          h.request({ id: h.id, action: "allow", secret: "token", url: "https://evil.test" }),
        )
      )?.status,
    ).toBe(400);
    expect(
      (await h.route(h.request({ id: h.id, action: "allow", secret: "x".repeat(9000) })))?.status,
    ).toBe(413);
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it("refuses an expired window without using the token", async () => {
    const h = setup();
    h.store.revoke(h.windowId);
    expect((await h.route(h.request({ id: h.id, action: "allow", secret: "token" })))?.status).toBe(
      401,
    );
    expect(h.fetch).not.toHaveBeenCalled();
  });
});

it("accepts a local linked-field submission without returning its resolved token", async () => {
  const h = setup();
  const answer = {
    id: h.id,
    action: "allow-linked",
    store: "onepassword",
    reference: "op://Private/Linear/credential",
  };
  expect((await h.route(h.request(answer, "wrong")))?.status).toBe(401);
  expect((await h.route(h.request({ ...answer, secret: "not-allowed" })))?.status).toBe(400);
  expect(await (await h.route(h.request(answer)))?.json()).toEqual({ status: "accepted" });
  expect(await h.pending).toEqual({ status: "used" });
  expect(h.fetch.mock.calls[0]?.[0].headers.get("authorization")).toBe("fixture-linked-token");
  expect(await (await h.route(h.request(answer)))?.json()).toEqual({ status: "refused" });
  expect(await (await h.route(h.request()))?.text()).not.toContain("fixture-linked-token");
});
