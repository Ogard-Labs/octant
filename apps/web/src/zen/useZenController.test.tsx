import type {
  ZenBootstrapResponse,
  ZenCommand,
  ZenElementId,
  ZenFocusZone,
  ZenFocusZoneCommand,
  ZenFocusZoneResult,
  ZenResult,
  ZenSpace,
  ZenSpaceId,
} from "@octant/contracts/zen";
import {
  DEFAULT_ZEN_APPEARANCE,
  DEFAULT_ZEN_VIEWPORT,
  MAX_ZEN_BACKGROUND_BYTES,
} from "@octant/contracts/zen";
import type { AggregateVersion } from "@octant/contracts/events";
import { decodeWindowId } from "@octant/contracts/shell";
import type { ZenClient } from "@octant/client-runtime/zen-client";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useZenController, ZEN_PRESENTATION_STORAGE_PREFIX } from "./useZenController";
import { catalogRef, entry } from "./ZenThreadPicker.test-fixture";

const windowId = decodeWindowId("00000000-0000-4000-8000-000000000901");
const spaceId = "00000000-0000-4000-8000-000000000902" as ZenSpaceId;

function makeSpace(overrides: Partial<ZenSpace> = {}): ZenSpace {
  return {
    spaceId,
    windowId,
    version: 1 as AggregateVersion,
    elements: [],
    viewport: DEFAULT_ZEN_VIEWPORT,
    appearance: DEFAULT_ZEN_APPEARANCE,
    active: false,
    barCollapsed: false,
    assistant: null,
    createdAt: "2026-07-26T12:00:00.000Z" as ZenSpace["createdAt"],
    updatedAt: "2026-07-26T12:00:00.000Z" as ZenSpace["updatedAt"],
    ...overrides,
  };
}

/** The one-space focus zone a window has until someone adds a second space. */
function makeZone(space: ZenSpace | null): ZenFocusZone | null {
  if (space === null) return null;
  return {
    windowId,
    version: 1 as AggregateVersion,
    spaces: [{ spaceId: space.spaceId, name: "Focus", position: 0 }],
    activeSpaceId: space.spaceId,
    createdAt: space.createdAt,
    updatedAt: space.updatedAt,
  };
}

function createClient(overrides: Partial<ZenClient> = {}): ZenClient {
  let space: ZenSpace | null = null;
  return {
    space: vi.fn(
      async (command: ZenFocusZoneCommand): Promise<ZenFocusZoneResult> =>
        overrides.space !== undefined
          ? await overrides.space(command)
          : Promise.reject(new Error("This window holds one space.")),
    ),
    bootstrap: vi.fn(async (): Promise<ZenBootstrapResponse> => {
      const result =
        overrides.bootstrap !== undefined
          ? await overrides.bootstrap()
          : { space: null as ZenSpace | null, focusZone: null, windowId };
      space = result.space;
      return result as ZenBootstrapResponse;
    }),
    command: vi.fn(async (cmd: ZenCommand): Promise<ZenResult> => {
      if (cmd.command === "create-space") {
        space = makeSpace({ active: true });
        return { result: "create-space", space };
      }
      if (cmd.command === "recover") {
        return { result: "recover" };
      }
      if (cmd.command === "set-presentation") {
        if (space === null) throw new Error("No space for set-presentation.");
        space = makeSpace({
          version: (cmd.expectedVersion + 1) as AggregateVersion,
          active: typeof cmd.active === "boolean" ? cmd.active : space.active,
          barCollapsed:
            typeof cmd.barCollapsed === "boolean" ? cmd.barCollapsed : space.barCollapsed,
        });
        return { result: "mutation", space };
      }
      if (space === null) throw new Error("No space for mutation.");
      space = makeSpace({
        version: (cmd.expectedVersion + 1) as AggregateVersion,
        active: space.active,
        barCollapsed: space.barCollapsed,
      });
      return { result: "mutation", space };
    }),
    searchThreads: vi.fn() as never,
    attachThread: vi.fn() as never,
    continueThread: vi.fn() as never,
    assistant: vi.fn() as never,
    ensureAssistant: vi.fn() as never,
    uploadBackground: vi.fn() as never,
    readBackground: vi.fn() as never,
    ...overrides,
  };
}

afterEach(() => {
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("useZenController", () => {
  it("enters Zen by creating a space when bootstrap has none", async () => {
    const client = createClient();
    const { result } = renderHook(() =>
      useZenController({ client, windowId, storage: window.sessionStorage }),
    );

    await act(async () => {
      await result.current.enterZen();
    });

    expect(result.current.active).toBe(true);
    expect(result.current.space?.spaceId).toBe(spaceId);
    // Once to find there is no space, once more to read the focus zone that
    // creating the first space opened.
    expect(client.bootstrap).toHaveBeenCalledTimes(2);
    expect(client.command).toHaveBeenCalledWith(
      expect.objectContaining({ command: "create-space", windowId }),
    );
    expect(window.sessionStorage.getItem(`${ZEN_PRESENTATION_STORAGE_PREFIX}${windowId}`)).toBe(
      "active",
    );
  });

  it("creates and controls timers only through authoritative commands", async () => {
    const timerId = "00000000-0000-4000-8000-000000000904" as ZenElementId;
    const idleTimer = {
      elementId: timerId,
      kind: "timer" as const,
      durationMs: 25 * 60 * 1000,
      remainingMs: 25 * 60 * 1000,
      status: "idle" as const,
      startedAt: null,
      deadlineAt: null,
      clockSessionId: null,
      monotonicStartedMs: null,
      geometry: { x: 64, y: 96, width: 360, height: 220 },
      zIndex: 1,
      minimized: false,
      locked: false,
    };
    const initial = makeSpace({ active: true });
    const created = makeSpace({
      version: 2 as AggregateVersion,
      active: true,
      elements: [idleTimer],
    });
    const running = makeSpace({
      version: 3 as AggregateVersion,
      active: true,
      elements: [
        {
          ...idleTimer,
          status: "running",
          startedAt: "2026-07-29T08:00:00.000Z" as never,
          deadlineAt: "2026-07-29T08:25:00.000Z" as never,
          clockSessionId: "server-session",
          monotonicStartedMs: 10_000,
        },
      ],
    });
    const client = createClient({
      bootstrap: vi.fn(async () => ({ space: initial, focusZone: makeZone(initial), windowId })),
      command: vi
        .fn()
        .mockResolvedValueOnce({ result: "mutation", space: created })
        .mockResolvedValueOnce({ result: "mutation", space: running }),
    });
    const { result } = renderHook(() => useZenController({ client, windowId }));

    await act(async () => {
      await result.current.enterZen();
    });
    await act(async () => {
      await result.current.addTimer(25 * 60 * 1000);
    });
    await act(async () => {
      await result.current.timerAction(timerId, "start");
    });

    expect(client.command).toHaveBeenNthCalledWith(1, {
      command: "create-timer",
      spaceId,
      durationMs: 25 * 60 * 1000,
      expectedVersion: 1,
    });
    expect(client.command).toHaveBeenNthCalledWith(2, {
      command: "timer-action",
      spaceId,
      elementId: timerId,
      action: "start",
      expectedVersion: 2,
    });
    expect(result.current.space?.elements[0]).toMatchObject({ status: "running" });
  });

  it("provides manual thread attachment and persistent assistant fallback state", async () => {
    const attachedSpace = makeSpace({
      version: 2 as AggregateVersion,
      elements: [
        {
          elementId: "00000000-0000-4000-8000-000000000903" as ZenElementId,
          kind: "thread",
          sourceContext: entry.sourceContext,
          geometry: { x: 64, y: 96, width: 420, height: 260 },
          zIndex: 1,
          minimized: false,
          locked: false,
        },
      ],
    });
    const assistant = {
      status: "ready" as const,
      binding: {
        threadId: entry.threadId as never,
        providerId: String(entry.providerInstanceId),
        modelId: String(entry.modelId),
      },
      provider: {
        providerInstanceId: entry.providerInstanceId,
        providerLabel: "Local provider",
        modelId: entry.modelId,
        modelLabel: "Local model",
        readiness: "ready" as const,
        toolCapability: "unsupported" as const,
        toolCapabilityReason: "Use manual controls.",
      },
      transcript: [],
      manualControls: ["threads", "widgets", "add", "placement", "appearance"] as const,
    };
    const proposed = {
      ...assistant,
      recipePreview: {
        previewId: "00000000-0000-4000-8000-000000000921" as never,
        recipe: {
          recipeId: "00000000-0000-4000-8000-000000000922" as never,
          name: "Release focus",
          primitives: ["checklist"] as const,
          fields: [],
        },
        providerInstanceId: entry.providerInstanceId,
        modelId: entry.modelId,
        expectedVersion: 2 as AggregateVersion,
        createdAt: "2026-07-29T12:00:00.000Z" as never,
        expiresAt: "2026-07-29T12:10:00.000Z" as never,
      },
    };
    const client = createClient({
      searchThreads: vi.fn(async () => ({ query: "", entries: [entry] })),
      attachThread: vi.fn(async () => ({
        result: "thread-attached" as const,
        entry,
        elementId: attachedSpace.elements[0]!.elementId,
        space: attachedSpace,
      })),
      ensureAssistant: vi.fn(async () => assistant),
      // What the host holds for this window once a turn has been answered.
      assistant: vi.fn(async () => proposed),
    });
    const { result } = renderHook(() =>
      useZenController({ client, windowId, storage: window.sessionStorage }),
    );

    await act(async () => {
      await result.current.enterZen();
      await result.current.openThreads();
    });
    expect(result.current.threadPickerOpen).toBe(true);
    expect(result.current.threadEntries).toEqual([entry]);

    await act(async () => {
      await result.current.attachThread(catalogRef);
      await result.current.openAssistant();
      await result.current.openThreads();
    });
    expect(result.current.threadPickerOpen).toBe(true);
    expect(result.current.assistantOpen).toBe(false);

    await act(async () => {
      await result.current.openAssistant();
    });
    // Opening reports only what the host had before the turn.
    expect(result.current.assistant?.recipePreview ?? null).toBeNull();

    await act(async () => {
      await result.current.refreshAssistant();
    });
    expect(result.current.threadPickerOpen).toBe(false);
    expect(result.current.space?.elements[0]).toMatchObject({
      kind: "thread",
      sourceContext: entry.sourceContext,
    });
    expect(result.current.assistantOpen).toBe(true);
    expect(result.current.assistant?.provider?.toolCapability).toBe("unsupported");
    // The proposal a turn made is Zen's, and only this read brings it back.
    expect(result.current.assistant?.recipePreview).toMatchObject({
      recipe: { name: "Release focus" },
    });
    expect(client.attachThread).toHaveBeenCalledWith({ catalogRef, expectedVersion: 1 });
  });

  it("restores an active space from the server on mount when session is active", async () => {
    window.sessionStorage.setItem(`${ZEN_PRESENTATION_STORAGE_PREFIX}${windowId}`, "active");
    const space = makeSpace({ active: true });
    const client = createClient({
      bootstrap: vi.fn(async () => ({ space, focusZone: makeZone(space), windowId })),
    });

    const { result } = renderHook(() =>
      useZenController({ client, windowId, storage: window.sessionStorage }),
    );

    await waitFor(() => {
      expect(result.current.active).toBe(true);
      expect(result.current.space?.spaceId).toBe(spaceId);
    });
  });

  it("rejects oversized background selections before allocating bytes or calling the client", async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    const uploadBackground = vi.fn(async (): Promise<ZenSpace> => makeSpace());
    const file = {
      name: "oversized.png",
      size: MAX_ZEN_BACKGROUND_BYTES + 1,
      type: "image/png",
      arrayBuffer,
    } as unknown as File;
    const client = createClient({
      bootstrap: vi.fn(async () =>
        (() => {
          const only = makeSpace();
          return { space: only, focusZone: makeZone(only), windowId };
        })(),
      ),
      uploadBackground,
    });
    const { result } = renderHook(() => useZenController({ client, windowId }));

    await act(async () => {
      await result.current.enterZen();
    });

    await expect(result.current.uploadBackground(file)).rejects.toThrow("too large");
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(uploadBackground).not.toHaveBeenCalled();
  });

  it("loads the still-frame asset when Reduced Motion is on", async () => {
    const assetId = "00000000-0000-4000-8000-000000000907" as never;
    const stillAssetId = "00000000-0000-4000-8000-000000000908" as never;
    const space = makeSpace({
      active: true,
      appearance: {
        ...DEFAULT_ZEN_APPEARANCE,
        background: {
          kind: "image",
          assetId,
          stillAssetId,
          overlay: 20,
          fill: "cover",
        },
      },
    });
    const matchMedia = vi.fn().mockReturnValue({ matches: true });
    vi.stubGlobal("matchMedia", matchMedia);
    const createObjectURL = vi.fn<(blob: Blob) => string>().mockReturnValue("blob:zen-still");
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL: vi.fn() });
    const client = createClient({
      bootstrap: vi.fn(async () => ({ space, focusZone: makeZone(space), windowId })),
      readBackground: vi.fn(async () => new Blob([new Uint8Array([1])], { type: "image/gif" })),
    });
    const { result } = renderHook(() => useZenController({ client, windowId }));
    await act(async () => {
      await result.current.enterZen();
    });
    await waitFor(() => {
      expect(result.current.backgroundObjectUrl).toBe("blob:zen-still");
    });
    expect(client.readBackground).toHaveBeenCalledWith(stillAssetId);
    expect(matchMedia).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
  });

  it("uses bounded object URLs for image backgrounds and revokes replaced and unmounted URLs", async () => {
    const firstAssetId = "00000000-0000-4000-8000-000000000905" as never;
    const secondAssetId = "00000000-0000-4000-8000-000000000906" as never;
    const first = makeSpace({
      active: true,
      appearance: {
        ...DEFAULT_ZEN_APPEARANCE,
        background: { kind: "image", assetId: firstAssetId, overlay: 40, fill: "cover" },
      },
    });
    const second = makeSpace({
      version: 2 as AggregateVersion,
      active: true,
      appearance: {
        ...DEFAULT_ZEN_APPEARANCE,
        background: { kind: "image", assetId: secondAssetId, overlay: 40, fill: "cover" },
      },
    });
    const createObjectURL = vi
      .fn<(blob: Blob) => string>()
      .mockReturnValueOnce("blob:zen-first")
      .mockReturnValueOnce("blob:zen-second");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const client = createClient({
      bootstrap: vi.fn(async () => ({ space: first, focusZone: makeZone(first), windowId })),
      command: vi.fn(async (): Promise<ZenResult> => ({ result: "mutation", space: second })),
      readBackground: vi.fn(async () => new Blob([new Uint8Array([1])], { type: "image/png" })),
    });
    const { result, unmount } = renderHook(() => useZenController({ client, windowId }));

    await act(async () => {
      await result.current.enterZen();
    });
    await waitFor(() => {
      expect(result.current.backgroundObjectUrl).toBe("blob:zen-first");
    });
    await act(async () => {
      await result.current.updateAppearance(second.appearance);
    });
    await waitFor(() => {
      expect(result.current.backgroundObjectUrl).toBe("blob:zen-second");
    });

    expect(client.readBackground).toHaveBeenNthCalledWith(1, firstAssetId);
    expect(client.readBackground).toHaveBeenNthCalledWith(2, secondAssetId);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:zen-first");
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:zen-second");
  });

  it("exits Zen without clearing the durable space", async () => {
    const client = createClient({
      bootstrap: vi.fn(async () =>
        (() => {
          const only = makeSpace();
          return { space: only, focusZone: makeZone(only), windowId };
        })(),
      ),
    });
    const { result } = renderHook(() =>
      useZenController({ client, windowId, storage: window.sessionStorage }),
    );

    await act(async () => {
      await result.current.enterZen();
    });
    act(() => {
      result.current.exitZen();
    });

    expect(result.current.active).toBe(false);
    expect(result.current.space?.spaceId).toBe(spaceId);
    expect(window.sessionStorage.getItem(`${ZEN_PRESENTATION_STORAGE_PREFIX}${windowId}`)).toBe(
      null,
    );
  });

  it("falls back to the normal shell with Recover Zen when bootstrap fails", async () => {
    const client = createClient({
      bootstrap: vi.fn(async () => {
        throw new Error("Zen is unavailable.");
      }),
    });
    window.sessionStorage.setItem(`${ZEN_PRESENTATION_STORAGE_PREFIX}${windowId}`, "active");

    const { result } = renderHook(() =>
      useZenController({ client, windowId, storage: window.sessionStorage }),
    );

    await waitFor(() => {
      expect(result.current.active).toBe(false);
      expect(result.current.recoveryNeeded).toBe(true);
      expect(result.current.message).toMatch(/unavailable|recover/i);
    });
  });

  it("recovers by resetting the space and re-entering Zen", async () => {
    const space = makeSpace({ active: true });
    const client = createClient({
      bootstrap: vi
        .fn()
        .mockResolvedValueOnce({ space, focusZone: makeZone(space), windowId })
        .mockResolvedValueOnce({
          space: makeSpace({ version: 2 as AggregateVersion, active: true, elements: [] }),
          windowId,
        }),
      command: vi.fn(async (cmd: ZenCommand): Promise<ZenResult> => {
        if (cmd.command === "recover") return { result: "recover" };
        return { result: "mutation", space: makeSpace({ version: 2 as AggregateVersion }) };
      }),
    });

    const { result } = renderHook(() =>
      useZenController({ client, windowId, storage: window.sessionStorage }),
    );

    await act(async () => {
      await result.current.enterZen();
    });
    await act(async () => {
      await result.current.recoverZen();
    });

    expect(client.command).toHaveBeenCalledWith(
      expect.objectContaining({ command: "recover", spaceId, expectedVersion: 1 }),
    );
    expect(result.current.active).toBe(true);
    expect(result.current.recoveryNeeded).toBe(false);
  });

  it("collapses and restores the Navigator Bar without losing exit", () => {
    const client = createClient();
    const { result } = renderHook(() => useZenController({ client, windowId }));

    act(() => {
      result.current.setBarCollapsed(true);
    });
    expect(result.current.barCollapsed).toBe(true);
    act(() => {
      result.current.setBarCollapsed(false);
    });
    expect(result.current.barCollapsed).toBe(false);
  });

  it("rolls back optimistic element updates when the server rejects them", async () => {
    const space = makeSpace({
      elements: [
        {
          elementId: "00000000-0000-4000-8000-000000000903" as ZenElementId,
          kind: "notes",
          widgetVersion: 0 as AggregateVersion,
          content: "note",
          geometry: { x: 10, y: 10, width: 240, height: 160 },
          zIndex: 1,
          minimized: false,
          locked: false,
        },
      ],
    });
    const client = createClient({
      bootstrap: vi.fn(async () => ({ space, focusZone: makeZone(space), windowId })),
      command: vi.fn(async () => {
        throw new Error("rejected-update");
      }),
    });
    const { result } = renderHook(() => useZenController({ client, windowId }));

    await act(async () => {
      await result.current.enterZen();
    });

    const updated = {
      ...space.elements[0]!,
      geometry: { x: 80, y: 10, width: 240, height: 160 },
    };

    await act(async () => {
      await result.current.updateElement(updated);
    });

    expect(result.current.space?.elements[0]?.geometry.x).toBe(10);
    expect(result.current.message).toMatch(/stale|failed|rejected/i);
  });

  it("refreshes the server snapshot after a typed stale-version conflict", async () => {
    const localSpace = makeSpace({ version: 1 as AggregateVersion, active: true });
    const serverSpace = makeSpace({
      version: 2 as AggregateVersion,
      active: true,
      viewport: { panX: 80, panY: 20, scale: 1.25 },
    });
    const client = createClient({
      bootstrap: vi
        .fn()
        .mockResolvedValueOnce({ space: localSpace, focusZone: makeZone(localSpace), windowId })
        .mockResolvedValueOnce({ space: serverSpace, focusZone: makeZone(serverSpace), windowId }),
      command: vi.fn(async () => {
        throw new Error("Zen error: stale-version");
      }),
    });
    const { result } = renderHook(() =>
      useZenController({ client, windowId, storage: window.sessionStorage }),
    );

    await act(async () => {
      await result.current.enterZen();
    });
    await act(async () => {
      await result.current.updateViewport({ panX: 10, panY: 10, scale: 1.1 });
    });

    expect(client.bootstrap).toHaveBeenCalledTimes(2);
    expect(result.current.space?.version).toBe(2);
    expect(result.current.space?.viewport).toEqual(serverSpace.viewport);
    expect(result.current.message).toMatch(/changed|refresh/i);
  });

  it("creates and saves a versioned Notes widget through typed commands", async () => {
    const initial = makeSpace({ active: true });
    const notes = {
      elementId: "00000000-0000-4000-8000-000000000903" as ZenElementId,
      kind: "notes" as const,
      widgetVersion: 0 as AggregateVersion,
      content: "",
      geometry: { x: 64, y: 96, width: 420, height: 260 },
      zIndex: 1,
      minimized: false,
      locked: false,
    };
    const created = makeSpace({ version: 2 as AggregateVersion, active: true, elements: [notes] });
    const saved = makeSpace({
      version: 3 as AggregateVersion,
      active: true,
      elements: [{ ...notes, widgetVersion: 1 as AggregateVersion, content: "Durable" }],
    });
    const client = createClient({
      bootstrap: vi.fn(async () => ({ space: initial, focusZone: makeZone(initial), windowId })),
      command: vi
        .fn()
        .mockResolvedValueOnce({ result: "mutation", space: created })
        .mockResolvedValueOnce({ result: "mutation", space: saved }),
    });
    const { result } = renderHook(() => useZenController({ client, windowId }));

    await act(async () => {
      await result.current.enterZen();
    });
    await act(async () => {
      await result.current.createWidget("notes");
    });
    await act(async () => {
      await result.current.saveNotes(notes.elementId, "Durable", notes.widgetVersion);
    });

    expect(client.command).toHaveBeenNthCalledWith(1, {
      command: "create-widget",
      spaceId,
      kind: "notes",
      expectedVersion: 1,
    });
    expect(client.command).toHaveBeenNthCalledWith(2, {
      command: "save-notes",
      spaceId,
      elementId: notes.elementId,
      content: "Durable",
      expectedVersion: 2,
      expectedWidgetVersion: 0,
    });
    expect(result.current.space).toEqual(saved);
  });

  it("refreshes after a stale widget conflict and rejects the local save honestly", async () => {
    const notes = {
      elementId: "00000000-0000-4000-8000-000000000903" as ZenElementId,
      kind: "notes" as const,
      widgetVersion: 1 as AggregateVersion,
      content: "Server copy",
      geometry: { x: 64, y: 96, width: 420, height: 260 },
      zIndex: 1,
      minimized: false,
      locked: false,
    };
    const initial = makeSpace({ version: 2 as AggregateVersion, active: true, elements: [notes] });
    const refreshed = makeSpace({
      version: 3 as AggregateVersion,
      active: true,
      elements: [{ ...notes, widgetVersion: 2 as AggregateVersion, content: "Newer copy" }],
    });
    const client = createClient({
      bootstrap: vi
        .fn()
        .mockResolvedValueOnce({ space: initial, focusZone: makeZone(initial), windowId })
        .mockResolvedValueOnce({ space: refreshed, focusZone: makeZone(refreshed), windowId }),
      command: vi.fn(async () => {
        throw new Error("Zen error: stale-widget-version");
      }),
    });
    const { result } = renderHook(() => useZenController({ client, windowId }));

    await act(async () => {
      await result.current.enterZen();
    });
    let rejected: unknown;
    await act(async () => {
      try {
        await result.current.saveNotes(notes.elementId, "Local draft", notes.widgetVersion);
      } catch (error) {
        rejected = error;
      }
    });

    expect(String(rejected)).toMatch(/stale-widget-version/);
    expect(client.bootstrap).toHaveBeenCalledTimes(2);
    expect(result.current.space).toEqual(refreshed);
    expect(result.current.message).toMatch(/changed|refresh/i);
  });

  it("sends barCollapsed to the server when the Navigator Bar is toggled", async () => {
    const client = createClient();
    const { result } = renderHook(() => useZenController({ client, windowId }));

    await act(async () => {
      await result.current.enterZen();
    });
    act(() => {
      result.current.setBarCollapsed(true);
    });
    await waitFor(() => {
      expect(result.current.barCollapsed).toBe(true);
    });

    expect(client.command).toHaveBeenLastCalledWith(
      expect.objectContaining({ command: "set-presentation", barCollapsed: true }),
    );
  });

  it("serializes exit behind an in-flight bar collapse and keeps it authoritative", async () => {
    const client = createClient();
    const pending: Array<{ resolve: (space: ZenSpace) => void; cmd: ZenCommand }> = [];
    client.command = vi.fn(async (cmd: ZenCommand): Promise<ZenResult> => {
      if (cmd.command === "create-space") {
        return { result: "create-space", space: makeSpace({ active: true }) };
      }
      if (cmd.command === "set-presentation") {
        return new Promise((resolve) => {
          pending.push({
            resolve: (space) => resolve({ result: "mutation", space }),
            cmd,
          });
        });
      }
      return {
        result: "mutation",
        space: makeSpace({ version: (cmd as any).expectedVersion + 1 }),
      };
    });

    const { result } = renderHook(() => useZenController({ client, windowId }));

    await act(async () => {
      await result.current.enterZen();
    });

    act(() => {
      result.current.setBarCollapsed(true);
    });
    act(() => {
      result.current.exitZen();
    });

    // Only the collapse command should be in flight while it is unresolved;
    // exit must wait and use the returned version.
    await waitFor(() => expect(pending.length).toBe(1));
    const collapse = pending[0]!;
    expect(collapse.cmd).toMatchObject({
      command: "set-presentation",
      barCollapsed: true,
      expectedVersion: 1,
    });

    collapse.resolve(
      makeSpace({ version: 2 as AggregateVersion, active: true, barCollapsed: true }),
    );

    await waitFor(() => expect(pending.length).toBe(2));
    const exit = pending[1]!;
    expect(exit.cmd).toMatchObject({
      command: "set-presentation",
      active: false,
      expectedVersion: 2,
    });

    exit.resolve(makeSpace({ version: 3 as AggregateVersion, active: false, barCollapsed: true }));

    await waitFor(() => expect(result.current.active).toBe(false));
  });

  it("sends active false to the server on exit", async () => {
    const client = createClient();
    const { result } = renderHook(() => useZenController({ client, windowId }));

    await act(async () => {
      await result.current.enterZen();
    });
    act(() => {
      result.current.exitZen();
    });
    await waitFor(() => {
      expect(client.command).toHaveBeenLastCalledWith(
        expect.objectContaining({ command: "set-presentation", active: false }),
      );
    });
    expect(result.current.active).toBe(false);
  });

  it("keeps exit inactive when the set-presentation request is rejected", async () => {
    const client = createClient({
      command: vi.fn(async (cmd: ZenCommand): Promise<ZenResult> => {
        if (cmd.command === "create-space") {
          return { result: "create-space", space: makeSpace({ active: true }) };
        }
        if (cmd.command === "set-presentation" && cmd.active === false) {
          throw new Error("Server refused to save the exit state.");
        }
        return {
          result: "mutation",
          space: makeSpace({ version: (cmd as any).expectedVersion + 1 }),
        };
      }),
    });

    const { result } = renderHook(() => useZenController({ client, windowId }));

    await act(async () => {
      await result.current.enterZen();
    });

    act(() => {
      result.current.exitZen();
    });

    await waitFor(() => {
      expect(client.command).toHaveBeenLastCalledWith(
        expect.objectContaining({ command: "set-presentation", active: false }),
      );
    });

    await waitFor(() => {
      expect(result.current.message).toMatch(/exit|save|workspace/i);
    });
    expect(result.current.active).toBe(false);
    expect(result.current.recoveryNeeded).toBe(false);
  });

  it("keeps exit inactive when stale-version refresh returns active=true", async () => {
    const client = createClient({
      command: vi.fn(async (cmd: ZenCommand): Promise<ZenResult> => {
        if (cmd.command === "create-space") {
          return { result: "create-space", space: makeSpace({ active: true }) };
        }
        if (cmd.command === "set-presentation" && cmd.active === false) {
          throw new Error("stale-version conflict");
        }
        return {
          result: "mutation",
          space: makeSpace({ version: (cmd as any).expectedVersion + 1 }),
        };
      }),
      bootstrap: (() => {
        let calls = 0;
        return vi.fn(async (): Promise<ZenBootstrapResponse> => {
          calls++;
          if (calls === 1) return { space: null as ZenSpace | null, focusZone: null, windowId };
          const only = makeSpace({ version: 3 as AggregateVersion, active: true });
          return { space: only, focusZone: makeZone(only), windowId };
        });
      })(),
    });

    const { result } = renderHook(() => useZenController({ client, windowId }));

    await act(async () => {
      await result.current.enterZen();
    });

    act(() => {
      result.current.exitZen();
    });

    await waitFor(() => {
      expect(client.command).toHaveBeenLastCalledWith(
        expect.objectContaining({ command: "set-presentation", active: false }),
      );
    });

    await waitFor(() => {
      expect(result.current.message).toMatch(/exit|refresh|available|workspace/i);
    });
    expect(result.current.active).toBe(false);
  });
});

describe("useZenController focus zone", () => {
  const second = "00000000-0000-4000-8000-000000000905" as ZenSpaceId;

  function twoSpaceZone(activeSpaceId: ZenSpaceId): ZenFocusZone {
    return {
      windowId,
      version: 2 as AggregateVersion,
      spaces: [
        { spaceId, name: "Focus", position: 0 },
        { spaceId: second, name: "Review", position: 1 },
      ],
      activeSpaceId,
      createdAt: "2026-07-26T12:00:00.000Z" as ZenFocusZone["createdAt"],
      updatedAt: "2026-07-26T12:00:00.000Z" as ZenFocusZone["updatedAt"],
    };
  }

  it("shows the space the switcher picked, adopting the zone the server returned", async () => {
    const showing = makeSpace({ spaceId: second, active: true });
    const client = createClient({
      bootstrap: vi.fn(async () => ({
        space: makeSpace({ active: true }),
        focusZone: twoSpaceZone(spaceId),
        windowId,
      })),
      space: vi.fn(async () => ({
        result: "focus-zone-updated" as const,
        zone: twoSpaceZone(second),
        space: showing,
      })),
    });
    const { result } = renderHook(() => useZenController({ client, windowId }));

    await act(async () => {
      await result.current.enterZen();
    });
    await act(async () => {
      await result.current.showSpace(second);
    });

    expect(client.space).toHaveBeenCalledWith({
      command: "activate-space",
      spaceId: second,
      expectedVersion: 2,
    });
    expect(result.current.space?.spaceId).toBe(second);
    expect(result.current.focusZone?.activeSpaceId).toBe(second);
  });

  it("wraps to the first space when cycling past the last one", async () => {
    const client = createClient({
      bootstrap: vi.fn(async () => ({
        space: makeSpace({ spaceId: second, active: true }),
        focusZone: twoSpaceZone(second),
        windowId,
      })),
      space: vi.fn(async () => ({
        result: "focus-zone-updated" as const,
        zone: twoSpaceZone(spaceId),
        space: makeSpace({ active: true }),
      })),
    });
    const { result } = renderHook(() => useZenController({ client, windowId }));

    await act(async () => {
      await result.current.enterZen();
    });
    await act(async () => {
      await result.current.cycleSpace(1);
    });

    expect(client.space).toHaveBeenCalledWith(
      expect.objectContaining({ command: "activate-space", spaceId }),
    );
  });

  it("reports a space command the window's zone has moved past rather than switching", async () => {
    const client = createClient({
      bootstrap: vi.fn(async () => ({
        space: makeSpace({ active: true }),
        focusZone: twoSpaceZone(spaceId),
        windowId,
      })),
      space: vi.fn(async () => {
        throw new Error("Zen error: stale-version");
      }),
    });
    const { result } = renderHook(() => useZenController({ client, windowId }));

    await act(async () => {
      await result.current.enterZen();
    });
    await act(async () => {
      await result.current.showSpace(second);
    });

    expect(result.current.space?.spaceId).toBe(spaceId);
    expect(result.current.message).toMatch(/stale-version/);
  });
});
