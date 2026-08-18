import {
  LOCAL_HOST_ID,
  decodeChatThreadId,
  decodeCodeCheckoutId,
  decodeCodeThreadId,
  decodeProjectId,
  decodeProviderInstanceId,
  decodeWindowId,
  decodeZenElementId,
  decodeZenSpace,
  decodeZenSpaceId,
  decodeZenThreadCatalogEntry,
  decodeZenThreadCatalogRef,
  type AggregateVersion,
} from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { createZenClient } from "./zenClient";

const threadId = decodeChatThreadId("00000000-0000-4000-8000-000000000001");
const catalogRef = decodeZenThreadCatalogRef(`chat:${threadId}`);
const windowId = decodeWindowId("00000000-0000-4000-8000-000000000002");
const projectId = decodeProjectId("00000000-0000-4000-8000-000000000003");
const providerId = decodeProviderInstanceId("00000000-0000-4000-8000-000000000004");
const elementId = decodeZenElementId("00000000-0000-4000-8000-000000000005");
const entry = decodeZenThreadCatalogEntry({
  catalogRef,
  hostId: LOCAL_HOST_ID,
  hostLabel: "This Mac",
  mode: "chat",
  projectId,
  projectLabel: "Release",
  threadId,
  title: "Release blocker",
  status: "active",
  recentActivityAt: "2026-07-28T12:00:00.000Z",
  providerInstanceId: providerId,
  modelId: "model-local",
  sourceContext: {
    hostId: LOCAL_HOST_ID,
    mode: "chat",
    projectId,
    threadKind: "chat",
    threadId,
  },
});
const space = decodeZenSpace({
  spaceId: decodeZenSpaceId("00000000-0000-4000-8000-000000000006"),
  windowId,
  version: 3,
  elements: [
    {
      elementId,
      kind: "thread",
      sourceContext: entry.sourceContext,
      geometry: { x: 64, y: 96, width: 420, height: 260 },
      zIndex: 1,
      minimized: false,
      locked: false,
    },
  ],
  viewport: { panX: 0, panY: 0, scale: 1 },
  appearance: {
    background: { kind: "solid", color: "#1a1a2e" },
    dimming: 0,
    elementOpacity: 1,
    reducedMotion: false,
    reducedTransparency: false,
    increasedContrast: false,
  },
  assistant: null,
  createdAt: "2026-07-28T12:00:00.000Z",
  updatedAt: "2026-07-28T12:00:00.000Z",
});

describe("ZenClient thread catalog", () => {
  it("uploads and reads backgrounds only through the window capability route", async () => {
    const imageSpace = decodeZenSpace({
      ...space,
      appearance: {
        ...space.appearance,
        background: {
          kind: "image",
          assetId: "00000000-0000-4000-8000-000000000007",
          overlay: 40,
          fill: "cover",
        },
      },
    });
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ space: imageSpace }))
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
      );
    const client = createZenClient({
      baseUrl: "http://127.0.0.1:4242",
      fetch,
      windowCapability: `${"A".repeat(42)}A`,
    });
    const background = imageSpace.appearance.background;
    if (background.kind !== "image") throw new Error("Expected image background.");
    await expect(
      client.uploadBackground({
        spaceId: space.spaceId,
        expectedVersion: space.version,
        bytes: new Uint8Array([1, 2, 3]),
        mediaType: "image/png",
        displayName: "calm.png",
      }),
    ).resolves.toEqual(imageSpace);
    await expect(client.readBackground(background.assetId)).resolves.toBeInstanceOf(Blob);
    expect(fetch.mock.calls[0]).toEqual([
      "http://127.0.0.1:4242/api/zen/backgrounds",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-octant-window-capability": `${"A".repeat(42)}A` }),
      }),
    ]);
    expect(fetch.mock.calls[1]?.[0]).toBe(
      `http://127.0.0.1:4242/api/zen/backgrounds/${background.assetId}`,
    );
  });

  it("sends timer requests without adding renderer clock state", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ result: "mutation", space }))
      .mockResolvedValueOnce(Response.json({ result: "mutation", space }));
    const client = createZenClient({
      baseUrl: "http://127.0.0.1:4242",
      fetch,
      windowCapability: `${"A".repeat(42)}A`,
    });

    await client.command({
      command: "create-timer",
      spaceId: space.spaceId,
      durationMs: 25 * 60 * 1000,
      expectedVersion: space.version,
    });
    await client.command({
      command: "timer-action",
      spaceId: space.spaceId,
      elementId,
      action: "start",
      expectedVersion: space.version,
    });

    expect(fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      {
        command: "create-timer",
        spaceId: space.spaceId,
        durationMs: 25 * 60 * 1000,
        expectedVersion: space.version,
      },
      {
        command: "timer-action",
        spaceId: space.spaceId,
        elementId,
        action: "start",
        expectedVersion: space.version,
      },
    ]);
  });

  it("round-trips typed Notes commands and preserves conflict failures", async () => {
    const notesSpace = decodeZenSpace({
      ...space,
      version: 4,
      elements: [
        {
          elementId,
          kind: "notes",
          widgetVersion: 1,
          content: "Saved",
          geometry: { x: 64, y: 96, width: 420, height: 260 },
          zIndex: 1,
          minimized: false,
          locked: false,
        },
      ],
    });
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ result: "mutation", space: notesSpace }))
      .mockResolvedValueOnce(
        Response.json({ error: "Zen error: stale-widget-version" }, { status: 409 }),
      );
    const client = createZenClient({
      baseUrl: "http://127.0.0.1:4242",
      fetch,
      windowCapability: `${"A".repeat(42)}A`,
    });
    const command = {
      command: "save-notes" as const,
      spaceId: space.spaceId,
      elementId,
      content: "Saved",
      expectedVersion: 3 as AggregateVersion,
      expectedWidgetVersion: 0 as AggregateVersion,
    };

    await expect(client.command(command)).resolves.toEqual({
      result: "mutation",
      space: notesSpace,
    });
    await expect(client.command(command)).rejects.toMatchObject({
      status: 409,
      message: "Zen error: stale-widget-version",
    });
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify(command),
    });
  });

  it("searches, attaches, and continues only by exact catalog reference", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ query: "release", entries: [entry] }))
      .mockResolvedValueOnce(Response.json({ result: "thread-attached", entry, elementId, space }))
      .mockResolvedValueOnce(Response.json({ result: "thread-continuation", entry }));
    const client = createZenClient({
      baseUrl: "http://127.0.0.1:4242",
      fetch,
      windowCapability: `${"A".repeat(42)}A`,
    });

    await expect(client.searchThreads("release")).resolves.toEqual({
      query: "release",
      entries: [entry],
    });
    await expect(
      client.attachThread({ catalogRef, expectedVersion: 2 as AggregateVersion }),
    ).resolves.toMatchObject({
      result: "thread-attached",
      elementId,
    });
    await expect(client.continueThread(catalogRef)).resolves.toEqual({
      result: "thread-continuation",
      entry,
    });

    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "http://127.0.0.1:4242/api/zen/threads?q=release",
      "http://127.0.0.1:4242/api/zen/threads/attach",
      `http://127.0.0.1:4242/api/zen/threads/continue?ref=${encodeURIComponent(catalogRef)}`,
    ]);
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ catalogRef, expectedVersion: 2 }),
    });
  });

  it("switches this window to another of its spaces without touching what is pinned to either", async () => {
    const zone = {
      windowId,
      version: 4,
      spaces: [
        { spaceId: space.spaceId, name: "Focus", position: 0 },
        {
          spaceId: decodeZenSpaceId("00000000-0000-4000-8000-000000000007"),
          name: "Review",
          position: 1,
        },
      ],
      activeSpaceId: space.spaceId,
      createdAt: "2026-07-28T12:00:00.000Z",
      updatedAt: "2026-07-28T12:05:00.000Z",
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ result: "focus-zone-updated", zone, space }));
    const client = createZenClient({
      baseUrl: "http://127.0.0.1:4242",
      fetch,
      windowCapability: `${"A".repeat(42)}A`,
    });

    await expect(
      client.space({
        command: "activate-space",
        spaceId: space.spaceId,
        expectedVersion: 3 as AggregateVersion,
      }),
    ).resolves.toMatchObject({
      result: "focus-zone-updated",
      zone: { activeSpaceId: space.spaceId },
    });
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "http://127.0.0.1:4242/api/zen/spaces",
    ]);
  });

  it("pins a terminal by naming it, never by describing the card", async () => {
    const pinned = {
      result: "terminal-attached" as const,
      elementId,
      space,
    };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(Response.json(pinned));
    const client = createZenClient({
      baseUrl: "http://127.0.0.1:4242",
      fetch,
      windowCapability: `${"A".repeat(42)}A`,
    });

    await expect(
      client.attachTerminal({
        threadId: decodeCodeThreadId("00000000-0000-4000-8000-000000000021"),
        checkoutId: decodeCodeCheckoutId("00000000-0000-4000-8000-000000000022"),
        terminalId: "00000000-0000-4000-8000-000000000023" as never,
        expectedVersion: 3 as AggregateVersion,
      }),
    ).resolves.toMatchObject({ result: "terminal-attached" });
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "http://127.0.0.1:4242/api/zen/terminals/attach",
    ]);
  });

  it("reads and opens this window's assistant surface, and offers no turn of its own", async () => {
    const snapshot = {
      status: "ready" as const,
      binding: { threadId, providerId: providerId, modelId: "model-local" },
      provider: {
        providerInstanceId: providerId,
        providerLabel: "Local provider",
        modelId: "model-local",
        modelLabel: "Local model",
        readiness: "ready" as const,
        toolCapability: "unsupported" as const,
        toolCapabilityReason: "Use the manual Threads control.",
      },
      transcript: [],
      manualControls: ["threads", "widgets", "add", "placement", "appearance"] as const,
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(snapshot))
      .mockResolvedValueOnce(Response.json(snapshot));
    const client = createZenClient({
      baseUrl: "http://127.0.0.1:4242",
      fetch,
      windowCapability: `${"A".repeat(42)}A`,
    });

    await expect(client.assistant()).resolves.toMatchObject({ status: "ready" });
    await expect(client.ensureAssistant()).resolves.toMatchObject({ status: "ready" });
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "http://127.0.0.1:4242/api/zen/assistant",
      "http://127.0.0.1:4242/api/zen/assistant",
    ]);
    // Turns go to the host's Navigator surface, so Zen's client has no way to
    // send one and cannot answer a Zen turn on some other model.
    expect("sendAssistant" in client).toBe(false);
  });
});
