import {
  CANVAS_DESIGN_ASSET_SCHEME,
  CANVAS_DESIGN_VIEWPORT,
  type CanvasDesignAssetResolution,
  type CanvasDesignAssetUnavailableReason,
  type CanvasDesignBlock,
  type CanvasDesignTheme,
} from "@octant/contracts/canvas";
import { DESIGN_FRAME_KIT } from "./designFrameKit";

/**
 * The page a design frame is drawn from.
 *
 * It is handed to a frame whose `sandbox` never grants script, so no script
 * runs and the page cannot open, submit, or reach its parent. The policy below
 * also forbids every load but inline styles and `data:` images and fonts; a
 * policy can only narrow the one the app already passes to this page.
 *
 * Frames link to each other by fragment (`href="#checkout"`). With every
 * frame in one page, the frame a link names is shown by `:target` alone, so a
 * person clicks through a design without the page running anything.
 *
 * A `srcdoc` page resolves links against its parent's address, so a bare
 * `#checkout` would navigate the frame to the Octant page itself and draw it
 * blank. Each fragment link is written against the page's own address instead,
 * which the browser treats as a jump within the page.
 */

const FRAME_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'";

/**
 * One frame is shown at a time: the one the address names, the one holding
 * the section it names, or else the start frame.
 */
const DEVICE_FRAME_RULES = [
  "html, body { margin: 0; min-height: 100%; }",
  ".octant-frame { display: none; min-height: 100vh; }",
  ".octant-frame:target, .octant-frame:has(:target) { display: block; }",
  "body:not(:has(.octant-frame:target, .octant-frame :target)) .octant-frame[data-start] { display: block; }",
].join("\n");

/**
 * A document shows every frame in order, as sections of one page. The host
 * measures the body to size the frame, so the body holds its children's
 * margins and nothing stretches it to the frame's own height.
 */
const DOCUMENT_FRAME_RULES = [
  "html, body { margin: 0; }",
  "body { display: flow-root; }",
  ".octant-frame { display: block; }",
].join("\n");

// A page that sets no colours reads as a browser would show it, whatever
// theme Octant is in.
const UNTHEMED_PAGE = "html { color-scheme: light; background: white; color: black; }";

/**
 * The workspace tokens a themed frame receives, read from Octant's own page
 * when the frame is drawn. These are the semantic `--oct-*` roles the frame
 * kit reads; an author may read them too.
 */
export const DESIGN_FRAME_THEME_TOKENS: ReadonlyArray<string> = [
  "--oct-bg",
  "--oct-surface",
  "--oct-surface-warm",
  "--oct-fg",
  "--oct-fg-2",
  "--oct-fg-soft",
  "--oct-muted",
  "--oct-meta",
  "--oct-border",
  "--oct-border-soft",
  "--oct-selection",
  "--oct-accent",
  "--oct-accent-fg",
  "--oct-accent-on",
  "--oct-accent-soft",
  "--oct-success",
  "--oct-success-fg",
  "--oct-success-soft",
  "--oct-warn",
  "--oct-warn-fg",
  "--oct-warn-soft",
  "--oct-danger",
  "--oct-danger-fg",
  "--oct-danger-soft",
  "--oct-series-1",
  "--oct-series-2",
  "--oct-series-3",
  "--oct-series-4",
  "--oct-series-5",
  "--oct-series-6",
  "--oct-font-body",
  "--oct-font-mono",
  "--oct-text-xs",
  "--oct-text-sm",
  "--oct-text-base",
  "--oct-text-lg",
  "--oct-text-xl",
  "--oct-text-2xl",
  "--oct-text-3xl",
  "--oct-leading-body",
  "--oct-leading-tight",
  "--oct-leading-heading",
  "--oct-leading-snug",
  "--oct-leading-code",
  "--oct-weight-medium",
  "--oct-weight-strong",
  "--oct-tracking-tight",
  "--oct-tracking-snug",
  "--oct-tracking-wide",
  "--oct-space-1",
  "--oct-space-2",
  "--oct-space-3",
  "--oct-space-4",
  "--oct-space-6",
  "--oct-space-8",
  "--oct-radius-sm",
  "--oct-radius-md",
  "--oct-radius-pill",
];

/** The workspace's scheme and token values, as a themed frame is drawn with them. */
export interface DesignFrameThemeValues {
  readonly scheme: "light" | "dark";
  readonly tokens: ReadonlyArray<readonly [name: string, value: string]>;
}

/**
 * Whether a design is drawn in the workspace theme. A document is unless it
 * opts out; a device-size screen keeps its own brand unless it opts in.
 */
export function designFrameTheme(
  block: Pick<CanvasDesignBlock, "size" | "theme">,
): CanvasDesignTheme {
  return block.theme ?? (block.size === "document" ? "workspace" : "none");
}

/**
 * The sandbox a design's frame is drawn in. It never includes
 * `allow-scripts`. A document or a themed frame is same-origin so the host can
 * measure its page and hand it Octant's fonts; with no script, the page itself
 * can use none of that. Every other frame keeps an empty sandbox.
 */
export function designFrameSandbox(
  block: Pick<CanvasDesignBlock, "size" | "theme">,
): "" | "allow-same-origin" {
  return block.size === "document" || designFrameTheme(block) === "workspace"
    ? "allow-same-origin"
    : "";
}

/**
 * The workspace theme as `element` sees it. Each token is copied as its
 * computed value, which already holds the person's theme, contrast, and style,
 * so the frame needs none of Octant's own stylesheets. A value that could end
 * its declaration or rule is left out rather than written into the page.
 */
export function readWorkspaceFrameTheme(element: Element): DesignFrameThemeValues {
  const style = getComputedStyle(element);
  const tokens: Array<readonly [string, string]> = [];
  for (const name of DESIGN_FRAME_THEME_TOKENS) {
    const value = style.getPropertyValue(name).trim();
    if (value.length > 0 && value.length <= 512 && !/[<>{};]/.test(value)) {
      tokens.push([name, value]);
    }
  }
  return { scheme: workspaceScheme(element.ownerDocument), tokens };
}

function workspaceScheme(document: Document): "light" | "dark" {
  const mode = document.documentElement.dataset.octantThemeMode;
  if (mode === "light" || mode === "dark") return mode;
  const view = document.defaultView;
  return view !== null &&
    typeof view.matchMedia === "function" &&
    view.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/**
 * How a surface reaches the host for a design's images. The host resolves
 * them under the thread's authority each time it is asked; a surface without
 * one draws every declared image as a placeholder.
 */
export interface DesignAssetRuntime {
  readonly resolve: (
    blockId: string,
  ) => Promise<ReadonlyArray<CanvasDesignAssetResolution> | undefined>;
}

/** What a placeholder says about why its image is not drawn. */
export type DesignAssetPlaceholderReason =
  | CanvasDesignAssetUnavailableReason
  | "loading"
  | "not-loaded";

const PLACEHOLDER_LABEL: Record<DesignAssetPlaceholderReason, string> = {
  loading: "Loading image",
  "not-loaded": "Image not shown here",
  missing: "Image not found",
  refused: "Image not available to this Canvas",
  "too-large": "Image too large",
  "design-budget": "Design image budget spent",
  "not-an-image": "Not an image",
};

/**
 * The image drawn where a declared asset could not be: a hatched panel that
 * names the asset and why, as a `data:` image so it stands in a `src`, a
 * `srcset`, or a `url()` alike and the page still loads nothing.
 */
export function designAssetPlaceholder(
  assetId: string,
  reason: DesignAssetPlaceholderReason,
): string {
  // Asset ids are letters, digits, dots, dashes, and underscores, so they
  // need no escaping in the markup below; anything else is not drawn.
  const id = /^[A-Za-z0-9._-]{1,64}$/.test(assetId) ? assetId : "asset";
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200">',
    '<defs><pattern id="h" width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">',
    '<rect width="12" height="12" fill="#eceae4"/><rect width="5" height="12" fill="#e2dfd6"/></pattern></defs>',
    '<rect width="320" height="200" fill="url(#h)"/>',
    '<rect x="1" y="1" width="318" height="198" fill="none" stroke="#a39d8f" stroke-dasharray="6 4" stroke-width="2"/>',
    `<text x="160" y="96" text-anchor="middle" font-family="system-ui, sans-serif" font-size="15" font-weight="600" fill="#4a463e">${PLACEHOLDER_LABEL[reason]}</text>`,
    `<text x="160" y="120" text-anchor="middle" font-family="ui-monospace, monospace" font-size="12" fill="#6b665b">${id}</text>`,
    "</svg>",
  ].join("");
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

/**
 * The address each declared asset is drawn from: the resolved image, or a
 * placeholder that says why not. `resolved` undefined means the host has not
 * answered yet (`loading`) or there is no host to ask (`not-loaded`).
 */
export function designAssetUrls(
  block: Pick<CanvasDesignBlock, "assets">,
  resolved: ReadonlyArray<CanvasDesignAssetResolution> | undefined,
  pending: "loading" | "not-loaded",
): ReadonlyMap<string, string> {
  const urls = new Map<string, string>();
  for (const asset of block.assets ?? []) {
    const id = String(asset.assetId);
    const outcome = resolved?.find((entry) => String(entry.assetId) === id);
    urls.set(
      id,
      outcome === undefined
        ? designAssetPlaceholder(id, resolved === undefined ? pending : "refused")
        : outcome.status === "resolved"
          ? `data:${outcome.mediaType};base64,${outcome.data}`
          : designAssetPlaceholder(id, outcome.reason),
    );
  }
  return urls;
}

const ASSET_REFERENCE = new RegExp(
  `${CANVAS_DESIGN_ASSET_SCHEME.replace(/[-:]/g, "\\$&")}([A-Za-z0-9][A-Za-z0-9._-]{0,63})`,
  "g",
);

/**
 * Every literal `octant-asset:<id>` in markup or styles, replaced with the
 * address it is drawn from. The host's markup policy admits only literal
 * references to declared ids, so an id with no address here was not declared
 * and is drawn as a placeholder rather than left for the browser to request.
 */
function withAssets(markup: string, urls: ReadonlyMap<string, string> | undefined): string {
  if (!markup.includes(CANVAS_DESIGN_ASSET_SCHEME)) return markup;
  return markup.replace(
    ASSET_REFERENCE,
    (_reference, id: string) => urls?.get(id) ?? designAssetPlaceholder(id, "refused"),
  );
}

export function designDocument(
  block: Pick<CanvasDesignBlock, "size" | "theme" | "styles" | "frames">,
  options: {
    readonly frameIds?: ReadonlyArray<string>;
    readonly startFrameId?: string;
    /** The workspace theme a themed design is drawn in. */
    readonly theme?: DesignFrameThemeValues;
    /** Where each declared asset is drawn from, from `designAssetUrls`. */
    readonly assetUrls?: ReadonlyMap<string, string>;
  } = {},
): string {
  const isDocument = block.size === "document";
  const viewportWidth =
    block.size === "document" ? "device-width" : String(CANVAS_DESIGN_VIEWPORT[block.size].width);
  const shown =
    options.frameIds === undefined
      ? block.frames
      : block.frames.filter((frame) => options.frameIds?.includes(String(frame.frameId)));
  const start = options.startFrameId ?? String(shown[0]?.frameId ?? "");
  const frames = shown
    .map((frame) => {
      const id = escapeAttribute(String(frame.frameId));
      const startMark = String(frame.frameId) === start ? " data-start" : "";
      return `<div class="octant-frame" id="${id}"${startMark}>${withOwnAddress(withAssets(frame.html, options.assetUrls))}</div>`;
    })
    .join("");
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${FRAME_POLICY}">`,
    `<meta name="viewport" content="width=${viewportWidth}">`,
    `<style>${isDocument ? DOCUMENT_FRAME_RULES : DEVICE_FRAME_RULES}</style>`,
    designFrameTheme(block) === "workspace"
      ? workspaceStyles(options.theme, isDocument)
      : `<style>${UNTHEMED_PAGE}</style>`,
    // The host refuses a stylesheet that closes its element; this keeps that
    // true for a document that reached the renderer some other way.
    `<style>${withAssets(block.styles ?? "", options.assetUrls).replace(/<\/style/gi, "<\\/style")}</style>`,
    `</head><body>${frames}</body></html>`,
  ].join("");
}

/**
 * The workspace tokens, then the frame kit, both ahead of the author's own
 * styles. A document is transparent so it sits on the Canvas surface; a
 * themed screen paints the workspace ground. The frame's scheme matches the
 * workspace, which is also what lets a browser draw a transparent frame
 * without an opaque backdrop behind it.
 */
function workspaceStyles(theme: DesignFrameThemeValues | undefined, isDocument: boolean): string {
  const tokens = (theme?.tokens ?? []).map(([name, value]) => `${name}: ${value};`).join(" ");
  return [
    `<style>:root { color-scheme: ${theme?.scheme ?? "light"}; ${tokens} }`,
    `html { background: ${isDocument ? "transparent" : "var(--oct-bg)"}; }</style>`,
    `<style>${DESIGN_FRAME_KIT}</style>`,
  ].join("");
}

/** The host admits only fragment links, so every `href=` here starts with `#`. */
function withOwnAddress(html: string): string {
  return html.replace(/([\s/"'](?:xlink:)?href\s*=\s*["']?\s*)#/gi, "$1about:srcdoc#");
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
