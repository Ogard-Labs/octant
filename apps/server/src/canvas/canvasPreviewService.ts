import type { CanvasBlock } from "@octant/contracts/canvas";
import { decodeCanvasId } from "@octant/contracts/canvas";
import type { ProviderToolImage } from "@octant/contracts";
import { effectiveCanvasPresentation } from "@octant/domain";
import { getDefaultToken } from "@octant/theme";
import type {
  CanvasAuthorizationContext,
  CanvasProjectRecord,
  CanvasService,
} from "./canvasService";
import {
  canvasPreviewWarnings,
  type CanvasPreviewPalette,
  type CanvasPreviewWarning,
} from "./canvasPreviewWarnings";
import type { CanvasPreviewRenderer } from "./canvasPreviewRenderer";

/**
 * Looking at a Canvas before it is sent.
 *
 * The service answers one question honestly: what does this document read as,
 * and can this turn be shown a picture of it? The layout reading is computed
 * from the document and the target width, so it is reported whether or not a
 * browser rendered anything. The picture is added only when a Chromium the host
 * may drive exists and the model driving this turn accepts images in a tool
 * result; otherwise the warning list still comes back and the result says which
 * of the two was missing.
 *
 * It is bounded the way a person previewing a document is: one look per thread
 * at a time, and a small allowance per minute, so a loop cannot spend the
 * host's browser or a model's context on the same page repeatedly.
 */
export interface CanvasPreviewServiceOptions {
  readonly canvas: Pick<CanvasService, "get" | "history">;
  readonly renderer: CanvasPreviewRenderer;
  /** Milliseconds since the epoch; injectable so a test owns the clock. */
  readonly now?: () => number;
  readonly previewsPerWindow?: number;
  readonly windowMs?: number;
}

export interface CanvasPreviewRequest {
  readonly canvasId: ReturnType<typeof decodeCanvasId>;
  readonly threadKey: string;
  /** A specific version sequence, or the current version when absent. */
  readonly version?: number;
  readonly width: CanvasPreviewWidth;
  readonly theme: "light" | "dark";
  /** Whether the model driving this turn accepts images in a tool result. */
  readonly imagesInToolResults: boolean;
}

export type CanvasPreviewWidth = "inline" | "sidebar" | number;

export type CanvasPreviewOutcome =
  | {
      readonly kind: "preview";
      readonly canvasId: string;
      readonly sequence: number;
      readonly width: number;
      readonly height: number;
      readonly warnings: ReadonlyArray<CanvasPreviewWarning>;
      /** Present only when the picture could be taken this time. */
      readonly image?: ProviderToolImage;
      /** Why no picture accompanies the warnings, when one does not. */
      readonly imageOmitted?: "no-browser" | "provider-cannot-take-images";
    }
  | { readonly kind: "unavailable"; readonly message: string }
  | { readonly kind: "busy" }
  | { readonly kind: "rate-limited" };

/** The drawn width a named layout asks for. */
const INLINE_WIDTH = 380;
const SIDEBAR_WIDTH = 720;
/** A preview is at least a phone and never wider than the image ceiling allows. */
const MIN_WIDTH = 320;
const MAX_WIDTH = 1_200;
/** The smallest and largest picture; content decides the height in between. */
const MIN_HEIGHT = 360;
const MAX_HEIGHT = 2_400;
const PER_BLOCK_HEIGHT = 96;
const PREVIEWS_PER_WINDOW = 6;
const PREVIEW_WINDOW_MS = 60_000;

/**
 * The series hues in the fixed categorical order the design pins them to:
 * brass, teal, rose, violet, green, blue.
 */
const SERIES_TOKEN_IDS: ReadonlyArray<string> = [
  "palette-orange",
  "palette-teal",
  "palette-pink",
  "palette-purple",
  "palette-green",
  "palette-blue",
];

/** The palette a preview is read against, from the chosen theme's own tokens. */
export function canvasPreviewPalette(theme: "light" | "dark"): CanvasPreviewPalette {
  const token = (id: string): string => getDefaultToken(id, theme);
  return {
    workspace: token("workspace"),
    ink: token("text-primary"),
    muted: token("text-secondary"),
    accent: token("accent"),
    series: SERIES_TOKEN_IDS.map(token),
  };
}

export function canvasPreviewWidth(width: CanvasPreviewWidth): number {
  const requested = width === "inline" ? INLINE_WIDTH : width === "sidebar" ? SIDEBAR_WIDTH : width;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(requested)));
}

export function createCanvasPreviewService(
  options: CanvasPreviewServiceOptions,
): CanvasPreviewService {
  const now = options.now ?? (() => Date.now());
  const previewsPerWindow = options.previewsPerWindow ?? PREVIEWS_PER_WINDOW;
  const windowMs = options.windowMs ?? PREVIEW_WINDOW_MS;
  const inFlight = new Map<string, Promise<void>>();
  const recent = new Map<string, number[]>();

  const service: CanvasPreviewService = {
    async preview(
      request: CanvasPreviewRequest,
      context: CanvasAuthorizationContext,
      project: CanvasProjectRecord | undefined,
    ): Promise<CanvasPreviewOutcome> {
      if (inFlight.has(request.threadKey)) return { kind: "busy" };
      let resolveDone: () => void = () => undefined;
      const done = new Promise<void>((resolvePromise) => {
        resolveDone = resolvePromise;
      });
      inFlight.set(request.threadKey, done);
      try {
        if (exceedsRateLimit(recent, request.threadKey, now(), previewsPerWindow, windowMs)) {
          return { kind: "rate-limited" };
        }
        const version = resolveVersion(options.canvas, request, context, project);
        if (version.kind === "unavailable") return version;
        const definition = version.version.definition;
        const width = canvasPreviewWidth(request.width);
        const presentation =
          request.width === "inline" ? "inline" : effectiveCanvasPresentation(definition);
        const palette = canvasPreviewPalette(request.theme);
        const warnings = canvasPreviewWarnings({ definition, presentation, width, palette });
        const height = previewHeight(definition.blocks);
        const base = {
          kind: "preview",
          canvasId: String(version.version.canvasId),
          sequence: version.version.sequence,
          width,
          height,
          warnings,
        } as const;
        if (!request.imagesInToolResults) {
          return { ...base, imageOmitted: "provider-cannot-take-images" };
        }
        if (!(await options.renderer.available())) {
          return { ...base, imageOmitted: "no-browser" };
        }
        const rendered = await options.renderer.render({
          definition,
          width,
          height,
          palette: {
            background: palette.workspace,
            ink: palette.ink,
            muted: palette.muted,
            accent: palette.accent,
          },
        });
        if (rendered.kind !== "rendered") {
          return { ...base, imageOmitted: "no-browser" };
        }
        return {
          ...base,
          image: { mimeType: "image/png", data: Buffer.from(rendered.png).toString("base64") },
        };
      } finally {
        inFlight.delete(request.threadKey);
        resolveDone();
      }
    },
  };
  return service;
}

export interface CanvasPreviewService {
  preview(
    request: CanvasPreviewRequest,
    context: CanvasAuthorizationContext,
    project: CanvasProjectRecord | undefined,
  ): Promise<CanvasPreviewOutcome>;
}

function resolveVersion(
  canvas: Pick<CanvasService, "get" | "history">,
  request: CanvasPreviewRequest,
  context: CanvasAuthorizationContext,
  project: CanvasProjectRecord | undefined,
):
  | { readonly kind: "ready"; readonly version: CanvasServiceVersion }
  | { readonly kind: "unavailable"; readonly message: string } {
  if (request.version === undefined) {
    const outcome = canvas.get(request.canvasId, context, project);
    return outcome.kind === "ready"
      ? { kind: "ready", version: outcome.version }
      : { kind: "unavailable", message: "That Canvas is unavailable." };
  }
  const history = canvas.history(request.canvasId, context, project);
  if (history.kind !== "ready")
    return { kind: "unavailable", message: "That Canvas is unavailable." };
  const entry = history.history.entries.find((row) => row.sequence === request.version);
  if (entry === undefined) {
    return {
      kind: "unavailable",
      message: `This Canvas has no version ${String(request.version)}.`,
    };
  }
  const outcome = canvas.get(request.canvasId, context, project, entry.versionId);
  return outcome.kind === "ready"
    ? { kind: "ready", version: outcome.version }
    : { kind: "unavailable", message: "That Canvas version is unavailable." };
}

type CanvasServiceVersion = Extract<
  ReturnType<CanvasService["get"]>,
  { readonly kind: "ready" }
>["version"];

function previewHeight(blocks: ReadonlyArray<CanvasBlock>): number {
  return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, blocks.length * PER_BLOCK_HEIGHT));
}

function exceedsRateLimit(
  recent: Map<string, number[]>,
  threadKey: string,
  at: number,
  perWindow: number,
  windowMs: number,
): boolean {
  const stamps = (recent.get(threadKey) ?? []).filter((stamp) => at - stamp < windowMs);
  if (stamps.length >= perWindow) {
    recent.set(threadKey, stamps);
    return true;
  }
  stamps.push(at);
  recent.set(threadKey, stamps);
  return false;
}

/** Re-exported so the tool and its tests share one definition of the palette type. */
export type { CanvasPreviewPalette, CanvasPreviewWarning };
