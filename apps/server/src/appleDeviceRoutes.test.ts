import type { DeviceId, RemoteSessionId, StableHostId } from "@octant/contracts/remote-access";
import type { AppleDeviceRequest } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import type { AppleDeviceExecutionContext } from "./apple/appleDeviceService";
import { createAppleDeviceRouteHandler } from "./appleDeviceRoutes";
import { createRemoteDevicePrincipal } from "./clientPrincipal";
import { bindPrincipalRouteContext } from "./principalRouteContext";
import { WindowAuthorityStore } from "./windowAuthorityStore";

const capability = `${"D".repeat(42)}A`;
const windowId = "50000000-0000-4000-8000-000000000001";
const remotePrincipal = createRemoteDevicePrincipal({
  hostId: "11111111-1111-4111-8111-111111111111" as StableHostId,
  deviceId: "22222222-2222-4222-8222-222222222222" as DeviceId,
  credentialGeneration: 1,
  origin: "https://octant.example",
  protocolVersion: 1,
  capabilityDigest: "b".repeat(64),
  sessionId: "33333333-3333-4333-8333-333333333333" as RemoteSessionId,
});
const person = { kind: "local-user", actorId: "50000000-0000-4000-8000-000000000010" };
const remotePerson = {
  kind: "remote-device",
  actorId: "50000000-0000-4000-8000-000000000010",
  deviceId: "22222222-2222-4222-8222-222222222222",
};
const deviceId = "50000000-0000-4000-8000-000000000009";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const uploadBuild = {
  bundleIdentifier: "sh.octant.SimulatorFixture",
  version: "1.0",
  buildNumber: "3",
  signing: { teamId: "A1B2C3D4E5", identity: "3".repeat(40) },
  profileId: "50000000-0000-4000-8000-000000000090",
};

const preparedVersion = {
  bundleIdentifier: "app.octant.simulatorfixture",
  version: "1.0",
  buildNumber: "1",
  platform: "ios",
};

function body(kind: AppleDeviceRequest["kind"], requestedBy: unknown = person) {
  return {
    actionId: "50000000-0000-4000-8000-000000000002",
    correlationId: "50000000-0000-4000-8000-000000000003",
    authority: {
      hostId: "50000000-0000-4000-8000-000000000004",
      mode: "code",
      projectId: "50000000-0000-4000-8000-000000000005",
      providerInstanceId: "50000000-0000-4000-8000-000000000006",
      extension: { kind: "core" },
    },
    threadId: "50000000-0000-4000-8000-000000000007",
    checkoutId: "50000000-0000-4000-8000-000000000008",
    kind,
    requestedBy,
    ...(kind === "discover" ||
    kind === "upload" ||
    kind === "submit-for-review" ||
    kind === "release-version"
      ? {}
      : { deviceId }),
    ...(kind === "submit-for-review" || kind === "release-version"
      ? { storeVersion: preparedVersion }
      : {}),
    ...(kind === "upload"
      ? {
          projectPath: "SimulatorFixture.xcodeproj",
          teamId: "A1B2C3D4E5",
          upload: uploadBuild,
        }
      : {}),
    ...(kind === "build" || kind === "run"
      ? { projectPath: "SimulatorFixture.xcodeproj", teamId: "A1B2C3D4E5" }
      : {}),
    ...(kind === "install" ? { artifact: "apple-device-product-1" } : {}),
    ...(kind === "launch" || kind === "terminate" || kind === "logs" || kind === "uninstall"
      ? { bundleIdentifier: "sh.octant.SimulatorFixture" }
      : {}),
    timeoutMs: 30_000,
    approval: { kind: "not-required" },
  };
}

function post(path: string, payload: unknown, remote = false) {
  const request = new Request(`http://127.0.0.1:13773${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(remote ? {} : { "x-octant-window-capability": capability }),
      origin: "http://127.0.0.1:5173",
    },
    body: JSON.stringify(payload),
  });
  if (remote) {
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
  const scope = (request: AppleDeviceRequest): AppleDeviceExecutionContext => ({
    authority: request.authority,
    threadId: request.threadId,
    checkoutId: request.checkoutId,
    checkoutRoot: "/checkout",
    executionPolicy: "approval-gated",
    approvalValid: false,
  });
  const resolveScope = vi.fn(async (_windowId: unknown, request: AppleDeviceRequest) =>
    scope(request),
  );
  const resolveThread = vi.fn(
    async (
      _windowId: unknown,
      request: Pick<AppleDeviceRequest, "authority" | "threadId" | "checkoutId">,
    ) => ({ threadId: request.threadId, checkoutId: request.checkoutId }),
  );
  const service = {
    readScreenshot: vi.fn(async (reference: string) =>
      reference === "apple-device-screenshot-1"
        ? { kind: "found" as const, bytes: PNG }
        : { kind: "not-found" as const },
    ),
    request: vi.fn(async (request: AppleDeviceRequest) =>
      request.kind === "discover"
        ? {
            kind: "apple-device-discovery" as const,
            discovery: {
              devices: [],
              tooling: [],
              leases: [],
              discoveredAt: "2026-10-26T12:00:00.000Z" as never,
            },
          }
        : { kind: "apple-device-refused" as const, reason: "confirmation-required" as const },
    ),
  };
  const prepareUpload = vi.fn(
    async () => ({ kind: "prepared" as const, upload: uploadBuild }) as never,
  );
  const prepareStoreVersion = vi.fn(
    async () =>
      ({
        kind: "prepared" as const,
        storeVersion: preparedVersion,
        ready: "submit-for-review" as const,
        state: "PREPARE_FOR_SUBMISSION",
      }) as never,
  );
  const handler = createAppleDeviceRouteHandler({
    windowAuthorityStore: store,
    service,
    resolveScope,
    resolveThread,
    prepareUpload,
    prepareStoreVersion,
    now: () => 2,
  });
  return { handler, service, resolveScope, resolveThread, prepareUpload, prepareStoreVersion };
}

describe("Apple device routes", () => {
  it("answers a local window's discovery through the device service", async () => {
    const { handler, service, resolveScope } = routes();
    const response = await handler(post("/api/apple/devices", body("discover")));
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toMatchObject({ kind: "apple-device-discovery" });
    expect(resolveScope).toHaveBeenCalledWith(
      windowId,
      expect.objectContaining({ kind: "discover" }),
      expect.objectContaining({ kind: "local-window" }),
    );
    expect(service.request).toHaveBeenCalledTimes(1);
  });

  it("takes a lease request only on the lease route and a read only on the device route", async () => {
    const { handler, service } = routes();
    expect((await handler(post("/api/apple/devices", body("use-device"))))?.status).toBe(400);
    expect((await handler(post("/api/apple/device-leases", body("status"))))?.status).toBe(400);
    expect((await handler(post("/api/apple/devices", body("install"))))?.status).toBe(400);
    expect(service.request).not.toHaveBeenCalled();
    expect((await handler(post("/api/apple/device-leases", body("use-device"))))?.status).toBe(200);
    expect(service.request).toHaveBeenCalledTimes(1);
  });

  it("refuses a request that names someone other than the person asking", async () => {
    const { handler, service } = routes();
    const agent = {
      kind: "agent",
      actorId: "50000000-0000-4000-8000-000000000010",
      providerInstanceId: "50000000-0000-4000-8000-000000000006",
      threadId: "50000000-0000-4000-8000-000000000007",
    };
    for (const requestedBy of [agent, remotePerson]) {
      const response = await handler(post("/api/apple/devices", body("discover", requestedBy)));
      expect(response?.status).toBe(403);
    }
    const remote = await handler(post("/api/apple/devices", body("discover", person), true));
    expect(remote?.status).toBe(403);
    expect(service.request).not.toHaveBeenCalled();
  });

  it("lets a paired device read devices but never start or release a lease", async () => {
    const { handler, service } = routes();
    const read = await handler(post("/api/apple/devices", body("discover", remotePerson), true));
    expect(read?.status).toBe(200);
    for (const kind of ["use-device", "release-device"] as const) {
      const response = await handler(
        post("/api/apple/device-leases", body(kind, remotePerson), true),
      );
      expect(response?.status).toBe(403);
    }
    expect(service.request).toHaveBeenCalledTimes(1);
  });

  const actionKinds = [
    "build",
    "run",
    "install",
    "launch",
    "terminate",
    "logs",
    "screenshot",
  ] as const;

  it("takes the app's build, install, launch, stop, console read, and a screenshot only on the local action route", async () => {
    const { handler, service } = routes();
    for (const kind of actionKinds) {
      expect((await handler(post("/api/apple/devices", body(kind))))?.status).toBe(400);
      expect((await handler(post("/api/apple/device-leases", body(kind))))?.status).toBe(400);
    }
    for (const kind of ["discover", "use-device", "uninstall", "provisioning-update"] as const) {
      expect((await handler(post("/api/apple/device-actions", body(kind))))?.status).toBe(400);
    }
    expect(service.request).not.toHaveBeenCalled();
    for (const kind of actionKinds) {
      expect((await handler(post("/api/apple/device-actions", body(kind))))?.status).toBe(200);
    }
    expect(service.request).toHaveBeenCalledTimes(actionKinds.length);
  });

  it("lets a paired device start nothing on a device, not even a console read or a screenshot", async () => {
    const { handler, service, resolveScope } = routes();
    for (const kind of actionKinds) {
      for (const requestedBy of [remotePerson, person]) {
        const response = await handler(
          post("/api/apple/device-actions", body(kind, requestedBy), true),
        );
        expect(response?.status).toBe(403);
      }
    }
    expect(resolveScope).not.toHaveBeenCalled();
    expect(service.request).not.toHaveBeenCalled();
  });

  it("takes an upload only on the local distribution route, and from no paired device", async () => {
    const { handler, service, resolveScope } = routes();
    for (const path of [
      "/api/apple/devices",
      "/api/apple/device-leases",
      "/api/apple/device-actions",
    ]) {
      expect((await handler(post(path, body("upload"))))?.status).toBe(400);
    }
    for (const kind of ["build", "use-device"] as const) {
      expect((await handler(post("/api/apple/distribution", body(kind))))?.status).toBe(400);
    }
    for (const requestedBy of [remotePerson, person]) {
      expect(
        (await handler(post("/api/apple/distribution", body("upload", requestedBy), true)))?.status,
      ).toBe(403);
    }
    expect(resolveScope).not.toHaveBeenCalled();
    expect(service.request).not.toHaveBeenCalled();
    expect((await handler(post("/api/apple/distribution", body("upload"))))?.status).toBe(200);
    expect(service.request).toHaveBeenCalledTimes(1);
  });

  it("reads what an upload would send for a local window only", async () => {
    const { handler, prepareUpload } = routes();
    const {
      kind: _kind,
      requestedBy: _requestedBy,
      deviceId: _deviceId,
      actionId: _a,
      correlationId: _c,
      timeoutMs: _t,
      approval: _p,
      ...scope
    } = body("status");
    const read = {
      kind: "apple-upload-preparation",
      ...scope,
      projectPath: "SimulatorFixture.xcodeproj",
      teamId: "A1B2C3D4E5",
    };
    expect((await handler(post("/api/apple/distribution-preparations", read, true)))?.status).toBe(
      403,
    );
    expect(prepareUpload).not.toHaveBeenCalled();
    expect(
      (
        await handler(
          post("/api/apple/distribution-preparations", {
            ...read,
            scheme: "-allowProvisioningUpdates",
          }),
        )
      )?.status,
    ).toBe(400);
    const answer = await handler(post("/api/apple/distribution-preparations", read));
    expect(answer?.status).toBe(200);
    await expect(answer?.json()).resolves.toEqual({ kind: "prepared", upload: uploadBuild });
  });

  it("takes a submission or release only on the local distribution route, and from no paired device", async () => {
    for (const kind of ["submit-for-review", "release-version"] as const) {
      const { handler, service, resolveScope } = routes();
      for (const path of [
        "/api/apple/devices",
        "/api/apple/device-leases",
        "/api/apple/device-actions",
      ]) {
        expect((await handler(post(path, body(kind))))?.status).toBe(400);
      }
      for (const requestedBy of [remotePerson, person]) {
        expect(
          (await handler(post("/api/apple/distribution", body(kind, requestedBy), true)))?.status,
        ).toBe(403);
      }
      expect(resolveScope).not.toHaveBeenCalled();
      expect(service.request).not.toHaveBeenCalled();
      expect((await handler(post("/api/apple/distribution", body(kind))))?.status).toBe(200);
      expect(service.request).toHaveBeenCalledTimes(1);
    }
  });

  it("reads what App Store Connect holds for the project's version for a local window only", async () => {
    const { handler, prepareStoreVersion } = routes();
    const {
      kind: _kind,
      requestedBy: _requestedBy,
      deviceId: _deviceId,
      actionId: _a,
      correlationId: _c,
      timeoutMs: _t,
      approval: _p,
      ...scope
    } = body("status");
    const read = {
      kind: "apple-store-version-preparation",
      ...scope,
      projectPath: "SimulatorFixture.xcodeproj",
    };
    expect((await handler(post("/api/apple/distribution-versions", read, true)))?.status).toBe(403);
    expect(prepareStoreVersion).not.toHaveBeenCalled();
    const answer = await handler(post("/api/apple/distribution-versions", read));
    expect(answer?.status).toBe(200);
    await expect(answer?.json()).resolves.toMatchObject({
      kind: "prepared",
      storeVersion: preparedVersion,
      ready: "submit-for-review",
    });
  });

  const screenshotRead = (reference = "apple-device-screenshot-1") => {
    const {
      kind: _kind,
      requestedBy: _requestedBy,
      deviceId: _deviceId,
      ...scope
    } = body("status");
    const { actionId: _a, correlationId: _c, timeoutMs: _t, approval: _p, ...thread } = scope;
    return { kind: "apple-artifact-request", ...thread, reference };
  };

  it("hands a local window the pixels of its thread's latest device screenshot", async () => {
    const { handler, service, resolveThread } = routes();
    const response = await handler(post("/api/apple/device-screenshots", screenshotRead()));
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toBe("image/png");
    expect(response?.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array((await response?.arrayBuffer()) ?? new ArrayBuffer(0))).toEqual(PNG);
    expect(resolveThread).toHaveBeenCalledWith(
      windowId,
      expect.objectContaining({ threadId: "50000000-0000-4000-8000-000000000007" }),
      expect.objectContaining({ kind: "local-window" }),
    );
    expect(service.readScreenshot).toHaveBeenCalledWith(
      "apple-device-screenshot-1",
      expect.objectContaining({ threadId: "50000000-0000-4000-8000-000000000007" }),
    );
    // A reference the thread does not hold reads as nothing at all.
    const other = await handler(
      post("/api/apple/device-screenshots", screenshotRead("apple-device-screenshot-2")),
    );
    expect(other?.status).toBe(404);
    expect(other?.headers.get("content-type")).not.toBe("image/png");
  });

  it("never hands a device screenshot to a paired device or a window outside the thread", async () => {
    const { handler, service, resolveThread } = routes();
    const remote = await handler(post("/api/apple/device-screenshots", screenshotRead(), true));
    expect(remote?.status).toBe(403);
    expect(resolveThread).not.toHaveBeenCalled();
    resolveThread.mockResolvedValueOnce(undefined as never);
    const outside = await handler(post("/api/apple/device-screenshots", screenshotRead()));
    expect(outside?.status).toBe(403);
    // A device request is not a screenshot read, and the read takes nothing else.
    expect((await handler(post("/api/apple/device-screenshots", body("screenshot"))))?.status).toBe(
      400,
    );
    expect(service.readScreenshot).not.toHaveBeenCalled();
  });

  it("refuses a window that cannot reach the thread", async () => {
    const { handler, service, resolveScope } = routes();
    resolveScope.mockResolvedValueOnce(undefined as never);
    expect((await handler(post("/api/apple/devices", body("discover"))))?.status).toBe(403);
    expect(
      (
        await handler(
          new Request("http://127.0.0.1:13773/api/apple/devices", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body("discover")),
          }),
        )
      )?.status,
    ).toBe(401);
    expect(service.request).not.toHaveBeenCalled();
  });
});
