import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WindowId } from "@octant/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeviceId, RemoteSessionId, StableHostId } from "@octant/contracts/remote-access";
import { AGENT_ACCESS_ORIGIN, createRemoteDevicePrincipal } from "./clientPrincipal";
import { createFolderBrowseRouteHandler } from "./folderBrowseRoutes";
import { bindPrincipalRouteContext } from "./principalRouteContext";
import { FolderBrowseService, FolderBrowseServiceError } from "./folderBrowseService";
import { WindowAuthorityStore } from "./windowAuthorityStore";

const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const otherCapability = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA";
const windowId = "80000000-0000-4000-8000-000000000021" as WindowId;
const otherWindowId = "80000000-0000-4000-8000-000000000022" as WindowId;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  const pending = cleanups.splice(0);
  await Promise.all(pending.map((fn) => fn()));
});

function names(body: { candidates?: ReadonlyArray<{ displayName: string }> }): string[] {
  return (body.candidates ?? []).map((candidate) => candidate.displayName);
}

describe("folder browse routes", () => {
  it("returns only folders matching the search term", async () => {
    const { handle } = await liveHarness();
    const unfiltered = await handle(browseRequest({ hostId: "local", mode: "work" }));
    expect(unfiltered?.status).toBe(200);
    expect(names((await unfiltered?.json()) as never).sort()).toEqual(["alpha", "beta"]);

    const filtered = await handle(browseRequest({ hostId: "local", mode: "work", search: "alp" }));
    expect(filtered?.status).toBe(200);
    expect(names((await filtered?.json()) as never)).toEqual(["alpha"]);
  });

  it("issues clickable ancestor candidates on nested browse", async () => {
    const { handle } = await liveHarness();
    const root = await handle(browseRequest({ hostId: "local", mode: "work" }));
    const listed = (await root?.json()) as {
      candidates: ReadonlyArray<{ candidateId: string; displayName: string }>;
    };
    const alpha = listed.candidates.find((candidate) => candidate.displayName === "alpha");
    expect(alpha).toBeDefined();
    if (alpha === undefined) return;

    const nested = await handle(
      browseRequest({
        hostId: "local",
        mode: "work",
        parentCandidateId: alpha.candidateId,
      }),
    );
    expect(nested?.status).toBe(200);
    const body = (await nested?.json()) as {
      breadcrumbs: ReadonlyArray<{ label: string; candidateId?: string }>;
    };
    expect(body.breadcrumbs[0]?.candidateId).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/i));
    expect(body.breadcrumbs.at(-1)?.candidateId).toBeUndefined();
  });

  it("refuses expired, foreign-window, and foreign-mode candidates", async () => {
    const { handle } = await liveHarness();
    const listedResponse = await handle(browseRequest({ hostId: "local", mode: "work" }));
    const listed = (await listedResponse?.json()) as {
      candidates: ReadonlyArray<{ candidateId: string; displayName: string }>;
    };
    const alpha = listed.candidates.find((candidate) => candidate.displayName === "alpha");
    expect(alpha).toBeDefined();
    if (alpha === undefined) return;

    const foreignWindow = await handle(
      browseRequest(
        { hostId: "local", mode: "work", parentCandidateId: alpha.candidateId },
        otherCapability,
      ),
    );
    expect(foreignWindow?.status).toBe(401);
    expect(await foreignWindow?.json()).toMatchObject({ category: "unauthorized" });

    const foreignMode = await handle(
      browseRequest({
        hostId: "local",
        mode: "code",
        parentCandidateId: alpha.candidateId,
      }),
    );
    expect(foreignMode?.status).toBe(400);
    expect(await foreignMode?.json()).toMatchObject({ category: "invalid" });

    const expired = await createFolderBrowseRouteHandler({
      service: {
        browse: vi.fn(async () => {
          throw new FolderBrowseServiceError({
            category: "not-found",
            message: "Parent folder candidate has expired or is invalid.",
          });
        }),
        select: vi.fn(),
      } as never,
      windowAuthorityStore: registeredStore(),
      now: () => 1,
    })(
      browseRequest({
        hostId: "local",
        mode: "work",
        parentCandidateId: alpha.candidateId,
      }),
    );
    expect(expired?.status).toBe(404);
    expect(await expired?.json()).toMatchObject({ category: "not-found" });
  });

  it("refuses unauthenticated and non-loopback browse requests", async () => {
    const { handle } = await liveHarness();
    const missing = await handle(
      new Request("http://127.0.0.1/api/folders/browse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hostId: "local", mode: "work" }),
      }),
    );
    expect(missing?.status).toBe(401);

    const foreignHost = await handle(
      new Request("http://192.168.1.5/api/folders/browse", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify({ hostId: "local", mode: "work" }),
      }),
    );
    expect(foreignHost?.status).toBe(400);
  });

  it("lets a device the host's own person paired browse that computer's folders, as that device", async () => {
    const { handle, issued } = await liveHarness();
    const response = await handle(
      fromDevice({ hostId: "local", mode: "code" }, { admittedBy: "host-person" }),
    );
    expect(response?.status).toBe(200);
    const listed = (await response?.json()) as {
      candidates: ReadonlyArray<{ candidateId: string; displayName: string }>;
    };
    expect(names(listed).sort()).toEqual(["alpha", "beta"]);
    const alpha = listed.candidates.find((candidate) => candidate.displayName === "alpha");
    if (alpha === undefined) throw new Error("No alpha candidate.");
    const selection = { hostId: "local", mode: "code", candidateId: alpha.candidateId };
    // A candidate the device was given is not a window's to choose.
    const fromWindow = await handle(
      new Request("http://127.0.0.1/api/folders/select", {
        method: "POST",
        headers: { "content-type": "application/json", "x-octant-window-capability": capability },
        body: JSON.stringify(selection),
      }),
    );
    expect(fromWindow?.status).not.toBe(200);
    const chosen = await handle(
      fromDevice(selection, { admittedBy: "host-person" }, "/api/folders/select"),
    );
    expect(chosen?.status).toBe(200);
    // The receipt chosen from it belongs to the device's own scope.
    expect(issued.at(-1)?.windowId).toBe(deviceScope);
  });

  it("refuses a hub-introduced device and an agent grant", async () => {
    const { handle } = await liveHarness();
    for (const principal of [
      { admittedBy: "hub-roster" as const },
      { admittedBy: "host-person" as const, origin: AGENT_ACCESS_ORIGIN },
    ]) {
      const response = await handle(fromDevice({ hostId: "local", mode: "code" }, principal));
      expect(response?.status).toBe(403);
    }
  });
});

const deviceScope = "22222222-2222-4222-8222-222222222222";

function fromDevice(
  body: unknown,
  input: { readonly admittedBy: "host-person" | "hub-roster"; readonly origin?: string },
  path = "/api/folders/browse",
): Request {
  const request = new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  bindPrincipalRouteContext(request, {
    principal: createRemoteDevicePrincipal({
      hostId: "11111111-1111-4111-8111-111111111111" as StableHostId,
      deviceId: deviceScope as DeviceId,
      credentialGeneration: 1,
      origin: input.origin ?? "https://octant.example",
      protocolVersion: 1,
      capabilityDigest: "b".repeat(64),
      sessionId: "33333333-3333-4333-8333-333333333333" as RemoteSessionId,
      admittedBy: input.admittedBy,
    }),
    scopeId: deviceScope as WindowId,
  });
  return request;
}

async function liveHarness() {
  const home = await mkdtemp(join(tmpdir(), "octant-folder-routes-"));
  cleanups.push(async () => {
    await rm(home, { recursive: true, force: true });
  });
  await mkdir(join(home, "alpha"));
  await mkdir(join(home, "beta"));
  const issued: Array<{ readonly windowId: string }> = [];
  const service = new FolderBrowseService({
    bindingReceiptStore: {
      issue: (input) => {
        issued.push({ windowId: String(input.windowId) });
        return {
          receiptId: `receipt-${input.now}` as never,
          projectType: input.projectType,
          expiresAt: input.now + 60_000,
        };
      },
    },
    projectRootPort: {
      validate: async (_type, candidate) => ({ canonicalRoot: candidate }),
    },
    homeDir: home,
    now: () => 1_000,
    clock: () => "2026-07-24T12:00:00.000Z",
  });
  const handle = createFolderBrowseRouteHandler({
    service,
    windowAuthorityStore: registeredStore(),
    now: () => 1,
  });
  return { handle, issued };
}

function registeredStore(): WindowAuthorityStore {
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: 0 });
  store.register({ windowId: otherWindowId, capability: otherCapability, now: 0 });
  return store;
}

function browseRequest(body: unknown, token = capability): Request {
  return new Request("http://127.0.0.1/api/folders/browse", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-octant-window-capability": token,
    },
    body: JSON.stringify(body),
  });
}
