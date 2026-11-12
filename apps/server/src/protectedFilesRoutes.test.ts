import { decodeWindowId } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { bindPrincipalRouteContext } from "./principalRouteContext";
import {
  PROTECTED_FILES_COMMAND_PATH,
  PROTECTED_FILES_PATH,
  createProtectedFilesRouteHandler,
} from "./protectedFilesRoutes";
import { WindowAuthorityStore } from "./windowAuthorityStore";

const windowId = decodeWindowId("74000000-0000-4000-8000-000000000001");
const capability = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop4";

function route() {
  const windowAuthorityStore = new WindowAuthorityStore();
  windowAuthorityStore.register({ windowId, capability, now: 0 });
  const change = vi.fn(() => ({ kind: "protected-files-settings" as const, settings: {} }));
  const settings = vi.fn(() => ({ kind: "protected-files-settings" as const }));
  const handler = createProtectedFilesRouteHandler({
    service: { change, settings } as never,
    windowAuthorityStore,
    now: () => 0,
  });
  return { handler, change, settings };
}

function request(path: string, method: string, body?: unknown, withCapability = true): Request {
  return new Request(`http://127.0.0.1:3100${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(withCapability ? { "x-octant-window-capability": capability } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const add = { kind: "add-protected-path", path: "~/secrets", expectedVersion: 0 };

describe("protected files routes", () => {
  it("reads the list for a window and changes it from a window on this host", async () => {
    const { handler, change, settings } = route();
    expect((await handler(request(PROTECTED_FILES_PATH, "GET")))?.status).toBe(200);
    expect(settings).toHaveBeenCalledOnce();
    expect((await handler(request(PROTECTED_FILES_COMMAND_PATH, "POST", add)))?.status).toBe(200);
    expect(change).toHaveBeenCalledWith(add);
  });

  it("refuses a caller without the window's capability", async () => {
    const { handler, change } = route();
    const response = await handler(request(PROTECTED_FILES_COMMAND_PATH, "POST", add, false));
    expect(response?.status).toBe(401);
    expect(change).not.toHaveBeenCalled();
  });

  it("changes the list from a device the host's own person paired, journaled as that device, and refuses a hub-introduced device and an unproved pairing", async () => {
    const { handler, change } = route();
    const deviceId = "74000000-0000-4000-8000-0000000000de";
    const fromDevice = (admittedBy?: "host-person" | "hub-roster") => {
      const remote = request(PROTECTED_FILES_COMMAND_PATH, "POST", add, false);
      bindPrincipalRouteContext(remote, {
        principal: {
          kind: "remote-device",
          deviceId,
          ...(admittedBy === undefined ? {} : { admittedBy }),
        } as never,
        scopeId: decodeWindowId(deviceId),
      });
      return remote;
    };
    for (const restricted of [undefined, "hub-roster"] as const) {
      const response = await handler(fromDevice(restricted));
      expect(response?.status).toBe(403);
      expect(await response?.json()).toMatchObject({ reason: "unauthorized" });
    }
    expect(change).not.toHaveBeenCalled();

    expect((await handler(fromDevice("host-person")))?.status).toBe(200);
    expect(change).toHaveBeenCalledWith(add, {
      kind: "remote-device",
      actorId: deviceId,
      deviceId,
    });
  });

  it("refuses removing a built-in group that was not confirmed", async () => {
    const { handler, change } = route();
    const response = await handler(
      request(PROTECTED_FILES_COMMAND_PATH, "POST", {
        kind: "remove-built-in-protected-files",
        id: "ssh-private-keys",
        expectedVersion: 0,
      }),
    );
    expect(response?.status).toBe(400);
    expect(change).not.toHaveBeenCalled();
  });
});
