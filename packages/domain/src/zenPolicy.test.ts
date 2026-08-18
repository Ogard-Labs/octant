import { describe, expect, it } from "vitest";
import {
  addElement,
  createZenSpace,
  removeElement,
  updateElement,
  updateViewport,
  updateAppearance,
  bindAssistant,
  dockResearch,
  recoverSpace,
  processZenCommand,
  reconcileScheduledTimer,
  checkChecklistIsolation,
  resolveAccessibilityFallbacks,
  validateGeometry,
  validateSafeUrl,
  validateWidgetRecipe,
  validateLocalHostSource,
  ZenPolicyRejected,
  MAX_ZEN_ELEMENTS,
  MAX_LIVE_ZEN_CARDS,
  resolveZenLiveCardActivity,
} from "./zenPolicy";
import { DEFAULT_ZEN_APPEARANCE, DEFAULT_ZEN_VIEWPORT } from "@octant/contracts/zen";
import type {
  ZenSpace,
  ZenSpaceId,
  ZenElementId,
  ZenElementPayload,
  ZenWidgetRecipeDraft,
  ZenSourceContext,
} from "@octant/contracts/zen";
import type { AggregateVersion } from "@octant/contracts/events";

function makeId(prefix: string): any {
  return `${prefix}-0000-4000-8000-000000000000`;
}

const localHostId = "local" as any;
const now = "2026-07-24T10:00:00.000Z" as any;

function makeSpace(version: number = 0, elements: ZenElementPayload[] = []): ZenSpace {
  return {
    spaceId: makeId("11111111") as ZenSpaceId,
    windowId: makeId("33333333"),
    version: version as AggregateVersion,
    elements,
    viewport: DEFAULT_ZEN_VIEWPORT,
    appearance: DEFAULT_ZEN_APPEARANCE,
    active: false,
    barCollapsed: false,
    assistant: null,
    research: null,
    createdAt: now,
    updatedAt: now,
  };
}

function makeNotesElement(
  id: string = makeId("22222222"),
  zIndex: number = 1,
  content: string = "test",
): Extract<ZenElementPayload, { kind: "notes" }> {
  return {
    elementId: id as ZenElementId,
    kind: "notes",
    widgetVersion: 0 as AggregateVersion,
    content,
    geometry: { x: 100, y: 100, width: 400, height: 300 },
    zIndex: zIndex as any,
    minimized: false,
    locked: false,
  };
}

function makeThreadElement(id: string = makeId("44444444"), zIndex: number = 1): ZenElementPayload {
  return {
    elementId: id as ZenElementId,
    kind: "thread",
    sourceContext: {
      hostId: localHostId,
      mode: "chat",
      projectId: null,
      threadKind: "chat",
      threadId: makeId("55555555"),
    },
    geometry: { x: 100, y: 100, width: 400, height: 300 },
    zIndex: zIndex as any,
    minimized: false,
    locked: false,
  };
}

function makeTerminalElement(
  id: string = makeId("4a4a4a4a"),
): Extract<ZenElementPayload, { kind: "terminal" }> {
  return {
    elementId: id as ZenElementId,
    kind: "terminal",
    sourceContext: {
      hostId: localHostId,
      mode: "code",
      projectId: null,
      threadKind: "code",
      threadId: makeId("5a5a5a5a"),
    },
    checkoutId: makeId("5b5b5b5b"),
    terminalId: makeId("5c5c5c5c"),
    geometry: { x: 100, y: 100, width: 520, height: 320 },
    zIndex: 1,
    minimized: false,
    locked: false,
  } as unknown as Extract<ZenElementPayload, { kind: "terminal" }>;
}

function makeTimerElement(
  overrides: Partial<Extract<ZenElementPayload, { kind: "timer" }>> = {},
): Extract<ZenElementPayload, { kind: "timer" }> {
  return {
    elementId: makeId("77777777") as ZenElementId,
    kind: "timer",
    durationMs: 25 * 60 * 1000,
    remainingMs: 25 * 60 * 1000,
    status: "idle",
    startedAt: null,
    deadlineAt: null,
    clockSessionId: null,
    monotonicStartedMs: null,
    geometry: { x: 100, y: 100, width: 400, height: 300 },
    zIndex: 1 as any,
    minimized: false,
    locked: false,
    title: "Focus timer",
    ...overrides,
  };
}

describe("createZenSpace", () => {
  it("creates a space with defaults", () => {
    const space = createZenSpace(makeId("33333333"), localHostId);
    expect(space.version).toBe(0);
    expect(space.elements).toEqual([]);
    expect(space.assistant).toBeNull();
    expect(space.viewport).toEqual(DEFAULT_ZEN_VIEWPORT);
    expect(space.appearance).toEqual(DEFAULT_ZEN_APPEARANCE);
    expect(space.active).toBe(true);
    expect(space.barCollapsed).toBe(false);
  });

  it("accepts custom appearance", () => {
    const appearance = { ...DEFAULT_ZEN_APPEARANCE, dimming: 50 };
    const space = createZenSpace(makeId("33333333"), localHostId, appearance);
    expect(space.appearance.dimming).toBe(50);
  });

  it("accepts a first-party built-in background", () => {
    const appearance = {
      ...DEFAULT_ZEN_APPEARANCE,
      background: {
        kind: "builtin" as const,
        presetId: "nordic-fjord-aurora" as const,
        overlay: 30,
        fill: "cover" as const,
      },
    };
    const space = createZenSpace(makeId("33333333"), localHostId, appearance);
    expect(space.appearance.background).toEqual(appearance.background);
  });

  it("rejects an unknown built-in background", () => {
    expect(() =>
      createZenSpace(makeId("33333333"), localHostId, {
        ...DEFAULT_ZEN_APPEARANCE,
        background: {
          kind: "builtin",
          presetId: "not-a-preset",
          overlay: 20,
          fill: "cover",
        } as never,
      }),
    ).toThrow(ZenPolicyRejected);
  });
});

describe("addElement", () => {
  it("adds a notes element", () => {
    const space = makeSpace();
    const updated = addElement(space, makeNotesElement(), 0, localHostId);
    expect(updated.elements).toHaveLength(1);
    expect(updated.version).toBe(1);
  });

  it("adds a thread element with local host", () => {
    const space = makeSpace();
    const updated = addElement(space, makeThreadElement(), 0, localHostId);
    expect(updated.elements[0]?.kind).toBe("thread");
  });

  it("pins a terminal card under the thread that owns the shell", () => {
    const space = makeSpace();
    const updated = addElement(space, makeTerminalElement(), 0, localHostId);
    expect(updated.elements[0]).toMatchObject({
      kind: "terminal",
      sourceContext: { threadKind: "code" },
    });
  });

  it("refuses a terminal card naming a shell on some other host", () => {
    const space = makeSpace();
    const elsewhere = makeTerminalElement();
    expect(() =>
      addElement(
        space,
        {
          ...elsewhere,
          sourceContext: { ...elsewhere.sourceContext, hostId: makeId("99999999") },
        } as ZenElementPayload,
        0,
        localHostId,
      ),
    ).toThrow(ZenPolicyRejected);
  });

  it("rejects stale version", () => {
    const space = makeSpace(5);
    expect(() => addElement(space, makeNotesElement(), 3, localHostId)).toThrow(ZenPolicyRejected);
  });

  it("rejects duplicate element ID", () => {
    const el = makeNotesElement();
    const space = makeSpace(0, [el]);
    expect(() => addElement(space, el, 1, localHostId)).toThrow(ZenPolicyRejected);
  });

  it("rejects duplicate z-index", () => {
    const space = makeSpace(0, [makeNotesElement(makeId("aaaa"), 1)]);
    expect(() => addElement(space, makeNotesElement(makeId("bbbb"), 1), 0, localHostId)).toThrow(
      ZenPolicyRejected,
    );
  });

  it("rejects element limit", () => {
    const space = makeSpace(
      MAX_ZEN_ELEMENTS,
      Array(MAX_ZEN_ELEMENTS)
        .fill(null)
        .map((_, i) => makeNotesElement(makeId(String(i).padStart(8, "0")), i + 1)),
    );
    expect(() =>
      addElement(
        space,
        makeNotesElement(makeId("zzzz"), MAX_ZEN_ELEMENTS + 1),
        MAX_ZEN_ELEMENTS,
        localHostId,
      ),
    ).toThrow(ZenPolicyRejected);
  });

  it("rejects cross-host thread source", () => {
    const el: ZenElementPayload = {
      elementId: makeId("44444444") as ZenElementId,
      kind: "thread",
      sourceContext: {
        hostId: "remote-host" as any,
        mode: "chat",
        projectId: null,
        threadKind: "chat",
        threadId: makeId("55555555"),
      },
      geometry: { x: 100, y: 100, width: 400, height: 300 },
      zIndex: 1 as any,
      minimized: false,
      locked: false,
    };
    expect(() => addElement(makeSpace(), el, 0, localHostId)).toThrow(ZenPolicyRejected);
  });

  it("allows cross-Project thread attachment", () => {
    const el: ZenElementPayload = {
      elementId: makeId("44444444") as ZenElementId,
      kind: "thread",
      sourceContext: {
        hostId: localHostId,
        mode: "code",
        projectId: makeId("99999999"),
        threadKind: "code",
        threadId: makeId("55555555"),
      },
      geometry: { x: 100, y: 100, width: 400, height: 300 },
      zIndex: 1 as any,
      minimized: false,
      locked: false,
    };
    const updated = addElement(makeSpace(), el, 0, localHostId);
    const attached = updated.elements[0];
    expect(attached?.kind).toBe("thread");
    if (attached?.kind === "thread") {
      expect(attached.sourceContext.projectId).toBe(makeId("99999999"));
    }
  });
});

describe("updateElement", () => {
  it("updates an existing element", () => {
    const el = makeNotesElement();
    const space = makeSpace(0, [el]);
    const updatedEl = { ...el, geometry: { ...el.geometry, x: 240 } };
    const result = updateElement(space, updatedEl, 0, localHostId);
    const resultElement = result.elements[0];
    expect(resultElement?.kind).toBe("notes");
    if (resultElement?.kind === "notes") {
      expect(resultElement.content).toBe("test");
      expect(resultElement.geometry.x).toBe(240);
    }
    expect(result.version).toBe(1);
  });

  it("rejects widget data changes through the generic presentation mutation", () => {
    const notes = makeNotesElement();
    const checklist: ZenElementPayload = {
      elementId: makeId("66666666") as ZenElementId,
      kind: "checklist",
      widgetVersion: 0 as AggregateVersion,
      items: [],
      geometry: { x: 100, y: 100, width: 400, height: 300 },
      zIndex: 2,
      minimized: false,
      locked: false,
    };
    const space = makeSpace(0, [notes, checklist]);

    expect(() =>
      updateElement(
        space,
        { ...notes, content: "forged", widgetVersion: 9 as AggregateVersion },
        0,
        localHostId,
      ),
    ).toThrow(/typed widget command/i);
    expect(() =>
      updateElement(
        space,
        {
          ...checklist,
          items: [{ itemId: makeId("77777777"), text: "forged", done: false }],
        },
        0,
        localHostId,
      ),
    ).toThrow(/typed widget command/i);
  });

  it("rejects unknown element", () => {
    const space = makeSpace();
    expect(() => updateElement(space, makeNotesElement(), 0, localHostId)).toThrow(
      ZenPolicyRejected,
    );
  });

  it("rejects stale version", () => {
    const space = makeSpace(5, [makeNotesElement()]);
    expect(() => updateElement(space, makeNotesElement(), 3, localHostId)).toThrow(
      ZenPolicyRejected,
    );
  });

  it("preserves authoritative timer lifecycle fields during presentation updates", () => {
    const timer = makeTimerElement({
      status: "running",
      startedAt: "2026-07-29T08:00:00.000Z" as any,
      deadlineAt: "2026-07-29T08:25:00.000Z" as any,
      clockSessionId: "session-a",
      monotonicStartedMs: 10_000,
    });
    const result = updateElement(
      makeSpace(0, [timer]),
      {
        ...timer,
        geometry: { ...timer.geometry, x: 200 },
        status: "completed",
        remainingMs: 0,
        startedAt: null,
        deadlineAt: null,
        clockSessionId: null,
        monotonicStartedMs: null,
      },
      0,
      localHostId,
    );

    expect(result.elements[0]).toMatchObject({
      geometry: { x: 200 },
      status: "running",
      remainingMs: 25 * 60 * 1000,
      clockSessionId: "session-a",
    });
  });
});

describe("timer lifecycle", () => {
  it("reconciles a scheduled timer from monotonic expiry when wall time moves backward", () => {
    const running = makeTimerElement({
      status: "running",
      remainingMs: 20 * 60 * 1000,
      startedAt: "2026-07-29T08:00:00.000Z" as any,
      deadlineAt: "2026-07-29T08:20:00.000Z" as any,
      clockSessionId: "same-server-session",
      monotonicStartedMs: 10_000,
    });

    const completed = reconcileScheduledTimer(makeSpace(4, [running]), running.elementId, {
      wallTimeMs: Date.parse("2026-07-29T07:00:00.000Z"),
      monotonicTimeMs: 10_000 + 20 * 60 * 1000,
      sessionId: "same-server-session",
    });

    expect(completed.elements[0]).toMatchObject({ status: "completed", remainingMs: 0 });
  });

  it("uses monotonic elapsed time during a clock jump, then pauses idempotently", () => {
    const initial = makeSpace(0, [makeTimerElement()]);
    const started = processZenCommand(
      initial,
      {
        command: "timer-action",
        spaceId: initial.spaceId,
        elementId: initial.elements[0]!.elementId,
        action: "start",
        expectedVersion: 0 as AggregateVersion,
      },
      localHostId,
      {
        wallTimeMs: Date.parse("2026-07-29T08:00:00.000Z"),
        monotonicTimeMs: 10_000,
        sessionId: "session-a",
      },
    );
    const paused = processZenCommand(
      started,
      {
        command: "timer-action",
        spaceId: started.spaceId,
        elementId: initial.elements[0]!.elementId,
        action: "pause",
        expectedVersion: started.version,
      },
      localHostId,
      {
        wallTimeMs: Date.parse("2026-07-29T11:00:00.000Z"),
        monotonicTimeMs: 70_000,
        sessionId: "session-a",
      },
    );
    const duplicate = processZenCommand(
      paused,
      {
        command: "timer-action",
        spaceId: paused.spaceId,
        elementId: initial.elements[0]!.elementId,
        action: "pause",
        expectedVersion: paused.version,
      },
      localHostId,
      {
        wallTimeMs: Date.parse("2026-07-29T11:00:01.000Z"),
        monotonicTimeMs: 71_000,
        sessionId: "session-a",
      },
    );

    expect(started.elements[0]).toMatchObject({ status: "running", clockSessionId: "session-a" });
    expect(paused.elements[0]).toMatchObject({ status: "paused", remainingMs: 24 * 60 * 1000 });
    expect(duplicate).toBe(paused);
  });

  it("uses persisted wall time after restart without touching other work", () => {
    const note = makeNotesElement(makeId("88888888"), 2, "Keep this work intact");
    const running = makeTimerElement({
      status: "running",
      remainingMs: 20 * 60 * 1000,
      startedAt: "2026-07-29T08:00:00.000Z" as any,
      deadlineAt: "2026-07-29T08:20:00.000Z" as any,
      clockSessionId: "old-session",
      monotonicStartedMs: 10_000,
    });
    const space = makeSpace(4, [running, note]);
    const completed = processZenCommand(
      space,
      {
        command: "timer-action",
        spaceId: space.spaceId,
        elementId: running.elementId,
        action: "pause",
        expectedVersion: 4 as AggregateVersion,
      },
      localHostId,
      {
        wallTimeMs: Date.parse("2026-07-29T08:30:00.000Z"),
        monotonicTimeMs: 5_000,
        sessionId: "new-session",
      },
    );

    expect(completed.elements[0]).toMatchObject({ status: "completed", remainingMs: 0 });
    expect(completed.elements[1]).toEqual(note);
  });

  it("completes from suspend-aware monotonic elapsed time after wake", () => {
    const running = makeTimerElement({
      status: "running",
      remainingMs: 20 * 60 * 1000,
      startedAt: "2026-07-29T08:00:00.000Z" as any,
      deadlineAt: "2026-07-29T08:20:00.000Z" as any,
      clockSessionId: "same-server-session",
      monotonicStartedMs: 10_000,
    });
    const space = makeSpace(4, [running]);
    const completed = processZenCommand(
      space,
      {
        command: "timer-action",
        spaceId: space.spaceId,
        elementId: running.elementId,
        action: "pause",
        expectedVersion: 4 as AggregateVersion,
      },
      localHostId,
      {
        wallTimeMs: Date.parse("2026-07-29T08:30:00.000Z"),
        monotonicTimeMs: 10_000 + 30 * 60 * 1000,
        sessionId: "same-server-session",
      },
    );

    expect(completed.elements[0]).toMatchObject({ status: "completed", remainingMs: 0 });
  });

  it("fails a stale timer action safely", () => {
    const space = makeSpace(3, [makeTimerElement()]);
    expect(() =>
      processZenCommand(
        space,
        {
          command: "timer-action",
          spaceId: space.spaceId,
          elementId: space.elements[0]!.elementId,
          action: "start",
          expectedVersion: 2 as AggregateVersion,
        },
        localHostId,
        { wallTimeMs: Date.now(), monotonicTimeMs: 100, sessionId: "session-a" },
      ),
    ).toThrow(ZenPolicyRejected);
  });
});

describe("removeElement", () => {
  it("removes an element and renumbers z-indices", () => {
    const space = makeSpace(0, [
      makeNotesElement(makeId("aaaa"), 1),
      makeNotesElement(makeId("bbbb"), 2),
      makeNotesElement(makeId("cccc"), 3),
    ]);
    const result = removeElement(space, makeId("bbbb") as ZenElementId, 0);
    expect(result.elements).toHaveLength(2);
    expect(result.elements[0]?.zIndex).toBe(1);
    expect(result.elements[1]?.zIndex).toBe(2);
  });

  it("rejects unknown element", () => {
    const space = makeSpace();
    expect(() => removeElement(space, makeId("zzzz") as ZenElementId, 0)).toThrow(
      ZenPolicyRejected,
    );
  });
});

describe("updateViewport", () => {
  it("updates viewport", () => {
    const space = makeSpace();
    const result = updateViewport(space, { panX: 10, panY: 20, scale: 1.5 }, 0);
    expect(result.viewport).toEqual({ panX: 10, panY: 20, scale: 1.5 });
  });
});

describe("updateAppearance", () => {
  it("updates appearance", () => {
    const space = makeSpace();
    const appearance = { ...DEFAULT_ZEN_APPEARANCE, dimming: 30 };
    const result = updateAppearance(space, appearance, 0);
    expect(result.appearance.dimming).toBe(30);
  });
});

describe("bindAssistant", () => {
  it("binds assistant", () => {
    const space = makeSpace();
    const assistant = {
      threadId: makeId("55555555"),
      providerId: "openai",
      modelId: "gpt-4o",
    };
    const result = bindAssistant(space, assistant, 0);
    expect(result.assistant).toEqual(assistant);
  });
});

describe("dockResearch", () => {
  const workSource: ZenSourceContext = {
    hostId: localHostId,
    mode: "work",
    projectId: null,
    threadKind: "work",
    threadId: makeId("66666666") as ZenSourceContext["threadId"],
  };

  it("docks a research browser onto a Work or Code thread", () => {
    const result = dockResearch(
      makeSpace(),
      { sourceContext: workSource, width: 480, collapsed: false },
      0,
    );
    expect(result.research).toEqual({
      sourceContext: workSource,
      width: 480,
      collapsed: false,
    });
  });

  it("closes the dock by holding nothing", () => {
    const docked = dockResearch(
      makeSpace(),
      { sourceContext: workSource, width: 480, collapsed: false },
      0,
    );
    expect(dockResearch(docked, null, docked.version).research).toBeNull();
  });

  it("refuses to dock onto a Chat thread, which has no browsing context", () => {
    expect(() =>
      dockResearch(
        makeSpace(),
        {
          sourceContext: { ...workSource, mode: "chat" as const, threadKind: "chat" as const },
          width: 480,
          collapsed: false,
        },
        0,
      ),
    ).toThrow();
  });

  it("refuses a dock written against a space that has moved on", () => {
    expect(() => dockResearch(makeSpace(3), null, 2)).toThrow();
  });
});

describe("recoverSpace", () => {
  it("recovers space to empty state", () => {
    const space = makeSpace(3, [makeNotesElement(), makeThreadElement(makeId("xx"), 2)]);
    const result = recoverSpace(space, 3);
    expect(result.elements).toEqual([]);
    expect(result.viewport).toEqual(DEFAULT_ZEN_VIEWPORT);
    expect(result.appearance).toEqual(DEFAULT_ZEN_APPEARANCE);
    expect(result.version).toBe(4);
  });
});

describe("checkChecklistIsolation", () => {
  it("returns true for clean space", () => {
    expect(checkChecklistIsolation(makeSpace())).toBe(true);
  });

  it("returns true for space with checklist", () => {
    const space = makeSpace(0, [
      {
        elementId: makeId("22222222") as ZenElementId,
        kind: "checklist",
        widgetVersion: 0 as AggregateVersion,
        items: [{ itemId: makeId("66666666"), text: "Task 1", done: false }],
        geometry: { x: 100, y: 100, width: 400, height: 300 },
        zIndex: 1 as any,
        minimized: false,
        locked: false,
      },
    ]);
    expect(checkChecklistIsolation(space)).toBe(true);
  });
});

describe("resolveAccessibilityFallbacks", () => {
  it("applies system reduced motion", () => {
    const result = resolveAccessibilityFallbacks(DEFAULT_ZEN_APPEARANCE, true, false, false);
    expect(result.reducedMotion).toBe(true);
  });

  it("merges user and system settings", () => {
    const appearance = { ...DEFAULT_ZEN_APPEARANCE, reducedTransparency: true };
    const result = resolveAccessibilityFallbacks(appearance, false, false, true);
    expect(result.reducedTransparency).toBe(true);
    expect(result.increasedContrast).toBe(true);
  });

  it("replaces an animated built-in with its still fallback when Reduced Motion is on", () => {
    const appearance = {
      ...DEFAULT_ZEN_APPEARANCE,
      background: {
        kind: "builtin" as const,
        presetId: "perspective-dot-plane-animated" as const,
        overlay: 20,
        fill: "cover" as const,
      },
    };
    const result = resolveAccessibilityFallbacks(appearance, true, false, false);
    expect(result.reducedMotion).toBe(true);
    expect(result.background).toEqual({
      kind: "builtin",
      presetId: "perspective-dot-plane",
      overlay: 20,
      fill: "cover",
    });
  });

  it("replaces a custom animated upload with its still frame when Reduced Motion is on", () => {
    const appearance = {
      ...DEFAULT_ZEN_APPEARANCE,
      background: {
        kind: "image" as const,
        assetId: makeId("77777777"),
        stillAssetId: makeId("88888888"),
        overlay: 18,
        fill: "cover" as const,
      },
    };
    const result = resolveAccessibilityFallbacks(appearance, true, false, false);
    expect(result.reducedMotion).toBe(true);
    expect(result.background).toEqual({
      kind: "image",
      assetId: makeId("88888888"),
      overlay: 18,
      fill: "cover",
    });
  });
});

describe("validateGeometry", () => {
  it("accepts valid geometry", () => {
    expect(() => validateGeometry({ x: 0, y: 0, width: 400, height: 300 })).not.toThrow();
  });

  it("rejects NaN geometry", () => {
    expect(() => validateGeometry({ x: NaN, y: 0, width: 400, height: 300 })).toThrow(
      ZenPolicyRejected,
    );
  });
});

describe("validateSafeUrl", () => {
  it("accepts https url", () => {
    expect(() => validateSafeUrl("https://example.com")).not.toThrow();
  });

  it("rejects javascript url", () => {
    expect(() => validateSafeUrl("javascript:alert(1)")).toThrow(ZenPolicyRejected);
  });
});

describe("validateWidgetRecipe", () => {
  it("accepts valid recipe", () => {
    const recipe: ZenWidgetRecipeDraft = {
      recipeId: makeId("77777777"),
      name: "Focus Timer",
      primitives: ["timer"],
      fields: [],
    };
    expect(() => validateWidgetRecipe(recipe)).not.toThrow();
  });

  it("rejects recipe with script content", () => {
    const recipe: ZenWidgetRecipeDraft = {
      recipeId: makeId("77777777"),
      name: "<script>alert(1)</script>",
      primitives: ["notes"],
      fields: [],
    };
    expect(() => validateWidgetRecipe(recipe)).toThrow(ZenPolicyRejected);
  });
});

describe("validateLocalHostSource", () => {
  it("accepts local host", () => {
    const ctx: ZenSourceContext = {
      hostId: localHostId,
      mode: "chat",
      projectId: null,
      threadKind: "chat",
      threadId: makeId("55555555"),
    };
    expect(() => validateLocalHostSource(ctx, localHostId)).not.toThrow();
  });

  it("rejects remote host", () => {
    const ctx: ZenSourceContext = {
      hostId: "remote" as any,
      mode: "chat",
      projectId: null,
      threadKind: "chat",
      threadId: makeId("55555555"),
    };
    expect(() => validateLocalHostSource(ctx, localHostId)).toThrow(ZenPolicyRejected);
  });
});

describe("processZenCommand", () => {
  it("processes set-presentation command for active and barCollapsed", () => {
    const space = makeSpace();
    const active = processZenCommand(
      space,
      {
        command: "set-presentation",
        spaceId: space.spaceId,
        expectedVersion: 0 as AggregateVersion,
        active: true,
      },
      localHostId,
    );
    expect(active.active).toBe(true);
    expect(active.barCollapsed).toBe(false);
    expect(active.version).toBe(1);

    const collapsed = processZenCommand(
      active,
      {
        command: "set-presentation",
        spaceId: space.spaceId,
        expectedVersion: 1 as AggregateVersion,
        barCollapsed: true,
      },
      localHostId,
    );
    expect(collapsed.active).toBe(true);
    expect(collapsed.barCollapsed).toBe(true);
    expect(collapsed.version).toBe(2);

    const exited = processZenCommand(
      collapsed,
      {
        command: "set-presentation",
        spaceId: space.spaceId,
        expectedVersion: 2 as AggregateVersion,
        active: false,
      },
      localHostId,
    );
    expect(exited.active).toBe(false);
    expect(exited.barCollapsed).toBe(true);
    expect(exited.version).toBe(3);
  });

  it("rejects stale version for set-presentation", () => {
    const space = makeSpace(2);
    expect(() =>
      processZenCommand(
        space,
        {
          command: "set-presentation",
          spaceId: space.spaceId,
          expectedVersion: 0 as AggregateVersion,
          active: true,
        },
        localHostId,
      ),
    ).toThrow(ZenPolicyRejected);
  });

  it("rejects a no-op set-presentation command with neither active nor barCollapsed", () => {
    const space = makeSpace();
    expect(() =>
      processZenCommand(
        space,
        {
          command: "set-presentation",
          spaceId: space.spaceId,
          expectedVersion: 0 as AggregateVersion,
        },
        localHostId,
      ),
    ).toThrow(ZenPolicyRejected);
  });

  it("processes add-element command", () => {
    const space = makeSpace();
    const command = {
      command: "add-element" as const,
      spaceId: space.spaceId,
      element: makeNotesElement(),
      expectedVersion: 0 as AggregateVersion,
    };
    const result = processZenCommand(space, command, localHostId);
    expect(result.elements).toHaveLength(1);
  });

  it("processes remove-element command", () => {
    const el = makeNotesElement();
    const space = makeSpace(0, [el]);
    const command = {
      command: "remove-element" as const,
      spaceId: space.spaceId,
      elementId: el.elementId,
      expectedVersion: 0 as AggregateVersion,
    };
    const result = processZenCommand(space, command, localHostId);
    expect(result.elements).toHaveLength(0);
  });

  it("saves notes only when aggregate and widget versions match", () => {
    const notes = makeNotesElement();
    const space = makeSpace(4, [notes]);
    const result = processZenCommand(
      space,
      {
        command: "save-notes",
        spaceId: space.spaceId,
        elementId: notes.elementId,
        content: "Durable draft",
        expectedVersion: 4 as AggregateVersion,
        expectedWidgetVersion: 0 as AggregateVersion,
      },
      localHostId,
    );

    expect(result.elements[0]).toMatchObject({
      kind: "notes",
      content: "Durable draft",
      widgetVersion: 1,
    });
  });

  it("rejects a stale notes widget version without changing content", () => {
    const notes = makeNotesElement();
    const space = makeSpace(4, [notes]);

    expect(() =>
      processZenCommand(
        space,
        {
          command: "save-notes",
          spaceId: space.spaceId,
          elementId: notes.elementId,
          content: "Stale draft",
          expectedVersion: 4 as AggregateVersion,
          expectedWidgetVersion: 3 as AggregateVersion,
        },
        localHostId,
      ),
    ).toThrow(/widget version/i);
    expect(notes).toMatchObject({ content: "test", widgetVersion: 0 });
  });

  it("completes, reorders, and removes stable checklist item identities", () => {
    const firstId = makeId("66666666");
    const secondId = makeId("77777777");
    const checklist: ZenElementPayload = {
      elementId: makeId("22222222") as ZenElementId,
      kind: "checklist",
      widgetVersion: 0 as AggregateVersion,
      items: [
        { itemId: firstId, text: "First", done: false },
        { itemId: secondId, text: "Second", done: false },
      ],
      geometry: { x: 100, y: 100, width: 400, height: 300 },
      zIndex: 1,
      minimized: false,
      locked: false,
    };

    const completed = processZenCommand(
      makeSpace(2, [checklist]),
      {
        command: "set-checklist-item-completed",
        spaceId: makeSpace().spaceId,
        elementId: checklist.elementId,
        itemId: firstId,
        done: true,
        expectedVersion: 2 as AggregateVersion,
        expectedWidgetVersion: 0 as AggregateVersion,
      },
      localHostId,
    );
    const reordered = processZenCommand(
      completed,
      {
        command: "reorder-checklist-item",
        spaceId: completed.spaceId,
        elementId: checklist.elementId,
        itemId: secondId,
        beforeItemId: firstId,
        expectedVersion: 3 as AggregateVersion,
        expectedWidgetVersion: 1 as AggregateVersion,
      },
      localHostId,
    );
    const removed = processZenCommand(
      reordered,
      {
        command: "remove-checklist-item",
        spaceId: reordered.spaceId,
        elementId: checklist.elementId,
        itemId: firstId,
        expectedVersion: 4 as AggregateVersion,
        expectedWidgetVersion: 2 as AggregateVersion,
      },
      localHostId,
    );

    expect(completed.elements[0]).toMatchObject({ widgetVersion: 1 });
    expect(
      completed.elements[0]?.kind === "checklist" ? completed.elements[0].items[0] : null,
    ).toMatchObject({ itemId: firstId, done: true });
    expect(reordered.elements[0]).toMatchObject({ widgetVersion: 2 });
    expect(reordered.elements[0]?.kind === "checklist" ? reordered.elements[0].items : []).toEqual([
      expect.objectContaining({ itemId: secondId }),
      expect.objectContaining({ itemId: firstId }),
    ]);
    expect(removed.elements[0]).toMatchObject({ widgetVersion: 3 });
    expect(removed.elements[0]?.kind === "checklist" ? removed.elements[0].items : []).toEqual([
      expect.objectContaining({ itemId: secondId }),
    ]);
  });

  it("rejects forged checklist identities without mutation", () => {
    const checklist: ZenElementPayload = {
      elementId: makeId("22222222") as ZenElementId,
      kind: "checklist",
      widgetVersion: 0 as AggregateVersion,
      items: [],
      geometry: { x: 100, y: 100, width: 400, height: 300 },
      zIndex: 1,
      minimized: false,
      locked: false,
    };

    expect(() =>
      processZenCommand(
        makeSpace(1, [checklist]),
        {
          command: "set-checklist-item-completed",
          spaceId: makeSpace().spaceId,
          elementId: checklist.elementId,
          itemId: makeId("99999999"),
          done: true,
          expectedVersion: 1 as AggregateVersion,
          expectedWidgetVersion: 0 as AggregateVersion,
        },
        localHostId,
      ),
    ).toThrow(/checklist item/i);
    expect(checklist.items).toEqual([]);
  });
});

describe("resolveZenLiveCardActivity", () => {
  const visibleRegion = { x: 0, y: 0, width: 1200, height: 800 };

  function threadCard(
    id: string,
    overrides: Partial<Extract<ZenElementPayload, { kind: "thread" }>> = {},
  ): Extract<ZenElementPayload, { kind: "thread" }> {
    return {
      ...(makeThreadElement(id) as Extract<ZenElementPayload, { kind: "thread" }>),
      ...overrides,
    };
  }

  function terminalCard(
    id: string,
    overrides: Partial<Extract<ZenElementPayload, { kind: "terminal" }>> = {},
  ): Extract<ZenElementPayload, { kind: "terminal" }> {
    const thread = makeThreadElement(id) as Extract<ZenElementPayload, { kind: "thread" }>;
    return {
      ...thread,
      kind: "terminal",
      sourceContext: { ...thread.sourceContext, mode: "code", threadKind: "code" },
      checkoutId: makeId("cccc0000"),
      terminalId: makeId("7e007e00"),
      ...overrides,
    } as unknown as Extract<ZenElementPayload, { kind: "terminal" }>;
  }

  it("spends one budget across every kind of card that streams", () => {
    const conversation = threadCard(makeId("aaaaaaaa"), { zIndex: 1 as any });
    const shell = terminalCard(makeId("bbbbbbbb"), { zIndex: 2 as any });

    const activity = resolveZenLiveCardActivity({
      elements: [conversation, shell],
      visibleRegion,
      budget: 1,
    });

    // A pinned shell costs the same stream a pinned conversation does, so it
    // competes for the same slot rather than being waved through beside it.
    expect(activity).toEqual([
      { elementId: conversation.elementId, activity: "frozen", reason: "budget" },
      { elementId: shell.elementId, activity: "live" },
    ]);
  });

  it("freezes a pinned shell the reader has panned away from", () => {
    const shell = terminalCard(makeId("bbbbbbbb"), {
      geometry: { x: 4000, y: 4000, width: 520, height: 320 },
    });

    const activity = resolveZenLiveCardActivity({ elements: [shell], visibleRegion });

    expect(activity).toEqual([
      { elementId: shell.elementId, activity: "frozen", reason: "off-screen" },
    ]);
  });

  it("keeps only the cards a reader is actually looking at streaming", () => {
    const cards = [
      threadCard(makeId("aaaaaaaa"), { zIndex: 1 as any }),
      threadCard(makeId("bbbbbbbb"), { zIndex: 2 as any }),
      threadCard(makeId("cccccccc"), { zIndex: 3 as any }),
      threadCard(makeId("dddddddd"), { zIndex: 4 as any }),
    ];

    const activity = resolveZenLiveCardActivity({
      elements: cards,
      visibleRegion,
      budget: 2,
    });

    expect(
      activity.filter((card) => card.activity === "live").map((card) => card.elementId),
    ).toEqual([cards[2]!.elementId, cards[3]!.elementId]);
    expect(activity.filter((card) => card.activity === "frozen")).toEqual([
      { elementId: cards[0]!.elementId, activity: "frozen", reason: "budget" },
      { elementId: cards[1]!.elementId, activity: "frozen", reason: "budget" },
    ]);
  });

  it("gives the focused card a live slot ahead of a card stacked in front of it", () => {
    const back = threadCard(makeId("aaaaaaaa"), { zIndex: 1 as any });
    const front = threadCard(makeId("bbbbbbbb"), { zIndex: 9 as any });

    const activity = resolveZenLiveCardActivity({
      elements: [back, front],
      visibleRegion,
      focusedElementId: back.elementId,
      budget: 1,
    });

    expect(activity).toEqual([
      { elementId: back.elementId, activity: "live" },
      { elementId: front.elementId, activity: "frozen", reason: "budget" },
    ]);
  });

  it("stops streaming a card that is minimized or panned out of sight", () => {
    const minimized = threadCard(makeId("aaaaaaaa"), { minimized: true });
    const offScreen = threadCard(makeId("bbbbbbbb"), {
      geometry: { x: 4000, y: 4000, width: 400, height: 300 },
    });
    const visible = threadCard(makeId("cccccccc"));

    const activity = resolveZenLiveCardActivity({
      elements: [minimized, offScreen, visible],
      visibleRegion,
    });

    expect(activity).toEqual([
      { elementId: minimized.elementId, activity: "frozen", reason: "minimized" },
      { elementId: offScreen.elementId, activity: "frozen", reason: "off-screen" },
      { elementId: visible.elementId, activity: "live" },
    ]);
  });

  it("reports nothing for the widgets sharing the space", () => {
    const activity = resolveZenLiveCardActivity({
      elements: [makeNotesElement(), makeTimerElement()],
      visibleRegion,
    });

    expect(activity).toEqual([]);
  });

  it("defaults to the live-card budget rather than the element ceiling", () => {
    const cards = Array.from({ length: MAX_ZEN_ELEMENTS }, (_unused, index) =>
      threadCard(makeId(`${index}`.padStart(8, "a")), { zIndex: (index + 1) as any }),
    );

    const activity = resolveZenLiveCardActivity({ elements: cards, visibleRegion });

    expect(activity.filter((card) => card.activity === "live")).toHaveLength(MAX_LIVE_ZEN_CARDS);
    expect(MAX_LIVE_ZEN_CARDS).toBeLessThan(MAX_ZEN_ELEMENTS);
  });
});
