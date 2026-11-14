import { defaultShellSettings } from "@octant/domain/shell-policy";
import { describe, expect, it, vi } from "vitest";
import { classifyProductAction } from "./authenticatedProductRoutes";
import { bindPrincipalRouteContext } from "./principalRouteContext";
import { createRemoteRoutePolicy } from "./remoteRoutePolicy";
import { ShellServiceError } from "./shellService";
import { createShellSettingsRouteHandler } from "./shellSettingsRoutes";

const deviceId = "55000000-0000-4000-8000-000000000001";
const settings = { ...defaultShellSettings(), replyDetail: "medium" as const };

function setup(failure?: ConstructorParameters<typeof ShellServiceError>[0]) {
  const service = {
    readSettings: vi.fn(() => ({ settings, version: 4 as never })),
    replaceSettings: vi.fn((input: { readonly settings: typeof settings }) => {
      if (failure !== undefined) throw new ShellServiceError(failure);
      return { kind: "settings-replaced" as const, settings: input.settings, version: 5 as never };
    }),
  };
  return { service, handle: createShellSettingsRouteHandler(service as never) };
}

function deviceRequest(
  admittedBy: "host-person" | "hub-roster" | undefined,
  init: RequestInit = {},
  path = "/api/shell/settings",
): Request {
  const request = new Request(`http://127.0.0.1${path}`, init);
  bindPrincipalRouteContext(request, {
    principal: {
      kind: "remote-device",
      hostId: "11111111-1111-4111-8111-111111111111",
      deviceId,
      credentialGeneration: 1,
      origin: "https://remote.example",
      protocolVersion: 1,
      capabilityDigest: "a".repeat(64),
      sessionId: "55000000-0000-4000-8000-0000000000aa",
      ...(admittedBy === undefined ? {} : { admittedBy }),
    } as never,
    scopeId: deviceId as never,
  });
  return request;
}

const replacement = (level: "low" | "high") =>
  ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      expectedVersion: 4,
      settings: {
        ...settings,
        threadReplyDetail: [{ mode: "code", threadId: "thread-1", level }],
      },
    }),
  }) satisfies RequestInit;

describe("shell settings from a paired device", () => {
  it("gives a device the host's own person paired the settings and the version to replace", async () => {
    const { handle } = setup();
    const response = await handle(deviceRequest("host-person"));
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({
      version: 4,
      settings: { replyDetail: "medium" },
    });
  });

  it("writes a thread's reply detail for such a device and hands the service the device as the actor", async () => {
    const { handle, service } = setup();
    const response = await handle(deviceRequest("host-person", replacement("high")));
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ kind: "settings-replaced", version: 5 });
    expect(service.replaceSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedVersion: 4,
        actor: { kind: "remote-device", actorId: deviceId, deviceId },
        settings: expect.objectContaining({
          threadReplyDetail: [{ mode: "code", threadId: "thread-1", level: "high" }],
        }),
      }),
    );
  });

  it("refuses a device the hub's roster introduced, an unproved pairing, and a caller with no device session", async () => {
    const { handle, service } = setup();
    for (const admittedBy of ["hub-roster", undefined] as const) {
      expect((await handle(deviceRequest(admittedBy)))?.status).toBe(403);
      expect((await handle(deviceRequest(admittedBy, replacement("high"))))?.status).toBe(403);
    }
    expect((await handle(new Request("http://127.0.0.1/api/shell/settings")))?.status).toBe(403);
    expect(service.readSettings).not.toHaveBeenCalled();
    expect(service.replaceSettings).not.toHaveBeenCalled();
  });

  it("lets a device the host's own person paired choose how long paired devices stay paired, and refuses a restricted device", async () => {
    const { handle, service } = setup();
    const lifetime = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 4,
        settings: { ...settings, pairedDeviceLifetime: "never" },
      }),
    } satisfies RequestInit;
    expect((await handle(deviceRequest("hub-roster", lifetime)))?.status).toBe(403);
    expect(service.replaceSettings).not.toHaveBeenCalled();
    const response = await handle(deviceRequest("host-person", lifetime));
    expect(response?.status).toBe(200);
    expect(service.replaceSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { kind: "remote-device", actorId: deviceId, deviceId },
        settings: expect.objectContaining({ pairedDeviceLifetime: "never" }),
      }),
    );
  });

  it("refuses a query, another method and a malformed replacement, and reports a stale version as a conflict", async () => {
    const { handle } = setup({
      category: "conflict",
      message: "Shell settings changed.",
      expectedVersion: 4 as never,
      actualVersion: 5 as never,
    });
    expect(
      (await handle(deviceRequest("host-person", {}, "/api/shell/settings?window=1")))?.status,
    ).toBe(400);
    expect((await handle(deviceRequest("host-person", { method: "DELETE" })))?.status).toBe(405);
    expect(
      (await handle(deviceRequest("host-person", { method: "POST", body: "{" })))?.status,
    ).toBe(400);
    expect((await handle(deviceRequest("host-person", replacement("low"))))?.status).toBe(409);
  });

  it("is forwarded by the private listener while a window's shell routes stay on the host, and is no catalogued remote action", () => {
    const origin = "https://octant.example:8443";
    const policy = createRemoteRoutePolicy({ origin });
    const inspect = (path: string, method: string) =>
      policy.inspect(
        new Request(`${origin}${path}`, {
          method,
          headers: {
            host: "octant.example:8443",
            origin,
            "sec-fetch-site": "same-origin",
            ...(method === "GET" ? {} : { "content-type": "application/json" }),
          },
        }),
      );
    expect(inspect("/api/shell/settings", "GET").kind).toBe("allow");
    expect(inspect("/api/shell/settings", "POST").kind).toBe("allow");
    for (const path of [
      "/api/shell/bootstrap",
      "/api/shell/commands",
      "/api/shell/launch-session",
      "/api/shell/local-session",
    ]) {
      expect(inspect(path, "POST").kind).not.toBe("allow");
    }
    // A restricted device session is held to the catalogue, which names no
    // action for this path, so the product dispatch refuses it before the route.
    expect(
      classifyProductAction(new Request(`${origin}/api/shell/settings`, { method: "POST" })),
    ).toBeUndefined();
  });
});
