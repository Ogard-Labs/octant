import {
  LOCAL_HOST_ID,
  decodeCanvasId,
  decodeChatThreadId,
  decodeCodeCheckoutId,
  decodeCodeThreadId,
  decodeWorkThreadId,
  decodeHostId,
  decodeProjectId,
  decodeProviderInstanceId,
  decodeWindowId,
  decodeZenElementId,
  decodeZenChecklistItemId,
  decodeZenSpaceId,
  decodeZenThreadCatalogEntry,
  decodeZenThreadCatalogRef,
  type ZenSpace,
  type AggregateVersion,
  type WindowId,
  type ZenFocusZone,
  type ChatThread,
  type ChatThreadView,
} from "@octant/contracts";
import { createZenSpace } from "@octant/domain";
import { describe, expect, it, vi } from "vitest";
import { ZenService } from "./zenService";

/** Each window's focus zone, held only for the life of one test. */
function memoryFocusZone() {
  const byWindow = new Map<string, ZenFocusZone>();
  return {
    read: (windowId: WindowId) => byWindow.get(String(windowId)) ?? null,
    write: (next: ZenFocusZone) => {
      byWindow.set(String(next.windowId), next);
      return next;
    },
  };
}

const ids = {
  window: decodeWindowId("00000000-0000-4000-8000-000000000001"),
  otherWindow: decodeWindowId("00000000-0000-4000-8000-000000000002"),
  space: decodeZenSpaceId("00000000-0000-4000-8000-000000000003"),
  element: decodeZenElementId("00000000-0000-4000-8000-000000000004"),
  item: decodeZenChecklistItemId("00000000-0000-4000-8000-000000000008"),
  otherSpace: decodeZenSpaceId("00000000-0000-4000-8000-000000000009"),
  otherElement: decodeZenElementId("00000000-0000-4000-8000-000000000010"),
  project: decodeProjectId("00000000-0000-4000-8000-000000000005"),
  thread: decodeChatThreadId("00000000-0000-4000-8000-000000000006"),
  /** An ordinary conversation on this host that is nobody's Zen assistant. */
  supersededThread: decodeChatThreadId("00000000-0000-4000-8000-000000000040"),
  provider: decodeProviderInstanceId("00000000-0000-4000-8000-000000000007"),
} as const;

const catalogRef = decodeZenThreadCatalogRef(`chat:${ids.thread}`);
const entry = decodeZenThreadCatalogEntry({
  catalogRef,
  hostId: LOCAL_HOST_ID,
  hostLabel: "This Mac",
  mode: "chat",
  projectId: ids.project,
  projectLabel: "Release",
  threadId: ids.thread,
  title: "Release blocker",
  status: "active",
  recentActivityAt: "2026-07-28T12:00:00.000Z",
  providerInstanceId: ids.provider,
  modelId: "model-local",
  sourceContext: {
    hostId: LOCAL_HOST_ID,
    mode: "chat",
    projectId: ids.project,
    threadKind: "chat",
    threadId: ids.thread,
  },
});

function space(): ZenSpace {
  return {
    ...createZenSpace(ids.window, decodeHostId(LOCAL_HOST_ID)),
    spaceId: ids.space,
    version: 2 as AggregateVersion,
  };
}

function fixture(options: { readonly resolve?: typeof entry | undefined } = {}) {
  let current = space();
  const append = vi.fn((next: ZenSpace, expectedVersion: number) => {
    current = { ...next, version: (expectedVersion + 1) as AggregateVersion };
    return current;
  });
  const resolve = vi.fn(async () => ("resolve" in options ? options.resolve : entry));
  const service = new ZenService({
    focusZone: memoryFocusZone(),
    loadSpace: () => current,
    loadSpaceByWindow: () => current,
    eventStore: {
      append,
      isConcurrencyConflict: () => false,
    } as never,
    localHostId: LOCAL_HOST_ID,
    threadCatalog: { resolve, search: async () => [entry] },
    uuid: () => ids.element,
  });
  return { append, resolve, service };
}

describe("ZenService thread pinning", () => {
  it("resolves the exact catalog reference server-side before persisting its source context", async () => {
    const { append, resolve, service } = fixture();

    const result = await service.pinThread(ids.window, {
      catalogRef,
      expectedVersion: 2 as AggregateVersion,
    });

    expect(resolve).toHaveBeenCalledWith(ids.window, catalogRef);
    expect(result.result).toBe("thread-pinned");
    expect(result.elementId).toBe(ids.element);
    expect(result.space.elements[0]).toMatchObject({
      kind: "thread",
      elementId: ids.element,
      sourceContext: entry.sourceContext,
    });
    expect(append).toHaveBeenCalledWith(expect.any(Object), 2);
  });

  it("rejects forged and stale catalog references without mutation", async () => {
    const { append, service } = fixture({ resolve: undefined });

    await expect(
      service.pinThread(ids.window, {
        catalogRef,
        expectedVersion: 2 as AggregateVersion,
      }),
    ).rejects.toThrow("unavailable-source");
    expect(append).not.toHaveBeenCalled();
  });

  it("does not allow another window to pin through a valid reference", async () => {
    const { append, service } = fixture();

    await expect(
      service.pinThread(ids.otherWindow, {
        catalogRef,
        expectedVersion: 2 as AggregateVersion,
      }),
    ).rejects.toThrow("wrong-window");
    expect(append).not.toHaveBeenCalled();
  });

  it("lets only one parallel pin commit for the same expected version", async () => {
    let current = space();
    const conflict = new Error("conflict");
    let committed = false;
    const service = new ZenService({
      focusZone: memoryFocusZone(),
      loadSpace: () => current,
      loadSpaceByWindow: () => current,
      eventStore: {
        append: (next: ZenSpace, expectedVersion: number) => {
          if (committed) throw conflict;
          committed = true;
          current = { ...next, version: (expectedVersion + 1) as AggregateVersion };
          return current;
        },
        isConcurrencyConflict: (error: unknown) => error === conflict,
      } as never,
      localHostId: LOCAL_HOST_ID,
      threadCatalog: {
        resolve: async () => {
          await Promise.resolve();
          return entry;
        },
        search: async () => [entry],
      },
      uuid: () => ids.element,
    });

    const results = await Promise.allSettled([
      service.pinThread(ids.window, { catalogRef, expectedVersion: 2 as AggregateVersion }),
      service.pinThread(ids.window, { catalogRef, expectedVersion: 2 as AggregateVersion }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" ? String(rejected.reason) : "").toContain(
      "stale-version",
    );
  });

  it("does not commit when a pin is interrupted during source authorization", async () => {
    let finishResolve!: (value: typeof entry) => void;
    const resolve = new Promise<typeof entry>((resolvePromise) => {
      finishResolve = resolvePromise;
    });
    const controller = new AbortController();
    const current = space();
    const append = vi.fn();
    const service = new ZenService({
      focusZone: memoryFocusZone(),
      loadSpace: () => current,
      loadSpaceByWindow: () => current,
      eventStore: { append, isConcurrencyConflict: () => false } as never,
      localHostId: LOCAL_HOST_ID,
      threadCatalog: { resolve: async () => await resolve, search: async () => [entry] },
      uuid: () => ids.element,
    });

    const pinning = service.pinThread(
      ids.window,
      { catalogRef, expectedVersion: 2 as AggregateVersion },
      controller.signal,
    );
    controller.abort();
    finishResolve(entry);

    await expect(pinning).rejects.toThrow("interrupted");
    expect(append).not.toHaveBeenCalled();
  });
});

describe("ZenService durable Notes and Checklist widgets", () => {
  function widgetFixture(initial: ZenSpace = space()) {
    let current = initial;
    const append = vi.fn((next: ZenSpace, expectedVersion: number) => {
      current = { ...next, version: (expectedVersion + 1) as AggregateVersion };
      return current;
    });
    const appendWidgetMutation = vi.fn(
      (next: ZenSpace, expectedVersion: number, _mutation: unknown) =>
        append(next, expectedVersion),
    );
    const generated = [ids.element, ids.item];
    const service = new ZenService({
      focusZone: memoryFocusZone(),
      loadSpace: () => current,
      loadSpaceByWindow: () => current,
      eventStore: {
        append,
        appendWidgetMutation,
        isConcurrencyConflict: () => false,
      } as never,
      localHostId: LOCAL_HOST_ID,
      uuid: () => generated.shift() ?? ids.item,
    });
    return { append, appendWidgetMutation, current: () => current, service };
  }

  it.each(["notes", "checklist"] as const)(
    "creates a server-identified %s widget with an independent version",
    (kind) => {
      const { appendWidgetMutation, service } = widgetFixture();

      const result = service.handleCommand(
        {
          command: "create-widget",
          spaceId: ids.space,
          kind,
          expectedVersion: 2 as AggregateVersion,
        },
        ids.window,
      );

      expect(result.result).toBe("mutation");
      if (result.result !== "mutation") throw new Error("Expected widget mutation result.");
      expect(result.space.elements[0]).toMatchObject({
        elementId: ids.element,
        kind,
        widgetVersion: 0,
      });
      expect(appendWidgetMutation).toHaveBeenCalledWith(
        expect.any(Object),
        2,
        expect.objectContaining({
          operation: "widget-created",
          kind,
          elementId: ids.element,
          widgetVersion: 0,
        }),
      );
    },
  );

  it("places a second widget beside the first instead of obscuring it", () => {
    const initial = {
      ...space(),
      elements: [
        {
          elementId: ids.item as unknown as typeof ids.element,
          kind: "notes" as const,
          widgetVersion: 0 as AggregateVersion,
          content: "Visible",
          geometry: { x: 64, y: 96, width: 420, height: 260 },
          zIndex: 1,
          minimized: false,
          locked: false,
        },
      ],
    };
    const { service } = widgetFixture(initial);

    const result = service.handleCommand(
      {
        command: "create-widget",
        spaceId: ids.space,
        kind: "checklist",
        expectedVersion: 2 as AggregateVersion,
      },
      ids.window,
    );

    expect(result.result === "mutation" ? result.space.elements[1]?.geometry : null).toMatchObject({
      x: 516,
      y: 96,
    });
  });

  it("compacts saturated z-index values before placing a new widget on top", () => {
    const initial = {
      ...space(),
      elements: [
        {
          elementId: ids.item as unknown as typeof ids.element,
          kind: "notes" as const,
          widgetVersion: 0 as AggregateVersion,
          content: "Top note",
          geometry: { x: 64, y: 96, width: 420, height: 260 },
          zIndex: 1000,
          minimized: false,
          locked: false,
        },
      ],
    };
    const { service } = widgetFixture(initial);

    const result = service.handleCommand(
      {
        command: "create-widget",
        spaceId: ids.space,
        kind: "checklist",
        expectedVersion: 2 as AggregateVersion,
      },
      ids.window,
    );

    expect(result.result).toBe("mutation");
    if (result.result !== "mutation") throw new Error("Expected widget mutation result.");
    expect(result.space.elements.map((element) => element.zIndex)).toEqual([1, 2]);
  });

  it("saves notes and records the typed widget mutation", () => {
    const initial = {
      ...space(),
      elements: [
        {
          elementId: ids.element,
          kind: "notes" as const,
          widgetVersion: 0 as AggregateVersion,
          content: "Draft",
          geometry: { x: 64, y: 96, width: 420, height: 260 },
          zIndex: 1,
          minimized: false,
          locked: false,
        },
      ],
    };
    const { appendWidgetMutation, service } = widgetFixture(initial);

    const result = service.handleCommand(
      {
        command: "save-notes",
        spaceId: ids.space,
        elementId: ids.element,
        content: "Saved",
        expectedVersion: 2 as AggregateVersion,
        expectedWidgetVersion: 0 as AggregateVersion,
      },
      ids.window,
    );

    expect(result.result === "mutation" ? result.space.elements[0] : null).toMatchObject({
      kind: "notes",
      content: "Saved",
      widgetVersion: 1,
    });
    expect(appendWidgetMutation).toHaveBeenCalledWith(
      expect.any(Object),
      2,
      expect.objectContaining({ operation: "notes-saved", widgetVersion: 1 }),
    );
  });

  it("generates stable checklist item IDs and rejects stale/forged mutations", () => {
    const initial = {
      ...space(),
      elements: [
        {
          elementId: ids.element,
          kind: "checklist" as const,
          widgetVersion: 0 as AggregateVersion,
          items: [],
          geometry: { x: 64, y: 96, width: 420, height: 260 },
          zIndex: 1,
          minimized: false,
          locked: false,
        },
      ],
    };
    const { appendWidgetMutation, current, service } = widgetFixture(initial);

    const added = service.handleCommand(
      {
        command: "add-checklist-item",
        spaceId: ids.space,
        elementId: ids.element,
        text: "Run tests",
        expectedVersion: 2 as AggregateVersion,
        expectedWidgetVersion: 0 as AggregateVersion,
      },
      ids.window,
    );

    expect(added.result === "mutation" ? added.space.elements[0] : null).toMatchObject({
      widgetVersion: 1,
      items: [{ itemId: ids.element, text: "Run tests", done: false }],
    });
    expect(appendWidgetMutation).toHaveBeenCalledWith(
      expect.any(Object),
      2,
      expect.objectContaining({ operation: "checklist-item-added", itemId: ids.element }),
    );
    expect(() =>
      service.handleCommand(
        {
          command: "set-checklist-item-completed",
          spaceId: ids.space,
          elementId: ids.element,
          itemId: ids.item,
          done: true,
          expectedVersion: current().version,
          expectedWidgetVersion: 1 as AggregateVersion,
        },
        ids.window,
      ),
    ).toThrow(/unknown-checklist-item/);
    expect(appendWidgetMutation).toHaveBeenCalledTimes(1);
  });

  it("does not commit an already-cancelled widget mutation", () => {
    const { appendWidgetMutation, service } = widgetFixture();
    const controller = new AbortController();
    controller.abort();

    expect(() =>
      service.handleCommand(
        {
          command: "create-widget",
          spaceId: ids.space,
          kind: "notes",
          expectedVersion: 2 as AggregateVersion,
        },
        ids.window,
        controller.signal,
      ),
    ).toThrow(/interrupted/);
    expect(appendWidgetMutation).not.toHaveBeenCalled();
  });
});

function assistantThread(): ChatThread {
  return {
    id: ids.thread,
    title: "Navigator",
    lifecycle: "active",
    providerInstanceId: ids.provider,
    modelId: "model-local",
    researchEnabled: false,
    researchRouting: "automatic",
    personalityInstructions: "Help with the active Zen space.",
    version: 1,
    createdAt: "2026-07-28T12:00:00.000Z",
    updatedAt: "2026-07-28T12:00:00.000Z",
  } as unknown as ChatThread;
}

function providerState(toolCapability: "supported" | "unsupported") {
  return {
    providerInstanceId: ids.provider,
    providerLabel: "Local provider",
    modelId: "model-local" as never,
    modelLabel: "Local model",
    readiness: "ready" as const,
    toolCapability,
    ...(toolCapability === "supported"
      ? {}
      : { toolCapabilityReason: "Use the manual Zen controls." }),
  };
}

describe("ZenService Reference widget", () => {
  it("normalizes a safe Reference URL server-side before persisting it", () => {
    const { append, service } = fixture();

    const result = service.handleCommand(
      {
        command: "create-reference",
        spaceId: ids.space,
        url: "HTTPS://Example.com/release-notes" as never,
        label: "Release notes",
        expectedVersion: 2 as AggregateVersion,
      },
      ids.window,
    );

    expect(result.result).toBe("mutation");
    expect(result.result === "mutation" ? result.space.elements[0] : undefined).toMatchObject({
      elementId: ids.element,
      kind: "reference",
      url: "https://example.com/release-notes",
      label: "Release notes",
    });
    expect(append).toHaveBeenCalledWith(expect.any(Object), 2);
  });
});

describe("ZenService timer lifecycle", () => {
  it("completes from the persisted deadline when the scheduler resumes after sleep", async () => {
    let current = space();
    let clock = {
      wallTimeMs: Date.parse("2026-07-29T08:00:00.000Z"),
      monotonicTimeMs: 10_000,
      sessionId: "server-session",
    };
    let scheduled: (() => void) | undefined;
    const append = vi.fn((next: ZenSpace, expectedVersion: number) => {
      current = { ...next, version: (expectedVersion + 1) as AggregateVersion };
      return current;
    });
    const scheduleTimer = vi.fn((delayMs: number, callback: () => void) => {
      expect(delayMs).toBe(25 * 60 * 1000);
      scheduled = callback;
      return vi.fn();
    });
    const service = new ZenService({
      focusZone: memoryFocusZone(),
      loadSpace: () => current,
      loadSpaceByWindow: () => current,
      eventStore: { append, isConcurrencyConflict: () => false } as never,
      localHostId: LOCAL_HOST_ID,
      uuid: () => ids.element,
      timerClock: () => clock,
      scheduleTimer,
    });

    const created = service.handleCommand(
      {
        command: "create-timer",
        spaceId: current.spaceId,
        durationMs: 25 * 60 * 1000,
        expectedVersion: current.version,
      },
      ids.window,
    );
    expect(created).toMatchObject({
      result: "mutation",
      space: { elements: [{ kind: "timer", status: "idle", remainingMs: 25 * 60 * 1000 }] },
    });

    const started = service.handleCommand(
      {
        command: "timer-action",
        spaceId: current.spaceId,
        elementId: ids.element,
        action: "start",
        expectedVersion: current.version,
      },
      ids.window,
    );
    expect(started).toMatchObject({
      result: "mutation",
      space: { elements: [{ status: "running", clockSessionId: "server-session" }] },
    });
    expect(scheduleTimer).toHaveBeenCalledOnce();

    clock = {
      ...clock,
      wallTimeMs: clock.wallTimeMs + 25 * 60 * 1000,
    };
    scheduled?.();

    expect(current.elements[0]).toMatchObject({ status: "completed", remainingMs: 0 });
    expect(append).toHaveBeenCalledTimes(3);
  });

  it("cancels scheduling on pause and treats duplicate current-state actions as no-ops", () => {
    let current = space();
    let clock = {
      wallTimeMs: Date.parse("2026-07-29T08:00:00.000Z"),
      monotonicTimeMs: 10_000,
      sessionId: "server-session",
    };
    const append = vi.fn((next: ZenSpace, expectedVersion: number) => {
      current = { ...next, version: (expectedVersion + 1) as AggregateVersion };
      return current;
    });
    const cancel = vi.fn();
    const service = new ZenService({
      focusZone: memoryFocusZone(),
      loadSpace: () => current,
      loadSpaceByWindow: () => current,
      eventStore: { append, isConcurrencyConflict: () => false } as never,
      localHostId: LOCAL_HOST_ID,
      uuid: () => ids.element,
      timerClock: () => clock,
      scheduleTimer: () => cancel,
    });
    service.handleCommand(
      {
        command: "create-timer",
        spaceId: current.spaceId,
        durationMs: 25 * 60 * 1000,
        expectedVersion: current.version,
      },
      ids.window,
    );
    service.handleCommand(
      {
        command: "timer-action",
        spaceId: current.spaceId,
        elementId: ids.element,
        action: "start",
        expectedVersion: current.version,
      },
      ids.window,
    );
    clock = {
      wallTimeMs: clock.wallTimeMs + 3 * 60 * 60 * 1000,
      monotonicTimeMs: clock.monotonicTimeMs + 60_000,
      sessionId: clock.sessionId,
    };
    const paused = service.handleCommand(
      {
        command: "timer-action",
        spaceId: current.spaceId,
        elementId: ids.element,
        action: "pause",
        expectedVersion: current.version,
      },
      ids.window,
    );
    const appendCount = append.mock.calls.length;
    const duplicate = service.handleCommand(
      {
        command: "timer-action",
        spaceId: current.spaceId,
        elementId: ids.element,
        action: "pause",
        expectedVersion: current.version,
      },
      ids.window,
    );

    expect(paused).toMatchObject({
      space: { elements: [{ status: "paused", remainingMs: 24 * 60 * 1000 }] },
    });
    expect(duplicate).toMatchObject({ space: { version: current.version } });
    expect(append).toHaveBeenCalledTimes(appendCount);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("reconciles an expired persisted timer on restart bootstrap", () => {
    const timer = {
      elementId: ids.element,
      kind: "timer" as const,
      durationMs: 20 * 60 * 1000,
      remainingMs: 20 * 60 * 1000,
      status: "running" as const,
      startedAt: "2026-07-29T08:00:00.000Z" as never,
      deadlineAt: "2026-07-29T08:20:00.000Z" as never,
      clockSessionId: "previous-server",
      monotonicStartedMs: 100_000,
      geometry: { x: 100, y: 100, width: 400, height: 300 },
      zIndex: 1,
      minimized: false,
      locked: false,
    };
    let current = { ...space(), elements: [timer] } as ZenSpace;
    const append = vi.fn((next: ZenSpace, expectedVersion: number) => {
      current = { ...next, version: (expectedVersion + 1) as AggregateVersion };
      return current;
    });
    const service = new ZenService({
      focusZone: memoryFocusZone(),
      loadSpace: () => current,
      loadSpaceByWindow: () => current,
      eventStore: { append, isConcurrencyConflict: () => false } as never,
      localHostId: LOCAL_HOST_ID,
      timerClock: () => ({
        wallTimeMs: Date.parse("2026-07-29T08:30:00.000Z"),
        monotonicTimeMs: 5_000,
        sessionId: "restarted-server",
      }),
      scheduleTimer: vi.fn(),
    });

    const bootstrap = service.bootstrap(ids.window);

    expect(bootstrap.space?.elements[0]).toMatchObject({ status: "completed", remainingMs: 0 });
    expect(append).toHaveBeenCalledOnce();
  });

  it("keeps authoritative schedules active for timers in other windows", () => {
    const first = space();
    const second = {
      ...createZenSpace(ids.otherWindow, decodeHostId(LOCAL_HOST_ID)),
      spaceId: ids.otherSpace,
      version: 2 as AggregateVersion,
    };
    const spaces = new Map([
      [first.spaceId, first],
      [second.spaceId, second],
    ]);
    const append = vi.fn((next: ZenSpace, expectedVersion: number) => {
      const committed = { ...next, version: (expectedVersion + 1) as AggregateVersion };
      spaces.set(committed.spaceId, committed);
      return committed;
    });
    const cancelFirst = vi.fn();
    const cancelSecond = vi.fn();
    const scheduleTimer = vi
      .fn<(delayMs: number, callback: () => void) => () => void>()
      .mockReturnValueOnce(cancelFirst)
      .mockReturnValueOnce(cancelSecond);
    const elementIds = [ids.element, ids.otherElement];
    const service = new ZenService({
      focusZone: memoryFocusZone(),
      loadSpace: (spaceId) => spaces.get(spaceId) ?? null,
      loadSpaceByWindow: (windowId) =>
        [...spaces.values()].find((candidate) => candidate.windowId === windowId) ?? null,
      eventStore: { append, isConcurrencyConflict: () => false } as never,
      localHostId: LOCAL_HOST_ID,
      uuid: () => elementIds.shift()!,
      timerClock: () => ({
        wallTimeMs: Date.parse("2026-07-29T08:00:00.000Z"),
        monotonicTimeMs: 10_000,
        sessionId: "server-session",
      }),
      scheduleTimer,
    });

    for (const [windowId, spaceId, elementId] of [
      [ids.window, ids.space, ids.element],
      [ids.otherWindow, ids.otherSpace, ids.otherElement],
    ] as const) {
      const created = service.handleCommand(
        {
          command: "create-timer",
          spaceId,
          durationMs: 25 * 60 * 1000,
          expectedVersion: spaces.get(spaceId)!.version,
        },
        windowId,
      );
      if (created.result !== "mutation") throw new Error("Expected Timer mutation");
      service.handleCommand(
        {
          command: "timer-action",
          spaceId,
          elementId,
          action: "start",
          expectedVersion: created.space.version,
        },
        windowId,
      );
    }

    expect(scheduleTimer).toHaveBeenCalledTimes(2);
    expect(cancelFirst).not.toHaveBeenCalled();
    expect(cancelSecond).not.toHaveBeenCalled();
  });

  it("compacts a saturated z-index before creating a Timer on top", () => {
    let current = {
      ...space(),
      elements: [
        {
          elementId: ids.otherElement,
          kind: "notes",
          widgetVersion: 0 as AggregateVersion,
          content: "Keep me",
          geometry: { x: 40, y: 40, width: 320, height: 220 },
          zIndex: 1000,
          minimized: false,
          locked: false,
        },
      ],
    } as ZenSpace;
    const append = vi.fn((next: ZenSpace, expectedVersion: number) => {
      current = { ...next, version: (expectedVersion + 1) as AggregateVersion };
      return current;
    });
    const service = new ZenService({
      focusZone: memoryFocusZone(),
      loadSpace: () => current,
      loadSpaceByWindow: () => current,
      eventStore: { append, isConcurrencyConflict: () => false } as never,
      localHostId: LOCAL_HOST_ID,
      uuid: () => ids.element,
    });

    const result = service.handleCommand(
      {
        command: "create-timer",
        spaceId: current.spaceId,
        durationMs: 25 * 60 * 1000,
        expectedVersion: current.version,
      },
      ids.window,
    );

    expect(result).toMatchObject({
      result: "mutation",
      space: {
        elements: [
          { kind: "notes", elementId: ids.otherElement, zIndex: 1 },
          { kind: "timer", elementId: ids.element, zIndex: 2 },
        ],
      },
    });
  });
});

describe("ZenService Navigator", () => {
  it("briefs the assistant on the active conversation, never a superseded exchange", async () => {
    const current = {
      ...space(),
      assistant: { threadId: ids.thread, providerId: ids.provider, modelId: "model-local" },
    } as ZenSpace;
    const thread = assistantThread();
    const turn = (id: string, content: string, supersedes?: string) => ({
      id,
      ...(supersedes === undefined ? {} : { supersedes }),
      createdAt: "2026-07-29T12:00:00.000Z",
      userMessageRef: { contentId: `${content}-user` },
      attempts: [
        {
          outcome: "completed",
          responseRefs: [{ contentId: `${content}-reply` }],
          updatedAt: "2026-07-29T12:00:01.000Z",
        },
      ],
    });
    const body = (contentId: string, text: string) => ({ contentId, body: text });
    const view = {
      thread,
      turns: [turn("t1", "friday"), turn("t2", "monday", "t1")],
      contents: [
        body("friday-user", "Ship the preview on Friday"),
        body("friday-reply", "Friday works"),
        body("monday-user", "Ship the preview on Monday"),
        body("monday-reply", "Monday works"),
      ],
    } as unknown as ChatThreadView;
    const service = new ZenService({
      focusZone: memoryFocusZone(),
      loadSpace: () => current,
      loadSpaceByWindow: () => current,
      eventStore: { append: vi.fn(), isConcurrencyConflict: () => false } as never,
      localHostId: LOCAL_HOST_ID,
      uuid: () => "00000000-0000-4000-8000-000000000099",
      assistantChat: { create: vi.fn(), read: () => view },
      assistantProviderState: () => ({
        providerInstanceId: ids.provider,
        providerLabel: "Local provider",
        modelId: "model-local" as never,
        modelLabel: "Local model",
        readiness: "ready",
        toolCapability: "supported",
      }),
    });

    const snapshot = await service.assistantSnapshot(ids.window);
    const texts = (snapshot as { transcript: ReadonlyArray<{ text: string }> }).transcript.map(
      (message) => message.text,
    );
    // The user replaced the Friday exchange; the assistant must not see it.
    expect(texts).toEqual(["Ship the preview on Monday", "Monday works"]);
  });

  describe("assistant transcript attempt outcomes", () => {
    /** The Navigator transcript this thread view briefs the assistant with. */
    const briefedWith = async (turns: ReadonlyArray<unknown>, contents: ReadonlyArray<unknown>) => {
      const current = {
        ...space(),
        assistant: { threadId: ids.thread, providerId: ids.provider, modelId: "model-local" },
      } as ZenSpace;
      const view = { thread: assistantThread(), turns, contents } as unknown as ChatThreadView;
      const service = new ZenService({
        focusZone: memoryFocusZone(),
        loadSpace: () => current,
        loadSpaceByWindow: () => current,
        eventStore: { append: vi.fn(), isConcurrencyConflict: () => false } as never,
        localHostId: LOCAL_HOST_ID,
        uuid: () => "00000000-0000-4000-8000-000000000099",
        assistantChat: { create: vi.fn(), read: () => view },
        assistantProviderState: () => ({
          providerInstanceId: ids.provider,
          providerLabel: "Local provider",
          modelId: "model-local" as never,
          modelLabel: "Local model",
          readiness: "ready",
          toolCapability: "supported",
        }),
      });
      const snapshot = await service.assistantSnapshot(ids.window);
      return (
        snapshot as { transcript: ReadonlyArray<{ role: string; text: string }> }
      ).transcript.map((message) => [message.role, message.text]);
    };

    const attempt = (outcome: string, ...contentIds: ReadonlyArray<string>) => ({
      outcome,
      responseRefs: contentIds.map((contentId) => ({ contentId })),
      updatedAt: "2026-07-29T12:00:01.000Z",
    });

    const turn = (attempts: ReadonlyArray<unknown>) => ({
      id: "t1",
      createdAt: "2026-07-29T12:00:00.000Z",
      userMessageRef: { contentId: "ask" },
      attempts,
    });

    it("briefs the assistant on the prompt but not the text a failed attempt abandoned", async () => {
      // The attempt joins its refs into one assistant message, so a failure
      // that emitted anything would otherwise brief the Navigator with a whole
      // message the conversation never accepted as its answer.
      const transcript = await briefedWith(
        [turn([attempt("failed", "partial")])],
        [
          { contentId: "ask", body: "What is on today?" },
          { contentId: "partial", body: "Today you have" },
        ],
      );

      expect(transcript).toEqual([["user", "What is on today?"]]);
    });

    it("briefs the assistant on the answer a retry produced, exactly once", async () => {
      const transcript = await briefedWith(
        [turn([attempt("failed", "partial"), attempt("completed", "answer")])],
        [
          { contentId: "ask", body: "What is on today?" },
          { contentId: "partial", body: "Today you have" },
          { contentId: "answer", body: "Two reviews and a demo." },
        ],
      );

      expect(transcript).toEqual([
        ["user", "What is on today?"],
        ["assistant", "Two reviews and a demo."],
      ]);
    });

    it("still joins every response of a completed attempt into one message", async () => {
      const transcript = await briefedWith(
        [turn([attempt("completed", "first", "second")])],
        [
          { contentId: "ask", body: "What is on today?" },
          { contentId: "first", body: "Two reviews " },
          { contentId: "second", body: "and a demo." },
        ],
      );

      expect(transcript).toEqual([
        ["user", "What is on today?"],
        ["assistant", "Two reviews and a demo."],
      ]);
    });
  });

  it("keeps a provider recipe inert until the user confirms a current preview, then consumes it", () => {
    let current = {
      ...space(),
      assistant: {
        threadId: ids.thread,
        providerId: ids.provider,
        modelId: "model-local",
      },
    } as ZenSpace;
    const thread = assistantThread();
    const append = vi.fn((next: ZenSpace, expectedVersion: number) => {
      current = { ...next, version: (expectedVersion + 1) as AggregateVersion };
      return current;
    });
    const generated = [
      "00000000-0000-4000-8000-000000000011",
      "00000000-0000-4000-8000-000000000012",
    ];
    let recipeNow = Date.parse("2026-07-29T12:00:00.000Z");
    const service = new ZenService({
      focusZone: memoryFocusZone(),
      loadSpace: () => current,
      loadSpaceByWindow: () => current,
      eventStore: { append, isConcurrencyConflict: () => false } as never,
      localHostId: LOCAL_HOST_ID,
      uuid: () => generated.shift()!,
      assistantChat: {
        create: vi.fn(),
        read: () => ({ thread, turns: [], contents: [] }) as unknown as ChatThreadView,
      },
      assistantProviderState: () => ({
        providerInstanceId: ids.provider,
        providerLabel: "Local provider",
        modelId: "model-local" as never,
        modelLabel: "Local model",
        readiness: "ready",
        toolCapability: "supported",
      }),
      recipeClock: () => recipeNow,
    });
    const preview = service.previewRecipe(ids.window, ids.thread, {
      expectedVersion: current.version,
      recipe: {
        recipeId: "00000000-0000-4000-8000-000000000013" as never,
        name: "Release focus",
        primitives: ["checklist", "text"],
        fields: [{ key: "goal", label: "Goal", kind: "text", defaultValue: "Ship" }],
      },
    });

    expect(append).not.toHaveBeenCalled();
    const placed = service.handleCommand(
      {
        command: "confirm-recipe-preview",
        spaceId: current.spaceId,
        previewId: preview.previewId,
        action: "place",
        expectedVersion: current.version,
      },
      ids.window,
    );

    expect(placed).toMatchObject({
      result: "mutation",
      space: {
        recipes: [
          {
            recipeId: preview.recipe.recipeId,
            provenance: {
              assistantThreadId: ids.thread,
              providerInstanceId: ids.provider,
              modelId: "model-local",
              previewId: "00000000-0000-4000-8000-000000000011",
              previewVersion: 2,
              createdAt: "2026-07-29T12:00:00.000Z",
              confirmedAt: "2026-07-29T12:00:00.000Z",
            },
          },
        ],
        elements: [{ kind: "recipe", recipeId: preview.recipe.recipeId, state: { goal: "Ship" } }],
      },
    });
    expect(() =>
      service.handleCommand(
        {
          command: "confirm-recipe-preview",
          spaceId: current.spaceId,
          previewId: preview.previewId,
          action: "place",
          expectedVersion: current.version,
        },
        ids.window,
      ),
    ).toThrow(/stale-preview/);
  });

  it("purges expired previews before bounded admission while allowing a revision to reuse its slot", async () => {
    let current = {
      ...space(),
      assistant: { threadId: ids.thread, providerId: ids.provider, modelId: "model-local" },
    } as ZenSpace;
    const thread = assistantThread();
    let recipeNow = Date.parse("2026-07-29T12:00:00.000Z");
    let nextPreviewId = 20;
    const service = new ZenService({
      focusZone: memoryFocusZone(),
      loadSpace: () => current,
      loadSpaceByWindow: () => current,
      eventStore: {
        append: (next: ZenSpace, expectedVersion: number) => {
          current = { ...next, version: (expectedVersion + 1) as AggregateVersion };
          return current;
        },
        isConcurrencyConflict: () => false,
      } as never,
      localHostId: LOCAL_HOST_ID,
      uuid: () => `00000000-0000-4000-8000-${String(nextPreviewId++).padStart(12, "0")}`,
      assistantChat: {
        create: vi.fn(),
        read: () => ({ thread, turns: [], contents: [] }) as unknown as ChatThreadView,
      },
      assistantProviderState: () => ({
        providerInstanceId: ids.provider,
        providerLabel: "Local provider",
        modelId: "model-local" as never,
        modelLabel: "Local model",
        readiness: "ready",
        toolCapability: "supported",
      }),
      recipeClock: () => recipeNow,
    });
    const recipe = (index: number) => ({
      recipeId: `00000000-0000-4000-8000-${String(100 + index).padStart(12, "0")}` as never,
      name: `Focus ${index}`,
      primitives: ["text"] as const,
      fields: [],
    });

    const previews = Array.from({ length: 4 }, (_, index) =>
      service.previewRecipe(ids.window, ids.thread, {
        expectedVersion: current.version,
        recipe: recipe(index),
      }),
    );

    expect(() =>
      service.previewRecipe(ids.window, ids.thread, {
        expectedVersion: current.version,
        recipe: recipe(4),
      }),
    ).toThrow(/recipe preview capacity/i);

    const revised = service.previewRecipe(ids.window, ids.thread, {
      expectedVersion: current.version,
      previewId: previews[0]!.previewId,
      recipe: { ...recipe(0), name: "Revised focus" },
    });
    expect(revised).toMatchObject({
      previewId: previews[0]!.previewId,
      recipe: { name: "Revised focus" },
    });

    recipeNow += 10 * 60_000;
    await expect(service.assistantSnapshot(ids.window)).resolves.toMatchObject({
      recipePreview: null,
    });
    expect(() =>
      service.previewRecipe(ids.window, ids.thread, {
        expectedVersion: current.version,
        recipe: recipe(4),
      }),
    ).not.toThrow();
  });

  it("exposes the latest unexpired recipe preview for the exact assistant", async () => {
    let current = {
      ...space(),
      assistant: { threadId: ids.thread, providerId: ids.provider, modelId: "model-local" },
    } as ZenSpace;
    const thread = assistantThread();
    let recipeNow = Date.parse("2026-07-29T12:00:00.000Z");
    let nextPreviewId = 30;
    const service = new ZenService({
      focusZone: memoryFocusZone(),
      loadSpace: () => current,
      loadSpaceByWindow: () => current,
      eventStore: {
        append: (next: ZenSpace, expectedVersion: number) => {
          current = { ...next, version: (expectedVersion + 1) as AggregateVersion };
          return current;
        },
        isConcurrencyConflict: () => false,
      } as never,
      localHostId: LOCAL_HOST_ID,
      uuid: () => `00000000-0000-4000-8000-${String(nextPreviewId++).padStart(12, "0")}`,
      assistantChat: {
        create: vi.fn(),
        read: () => ({ thread, turns: [], contents: [] }) as unknown as ChatThreadView,
      },
      assistantProviderState: () => ({
        providerInstanceId: ids.provider,
        providerLabel: "Local provider",
        modelId: "model-local" as never,
        modelLabel: "Local model",
        readiness: "ready",
        toolCapability: "supported",
      }),
      recipeClock: () => recipeNow,
    });
    const recipe = (recipeId: string, name: string) => ({
      recipeId: recipeId as never,
      name,
      primitives: ["text"] as const,
      fields: [],
    });

    const first = service.previewRecipe(ids.window, ids.thread, {
      expectedVersion: current.version,
      recipe: recipe("00000000-0000-4000-8000-000000000131", "First focus"),
    });
    recipeNow += 1;
    const second = service.previewRecipe(ids.window, ids.thread, {
      expectedVersion: current.version,
      recipe: recipe("00000000-0000-4000-8000-000000000132", "Second focus"),
    });

    await expect(service.assistantSnapshot(ids.window)).resolves.toMatchObject({
      recipePreview: { previewId: second.previewId, recipe: { name: "Second focus" } },
    });

    recipeNow += 1;
    const revised = service.previewRecipe(ids.window, ids.thread, {
      expectedVersion: current.version,
      previewId: first.previewId,
      recipe: recipe("00000000-0000-4000-8000-000000000131", "Revised first focus"),
    });

    await expect(service.assistantSnapshot(ids.window)).resolves.toMatchObject({
      recipePreview: { previewId: revised.previewId, recipe: { name: "Revised first focus" } },
    });
  });

  it("refuses executable recipe text and unsupported-provider confirmation without a Zen mutation", () => {
    let current = {
      ...space(),
      assistant: { threadId: ids.thread, providerId: ids.provider, modelId: "model-local" },
    } as ZenSpace;
    const thread = assistantThread();
    const append = vi.fn((next: ZenSpace, expectedVersion: number) => {
      current = { ...next, version: (expectedVersion + 1) as AggregateVersion };
      return current;
    });
    const service = new ZenService({
      focusZone: memoryFocusZone(),
      loadSpace: () => current,
      loadSpaceByWindow: () => current,
      eventStore: { append, isConcurrencyConflict: () => false } as never,
      localHostId: LOCAL_HOST_ID,
      uuid: () => "00000000-0000-4000-8000-000000000014",
      assistantChat: {
        create: vi.fn(),
        read: () => ({ thread, turns: [], contents: [] }) as unknown as ChatThreadView,
      },
      assistantProviderState: () => ({
        providerInstanceId: ids.provider,
        providerLabel: "Local provider",
        modelId: "model-local" as never,
        modelLabel: "Local model",
        readiness: "ready",
        toolCapability: "supported",
      }),
    });

    expect(() =>
      service.previewRecipe(ids.window, ids.thread, {
        expectedVersion: current.version,
        recipe: {
          recipeId: "00000000-0000-4000-8000-000000000015" as never,
          name: "Safe name",
          primitives: ["text"],
          fields: [{ key: "copy", label: "<script>bad</script>", kind: "text" }],
        },
      }),
    ).toThrow(/executable-content/);
    expect(append).not.toHaveBeenCalled();
  });

  it("binds the host's one conversation, then keeps that binding across reopenings", async () => {
    let current = space();
    const thread = assistantThread();
    const create = vi.fn(async () => thread);
    const read = vi.fn(() => ({ thread, turns: [], contents: [] }) as unknown as ChatThreadView);
    const append = vi.fn((next: ZenSpace, expectedVersion: number) => {
      current = { ...next, version: (expectedVersion + 1) as AggregateVersion };
      return current;
    });
    const service = new ZenService({
      focusZone: memoryFocusZone(),
      loadSpace: () => current,
      loadSpaceByWindow: () => current,
      eventStore: { append, isConcurrencyConflict: () => false } as never,
      localHostId: LOCAL_HOST_ID,
      assistantChat: { create, read },
      assistantProviderState: () => ({
        providerInstanceId: ids.provider,
        providerLabel: "Local provider",
        modelId: "model-local" as never,
        modelLabel: "Local model",
        readiness: "ready",
        toolCapability: "supported",
      }),
    });

    const first = await service.ensureAssistant(ids.window);
    const second = await service.ensureAssistant(ids.window);

    // Reopening resolves the conversation again — that is how a binding is kept
    // honest — but nothing is journaled the second time, so the surface keeps
    // the one conversation instead of accumulating bindings.
    expect(create).toHaveBeenCalledTimes(2);
    expect(append).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({
      status: "ready",
      binding: { threadId: ids.thread, providerId: ids.provider, modelId: "model-local" },
      provider: { readiness: "ready", toolCapability: "supported" },
    });
    expect(second.binding?.threadId).toBe(ids.thread);
    expect(current.assistant?.threadId).toBe(ids.thread);
  });

  it("coalesces parallel first-open requests into one ordinary Chat thread", async () => {
    let current = space();
    const thread = assistantThread();
    let finishCreate!: (value: ChatThread) => void;
    const pendingCreate = new Promise<ChatThread>((resolve) => {
      finishCreate = resolve;
    });
    const create = vi.fn(async () => await pendingCreate);
    const append = vi.fn((next: ZenSpace, expectedVersion: number) => {
      current = { ...next, version: (expectedVersion + 1) as AggregateVersion };
      return current;
    });
    const service = new ZenService({
      focusZone: memoryFocusZone(),
      loadSpace: () => current,
      loadSpaceByWindow: () => current,
      eventStore: { append, isConcurrencyConflict: () => false } as never,
      localHostId: LOCAL_HOST_ID,
      assistantChat: {
        create,
        read: () => ({ thread, turns: [], contents: [] }) as unknown as ChatThreadView,
      },
    });

    const first = service.ensureAssistant(ids.window);
    const second = service.ensureAssistant(ids.window);
    finishCreate(thread);

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(create).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledTimes(1);
  });

  it("preserves the binding but reports unavailable when the source thread disappears", async () => {
    let current = {
      ...space(),
      assistant: {
        threadId: ids.thread,
        providerId: ids.provider,
        modelId: "model-local",
      },
    } as ZenSpace;
    const service = new ZenService({
      focusZone: memoryFocusZone(),
      loadSpace: () => current,
      loadSpaceByWindow: () => current,
      eventStore: {
        append: (next: ZenSpace) => (current = next),
        isConcurrencyConflict: () => false,
      } as never,
      localHostId: LOCAL_HOST_ID,
      assistantChat: { create: vi.fn(), read: () => undefined },
    });

    await expect(service.assistantSnapshot(ids.window)).resolves.toMatchObject({
      status: "unavailable",
      binding: { threadId: ids.thread },
      provider: null,
      message: "Navigator source thread is unavailable.",
    });
  });

  it("rebinds a space that names a conversation its assistant is no longer a front on", async () => {
    // The space still names a thread of Zen's own from before the assistant
    // became a front on the host's conversation. Leaving it there would put the
    // conversation the user reads and the thread Zen's tools are authorized
    // against on two different threads, which makes a recipe unproposable.
    let current = {
      ...space(),
      assistant: { threadId: ids.supersededThread, providerId: ids.provider, modelId: "stale" },
    } as ZenSpace;
    const conversation = assistantThread();
    const service = new ZenService({
      focusZone: memoryFocusZone(),
      loadSpace: () => current,
      loadSpaceByWindow: () => current,
      eventStore: {
        append: (next: ZenSpace, expectedVersion: number) =>
          (current = { ...next, version: (expectedVersion + 1) as AggregateVersion }),
        isConcurrencyConflict: () => false,
      } as never,
      localHostId: LOCAL_HOST_ID,
      assistantChat: {
        create: async () => conversation,
        read: () =>
          ({ thread: conversation, turns: [], contents: [] }) as unknown as ChatThreadView,
      },
      assistantProviderState: () => providerState("supported"),
    });

    await service.ensureAssistant(ids.window);

    expect(current.assistant?.threadId).toBe(ids.thread);
    expect(service.isAssistantThread(ids.window, ids.thread)).toBe(true);
    expect(service.isAssistantThread(ids.window, ids.supersededThread)).toBe(false);
  });

  it("proposes a recipe on the bound conversation and refuses every other thread", async () => {
    let current = {
      ...space(),
      assistant: { threadId: ids.thread, providerId: ids.provider, modelId: "model-local" },
    } as ZenSpace;
    const conversation = assistantThread();
    const service = new ZenService({
      focusZone: memoryFocusZone(),
      loadSpace: () => current,
      loadSpaceByWindow: () => current,
      eventStore: {
        append: (next: ZenSpace, expectedVersion: number) =>
          (current = { ...next, version: (expectedVersion + 1) as AggregateVersion }),
        isConcurrencyConflict: () => false,
      } as never,
      localHostId: LOCAL_HOST_ID,
      uuid: () => "00000000-0000-4000-8000-000000000041",
      assistantChat: {
        create: async () => conversation,
        read: () =>
          ({ thread: conversation, turns: [], contents: [] }) as unknown as ChatThreadView,
      },
      assistantProviderState: () => providerState("supported"),
    });

    expect(
      service.previewRecipe(ids.window, ids.thread, {
        expectedVersion: current.version,
        recipe: {
          recipeId: "00000000-0000-4000-8000-000000000042" as never,
          name: "Release focus",
          primitives: ["checklist"],
          fields: [],
        },
      }),
    ).toMatchObject({ recipe: { name: "Release focus" } });

    // An ordinary conversation on this same host is not this window's assistant
    // surface, so it cannot propose anything into this window's Zen space.
    expect(() =>
      service.previewRecipe(ids.window, ids.supersededThread, {
        expectedVersion: current.version,
        recipe: {
          recipeId: "00000000-0000-4000-8000-000000000043" as never,
          name: "Forged focus",
          primitives: ["checklist"],
          fields: [],
        },
      }),
    ).toThrow(/missing-capability/);
  });

  it("keeps one window's proposal out of another window's surface and confirmation", () => {
    // Two windows, each with its own Zen space, both fronts on the one
    // host-owned conversation the host serves every window.
    const spaces = new Map<string, ZenSpace>([
      [
        String(ids.window),
        {
          ...space(),
          assistant: { threadId: ids.thread, providerId: ids.provider, modelId: "model-local" },
        } as ZenSpace,
      ],
      [
        String(ids.otherWindow),
        {
          ...createZenSpace(ids.otherWindow, decodeHostId(LOCAL_HOST_ID)),
          spaceId: ids.otherSpace,
          version: 2 as AggregateVersion,
          assistant: { threadId: ids.thread, providerId: ids.provider, modelId: "model-local" },
        } as ZenSpace,
      ],
    ]);
    const conversation = assistantThread();
    const append = vi.fn((next: ZenSpace, expectedVersion: number) => {
      const committed = { ...next, version: (expectedVersion + 1) as AggregateVersion };
      spaces.set(String(committed.windowId), committed);
      return committed;
    });
    const service = new ZenService({
      focusZone: memoryFocusZone(),
      loadSpace: (spaceId) =>
        [...spaces.values()].find((candidate) => candidate.spaceId === spaceId) ?? null,
      loadSpaceByWindow: (windowId) => spaces.get(String(windowId)) ?? null,
      eventStore: { append, isConcurrencyConflict: () => false } as never,
      localHostId: LOCAL_HOST_ID,
      uuid: () => "00000000-0000-4000-8000-000000000044",
      assistantChat: {
        create: async () => conversation,
        read: () =>
          ({ thread: conversation, turns: [], contents: [] }) as unknown as ChatThreadView,
      },
      assistantProviderState: () => providerState("supported"),
    });

    const preview = service.previewRecipe(ids.window, ids.thread, {
      expectedVersion: spaces.get(String(ids.window))!.version,
      recipe: {
        recipeId: "00000000-0000-4000-8000-000000000045" as never,
        name: "Release focus",
        primitives: ["checklist"],
        fields: [],
      },
    });

    // The other window shares the conversation but not the proposal: it neither
    // sees the preview nor can commit it into its own space.
    expect(() =>
      service.handleCommand(
        {
          command: "confirm-recipe-preview",
          spaceId: ids.otherSpace,
          previewId: preview.previewId,
          action: "place",
          expectedVersion: spaces.get(String(ids.otherWindow))!.version,
        },
        ids.otherWindow,
      ),
    ).toThrow(/stale-preview/);
    expect(append).not.toHaveBeenCalled();

    return Promise.all([
      expect(service.assistantSnapshot(ids.otherWindow)).resolves.toMatchObject({
        recipePreview: null,
      }),
      expect(service.assistantSnapshot(ids.window)).resolves.toMatchObject({
        recipePreview: { previewId: preview.previewId },
      }),
    ]);
  });
});

describe("ZenService focus zone", () => {
  const added = decodeZenSpaceId("00000000-0000-4000-8000-000000000060");

  function zoneFixture() {
    const stored = new Map<string, ZenSpace>([[String(ids.space), space()]]);
    const append = vi.fn((next: ZenSpace, expectedVersion: number) => {
      const committed = { ...next, version: (expectedVersion + 1) as AggregateVersion };
      stored.set(String(committed.spaceId), committed);
      return committed;
    });
    const service = new ZenService({
      focusZone: memoryFocusZone(),
      loadSpace: (spaceId) => stored.get(String(spaceId)) ?? null,
      loadSpaceByWindow: (windowId) =>
        [...stored.values()].find((candidate) => candidate.windowId === windowId) ?? null,
      eventStore: { append, isConcurrencyConflict: () => false } as never,
      localHostId: LOCAL_HOST_ID,
      threadCatalog: { resolve: async () => entry, search: async () => [entry] },
      uuid: () => added,
    });
    return { append, service, stored };
  }

  it("keeps the space a window already had as the first space of its focus zone", () => {
    const { service } = zoneFixture();

    const bootstrap = service.bootstrap(ids.window);

    expect(bootstrap.space?.spaceId).toBe(ids.space);
    expect(bootstrap.focusZone).toMatchObject({
      activeSpaceId: ids.space,
      spaces: [{ spaceId: ids.space, name: "Focus", position: 0 }],
    });
  });

  it("puts a newly added space in front of the window without touching the one it left", () => {
    const { append, service } = zoneFixture();
    const zone = service.focusZoneOrFail(ids.window);

    const result = service.focusZoneCommand(
      { command: "add-space", name: "Review", expectedVersion: zone.version },
      ids.window,
    );

    expect(result.zone.activeSpaceId).toBe(added);
    expect(result.zone.spaces.map((entryOf) => entryOf.name)).toEqual(["Focus", "Review"]);
    expect(result.space.spaceId).toBe(added);
    expect(result.space.elements).toEqual([]);
    // Only the new space and the showing flag were written; nothing pinned to
    // the space the user left was rewritten.
    expect(append.mock.calls.map(([next]) => next.spaceId)).toEqual([added, ids.space]);
  });

  it("carries the focus zone's showing state to the space being switched to", () => {
    const { service, stored } = zoneFixture();
    const zone = service.focusZoneOrFail(ids.window);
    service.focusZoneCommand(
      { command: "add-space", name: "Review", expectedVersion: zone.version },
      ids.window,
    );

    const back = service.focusZoneCommand(
      {
        command: "activate-space",
        spaceId: ids.space,
        expectedVersion: service.focusZoneOrFail(ids.window).version,
      },
      ids.window,
    );

    expect(back.zone.activeSpaceId).toBe(ids.space);
    expect(back.space.active).toBe(true);
    expect(stored.get(String(added))?.active).toBe(false);
  });

  it("refuses to remove a window's last space", () => {
    const { service } = zoneFixture();
    const zone = service.focusZoneOrFail(ids.window);

    expect(() =>
      service.focusZoneCommand(
        { command: "remove-space", spaceId: ids.space, expectedVersion: zone.version },
        ids.window,
      ),
    ).toThrow(/limit-exceeded/);
  });

  it("refuses a focus-zone command that names a version the window has moved past", () => {
    const { service } = zoneFixture();

    expect(() =>
      service.focusZoneCommand(
        { command: "add-space", name: "Review", expectedVersion: 99 as AggregateVersion },
        ids.window,
      ),
    ).toThrow(/stale-version/);
  });

  it("pins a thread to the space in front rather than the one the window opened first", async () => {
    const { service } = zoneFixture();
    const zone = service.focusZoneOrFail(ids.window);
    service.focusZoneCommand(
      { command: "add-space", name: "Review", expectedVersion: zone.version },
      ids.window,
    );

    const result = await service.pinThread(ids.window, {
      catalogRef,
      expectedVersion: service.bootstrap(ids.window).space!.version,
    });

    expect(result.result).toBe("thread-pinned");
    expect(result.space.spaceId).toBe(added);
  });
});

describe("ZenService terminal cards", () => {
  const codeThread = decodeCodeThreadId("00000000-0000-4000-8000-000000000070");
  const checkout = decodeCodeCheckoutId("00000000-0000-4000-8000-000000000071");
  const terminal = "00000000-0000-4000-8000-000000000072" as never;
  const codeRef = decodeZenThreadCatalogRef(`code:${codeThread}`);
  const codeEntry = decodeZenThreadCatalogEntry({
    catalogRef: codeRef,
    hostId: LOCAL_HOST_ID,
    hostLabel: "This Mac",
    mode: "code",
    projectId: ids.project,
    projectLabel: "Release",
    threadId: codeThread,
    title: "Release blocker",
    status: "active",
    recentActivityAt: "2026-07-28T12:00:00.000Z",
    providerInstanceId: ids.provider,
    modelId: "model-local",
    sourceContext: {
      hostId: LOCAL_HOST_ID,
      mode: "code",
      projectId: ids.project,
      threadKind: "code",
      threadId: codeThread,
    },
  });

  function terminalFixture(options: { readonly owned?: boolean } = {}) {
    let current = space();
    const append = vi.fn((next: ZenSpace, expectedVersion: number) => {
      current = { ...next, version: (expectedVersion + 1) as AggregateVersion };
      return current;
    });
    const read = vi.fn(async () => {
      if (options.owned === false) throw new Error("Terminal belongs to another code thread.");
      return { terminalId: terminal, state: "running" as const };
    });
    const service = new ZenService({
      focusZone: memoryFocusZone(),
      loadSpace: () => current,
      loadSpaceByWindow: () => current,
      eventStore: { append, isConcurrencyConflict: () => false } as never,
      localHostId: LOCAL_HOST_ID,
      threadCatalog: { resolve: async () => codeEntry, search: async () => [codeEntry] },
      codeTerminals: { read },
      uuid: () => ids.element,
    });
    return { append, read, service };
  }

  const request = {
    threadId: codeThread,
    checkoutId: checkout,
    terminalId: terminal,
    expectedVersion: 2 as AggregateVersion,
  };

  it("pins a terminal by naming it, and writes the card from what the server resolved", async () => {
    const { append, read, service } = terminalFixture();

    const result = await service.pinTerminal(ids.window, request);

    expect(read).toHaveBeenCalledWith(ids.window, {
      threadId: codeThread,
      checkoutId: checkout,
      terminalId: terminal,
    });
    expect(result.result).toBe("terminal-pinned");
    expect(append.mock.calls[0]?.[0].elements[0]).toMatchObject({
      kind: "terminal",
      checkoutId: checkout,
      terminalId: terminal,
      sourceContext: { threadKind: "code", threadId: codeThread },
      title: "Release blocker",
    });
  });

  it("refuses to pin a terminal this window's Code thread does not own", async () => {
    const { append, service } = terminalFixture({ owned: false });

    await expect(service.pinTerminal(ids.window, request)).rejects.toThrow(/unavailable-source/);
    expect(append).not.toHaveBeenCalled();
  });

  it("refuses to pin a terminal on a host that cannot answer for Code", async () => {
    let current = space();
    const service = new ZenService({
      focusZone: memoryFocusZone(),
      loadSpace: () => current,
      loadSpaceByWindow: () => current,
      eventStore: { append: vi.fn(), isConcurrencyConflict: () => false } as never,
      localHostId: LOCAL_HOST_ID,
      threadCatalog: { resolve: async () => codeEntry, search: async () => [codeEntry] },
      uuid: () => ids.element,
    });

    await expect(service.pinTerminal(ids.window, request)).rejects.toThrow(/missing-capability/);
    expect(current.elements).toEqual([]);
  });
});

describe("ZenService research dock", () => {
  const workThread = decodeWorkThreadId("00000000-0000-4000-8000-000000000080");
  const workEntry = decodeZenThreadCatalogEntry({
    catalogRef: decodeZenThreadCatalogRef(`work:${workThread}`),
    hostId: LOCAL_HOST_ID,
    hostLabel: "This Mac",
    mode: "work",
    projectId: ids.project,
    projectLabel: "Release",
    threadId: workThread,
    title: "Competitive read",
    status: "active",
    recentActivityAt: "2026-07-28T12:00:00.000Z",
    providerInstanceId: ids.provider,
    modelId: "model-local",
    sourceContext: {
      hostId: LOCAL_HOST_ID,
      mode: "work",
      projectId: ids.project,
      threadKind: "work",
      threadId: workThread,
    },
  });

  function dockFixture(options: { readonly resolves?: boolean } = {}) {
    let current = space();
    const append = vi.fn((next: ZenSpace, expectedVersion: number) => {
      current = { ...next, version: (expectedVersion + 1) as AggregateVersion };
      return current;
    });
    const service = new ZenService({
      focusZone: memoryFocusZone(),
      loadSpace: () => current,
      loadSpaceByWindow: () => current,
      eventStore: { append, isConcurrencyConflict: () => false } as never,
      localHostId: LOCAL_HOST_ID,
      threadCatalog: {
        resolve: async () => (options.resolves === false ? undefined : workEntry),
        search: async () => [workEntry],
      },
      uuid: () => ids.element,
    });
    return { append, service };
  }

  it("docks a research browser under the source context the server resolved", async () => {
    const { append, service } = dockFixture();

    const result = await service.dockResearch(ids.window, {
      thread: { threadId: workThread, mode: "work" },
      expectedVersion: 2 as AggregateVersion,
    });

    expect(result.result).toBe("research-docked");
    expect(append.mock.calls[0]?.[0].research).toMatchObject({
      sourceContext: { threadKind: "work", threadId: workThread },
      collapsed: false,
    });
  });

  it("refuses to dock onto a thread this window cannot see", async () => {
    const { append, service } = dockFixture({ resolves: false });

    await expect(
      service.dockResearch(ids.window, {
        thread: { threadId: workThread, mode: "work" },
        expectedVersion: 2 as AggregateVersion,
      }),
    ).rejects.toThrow(/unavailable-source/);
    expect(append).not.toHaveBeenCalled();
  });

  it("closes the dock without asking the catalog for anything", async () => {
    const { append, service } = dockFixture({ resolves: false });

    const result = await service.dockResearch(ids.window, {
      thread: null,
      expectedVersion: 2 as AggregateVersion,
    });

    expect(result.space.research).toBeNull();
    expect(append.mock.calls[0]?.[0].research).toBeNull();
  });
});

describe("ZenService canvas cards", () => {
  const canvasId = decodeCanvasId("00000000-0000-4000-8000-000000000090");

  function canvasFixture(options: { readonly readable?: boolean } = {}) {
    let current = space();
    const append = vi.fn((next: ZenSpace, expectedVersion: number) => {
      current = { ...next, version: (expectedVersion + 1) as AggregateVersion };
      return current;
    });
    const read = vi.fn(async () =>
      options.readable === false ? undefined : { title: "Release plan" },
    );
    const service = new ZenService({
      focusZone: memoryFocusZone(),
      loadSpace: () => current,
      loadSpaceByWindow: () => current,
      eventStore: { append, isConcurrencyConflict: () => false } as never,
      localHostId: LOCAL_HOST_ID,
      canvases: { read },
      uuid: () => ids.element,
    });
    return { append, read, service };
  }

  const request = { canvasId, expectedVersion: 2 as AggregateVersion };

  it("pins a canvas by naming it, and titles the card from what Canvas answered", async () => {
    const { append, read, service } = canvasFixture();

    const result = await service.pinCanvas(ids.window, request);

    expect(read).toHaveBeenCalledWith(ids.window, canvasId);
    expect(result.result).toBe("canvas-pinned");
    expect(append.mock.calls[0]?.[0].elements[0]).toMatchObject({
      kind: "canvas",
      canvasId,
      title: "Release plan",
    });
  });

  it("writes no canvas state into the card beyond where it sits", async () => {
    const { append, service } = canvasFixture();

    await service.pinCanvas(ids.window, request);

    // A card that carried a version or a copy of the content could come to
    // disagree with the tab on the same canvas.
    expect(Object.keys(append.mock.calls[0]?.[0].elements[0] ?? {}).sort()).toEqual([
      "canvasId",
      "elementId",
      "geometry",
      "kind",
      "locked",
      "minimized",
      "title",
      "zIndex",
    ]);
  });

  it("refuses to pin a canvas this window may not read", async () => {
    const { append, service } = canvasFixture({ readable: false });

    await expect(service.pinCanvas(ids.window, request)).rejects.toThrow(/unavailable-source/);
    expect(append).not.toHaveBeenCalled();
  });

  it("refuses to pin a canvas on a host that cannot answer for Canvas", async () => {
    let current = space();
    const service = new ZenService({
      focusZone: memoryFocusZone(),
      loadSpace: () => current,
      loadSpaceByWindow: () => current,
      eventStore: { append: vi.fn(), isConcurrencyConflict: () => false } as never,
      localHostId: LOCAL_HOST_ID,
      uuid: () => ids.element,
    });

    await expect(service.pinCanvas(ids.window, request)).rejects.toThrow(/missing-capability/);
    expect(current.elements).toEqual([]);
  });
});
