import { Effect, Schema } from "effect";
import { NonEmptyTrimmedString, NonNegativeInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
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
import { ZenBuiltinBackgroundId } from "./backgroundCatalog";

export { ZenBuiltinBackgroundId } from "./backgroundCatalog";

const brandedUuid = <B extends string>(brand: Parameters<typeof Schema.brand<B>>[0]) =>
  Schema.String.pipe(Schema.check(Schema.isGUID()), Schema.brand<B>(brand));

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

export const ZenThreadKind = Schema.Literals(["chat", "work", "code"]);
export type ZenThreadKind = typeof ZenThreadKind.Type;

export const ZenSourceContext = Schema.Struct({
  hostId: HostId,
  mode: OctantMode,
  projectId: Schema.NullOr(ProjectId),
  threadKind: ZenThreadKind,
  threadId: Schema.Union([ChatThreadId, WorkThreadId, CodeThreadId]),
  worktreeId: Schema.optional(NonEmptyTrimmedString),
}).check(Schema.makeFilter((context) => context.mode === context.threadKind));
export type ZenSourceContext = typeof ZenSourceContext.Type;

export const ZenThreadCatalogRef = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(
      /^(chat|work|code):[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    ),
  ),
  Schema.brand("ZenThreadCatalogRef"),
);
export type ZenThreadCatalogRef = typeof ZenThreadCatalogRef.Type;

export const ZenThreadCatalogEntry = Schema.Struct({
  catalogRef: ZenThreadCatalogRef,
  hostId: HostId,
  hostLabel: NonEmptyTrimmedString,
  mode: OctantMode,
  projectId: Schema.NullOr(ProjectId),
  projectLabel: NonEmptyTrimmedString,
  threadId: Schema.Union([ChatThreadId, WorkThreadId, CodeThreadId]),
  title: NonEmptyTrimmedString,
  status: NonEmptyTrimmedString,
  recentActivityAt: UtcTimestamp,
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  sourceContext: ZenSourceContext,
});
export type ZenThreadCatalogEntry = typeof ZenThreadCatalogEntry.Type;

export const ZenThreadCatalogResponse = Schema.Struct({
  query: Schema.String.check(Schema.isMaxLength(200)),
  entries: Schema.Array(ZenThreadCatalogEntry),
});
export type ZenThreadCatalogResponse = typeof ZenThreadCatalogResponse.Type;

// ── Geometry ─────────────────────────────────────────────────────────────────

export const MIN_ZEN_ELEMENT_WIDTH = 200;
export const MAX_ZEN_ELEMENT_WIDTH = 2400;
export const MIN_ZEN_ELEMENT_HEIGHT = 100;
export const MAX_ZEN_ELEMENT_HEIGHT = 1400;

export const ZenGeometry = Schema.Struct({
  x: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(10000)),
  y: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(10000)),
  width: Schema.Number.check(
    Schema.isGreaterThanOrEqualTo(MIN_ZEN_ELEMENT_WIDTH),
    Schema.isLessThanOrEqualTo(MAX_ZEN_ELEMENT_WIDTH),
  ),
  height: Schema.Number.check(
    Schema.isGreaterThanOrEqualTo(MIN_ZEN_ELEMENT_HEIGHT),
    Schema.isLessThanOrEqualTo(MAX_ZEN_ELEMENT_HEIGHT),
  ),
});
export type ZenGeometry = typeof ZenGeometry.Type;

/**
 * How a space places its cards. `arrange` uses the geometry each card stores:
 * every card is a window a person moves and sizes. `wall` now means only "never
 * arranged": the renderer tiles such a space once, writes those tiles as each
 * card's geometry, and moves it to `arrange`, so a first drag starts from what
 * was drawn. It stays in the literal because stored spaces carry it.
 */
export const ZenSpaceLayout = Schema.Literals(["wall", "arrange"]);
export type ZenSpaceLayout = typeof ZenSpaceLayout.Type;

export const ZenViewport = Schema.Struct({
  panX: Schema.Number.check(Schema.isBetween({ minimum: -10000, maximum: 10000 })),
  panY: Schema.Number.check(Schema.isBetween({ minimum: -10000, maximum: 10000 })),
  scale: Schema.Number.check(Schema.isBetween({ minimum: 0.1, maximum: 5 })),
});
export type ZenViewport = typeof ZenViewport.Type;

// ── Element kinds ────────────────────────────────────────────────────────────

export const ZenElementKind = Schema.Literals([
  "thread",
  "terminal",
  "project-terminal",
  "canvas",
  "notes",
  "checklist",
  "timer",
  "reference",
  "recipe",
]);
export type ZenElementKind = typeof ZenElementKind.Type;

export const ZenElementState = Schema.Struct({
  elementId: ZenElementId,
  kind: ZenElementKind,
  geometry: ZenGeometry,
  zIndex: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1000)),
  minimized: Schema.Boolean,
  locked: Schema.Boolean,
  sourceContext: Schema.NullOr(ZenSourceContext),
  title: Schema.optional(NonEmptyTrimmedString),
});
export type ZenElementState = typeof ZenElementState.Type;

// ── Element-specific payloads ────────────────────────────────────────────────

export const ZenThreadElementPayload = Schema.Struct({
  elementId: ZenElementId,
  kind: Schema.Literal("thread"),
  sourceContext: ZenSourceContext,
  geometry: ZenGeometry,
  zIndex: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1000)),
  minimized: Schema.Boolean,
  locked: Schema.Boolean,
});
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
  zIndex: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1000)),
  minimized: Schema.Boolean,
  locked: Schema.Boolean,
  title: Schema.optional(NonEmptyTrimmedString),
}).check(Schema.makeFilter((element) => element.sourceContext.threadKind === "code"));
export type ZenTerminalElementPayload = typeof ZenTerminalElementPayload.Type;

/**
 * A terminal a Code Project owns without a thread, pinned where the person can
 * watch it.
 *
 * Addressed like a thread's terminal and granting as little: the card names
 * the Project and the shell, and every keystroke is authorized by the host
 * against the window and Project that opened it. It carries no thread,
 * because there is none, and so nothing an agent does can reach it through
 * the card.
 */
export const ZenProjectTerminalElementPayload = Schema.Struct({
  elementId: ZenElementId,
  kind: Schema.Literal("project-terminal"),
  hostId: HostId,
  projectId: ProjectId,
  terminalId: CodeTerminalId,
  geometry: ZenGeometry,
  zIndex: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1000)),
  minimized: Schema.Boolean,
  locked: Schema.Boolean,
  title: Schema.optional(NonEmptyTrimmedString),
  /**
   * The terminal runs the Work task's provider program, as its owner said when
   * the card was pinned, so a restart asks for that program again. It grants
   * nothing: the host decides that start as it decides any other.
   */
  program: Schema.optional(Schema.Literal("provider")),
  /**
   * That program's name as the host resolved it at the start ("Gemini CLI"),
   * so the card names the program it runs rather than whatever the window's
   * Work task uses later. Shown only; it grants nothing.
   */
  programName: Schema.optional(NonEmptyTrimmedString),
});
export type ZenProjectTerminalElementPayload = typeof ZenProjectTerminalElementPayload.Type;

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
  zIndex: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1000)),
  minimized: Schema.Boolean,
  locked: Schema.Boolean,
  title: Schema.optional(NonEmptyTrimmedString),
});
export type ZenCanvasElementPayload = typeof ZenCanvasElementPayload.Type;

export const MAX_ZEN_NOTES_CONTENT_BYTES = 64 * 1024;
export const MAX_ZEN_CHECKLIST_ITEMS = 50;
export const MAX_ZEN_CHECKLIST_ITEM_TEXT_LENGTH = 500;

export const ZenNotesElementPayload = Schema.Struct({
  elementId: ZenElementId,
  kind: Schema.Literal("notes"),
  widgetVersion: AggregateVersion,
  content: Schema.String.check(
    Schema.makeFilter(
      (content) => new TextEncoder().encode(content).byteLength <= MAX_ZEN_NOTES_CONTENT_BYTES,
      { message: `notes content exceeds ${MAX_ZEN_NOTES_CONTENT_BYTES} UTF-8 bytes` },
    ),
  ),
  geometry: ZenGeometry,
  zIndex: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1000)),
  minimized: Schema.Boolean,
  locked: Schema.Boolean,
  title: Schema.optional(NonEmptyTrimmedString),
});
export type ZenNotesElementPayload = typeof ZenNotesElementPayload.Type;

export const ZenChecklistItem = Schema.Struct({
  itemId: ZenChecklistItemId,
  text: Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(MAX_ZEN_CHECKLIST_ITEM_TEXT_LENGTH),
  ),
  done: Schema.Boolean,
});
export type ZenChecklistItem = typeof ZenChecklistItem.Type;

const ZenChecklistItems = Schema.Array(ZenChecklistItem).check(
  Schema.isMaxLength(MAX_ZEN_CHECKLIST_ITEMS),
  Schema.makeFilter((items) => new Set(items.map((item) => item.itemId)).size === items.length, {
    message: "checklist item IDs must be unique",
  }),
);

export const ZenChecklistElementPayload = Schema.Struct({
  elementId: ZenElementId,
  kind: Schema.Literal("checklist"),
  widgetVersion: AggregateVersion,
  items: ZenChecklistItems,
  geometry: ZenGeometry,
  zIndex: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1000)),
  minimized: Schema.Boolean,
  locked: Schema.Boolean,
  title: Schema.optional(NonEmptyTrimmedString),
});
export type ZenChecklistElementPayload = typeof ZenChecklistElementPayload.Type;

export const MAX_ZEN_TIMER_DURATION_MS = 8 * 60 * 60 * 1000;
export const DEFAULT_ZEN_TIMER_DURATION_MS = 25 * 60 * 1000;
export const ZenTimerDurationMs = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(MAX_ZEN_TIMER_DURATION_MS),
);
export type ZenTimerDurationMs = typeof ZenTimerDurationMs.Type;

export const ZenTimerStatus = Schema.Literals(["idle", "running", "paused", "completed"]);
export type ZenTimerStatus = typeof ZenTimerStatus.Type;

export const ZenTimerElementPayload = Schema.Struct({
  elementId: ZenElementId,
  kind: Schema.Literal("timer"),
  durationMs: ZenTimerDurationMs,
  remainingMs: NonNegativeInt,
  status: ZenTimerStatus,
  startedAt: Schema.NullOr(UtcTimestamp),
  deadlineAt: Schema.NullOr(UtcTimestamp),
  clockSessionId: Schema.NullOr(NonEmptyTrimmedString),
  monotonicStartedMs: Schema.NullOr(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
  geometry: ZenGeometry,
  zIndex: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1000)),
  minimized: Schema.Boolean,
  locked: Schema.Boolean,
  title: Schema.optional(NonEmptyTrimmedString),
}).check(
  Schema.makeFilter((timer) => {
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
);
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
  Schema.check(
    Schema.makeFilter(
      (value) => {
        try {
          normalizeZenReferenceUrl(value);
          return true;
        } catch {
          return false;
        }
      },
      { message: "reference URL must be a credential-free HTTP(S) URL" },
    ),
  ),
  Schema.brand("ZenReferenceUrl"),
);
export type ZenReferenceUrl = typeof ZenReferenceUrl.Type;

export const ZenReferenceElementPayload = Schema.Struct({
  elementId: ZenElementId,
  kind: Schema.Literal("reference"),
  url: ZenReferenceUrl,
  label: Schema.optional(NonEmptyTrimmedString),
  geometry: ZenGeometry,
  zIndex: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1000)),
  minimized: Schema.Boolean,
  locked: Schema.Boolean,
});
export type ZenReferenceElementPayload = typeof ZenReferenceElementPayload.Type;

export const ZenRecipeElementPayload = Schema.Struct({
  elementId: ZenElementId,
  kind: Schema.Literal("recipe"),
  recipeId: ZenWidgetRecipeId,
  state: Schema.Record(
    Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(64)),
    Schema.Union([Schema.String.check(Schema.isMaxLength(2_000)), Schema.Number, Schema.Boolean]),
  ),
  geometry: ZenGeometry,
  zIndex: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1000)),
  minimized: Schema.Boolean,
  locked: Schema.Boolean,
  title: Schema.optional(NonEmptyTrimmedString),
});
export type ZenRecipeElementPayload = typeof ZenRecipeElementPayload.Type;

export const ZenElementPayload = Schema.Union([
  ZenThreadElementPayload,
  ZenTerminalElementPayload,
  ZenProjectTerminalElementPayload,
  ZenCanvasElementPayload,
  ZenNotesElementPayload,
  ZenChecklistElementPayload,
  ZenTimerElementPayload,
  ZenReferenceElementPayload,
  ZenRecipeElementPayload,
]);
export type ZenElementPayload = typeof ZenElementPayload.Type;

// ── Widget recipe ────────────────────────────────────────────────────────────

export const ZenWidgetPrimitive = Schema.Literals([
  "notes",
  "checklist",
  "timer",
  "text",
  "link",
  "media",
]);
export type ZenWidgetPrimitive = typeof ZenWidgetPrimitive.Type;

const ZenWidgetRecipeDefinition = {
  recipeId: ZenWidgetRecipeId,
  name: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(120)),
  description: Schema.optional(
    Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(1_000)),
  ),
  primitives: Schema.NonEmptyArray(ZenWidgetPrimitive).check(Schema.isMaxLength(10)),
  fields: Schema.Array(
    Schema.Struct({
      key: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(64)),
      label: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(120)),
      kind: Schema.Literals(["text", "number", "boolean", "select"]),
      defaultValue: Schema.optional(
        Schema.Union([
          Schema.String.check(Schema.isMaxLength(2_000)),
          Schema.Number,
          Schema.Boolean,
        ]),
      ),
      options: Schema.optional(
        Schema.Array(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(120))).check(
          Schema.isMaxLength(20),
        ),
      ),
    }),
  ).check(Schema.isMaxLength(20)),
};

/** The provider-proposed recipe shape. It is never persisted directly. */
export const ZenWidgetRecipeDraft = Schema.Struct(ZenWidgetRecipeDefinition);
export type ZenWidgetRecipeDraft = typeof ZenWidgetRecipeDraft.Type;

/** Durable, bounded evidence of the exact Navigator (Zen assistant) authority that created a saved recipe. */
export const ZenWidgetRecipeProvenance = Schema.Struct({
  assistantThreadId: ChatThreadId,
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId.check(Schema.isMaxLength(200)),
  previewId: ZenRecipePreviewId,
  previewVersion: AggregateVersion,
  createdAt: UtcTimestamp,
  confirmedAt: UtcTimestamp,
});
export type ZenWidgetRecipeProvenance = typeof ZenWidgetRecipeProvenance.Type;

export const ZenWidgetRecipe = Schema.Struct({
  ...ZenWidgetRecipeDefinition,
  provenance: ZenWidgetRecipeProvenance,
});
export type ZenWidgetRecipe = typeof ZenWidgetRecipe.Type;

export const ZenRecipePreview = Schema.Struct({
  previewId: ZenRecipePreviewId,
  recipe: ZenWidgetRecipeDraft,
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  expectedVersion: AggregateVersion,
  createdAt: UtcTimestamp,
  expiresAt: UtcTimestamp,
});
export type ZenRecipePreview = typeof ZenRecipePreview.Type;

// ── Background & appearance ──────────────────────────────────────────────────

export const ZenBackgroundKind = Schema.Literals([
  "solid",
  "gradient",
  "image",
  "builtin",
  "theme",
]);
export type ZenBackgroundKind = typeof ZenBackgroundKind.Type;

export const ZenBackgroundFill = Schema.Literals(["cover", "contain", "tile"]);
export type ZenBackgroundFill = typeof ZenBackgroundFill.Type;

export const ZenGradientStyle = Schema.Literals(["linear", "radial", "conic"]);
export type ZenGradientStyle = typeof ZenGradientStyle.Type;

export const ZenHexColor = Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/));
export type ZenHexColor = typeof ZenHexColor.Type;

export interface ZenBuiltinBackgroundPreset {
  readonly id: ZenBuiltinBackgroundId;
  readonly title: string;
  readonly group: "gradient" | "landscape" | "forest" | "wood" | "abstract";
  readonly tone: "dark" | "light";
  readonly motion: "still" | "animated";
  /**
   * Document-relative: the packaged renderer loads from a `file:` URL, where a
   * root-absolute path resolves to the filesystem root and the picture never loads.
   */
  readonly src: `zen-backgrounds/${string}`;
  readonly stillSrc?: `zen-backgrounds/${string}`;
  /**
   * The same picture for a light theme. The app ground follows the window's
   * scheme, so one default works in both: a dark glow behind a light page is
   * a black rectangle, and a pastel behind a dark one glares.
   */
  readonly lightSrc?: `zen-backgrounds/${string}`;
}

export const ZEN_BUILTIN_BACKGROUNDS = [
  {
    id: "soft-glow",
    title: "Soft glow",
    group: "gradient",
    tone: "dark",
    motion: "still",
    src: "zen-backgrounds/soft-glow.jpg",
    lightSrc: "zen-backgrounds/soft-glow-light.jpg",
  },
  {
    id: "soft-graphite",
    title: "Graphite",
    group: "gradient",
    tone: "dark",
    motion: "still",
    src: "zen-backgrounds/soft-graphite.jpg",
    lightSrc: "zen-backgrounds/soft-graphite-light.jpg",
  },
  {
    id: "soft-sunset",
    title: "Sunset",
    group: "gradient",
    tone: "dark",
    motion: "still",
    src: "zen-backgrounds/soft-sunset.jpg",
    lightSrc: "zen-backgrounds/soft-sunset-light.jpg",
  },
  {
    id: "nordic-fjord-aurora",
    title: "Nordic fjord",
    group: "landscape",
    tone: "dark",
    motion: "still",
    src: "zen-backgrounds/nordic-fjord-aurora.jpg",
  },
  {
    id: "lofoten-night",
    title: "Lofoten night",
    group: "landscape",
    tone: "dark",
    motion: "still",
    src: "zen-backgrounds/lofoten-night.jpg",
  },
  {
    id: "aurora-crimson-ridge",
    title: "Crimson ridge",
    group: "landscape",
    tone: "dark",
    motion: "still",
    src: "zen-backgrounds/aurora-crimson-ridge.jpg",
  },
  {
    id: "rain-black-valley",
    title: "Rain-black valley",
    group: "forest",
    tone: "dark",
    motion: "still",
    src: "zen-backgrounds/rain-black-valley.jpg",
  },
  {
    id: "spruce-wall-dusk",
    title: "Spruce wall",
    group: "forest",
    tone: "dark",
    motion: "still",
    src: "zen-backgrounds/spruce-wall-dusk.jpg",
  },
  {
    id: "weathered-ash-planks",
    title: "Weathered ash",
    group: "wood",
    tone: "dark",
    motion: "still",
    src: "zen-backgrounds/weathered-ash-planks.jpg",
  },
  {
    id: "near-black-oak-planks",
    title: "Near-black oak",
    group: "wood",
    tone: "dark",
    motion: "still",
    src: "zen-backgrounds/near-black-oak-planks.jpg",
  },
  {
    id: "warm-walnut-planks",
    title: "Warm walnut",
    group: "wood",
    tone: "dark",
    motion: "still",
    src: "zen-backgrounds/warm-walnut-planks.jpg",
  },
  {
    id: "perspective-dot-plane",
    title: "Perspective dots",
    group: "abstract",
    tone: "dark",
    motion: "still",
    src: "zen-backgrounds/perspective-dot-plane.jpg",
  },
  {
    id: "perspective-dot-plane-light",
    title: "Perspective dots light",
    group: "abstract",
    tone: "light",
    motion: "still",
    src: "zen-backgrounds/perspective-dot-plane-light.jpg",
  },
  {
    id: "waving-dot-field",
    title: "Waving dots",
    group: "abstract",
    tone: "dark",
    motion: "still",
    src: "zen-backgrounds/waving-dot-field.jpg",
  },
  {
    id: "waving-dot-field-light",
    title: "Waving dots light",
    group: "abstract",
    tone: "light",
    motion: "still",
    src: "zen-backgrounds/waving-dot-field-light.jpg",
  },
  {
    id: "curling-dash-wave",
    title: "Curling dashes",
    group: "abstract",
    tone: "dark",
    motion: "still",
    src: "zen-backgrounds/curling-dash-wave.jpg",
  },
  {
    id: "curling-dash-wave-light",
    title: "Curling dashes light",
    group: "abstract",
    tone: "light",
    motion: "still",
    src: "zen-backgrounds/curling-dash-wave-light.jpg",
  },
  {
    id: "perspective-dot-plane-animated",
    title: "Perspective dots animated",
    group: "abstract",
    tone: "dark",
    motion: "animated",
    src: "zen-backgrounds/perspective-dot-plane-dark.webp",
    stillSrc: "zen-backgrounds/perspective-dot-plane.jpg",
  },
  {
    id: "perspective-dot-plane-light-animated",
    title: "Perspective dots light animated",
    group: "abstract",
    tone: "light",
    motion: "animated",
    src: "zen-backgrounds/perspective-dot-plane-light.webp",
    stillSrc: "zen-backgrounds/perspective-dot-plane-light.jpg",
  },
  {
    id: "waving-dot-field-animated",
    title: "Waving dots animated",
    group: "abstract",
    tone: "dark",
    motion: "animated",
    src: "zen-backgrounds/waving-dot-field-dark.webp",
    stillSrc: "zen-backgrounds/waving-dot-field.jpg",
  },
  {
    id: "waving-dot-field-light-animated",
    title: "Waving dots light animated",
    group: "abstract",
    tone: "light",
    motion: "animated",
    src: "zen-backgrounds/waving-dot-field-light.webp",
    stillSrc: "zen-backgrounds/waving-dot-field-light.jpg",
  },
  {
    id: "curling-dash-wave-animated",
    title: "Curling dashes animated",
    group: "abstract",
    tone: "dark",
    motion: "animated",
    src: "zen-backgrounds/curling-dash-wave-dark.webp",
    stillSrc: "zen-backgrounds/curling-dash-wave.jpg",
  },
  {
    id: "curling-dash-wave-light-animated",
    title: "Curling dashes light animated",
    group: "abstract",
    tone: "light",
    motion: "animated",
    src: "zen-backgrounds/curling-dash-wave-light.webp",
    stillSrc: "zen-backgrounds/curling-dash-wave-light.jpg",
  },
] as const satisfies ReadonlyArray<ZenBuiltinBackgroundPreset>;

export type ZenBuiltinBackgroundIdSchema = typeof ZenBuiltinBackgroundId.Type;

export const ZenBackground = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("solid"),
    color: ZenHexColor,
  }),
  Schema.Struct({
    kind: Schema.Literal("gradient"),
    style: ZenGradientStyle.pipe(Schema.withDecodingDefaultType(Effect.succeed("linear" as const))),
    from: ZenHexColor,
    to: ZenHexColor,
    angle: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 360 })),
  }),
  Schema.Struct({
    kind: Schema.Literal("image"),
    assetId: ZenBackgroundAssetId,
    stillAssetId: Schema.optional(ZenBackgroundAssetId),
    overlay: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 90 })),
    fill: ZenBackgroundFill.pipe(Schema.withDecodingDefaultType(Effect.succeed("cover" as const))),
  }).check(
    Schema.makeFilter(
      (background) =>
        background.stillAssetId === undefined || background.stillAssetId !== background.assetId,
      { message: "stillAssetId must differ from assetId" },
    ),
  ),
  Schema.Struct({
    kind: Schema.Literal("builtin"),
    presetId: ZenBuiltinBackgroundId,
    overlay: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 90 })),
    fill: ZenBackgroundFill.pipe(Schema.withDecodingDefaultType(Effect.succeed("cover" as const))),
  }),
  Schema.Struct({
    kind: Schema.Literal("theme"),
  }),
]);
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

/**
 * A new space opens on a first-party picture, not a flat colour: the glass a
 * card wears takes its colour from what is behind it, and over a flat ground
 * the focus zone read as an empty dark page. A space stored before this with
 * the old flat default is drawn the same way (see
 * {@link LEGACY_DEFAULT_ZEN_GROUND_COLOR}).
 */
export const DEFAULT_ZEN_BACKGROUND: ZenBackground = {
  kind: "builtin",
  presetId: "nordic-fjord-aurora",
  overlay: 20,
  fill: "cover",
};

/**
 * The flat colour every space was given before it had a picture. Nobody chose
 * it, so a space still carrying it is read as unconfigured and shown on
 * {@link DEFAULT_ZEN_BACKGROUND}.
 */
export const LEGACY_DEFAULT_ZEN_GROUND_COLOR = "#1a1a2e";

/**
 * How a picture ground is printed. `pixelate` draws it in square cells of
 * `cell` CSS pixels; `dither` does the same and then quantizes each colour
 * channel to `levels` steps through an ordered threshold, so it reads as a
 * halftone. `none` keeps the dials so turning the effect back on restores
 * them. It applies to built-in and uploaded pictures; the application ground
 * carries its own dither in Settings › Background.
 */
export const ZenGroundEffect = Schema.Struct({
  kind: Schema.Literals(["none", "pixelate", "dither"]),
  cell: Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 16 })),
  levels: Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 16 })),
});
export type ZenGroundEffect = typeof ZenGroundEffect.Type;

export const DEFAULT_ZEN_GROUND_EFFECT: ZenGroundEffect = { kind: "none", cell: 3, levels: 8 };

export const ZenAppearance = Schema.Struct({
  background: ZenBackground,
  dimming: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 90 })),
  elementOpacity: Schema.Number.check(Schema.isBetween({ minimum: 0.1, maximum: 1 })),
  reducedMotion: Schema.Boolean,
  reducedTransparency: Schema.Boolean,
  increasedContrast: Schema.Boolean,
  /** Absent on every space stored before the effect existed; read as none. */
  groundEffect: Schema.optional(ZenGroundEffect),
});
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
  providerId: NonEmptyTrimmedString,
  modelId: NonEmptyTrimmedString,
});
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
  width: Schema.Number.check(
    Schema.isGreaterThanOrEqualTo(MIN_ZEN_RESEARCH_DOCK_WIDTH),
    Schema.isLessThanOrEqualTo(MAX_ZEN_RESEARCH_DOCK_WIDTH),
  ),
  collapsed: Schema.Boolean,
}).check(Schema.makeFilter((dock) => dock.sourceContext.threadKind !== "chat"));
export type ZenResearchDock = typeof ZenResearchDock.Type;

/**
 * A Project's own browser docked to the edge of a space.
 *
 * It names a Work or Code Project and no thread: the page is the person's,
 * in an isolated context the host keeps for this window and Project, and no
 * agent can reach it. Docking grants nothing either; whether the window may
 * still show that Project's page is decided by the host each time it is asked.
 */
export const ZenProjectResearchDock = Schema.Struct({
  project: Schema.Struct({
    hostId: HostId,
    projectId: ProjectId,
    mode: Schema.Literals(["work", "code"]),
  }),
  width: Schema.Number.check(
    Schema.isGreaterThanOrEqualTo(MIN_ZEN_RESEARCH_DOCK_WIDTH),
    Schema.isLessThanOrEqualTo(MAX_ZEN_RESEARCH_DOCK_WIDTH),
  ),
  collapsed: Schema.Boolean,
});
export type ZenProjectResearchDock = typeof ZenProjectResearchDock.Type;

/** What a space can have docked: a thread's browsing context or a Project's own browser. */
export const ZenDockedResearch = Schema.Union([ZenResearchDock, ZenProjectResearchDock]);
export type ZenDockedResearch = typeof ZenDockedResearch.Type;

export const ZenSpace = Schema.Struct({
  spaceId: ZenSpaceId,
  windowId: WindowId,
  version: AggregateVersion,
  elements: Schema.Array(ZenElementPayload),
  recipes: Schema.optional(Schema.Array(ZenWidgetRecipe).check(Schema.isMaxLength(20))),
  viewport: ZenViewport,
  appearance: ZenAppearance,
  active: Schema.Boolean.pipe(Schema.withDecodingDefaultType(Effect.succeed(false))),
  barCollapsed: Schema.Boolean.pipe(Schema.withDecodingDefaultType(Effect.succeed(false))),
  // A space journaled before the wall existed replays as a wall, like a new
  // one. Its stored geometry came from the spawn cascade rather than from a
  // person, so keeping it would preserve the stacking this replaces; and
  // because the wall never writes geometry, anyone who did arrange their cards
  // by hand gets that arrangement back exactly by pressing Arrange once.
  layout: ZenSpaceLayout.pipe(Schema.withDecodingDefaultType(Effect.succeed("wall" as const))),
  assistant: Schema.NullOr(ZenAssistantBinding),
  research: Schema.NullOr(ZenDockedResearch).pipe(
    Schema.withDecodingDefaultType(Effect.succeed(null)),
  ),
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
}).check(
  Schema.makeFilter(
    (space) => {
      const ids = new Set(space.elements.map((e) => e.elementId));
      if (ids.size !== space.elements.length) return false;
      const recipeIds = new Set((space.recipes ?? []).map((recipe) => recipe.recipeId));
      if (recipeIds.size !== (space.recipes ?? []).length) return false;
      const zIndices = new Set(space.elements.map((e) => e.zIndex));
      return zIndices.size === space.elements.length;
    },
    { message: "duplicate element IDs or z-index values in ZenSpace" },
  ),
);
export type ZenSpace = typeof ZenSpace.Type;

/** A full aggregate snapshot carried by the event journal for replay. */
export const ZenSpaceSnapshot = Schema.Struct({
  spaceId: ZenSpaceId,
  space: ZenSpace,
});
export type ZenSpaceSnapshot = typeof ZenSpaceSnapshot.Type;

export const ZenSpaceSnapshotRecorded = ZenSpaceSnapshot;
export type ZenSpaceSnapshotRecorded = typeof ZenSpaceSnapshotRecorded.Type;

/**
 * V1 journal snapshots used a boolean `running` timer flag. Keep the legacy
 * event schema explicit so replay validates the old bytes before the server
 * projection migrates them to the current timer clock fields.
 */
const ZenLegacyTimerElementPayload = Schema.Struct({
  elementId: ZenElementId,
  kind: Schema.Literal("timer"),
  durationMs: ZenTimerDurationMs,
  remainingMs: NonNegativeInt,
  running: Schema.Boolean,
  geometry: ZenGeometry,
  zIndex: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1000)),
  minimized: Schema.Boolean,
  locked: Schema.Boolean,
  title: Schema.optional(NonEmptyTrimmedString),
}).pipe(
  // zenProjection's migration carries remainingMs/durationMs through unchanged
  // and then re-validates the result against the current ZenTimerElementPayload,
  // whose filter already rejects remainingMs > durationMs. Enforcing it here too
  // means a V1 event that could never have come from the timer policy is
  // quarantined at the replay decode boundary with an honest reason, not three
  // layers deeper inside the projection's own re-decode.
  Schema.check(Schema.makeFilter((timer) => timer.remainingMs <= timer.durationMs)),
);

const ZenLegacyElementPayload = Schema.Union([
  ZenThreadElementPayload,
  ZenTerminalElementPayload,
  ZenCanvasElementPayload,
  ZenNotesElementPayload,
  ZenChecklistElementPayload,
  ZenLegacyTimerElementPayload,
  ZenReferenceElementPayload,
  ZenRecipeElementPayload,
]);

const ZenLegacySpace = Schema.Struct({
  spaceId: ZenSpaceId,
  windowId: WindowId,
  version: AggregateVersion,
  elements: Schema.Array(ZenLegacyElementPayload),
  recipes: Schema.optional(Schema.Array(ZenWidgetRecipe).check(Schema.isMaxLength(20))),
  viewport: ZenViewport,
  appearance: ZenAppearance,
  active: Schema.Boolean.pipe(Schema.withDecodingDefaultType(Effect.succeed(false))),
  barCollapsed: Schema.Boolean.pipe(Schema.withDecodingDefaultType(Effect.succeed(false))),
  assistant: Schema.NullOr(ZenAssistantBinding),
  research: Schema.NullOr(ZenResearchDock).pipe(
    Schema.withDecodingDefaultType(Effect.succeed(null)),
  ),
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
});

export const ZenSpaceSnapshotRecordedV1 = Schema.Struct({
  spaceId: ZenSpaceId,
  space: ZenLegacySpace,
});
export type ZenSpaceSnapshotRecordedV1 = typeof ZenSpaceSnapshotRecordedV1.Type;

export const ZenWidgetMutation = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("widget-created"),
    kind: Schema.Literals(["notes", "checklist"]),
    elementId: ZenElementId,
    widgetVersion: AggregateVersion,
  }),
  Schema.Struct({
    operation: Schema.Literal("notes-saved"),
    elementId: ZenElementId,
    widgetVersion: AggregateVersion,
  }),
  Schema.Struct({
    operation: Schema.Literal("checklist-item-added"),
    elementId: ZenElementId,
    itemId: ZenChecklistItemId,
    widgetVersion: AggregateVersion,
  }),
  Schema.Struct({
    operation: Schema.Literals([
      "checklist-item-completed",
      "checklist-item-reordered",
      "checklist-item-removed",
    ]),
    elementId: ZenElementId,
    itemId: ZenChecklistItemId,
    widgetVersion: AggregateVersion,
  }),
]);
export type ZenWidgetMutation = typeof ZenWidgetMutation.Type;

export const ZenWidgetMutationRecorded = Schema.Struct({
  spaceId: ZenSpaceId,
  space: ZenSpace,
  mutation: ZenWidgetMutation,
});
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
});
export type ZenThreadPinRequest = typeof ZenThreadPinRequest.Type;

export const ZenThreadPinResult = Schema.Struct({
  result: Schema.Literal("thread-pinned"),
  entry: ZenThreadCatalogEntry,
  elementId: ZenElementId,
  space: ZenSpace,
});
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
  title: Schema.optional(NonEmptyTrimmedString),
});
export type ZenTerminalPinRequest = typeof ZenTerminalPinRequest.Type;

export const ZenTerminalPinResult = Schema.Struct({
  result: Schema.Literal("terminal-pinned"),
  elementId: ZenElementId,
  space: ZenSpace,
});
export type ZenTerminalPinResult = typeof ZenTerminalPinResult.Type;

/**
 * Pin a terminal this window opened for a Code Project.
 *
 * Named, never described: the server asks the Project terminal owner whether
 * this window owns the shell and writes the card itself.
 */
export const ZenProjectTerminalPinRequest = Schema.Struct({
  projectId: ProjectId,
  terminalId: CodeTerminalId,
  expectedVersion: AggregateVersion,
  geometry: Schema.optional(ZenGeometry),
  title: Schema.optional(NonEmptyTrimmedString),
});
export type ZenProjectTerminalPinRequest = typeof ZenProjectTerminalPinRequest.Type;

/**
 * Dock a research browser onto a Work or Code thread this window may see.
 *
 * The request names the thread, never the source context: the server resolves
 * the thread's own context from the catalog and writes the dock itself, so a
 * caller cannot dock onto authority by describing it. A null thread closes the
 * dock; naming the bound thread again with a new width or collapsed flag
 * rearranges it. Naming a `project` instead of a thread docks that Project's
 * own browser, which the server resolves the same way.
 */
export const ZenResearchDockRequest = Schema.Struct({
  thread: Schema.NullOr(
    Schema.Struct({
      threadId: Schema.Union([WorkThreadId, CodeThreadId]),
      mode: Schema.Literals(["work", "code"]),
    }),
  ),
  project: Schema.optional(Schema.Struct({ projectId: ProjectId })),
  width: Schema.optional(
    Schema.Number.check(
      Schema.isGreaterThanOrEqualTo(MIN_ZEN_RESEARCH_DOCK_WIDTH),
      Schema.isLessThanOrEqualTo(MAX_ZEN_RESEARCH_DOCK_WIDTH),
    ),
  ),
  collapsed: Schema.optional(Schema.Boolean),
  expectedVersion: AggregateVersion,
}).check(Schema.makeFilter((request) => request.thread === null || request.project === undefined));
export type ZenResearchDockRequest = typeof ZenResearchDockRequest.Type;

export const ZenResearchDockResult = Schema.Struct({
  result: Schema.Literal("research-docked"),
  space: ZenSpace,
});
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
  title: Schema.optional(NonEmptyTrimmedString),
});
export type ZenCanvasPinRequest = typeof ZenCanvasPinRequest.Type;

export const ZenCanvasPinResult = Schema.Struct({
  result: Schema.Literal("canvas-pinned"),
  elementId: ZenElementId,
  space: ZenSpace,
});
export type ZenCanvasPinResult = typeof ZenCanvasPinResult.Type;

export const ZenThreadContinuationTarget = Schema.Struct({
  result: Schema.Literal("thread-continuation"),
  entry: ZenThreadCatalogEntry,
});
export type ZenThreadContinuationTarget = typeof ZenThreadContinuationTarget.Type;

export const ZenAssistantProviderState = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  providerLabel: NonEmptyTrimmedString,
  modelId: ProviderModelId,
  modelLabel: NonEmptyTrimmedString,
  readiness: ProviderReadiness,
  toolCapability: ProviderCapabilitySupport,
  toolCapabilityReason: Schema.optional(NonEmptyTrimmedString),
});
export type ZenAssistantProviderState = typeof ZenAssistantProviderState.Type;

export const ZenAssistantTranscriptMessage = Schema.Struct({
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
  createdAt: UtcTimestamp,
});
export type ZenAssistantTranscriptMessage = typeof ZenAssistantTranscriptMessage.Type;

export const ZenAssistantSnapshot = Schema.Struct({
  status: Schema.Literals(["unbound", "ready", "unavailable"]),
  binding: Schema.NullOr(ZenAssistantBinding),
  provider: Schema.NullOr(ZenAssistantProviderState),
  transcript: Schema.Array(ZenAssistantTranscriptMessage),
  recipePreview: Schema.optional(Schema.NullOr(ZenRecipePreview)),
  manualControls: Schema.Tuple([
    Schema.Literal("threads"),
    Schema.Literal("widgets"),
    Schema.Literal("add"),
    Schema.Literal("placement"),
    Schema.Literal("appearance"),
  ]),
  message: Schema.optional(NonEmptyTrimmedString),
});
export type ZenAssistantSnapshot = typeof ZenAssistantSnapshot.Type;

/** The Zen assistant's one tool; its `operation` names what a call does. */
export const ZEN_ASSISTANT_TOOL_NAME = "octant_zen";

/** What `octant_zen` does besides `help`, which the host answers from static text. */
export const ZenAssistantOperation = Schema.Literals([
  "get-space",
  "search-threads",
  "pin-thread",
  "create-widget",
  "preview-recipe",
  "place-element",
  "update-appearance",
]);
export type ZenAssistantOperation = typeof ZenAssistantOperation.Type;

export const ZenAssistantSearchThreadsInput = Schema.Struct({
  query: Schema.String.check(Schema.isMaxLength(200)),
});
export type ZenAssistantSearchThreadsInput = typeof ZenAssistantSearchThreadsInput.Type;

export const ZenAssistantPinThreadInput = ZenThreadPinRequest;
export type ZenAssistantPinThreadInput = typeof ZenAssistantPinThreadInput.Type;

export const ZenAssistantGetSpaceInput = Schema.Struct({});
export type ZenAssistantGetSpaceInput = typeof ZenAssistantGetSpaceInput.Type;

/** The kinds `create-widget` makes; a recipe widget comes only from a confirmed preview. */
export const ZenAssistantWidgetKind = Schema.Literals(["notes", "checklist", "timer"]);
export type ZenAssistantWidgetKind = typeof ZenAssistantWidgetKind.Type;

export const ZenAssistantCreateWidgetInput = Schema.Struct({
  kind: ZenAssistantWidgetKind,
  durationMs: Schema.optional(ZenTimerDurationMs),
  expectedVersion: AggregateVersion,
}).check(Schema.makeFilter((input) => input.durationMs === undefined || input.kind === "timer"));
export type ZenAssistantCreateWidgetInput = typeof ZenAssistantCreateWidgetInput.Type;

export const ZenAssistantPreviewRecipeInput = Schema.Struct({
  recipe: ZenWidgetRecipeDraft,
  expectedVersion: AggregateVersion,
  previewId: Schema.optional(ZenRecipePreviewId),
});
export type ZenAssistantPreviewRecipeInput = typeof ZenAssistantPreviewRecipeInput.Type;

export const ZenAssistantPlacementInput = Schema.Struct({
  elementId: ZenElementId,
  expectedVersion: AggregateVersion,
  action: Schema.Literals(["move-resize", "focus", "minimize", "restore", "remove"]),
  geometry: Schema.optional(ZenGeometry),
}).check(
  Schema.makeFilter((input) => (input.action === "move-resize") === (input.geometry !== undefined)),
);
export type ZenAssistantPlacementInput = typeof ZenAssistantPlacementInput.Type;

export const ZenAssistantAppearanceInput = Schema.Struct({
  expectedVersion: AggregateVersion,
  dimming: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 90 }))),
  elementOpacity: Schema.optional(
    Schema.Number.check(Schema.isBetween({ minimum: 0.1, maximum: 1 })),
  ),
}).check(
  Schema.makeFilter((input) => input.dimming !== undefined || input.elementOpacity !== undefined),
);
export type ZenAssistantAppearanceInput = typeof ZenAssistantAppearanceInput.Type;

export const ZenAssistantAction = Schema.Union([ZenAssistantOperation, Schema.Literal("unknown")]);
export type ZenAssistantAction = typeof ZenAssistantAction.Type;

/**
 * One element as `get-space` reports it: enough to arrange it and nothing of
 * its content, so the assistant learns ids and layout without reading notes,
 * checklists, or the threads pinned there.
 */
export const ZenAssistantElementSummary = Schema.Struct({
  elementId: ZenElementId,
  kind: ZenElementKind,
  title: Schema.optional(NonEmptyTrimmedString),
  geometry: ZenGeometry,
  zIndex: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1000)),
  minimized: Schema.Boolean,
});
export type ZenAssistantElementSummary = typeof ZenAssistantElementSummary.Type;

export const ZenAssistantToolResult = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("get-space"),
    status: Schema.Literal("ok"),
    version: AggregateVersion,
    dimming: ZenAppearance.fields.dimming,
    elementOpacity: ZenAppearance.fields.elementOpacity,
    elements: Schema.Array(ZenAssistantElementSummary),
  }),
  Schema.Struct({
    action: Schema.Literal("search-threads"),
    status: Schema.Literal("ok"),
    entries: Schema.Array(ZenThreadCatalogEntry),
  }),
  Schema.Struct({
    action: Schema.Literal("preview-recipe"),
    status: Schema.Literal("ok"),
    preview: ZenRecipePreview,
  }),
  Schema.Struct({
    action: Schema.Literal("pin-thread"),
    status: Schema.Literal("ok"),
    entry: ZenThreadCatalogEntry,
    elementId: ZenElementId,
    version: AggregateVersion,
  }),
  Schema.Struct({
    action: Schema.Literal("create-widget"),
    status: Schema.Literal("ok"),
    kind: ZenAssistantWidgetKind,
    elementId: ZenElementId,
    version: AggregateVersion,
  }),
  Schema.Struct({
    action: Schema.Literal("place-element"),
    status: Schema.Literal("ok"),
    elementId: ZenElementId,
    version: AggregateVersion,
  }),
  Schema.Struct({
    action: Schema.Literal("update-appearance"),
    status: Schema.Literal("ok"),
    appearance: ZenAppearance,
    version: AggregateVersion,
  }),
  Schema.Struct({
    action: ZenAssistantAction,
    status: Schema.Literal("conflict"),
    code: Schema.Literal("stale-version"),
    version: AggregateVersion,
    message: NonEmptyTrimmedString,
  }),
  Schema.Struct({
    action: ZenAssistantAction,
    status: Schema.Literals(["failed", "interrupted", "unsupported"]),
    code: Schema.optional(NonEmptyTrimmedString),
    message: NonEmptyTrimmedString,
  }),
]);
export type ZenAssistantToolResult = typeof ZenAssistantToolResult.Type;

// ── Commands ─────────────────────────────────────────────────────────────────

export const ZenCreateSpaceCommand = Schema.Struct({
  command: Schema.Literal("create-space"),
  windowId: WindowId,
  appearance: Schema.optional(ZenAppearance),
});
export type ZenCreateSpaceCommand = typeof ZenCreateSpaceCommand.Type;

export const ZenAddElementCommand = Schema.Struct({
  command: Schema.Literal("add-element"),
  spaceId: ZenSpaceId,
  element: ZenElementPayload,
  expectedVersion: AggregateVersion,
});
export type ZenAddElementCommand = typeof ZenAddElementCommand.Type;

export const ZenUpdateElementCommand = Schema.Struct({
  command: Schema.Literal("update-element"),
  spaceId: ZenSpaceId,
  element: ZenElementPayload,
  expectedVersion: AggregateVersion,
});
export type ZenUpdateElementCommand = typeof ZenUpdateElementCommand.Type;

export const ZenRemoveElementCommand = Schema.Struct({
  command: Schema.Literal("remove-element"),
  spaceId: ZenSpaceId,
  elementId: ZenElementId,
  expectedVersion: AggregateVersion,
});
export type ZenRemoveElementCommand = typeof ZenRemoveElementCommand.Type;

export const ZenCreateTimerCommand = Schema.Struct({
  command: Schema.Literal("create-timer"),
  spaceId: ZenSpaceId,
  durationMs: ZenTimerDurationMs,
  title: Schema.optional(NonEmptyTrimmedString),
  expectedVersion: AggregateVersion,
});
export type ZenCreateTimerCommand = typeof ZenCreateTimerCommand.Type;

export const ZenTimerAction = Schema.Literals(["start", "pause", "reset", "set-duration"]);
export type ZenTimerAction = typeof ZenTimerAction.Type;

export const ZenTimerActionCommand = Schema.Struct({
  command: Schema.Literal("timer-action"),
  spaceId: ZenSpaceId,
  elementId: ZenElementId,
  action: ZenTimerAction,
  durationMs: Schema.optional(ZenTimerDurationMs),
  expectedVersion: AggregateVersion,
}).check(
  Schema.makeFilter(
    (command) => (command.action === "set-duration") === (command.durationMs !== undefined),
  ),
);
export type ZenTimerActionCommand = typeof ZenTimerActionCommand.Type;

export const ZenUpdateViewportCommand = Schema.Struct({
  command: Schema.Literal("update-viewport"),
  spaceId: ZenSpaceId,
  viewport: ZenViewport,
  expectedVersion: AggregateVersion,
});
export type ZenUpdateViewportCommand = typeof ZenUpdateViewportCommand.Type;

export const ZenUpdateAppearanceCommand = Schema.Struct({
  command: Schema.Literal("update-appearance"),
  spaceId: ZenSpaceId,
  appearance: ZenAppearance,
  expectedVersion: AggregateVersion,
});
export type ZenUpdateAppearanceCommand = typeof ZenUpdateAppearanceCommand.Type;

export const ZenBindAssistantCommand = Schema.Struct({
  command: Schema.Literal("bind-assistant"),
  spaceId: ZenSpaceId,
  assistant: ZenAssistantBinding,
  expectedVersion: AggregateVersion,
});
export type ZenBindAssistantCommand = typeof ZenBindAssistantCommand.Type;

export const ZenDockResearchCommand = Schema.Struct({
  command: Schema.Literal("dock-research"),
  spaceId: ZenSpaceId,
  research: Schema.NullOr(ZenDockedResearch),
  expectedVersion: AggregateVersion,
});
export type ZenDockResearchCommand = typeof ZenDockResearchCommand.Type;

export const ZenCreateWidgetCommand = Schema.Struct({
  command: Schema.Literal("create-widget"),
  spaceId: ZenSpaceId,
  kind: Schema.Literals(["notes", "checklist"]),
  expectedVersion: AggregateVersion,
});
export type ZenCreateWidgetCommand = typeof ZenCreateWidgetCommand.Type;

export const ZenCreateReferenceCommand = Schema.Struct({
  command: Schema.Literal("create-reference"),
  spaceId: ZenSpaceId,
  url: ZenReferenceUrl,
  label: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(200))),
  expectedVersion: AggregateVersion,
});
export type ZenCreateReferenceCommand = typeof ZenCreateReferenceCommand.Type;

export const ZenSaveNotesCommand = Schema.Struct({
  command: Schema.Literal("save-notes"),
  spaceId: ZenSpaceId,
  elementId: ZenElementId,
  content: ZenNotesElementPayload.fields.content,
  expectedVersion: AggregateVersion,
  expectedWidgetVersion: AggregateVersion,
});
export type ZenSaveNotesCommand = typeof ZenSaveNotesCommand.Type;

export const ZenAddChecklistItemCommand = Schema.Struct({
  command: Schema.Literal("add-checklist-item"),
  spaceId: ZenSpaceId,
  elementId: ZenElementId,
  text: ZenChecklistItem.fields.text,
  expectedVersion: AggregateVersion,
  expectedWidgetVersion: AggregateVersion,
});
export type ZenAddChecklistItemCommand = typeof ZenAddChecklistItemCommand.Type;

export const ZenSetChecklistItemCompletedCommand = Schema.Struct({
  command: Schema.Literal("set-checklist-item-completed"),
  spaceId: ZenSpaceId,
  elementId: ZenElementId,
  itemId: ZenChecklistItemId,
  done: Schema.Boolean,
  expectedVersion: AggregateVersion,
  expectedWidgetVersion: AggregateVersion,
});
export type ZenSetChecklistItemCompletedCommand = typeof ZenSetChecklistItemCompletedCommand.Type;

export const ZenReorderChecklistItemCommand = Schema.Struct({
  command: Schema.Literal("reorder-checklist-item"),
  spaceId: ZenSpaceId,
  elementId: ZenElementId,
  itemId: ZenChecklistItemId,
  beforeItemId: Schema.NullOr(ZenChecklistItemId),
  expectedVersion: AggregateVersion,
  expectedWidgetVersion: AggregateVersion,
});
export type ZenReorderChecklistItemCommand = typeof ZenReorderChecklistItemCommand.Type;

export const ZenRemoveChecklistItemCommand = Schema.Struct({
  command: Schema.Literal("remove-checklist-item"),
  spaceId: ZenSpaceId,
  elementId: ZenElementId,
  itemId: ZenChecklistItemId,
  expectedVersion: AggregateVersion,
  expectedWidgetVersion: AggregateVersion,
});
export type ZenRemoveChecklistItemCommand = typeof ZenRemoveChecklistItemCommand.Type;

export const ZenSetPresentationCommand = Schema.Struct({
  command: Schema.Literal("set-presentation"),
  spaceId: ZenSpaceId,
  expectedVersion: AggregateVersion,
  active: Schema.optional(Schema.Boolean),
  barCollapsed: Schema.optional(Schema.Boolean),
  layout: Schema.optional(ZenSpaceLayout),
}).check(
  Schema.makeFilter(
    (command) =>
      command.active !== undefined ||
      command.barCollapsed !== undefined ||
      command.layout !== undefined,
    { message: "set-presentation must include active, barCollapsed, or layout" },
  ),
);
export type ZenSetPresentationCommand = typeof ZenSetPresentationCommand.Type;

export const ZenRecoverCommand = Schema.Struct({
  command: Schema.Literal("recover"),
  spaceId: ZenSpaceId,
  expectedVersion: AggregateVersion,
});
export type ZenRecoverCommand = typeof ZenRecoverCommand.Type;

export const ZenConfirmRecipePreviewCommand = Schema.Struct({
  command: Schema.Literal("confirm-recipe-preview"),
  spaceId: ZenSpaceId,
  previewId: ZenRecipePreviewId,
  action: Schema.Literals(["save", "place"]),
  expectedVersion: AggregateVersion,
});
export type ZenConfirmRecipePreviewCommand = typeof ZenConfirmRecipePreviewCommand.Type;

export const ZenCommand = Schema.Union([
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
]);
export type ZenCommand = typeof ZenCommand.Type;

// ── Results ──────────────────────────────────────────────────────────────────

export const ZenCreateSpaceResult = Schema.Struct({
  result: Schema.Literal("create-space"),
  space: ZenSpace,
});
export type ZenCreateSpaceResult = typeof ZenCreateSpaceResult.Type;

export const ZenMutationResult = Schema.Struct({
  result: Schema.Literal("mutation"),
  space: ZenSpace,
});
export type ZenMutationResult = typeof ZenMutationResult.Type;

export const ZenRecoverResult = Schema.Struct({
  result: Schema.Literal("recover"),
});
export type ZenRecoverResult = typeof ZenRecoverResult.Type;

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

export const ZenFailureReason = Schema.Literals([
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
  "unsupported-kind",
  "invalid-background",
  "invalid-presentation",
  "missing-capability",
  "unavailable-source",
  "unknown-element",
  "wrong-widget-kind",
  "stale-widget-version",
  "unknown-checklist-item",
  "cross-host",
  "limit-exceeded",
  "recovery-required",
]);
export type ZenFailureReason = typeof ZenFailureReason.Type;

// ── Presentation mutation results ───────────────────────────────────────────
//
// Presentation mutations (element geometry, z-order, viewport, and active state)
// can be refused by policy without being a service failure. The result carries the
// refusal kind and message so callers can reconcile optimistic UI state instead of
// collapsing expected refusals into thrown exceptions.

export const ZenRefusedResult = Schema.Struct({
  status: Schema.Literal("refused"),
  kind: ZenFailureReason,
  message: Schema.String,
});
export type ZenRefusedResult = typeof ZenRefusedResult.Type;

export const ZenFailedResult = Schema.Struct({
  status: Schema.Literal("failed"),
  kind: Schema.String,
  message: Schema.String,
});
export type ZenFailedResult = typeof ZenFailedResult.Type;

export const ZenTruncatedResult = Schema.Struct({
  status: Schema.Literal("truncated"),
  kind: Schema.Literal("truncated"),
  space: ZenSpace,
  message: Schema.String,
});
export type ZenTruncatedResult = typeof ZenTruncatedResult.Type;

export const ZenResult = Schema.Union([
  ZenCreateSpaceResult,
  ZenMutationResult,
  ZenRecoverResult,
  ZenRefusedResult,
  ZenFailedResult,
  ZenTruncatedResult,
]);
export type ZenResult = typeof ZenResult.Type;

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

export const ZenSpaceName = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_ZEN_SPACE_NAME_LENGTH),
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
  position: NonNegativeInt,
});
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
  spaces: Schema.Array(ZenSpaceSummary).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_ZEN_SPACES_PER_WINDOW),
  ),
  activeSpaceId: ZenSpaceId,
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
}).check(
  Schema.makeFilter(
    (zone) => {
      const ids = new Set(zone.spaces.map((space) => String(space.spaceId)));
      if (ids.size !== zone.spaces.length) return false;
      if (!ids.has(String(zone.activeSpaceId))) return false;
      const positions = [...zone.spaces].map((space) => space.position).sort((a, b) => a - b);
      return positions.every((position, index) => position === index);
    },
    {
      message:
        "a focus zone needs unique spaces, contiguous positions, and an active space it holds",
    },
  ),
);
export type ZenFocusZone = typeof ZenFocusZone.Type;

/** A full focus-zone snapshot carried by the event journal for replay. */
export const ZenFocusZoneRecorded = Schema.Struct({
  windowId: WindowId,
  zone: ZenFocusZone,
});
export type ZenFocusZoneRecorded = typeof ZenFocusZoneRecorded.Type;

/**
 * Add another space to a window that already has a focus zone. The window's
 * first space is minted by `create-space`, which opens the zone itself.
 */
export const ZenAddSpaceCommand = Schema.Struct({
  command: Schema.Literal("add-space"),
  name: ZenSpaceName,
  expectedVersion: AggregateVersion,
});
export type ZenAddSpaceCommand = typeof ZenAddSpaceCommand.Type;

export const ZenRenameSpaceCommand = Schema.Struct({
  command: Schema.Literal("rename-space"),
  spaceId: ZenSpaceId,
  name: ZenSpaceName,
  expectedVersion: AggregateVersion,
});
export type ZenRenameSpaceCommand = typeof ZenRenameSpaceCommand.Type;

export const ZenRemoveSpaceCommand = Schema.Struct({
  command: Schema.Literal("remove-space"),
  spaceId: ZenSpaceId,
  expectedVersion: AggregateVersion,
});
export type ZenRemoveSpaceCommand = typeof ZenRemoveSpaceCommand.Type;

export const ZenReorderSpaceCommand = Schema.Struct({
  command: Schema.Literal("reorder-space"),
  spaceId: ZenSpaceId,
  position: NonNegativeInt,
  expectedVersion: AggregateVersion,
});
export type ZenReorderSpaceCommand = typeof ZenReorderSpaceCommand.Type;

export const ZenActivateSpaceCommand = Schema.Struct({
  command: Schema.Literal("activate-space"),
  spaceId: ZenSpaceId,
  expectedVersion: AggregateVersion,
});
export type ZenActivateSpaceCommand = typeof ZenActivateSpaceCommand.Type;

export const ZenFocusZoneCommand = Schema.Union([
  ZenAddSpaceCommand,
  ZenRenameSpaceCommand,
  ZenRemoveSpaceCommand,
  ZenReorderSpaceCommand,
  ZenActivateSpaceCommand,
]);
export type ZenFocusZoneCommand = typeof ZenFocusZoneCommand.Type;

export const ZenFocusZoneResult = Schema.Struct({
  result: Schema.Literal("focus-zone-updated"),
  zone: ZenFocusZone,
  /** The space now in front, so a switch is one round trip rather than two. */
  space: ZenSpace,
});
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
});
export type ZenBootstrapResponse = typeof ZenBootstrapResponse.Type;

export const decodeZenCommand = Schema.decodeUnknownSync(ZenCommand, STRICT_DECODE_OPTIONS);
export const decodeZenResult = Schema.decodeUnknownSync(ZenResult, STRICT_DECODE_OPTIONS);
export const decodeZenBootstrapResponse = Schema.decodeUnknownSync(
  ZenBootstrapResponse,
  STRICT_DECODE_OPTIONS,
);
export const decodeZenFocusZone = Schema.decodeUnknownSync(ZenFocusZone, STRICT_DECODE_OPTIONS);
export const decodeZenFocusZoneCommand = Schema.decodeUnknownSync(
  ZenFocusZoneCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeZenFocusZoneRecorded = Schema.decodeUnknownSync(
  ZenFocusZoneRecorded,
  STRICT_DECODE_OPTIONS,
);
export const decodeZenFocusZoneResult = Schema.decodeUnknownSync(
  ZenFocusZoneResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeZenSpace = Schema.decodeUnknownSync(ZenSpace, STRICT_DECODE_OPTIONS);
export const decodeZenSpaceSnapshotRecordedV1 = Schema.decodeUnknownSync(
  ZenSpaceSnapshotRecordedV1,
  STRICT_DECODE_OPTIONS,
);
export const decodeZenWidgetMutationRecorded = Schema.decodeUnknownSync(
  ZenWidgetMutationRecorded,
  STRICT_DECODE_OPTIONS,
);
export const decodeZenSpaceId = Schema.decodeUnknownSync(ZenSpaceId, STRICT_DECODE_OPTIONS);
export const decodeZenElementId = Schema.decodeUnknownSync(ZenElementId, STRICT_DECODE_OPTIONS);
export const decodeZenChecklistItemId = Schema.decodeUnknownSync(
  ZenChecklistItemId,
  STRICT_DECODE_OPTIONS,
);
export const decodeZenBackgroundAssetId = Schema.decodeUnknownSync(
  ZenBackgroundAssetId,
  STRICT_DECODE_OPTIONS,
);
export const decodeZenThreadCatalogRef = Schema.decodeUnknownSync(
  ZenThreadCatalogRef,
  STRICT_DECODE_OPTIONS,
);
export const decodeZenThreadCatalogEntry = Schema.decodeUnknownSync(
  ZenThreadCatalogEntry,
  STRICT_DECODE_OPTIONS,
);
export const decodeZenThreadCatalogResponse = Schema.decodeUnknownSync(
  ZenThreadCatalogResponse,
  STRICT_DECODE_OPTIONS,
);
export const decodeZenThreadPinRequest = Schema.decodeUnknownSync(
  ZenThreadPinRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeZenThreadPinResult = Schema.decodeUnknownSync(
  ZenThreadPinResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeZenResearchDockRequest = Schema.decodeUnknownSync(
  ZenResearchDockRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeZenResearchDockResult = Schema.decodeUnknownSync(
  ZenResearchDockResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeZenCanvasPinRequest = Schema.decodeUnknownSync(
  ZenCanvasPinRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeZenCanvasPinResult = Schema.decodeUnknownSync(
  ZenCanvasPinResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeZenTerminalPinRequest = Schema.decodeUnknownSync(
  ZenTerminalPinRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeZenTerminalPinResult = Schema.decodeUnknownSync(
  ZenTerminalPinResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeZenProjectTerminalPinRequest = Schema.decodeUnknownSync(
  ZenProjectTerminalPinRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeZenThreadContinuationTarget = Schema.decodeUnknownSync(
  ZenThreadContinuationTarget,
  STRICT_DECODE_OPTIONS,
);
export const decodeZenAssistantSnapshot = Schema.decodeUnknownSync(
  ZenAssistantSnapshot,
  STRICT_DECODE_OPTIONS,
);
export const decodeZenAssistantSearchThreadsInput = Schema.decodeUnknownSync(
  ZenAssistantSearchThreadsInput,
  STRICT_DECODE_OPTIONS,
);
export const decodeZenAssistantPinThreadInput = Schema.decodeUnknownSync(
  ZenAssistantPinThreadInput,
  STRICT_DECODE_OPTIONS,
);
export const decodeZenAssistantGetSpaceInput = Schema.decodeUnknownSync(
  ZenAssistantGetSpaceInput,
  STRICT_DECODE_OPTIONS,
);
export const decodeZenAssistantCreateWidgetInput = Schema.decodeUnknownSync(
  ZenAssistantCreateWidgetInput,
  STRICT_DECODE_OPTIONS,
);
export const decodeZenAssistantPreviewRecipeInput = Schema.decodeUnknownSync(
  ZenAssistantPreviewRecipeInput,
  STRICT_DECODE_OPTIONS,
);
export const decodeZenRecipePreviewId = Schema.decodeUnknownSync(
  ZenRecipePreviewId,
  STRICT_DECODE_OPTIONS,
);
export const decodeZenAssistantPlacementInput = Schema.decodeUnknownSync(
  ZenAssistantPlacementInput,
  STRICT_DECODE_OPTIONS,
);
export const decodeZenAssistantAppearanceInput = Schema.decodeUnknownSync(
  ZenAssistantAppearanceInput,
  STRICT_DECODE_OPTIONS,
);
export const decodeZenAssistantToolResult = Schema.decodeUnknownSync(
  ZenAssistantToolResult,
  STRICT_DECODE_OPTIONS,
);
