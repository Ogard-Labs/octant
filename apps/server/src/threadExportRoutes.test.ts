import { THREAD_EXPORT_FORMAT, type ThreadExportOutcome } from "@octant/contracts/thread-export";
import { describe, expect, it, vi } from "vitest";
import {
  createThreadExportRouteHandler,
  createThreadHandOffRouteHandler,
} from "./threadExportRoutes";
import type { ThreadExportService } from "./threadExportService";
import type { ThreadHandOffService } from "./threadHandOffService";
import { WindowAuthorityStore } from "./windowAuthorityStore";

const nowMs = Date.parse("2026-08-19T12:00:00.000Z");
const windowId = "70000000-0000-4000-8000-000000000001";
const capability = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop0";
const threadId = "00000000-0000-4000-8000-000000000901";

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

describe("thread export routes", () => {
  it("returns undefined for other paths", async () => {
    const { handler } = setup({ kind: "refused", reason: "not-found" });
    expect(await handler(makeRequest("/api/other"))).toBeUndefined();
  });

  it("returns the bundle for an authenticated local window", async () => {
    const { handler } = setup({
      kind: "exported",
      bundle: {
        octant: {
          format: THREAD_EXPORT_FORMAT,
          threadId,
          mode: "chat",
          title: "Launch plan",
          hostId: "local" as never,
          version: 1,
          sequence: 1,
          generatedAt: "2026-08-19T12:00:00.000Z" as never,
        },
        transcript: { entries: [], activeCount: 0, revisedCount: 0 },
        evidence: { artifacts: [], attachments: [], citations: [] },
        provenance: {
          mode: "chat",
          threadId,
          hostId: "local" as never,
          providerInstanceId: "10000000-0000-4000-8000-000000000001" as never,
          modelId: "model-a" as never,
          createdAt: "2026-08-19T12:00:00.000Z" as never,
          updatedAt: "2026-08-19T12:00:00.000Z" as never,
        },
        omissions: [],
      },
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
});
