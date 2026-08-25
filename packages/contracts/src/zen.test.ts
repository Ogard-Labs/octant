import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import * as zenContracts from "./zen";

import {
  ZenSpace,
  ZenSpaceId,
  ZenElementId,
  ZenElementPayload,
  ZenGeometry,
  ZenViewport,
  ZenAppearance,
  ZenBackground,
  ZenBuiltinBackgroundId,
  ZEN_BUILTIN_BACKGROUNDS,
  ZenSourceContext,
  ZenWidgetRecipe,
  ZenCommand,
  ZenError,
  ZenBootstrapResponse,
  DEFAULT_ZEN_APPEARANCE,
  DEFAULT_ZEN_VIEWPORT,
  MIN_ZEN_ELEMENT_WIDTH,
  MAX_ZEN_ELEMENT_WIDTH,
  ZenAssistantSearchThreadsInput,
  ZenAssistantPinThreadInput,
  ZenAssistantPlacementInput,
  ZenAssistantAppearanceInput,
  ZenAssistantCreateWidgetInput,
  ZenAssistantToolResult,
  ZenResearchDock,
  MIN_ZEN_RESEARCH_DOCK_WIDTH,
} from "./zen";

const decodeSpace = Schema.decodeUnknownSync(ZenSpace);
const decodeLegacySnapshot = Schema.decodeUnknownSync(zenContracts.ZenSpaceSnapshotRecordedV1);
const decodeElement = Schema.decodeUnknownSync(ZenElementPayload);
const decodeGeometry = Schema.decodeUnknownSync(ZenGeometry);
const decodeViewport = Schema.decodeUnknownSync(ZenViewport);
const decodeAppearance = Schema.decodeUnknownSync(ZenAppearance);
const decodeBackground = Schema.decodeUnknownSync(ZenBackground);
const decodeCommand = Schema.decodeUnknownSync(ZenCommand);
const decodeRecipe = Schema.decodeUnknownSync(ZenWidgetRecipe);
const decodeBootstrap = Schema.decodeUnknownSync(ZenBootstrapResponse);
const decodeSourceContext = Schema.decodeUnknownSync(ZenSourceContext);
const decodeAssistantSearch = Schema.decodeUnknownSync(ZenAssistantSearchThreadsInput);
const decodeAssistantAttach = Schema.decodeUnknownSync(ZenAssistantPinThreadInput);
const decodeAssistantPlacement = Schema.decodeUnknownSync(ZenAssistantPlacementInput);
const decodeAssistantAppearance = Schema.decodeUnknownSync(ZenAssistantAppearanceInput);
const decodeAssistantCreateWidget = Schema.decodeUnknownSync(ZenAssistantCreateWidgetInput);
const decodeAssistantToolResult = Schema.decodeUnknownSync(ZenAssistantToolResult);
const decodeResearchDock = Schema.decodeUnknownSync(ZenResearchDock);

function makeId(prefix: string): string {
  return `${prefix}-0000-4000-8000-000000000000`;
}

const spaceId = () => makeId("11111111") as typeof ZenSpaceId.Type;
const elementId = () => makeId("22222222") as typeof ZenElementId.Type;
const windowId = () => makeId("33333333");
const chatThreadId = () => makeId("44444444");
const projectId = () => makeId("55555555");

describe("ZenGeometry", () => {
  it("accepts valid geometry", () => {
    const geo = decodeGeometry({ x: 100, y: 200, width: 400, height: 300 });
    expect(geo).toEqual({ x: 100, y: 200, width: 400, height: 300 });
  });

  it("rejects width below minimum", () => {
    expect(() =>
      decodeGeometry({ x: 0, y: 0, width: MIN_ZEN_ELEMENT_WIDTH - 1, height: 200 }),
    ).toThrow();
  });

  it("rejects width above maximum", () => {
    expect(() =>
      decodeGeometry({ x: 0, y: 0, width: MAX_ZEN_ELEMENT_WIDTH + 1, height: 200 }),
    ).toThrow();
  });

  it("rejects negative coordinates", () => {
    expect(() => decodeGeometry({ x: -1, y: 0, width: 400, height: 300 })).toThrow();
  });

  it("rejects NaN geometry", () => {
    expect(() => decodeGeometry({ x: NaN, y: 0, width: 400, height: 300 })).toThrow();
  });

  it("rejects infinite geometry", () => {
    expect(() => decodeGeometry({ x: Infinity, y: 0, width: 400, height: 300 })).toThrow();
  });

  it("rejects excess properties", () => {
    expect(() => decodeGeometry({ x: 0, y: 0, width: 400, height: 300, extra: true })).toThrow();
  });
});

describe("ZenViewport", () => {
  it("accepts valid viewport", () => {
    const vp = decodeViewport({ panX: 0, panY: 0, scale: 1 });
    expect(vp).toEqual({ panX: 0, panY: 0, scale: 1 });
  });

  it("rejects scale below 0.1", () => {
    expect(() => decodeViewport({ panX: 0, panY: 0, scale: 0.05 })).toThrow();
  });

  it("rejects scale above 5", () => {
    expect(() => decodeViewport({ panX: 0, panY: 0, scale: 6 })).toThrow();
  });
});

describe("ZenBackground", () => {
  it("accepts solid background", () => {
    expect(decodeBackground({ kind: "solid", color: "#1a1a2e" })).toEqual({
      kind: "solid",
      color: "#1a1a2e",
    });
  });

  it("accepts gradient background", () => {
    expect(
      decodeBackground({ kind: "gradient", from: "#1a1a2e", to: "#16213e", angle: 45 }),
    ).toEqual({
      kind: "gradient",
      style: "linear",
      from: "#1a1a2e",
      to: "#16213e",
      angle: 45,
    });
  });

  it("accepts image background", () => {
    expect(decodeBackground({ kind: "image", assetId: makeId("77777777"), overlay: 30 })).toEqual({
      kind: "image",
      assetId: makeId("77777777"),
      overlay: 30,
      fill: "cover",
    });
  });

  it("rejects a background asset path instead of treating it as an identifier", () => {
    expect(() =>
      decodeBackground({ kind: "image", assetId: "../../private", overlay: 30 }),
    ).toThrow();
  });

  it("rejects invalid hex color", () => {
    expect(() => decodeBackground({ kind: "solid", color: "not-a-color" })).toThrow();
  });

  it("rejects overlay above 90", () => {
    expect(() =>
      decodeBackground({ kind: "image", assetId: makeId("77777777"), overlay: 95 }),
    ).toThrow();
  });

  it("accepts a first-party built-in background", () => {
    expect(
      decodeBackground({
        kind: "builtin",
        presetId: "nordic-fjord-aurora",
        overlay: 35,
        fill: "cover",
      }),
    ).toEqual({
      kind: "builtin",
      presetId: "nordic-fjord-aurora",
      overlay: 35,
      fill: "cover",
    });
  });

  it("accepts a custom radial gradient", () => {
    expect(
      decodeBackground({
        kind: "gradient",
        style: "radial",
        from: "#f4f1ea",
        to: "#c8c8c5",
        angle: 0,
      }),
    ).toEqual({
      kind: "gradient",
      style: "radial",
      from: "#f4f1ea",
      to: "#c8c8c5",
      angle: 0,
    });
  });

  it("defaults a legacy two-stop gradient to linear", () => {
    expect(
      decodeBackground({ kind: "gradient", from: "#1a1a2e", to: "#16213e", angle: 45 }),
    ).toEqual({
      kind: "gradient",
      style: "linear",
      from: "#1a1a2e",
      to: "#16213e",
      angle: 45,
    });
  });

  it("accepts a custom image fill mode", () => {
    expect(
      decodeBackground({
        kind: "image",
        assetId: makeId("77777777"),
        overlay: 20,
        fill: "contain",
      }),
    ).toEqual({
      kind: "image",
      assetId: makeId("77777777"),
      overlay: 20,
      fill: "contain",
    });
  });

  it("accepts a custom animated upload with a still-frame fallback", () => {
    expect(
      decodeBackground({
        kind: "image",
        assetId: makeId("77777777"),
        stillAssetId: makeId("88888888"),
        overlay: 20,
        fill: "cover",
      }),
    ).toEqual({
      kind: "image",
      assetId: makeId("77777777"),
      stillAssetId: makeId("88888888"),
      overlay: 20,
      fill: "cover",
    });
  });

  it("rejects a custom still-frame that points at the same asset", () => {
    expect(() =>
      decodeBackground({
        kind: "image",
        assetId: makeId("77777777"),
        stillAssetId: makeId("77777777"),
        overlay: 20,
        fill: "cover",
      }),
    ).toThrow();
  });

  it("rejects an unknown built-in preset", () => {
    expect(() =>
      decodeBackground({
        kind: "builtin",
        presetId: "not-a-preset",
        overlay: 20,
        fill: "cover",
      }),
    ).toThrow();
  });

  it("rejects a remote or path-shaped built-in identifier", () => {
    expect(() =>
      decodeBackground({
        kind: "builtin",
        presetId: "../secret",
        overlay: 20,
        fill: "cover",
      }),
    ).toThrow();
  });
});

describe("ZEN_BUILTIN_BACKGROUNDS", () => {
  it("exposes only first-party local still and animated presets", () => {
    expect(ZEN_BUILTIN_BACKGROUNDS.length).toBeGreaterThan(0);
    for (const preset of ZEN_BUILTIN_BACKGROUNDS) {
      expect(preset.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(preset.src.startsWith("/zen-backgrounds/")).toBe(true);
      expect(preset.src.includes("://")).toBe(false);
      expect(["still", "animated"]).toContain(preset.motion);
      Schema.decodeUnknownSync(ZenBuiltinBackgroundId)(preset.id);
      if (preset.motion === "animated") {
        expect(preset.src.endsWith(".webp")).toBe(true);
        expect(preset.stillSrc).toBeDefined();
        expect(
          ZEN_BUILTIN_BACKGROUNDS.some(
            (candidate) => candidate.motion === "still" && candidate.src === preset.stillSrc,
          ),
        ).toBe(true);
      }
    }
  });
});

describe("ZenAppearance", () => {
  it("accepts default appearance", () => {
    expect(decodeAppearance(DEFAULT_ZEN_APPEARANCE)).toEqual(DEFAULT_ZEN_APPEARANCE);
  });

  it("rejects dimming above 90", () => {
    expect(() => decodeAppearance({ ...DEFAULT_ZEN_APPEARANCE, dimming: 95 })).toThrow();
  });

  it("rejects element opacity below 0.1", () => {
    expect(() => decodeAppearance({ ...DEFAULT_ZEN_APPEARANCE, elementOpacity: 0.05 })).toThrow();
  });
});

describe("ZenSourceContext", () => {
  it("accepts valid source context", () => {
    const ctx = decodeSourceContext({
      hostId: "local",
      mode: "chat",
      projectId: null,
      threadKind: "chat",
      threadId: chatThreadId(),
    });
    expect(ctx.hostId).toBe("local");
    expect(ctx.mode).toBe("chat");
  });

  it("accepts source context with project", () => {
    const ctx = decodeSourceContext({
      hostId: "local",
      mode: "code",
      projectId: projectId(),
      threadKind: "code",
      threadId: chatThreadId(),
      worktreeId: "wt-1",
    });
    expect(ctx.projectId).toBe(projectId());
    expect(ctx.worktreeId).toBe("wt-1");
  });

  it("rejects excess properties", () => {
    expect(() =>
      decodeSourceContext({
        hostId: "local",
        mode: "chat",
        projectId: null,
        threadKind: "chat",
        threadId: chatThreadId(),
        extra: true,
      }),
    ).toThrow();
  });
});

describe("ZenElementPayload", () => {
  it("accepts thread element", () => {
    const el = decodeElement({
      elementId: elementId(),
      kind: "thread",
      sourceContext: {
        hostId: "local",
        mode: "chat",
        projectId: null,
        threadKind: "chat",
        threadId: chatThreadId(),
      },
      geometry: { x: 100, y: 100, width: 400, height: 300 },
      zIndex: 1,
      minimized: false,
      locked: false,
    });
    expect(el.kind).toBe("thread");
  });

  it("accepts notes element", () => {
    const el = decodeElement({
      elementId: elementId(),
      kind: "notes",
      widgetVersion: 0,
      content: "Hello world",
      geometry: { x: 100, y: 100, width: 400, height: 300 },
      zIndex: 1,
      minimized: false,
      locked: false,
    });
    expect(el.kind).toBe("notes");
    if (el.kind === "notes") expect(el.content).toBe("Hello world");
  });

  it("requires an independent widget version for notes", () => {
    expect(() =>
      decodeElement({
        elementId: elementId(),
        kind: "notes",
        content: "Unversioned note",
        geometry: { x: 100, y: 100, width: 400, height: 300 },
        zIndex: 1,
        minimized: false,
        locked: false,
      }),
    ).toThrow();
  });

  it("rejects notes larger than the UTF-8 byte budget", () => {
    expect(() =>
      decodeElement({
        elementId: elementId(),
        kind: "notes",
        widgetVersion: 0,
        content: "é".repeat(32_769),
        geometry: { x: 100, y: 100, width: 400, height: 300 },
        zIndex: 1,
        minimized: false,
        locked: false,
      }),
    ).toThrow();
  });

  it("accepts checklist element", () => {
    const el = decodeElement({
      elementId: elementId(),
      kind: "checklist",
      widgetVersion: 0,
      items: [{ itemId: makeId("66666666"), text: "Task 1", done: false }],
      geometry: { x: 100, y: 100, width: 400, height: 300 },
      zIndex: 1,
      minimized: false,
      locked: false,
    });
    expect(el.kind).toBe("checklist");
    if (el.kind === "checklist") expect(el.items).toHaveLength(1);
  });

  it("requires an independent widget version for checklists", () => {
    expect(() =>
      decodeElement({
        elementId: elementId(),
        kind: "checklist",
        items: [],
        geometry: { x: 100, y: 100, width: 400, height: 300 },
        zIndex: 1,
        minimized: false,
        locked: false,
      }),
    ).toThrow();
  });

  it("rejects duplicate checklist item identities", () => {
    const itemId = makeId("66666666");
    expect(() =>
      decodeElement({
        elementId: elementId(),
        kind: "checklist",
        widgetVersion: 0,
        items: [
          { itemId, text: "First", done: false },
          { itemId, text: "Duplicate", done: true },
        ],
        geometry: { x: 100, y: 100, width: 400, height: 300 },
        zIndex: 1,
        minimized: false,
        locked: false,
      }),
    ).toThrow();
  });

  it("rejects oversized checklist definitions", () => {
    expect(() =>
      decodeElement({
        elementId: elementId(),
        kind: "checklist",
        widgetVersion: 0,
        items: Array.from({ length: 51 }, (_, index) => ({
          itemId: `${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`,
          text: `Item ${index}`,
          done: false,
        })),
        geometry: { x: 100, y: 100, width: 400, height: 300 },
        zIndex: 1,
        minimized: false,
        locked: false,
      }),
    ).toThrow();
  });

  it("accepts timer element", () => {
    const el = decodeElement({
      elementId: elementId(),
      kind: "timer",
      durationMs: 25 * 60 * 1000,
      remainingMs: 25 * 60 * 1000,
      status: "idle",
      startedAt: null,
      deadlineAt: null,
      clockSessionId: null,
      monotonicStartedMs: null,
      geometry: { x: 100, y: 100, width: 400, height: 300 },
      zIndex: 1,
      minimized: false,
      locked: false,
    });
    expect(el.kind).toBe("timer");
  });

  it("accepts explicit running and completed timer lifecycle states", () => {
    const running = decodeElement({
      elementId: elementId(),
      kind: "timer",
      durationMs: 25 * 60 * 1000,
      remainingMs: 20 * 60 * 1000,
      status: "running",
      startedAt: "2026-07-29T08:00:00.000Z",
      deadlineAt: "2026-07-29T08:20:00.000Z",
      clockSessionId: "server-session-1",
      monotonicStartedMs: 42_000,
      geometry: { x: 100, y: 100, width: 400, height: 300 },
      zIndex: 1,
      minimized: false,
      locked: false,
    });
    const completed = decodeElement({
      ...running,
      status: "completed",
      remainingMs: 0,
      startedAt: null,
      deadlineAt: null,
      clockSessionId: null,
      monotonicStartedMs: null,
    });

    expect(running).toMatchObject({ status: "running", remainingMs: 20 * 60 * 1000 });
    expect(completed).toMatchObject({ status: "completed", remainingMs: 0 });
  });

  it("rejects inconsistent timer lifecycle timestamps", () => {
    expect(() =>
      decodeElement({
        elementId: elementId(),
        kind: "timer",
        durationMs: 25 * 60 * 1000,
        remainingMs: 25 * 60 * 1000,
        status: "paused",
        startedAt: "2026-07-29T08:00:00.000Z",
        deadlineAt: null,
        clockSessionId: null,
        monotonicStartedMs: null,
        geometry: { x: 100, y: 100, width: 400, height: 300 },
        zIndex: 1,
        minimized: false,
        locked: false,
      }),
    ).toThrow();
  });

  it("accepts reference element with https url", () => {
    const el = decodeElement({
      elementId: elementId(),
      kind: "reference",
      url: "https://example.com",
      geometry: { x: 100, y: 100, width: 400, height: 300 },
      zIndex: 1,
      minimized: false,
      locked: false,
    });
    expect(el.kind).toBe("reference");
  });

  it("rejects credential-bearing reference URLs instead of persisting a secret", () => {
    expect(() =>
      decodeElement({
        elementId: elementId(),
        kind: "reference",
        url: "https://user:secret@example.com/release-notes",
        geometry: { x: 0, y: 0, width: 400, height: 300 },
        zIndex: 1,
        minimized: false,
        locked: false,
      }),
    ).toThrow();
  });

  it("rejects reference with invalid url", () => {
    expect(() =>
      decodeElement({
        elementId: elementId(),
        kind: "reference",
        url: "not-a-url",
        geometry: { x: 100, y: 100, width: 400, height: 300 },
        zIndex: 1,
        minimized: false,
        locked: false,
      }),
    ).toThrow();
  });

  it("rejects reference with javascript url", () => {
    expect(() =>
      decodeElement({
        elementId: elementId(),
        kind: "reference",
        url: "javascript:alert(1)",
        geometry: { x: 100, y: 100, width: 400, height: 300 },
        zIndex: 1,
        minimized: false,
        locked: false,
      }),
    ).toThrow();
  });

  it("rejects element with zIndex above 1000", () => {
    expect(() =>
      decodeElement({
        elementId: elementId(),
        kind: "notes",
        widgetVersion: 0,
        content: "",
        geometry: { x: 100, y: 100, width: 400, height: 300 },
        zIndex: 1001,
        minimized: false,
        locked: false,
      }),
    ).toThrow();
  });

  it("rejects timer duration above 8 hours", () => {
    expect(() =>
      decodeElement({
        elementId: elementId(),
        kind: "timer",
        durationMs: 9 * 60 * 60 * 1000,
        remainingMs: 0,
        status: "completed",
        startedAt: null,
        deadlineAt: null,
        clockSessionId: null,
        monotonicStartedMs: null,
        geometry: { x: 100, y: 100, width: 400, height: 300 },
        zIndex: 1,
        minimized: false,
        locked: false,
      }),
    ).toThrow();
  });
});

describe("ZenWidgetRecipe", () => {
  it("requires an exact bounded assistant provenance receipt for saved recipes", () => {
    expect(() =>
      decodeRecipe({
        recipeId: makeId("77777777"),
        name: "Focus Timer",
        primitives: ["timer"],
        fields: [],
      }),
    ).toThrow();
  });

  it("accepts minimal valid recipe", () => {
    const recipe = decodeRecipe({
      recipeId: makeId("77777777"),
      name: "Focus Timer",
      primitives: ["timer"],
      fields: [],
      provenance: {
        assistantThreadId: makeId("77777778"),
        providerInstanceId: makeId("77777779"),
        modelId: "model-local",
        previewId: makeId("77777780"),
        previewVersion: 2,
        createdAt: "2026-07-29T12:00:00.000Z",
        confirmedAt: "2026-07-29T12:01:00.000Z",
      },
    });
    expect(recipe.primitives).toEqual(["timer"]);
  });

  it("accepts recipe with fields", () => {
    const recipe = decodeRecipe({
      recipeId: makeId("77777777"),
      name: "Task Tracker",
      primitives: ["checklist", "notes"],
      fields: [{ key: "duration", label: "Duration", kind: "number" as const, defaultValue: 25 }],
      provenance: {
        assistantThreadId: makeId("77777778"),
        providerInstanceId: makeId("77777779"),
        modelId: "model-local",
        previewId: makeId("77777780"),
        previewVersion: 2,
        createdAt: "2026-07-29T12:00:00.000Z",
        confirmedAt: "2026-07-29T12:01:00.000Z",
      },
    });
    expect(recipe.fields).toHaveLength(1);
  });

  it("rejects empty primitives", () => {
    expect(() =>
      decodeRecipe({
        recipeId: makeId("77777777"),
        name: "Empty",
        primitives: [],
        fields: [],
      }),
    ).toThrow();
  });

  it("rejects more than 10 primitives", () => {
    expect(() =>
      decodeRecipe({
        recipeId: makeId("77777777"),
        name: "Too many",
        primitives: Array(11).fill("notes"),
        fields: [],
      }),
    ).toThrow();
  });

  it("rejects unknown primitive", () => {
    expect(() =>
      decodeRecipe({
        recipeId: makeId("77777777"),
        name: "Bad",
        primitives: ["unknown-primitive"],
        fields: [],
      }),
    ).toThrow();
  });

  it("rejects excess properties", () => {
    expect(() =>
      decodeRecipe({
        recipeId: makeId("77777777"),
        name: "Bad",
        primitives: ["notes"],
        fields: [],
        extra: true,
      }),
    ).toThrow();
  });
});

describe("ZenCanvasElementPayload", () => {
  const card = {
    elementId: elementId(),
    kind: "canvas",
    canvasId: makeId("77777777"),
    geometry: { x: 100, y: 100, width: 400, height: 300 },
    zIndex: 1,
    minimized: false,
    locked: false,
  };

  it("pins a canvas by naming it and nothing else about it", () => {
    const element = decodeElement(card);
    expect(element.kind).toBe("canvas");
    expect("canvasId" in element ? element.canvasId : undefined).toBe(makeId("77777777"));
  });

  it("refuses a card carrying canvas state of its own", () => {
    // A card that held a version, a copy of the content, or a history of its
    // own could disagree with the tab on the same canvas.
    expect(() => decodeElement({ ...card, versionId: makeId("88888888") })).toThrow();
    expect(() => decodeElement({ ...card, blocks: [] })).toThrow();
  });
});

describe("ZenResearchDock", () => {
  const codeSource = {
    hostId: "local",
    mode: "code",
    projectId: projectId(),
    threadKind: "code",
    threadId: chatThreadId(),
  };

  it("docks onto the browsing context of a Work or Code thread", () => {
    const dock = decodeResearchDock({
      sourceContext: codeSource,
      width: 480,
      collapsed: false,
    });
    expect(dock.sourceContext.threadKind).toBe("code");
    expect(dock.collapsed).toBe(false);
  });

  it("refuses to dock onto a Chat thread, which has no browsing context", () => {
    expect(() =>
      decodeResearchDock({
        sourceContext: {
          hostId: "local",
          mode: "chat",
          projectId: null,
          threadKind: "chat",
          threadId: chatThreadId(),
        },
        width: 480,
        collapsed: false,
      }),
    ).toThrow();
  });

  it("refuses a dock narrower than a page can be read in", () => {
    expect(() =>
      decodeResearchDock({
        sourceContext: codeSource,
        width: MIN_ZEN_RESEARCH_DOCK_WIDTH - 1,
        collapsed: false,
      }),
    ).toThrow();
  });

  it("leaves a space that predates the dock with none", () => {
    // Spaces already in the journal carry no dock, and replay must not turn
    // that into an invalid space.
    const space = decodeSpace({
      spaceId: spaceId(),
      windowId: windowId(),
      version: 0,
      elements: [],
      viewport: DEFAULT_ZEN_VIEWPORT,
      appearance: DEFAULT_ZEN_APPEARANCE,
      assistant: null,
      createdAt: "2026-07-24T10:00:00.000Z",
      updatedAt: "2026-07-24T10:00:00.000Z",
    });
    expect(space.research).toBeNull();
  });
});

describe("ZenSpace", () => {
  it("defaults active and barCollapsed to false when omitted", () => {
    const space = decodeSpace({
      spaceId: spaceId(),
      windowId: windowId(),
      version: 0,
      elements: [],
      viewport: DEFAULT_ZEN_VIEWPORT,
      appearance: DEFAULT_ZEN_APPEARANCE,
      assistant: null,
      research: null,
      createdAt: "2026-07-24T10:00:00.000Z",
      updatedAt: "2026-07-24T10:00:00.000Z",
    });
    expect(space.elements).toEqual([]);
    expect(space.assistant).toBeNull();
    expect(space.active).toBe(false);
    expect(space.barCollapsed).toBe(false);
  });

  it("accepts explicit active and barCollapsed presentation state", () => {
    const space = decodeSpace({
      spaceId: spaceId(),
      windowId: windowId(),
      version: 0,
      elements: [],
      viewport: DEFAULT_ZEN_VIEWPORT,
      appearance: DEFAULT_ZEN_APPEARANCE,
      active: true,
      barCollapsed: true,
      assistant: null,
      research: null,
      createdAt: "2026-07-24T10:00:00.000Z",
      updatedAt: "2026-07-24T10:00:00.000Z",
    });
    expect(space.active).toBe(true);
    expect(space.barCollapsed).toBe(true);
  });

  it("accepts space with elements and assistant", () => {
    const space = decodeSpace({
      spaceId: spaceId(),
      windowId: windowId(),
      version: 3,
      elements: [
        {
          elementId: elementId(),
          kind: "notes",
          widgetVersion: 0,
          content: "Focus notes",
          geometry: { x: 100, y: 100, width: 400, height: 300 },
          zIndex: 1,
          minimized: false,
          locked: false,
        },
      ],
      viewport: { panX: 10, panY: 20, scale: 1.1 },
      appearance: DEFAULT_ZEN_APPEARANCE,
      assistant: {
        threadId: chatThreadId(),
        providerId: "openai",
        modelId: "gpt-4o",
      },
      createdAt: "2026-07-24T10:00:00.000Z",
      updatedAt: "2026-07-24T10:00:00.000Z",
    });
    expect(space.elements).toHaveLength(1);
    expect(space.assistant?.providerId).toBe("openai");
  });

  it("rejects duplicate element IDs", () => {
    const id = elementId();
    expect(() =>
      decodeSpace({
        spaceId: spaceId(),
        windowId: windowId(),
        version: 1,
        elements: [
          {
            elementId: id,
            kind: "notes",
            widgetVersion: 0,
            content: "a",
            geometry: { x: 0, y: 0, width: 300, height: 200 },
            zIndex: 1,
            minimized: false,
            locked: false,
          },
          {
            elementId: id,
            kind: "notes",
            widgetVersion: 0,
            content: "b",
            geometry: { x: 0, y: 0, width: 300, height: 200 },
            zIndex: 2,
            minimized: false,
            locked: false,
          },
        ],
        viewport: DEFAULT_ZEN_VIEWPORT,
        appearance: DEFAULT_ZEN_APPEARANCE,
        assistant: null,
        research: null,
        createdAt: "2026-07-24T10:00:00.000Z",
        updatedAt: "2026-07-24T10:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects duplicate z-index values", () => {
    expect(() =>
      decodeSpace({
        spaceId: spaceId(),
        windowId: windowId(),
        version: 1,
        elements: [
          {
            elementId: elementId(),
            kind: "notes",
            widgetVersion: 0,
            content: "a",
            geometry: { x: 0, y: 0, width: 300, height: 200 },
            zIndex: 1,
            minimized: false,
            locked: false,
          },
          {
            elementId: elementId(),
            kind: "notes",
            widgetVersion: 0,
            content: "b",
            geometry: { x: 0, y: 0, width: 300, height: 200 },
            zIndex: 1,
            minimized: false,
            locked: false,
          },
        ],
        viewport: DEFAULT_ZEN_VIEWPORT,
        appearance: DEFAULT_ZEN_APPEARANCE,
        assistant: null,
        research: null,
        createdAt: "2026-07-24T10:00:00.000Z",
        updatedAt: "2026-07-24T10:00:00.000Z",
      }),
    ).toThrow();
  });

  it("decodes the legacy snapshot shape used by V1 replay", () => {
    const snapshot = decodeLegacySnapshot({
      spaceId: spaceId(),
      space: {
        spaceId: spaceId(),
        windowId: windowId(),
        version: 1,
        elements: [
          {
            elementId: elementId(),
            kind: "timer",
            durationMs: 25 * 60 * 1000,
            remainingMs: 20 * 60 * 1000,
            running: true,
            geometry: { x: 0, y: 0, width: 300, height: 200 },
            zIndex: 1,
            minimized: false,
            locked: false,
          },
        ],
        viewport: DEFAULT_ZEN_VIEWPORT,
        appearance: DEFAULT_ZEN_APPEARANCE,
        assistant: null,
        research: null,
        createdAt: "2026-07-24T10:00:00.000Z",
        updatedAt: "2026-07-24T10:00:00.000Z",
      },
    });
    expect(snapshot.space.elements[0]).toMatchObject({ kind: "timer", running: true });
  });

  it("rejects a legacy timer snapshot whose remaining time exceeds its duration", () => {
    expect(() =>
      decodeLegacySnapshot({
        spaceId: spaceId(),
        space: {
          spaceId: spaceId(),
          windowId: windowId(),
          version: 1,
          elements: [
            {
              elementId: elementId(),
              kind: "timer",
              durationMs: 25 * 60 * 1000,
              remainingMs: 30 * 60 * 1000,
              running: true,
              geometry: { x: 0, y: 0, width: 300, height: 200 },
              zIndex: 1,
              minimized: false,
              locked: false,
            },
          ],
          viewport: DEFAULT_ZEN_VIEWPORT,
          appearance: DEFAULT_ZEN_APPEARANCE,
          assistant: null,
          research: null,
          createdAt: "2026-07-24T10:00:00.000Z",
          updatedAt: "2026-07-24T10:00:00.000Z",
        },
      }),
    ).toThrow();
  });
});

describe("ZenCommand", () => {
  it("decodes create-space command", () => {
    const cmd = decodeCommand({
      command: "create-space",
      windowId: windowId(),
    });
    expect(cmd.command).toBe("create-space");
  });

  it("decodes add-element command", () => {
    const cmd = decodeCommand({
      command: "add-element",
      spaceId: spaceId(),
      element: {
        elementId: elementId(),
        kind: "notes",
        widgetVersion: 0,
        content: "",
        geometry: { x: 0, y: 0, width: 300, height: 200 },
        zIndex: 1,
        minimized: false,
        locked: false,
      },
      expectedVersion: 0,
    });
    expect(cmd.command).toBe("add-element");
  });

  it.each([
    {
      command: "create-widget",
      spaceId: spaceId(),
      kind: "notes",
      expectedVersion: 1,
    },
    {
      command: "save-notes",
      spaceId: spaceId(),
      elementId: elementId(),
      content: "Release notes",
      expectedVersion: 1,
      expectedWidgetVersion: 0,
    },
    {
      command: "add-checklist-item",
      spaceId: spaceId(),
      elementId: elementId(),
      text: "Run verification",
      expectedVersion: 1,
      expectedWidgetVersion: 0,
    },
    {
      command: "set-checklist-item-completed",
      spaceId: spaceId(),
      elementId: elementId(),
      itemId: makeId("66666666"),
      done: true,
      expectedVersion: 1,
      expectedWidgetVersion: 1,
    },
    {
      command: "reorder-checklist-item",
      spaceId: spaceId(),
      elementId: elementId(),
      itemId: makeId("66666666"),
      beforeItemId: null,
      expectedVersion: 1,
      expectedWidgetVersion: 2,
    },
    {
      command: "remove-checklist-item",
      spaceId: spaceId(),
      elementId: elementId(),
      itemId: makeId("66666666"),
      expectedVersion: 1,
      expectedWidgetVersion: 3,
    },
  ])("decodes the typed $command command", (input) => {
    expect(decodeCommand(input).command).toBe(input.command);
  });

  it("decodes set-presentation command with optional active and barCollapsed", () => {
    const both = decodeCommand({
      command: "set-presentation",
      spaceId: spaceId(),
      expectedVersion: 1,
      active: true,
      barCollapsed: false,
    });
    expect(both.command).toBe("set-presentation");
    expect((both as any).active).toBe(true);
    expect((both as any).barCollapsed).toBe(false);

    const activeOnly = decodeCommand({
      command: "set-presentation",
      spaceId: spaceId(),
      expectedVersion: 1,
      active: false,
    });
    expect((activeOnly as any).command).toBe("set-presentation");
    expect((activeOnly as any).active).toBe(false);
    expect((activeOnly as any).barCollapsed).toBeUndefined();

    expect(() =>
      decodeCommand({
        command: "set-presentation",
        spaceId: spaceId(),
        expectedVersion: 1,
      }),
    ).toThrow();
  });

  it("rejects unsupported widget kinds at the D1 creation boundary", () => {
    expect(() =>
      decodeCommand({
        command: "create-widget",
        spaceId: spaceId(),
        kind: "timer",
        expectedVersion: 1,
      }),
    ).toThrow();
  });

  it("decodes remove-element command", () => {
    const cmd = decodeCommand({
      command: "remove-element",
      spaceId: spaceId(),
      elementId: elementId(),
      expectedVersion: 1,
    });
    expect(cmd.command).toBe("remove-element");
  });

  it("decodes update-viewport command", () => {
    const cmd = decodeCommand({
      command: "update-viewport",
      spaceId: spaceId(),
      viewport: { panX: 0, panY: 0, scale: 1.5 },
      expectedVersion: 2,
    });
    expect(cmd.command).toBe("update-viewport");
  });

  it("decodes update-appearance command", () => {
    const cmd = decodeCommand({
      command: "update-appearance",
      spaceId: spaceId(),
      appearance: DEFAULT_ZEN_APPEARANCE,
      expectedVersion: 3,
    });
    expect(cmd.command).toBe("update-appearance");
  });

  it("decodes bind-assistant command", () => {
    const cmd = decodeCommand({
      command: "bind-assistant",
      spaceId: spaceId(),
      assistant: {
        threadId: chatThreadId(),
        providerId: "openai",
        modelId: "gpt-4o",
      },
      expectedVersion: 4,
    });
    expect(cmd.command).toBe("bind-assistant");
  });

  it("decodes recover command", () => {
    const cmd = decodeCommand({
      command: "recover",
      spaceId: spaceId(),
      expectedVersion: 5,
    });
    expect(cmd.command).toBe("recover");
  });

  it("decodes server-timed create and lifecycle commands", () => {
    expect(
      decodeCommand({
        command: "create-timer",
        spaceId: spaceId(),
        durationMs: 25 * 60 * 1000,
        expectedVersion: 5,
      }),
    ).toMatchObject({ command: "create-timer", durationMs: 25 * 60 * 1000 });
    expect(
      decodeCommand({
        command: "timer-action",
        spaceId: spaceId(),
        elementId: elementId(),
        action: "start",
        expectedVersion: 6,
      }),
    ).toMatchObject({ command: "timer-action", action: "start" });
    expect(
      decodeCommand({
        command: "timer-action",
        spaceId: spaceId(),
        elementId: elementId(),
        action: "set-duration",
        durationMs: 50 * 60 * 1000,
        expectedVersion: 6,
      }),
    ).toMatchObject({ action: "set-duration", durationMs: 50 * 60 * 1000 });
  });

  it("rejects caller-supplied timer clocks and invalid duration actions", () => {
    expect(() =>
      decodeCommand({
        command: "timer-action",
        spaceId: spaceId(),
        elementId: elementId(),
        action: "start",
        startedAt: "2026-07-29T08:00:00.000Z",
        expectedVersion: 6,
      }),
    ).toThrow();
    expect(() =>
      decodeCommand({
        command: "timer-action",
        spaceId: spaceId(),
        elementId: elementId(),
        action: "pause",
        durationMs: 5 * 60 * 1000,
        expectedVersion: 6,
      }),
    ).toThrow();
  });

  it("rejects unknown command", () => {
    expect(() =>
      decodeCommand({
        command: "unknown-command",
        spaceId: spaceId(),
      }),
    ).toThrow();
  });

  it("accepts a bounded Reference creation request without caller-supplied identity", () => {
    expect(
      decodeCommand({
        command: "create-reference",
        spaceId: spaceId(),
        url: "https://example.com/release-notes",
        label: "Release notes",
        expectedVersion: 6,
      }),
    ).toMatchObject({ command: "create-reference", label: "Release notes" });
  });
});

describe("Zen widget journal events", () => {
  it("exports a typed Note/Checklist mutation event decoder", () => {
    expect(zenContracts).toHaveProperty("ZenWidgetMutationRecorded");
    expect(zenContracts).toHaveProperty("decodeZenWidgetMutationRecorded");
  });
});

describe("ZenFocusZone", () => {
  const owner = makeId("33333333");
  const first = makeId("11111111");
  const second = makeId("11111112");

  function zone(overrides: Record<string, unknown> = {}) {
    return {
      windowId: owner,
      version: 2,
      spaces: [
        { spaceId: first, name: "Focus", position: 0 },
        { spaceId: second, name: "Review", position: 1 },
      ],
      activeSpaceId: first,
      createdAt: "2026-07-24T10:00:00.000Z",
      updatedAt: "2026-07-24T10:05:00.000Z",
      ...overrides,
    };
  }

  it("accepts a window's named, ordered spaces with one of them in front", () => {
    expect(zenContracts.decodeZenFocusZone(zone()).spaces).toHaveLength(2);
  });

  it("refuses a zone whose spaces are not one per identity", () => {
    expect(() =>
      zenContracts.decodeZenFocusZone(
        zone({
          spaces: [
            { spaceId: first, name: "Focus", position: 0 },
            { spaceId: first, name: "Review", position: 1 },
          ],
        }),
      ),
    ).toThrow();
  });

  it("refuses a zone whose positions leave a gap, so the order is the positions", () => {
    expect(() =>
      zenContracts.decodeZenFocusZone(
        zone({
          spaces: [
            { spaceId: first, name: "Focus", position: 0 },
            { spaceId: second, name: "Review", position: 2 },
          ],
        }),
      ),
    ).toThrow();
  });

  it("refuses a zone pointing at a space the window does not hold", () => {
    expect(() =>
      zenContracts.decodeZenFocusZone(zone({ activeSpaceId: makeId("11111113") })),
    ).toThrow();
  });

  it("refuses a zone with no spaces at all", () => {
    expect(() => zenContracts.decodeZenFocusZone(zone({ spaces: [] }))).toThrow();
  });

  it("refuses a space command that names no version to write against", () => {
    expect(() =>
      zenContracts.decodeZenFocusZoneCommand({ command: "add-space", name: "Review" }),
    ).toThrow();
  });

  it("refuses a space name that is only whitespace", () => {
    expect(() =>
      zenContracts.decodeZenFocusZoneCommand({
        command: "add-space",
        name: "   ",
        expectedVersion: 2,
      }),
    ).toThrow();
  });
});

describe("ZenBootstrapResponse", () => {
  it("reports a window that has never opened Zen as holding neither a space nor a zone", () => {
    const resp = decodeBootstrap({
      space: null,
      focusZone: null,
      windowId: windowId(),
    });
    expect(resp.space).toBeNull();
    expect(resp.focusZone).toBeNull();
  });

  it("reports the space in front alongside every space the window holds", () => {
    const first = spaceId();
    const second = makeId("11111112") as typeof ZenSpaceId.Type;
    const owner = windowId();
    const resp = decodeBootstrap({
      space: {
        spaceId: first,
        windowId: owner,
        version: 0,
        elements: [],
        viewport: DEFAULT_ZEN_VIEWPORT,
        appearance: DEFAULT_ZEN_APPEARANCE,
        assistant: null,
        research: null,
        createdAt: "2026-07-24T10:00:00.000Z",
        updatedAt: "2026-07-24T10:00:00.000Z",
      },
      focusZone: {
        windowId: owner,
        version: 2,
        spaces: [
          { spaceId: first, name: "Focus", position: 0 },
          { spaceId: second, name: "Review", position: 1 },
        ],
        activeSpaceId: first,
        createdAt: "2026-07-24T10:00:00.000Z",
        updatedAt: "2026-07-24T10:05:00.000Z",
      },
      windowId: owner,
    });
    expect(resp.space).not.toBeNull();
    expect(resp.focusZone?.activeSpaceId).toBe(first);
  });
});

describe("ZenError", () => {
  it("creates typed error with message", () => {
    const err = new ZenError({ reason: "stale-version" });
    expect(err.message).toBe("Zen error: stale-version");
  });
});

describe("Zen Assistant typed actions", () => {
  it("accepts bounded action inputs without authority identity", () => {
    expect(decodeAssistantSearch({ query: "release" })).toEqual({ query: "release" });
    expect(
      decodeAssistantAttach({
        catalogRef: `chat:${chatThreadId()}`,
        expectedVersion: 2,
      }),
    ).toMatchObject({ expectedVersion: 2 });
    expect(
      decodeAssistantPlacement({
        elementId: elementId(),
        expectedVersion: 2,
        action: "focus",
      }),
    ).toMatchObject({ action: "focus" });
    expect(decodeAssistantAppearance({ expectedVersion: 2, dimming: 25 })).toMatchObject({
      dimming: 25,
    });
  });

  it("rejects forged window, space, and source authority fields", () => {
    expect(() => decodeAssistantSearch({ query: "release", windowId: windowId() })).toThrow();
    expect(() =>
      decodeAssistantAttach({
        catalogRef: `chat:${chatThreadId()}`,
        expectedVersion: 2,
        spaceId: spaceId(),
        sourceContext: {
          hostId: "forged",
          mode: "chat",
          projectId: null,
          threadKind: "chat",
          threadId: chatThreadId(),
        },
      }),
    ).toThrow();
  });

  it("requires geometry only for move-resize and at least one appearance change", () => {
    expect(() =>
      decodeAssistantPlacement({
        elementId: elementId(),
        expectedVersion: 2,
        action: "move-resize",
      }),
    ).toThrow();
    expect(() =>
      decodeAssistantPlacement({
        elementId: elementId(),
        expectedVersion: 2,
        action: "focus",
        geometry: { x: 0, y: 0, width: 400, height: 300 },
      }),
    ).toThrow();
    expect(() => decodeAssistantAppearance({ expectedVersion: 2 })).toThrow();
  });

  it("decodes structured conflict results for provider continuation", () => {
    expect(
      decodeAssistantToolResult({
        action: "pin-thread",
        status: "conflict",
        code: "stale-version",
        message: "Zen changed elsewhere.",
      }),
    ).toMatchObject({ status: "conflict", code: "stale-version" });
  });

  it("decodes a bounded Timer creation request and success result", () => {
    expect(
      decodeAssistantCreateWidget({
        kind: "timer",
        durationMs: 40 * 60 * 1000,
        expectedVersion: 2,
      }),
    ).toMatchObject({ kind: "timer", durationMs: 40 * 60 * 1000 });
    expect(
      decodeAssistantToolResult({
        action: "create-widget",
        status: "ok",
        kind: "timer",
        elementId: elementId(),
        version: 3,
      }),
    ).toMatchObject({ action: "create-widget", status: "ok", kind: "timer", version: 3 });
  });
});
