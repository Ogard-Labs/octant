import { expect, it, vi } from "vitest";
import { decodeWindowId } from "@octant/contracts";
import { createFileMentionRouteHandler } from "./fileMentionRoutes";
import { WindowAuthorityStore } from "./windowAuthorityStore";
import { bindPrincipalRouteContext } from "./principalRouteContext";

it("refuses a paired client folder path before invoking filesystem authority", async () => {
  const store = new WindowAuthorityStore();
  const windowId = decodeWindowId("00000000-0000-4000-8000-000000000901");
  const execute = vi.fn();
  const request = new Request("http://127.0.0.1/api/file-mentions/commands", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "inspect-folder-mentions",
      requestId: "00000000-0000-4000-8000-000000000001",
      scope: { mode: "work", threadId: "00000000-0000-4000-8000-000000000002" },
      paths: ["/client/private"],
    }),
  });
  bindPrincipalRouteContext(request, {
    scopeId: windowId,
    principal: { kind: "remote-device", deviceId: "fixture" } as never,
  });
  const route = createFileMentionRouteHandler({
    service: { execute },
    windowAuthorityStore: store,
    now: () => 1,
  });
  const response = await route(request);
  expect(response?.status).toBe(403);
  expect(execute).not.toHaveBeenCalled();
});

it("requires a live local window capability before inspecting folders", async () => {
  const store = new WindowAuthorityStore();
  const windowId = decodeWindowId("00000000-0000-4000-8000-000000000901");
  const capability = "A".repeat(43);
  store.register({ windowId, capability, now: 0 });
  const execute = vi.fn(async () => ({
    kind: "folder-mentions-inspected" as const,
    requestId: "00000000-0000-4000-8000-000000000001" as never,
    folders: [],
    unavailable: [],
  }));
  const route = createFileMentionRouteHandler({
    service: { execute },
    windowAuthorityStore: store,
    now: () => 1,
  });
  const request = (credential?: string) =>
    new Request("http://127.0.0.1/api/file-mentions/commands", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(credential === undefined ? {} : { "x-octant-window-capability": credential }),
      },
      body: JSON.stringify({ kind: "inspect-folder-mentions" }),
    });
  expect((await route(request()))?.status).toBe(401);
  expect(execute).not.toHaveBeenCalled();
  expect((await route(request(capability)))?.status).toBe(200);
  expect(execute).toHaveBeenCalledWith(
    { kind: "inspect-folder-mentions" },
    { windowId, localHost: true },
  );
});
