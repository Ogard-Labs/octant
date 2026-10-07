import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { decodeHostResourceSnapshot, decodeWindowId } from "@octant/contracts";
import { decodeStableHostId, DeviceId, RemoteSessionId } from "@octant/contracts/remote-access";
import { describe, expect, it, vi } from "vitest";
import { createRemoteDevicePrincipal } from "./clientPrincipal";
import { bindPrincipalRouteContext } from "./principalRouteContext";
import { WindowAuthorityStore } from "./windowAuthorityStore";
import {
  createHostResourceRouteHandler,
  readHostResourceSnapshot,
  snapshotRevealsOnlyLoad,
  type HostResourceRouteDependencies,
} from "./hostResourceRoutes";

const nowMs = new Date("2026-10-06T12:00:00.000Z").getTime();
const windowId = decodeWindowId("70000000-0000-4000-8000-000000000002");
const capability = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop0";
const thisHost = "33333333-3333-4333-8333-333333333333";
const otherHost = "44444444-4444-4444-8444-444444444444";
const deviceId = Schema.decodeUnknownSync(DeviceId)("22222222-2222-4222-8222-222222222222");
const sessionId = Schema.decodeUnknownSync(RemoteSessionId)("55555555-5555-4555-8555-555555555555");
const dataDirectory = "/var/octant-data-directory-marker";

function loadSnapshot(sampledAt = "2026-10-06T12:00:00.000Z") {
  return decodeHostResourceSnapshot({
    cores: 8,
    cpuPercent: 42,
    memory: { usedBytes: 4_000, totalBytes: 16_000 },
    disk: { usedBytes: 20, freeBytes: 80 },
    sampledAt,
  });
}

function setup(overrides: Partial<HostResourceRouteDependencies> = {}) {
  const windowAuthorityStore = new WindowAuthorityStore();
  windowAuthorityStore.register({ windowId, capability, now: nowMs });
  const read = vi.fn(async () => loadSnapshot());
  const handler = createHostResourceRouteHandler({
    windowAuthorityStore,
    hostId: () => thisHost,
    dataDirectory,
    now: () => nowMs,
    read,
    ...overrides,
  });
  return { handler, read };
}

function localRequest(path = "/api/host/resources"): Request {
  return new Request(`http://127.0.0.1:3100${path}`, {
    method: "GET",
    headers: { "x-octant-window-capability": capability, origin: "http://127.0.0.1:5173" },
  });
}

function remoteRequest(host: string): Request {
  const request = new Request("http://127.0.0.1:3100/api/host/resources", {
    method: "GET",
    headers: { origin: "http://127.0.0.1" },
  });
  bindPrincipalRouteContext(request, {
    principal: createRemoteDevicePrincipal({
      hostId: decodeStableHostId(host),
      deviceId,
      credentialGeneration: 1,
      origin: "https://octant.example",
      protocolVersion: 1,
      capabilityDigest: "a".repeat(64),
      sessionId,
    }),
    scopeId: decodeWindowId(deviceId),
  });
  return request;
}

function requireResponse(response: Response | undefined): Response {
  if (response === undefined) throw new Error("expected a response");
  return response;
}

describe("host resource route", () => {
  it("returns a load snapshot and nothing else to the local owner", async () => {
    const { handler } = setup();
    const response = requireResponse(await handler(localRequest()));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(dataDirectory);
    expect(text).not.toContain("process");
    const body: unknown = JSON.parse(text);
    expect(snapshotRevealsOnlyLoad(body)).toBe(true);
    expect(decodeHostResourceSnapshot(body)).toEqual(loadSnapshot());
  });

  it("reuses one snapshot for about five seconds and samples again after that", async () => {
    let clock = nowMs;
    const first = loadSnapshot("2026-10-06T12:00:00.000Z");
    const later = loadSnapshot("2026-10-06T12:00:05.000Z");
    const read = vi.fn(async () => (clock < nowMs + 5_000 ? first : later));
    const { handler } = setup({ read, now: () => clock });

    const firstBody = decodeHostResourceSnapshot(
      await requireResponse(await handler(localRequest())).json(),
    );
    clock += 4_999;
    const cachedBody = decodeHostResourceSnapshot(
      await requireResponse(await handler(localRequest())).json(),
    );
    clock += 1;
    const refreshedBody = decodeHostResourceSnapshot(
      await requireResponse(await handler(localRequest())).json(),
    );

    expect(firstBody).toEqual(first);
    expect(cachedBody).toEqual(first);
    expect(refreshedBody).toEqual(later);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("refuses figures to a remote principal bound to another host's identity", async () => {
    const { handler, read } = setup();
    const response = requireResponse(await handler(remoteRequest(otherHost)));
    expect(response.status).toBe(403);
    const text = await response.text();
    expect(text).not.toContain("cpuPercent");
    expect(text).not.toContain("memory");
    expect(text).not.toContain("disk");
    expect(text).not.toContain(dataDirectory);
    expect(read).not.toHaveBeenCalled();
  });

  it("refuses figures when nobody is authenticated", async () => {
    const { handler, read } = setup();
    const response = requireResponse(
      await handler(new Request("http://127.0.0.1:3100/api/host/resources")),
    );
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("cpuPercent");
    expect(read).not.toHaveBeenCalled();
  });

  it("returns figures to a paired device of this host", async () => {
    const { handler, read } = setup();
    const response = requireResponse(await handler(remoteRequest(thisHost)));
    expect(response.status).toBe(200);
    expect(decodeHostResourceSnapshot(await response.json()).cpuPercent).toBe(42);
    expect(read).toHaveBeenCalledOnce();
  });

  it("omits the disk bar's figures when the data volume cannot be read", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octant-host-resources-"));
    const windowAuthorityStore = new WindowAuthorityStore();
    windowAuthorityStore.register({ windowId, capability, now: nowMs });
    try {
      const handler = createHostResourceRouteHandler({
        windowAuthorityStore,
        hostId: () => thisHost,
        dataDirectory: directory,
        now: () => nowMs,
        cpuPercent: async () => 7,
        memory: () => ({ usedBytes: 10, totalBytes: 20 }),
        cores: () => 2,
        statfs: () => Promise.reject(new Error(`statfs failed for ${directory}`)),
      });
      const response = requireResponse(await handler(localRequest()));
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain(directory);
      expect(text).not.toContain("octant-host-resources");
      const body: unknown = JSON.parse(text);
      expect(snapshotRevealsOnlyLoad(body)).toBe(true);
      const decoded = decodeHostResourceSnapshot(body);
      expect(decoded.disk).toBeUndefined();
      expect(decoded.cpuPercent).toBe(7);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("reading a host resource snapshot", () => {
  it("hides disk when statfs fails and does not include the sampled path", async () => {
    const marker = "/tmp/octant-secret-data-dir";
    const sampled = await readHostResourceSnapshot({
      dataDirectory: marker,
      now: () => nowMs,
      cpuPercent: async () => 3,
      memory: () => ({ usedBytes: 1, totalBytes: 2 }),
      cores: () => 1,
      statfs: () => Promise.reject(new Error(marker)),
    });
    expect(sampled.disk).toBeUndefined();
    expect(JSON.stringify(sampled)).not.toContain(marker);
  });
});
