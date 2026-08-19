import { Schema } from "effect";
import { AggregateVersion, UtcTimestamp } from "./events";
import { HostId, WindowId } from "./shell";
import { ChatThreadId } from "./chat";
import { CanvasId } from "./canvasIdentity";
import { CodeCheckoutId, CodeTerminalId, CodeThreadId } from "./code";
import { WorkThreadId } from "./workThreads";

import { OctantMode } from "./modes";
import { ProjectId } from "./projects";
import {
  ProviderCapabilitySupport,
  ProviderInstanceId,
  ProviderModelId,
  ProviderReadiness,
} from "./providers";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));

// ── Identities ──────────────────────────────────────────────────────────────

export const ZenSpaceId = brandedUuid("ZenSpaceId");
export type ZenSpaceId = typeof ZenSpaceId.Type;
export const ZenElementId = brandedUuid("ZenElementId");
export type ZenElementId = typeof ZenElementId.Type;
export const ZenWidgetRecipeId = brandedUuid("ZenWidgetRecipeId");
export type ZenWidgetRecipeId = typeof ZenWidgetRecipeId.Type;
export const ZenRecipePreviewId = brandedUuid("ZenRecipePreviewId");
export type ZenRecipePreviewId = typeof ZenRecipePreviewId.Type;
export const ZenChecklistItemId = brandedUuid("ZenChecklistItemId");
export type ZenChecklistItemId = typeof ZenChecklistItemId.Type;
export const ZenBackgroundAssetId = brandedUuid("ZenBackgroundAssetId");
export type ZenBackgroundAssetId = typeof ZenBackgroundAssetId.Type;

/** Maximum accepted size for a single local Zen background image. */
export const MAX_ZEN_BACKGROUND_BYTES = 8 * 1024 * 1024;
export const ZEN_BACKGROUND_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;
export type ZenBackgroundMediaType = (typeof ZEN_BACKGROUND_MEDIA_TYPES)[number];
export const ZEN_BACKGROUND_STILL_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type ZenBackgroundStillMediaType = (typeof ZEN_BACKGROUND_STILL_MEDIA_TYPES)[number];

// ── Source context ───────────────────────────────────────────────────────────

export const ZenThreadKind = Schema.Literal("chat", "work", "code");
export type ZenThreadKind = typeof ZenThreadKind.Type;

export const ZenSourceContext = Schema.Struct({
  hostId: HostId,
  mode: OctantMode,
  projectId: Schema.NullOr(ProjectId),
  threadKind: ZenThreadKind,
  threadId: Schema.Union(ChatThreadId, WorkThreadId, CodeThreadId),
  worktreeId: Schema.optional(Schema.NonEmptyTrimmedString),
})
  .pipe(Schema.filter((context) => context.mode === context.threadKind))
  .annotations(strict);
export type ZenSourceContext = typeof ZenSourceContext.Type;

export const ZenThreadCatalogRef = Schema.String.pipe(
  Schema.pattern(
    /^(chat|work|code):[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  ),
  Schema.brand("ZenThreadCatalogRef"),
);
export type ZenThreadCatalogRef = typeof ZenThreadCatalogRef.Type;

export const ZenThreadCatalogEntry = Schema.Struct({
  catalogRef: ZenThreadCatalogRef,
  hostId: HostId,
  hostLabel: Schema.NonEmptyTrimmedString,
  mode: OctantMode,
  projectId: Schema.NullOr(ProjectId),
  projectLabel: Schema.NonEmptyTrimmedString,
  threadId: Schema.Union(ChatThreadId, WorkThreadId, CodeThreadId),
  title: Schema.NonEmptyTrimmedString,
  status: Schema.NonEmptyTrimmedString,
  recentActivityAt: UtcTimestamp,
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  sourceContext: ZenSourceContext,
}).annotations(strict);
export type ZenThreadCatalogEntry = typeof ZenThreadCatalogEntry.Type;

export const ZenThreadCatalogResponse = Schema.Struct({
  query: Schema.String.pipe(Schema.maxLength(200)),
  entries: Schema.Array(ZenThreadCatalogEntry),
}).annotations(strict);
export type ZenThreadCatalogResponse = typeof ZenThreadCatalogResponse.Type;

// ── Geometry ─────────────────────────────────────────────────────────────────

export const MIN_ZEN_ELEMENT_WIDTH = 200;
export const MAX_ZEN_ELEMENT_WIDTH = 2400;
export const MIN_ZEN_ELEMENT_HEIGHT = 100;
export const MAX_ZEN_ELEMENT_HEIGHT = 1400;

export const ZenGeometry = Schema.Struct({
  x: Schema.Number.pipe(Schema.greaterThanOrEqualTo(0), Schema.lessThanOrEqualTo(10000)),
  y: Schema.Number.pipe(Schema.greaterThanOrEqualTo(0), Schema.lessThanOrEqualTo(10000)),
  width: Schema.Number.pipe(
    Schema.greaterThanOrEqualTo(MIN_ZEN_ELEMENT_WIDTH),
    Schema.lessThanOrEqualTo(MAX_ZEN_ELEMENT_WIDTH),
  ),
  height: Schema.Number.pipe(
    Schema.greaterThanOrEqualTo(MIN_ZEN_ELEMENT_HEIGHT),
    Schema.lessThanOrEqualTo(MAX_ZEN_ELEMENT_HEIGHT),
  ),
}).annotations(strict);
export type ZenGeometry = typeof ZenGeometry.Type;

export const ZenViewport = Schema.Struct({
  panX: Schema.Number.pipe(Schema.between(-10000, 10000)),
  panY: Schema.Number.pipe(Schema.between(-10000, 10000)),
  scale: Schema.Number.pipe(Schema.between(0.1, 5)),
}).annotations(strict);
export type ZenViewport = typeof ZenViewport.Type;

// ── Element kinds ────────────────────────────────────────────────────────────

export const ZenElementKind = Schema.Literal(
  "thread",
  "terminal",
  "canvas",
  "notes",
  "checklist",
  "timer",
  "reference",
  "recipe",
);
export type ZenElementKind = typeof ZenElementKind.Type;

export const ZenElementState = Schema.Struct({
  elementId: ZenElementId,
  kind: ZenElementKind,
  geometry: ZenGeometry,
  zIndex: Schema.Int.pipe(Schema.positive(), Schema.lessThanOrEqualTo(1000)),
  minimized: Schema.Boolean,
  locked: Schema.Boolean,
  sourceContext: Schema.NullOr(ZenSourceContext),
  title: Schema.optional(Schema.NonEmptyTrimmedString),
}).annotations(strict);
export type ZenElementState = typeof ZenElementState.Type;

// ── Element-specific payloads ────────────────────────────────────────────────

export const ZenThreadElementPayload = Schema.Struct({
  elementId: ZenElementId,
  kind: Schema.Literal("thread"),
  sourceContext: ZenSourceContext,
  geometry: ZenGeometry,
  zIndex: Schema.Int.pipe(Schema.positive(), Schema.lessThanOrEqualTo(1000)),
  minimized: Schema.Boolean,
  locked: Schema.Boolean,
}).annotations(strict);
export type ZenThreadElementPayload = typeof ZenThreadElementPayload.Type;

/**
 * A terminal one of this window's Code threads owns, pinned where the user can
 * watch it.
 *
 * The terminal is addressed, never described: the shell belongs to the thread
 * and checkout named here, and every keystroke the card sends is authorized
 * against that pair exactly as it is from the workspace tab. Pinning grants
 * nothing — a card naming a terminal this window does not own is refused, and
 * a card naming one it does own reaches no further than the tab already could.
 */
export const ZenTerminalElementPayload = Schema.Struct({
  elementId: ZenElementId,
  kind: Schema.Literal("terminal"),
  sourceContext: ZenSourceContext,
  checkoutId: CodeCheckoutId,
  terminalId: CodeTerminalId,
  geometry: ZenGeometry,
  zIndex: Schema.Int.pipe(Schema.positive(), Schema.lessThanOrEqualTo(1000)),
  minimized: Schema.Boolean,
  locked: Schema.Boolean,
  title: Schema.optional(Schema.NonEmptyTrimmedString),
})
  .pipe(Schema.filter((element) => element.sourceContext.threadKind === "code"))
  .annotations(strict);
export type ZenTerminalElementPayload = typeof ZenTerminalElementPayload.Type;

/**
 * A canvas this window may already open, pinned where the user can watch it.
 *
 * The canvas is addressed, never described: the card names the document, and
 * every read goes to the same journal a workspace tab reads, under the same
 * authority the window already has for that Project. Pinning grants nothing —
 * a card naming a canvas this window may not see is refused, and one naming a
 * canvas it may see reaches no further than the tab already could.
 *
 * The card holds no canvas state of its own beyond where it sits: no copy of
 * the content, no pinned version, no separate revision history. A card and a
 * tab on one canvas therefore cannot come to disagree about what it says.
 */
export const ZenCanvasElementPayload = Schema.Struct({
  elementId: ZenElementId,
  kind: Schema.Literal("canvas"),
  canvasId: CanvasId,
  geometry: ZenGeometry,
  zIndex: Schema.Int.pipe(Schema.positive(), Schema.lessThanOrEqualTo(1000)),
  minimized: Schema.Boolean,
  locked: Schema.Boolean,
  title: Schema.optional(Schema.NonEmptyTrimmedString),
}).annotations(strict);
export type ZenCanvasElementPayload = typeof ZenCanvasElementPayload.Type;

export const ZenNotesElementPayload = Schema.Struct({
  elementId: ZenElementId,
  kind: Schema.Literal("notes"),
  widgetVersion: AggregateVersion,
  content: Schema.String.pipe(
    Schema.filter(
      (content) => new TextEncoder().encode(content).byteLength <= MAX_ZEN_NOTES_CONTENT_BYTES,
      { message: () => `notes content exceeds ${MAX_ZEN_NOTES_CONTENT_BYTES} UTF-8 bytes` },
    ),
  ),
  geometry: ZenGeometry,
  zIndex: Schema.Int.pipe(Schema.positive(), Schema.lessThanOrEqualTo(1000)),
  minimized: Schema.Boolean,
  locked: Schema.Boolean,
  title: Schema.optional(Schema.NonEmptyTrimmedString),
}).annotations(strict);
export type ZenNotesElementPayload = typeof ZenNotesElementPayload.Type;

export const MAX_ZEN_NOTES_CONTENT_BYTES = 64 * 1024;
export const MAX_ZEN_CHECKLIST_ITEMS = 50;
export const MAX_ZEN_CHECKLIST_ITEM_TEXT_LENGTH = 500;

export const ZenChecklistItem = Schema.Struct({
  itemId: ZenChecklistItemId,
  text: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(MAX_ZEN_CHECKLIST_ITEM_TEXT_LENGTH)),
  done: Schema.Boolean,
}).annotations(strict);
export type ZenChecklistItem = typeof ZenChecklistItem.Type;

const ZenChecklistItems = Schema.Array(ZenChecklistItem).pipe(
  Schema.maxItems(MAX_ZEN_CHECKLIST_ITEMS),
  Schema.filter((items) => new Set(items.map((item) => item.itemId)).size === items.length, {
    message: () => "checklist item IDs must be unique",
  }),
);

export const ZenChecklistElementPayload = Schema.Struct({
  elementId: ZenElementId,
  kind: Schema.Literal("checklist"),
  widgetVersion: AggregateVersion,
  items: ZenChecklistItems,
  geometry: ZenGeometry,
  zIndex: Schema.Int.pipe(Schema.positive(), Schema.lessThanOrEqualTo(1000)),
  minimized: Schema.Boolean,
  locked: Schema.Boolean,
  title: Schema.optional(Schema.NonEmptyTrimmedString),
}).annotations(strict);
export type ZenChecklistElementPayload = typeof ZenChecklistElementPayload.Type;

export const MAX_ZEN_TIMER_DURATION_MS = 8 * 60 * 60 * 1000;
export const DEFAULT_ZEN_TIMER_DURATION_MS = 25 * 60 * 1000;
export const ZenTimerDurationMs = Schema.Int.pipe(
  Schema.positive(),
  Schema.lessThanOrEqualTo(MAX_ZEN_TIMER_DURATION_MS),
);
export type ZenTimerDurationMs = typeof ZenTimerDurationMs.Type;

export const ZenTimerStatus = Schema.Literal("idle", "running", "paused", "completed");
export type ZenTimerStatus = typeof ZenTimerStatus.Type;

export const ZenTimerElementPayload = Schema.Struct({
  elementId: ZenElementId,
  kind: Schema.Literal("timer"),
  durationMs: ZenTimerDurationMs,
  remainingMs: Schema.Int.pipe(Schema.nonNegative()),
  status: ZenTimerStatus,
  startedAt: Schema.NullOr(UtcTimestamp),
  deadlineAt: Schema.NullOr(UtcTimestamp),
  clockSessionId: Schema.NullOr(Schema.NonEmptyTrimmedString),
  monotonicStartedMs: Schema.NullOr(Schema.Number.pipe(Schema.nonNegative())),
  geometry: ZenGeometry,
  zIndex: Schema.Int.pipe(Schema.positive(), Schema.lessThanOrEqualTo(1000)),
  minimized: Schema.Boolean,
  locked: Schema.Boolean,
  title: Schema.optional(Schema.NonEmptyTrimmedString),
})
  .pipe(
    Schema.filter((timer) => {
      if (timer.remainingMs > timer.durationMs) return false;
      const hasRunningClock =
        timer.startedAt !== null &&
        timer.deadlineAt !== null &&
        timer.clockSessionId !== null &&
        timer.monotonicStartedMs !== null;
      const hasAnyRunningClock =
        timer.startedAt !== null ||
        timer.deadlineAt !== null ||
        timer.clockSessionId !== null ||
        timer.monotonicStartedMs !== null;
      if (timer.status === "running") return hasRunningClock && timer.remainingMs > 0;
      if (hasAnyRunningClock) return false;
      if (timer.status === "completed") return timer.remainingMs === 0;
      if (timer.status === "idle") return timer.remainingMs === timer.durationMs;
      return timer.remainingMs > 0;
    }),
  )
  .annotations(strict);
export type ZenTimerElementPayload = typeof ZenTimerElementPayload.Type;

/**
 * Reference URLs are durable, user-visible metadata. Only canonical HTTP(S)
 * origins without credentials may enter the event journal. The renderer never
 * resolves, follows, or fetches them on the host's behalf.
 */
export function normalizeZenReferenceUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Reference URL is invalid.");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.hostname.length === 0) {
    throw new Error("Reference URL must use HTTP or HTTPS.");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error("Reference URL must not contain credentials.");
  }
  return url.toString();
}

export const ZenReferenceUrl = Schema.String.pipe(
  Schema.filter(
    (value) => {
      try {
        normalizeZenReferenceUrl(value);
        return true;
      } catch {
        return false;
      }
    },
    { message: () => "reference URL must be a credential-free HTTP(S) URL" },
  ),
  Schema.brand("ZenReferenceUrl"),
);
export type ZenReferenceUrl = typeof ZenReferenceUrl.Type;

export const ZenReferenceElementPayload = Schema.Struct({
  elementId: ZenElementId,
  kind: Schema.Literal("reference"),
  url: ZenReferenceUrl,
  label: Schema.optional(Schema.NonEmptyTrimmedString),
  geometry: ZenGeometry,
  zIndex: Schema.Int.pipe(Schema.positive(), Schema.lessThanOrEqualTo(1000)),
  minimized: Schema.Boolean,
  locked: Schema.Boolean,
}).annotations(strict);
export type ZenReferenceElementPayload = typeof ZenReferenceElementPayload.Type;

export const ZenRecipeElementPayload = Schema.Struct({
  elementId: ZenElementId,
  kind: Schema.Literal("recipe"),
  recipeId: ZenWidgetRecipeId,
  state: Schema.Record({
    key: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(64)),
    value: Schema.Union(Schema.String.pipe(Schema.maxLength(2_000)), Schema.Number, Schema.Boolean),
  }),
  geometry: ZenGeometry,
  zIndex: Schema.Int.pipe(Schema.positive(), Schema.lessThanOrEqualTo(1000)),
  minimized: Schema.Boolean,
  locked: Schema.Boolean,
  title: Schema.optional(Schema.NonEmptyTrimmedString),
}).annotations(strict);
export type ZenRecipeElementPayload = typeof ZenRecipeElementPayload.Type;

export const ZenElementPayload = Schema.Union(
  ZenThreadElementPayload,
  ZenTerminalElementPayload,
  ZenCanvasElementPayload,
  ZenNotesElementPayload,
  ZenChecklistElementPayload,
  ZenTimerElementPayload,
  ZenReferenceElementPayload,
  ZenRecipeElementPayload,
);
export type ZenElementPayload = typeof ZenElementPayload.Type;

// ── Widget recipe ────────────────────────────────────────────────────────────

export const ZenWidgetPrimitive = Schema.Literal(
  "notes",
  "checklist",
  "timer",
  "text",
  "link",
  "media",
);
export type ZenWidgetPrimitive = typeof ZenWidgetPrimitive.Type;

const ZenWidgetRecipeDefinition = {
  recipeId: ZenWidgetRecipeId,
  name: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(120)),
  description: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1_000))),
  primitives: Schema.NonEmptyArray(ZenWidgetPrimitive).pipe(Schema.maxItems(10)),
  fields: Schema.Array(
    Schema.Struct({
      key: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(64)),
      label: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(120)),
      kind: Schema.Literal("text", "number", "boolean", "select"),
      defaultValue: Schema.optional(
        Schema.Union(Schema.String.pipe(Schema.maxLength(2_000)), Schema.Number, Schema.Boolean),
      ),
      options: Schema.optional(
        Schema.Array(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(120))).pipe(
          Schema.maxItems(20),
        ),
      ),
    }).annotations(strict),
  ).pipe(Schema.maxItems(20)),
};

/** The provider-proposed recipe shape. It is never persisted directly. */
export const ZenWidgetRecipeDraft = Schema.Struct(ZenWidgetRecipeDefinition).annotations(strict);
export type ZenWidgetRecipeDraft = typeof ZenWidgetRecipeDraft.Type;

/** Durable, bounded evidence of the exact Navigator (Zen assistant) authority that created a saved recipe. */
export const ZenWidgetRecipeProvenance = Schema.Struct({
  assistantThreadId: ChatThreadId,
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId.pipe(Schema.maxLength(200)),
  previewId: ZenRecipePreviewId,
  previewVersion: AggregateVersion,
  createdAt: UtcTimestamp,
  confirmedAt: UtcTimestamp,
}).annotations(strict);
export type ZenWidgetRecipeProvenance = typeof ZenWidgetRecipeProvenance.Type;

export const ZenWidgetRecipe = Schema.Struct({
  ...ZenWidgetRecipeDefinition,
  provenance: ZenWidgetRecipeProvenance,
}).annotations(strict);
export type ZenWidgetRecipe = typeof ZenWidgetRecipe.Type;

export const ZenRecipePreview = Schema.Struct({
  previewId: ZenRecipePreviewId,
  recipe: ZenWidgetRecipeDraft,
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  expectedVersion: AggregateVersion,
  createdAt: UtcTimestamp,
  expiresAt: UtcTimestamp,
}).annotations(strict);
export type ZenRecipePreview = typeof ZenRecipePreview.Type;

// ── Background & appearance ──────────────────────────────────────────────────

export const ZenBackgroundKind = Schema.Literal("solid", "gradient", "image", "builtin");
export type ZenBackgroundKind = typeof ZenBackgroundKind.Type;

export const ZenBackgroundFill = Schema.Literal("cover", "contain", "tile");
export type ZenBackgroundFill = typeof ZenBackgroundFill.Type;

export const ZenGradientStyle = Schema.Literal("linear", "radial", "conic");
export type ZenGradientStyle = typeof ZenGradientStyle.Type;

export const ZenHexColor = Schema.String.pipe(Schema.pattern(/^#[0-9a-fA-F]{6}$/));
export type ZenHexColor = typeof ZenHexColor.Type;

export interface ZenBuiltinBackgroundPreset {
  readonly id: string;
  readonly title: string;
  readonly group: "landscape" | "forest" | "wood" | "abstract";
  readonly tone: "dark" | "light";
  readonly motion: "still" | "animated";
  readonly src: `/zen-backgrounds/${string}`;
  readonly stillSrc?: `/zen-backgrounds/${string}`;
}

export const ZEN_BUILTIN_BACKGROUNDS = [
  {
    id: "nordic-fjord-aurora",
    title: "Nordic fjord",
    group: "landscape",
    tone: "dark",
    motion: "still",
    src: "/zen-backgrounds/nordic-fjord-aurora.jpg",
  },
  {
    id: "lofoten-night",
    title: "Lofoten night",
    group: "landscape",
    tone: "dark",
    motion: "still",
    src: "/zen-backgrounds/lofoten-night.jpg",
  },
  {
    id: "aurora-crimson-ridge",
    title: "Crimson ridge",
    group: "landscape",
    tone: "dark",
    motion: "still",
    src: "/zen-backgrounds/aurora-crimson-ridge.jpg",
  },
  {
    id: "rain-black-valley",
    title: "Rain-black valley",
    group: "forest",
    tone: "dark",
    motion: "still",
    src: "/zen-backgrounds/rain-black-valley.jpg",
  },
  {
    id: "spruce-wall-dusk",
    title: "Spruce wall",
    group: "forest",
    tone: "dark",
    motion: "still",
    src: "/zen-backgrounds/spruce-wall-dusk.jpg",
  },
  {
    id: "weathered-ash-planks",
    title: "Weathered ash",
    group: "wood",
    tone: "dark",
    motion: "still",
    src: "/zen-backgrounds/weathered-ash-planks.jpg",
  },
  {
    id: "near-black-oak-planks",
    title: "Near-black oak",
    group: "wood",
    tone: "dark",
    motion: "still",
    src: "/zen-backgrounds/near-black-oak-planks.jpg",
  },
  {
    id: "warm-walnut-planks",
    title: "Warm walnut",
    group: "wood",
    tone: "dark",
    motion: "still",
    src: "/zen-backgrounds/warm-walnut-planks.jpg",
  },
  {
    id: "perspective-dot-plane",
    title: "Perspective dots",
    group: "abstract",
    tone: "dark",
    motion: "still",
    src: "/zen-backgrounds/perspective-dot-plane.jpg",
  },
  {
    id: "perspective-dot-plane-light",
    title: "Perspective dots light",
    group: "abstract",
    tone: "light",
    motion: "still",
    src: "/zen-backgrounds/perspective-dot-plane-light.jpg",
  },
  {
    id: "waving-dot-field",
    title: "Waving dots",
    group: "abstract",
    tone: "dark",
    motion: "still",
    src: "/zen-backgrounds/waving-dot-field.jpg",
  },
  {
    id: "waving-dot-field-light",
    title: "Waving dots light",
    group: "abstract",
    tone: "light",
    motion: "still",
    src: "/zen-backgrounds/waving-dot-field-light.jpg",
  },
  {
    id: "curling-dash-wave",
    title: "Curling dashes",
    group: "abstract",
    tone: "dark",
    motion: "still",
    src: "/zen-backgrounds/curling-dash-wave.jpg",
  },
  {
    id: "curling-dash-wave-light",
    title: "Curling dashes light",
    group: "abstract",
    tone: "light",
    motion: "still",
    src: "/zen-backgrounds/curling-dash-wave-light.jpg",
  },
  {
    id: "perspective-dot-plane-animated",
    title: "Perspective dots animated",
    group: "abstract",
    tone: "dark",
    motion: "animated",
    src: "/zen-backgrounds/perspective-dot-plane-dark.webp",
    stillSrc: "/zen-backgrounds/perspective-dot-plane.jpg",
  },
  {
    id: "perspective-dot-plane-light-animated",
    title: "Perspective dots light animated",
    group: "abstract",
    tone: "light",
    motion: "animated",
    src: "/zen-backgrounds/perspective-dot-plane-light.webp",
    stillSrc: "/zen-backgrounds/perspective-dot-plane-light.jpg",
  },
  {
    id: "waving-dot-field-animated",
    title: "Waving dots animated",
    group: "abstract",
    tone: "dark",
    motion: "animated",
    src: "/zen-backgrounds/waving-dot-field-dark.webp",
    stillSrc: "/zen-backgrounds/waving-dot-field.jpg",
  },
  {
    id: "waving-dot-field-light-animated",
    title: "Waving dots light animated",
    group: "abstract",
    tone: "light",
    motion: "animated",
    src: "/zen-backgrounds/waving-dot-field-light.webp",
    stillSrc: "/zen-backgrounds/waving-dot-field-light.jpg",
  },
  {
    id: "curling-dash-wave-animated",
    title: "Curling dashes animated",
    group: "abstract",
    tone: "dark",
    motion: "animated",
    src: "/zen-backgrounds/curling-dash-wave-dark.webp",
    stillSrc: "/zen-backgrounds/curling-dash-wave.jpg",
  },
  {
    id: "curling-dash-wave-light-animated",
    title: "Curling dashes light animated",
    group: "abstract",
    tone: "light",
    motion: "animated",
    src: "/zen-backgrounds/curling-dash-wave-light.webp",
    stillSrc: "/zen-backgrounds/curling-dash-wave-light.jpg",
  },
] as const satisfies ReadonlyArray<ZenBuiltinBackgroundPreset>;

export type ZenBuiltinBackgroundId = (typeof ZEN_BUILTIN_BACKGROUNDS)[number]["id"];

export const ZenBuiltinBackgroundId = Schema.Literal(
  ...ZEN_BUILTIN_BACKGROUNDS.map((preset) => preset.id),
);
export type ZenBuiltinBackgroundIdSchema = typeof ZenBuiltinBackgroundId.Type;

export const ZenBackground = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("solid"),
    color: ZenHexColor,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("gradient"),
    style: Schema.optionalWith(ZenGradientStyle, { default: () => "linear" as const }),
    from: ZenHexColor,
    to: ZenHexColor,
    angle: Schema.Int.pipe(Schema.between(0, 360)),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("image"),
    assetId: ZenBackgroundAssetId,
    stillAssetId: Schema.optional(ZenBackgroundAssetId),
    overlay: Schema.Int.pipe(Schema.between(0, 90)),
    fill: Schema.optionalWith(ZenBackgroundFill, { default: () => "cover" as const }),
  })
    .pipe(
      Schema.filter(
        (background) =>
          background.stillAssetId === undefined || background.stillAssetId !== background.assetId,
        { message: () => "stillAssetId must differ from assetId" },
      ),
    )
    .annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("builtin"),
    presetId: ZenBuiltinBackgroundId,
    overlay: Schema.Int.pipe(Schema.between(0, 90)),
    fill: Schema.optionalWith(ZenBackgroundFill, { default: () => "cover" as const }),
  }).annotations(strict),
);
export type ZenBackground = typeof ZenBackground.Type;

export function getZenBuiltinBackground(
  presetId: ZenBuiltinBackgroundId,
): (typeof ZEN_BUILTIN_BACKGROUNDS)[number] {
  const preset = ZEN_BUILTIN_BACKGROUNDS.find((candidate) => candidate.id === presetId);
  if (preset === undefined) {
    throw new Error(`Unknown Zen built-in background: ${presetId}`);
  }
  return preset;
}

export const DEFAULT_ZEN_BACKGROUND: ZenBackground = {
  kind: "solid",
  color: "#1a1a2e",
};

export const ZenAppearance = Schema.Struct({
  background: ZenBackground,
  dimming: Schema.Int.pipe(Schema.between(0, 90)),
  elementOpacity: Schema.Number.pipe(Schema.between(0.1, 1)),
  reducedMotion: Schema.Boolean,
  reducedTransparency: Schema.Boolean,
  increasedContrast: Schema.Boolean,
}).annotations(strict);
export type ZenAppearance = typeof ZenAppearance.Type;

export const DEFAULT_ZEN_APPEARANCE: ZenAppearance = {
  background: DEFAULT_ZEN_BACKGROUND,
  dimming: 0,
  elementOpacity: 1,
  reducedMotion: false,
  reducedTransparency: false,
  increasedContrast: false,
};

// ── Zen space ────────────────────────────────────────────────────────────────

export const ZenAssistantBinding = Schema.Struct({
  threadId: ChatThreadId,
  providerId: Schema.NonEmptyTrimmedString,
  modelId: Schema.NonEmptyTrimmedString,
}).annotations(strict);
export type ZenAssistantBinding = typeof ZenAssistantBinding.Type;

export const MIN_ZEN_RESEARCH_DOCK_WIDTH = 320;
export const MAX_ZEN_RESEARCH_DOCK_WIDTH = 1200;
export const DEFAULT_ZEN_RESEARCH_DOCK_WIDTH = 480;

/**
 * A research browser docked to the edge of a space.
 *
 * Docked rather than pinned: the page is a live native view the host places by
 * absolute window bounds, and the canvas is drawn under a CSS transform, so a
 * page arranged with the cards would sit wherever the canvas last panned to
 * rather than where it appears. The dock is the space's edge, outside that
 * transform, and holds only how wide it is and whose browsing context it
 * shows.
 *
 * The dock binds a Work or Code thread and shows that thread's browsing
 * context, under that thread's authority and no other. Chat threads have no
 * browsing context to show. Docking grants nothing: what the agent may reach
 * in that context is exactly what approval put there, and stays there however
 * far the person browses.
 */
export const ZenResearchDock = Schema.Struct({
  sourceContext: ZenSourceContext,
  width: Schema.Number.pipe(
    Schema.greaterThanOrEqualTo(MIN_ZEN_RESEARCH_DOCK_WIDTH),
    Schema.lessThanOrEqualTo(MAX_ZEN_RESEARCH_DOCK_WIDTH),
  ),
  collapsed: Schema.Boolean,
})
  .pipe(Schema.filter((dock) => dock.sourceContext.threadKind !== "chat"))
  .annotations(strict);
export type ZenResearchDock = typeof ZenResearchDock.Type;

export const ZenSpace = Schema.Struct({
  spaceId: ZenSpaceId,
  windowId: WindowId,
  version: AggregateVersion,
  elements: Schema.Array(ZenElementPayload),
  recipes: Schema.optional(Schema.Array(ZenWidgetRecipe).pipe(Schema.maxItems(20))),
  viewport: ZenViewport,
  appearance: ZenAppearance,
  active: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  barCollapsed: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  assistant: Schema.NullOr(ZenAssistantBinding),
  research: Schema.optionalWith(Schema.NullOr(ZenResearchDock), { default: () => null }),
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
})
  .pipe(
    Schema.filter(
      (space) => {
        const ids = new Set(space.elements.map((e) => e.elementId));
        if (ids.size !== space.elements.length) return false;
        const recipeIds = new Set((space.recipes ?? []).map((recipe) => recipe.recipeId));
        if (recipeIds.size !== (space.recipes ?? []).length) return false;
        const zIndices = new Set(space.elements.map((e) => e.zIndex));
        return zIndices.size === space.elements.length;
      },
      { message: () => "duplicate element IDs or z-index values in ZenSpace" },
    ),
  )
  .annotations(strict);
export type ZenSpace = typeof ZenSpace.Type;

/** A full aggregate snapshot carried by the event journal for replay. */
export const ZenSpaceSnapshot = Schema.Struct({
  spaceId: ZenSpaceId,
  space: ZenSpace,
}).annotations(strict);
export type ZenSpaceSnapshot = typeof ZenSpaceSnapshot.Type;

export const ZenSpaceSnapshotRecorded = ZenSpaceSnapshot;
export type ZenSpaceSnapshotRecorded = typeof ZenSpaceSnapshotRecorded.Type;

export const ZenWidgetMutation = Schema.Union(
  Schema.Struct({
    operation: Schema.Literal("widget-created"),
    kind: Schema.Literal("notes", "checklist"),
    elementId: ZenElementId,
    widgetVersion: AggregateVersion,
  }).annotations(strict),
  Schema.Struct({
    operation: Schema.Literal("notes-saved"),
    elementId: ZenElementId,
    widgetVersion: AggregateVersion,
  }).annotations(strict),
  Schema.Struct({
    operation: Schema.Literal("checklist-item-added"),
    elementId: ZenElementId,
    itemId: ZenChecklistItemId,
    widgetVersion: AggregateVersion,
  }).annotations(strict),
  Schema.Struct({
    operation: Schema.Literal(
      "checklist-item-completed",
      "checklist-item-reordered",
      "checklist-item-removed",
    ),
    elementId: ZenElementId,
    itemId: ZenChecklistItemId,
    widgetVersion: AggregateVersion,
  }).annotations(strict),
);
export type ZenWidgetMutation = typeof ZenWidgetMutation.Type;

export const ZenWidgetMutationRecorded = Schema.Struct({
  spaceId: ZenSpaceId,
  space: ZenSpace,
  mutation: ZenWidgetMutation,
}).annotations(strict);
export type ZenWidgetMutationRecorded = typeof ZenWidgetMutationRecorded.Type;

export const DEFAULT_ZEN_VIEWPORT: ZenViewport = {
  panX: 0,
  panY: 0,
  scale: 1,
};

export const ZenThreadPinRequest = Schema.Struct({
  catalogRef: ZenThreadCatalogRef,
  expectedVersion: AggregateVersion,
  geometry: Schema.optional(ZenGeometry),
}).annotations(strict);
export type ZenThreadPinRequest = typeof ZenThreadPinRequest.Type;

export const ZenThreadPinResult = Schema.Struct({
  result: Schema.Literal("thread-pinned"),
  entry: ZenThreadCatalogEntry,
  elementId: ZenElementId,
  space: ZenSpace,
}).annotations(strict);
export type ZenThreadPinResult = typeof ZenThreadPinResult.Type;

/**
 * Pin a terminal one of this window's Code threads already owns.
 *
 * The request names the terminal, never the element: the server resolves the
 * thread and checkout that own the shell and writes the card itself, so a
 * caller cannot pin a terminal by describing one.
 */
export const ZenTerminalPinRequest = Schema.Struct({
  threadId: CodeThreadId,
  checkoutId: CodeCheckoutId,
  terminalId: CodeTerminalId,
  expectedVersion: AggregateVersion,
  geometry: Schema.optional(ZenGeometry),
  title: Schema.optional(Schema.NonEmptyTrimmedString),
}).annotations(strict);
export type ZenTerminalPinRequest = typeof ZenTerminalPinRequest.Type;

export const ZenTerminalPinResult = Schema.Struct({
  result: Schema.Literal("terminal-pinned"),
  elementId: ZenElementId,
  space: ZenSpace,
}).annotations(strict);
export type ZenTerminalPinResult = typeof ZenTerminalPinResult.Type;

/**
 * Dock a research browser onto a Work or Code thread this window may see.
 *
 * The request names the thread, never the source context: the server resolves
 * the thread's own context from the catalog and writes the dock itself, so a
 * caller cannot dock onto authority by describing it. A null thread closes the
 * dock; naming the bound thread again with a new width or collapsed flag
 * rearranges it.
 */
export const ZenResearchDockRequest = Schema.Struct({
  thread: Schema.NullOr(
    Schema.Struct({
      threadId: Schema.Union(WorkThreadId, CodeThreadId),
      mode: Schema.Literal("work", "code"),
    }).annotations(strict),
  ),
  width: Schema.optional(
    Schema.Number.pipe(
      Schema.greaterThanOrEqualTo(MIN_ZEN_RESEARCH_DOCK_WIDTH),
      Schema.lessThanOrEqualTo(MAX_ZEN_RESEARCH_DOCK_WIDTH),
    ),
  ),
  collapsed: Schema.optional(Schema.Boolean),
  expectedVersion: AggregateVersion,
}).annotations(strict);
export type ZenResearchDockRequest = typeof ZenResearchDockRequest.Type;

export const ZenResearchDockResult = Schema.Struct({
  result: Schema.Literal("research-docked"),
  space: ZenSpace,
}).annotations(strict);
export type ZenResearchDockResult = typeof ZenResearchDockResult.Type;

/**
 * Pin a canvas this window may already open.
 *
 * The request names the canvas, never the card: the server confirms this
 * window may read the document and writes the card itself, so a caller cannot
 * pin a canvas by describing one.
 */
export const ZenCanvasPinRequest = Schema.Struct({
  canvasId: CanvasId,
  expectedVersion: AggregateVersion,
  geometry: Schema.optional(ZenGeometry),
  title: Schema.optional(Schema.NonEmptyTrimmedString),
}).annotations(strict);
export type ZenCanvasPinRequest = typeof ZenCanvasPinRequest.Type;

export const ZenCanvasPinResult = Schema.Struct({
  result: Schema.Literal("canvas-pinned"),
  elementId: ZenElementId,
  space: ZenSpace,
}).annotations(strict);
export type ZenCanvasPinResult = typeof ZenCanvasPinResult.Type;

export const ZenThreadContinuationTarget = Schema.Struct({
  result: Schema.Literal("thread-continuation"),
  entry: ZenThreadCatalogEntry,
}).annotations(strict);
export type ZenThreadContinuationTarget = typeof ZenThreadContinuationTarget.Type;

export const ZenAssistantProviderState = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  providerLabel: Schema.NonEmptyTrimmedString,
  modelId: ProviderModelId,
  modelLabel: Schema.NonEmptyTrimmedString,
  readiness: ProviderReadiness,
  toolCapability: ProviderCapabilitySupport,
  toolCapabilityReason: Schema.optional(Schema.NonEmptyTrimmedString),
}).annotations(strict);
export type ZenAssistantProviderState = typeof ZenAssistantProviderState.Type;

export const ZenAssistantTranscriptMessage = Schema.Struct({
  role: Schema.Literal("user", "assistant"),
  text: Schema.String,
  createdAt: UtcTimestamp,
}).annotations(strict);
export type ZenAssistantTranscriptMessage = typeof ZenAssistantTranscriptMessage.Type;

export const ZenAssistantSnapshot = Schema.Struct({
  status: Schema.Literal("unbound", "ready", "unavailable"),
  binding: Schema.NullOr(ZenAssistantBinding),
  provider: Schema.NullOr(ZenAssistantProviderState),
  transcript: Schema.Array(ZenAssistantTranscriptMessage),
  recipePreview: Schema.optional(Schema.NullOr(ZenRecipePreview)),
  manualControls: Schema.Tuple(
    Schema.Literal("threads"),
    Schema.Literal("widgets"),
    Schema.Literal("add"),
    Schema.Literal("placement"),
    Schema.Literal("appearance"),
  ),
  message: Schema.optional(Schema.NonEmptyTrimmedString),
}).annotations(strict);
export type ZenAssistantSnapshot = typeof ZenAssistantSnapshot.Type;

export const ZenAssistantToolName = Schema.Literal(
  "octant_zen_search_threads",
  "octant_zen_pin_thread",
  "octant_zen_list_widgets",
  "octant_zen_create_widget",
  "octant_zen_preview_recipe",
  "octant_zen_place_element",
  "octant_zen_update_appearance",
);
export type ZenAssistantToolName = typeof ZenAssistantToolName.Type;

export const ZenAssistantSearchThreadsInput = Schema.Struct({
  query: Schema.String.pipe(Schema.maxLength(200)),
}).annotations(strict);
export type ZenAssistantSearchThreadsInput = typeof ZenAssistantSearchThreadsInput.Type;

export const ZenAssistantPinThreadInput = ZenThreadPinRequest;
export type ZenAssistantPinThreadInput = typeof ZenAssistantPinThreadInput.Type;

export const ZenAssistantListWidgetsInput = Schema.Struct({}).annotations(strict);
export type ZenAssistantListWidgetsInput = typeof ZenAssistantListWidgetsInput.Type;

export const ZenAssistantCreateWidgetInput = Schema.Struct({
  kind: Schema.Literal("notes", "checklist", "timer", "reference", "recipe"),
  durationMs: Schema.optional(ZenTimerDurationMs),
  expectedVersion: AggregateVersion,
})
  .pipe(Schema.filter((input) => input.durationMs === undefined || input.kind === "timer"))
  .annotations(strict);
export type ZenAssistantCreateWidgetInput = typeof ZenAssistantCreateWidgetInput.Type;

export const ZenAssistantPreviewRecipeInput = Schema.Struct({
  recipe: ZenWidgetRecipeDraft,
  expectedVersion: AggregateVersion,
  previewId: Schema.optional(ZenRecipePreviewId),
}).annotations(strict);
export type ZenAssistantPreviewRecipeInput = typeof ZenAssistantPreviewRecipeInput.Type;

export const ZenAssistantPlacementInput = Schema.Struct({
  elementId: ZenElementId,
  expectedVersion: AggregateVersion,
  action: Schema.Literal("move-resize", "focus", "minimize", "restore", "remove"),
  geometry: Schema.optional(ZenGeometry),
})
  .pipe(
    Schema.filter((input) => (input.action === "move-resize") === (input.geometry !== undefined)),
  )
  .annotations(strict);
export type ZenAssistantPlacementInput = typeof ZenAssistantPlacementInput.Type;

export const ZenAssistantAppearanceInput = Schema.Struct({
  expectedVersion: AggregateVersion,
  dimming: Schema.optional(Schema.Int.pipe(Schema.between(0, 90))),
  elementOpacity: Schema.optional(Schema.Number.pipe(Schema.between(0.1, 1))),
})
  .pipe(Schema.filter((input) => input.dimming !== undefined || input.elementOpacity !== undefined))
  .annotations(strict);
export type ZenAssistantAppearanceInput = typeof ZenAssistantAppearanceInput.Type;

export const ZenAssistantAction = Schema.Literal(
  "search-threads",
  "pin-thread",
  "list-widgets",
  "create-widget",
  "preview-recipe",
  "place-element",
  "update-appearance",
  "unknown",
);
export type ZenAssistantAction = typeof ZenAssistantAction.Type;

export const ZenWidgetCapability = Schema.Struct({
  kind: Schema.Literal("notes", "checklist", "timer", "reference", "recipe"),
  available: Schema.Boolean,
  reason: Schema.optional(Schema.NonEmptyTrimmedString),
}).annotations(strict);
export type ZenWidgetCapability = typeof ZenWidgetCapability.Type;

export const ZenAssistantToolResult = Schema.Union(
  Schema.Struct({
    action: Schema.Literal("search-threads"),
    status: Schema.Literal("ok"),
    entries: Schema.Array(ZenThreadCatalogEntry),
  }).annotations(strict),
  Schema.Struct({
    action: Schema.Literal("preview-recipe"),
    status: Schema.Literal("ok"),
    preview: ZenRecipePreview,
  }).annotations(strict),
  Schema.Struct({
    action: Schema.Literal("pin-thread"),
    status: Schema.Literal("ok"),
    entry: ZenThreadCatalogEntry,
    elementId: ZenElementId,
    version: AggregateVersion,
  }).annotations(strict),
  Schema.Struct({
    action: Schema.Literal("list-widgets"),
    status: Schema.Literal("ok"),
    widgets: Schema.Array(ZenWidgetCapability),
  }).annotations(strict),
  Schema.Struct({
    action: Schema.Literal("create-widget"),
    status: Schema.Literal("ok"),
    kind: Schema.Literal("notes", "checklist", "timer"),
    elementId: ZenElementId,
    version: AggregateVersion,
  }).annotations(strict),
  Schema.Struct({
    action: Schema.Literal("create-widget"),
    status: Schema.Literal("unavailable"),
    kind: Schema.Literal("notes", "checklist", "timer", "reference", "recipe"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    action: Schema.Literal("place-element"),
    status: Schema.Literal("ok"),
    elementId: ZenElementId,
    version: AggregateVersion,
  }).annotations(strict),
  Schema.Struct({
    action: Schema.Literal("update-appearance"),
    status: Schema.Literal("ok"),
    appearance: ZenAppearance,
    version: AggregateVersion,
  }).annotations(strict),
  Schema.Struct({
    action: ZenAssistantAction,
    status: Schema.Literal("conflict", "failed", "interrupted", "unsupported", "unavailable"),
    code: Schema.optional(Schema.NonEmptyTrimmedString),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
);
export type ZenAssistantToolResult = typeof ZenAssistantToolResult.Type;

// ── Commands ─────────────────────────────────────────────────────────────────

export const ZenCreateSpaceCommand = Schema.Struct({
  command: Schema.Literal("create-space"),
  windowId: WindowId,
  appearance: Schema.optional(ZenAppearance),
}).annotations(strict);
export type ZenCreateSpaceCommand = typeof ZenCreateSpaceCommand.Type;

export const ZenAddElementCommand = Schema.Struct({
  command: Schema.Literal("add-element"),
  spaceId: ZenSpaceId,
  element: ZenElementPayload,
  expectedVersion: AggregateVersion,
}).annotations(strict);
export type ZenAddElementCommand = typeof ZenAddElementCommand.Type;

export const ZenUpdateElementCommand = Schema.Struct({
  command: Schema.Literal("update-element"),
  spaceId: ZenSpaceId,
  element: ZenElementPayload,
  expectedVersion: AggregateVersion,
}).annotations(strict);
export type ZenUpdateElementCommand = typeof ZenUpdateElementCommand.Type;

export const ZenRemoveElementCommand = Schema.Struct({
  command: Schema.Literal("remove-element"),
  spaceId: ZenSpaceId,
  elementId: ZenElementId,
  expectedVersion: AggregateVersion,
}).annotations(strict);
export type ZenRemoveElementCommand = typeof ZenRemoveElementCommand.Type;

export const ZenCreateTimerCommand = Schema.Struct({
  command: Schema.Literal("create-timer"),
  spaceId: ZenSpaceId,
  durationMs: ZenTimerDurationMs,
  title: Schema.optional(Schema.NonEmptyTrimmedString),
  expectedVersion: AggregateVersion,
}).annotations(strict);
export type ZenCreateTimerCommand = typeof ZenCreateTimerCommand.Type;

export const ZenTimerAction = Schema.Literal("start", "pause", "reset", "set-duration");
export type ZenTimerAction = typeof ZenTimerAction.Type;

export const ZenTimerActionCommand = Schema.Struct({
  command: Schema.Literal("timer-action"),
  spaceId: ZenSpaceId,
  elementId: ZenElementId,
  action: ZenTimerAction,
  durationMs: Schema.optional(ZenTimerDurationMs),
  expectedVersion: AggregateVersion,
})
  .pipe(
    Schema.filter(
      (command) => (command.action === "set-duration") === (command.durationMs !== undefined),
    ),
  )
  .annotations(strict);
export type ZenTimerActionCommand = typeof ZenTimerActionCommand.Type;

export const ZenUpdateViewportCommand = Schema.Struct({
  command: Schema.Literal("update-viewport"),
  spaceId: ZenSpaceId,
  viewport: ZenViewport,
  expectedVersion: AggregateVersion,
}).annotations(strict);
export type ZenUpdateViewportCommand = typeof ZenUpdateViewportCommand.Type;

export const ZenUpdateAppearanceCommand = Schema.Struct({
  command: Schema.Literal("update-appearance"),
  spaceId: ZenSpaceId,
  appearance: ZenAppearance,
  expectedVersion: AggregateVersion,
}).annotations(strict);
export type ZenUpdateAppearanceCommand = typeof ZenUpdateAppearanceCommand.Type;

export const ZenBindAssistantCommand = Schema.Struct({
  command: Schema.Literal("bind-assistant"),
  spaceId: ZenSpaceId,
  assistant: ZenAssistantBinding,
  expectedVersion: AggregateVersion,
}).annotations(strict);
export type ZenBindAssistantCommand = typeof ZenBindAssistantCommand.Type;

export const ZenDockResearchCommand = Schema.Struct({
  command: Schema.Literal("dock-research"),
  spaceId: ZenSpaceId,
  research: Schema.NullOr(ZenResearchDock),
  expectedVersion: AggregateVersion,
}).annotations(strict);
export type ZenDockResearchCommand = typeof ZenDockResearchCommand.Type;

export const ZenCreateWidgetCommand = Schema.Struct({
  command: Schema.Literal("create-widget"),
  spaceId: ZenSpaceId,
  kind: Schema.Literal("notes", "checklist"),
  expectedVersion: AggregateVersion,
}).annotations(strict);
export type ZenCreateWidgetCommand = typeof ZenCreateWidgetCommand.Type;

export const ZenCreateReferenceCommand = Schema.Struct({
  command: Schema.Literal("create-reference"),
  spaceId: ZenSpaceId,
  url: ZenReferenceUrl,
  label: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(200))),
  expectedVersion: AggregateVersion,
}).annotations(strict);
export type ZenCreateReferenceCommand = typeof ZenCreateReferenceCommand.Type;

export const ZenSaveNotesCommand = Schema.Struct({
  command: Schema.Literal("save-notes"),
  spaceId: ZenSpaceId,
  elementId: ZenElementId,
  content: ZenNotesElementPayload.fields.content,
  expectedVersion: AggregateVersion,
  expectedWidgetVersion: AggregateVersion,
}).annotations(strict);
export type ZenSaveNotesCommand = typeof ZenSaveNotesCommand.Type;

export const ZenAddChecklistItemCommand = Schema.Struct({
  command: Schema.Literal("add-checklist-item"),
  spaceId: ZenSpaceId,
  elementId: ZenElementId,
  text: ZenChecklistItem.fields.text,
  expectedVersion: AggregateVersion,
  expectedWidgetVersion: AggregateVersion,
}).annotations(strict);
export type ZenAddChecklistItemCommand = typeof ZenAddChecklistItemCommand.Type;

export const ZenSetChecklistItemCompletedCommand = Schema.Struct({
  command: Schema.Literal("set-checklist-item-completed"),
  spaceId: ZenSpaceId,
  elementId: ZenElementId,
  itemId: ZenChecklistItemId,
  done: Schema.Boolean,
  expectedVersion: AggregateVersion,
  expectedWidgetVersion: AggregateVersion,
}).annotations(strict);
export type ZenSetChecklistItemCompletedCommand = typeof ZenSetChecklistItemCompletedCommand.Type;

export const ZenReorderChecklistItemCommand = Schema.Struct({
  command: Schema.Literal("reorder-checklist-item"),
  spaceId: ZenSpaceId,
  elementId: ZenElementId,
  itemId: ZenChecklistItemId,
  beforeItemId: Schema.NullOr(ZenChecklistItemId),
  expectedVersion: AggregateVersion,
  expectedWidgetVersion: AggregateVersion,
}).annotations(strict);
export type ZenReorderChecklistItemCommand = typeof ZenReorderChecklistItemCommand.Type;

export const ZenRemoveChecklistItemCommand = Schema.Struct({
  command: Schema.Literal("remove-checklist-item"),
  spaceId: ZenSpaceId,
  elementId: ZenElementId,
  itemId: ZenChecklistItemId,
  expectedVersion: AggregateVersion,
  expectedWidgetVersion: AggregateVersion,
}).annotations(strict);
export type ZenRemoveChecklistItemCommand = typeof ZenRemoveChecklistItemCommand.Type;

export const ZenSetPresentationCommand = Schema.Struct({
  command: Schema.Literal("set-presentation"),
  spaceId: ZenSpaceId,
  expectedVersion: AggregateVersion,
  active: Schema.optional(Schema.Boolean),
  barCollapsed: Schema.optional(Schema.Boolean),
})
  .pipe(
    Schema.filter((command) => command.active !== undefined || command.barCollapsed !== undefined, {
      message: () => "set-presentation must include active or barCollapsed",
    }),
  )
  .annotations(strict);
export type ZenSetPresentationCommand = typeof ZenSetPresentationCommand.Type;

export const ZenRecoverCommand = Schema.Struct({
  command: Schema.Literal("recover"),
  spaceId: ZenSpaceId,
  expectedVersion: AggregateVersion,
}).annotations(strict);
export type ZenRecoverCommand = typeof ZenRecoverCommand.Type;

export const ZenConfirmRecipePreviewCommand = Schema.Struct({
  command: Schema.Literal("confirm-recipe-preview"),
  spaceId: ZenSpaceId,
  previewId: ZenRecipePreviewId,
  action: Schema.Literal("save", "place"),
  expectedVersion: AggregateVersion,
}).annotations(strict);
export type ZenConfirmRecipePreviewCommand = typeof ZenConfirmRecipePreviewCommand.Type;

export const ZenCommand = Schema.Union(
  ZenCreateSpaceCommand,
  ZenAddElementCommand,
  ZenUpdateElementCommand,
  ZenRemoveElementCommand,
  ZenCreateTimerCommand,
  ZenTimerActionCommand,
  ZenUpdateViewportCommand,
  ZenUpdateAppearanceCommand,
  ZenBindAssistantCommand,
  ZenDockResearchCommand,
  ZenCreateWidgetCommand,
  ZenCreateReferenceCommand,
  ZenSaveNotesCommand,
  ZenAddChecklistItemCommand,
  ZenSetChecklistItemCompletedCommand,
  ZenReorderChecklistItemCommand,
  ZenRemoveChecklistItemCommand,
  ZenSetPresentationCommand,
  ZenRecoverCommand,
  ZenConfirmRecipePreviewCommand,
);
export type ZenCommand = typeof ZenCommand.Type;

// ── Results ──────────────────────────────────────────────────────────────────

export const ZenCreateSpaceResult = Schema.Struct({
  result: Schema.Literal("create-space"),
  space: ZenSpace,
}).annotations(strict);
export type ZenCreateSpaceResult = typeof ZenCreateSpaceResult.Type;

export const ZenMutationResult = Schema.Struct({
  result: Schema.Literal("mutation"),
  space: ZenSpace,
}).annotations(strict);
export type ZenMutationResult = typeof ZenMutationResult.Type;

export const ZenRecoverResult = Schema.Struct({
  result: Schema.Literal("recover"),
}).annotations(strict);
export type ZenRecoverResult = typeof ZenRecoverResult.Type;

export const ZenResult = Schema.Union(ZenCreateSpaceResult, ZenMutationResult, ZenRecoverResult);
export type ZenResult = typeof ZenResult.Type;

// ── Typed failures ───────────────────────────────────────────────────────────

export class ZenError extends Error {
  readonly _tag = "ZenError" as const;
  readonly reason: string;
  readonly spaceId?: string;

  constructor(opts: { reason: string; spaceId?: string; message?: string }) {
    super(opts.message ?? `Zen error: ${opts.reason}`);
    this.reason = opts.reason;
    if (opts.spaceId !== undefined) this.spaceId = opts.spaceId;
  }
}

export const ZenFailureReason = Schema.Literal(
  "invalid-command",
  "invalid-payload",
  "duplicate-element-id",
  "duplicate-z-index",
  "unknown-space",
  "duplicate-space",
  "wrong-window",
  "stale-version",
  "invalid-geometry",
  "invalid-source-context",
  "invalid-url",
  "invalid-recipe",
  "stale-preview",
  "oversized-recipe",
  "executable-content",
  "unsupported-action",
  "missing-capability",
  "unavailable-source",
  "unknown-element",
  "wrong-widget-kind",
  "stale-widget-version",
  "unknown-checklist-item",
  "cross-host",
  "limit-exceeded",
  "recovery-required",
);
export type ZenFailureReason = typeof ZenFailureReason.Type;

// ── Focus zone: the spaces one window holds ──────────────────────────────────

/**
 * How many spaces one window may hold.
 *
 * A focus zone is where the user pins what they are working on now. Past a
 * handful of spaces the switcher stops being a place you can find something and
 * becomes a list you have to read, which is the opposite of the point.
 */
export const MAX_ZEN_SPACES_PER_WINDOW = 8;

export const MAX_ZEN_SPACE_NAME_LENGTH = 64;

export const ZenSpaceName = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(MAX_ZEN_SPACE_NAME_LENGTH),
);
export type ZenSpaceName = typeof ZenSpaceName.Type;

/**
 * One space's place in its window, without its contents.
 *
 * The index carries the name and the order; the space itself carries what is
 * pinned to it. Keeping them apart is what lets the switcher list every space
 * without loading any of them.
 */
export const ZenSpaceSummary = Schema.Struct({
  spaceId: ZenSpaceId,
  name: ZenSpaceName,
  position: Schema.Int.pipe(Schema.nonNegative()),
}).annotations(strict);
export type ZenSpaceSummary = typeof ZenSpaceSummary.Type;

/**
 * The spaces one window holds, in order, and which of them is in front.
 *
 * `activeSpaceId` is the authority for which space the window is showing. A
 * space's own `active` flag says whether the focus zone is replacing the shell;
 * where the two ever disagree — a crash between the two writes that switch
 * spaces — this pointer wins and the stale flag is inert.
 */
export const ZenFocusZone = Schema.Struct({
  windowId: WindowId,
  version: AggregateVersion,
  spaces: Schema.Array(ZenSpaceSummary).pipe(
    Schema.minItems(1),
    Schema.maxItems(MAX_ZEN_SPACES_PER_WINDOW),
  ),
  activeSpaceId: ZenSpaceId,
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
})
  .pipe(
    Schema.filter(
      (zone) => {
        const ids = new Set(zone.spaces.map((space) => String(space.spaceId)));
        if (ids.size !== zone.spaces.length) return false;
        if (!ids.has(String(zone.activeSpaceId))) return false;
        const positions = [...zone.spaces].map((space) => space.position).sort((a, b) => a - b);
        return positions.every((position, index) => position === index);
      },
      {
        message: () =>
          "a focus zone needs unique spaces, contiguous positions, and an active space it holds",
      },
    ),
  )
  .annotations(strict);
export type ZenFocusZone = typeof ZenFocusZone.Type;

/** A full focus-zone snapshot carried by the event journal for replay. */
export const ZenFocusZoneRecorded = Schema.Struct({
  windowId: WindowId,
  zone: ZenFocusZone,
}).annotations(strict);
export type ZenFocusZoneRecorded = typeof ZenFocusZoneRecorded.Type;

/**
 * Add another space to a window that already has a focus zone. The window's
 * first space is minted by `create-space`, which opens the zone itself.
 */
export const ZenAddSpaceCommand = Schema.Struct({
  command: Schema.Literal("add-space"),
  name: ZenSpaceName,
  expectedVersion: AggregateVersion,
}).annotations(strict);
export type ZenAddSpaceCommand = typeof ZenAddSpaceCommand.Type;

export const ZenRenameSpaceCommand = Schema.Struct({
  command: Schema.Literal("rename-space"),
  spaceId: ZenSpaceId,
  name: ZenSpaceName,
  expectedVersion: AggregateVersion,
}).annotations(strict);
export type ZenRenameSpaceCommand = typeof ZenRenameSpaceCommand.Type;

export const ZenRemoveSpaceCommand = Schema.Struct({
  command: Schema.Literal("remove-space"),
  spaceId: ZenSpaceId,
  expectedVersion: AggregateVersion,
}).annotations(strict);
export type ZenRemoveSpaceCommand = typeof ZenRemoveSpaceCommand.Type;

export const ZenReorderSpaceCommand = Schema.Struct({
  command: Schema.Literal("reorder-space"),
  spaceId: ZenSpaceId,
  position: Schema.Int.pipe(Schema.nonNegative()),
  expectedVersion: AggregateVersion,
}).annotations(strict);
export type ZenReorderSpaceCommand = typeof ZenReorderSpaceCommand.Type;

export const ZenActivateSpaceCommand = Schema.Struct({
  command: Schema.Literal("activate-space"),
  spaceId: ZenSpaceId,
  expectedVersion: AggregateVersion,
}).annotations(strict);
export type ZenActivateSpaceCommand = typeof ZenActivateSpaceCommand.Type;

export const ZenFocusZoneCommand = Schema.Union(
  ZenAddSpaceCommand,
  ZenRenameSpaceCommand,
  ZenRemoveSpaceCommand,
  ZenReorderSpaceCommand,
  ZenActivateSpaceCommand,
);
export type ZenFocusZoneCommand = typeof ZenFocusZoneCommand.Type;

export const ZenFocusZoneResult = Schema.Struct({
  result: Schema.Literal("focus-zone-updated"),
  zone: ZenFocusZone,
  /** The space now in front, so a switch is one round trip rather than two. */
  space: ZenSpace,
}).annotations(strict);
export type ZenFocusZoneResult = typeof ZenFocusZoneResult.Type;

export const ZEN_FOCUS_ZONE_EVENT_NAMES = {
  updated: "zen.focus-zone-updated@1",
} as const;

// ── Bootstrap ────────────────────────────────────────────────────────────────

export const ZenBootstrapResponse = Schema.Struct({
  space: Schema.NullOr(ZenSpace),
  /**
   * The window's spaces and which is in front. Null alongside a null space for
   * a window that has never opened its focus zone; never null beside a space,
   * because a space always belongs to a zone.
   */
  focusZone: Schema.NullOr(ZenFocusZone),
  windowId: WindowId,
}).annotations(strict);
export type ZenBootstrapResponse = typeof ZenBootstrapResponse.Type;

export const decodeZenCommand = Schema.decodeUnknownSync(ZenCommand);
export const decodeZenResult = Schema.decodeUnknownSync(ZenResult);
export const decodeZenBootstrapResponse = Schema.decodeUnknownSync(ZenBootstrapResponse);
export const decodeZenFocusZone = Schema.decodeUnknownSync(ZenFocusZone);
export const decodeZenFocusZoneCommand = Schema.decodeUnknownSync(ZenFocusZoneCommand);
export const decodeZenFocusZoneRecorded = Schema.decodeUnknownSync(ZenFocusZoneRecorded);
export const decodeZenFocusZoneResult = Schema.decodeUnknownSync(ZenFocusZoneResult);
export const decodeZenSpace = Schema.decodeUnknownSync(ZenSpace);
export const decodeZenWidgetMutationRecorded = Schema.decodeUnknownSync(ZenWidgetMutationRecorded);
export const decodeZenSpaceId = Schema.decodeUnknownSync(ZenSpaceId);
export const decodeZenElementId = Schema.decodeUnknownSync(ZenElementId);
export const decodeZenChecklistItemId = Schema.decodeUnknownSync(ZenChecklistItemId);
export const decodeZenBackgroundAssetId = Schema.decodeUnknownSync(ZenBackgroundAssetId);
export const decodeZenThreadCatalogRef = Schema.decodeUnknownSync(ZenThreadCatalogRef);
export const decodeZenThreadCatalogEntry = Schema.decodeUnknownSync(ZenThreadCatalogEntry);
export const decodeZenThreadCatalogResponse = Schema.decodeUnknownSync(ZenThreadCatalogResponse);
export const decodeZenThreadPinRequest = Schema.decodeUnknownSync(ZenThreadPinRequest);
export const decodeZenThreadPinResult = Schema.decodeUnknownSync(ZenThreadPinResult);
export const decodeZenResearchDockRequest = Schema.decodeUnknownSync(ZenResearchDockRequest);
export const decodeZenResearchDockResult = Schema.decodeUnknownSync(ZenResearchDockResult);
export const decodeZenCanvasPinRequest = Schema.decodeUnknownSync(ZenCanvasPinRequest);
export const decodeZenCanvasPinResult = Schema.decodeUnknownSync(ZenCanvasPinResult);
export const decodeZenTerminalPinRequest = Schema.decodeUnknownSync(ZenTerminalPinRequest);
export const decodeZenTerminalPinResult = Schema.decodeUnknownSync(ZenTerminalPinResult);
export const decodeZenThreadContinuationTarget = Schema.decodeUnknownSync(
  ZenThreadContinuationTarget,
);
export const decodeZenAssistantSnapshot = Schema.decodeUnknownSync(ZenAssistantSnapshot);
export const decodeZenAssistantSearchThreadsInput = Schema.decodeUnknownSync(
  ZenAssistantSearchThreadsInput,
);
export const decodeZenAssistantPinThreadInput = Schema.decodeUnknownSync(
  ZenAssistantPinThreadInput,
);
export const decodeZenAssistantListWidgetsInput = Schema.decodeUnknownSync(
  ZenAssistantListWidgetsInput,
);
export const decodeZenAssistantCreateWidgetInput = Schema.decodeUnknownSync(
  ZenAssistantCreateWidgetInput,
);
export const decodeZenAssistantPreviewRecipeInput = Schema.decodeUnknownSync(
  ZenAssistantPreviewRecipeInput,
);
export const decodeZenRecipePreviewId = Schema.decodeUnknownSync(ZenRecipePreviewId);
export const decodeZenAssistantPlacementInput = Schema.decodeUnknownSync(
  ZenAssistantPlacementInput,
);
export const decodeZenAssistantAppearanceInput = Schema.decodeUnknownSync(
  ZenAssistantAppearanceInput,
);
export const decodeZenAssistantToolResult = Schema.decodeUnknownSync(ZenAssistantToolResult);
