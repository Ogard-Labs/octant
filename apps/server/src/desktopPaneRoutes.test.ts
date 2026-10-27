import type { DeviceId, RemoteSessionId, StableHostId } from "@octant/contracts/remote-access";
import { decodeDesktopViewId } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { createRemoteDevicePrincipal } from "./clientPrincipal";
import type { DesktopLeaseService } from "./computerUse/desktopLeaseService";
import { createDesktopPaneRouteHandler } from "./desktopPaneRoutes";
import { bindPrincipalRouteContext } from "./principalRouteContext";
import { WindowAuthorityStore } from "./windowAuthorityStore";

const capability = `${"D".repeat(42)}A`;
const windowId = "60000000-0000-4000-8000-000000000001";
const threadId = "60000000-0000-4000-8000-000000000002";
const leaseId = "60000000-0000-4000-8000-000000000003";
const viewId = "60000000-0000-4000-8000-000000000004";
const localActorId = "60000000-0000-4000-8000-000000000005";
const deviceId = "22222222-2222-4222-8222-222222222222";
const remotePrincipal = createRemoteDevicePrincipal({
  hostId: "11111111-1111-4111-8111-111111111111" as StableHostId,
  deviceId: deviceId as DeviceId,
  credentialGeneration: 1,
  origin: "https://octant.example",
  protocolVersion: 1,
  capabilityDigest: "b".repeat(64),
  sessionId: "33333333-3333-4333-8333-333333333333" as RemoteSessionId,
});
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

function post(
  path: string,
  payload: unknown,
  options: { remote?: boolean; capability?: string } = {},
) {
  const request = new Request(`http://127.0.0.1:13773${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.remote === true
        ? {}
        : { "x-octant-window-capability": options.capability ?? capability }),
      origin: "http://127.0.0.1:5173",
    },
    body: JSON.stringify(payload),
  });
  if (options.remote === true) {
    bindPrincipalRouteContext(request, {
      principal: remotePrincipal,
      scopeId: remotePrincipal.deviceId as never,
    });
  }
  return request;
}

function routes() {
  const store = new WindowAuthorityStore();
  store.register({ windowId: windowId as never, capability, now: 1 });
  const service = {
    overview: vi.fn<DesktopLeaseService["overview"]>(async () => ({
      status: "overview",
      leases: [],
      providers: [],
      start: { status: "refused", reason: "no-provider-configured" },
    })),
    acquire: vi.fn<DesktopLeaseService["acquire"]>(async () => ({
      status: "refused",
      reason: "no-provider-configured",
    })),
    release: vi.fn<DesktopLeaseService["release"]>(async () => ({
      status: "refused",
      reason: "lease-ended",
    })),
    retryRelease: vi.fn<DesktopLeaseService["retryRelease"]>(async () => ({
      status: "refused",
      reason: "lease-ended",
    })),
    extend: vi.fn<DesktopLeaseService["extend"]>(async () => ({
      status: "refused",
      reason: "lease-ended",
    })),
    openView: vi.fn<DesktopLeaseService["openView"]>(async () => ({
      status: "viewing",
      viewId: decodeDesktopViewId(viewId),
    })),
    closeView: vi.fn<DesktopLeaseService["closeView"]>(async () => ({ status: "view-closed" })),
    frame: vi.fn<DesktopLeaseService["frame"]>(async () => ({
      status: "frame",
      frame: { mediaType: "image/png", width: 1, height: 1, bytes: png },
    })),
    input: vi.fn<DesktopLeaseService["input"]>(async () => ({ status: "delivered" })),
  };
  const handler = createDesktopPaneRouteHandler({
    windowAuthorityStore: store,
    service,
    localActorId,
    now: () => 2,
  });
  return { handler, service };
}

describe("Desktop pane routes", () => {
  it("answers a local window as the person at this machine and a paired device as that device's person", async () => {
    const { handler, service } = routes();
    const local = await handler(post("/api/code/desktops", { kind: "overview", threadId }));
    expect(local?.status).toBe(200);
    await expect(local?.json()).resolves.toMatchObject({
      status: "overview",
      start: { status: "refused", reason: "no-provider-configured" },
    });
    const remote = await handler(
      post("/api/code/desktops", { kind: "overview", threadId }, { remote: true }),
    );
    expect(remote?.status).toBe(200);
    expect(service.overview.mock.calls.map(([caller]) => caller)).toEqual([
      {
        owner: { mode: "code", threadId },
        actor: { kind: "local-user", actorId: localActorId },
        scopeId: windowId,
      },
      {
        owner: { mode: "code", threadId },
        actor: { kind: "remote-device", actorId: deviceId, deviceId },
        scopeId: deviceId,
      },
    ]);
  });

  it("sends a person's input to the lease service as theirs, with the event they sent", async () => {
    const { handler, service } = routes();
    const event = { kind: "pointer", action: "down", button: "left", x: 3, y: 4 };
    const response = await handler(
      post(
        "/api/code/desktops",
        { kind: "input", threadId, leaseId, viewId, event },
        { remote: true },
      ),
    );
    await expect(response?.json()).resolves.toEqual({ status: "delivered" });
    expect(service.input).toHaveBeenCalledWith({
      owner: { mode: "code", threadId },
      actor: { kind: "remote-device", actorId: deviceId, deviceId },
      scopeId: deviceId,
      leaseId,
      viewId,
      event,
    });
  });

  it("refuses a request with no window capability, and one that names a window or an actor", async () => {
    const { handler, service } = routes();
    const unknownWindow = await handler(
      post(
        "/api/code/desktops",
        { kind: "overview", threadId },
        { capability: `${"E".repeat(42)}A` },
      ),
    );
    expect(unknownWindow?.status).toBe(401);
    const namesWindow = await handler(
      post("/api/code/desktops", { kind: "overview", threadId, windowId }),
    );
    expect(namesWindow?.status).toBe(400);
    const namesActor = await handler(
      post("/api/code/desktops", {
        kind: "acquire",
        threadId,
        actor: { kind: "agent", actorId: localActorId },
      }),
    );
    expect(namesActor?.status).toBe(400);
    expect(service.overview).not.toHaveBeenCalled();
    expect(service.acquire).not.toHaveBeenCalled();
  });

  it("answers a frame as the image it is, and a refused frame as an answer", async () => {
    const { handler, service } = routes();
    const shown = await handler(post("/api/code/desktops/frame", { threadId, leaseId, viewId }));
    expect(shown?.status).toBe(200);
    expect(shown?.headers.get("content-type")).toBe("image/png");
    expect(shown?.headers.get("cache-control")).toBe("no-store");
    expect(new Uint8Array(await (shown as Response).arrayBuffer())).toEqual(png);

    service.frame.mockResolvedValueOnce({ status: "refused", reason: "view-ended" });
    const ended = await handler(post("/api/code/desktops/frame", { threadId, leaseId, viewId }));
    expect(ended?.headers.get("content-type")).toContain("application/json");
    await expect(ended?.json()).resolves.toEqual({ status: "refused", reason: "view-ended" });
  });

  it("leaves every other path to the routes that own it", async () => {
    const { handler } = routes();
    await expect(handler(post("/api/code/board", {}))).resolves.toBeUndefined();
  });
});
