import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { decodeVideoJob, decodeWindowId } from "@octant/contracts";
import {
  decodeThreadExportBundle,
  decodeThreadVideoArchiveManifest,
  decodeThreadVideoArchiveOffer,
  THREAD_EXPORT_FORMAT,
  THREAD_EXPORT_PATH,
  THREAD_VIDEO_ARCHIVE_QUERY,
  type ThreadExportOutcome,
} from "@octant/contracts/thread-export";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  createThreadExportRouteHandler,
  createThreadHandOffRouteHandler,
} from "./threadExportRoutes";
import type { ThreadExportService } from "./threadExportService";
import type { ThreadHandOffService } from "./threadHandOffService";
import { bindPrincipalRouteContext } from "./principalRouteContext";
import { WindowAuthorityStore } from "./windowAuthorityStore";

const nowMs = Date.parse("2026-08-19T12:00:00.000Z");
const windowId = "70000000-0000-4000-8000-000000000001";
const capability = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop0";
const threadId = "00000000-0000-4000-8000-000000000901";
const videoOfferPath = `${THREAD_EXPORT_PATH}?${THREAD_VIDEO_ARCHIVE_QUERY}=1`;

function exportBundle() {
  return decodeThreadExportBundle({
    octant: {
      format: THREAD_EXPORT_FORMAT,
      threadId,
      mode: "chat",
      title: "Launch plan",
      hostId: "local",
      version: 1,
      sequence: 1,
      generatedAt: "2026-08-19T12:00:00.000Z",
    },
    transcript: { entries: [], activeCount: 0, revisedCount: 0 },
    evidence: { artifacts: [], attachments: [], citations: [] },
    provenance: {
      mode: "chat",
      threadId,
      hostId: "local",
      providerInstanceId: "10000000-0000-4000-8000-000000000001",
      modelId: "model-a",
      createdAt: "2026-08-19T12:00:00.000Z",
      updatedAt: "2026-08-19T12:00:00.000Z",
    },
    omissions: [],
  });
}

function setup(outcome: ThreadExportOutcome) {
  const windowAuthorityStore = new WindowAuthorityStore();
  windowAuthorityStore.register({ windowId: windowId as never, capability, now: nowMs });
  const service = {
    exportThread: async () => outcome,
  } as unknown as ThreadExportService;
  const handler = createThreadExportRouteHandler({
    service,
    windowAuthorityStore,
    now: () => nowMs,
  });
  return { handler };
}

function makeRequest(
  path: string,
  options: {
    readonly method?: string;
    readonly body?: unknown;
    readonly capability?: string;
    readonly hostname?: string;
  } = {},
): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.capability !== undefined) {
    headers["x-octant-window-capability"] = options.capability;
  }
  const host = options.hostname ?? "127.0.0.1";
  return new Request(`http://${host}:3100${path}`, {
    method: options.method ?? "POST",
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

describe("tool-call record route", () => {
  const body = { mode: "work", threadId, turnId: "00000000-0000-4000-8000-000000000a01" };
  const record = {
    toolCallId: "call-1",
    toolName: "Bash",
    input: { text: "ls", truncated: false },
    recordedAt: "2026-08-19T12:00:00.000Z",
  };
  function recordSetup() {
    const windowAuthorityStore = new WindowAuthorityStore();
    windowAuthorityStore.register({ windowId: windowId as never, capability, now: nowMs });
    const readToolCallRecords = vi.fn(async () => ({ kind: "records", records: [record] }));
    const handler = createThreadExportRouteHandler({
      service: { readToolCallRecords } as unknown as ThreadExportService,
      windowAuthorityStore,
      now: () => nowMs,
    });
    return { handler, readToolCallRecords };
  }

  it("answers an authenticated local window with a turn's tool-call records", async () => {
    const { handler, readToolCallRecords } = recordSetup();
    const response = await handler(
      makeRequest("/api/threads/tool-call-records", { capability, body }),
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ kind: "records", records: [record] });
    expect(readToolCallRecords).toHaveBeenCalledExactlyOnceWith(windowId, "local-window", body);
  });

  it("refuses a caller without a window capability before reading any record", async () => {
    const { handler, readToolCallRecords } = recordSetup();
    const response = await handler(makeRequest("/api/threads/tool-call-records", { body }));
    expect(response?.status).toBe(401);
    expect(readToolCallRecords).not.toHaveBeenCalled();
  });
});

describe("thread export routes", () => {
  it("returns undefined for other paths", async () => {
    const { handler } = setup({ kind: "refused", reason: "not-found" });
    expect(await handler(makeRequest("/api/other"))).toBeUndefined();
  });

  it("returns the bundle for an authenticated local window", async () => {
    const { handler } = setup({
      kind: "exported",
      bundle: exportBundle(),
    });
    const response = await handler(
      makeRequest("/api/threads/export", {
        capability,
        body: { mode: "chat", threadId },
      }),
    );
    expect(response?.status).toBe(200);
    const body = (await response!.json()) as { kind: string };
    expect(body.kind).toBe("exported");
  });

  it("fails closed without a window capability", async () => {
    const { handler } = setup({ kind: "exported", bundle: {} as never });
    const response = await handler(
      makeRequest("/api/threads/export", { body: { mode: "chat", threadId } }),
    );
    expect(response?.status).toBe(401);
    expect(await response!.text()).not.toContain(threadId);
  });

  it("fails closed off loopback", async () => {
    const { handler } = setup({ kind: "exported", bundle: {} as never });
    const response = await handler(
      makeRequest("/api/threads/export", {
        capability,
        hostname: "evil.example.com",
        body: { mode: "chat", threadId },
      }),
    );
    expect(response?.status).toBe(400);
  });

  it("answers 404 when the service refuses a missing thread", async () => {
    const { handler } = setup({ kind: "refused", reason: "not-found" });
    const response = await handler(
      makeRequest("/api/threads/export", {
        capability,
        body: { mode: "chat", threadId },
      }),
    );
    expect(response?.status).toBe(404);
    expect(await response!.json()).toEqual({ kind: "refused", reason: "not-found" });
  });

  it("answers a hand-off refusal the person can act on as an ordinary reply", async () => {
    const windowAuthorityStore = new WindowAuthorityStore();
    windowAuthorityStore.register({ windowId: windowId as never, capability, now: nowMs });
    const handOff = vi.fn(async () => ({ kind: "refused", reason: "turn-running" }) as const);
    const handler = createThreadHandOffRouteHandler({
      service: { handOff } as unknown as ThreadHandOffService,
      windowAuthorityStore,
      now: () => nowMs,
    });
    const response = await handler(
      makeRequest("/api/threads/hand-off", { body: { mode: "code", threadId }, capability }),
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ kind: "refused", reason: "turn-running" });
    expect(handOff).toHaveBeenCalledWith(windowId, "local-window", { mode: "code", threadId });

    const unauthenticated = await handler(
      makeRequest("/api/threads/hand-off", { body: { mode: "code", threadId } }),
    );
    expect(unauthenticated?.status).toBe(401);
    // One handler serves both commands, so a hand-off refusal has to name the
    // hand-off rather than tell the person their export was unauthorized.
    expect(await unauthenticated?.json()).toMatchObject({
      error: "Thread hand-off is unauthorized.",
    });
    expect(await handler(makeRequest("/api/threads/export", { capability }))).toBeUndefined();
  });

  it("treats a person-paired device as a local person for export while keeping hub-introduced devices remote", async () => {
    const windowAuthorityStore = new WindowAuthorityStore();
    windowAuthorityStore.register({ windowId: windowId as never, capability, now: nowMs });
    const exportThread = vi.fn<ThreadExportService["exportThread"]>(
      async () => ({ kind: "refused", reason: "not-found" }) as const,
    );
    const handler = createThreadExportRouteHandler({
      service: { exportThread } as unknown as ThreadExportService,
      windowAuthorityStore,
      now: () => nowMs,
    });

    const paired = makeRequest("/api/threads/export", { body: { mode: "chat", threadId } });
    bindPrincipalRouteContext(paired, {
      principal: { kind: "remote-device", admittedBy: "host-person" } as never,
      scopeId: windowId as never,
    });
    await handler(paired);

    const hub = makeRequest("/api/threads/export", { body: { mode: "chat", threadId } });
    bindPrincipalRouteContext(hub, {
      principal: { kind: "remote-device", admittedBy: "hub-roster" } as never,
      scopeId: windowId as never,
    });
    await handler(hub);

    expect(exportThread.mock.calls.map((call) => call[1])).toEqual([
      "local-window",
      "remote-device",
    ]);
  });
});

describe("thread exports with video files", () => {
  const bytes = Uint8Array.from({ length: 701 }, (_, index) => index % 256);
  const clipId = "e4000000-0000-4000-8000-000000000004";
  const hash = createHash("sha256").update(bytes).digest("hex");
  const job = decodeVideoJob({
    id: "e4000000-0000-4000-8000-000000000003",
    status: "completed",
    threadKind: "chat-thread",
    scopeId: threadId,
    profileInstanceId: "e4000000-0000-4000-8000-000000000001",
    driverKind: "gemini-video",
    modelId: "gemini-omni-1.2-flash",
    promptHash: "a".repeat(64),
    options: { durationSeconds: 10, resolution: "720p", aspectRatio: "16:9", audio: true },
    imageCount: 0,
    estimatedCostUsdMicros: 695_040,
    clip: {
      clipId,
      hash,
      size: bytes.length,
      durationSeconds: 10,
      resolution: "720p",
      aspectRatio: "16:9",
    },
    providerCopy: "removed",
    version: 2,
    createdAt: "2026-11-22T12:00:00.000Z",
    updatedAt: "2026-11-22T12:00:00.000Z",
  });

  function archiveFixture() {
    const windowAuthorityStore = new WindowAuthorityStore();
    windowAuthorityStore.register({ windowId: decodeWindowId(windowId), capability, now: nowMs });
    const exportThread = vi
      .fn<ThreadExportService["exportThread"]>()
      .mockResolvedValue({ kind: "exported", bundle: exportBundle() });
    const streamClip = vi.fn(async () => ({
      body: new Blob([bytes]).stream(),
      size: bytes.length,
    }));
    const handler = createThreadExportRouteHandler({
      service: { exportThread, readToolCallRecords: vi.fn() },
      windowAuthorityStore,
      now: () => nowMs,
      videoJobs: { listByScope: () => [job], getById: () => job, streamClip },
    });
    const prepare = async () => {
      const response = await handler(
        makeRequest(videoOfferPath, {
          capability,
          body: { mode: "chat", threadId },
        }),
      );
      expect(response?.status).toBe(200);
      const offer = decodeThreadVideoArchiveOffer(await response?.json());
      expect(offer.kind).toBe("archive-ready");
      if (offer.kind !== "archive-ready") throw new Error("Expected a video archive.");
      return offer;
    };
    return { handler, prepare, exportThread, streamClip };
  }

  it("quotes the archive size before reading video bytes and exports the transcript and clip as files", async () => {
    const { handler, prepare, streamClip } = archiveFixture();
    const offer = await prepare();
    expect(streamClip).not.toHaveBeenCalled();
    const result = await handler(makeRequest(offer.url, { method: "GET" }));
    expect(result?.status).toBe(200);
    expect(result?.headers.get("content-length")).toBe(String(offer.size));
    const contents = await result?.arrayBuffer();
    if (contents === undefined) throw new Error("Expected an archive body.");
    expect(contents.byteLength).toBe(offer.size);
    // Read through the system tar so this round-trip checks a standard archive
    // and works in the Node-run unit suite as well as in Bun.
    const input = Buffer.from(contents);
    // GNU tar adds the options a shell exports to every call, which would
    // change what is listed and read back.
    vi.stubEnv("TAR_OPTIONS", "--exclude=*.mp4");
    onTestFinished(() => void vi.unstubAllEnvs());
    const { TAR_OPTIONS: _exported, ...env } = process.env;
    const tar = (...args: ReadonlyArray<string>) => execFileSync("tar", args, { input, env });
    const clipPath = `video/${clipId}.mp4`;
    const paths = tar("-tf", "-").toString("utf8");
    expect(paths.trim().split(/\r?\n/)).toEqual(["manifest.json", clipPath]);
    const manifest = decodeThreadVideoArchiveManifest(
      JSON.parse(tar("-xOf", "-", "manifest.json").toString("utf8")),
    );
    expect(manifest.thread).toEqual(exportBundle());
    expect(manifest.clips).toEqual([{ jobId: job.id, clipId, size: bytes.length, hash }]);
    expect(Uint8Array.from(tar("-xOf", "-", clipPath))).toEqual(bytes);
    expect((await handler(makeRequest(offer.url, { method: "GET" })))?.status).toBe(404);
  });

  it("refuses to prepare without window authority or to download after thread access is lost", async () => {
    const { handler, prepare, exportThread, streamClip } = archiveFixture();
    const unauthorized = await handler(
      makeRequest(videoOfferPath, { body: { mode: "chat", threadId } }),
    );
    expect(unauthorized?.status).toBe(401);
    expect(exportThread).not.toHaveBeenCalled();
    const offer = await prepare();
    exportThread.mockResolvedValue({ kind: "refused", reason: "not-found" });
    expect((await handler(makeRequest(offer.url, { method: "GET" })))?.status).toBe(404);
    expect(streamClip).not.toHaveBeenCalled();
  });

  it("preflights and reads the same export path on a host without an archive service", async () => {
    const { handler } = setup({ kind: "exported", bundle: exportBundle() });
    const origin = "http://localhost:5173";
    const preflight = await handler(
      new Request(`http://127.0.0.1:3100${videoOfferPath}`, {
        method: "OPTIONS",
        headers: {
          origin,
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type,x-octant-window-capability",
        },
      }),
    );
    expect(preflight?.status).toBe(204);
    expect(preflight?.headers.get("access-control-allow-origin")).toBe(origin);
    const response = await handler(
      makeRequest(videoOfferPath, { capability, body: { mode: "chat", threadId } }),
    );
    expect(await response?.json()).toEqual({ kind: "exported", bundle: exportBundle() });
  });
});
