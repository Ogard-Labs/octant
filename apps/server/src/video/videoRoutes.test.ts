import { decodeVideoJob, decodeWindowId, type VideoJob } from "@octant/contracts";
import { decodeStableHostId, DeviceId, RemoteSessionId } from "@octant/contracts/remote-access";
import { Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import { AGENT_ACCESS_ORIGIN, createRemoteDevicePrincipal } from "../clientPrincipal";
import { bindPrincipalRouteContext } from "../principalRouteContext";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { createVideoRouteHandler, parseRange, type VideoRouteDependencies } from "./videoRoutes";

const nowMs = Date.parse("2026-11-22T12:00:00.000Z");
const windowId = "70000000-0000-4000-8000-000000000001";
const capability = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop0";
const scopeId = "e4000000-0000-4000-8000-000000000002";
const jobId = "e4000000-0000-4000-8000-000000000003";
const origin = "http://127.0.0.1:5173";
const clip = Uint8Array.from({ length: 100 }, (_, index) => index);

const job: VideoJob = decodeVideoJob({
  id: jobId,
  status: "completed",
  threadKind: "work-thread",
  scopeId,
  profileInstanceId: "e4000000-0000-4000-8000-000000000001",
  driverKind: "gemini-video",
  modelId: "gemini-omni-1.2-flash",
  promptHash: "a".repeat(64),
  options: { durationSeconds: 10, resolution: "720p", aspectRatio: "16:9", audio: true },
  imageCount: 0,
  estimatedCostUsdMicros: 695_040,
  clip: {
    clipId: "e4000000-0000-4000-8000-000000000004",
    hash: "b".repeat(64),
    size: clip.byteLength,
    durationSeconds: 10,
    resolution: "720p",
    aspectRatio: "16:9",
  },
  providerCopy: "removed",
  version: 2,
  createdAt: "2026-11-22T12:00:00.000Z",
  updatedAt: "2026-11-22T12:00:00.000Z",
});

function setup(
  isPairedDeviceSessionCurrent: VideoRouteDependencies["isPairedDeviceSessionCurrent"] = () =>
    false,
  clipJob = job,
) {
  let canOpen = true;
  const windowAuthorityStore = new WindowAuthorityStore();
  windowAuthorityStore.register({ windowId: windowId as never, capability, now: nowMs });
  const stop = vi.fn();
  const readClipRange = vi.fn<VideoRouteDependencies["jobs"]["readClipRange"]>(
    async (_job, range) => {
      const end = Math.min(range.end, clip.byteLength - 1);
      return {
        bytes: clip.slice(range.start, end + 1),
        start: range.start,
        end,
        size: clip.byteLength,
      };
    },
  );
  const handler = createVideoRouteHandler({
    jobs: {
      getById: (id) => (String(id) === jobId ? clipJob : undefined),
      listByScope: () => [clipJob],
      stop,
      readClipRange,
      streamClip: async () => ({
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(clip);
            controller.close();
          },
        }),
        size: clip.byteLength,
      }),
    },
    authorizeScope: async () => canOpen,
    isPairedDeviceSessionCurrent,
    windowAuthorityStore,
    now: () => nowMs,
  });
  return { handler, stop, readClipRange, loseThread: () => (canOpen = false) };
}

function request(
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
) {
  return new Request(`http://127.0.0.1:3100${path}`, {
    method: init.method ?? "GET",
    headers: { origin, "x-octant-window-capability": capability, ...init.headers },
    ...(init.body === undefined ? {} : { body: init.body }),
  });
}

async function ticketUrl(handler: ReturnType<typeof setup>["handler"]): Promise<string> {
  const response = await handler(
    request("/api/video/clip", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobId }),
    }),
  );
  if (response === undefined) throw new Error("The video routes did not answer.");
  expect(response.status).toBe(200);
  return ((await response.json()) as { url: string }).url;
}

describe("video routes", () => {
  it("lists a thread's jobs only for a window that can open the thread", async () => {
    const { handler, loseThread } = setup();
    const path = `/api/video/jobs?threadKind=work-thread&scopeId=${scopeId}`;
    const listed = await handler(request(path));
    if (listed === undefined) throw new Error("The video routes did not answer.");
    expect(((await listed.json()) as { jobs: unknown[] }).jobs).toHaveLength(1);
    loseThread();
    expect((await handler(request(path)))?.status).toBe(404);
  });

  it("serves a clip by byte range on a ticket, without the window's credential", async () => {
    const { handler } = setup();
    const url = await ticketUrl(handler);
    const response = await handler(
      new Request(`http://127.0.0.1:3100${url}`, { headers: { range: "bytes=10-19" } }),
    );
    expect(response?.status).toBe(206);
    expect(response?.headers.get("content-range")).toBe("bytes 10-19/100");
    expect(new Uint8Array(await (response?.arrayBuffer() ?? new ArrayBuffer(0)))).toEqual(
      clip.slice(10, 20),
    );
  });

  it("serves the whole clip to a download request that asks for no range", async () => {
    const { handler } = setup();
    const url = await ticketUrl(handler);
    const response = await handler(new Request(`http://127.0.0.1:3100${url}`));
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-length")).toBe(String(clip.byteLength));
    expect(new Uint8Array(await (response?.arrayBuffer() ?? new ArrayBuffer(0)))).toEqual(clip);
  });

  it("refuses the clip at the next request once the window can no longer open the thread", async () => {
    const { handler, loseThread } = setup();
    const url = await ticketUrl(handler);
    loseThread();
    expect((await handler(new Request(`http://127.0.0.1:3100${url}`)))?.status).toBe(404);
  });

  it("drops a revoked window's tickets", async () => {
    const { handler } = setup();
    const url = await ticketUrl(handler);
    handler.revokeWindow(windowId as never);
    expect((await handler(new Request(`http://127.0.0.1:3100${url}`)))?.status).toBe(404);
  });

  it("drops a paired Chat clip ticket when its issuing session is no longer current", async () => {
    let current = true;
    const isPairedDeviceSessionCurrent = vi.fn(() => current);
    const { handler, readClipRange } = setup(isPairedDeviceSessionCurrent, {
      ...job,
      threadKind: "chat-thread",
    });
    const principal = createRemoteDevicePrincipal({
      hostId: decodeStableHostId("70000000-0000-4000-8000-000000000011"),
      deviceId: Schema.decodeUnknownSync(DeviceId)("70000000-0000-4000-8000-000000000012"),
      sessionId: Schema.decodeUnknownSync(RemoteSessionId)("70000000-0000-4000-8000-000000000013"),
      origin: "https://host.example.test",
      capabilityDigest: "c".repeat(64),
      credentialGeneration: 2,
      protocolVersion: 1,
      admittedBy: "host-person",
    });
    const sessionNow = () => nowMs + 20;
    const issue = new Request("http://127.0.0.1:3100/api/video/clip", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobId }),
    });
    bindPrincipalRouteContext(issue, {
      principal,
      scopeId: decodeWindowId(String(principal.deviceId)),
      sessionNow,
    });
    const issued = await handler(issue);
    expect(issued?.status).toBe(200);
    if (issued === undefined) throw new Error("The video routes did not answer.");
    const { url } = (await issued.json()) as { url: string };
    const range = () =>
      new Request(`http://127.0.0.1:3100${url}`, { headers: { range: "bytes=0-9" } });
    expect((await handler(range()))?.status).toBe(206);

    current = false;
    const revoked = await handler(range());
    expect(revoked?.status).toBe(404);
    expect(revoked?.headers.get("content-type")).not.toBe("video/mp4");
    expect(isPairedDeviceSessionCurrent).toHaveBeenLastCalledWith(principal, sessionNow);
    expect(readClipRange).toHaveBeenCalledOnce();
    current = true;
    expect((await handler(range()))?.status).toBe(404);
  });

  it("stops a job the window can open", async () => {
    const { handler, stop } = setup();
    const response = await handler(request(`/api/video/jobs/${jobId}/stop`, { method: "POST" }));
    expect(response?.status).toBe(200);
    expect(stop).toHaveBeenCalledOnce();
  });

  it("refuses hub-introduced devices and agent grants while allowing directly paired narrower levels to read clips", async () => {
    const { handler, stop } = setup(() => true);
    const makePrincipal = (overrides: Partial<Parameters<typeof createRemoteDevicePrincipal>[0]>) =>
      createRemoteDevicePrincipal({
        hostId: decodeStableHostId("70000000-0000-4000-8000-000000000011"),
        deviceId: Schema.decodeUnknownSync(DeviceId)("70000000-0000-4000-8000-000000000012"),
        sessionId: Schema.decodeUnknownSync(RemoteSessionId)(
          "70000000-0000-4000-8000-000000000013",
        ),
        origin: "https://host.example.test",
        capabilityDigest: "c".repeat(64),
        credentialGeneration: 2,
        protocolVersion: 1,
        ...overrides,
      });
    const sendAs = async (
      principal: ReturnType<typeof createRemoteDevicePrincipal>,
      path: string,
      init: { method?: string; body?: string } = {},
    ) => {
      const req = new Request(`http://127.0.0.1:3100${path}`, {
        method: init.method ?? "GET",
        headers: init.body === undefined ? {} : { "content-type": "application/json" },
        ...(init.body === undefined ? {} : { body: init.body }),
      });
      bindPrincipalRouteContext(req, {
        principal,
        scopeId: decodeWindowId(String(principal.deviceId)),
      });
      return handler(req);
    };

    const readOnly = makePrincipal({ admittedBy: "host-person", accessLevel: "read-only" });
    expect(
      (await sendAs(readOnly, `/api/video/jobs?threadKind=work-thread&scopeId=${scopeId}`))?.status,
    ).toBe(200);
    expect(
      (await sendAs(readOnly, `/api/video/jobs/${jobId}/stop`, { method: "POST" }))?.status,
    ).toBe(404);
    expect(stop).not.toHaveBeenCalled();

    const hubMember = makePrincipal({ admittedBy: "hub-roster" });
    expect(
      (await sendAs(hubMember, `/api/video/jobs?threadKind=work-thread&scopeId=${scopeId}`))
        ?.status,
    ).toBe(404);

    const agentGrant = makePrincipal({
      admittedBy: "host-person",
      origin: AGENT_ACCESS_ORIGIN,
    });
    expect(
      (await sendAs(agentGrant, `/api/video/jobs?threadKind=work-thread&scopeId=${scopeId}`))
        ?.status,
    ).toBe(404);
  });

  it("reads open, closed and suffix ranges and refuses ones past the clip", () => {
    expect(parseRange("bytes=0-", 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=5-500", 100)).toEqual({ start: 5, end: 99 });
    expect(parseRange("bytes=100-", 100)).toBe("unsatisfiable");
    expect(parseRange(null, 100)).toBeUndefined();
  });
});
