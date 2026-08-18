import { describe, expect, it, vi } from "vitest";
import { MobileInboxFailure, type MobileRemoteTransport } from "./mobileInboxClient";
import {
  loadMobileBrowserSurface,
  tapMobileBrowserSurface,
  type MobileBrowserActionHandle,
} from "./mobileThreadSurfaceClient";

const ids = {
  thread: "20000000-0000-4000-8000-000000000001",
  context: "25000000-0000-4000-8000-000000000001",
  action: "70000000-0000-4000-8000-000000000001",
  correlation: "80000000-0000-4000-8000-000000000001",
};

const now = "2026-08-18T09:00:00.000Z";
const screenshot = `data:image/png;base64,${"A".repeat(24)}=`;

const authority = {
  hostId: "30000000-0000-4000-8000-000000000001",
  mode: "code",
  projectId: "40000000-0000-4000-8000-000000000001",
  rootId: "50000000-0000-4000-8000-000000000001",
  providerInstanceId: "60000000-0000-4000-8000-000000000001",
  extension: { kind: "core" },
} as unknown as MobileBrowserActionHandle["authority"];

function context() {
  return {
    contextId: ids.context,
    threadId: ids.thread,
    actionId: ids.action,
    correlationId: ids.correlation,
    authority,
    state: "active",
    presentation: "headless",
    policy: {
      profileMode: "isolated",
      allowedOrigins: ["https://example.com"],
      credentialFieldProtection: true,
      maxConcurrentTabs: 1,
      sessionTimeoutMs: 300_000,
    },
    createdAt: now,
  };
}

function observation(overrides: Record<string, unknown> = {}) {
  return {
    contextId: ids.context,
    actionId: ids.action,
    correlationId: ids.correlation,
    authority,
    url: "https://example.com/",
    title: "Example",
    screenshotDataUrl: screenshot,
    revision: 7,
    observedAt: now,
    stale: false,
    ...overrides,
  };
}

function transport(replies: ReadonlyArray<{ readonly status: number; readonly body?: unknown }>) {
  const queued = [...replies];
  const authenticatedFetch = vi.fn(
    async (_input: Parameters<MobileRemoteTransport["authenticatedFetch"]>[0]) => {
      const next = queued.shift() ?? { status: 500 };
      return new Response(next.body === undefined ? "{}" : JSON.stringify(next.body), {
        status: next.status,
        headers: { "content-type": "application/json" },
      });
    },
  );
  return { transport: { hostId: "local", authenticatedFetch }, authenticatedFetch };
}

describe("watching the host's browser from a phone", () => {
  it("shows the picture the host captured, with a handle for acting in it", async () => {
    const { transport: remote, authenticatedFetch } = transport([
      { status: 200, body: { threadId: ids.thread, authority } },
      {
        status: 200,
        body: {
          status: "running",
          threadId: ids.thread,
          context: context(),
          observation: observation(),
          evidence: [],
        },
      },
    ]);

    const view = await loadMobileBrowserSurface({
      transport: remote,
      threadId: ids.thread,
      mode: "code",
    });

    expect(view.status).toBe("showing");
    expect(view.screenshotDataUrl).toBe(screenshot);
    expect(view.action?.observationRevision).toBe(7);
    // The device asks for its own scope first; it never assumes the authority
    // that comes back.
    expect(authenticatedFetch.mock.calls[0]?.[0]).toMatchObject({
      path: "/api/browser/scope",
      method: "POST",
    });
  });

  it("reports the surface as unavailable when the host will not let this device watch", async () => {
    const { transport: remote } = transport([{ status: 403 }]);

    expect(
      await loadMobileBrowserSurface({
        transport: remote,
        threadId: ids.thread,
        mode: "code",
      }),
    ).toEqual({ status: "unavailable", stale: true });
  });

  it("says the thread has no browser running rather than waiting forever", async () => {
    const { transport: remote } = transport([
      { status: 200, body: { threadId: ids.thread, authority } },
      { status: 200, body: { status: "ready", threadId: ids.thread, evidence: [] } },
    ]);

    const view = await loadMobileBrowserSurface({
      transport: remote,
      threadId: ids.thread,
      mode: "code",
    });

    expect(view.status).toBe("idle");
    expect(view.action).toBeUndefined();
  });

  it("offers no handle while the host holds no live context", async () => {
    const { transport: remote } = transport([
      { status: 200, body: { threadId: ids.thread, authority } },
      {
        status: 200,
        body: {
          status: "running",
          threadId: ids.thread,
          observation: observation({ screenshotDataUrl: undefined }),
          evidence: [],
        },
      },
    ]);

    const view = await loadMobileBrowserSurface({
      transport: remote,
      threadId: ids.thread,
      mode: "code",
    });

    expect(view.status).toBe("idle");
    expect(view.action).toBeUndefined();
  });
});

describe("landing a tap in the page the host is showing", () => {
  const handle: MobileBrowserActionHandle = {
    actionId: ids.action,
    contextId: ids.context,
    correlationId: ids.correlation,
    authority,
    observationRevision: 7,
  };

  it("sends a normalized point against the picture it drew", async () => {
    const { transport: remote, authenticatedFetch } = transport([
      {
        status: 200,
        body: {
          status: "running",
          threadId: ids.thread,
          context: context(),
          observation: observation({ revision: 8 }),
          evidence: [],
        },
      },
    ]);

    const view = await tapMobileBrowserSurface({
      transport: remote,
      threadId: ids.thread,
      handle,
      point: { x: 0.25, y: 0.5 },
    });

    expect(view.action?.observationRevision).toBe(8);
    const body = authenticatedFetch.mock.calls[0]?.[0]?.body;
    const sent = JSON.parse(typeof body === "string" ? body : "{}") as Record<string, unknown>;
    expect(sent).toMatchObject({
      kind: "click",
      point: { x: 0.25, y: 0.5 },
      expectedObservationRevision: 7,
    });
  });

  it("reports the host's refusal as a refusal, not an empty view", async () => {
    const { transport: remote } = transport([{ status: 403 }]);

    await expect(
      tapMobileBrowserSurface({
        transport: remote,
        threadId: ids.thread,
        handle,
        point: { x: 0.5, y: 0.5 },
      }),
    ).rejects.toMatchObject({ category: "rejected" });
  });

  it("says the page moved on when the host refuses a gesture against a stale picture", async () => {
    const { transport: remote } = transport([{ status: 409 }]);

    await expect(
      tapMobileBrowserSurface({
        transport: remote,
        threadId: ids.thread,
        handle,
        point: { x: 0.5, y: 0.5 },
      }),
    ).rejects.toBeInstanceOf(MobileInboxFailure);
  });
});
