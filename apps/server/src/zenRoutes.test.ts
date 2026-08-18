import {
  LOCAL_HOST_ID,
  decodeChatThreadId,
  decodeProjectId,
  decodeProviderInstanceId,
  decodeWindowId,
  decodeZenThreadCatalogEntry,
  decodeZenThreadCatalogRef,
  ZenError,
} from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { WindowAuthorityStore } from "./windowAuthorityStore";
import { createZenRouteHandler } from "./zenRoutes";

const windowId = decodeWindowId("11111111-1111-4111-8111-111111111111");
const capability = `${"A".repeat(42)}A`;
const threadId = decodeChatThreadId("22222222-2222-4222-8222-222222222222");
const catalogRef = decodeZenThreadCatalogRef(`chat:${threadId}`);
const entry = decodeZenThreadCatalogEntry({
  catalogRef,
  hostId: LOCAL_HOST_ID,
  hostLabel: "This Mac",
  mode: "chat",
  projectId: decodeProjectId("33333333-3333-4333-8333-333333333333"),
  projectLabel: "Release",
  threadId,
  title: "Release blocker",
  status: "active",
  recentActivityAt: "2026-07-28T12:00:00.000Z",
  providerInstanceId: decodeProviderInstanceId("44444444-4444-4444-8444-444444444444"),
  modelId: "model-local",
  sourceContext: {
    hostId: LOCAL_HOST_ID,
    mode: "chat",
    projectId: "33333333-3333-4333-8333-333333333333",
    threadKind: "chat",
    threadId,
  },
});

describe("Zen routes", () => {
  it("decodes a command body from the request stream", async () => {
    const windowAuthorityStore = new WindowAuthorityStore();
    windowAuthorityStore.register({ windowId, capability, now: 0 });
    const handleCommand = vi.fn(() => ({ result: "recover" as const }));
    const handler = createZenRouteHandler({
      windowAuthorityStore,
      zenService: {
        bootstrap: vi.fn(() => ({ space: null, windowId })),
        handleCommand,
      } as never,
      now: () => 0,
    });

    const response = await handler(
      new Request("http://127.0.0.1/api/zen/command", {
        method: "POST",
        headers: { "x-octant-window-capability": capability },
        body: JSON.stringify({
          command: "create-space",
          windowId,
        }),
      }),
    );

    expect(response?.status).toBe(200);
    expect(handleCommand).toHaveBeenCalledWith(
      { command: "create-space", windowId },
      windowId,
      expect.any(AbortSignal),
    );
  });

  it("accepts typed widget creation but rejects caller-forged widget identities", async () => {
    const windowAuthorityStore = new WindowAuthorityStore();
    windowAuthorityStore.register({ windowId, capability, now: 0 });
    const handleCommand = vi.fn(() => ({ result: "recover" as const }));
    const handler = createZenRouteHandler({
      windowAuthorityStore,
      zenService: { handleCommand } as never,
      now: () => 0,
    });
    const headers = {
      "content-type": "application/json",
      "x-octant-window-capability": capability,
    };

    const accepted = await handler(
      new Request("http://127.0.0.1/api/zen/command", {
        method: "POST",
        headers,
        body: JSON.stringify({
          command: "create-widget",
          spaceId: "22222222-2222-4222-8222-222222222222",
          kind: "notes",
          expectedVersion: 1,
        }),
      }),
    );
    const forged = await handler(
      new Request("http://127.0.0.1/api/zen/command", {
        method: "POST",
        headers,
        body: JSON.stringify({
          command: "add-element",
          spaceId: "22222222-2222-4222-8222-222222222222",
          expectedVersion: 1,
          element: {
            elementId: "33333333-3333-4333-8333-333333333333",
            kind: "notes",
            widgetVersion: 0,
            content: "forged",
            geometry: { x: 0, y: 0, width: 200, height: 100 },
            zIndex: 1,
            minimized: false,
            locked: false,
          },
        }),
      }),
    );

    expect(accepted?.status).toBe(200);
    expect(forged?.status).toBe(400);
    expect(handleCommand).toHaveBeenCalledTimes(1);
    expect(handleCommand).toHaveBeenCalledWith(
      expect.objectContaining({ command: "create-widget", kind: "notes" }),
      windowId,
      expect.any(AbortSignal),
    );
  });

  it("accepts bounded timer commands but rejects caller-built timer state", async () => {
    const windowAuthorityStore = new WindowAuthorityStore();
    windowAuthorityStore.register({ windowId, capability, now: 0 });
    const handleCommand = vi.fn(() => ({ result: "mutation" as const, space: {} }));
    const handler = createZenRouteHandler({
      windowAuthorityStore,
      zenService: { handleCommand } as never,
      now: () => 0,
    });
    const accepted = await handler(
      new Request("http://127.0.0.1/api/zen/command", {
        method: "POST",
        headers: { "x-octant-window-capability": capability },
        body: JSON.stringify({
          command: "create-timer",
          spaceId: "22222222-2222-4222-8222-222222222222",
          durationMs: 25 * 60 * 1000,
          expectedVersion: 1,
        }),
      }),
    );
    const rejected = await handler(
      new Request("http://127.0.0.1/api/zen/command", {
        method: "POST",
        headers: { "x-octant-window-capability": capability },
        body: JSON.stringify({
          command: "add-element",
          spaceId: "22222222-2222-4222-8222-222222222222",
          expectedVersion: 1,
          element: {
            elementId: "33333333-3333-4333-8333-333333333333",
            kind: "timer",
            durationMs: 25 * 60 * 1000,
            remainingMs: 1,
            status: "running",
            startedAt: "2026-07-29T08:00:00.000Z",
            deadlineAt: "2026-07-29T08:00:00.001Z",
            clockSessionId: "forged-client",
            monotonicStartedMs: 1,
            geometry: { x: 0, y: 0, width: 360, height: 220 },
            zIndex: 1,
            minimized: false,
            locked: false,
          },
        }),
      }),
    );

    expect(accepted?.status).toBe(200);
    expect(rejected?.status).toBe(400);
    expect(handleCommand).toHaveBeenCalledTimes(1);
    expect(handleCommand).toHaveBeenCalledWith(
      expect.objectContaining({ command: "create-timer" }),
      windowId,
      expect.any(AbortSignal),
    );
  });

  it("rejects caller-supplied thread source context on updates", async () => {
    const windowAuthorityStore = new WindowAuthorityStore();
    windowAuthorityStore.register({ windowId, capability, now: 0 });
    const handleCommand = vi.fn(() => ({ result: "update-element" as const }));
    const handler = createZenRouteHandler({
      windowAuthorityStore,
      zenService: {
        bootstrap: vi.fn(() => ({ space: null, windowId })),
        handleCommand,
      } as never,
      now: () => 0,
    });

    const response = await handler(
      new Request("http://127.0.0.1/api/zen/command", {
        method: "POST",
        headers: { "x-octant-window-capability": capability },
        body: JSON.stringify({
          command: "update-element",
          spaceId: "22222222-2222-4222-8222-222222222222",
          expectedVersion: 1,
          element: {
            elementId: "33333333-3333-4333-8333-333333333333",
            kind: "thread",
            sourceContext: {
              hostId: "44444444-4444-4444-8444-444444444444",
              mode: "code",
              projectId: null,
              threadKind: "code",
              threadId: "55555555-5555-4555-8555-555555555555",
            },
            geometry: { x: 0, y: 0, width: 200, height: 100 },
            zIndex: 1,
            minimized: false,
            locked: false,
          },
        }),
      }),
    );

    expect(response?.status).toBe(400);
    expect(handleCommand).not.toHaveBeenCalled();
  });

  it("rejects caller-supplied Navigator bindings", async () => {
    const windowAuthorityStore = new WindowAuthorityStore();
    windowAuthorityStore.register({ windowId, capability, now: 0 });
    const handleCommand = vi.fn();
    const handler = createZenRouteHandler({
      windowAuthorityStore,
      zenService: { handleCommand } as never,
      now: () => 0,
    });

    const response = await handler(
      new Request("http://127.0.0.1/api/zen/command", {
        method: "POST",
        headers: { "x-octant-window-capability": capability },
        body: JSON.stringify({
          command: "bind-assistant",
          spaceId: "55555555-5555-4555-8555-555555555555",
          assistant: {
            threadId,
            providerId: "forged-provider",
            modelId: "forged-model",
          },
          expectedVersion: 1,
        }),
      }),
    );

    expect(response?.status).toBe(400);
    expect(handleCommand).not.toHaveBeenCalled();
  });

  it("searches only through the authenticated server catalog", async () => {
    const windowAuthorityStore = new WindowAuthorityStore();
    windowAuthorityStore.register({ windowId, capability, now: 0 });
    const searchThreads = vi.fn(async () => [entry]);
    const handler = createZenRouteHandler({
      windowAuthorityStore,
      zenService: { searchThreads } as never,
      now: () => 0,
    });

    const response = await handler(
      new Request("http://127.0.0.1/api/zen/threads?q=release", {
        headers: { "x-octant-window-capability": capability },
      }),
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ query: "release", entries: [entry] });
    expect(searchThreads).toHaveBeenCalledWith(windowId, "release");
  });

  it("attaches an exact catalog reference and rejects caller-supplied source authority", async () => {
    const windowAuthorityStore = new WindowAuthorityStore();
    windowAuthorityStore.register({ windowId, capability, now: 0 });
    const attachThread = vi.fn(async () => ({ result: "thread-attached" as const }));
    const handler = createZenRouteHandler({
      windowAuthorityStore,
      zenService: { attachThread } as never,
      now: () => 0,
    });

    const accepted = await handler(
      new Request("http://127.0.0.1/api/zen/threads/attach", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify({ catalogRef, expectedVersion: 2 }),
      }),
    );
    const forged = await handler(
      new Request("http://127.0.0.1/api/zen/threads/attach", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify({
          catalogRef,
          expectedVersion: 2,
          sourceContext: entry.sourceContext,
        }),
      }),
    );

    expect(accepted?.status).toBe(200);
    expect(attachThread).toHaveBeenCalledWith(windowId, { catalogRef, expectedVersion: 2 });
    expect(forged?.status).toBe(400);
    expect(attachThread).toHaveBeenCalledTimes(1);
  });

  it("resolves continuation from the exact source-qualified reference", async () => {
    const windowAuthorityStore = new WindowAuthorityStore();
    windowAuthorityStore.register({ windowId, capability, now: 0 });
    const continueThread = vi.fn(async () => ({ result: "thread-continuation" as const, entry }));
    const handler = createZenRouteHandler({
      windowAuthorityStore,
      zenService: { continueThread } as never,
      now: () => 0,
    });

    const response = await handler(
      new Request(
        `http://127.0.0.1/api/zen/threads/continue?ref=${encodeURIComponent(catalogRef)}`,
        { headers: { "x-octant-window-capability": capability } },
      ),
    );

    expect(response?.status).toBe(200);
    expect(continueThread).toHaveBeenCalledWith(windowId, catalogRef);
  });

  it("ensures and reads the persistent assistant only through window authority", async () => {
    const windowAuthorityStore = new WindowAuthorityStore();
    windowAuthorityStore.register({ windowId, capability, now: 0 });
    const ensureAssistant = vi.fn(async () => ({ status: "ready" as const }));
    const assistantSnapshot = vi.fn(async () => ({ status: "ready" as const }));
    const handler = createZenRouteHandler({
      windowAuthorityStore,
      zenService: { ensureAssistant, assistantSnapshot } as never,
      now: () => 0,
    });

    const ensured = await handler(
      new Request("http://127.0.0.1/api/zen/assistant", {
        method: "POST",
        headers: { "x-octant-window-capability": capability },
      }),
    );
    const snapshot = await handler(
      new Request("http://127.0.0.1/api/zen/assistant", {
        headers: { "x-octant-window-capability": capability },
      }),
    );

    expect(ensured?.status).toBe(200);
    expect(snapshot?.status).toBe(200);
    expect(ensureAssistant).toHaveBeenCalledWith(windowId);
    expect(assistantSnapshot).toHaveBeenCalledWith(windowId);
  });

  it("serves no Zen turn endpoint, because assistant turns are the host's Navigator route", async () => {
    const windowAuthorityStore = new WindowAuthorityStore();
    windowAuthorityStore.register({ windowId, capability, now: 0 });
    const handler = createZenRouteHandler({
      windowAuthorityStore,
      zenService: {} as never,
      now: () => 0,
    });

    const turn = await handler(
      new Request("http://127.0.0.1/api/zen/assistant/turn", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify({ prompt: "Attach the release thread" }),
      }),
    );

    expect(turn).toBeUndefined();
  });
});

describe("Zen space routes", () => {
  function spaceRouteFixture(focusZoneCommand: () => unknown) {
    const windowAuthorityStore = new WindowAuthorityStore();
    windowAuthorityStore.register({ windowId, capability, now: 0 });
    return createZenRouteHandler({
      windowAuthorityStore,
      zenService: { focusZoneCommand: vi.fn(focusZoneCommand) } as never,
      now: () => 0,
    });
  }

  it("switches the window that proved its own identity to another of its spaces", async () => {
    const spaceId = "55555555-5555-4555-8555-555555555555";
    const handler = spaceRouteFixture(() => ({ result: "focus-zone-updated" }));

    const response = await handler(
      new Request("http://127.0.0.1/api/zen/spaces", {
        method: "POST",
        headers: { "x-octant-window-capability": capability },
        body: JSON.stringify({ command: "activate-space", spaceId, expectedVersion: 3 }),
      }),
    );

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toMatchObject({ result: "focus-zone-updated" });
  });

  it("refuses a space command from a caller that cannot prove the window", async () => {
    const handler = spaceRouteFixture(() => ({ result: "focus-zone-updated" }));

    const response = await handler(
      new Request("http://127.0.0.1/api/zen/spaces", {
        method: "POST",
        body: JSON.stringify({ command: "add-space", name: "Review", expectedVersion: 1 }),
      }),
    );

    expect(response?.status).toBe(401);
  });

  it("refuses a space command whose body is not one of the space commands", async () => {
    const handler = spaceRouteFixture(() => ({ result: "focus-zone-updated" }));

    const response = await handler(
      new Request("http://127.0.0.1/api/zen/spaces", {
        method: "POST",
        headers: { "x-octant-window-capability": capability },
        body: JSON.stringify({ command: "add-space", name: "" }),
      }),
    );

    expect(response?.status).toBe(400);
  });

  it("reports a space command the window's zone has moved past as a conflict", async () => {
    const handler = spaceRouteFixture(() => {
      throw new ZenError({ reason: "stale-version" });
    });

    const response = await handler(
      new Request("http://127.0.0.1/api/zen/spaces", {
        method: "POST",
        headers: { "x-octant-window-capability": capability },
        body: JSON.stringify({ command: "add-space", name: "Review", expectedVersion: 1 }),
      }),
    );

    expect(response?.status).toBe(409);
  });
});

describe("Zen terminal routes", () => {
  const terminalRequest = {
    threadId: "77777777-7777-4777-8777-777777777777",
    checkoutId: "88888888-8888-4888-8888-888888888888",
    terminalId: "99999999-9999-4999-8999-999999999999",
    expectedVersion: 2,
  };

  function terminalRouteFixture(attachTerminal: () => unknown) {
    const windowAuthorityStore = new WindowAuthorityStore();
    windowAuthorityStore.register({ windowId, capability, now: 0 });
    return createZenRouteHandler({
      windowAuthorityStore,
      zenService: {
        attachTerminal: vi.fn(async () => attachTerminal()),
        handleCommand: vi.fn(),
      } as never,
      now: () => 0,
    });
  }

  it("pins a terminal for the window that proved its own identity", async () => {
    const handler = terminalRouteFixture(() => ({ result: "terminal-attached" }));

    const response = await handler(
      new Request("http://127.0.0.1/api/zen/terminals/attach", {
        method: "POST",
        headers: { "x-octant-window-capability": capability },
        body: JSON.stringify(terminalRequest),
      }),
    );

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toMatchObject({ result: "terminal-attached" });
  });

  it("refuses a terminal card the caller wrote itself instead of naming a terminal", async () => {
    const handler = terminalRouteFixture(() => ({ result: "terminal-attached" }));

    const response = await handler(
      new Request("http://127.0.0.1/api/zen/command", {
        method: "POST",
        headers: { "x-octant-window-capability": capability },
        body: JSON.stringify({
          command: "add-element",
          spaceId: "12121212-1212-4212-8212-121212121212",
          expectedVersion: 2,
          element: {
            elementId: "13131313-1313-4313-8313-131313131313",
            kind: "terminal",
            sourceContext: {
              hostId: LOCAL_HOST_ID,
              mode: "code",
              projectId: null,
              threadKind: "code",
              threadId: terminalRequest.threadId,
            },
            checkoutId: terminalRequest.checkoutId,
            terminalId: terminalRequest.terminalId,
            geometry: { x: 0, y: 0, width: 520, height: 320 },
            zIndex: 1,
            minimized: false,
            locked: false,
          },
        }),
      }),
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toMatchObject({
      error: expect.stringContaining("pinned by naming it"),
    });
  });

  it("refuses to pin a terminal for a caller that cannot prove the window", async () => {
    const handler = terminalRouteFixture(() => ({ result: "terminal-attached" }));

    const response = await handler(
      new Request("http://127.0.0.1/api/zen/terminals/attach", {
        method: "POST",
        body: JSON.stringify(terminalRequest),
      }),
    );

    expect(response?.status).toBe(401);
  });
});
