import {
  CANVAS_DESIGN_VIEWPORT,
  type CanvasStaticExportBlock,
  DESIGN_FRAME_KIT,
  type CanvasShareImage,
  withDrawnDesignAssetAddresses,
} from "./shareKit.ts";
import type { ServiceContext } from "./context.ts";
import { escapeHtml } from "./render.ts";
import { carriedImageResponse } from "./images.ts";
import {
  frameImageTokenIsValid,
  mintFrameImageToken,
  readFrameToken,
  type FrameMode,
} from "./tokens.ts";

type DesignBlock = Extract<CanvasStaticExportBlock, { readonly kind: "design" }>;

const FRAME_HEADERS = {
  "x-robots-tag": "noindex, nofollow, noarchive",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
} as const;

/**
 * The policy a static frame is served under: no script, nothing loaded but
 * inline style, data images, and the share's own images under `images`, the
 * path prefix of this frame's image route.
 */
export function staticFramePolicy(publicOrigin: string, images = ""): string {
  return `sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:${images === "" ? "" : ` ${images}`}; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors ${publicOrigin}`;
}

/**
 * The policy a running frame is served under: script allowed, the network
 * not, except the share's own images under `images`, this frame's image
 * route, which answers only for the images the share carries.
 */
export function runningFramePolicy(publicOrigin: string, images = ""): string {
  return `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:${images === "" ? "" : ` ${images}`}; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors ${publicOrigin}`;
}

// One frame shown at a time on a device size: the one the address names, the
// one holding the section it names, or else the first. A document shows every
// frame in order.
const DEVICE_FRAME_RULES = [
  "html, body { margin: 0; min-height: 100%; }",
  ".octant-frame { display: none; min-height: 100vh; }",
  ".octant-frame:target, .octant-frame:has(:target) { display: block; }",
  "body:not(:has(.octant-frame:target, .octant-frame :target)) .octant-frame[data-start] { display: block; }",
].join("\n");
const DOCUMENT_FRAME_RULES = [
  "html, body { margin: 0; }",
  "body { display: flow-root; }",
  ".octant-frame { display: block; }",
].join("\n");
const UNTHEMED_PAGE = "html { color-scheme: light; background: white; color: black; }";

// The workspace tokens the frame kit reads, with the values of the default
// theme. A shared design is handed no window's tokens, so a themed frame is
// drawn in these and follows the viewer's light or dark setting.
const THEME_SHARED = [
  "--oct-font-body: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  "--oct-font-mono: ui-monospace, 'SF Mono', Menlo, monospace",
  "--oct-text-xs: 0.75rem",
  "--oct-text-sm: 0.8125rem",
  "--oct-text-base: 1rem",
  "--oct-text-lg: 1.125rem",
  "--oct-text-xl: 1.375rem",
  "--oct-text-2xl: 1.75rem",
  "--oct-text-3xl: 2.25rem",
  "--oct-leading-body: 1.6",
  "--oct-leading-tight: 1.2",
  "--oct-leading-heading: 1.25",
  "--oct-leading-snug: 1.4",
  "--oct-leading-code: 1.5",
  "--oct-weight-medium: 500",
  "--oct-weight-strong: 600",
  "--oct-tracking-tight: -0.02em",
  "--oct-tracking-snug: -0.01em",
  "--oct-tracking-wide: 0.04em",
  "--oct-space-1: 0.25rem",
  "--oct-space-2: 0.5rem",
  "--oct-space-3: 0.75rem",
  "--oct-space-4: 1rem",
  "--oct-space-6: 1.5rem",
  "--oct-space-8: 2rem",
  "--oct-radius-sm: 4px",
  "--oct-radius-md: 8px",
  "--oct-radius-pill: 999px",
];
const THEME_LIGHT = [
  "--oct-bg: #ffffff",
  "--oct-surface: #f6f6f7",
  "--oct-surface-warm: #f3f1ee",
  "--oct-fg: #1b1b1d",
  "--oct-fg-2: #3a3a3e",
  "--oct-fg-soft: #55555b",
  "--oct-muted: #6b6b72",
  "--oct-meta: #6b6b72",
  "--oct-border: #cfcfd4",
  "--oct-border-soft: #e4e4e8",
  "--oct-selection: #dbe7ff",
  "--oct-accent: #2f5fd0",
  "--oct-accent-fg: #2f5fd0",
  "--oct-accent-on: #ffffff",
  "--oct-accent-soft: #e6eefc",
  "--oct-success: #1f7a4d",
  "--oct-success-fg: #1f7a4d",
  "--oct-success-soft: #e3f4ea",
  "--oct-warn: #a86400",
  "--oct-warn-fg: #8a5200",
  "--oct-warn-soft: #fbf0dc",
  "--oct-danger: #b3261e",
  "--oct-danger-fg: #b3261e",
  "--oct-danger-soft: #fbe6e4",
  "--oct-series-1: #2f5fd0",
  "--oct-series-2: #1f7a4d",
  "--oct-series-3: #a86400",
  "--oct-series-4: #8a3fb0",
  "--oct-series-5: #b3261e",
  "--oct-series-6: #3a8a9a",
];
const THEME_DARK = [
  "--oct-bg: #131315",
  "--oct-surface: #1c1c1f",
  "--oct-surface-warm: #211f1c",
  "--oct-fg: #ececef",
  "--oct-fg-2: #d0d0d5",
  "--oct-fg-soft: #b0b0b8",
  "--oct-muted: #9a9aa3",
  "--oct-meta: #9a9aa3",
  "--oct-border: #3a3a40",
  "--oct-border-soft: #2a2a2f",
  "--oct-selection: #25365e",
  "--oct-accent: #7ea2f5",
  "--oct-accent-fg: #7ea2f5",
  "--oct-accent-on: #101018",
  "--oct-accent-soft: #1f2a46",
  "--oct-success: #5fc592",
  "--oct-success-fg: #5fc592",
  "--oct-success-soft: #173024",
  "--oct-warn: #e0a23c",
  "--oct-warn-fg: #e0a23c",
  "--oct-warn-soft: #33270f",
  "--oct-danger: #f08a82",
  "--oct-danger-fg: #f08a82",
  "--oct-danger-soft: #3a1b19",
  "--oct-series-1: #7ea2f5",
  "--oct-series-2: #5fc592",
  "--oct-series-3: #e0a23c",
  "--oct-series-4: #c58be6",
  "--oct-series-5: #f08a82",
  "--oct-series-6: #6cc4d4",
];

function themeStyles(): string {
  const rule = (tokens: ReadonlyArray<string>) => tokens.map((token) => `${token};`).join(" ");
  return [
    `<style>:root { color-scheme: light dark; ${rule(THEME_SHARED)} ${rule(THEME_LIGHT)} }`,
    `@media (prefers-color-scheme: dark) { :root { ${rule(THEME_DARK)} } }`,
    "html { background: var(--oct-bg); }</style>",
    `<style>${DESIGN_FRAME_KIT}</style>`,
  ].join("");
}

/**
 * The page for one design's frames, as the app draws them but without the
 * host bridge: a shared page has no host to report to. A static design gets a
 * page per request that runs nothing; the response policy, not the markup,
 * is what keeps it that way.
 */
export function renderDesignFramePage(
  block: DesignBlock,
  images: ReadonlyArray<CanvasShareImage>,
  imageAddress: (image: CanvasShareImage) => string,
): string {
  // An image the share carries is drawn from its own address on this
  // origin, which the browser fetches once however often the frame names it;
  // a declared image the share does not carry keeps its reference, which
  // loads nothing.
  const carried = new Map(images.map((image) => [String(image.imageRef), image]));
  const imageOf = new Map(
    (block.assets ?? []).map((asset) => [String(asset.assetId), String(asset.imageRef)]),
  );
  const draw = (markup: string, language: "html" | "css") =>
    withDrawnDesignAssetAddresses(markup, language, (assetId) => {
      const image = carried.get(imageOf.get(assetId) ?? "");
      return image === undefined ? `octant-asset:${assetId}` : imageAddress(image);
    });
  const isDocument = block.size === "document";
  const themed = (block.theme ?? (isDocument ? "workspace" : "none")) === "workspace";
  const viewport = block.size === "document" ? undefined : CANVAS_DESIGN_VIEWPORT[block.size];
  const first = String(block.frames[0]?.frameId ?? "");
  const styles = draw(block.styles ?? "", "css");
  const frames = block.frames
    .map((frame) => {
      const id = String(frame.frameId);
      return `<div class="octant-frame" id="${escapeHtml(id)}"${id === first ? " data-start" : ""}>${draw(frame.html, "html")}</div>`;
    })
    .join("");
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8">',
    `<meta name="viewport" content="width=${viewport === undefined ? "device-width" : String(viewport.width)}">`,
    '<meta name="robots" content="noindex, nofollow">',
    `<title>${escapeHtml(block.title)}</title>`,
    `<style>${isDocument ? DOCUMENT_FRAME_RULES : DEVICE_FRAME_RULES}</style>`,
    themed ? themeStyles() : `<style>${UNTHEMED_PAGE}</style>`,
    // A stylesheet that closes its element would let author text become markup.
    `<style>${styles.replace(/<\/style/gi, "<\\/style")}</style>`,
    `</head><body>${frames}</body></html>`,
  ].join("");
}

function plain(status: number, text: string, policy: string): Response {
  return new Response(text, {
    status,
    headers: {
      ...FRAME_HEADERS,
      "content-type": "text/plain; charset=utf-8",
      "content-security-policy": policy,
    },
  });
}

/**
 * The user-content origin: `GET /f/<id>/<blockId>?t=<frame token>`, a
 * design's frame page, and `GET /f/<id>/<blockId>/images/<sha256>?t=<image
 * token>`, one image that design shows, and nothing else. The frame page
 * hands its images a token of their own, for the same link, revision and
 * block, so an image is served only to a frame the viewer opened.
 */
export function handleFrame(request: Request, ctx: ServiceContext, client: string): Response {
  const refused = staticFramePolicy(ctx.publicOrigin);
  const url = new URL(request.url);
  const match = /^\/f\/([^/]+)\/([^/]+)(?:\/images\/([0-9a-f]{64}))?$/.exec(url.pathname);
  if (request.method !== "GET" || match === null) return plain(404, "Not found", refused);
  const id = match[1] ?? "";
  const sha256 = match[3];
  let blockId: string;
  try {
    blockId = decodeURIComponent(match[2] ?? "");
  } catch {
    return plain(404, "Not found", refused);
  }
  if (sha256 !== undefined && !ctx.limiter.allow("image", client)) {
    return plain(429, "Too many requests", refused);
  }
  const token = url.searchParams.get("t") ?? "";
  const lookup = ctx.store.lookup(id);
  if (lookup.status !== "active") return plain(404, "Not found", refused);
  const { share } = lookup;
  const key = ctx.store.frameKey();
  const now = ctx.store.now();
  const block = share.document.blocks.find(
    (candidate) => candidate.kind === "design" && String(candidate.blockId) === blockId,
  );
  // Only the images this design names, by the share's own references.
  const named = new Set(
    block?.kind === "design" ? (block.assets ?? []).map((asset) => String(asset.imageRef)) : [],
  );
  const images = (share.document.images ?? []).filter((image) => named.has(String(image.imageRef)));
  if (sha256 !== undefined) {
    if (!frameImageTokenIsValid(key, id, share.revision, blockId, now, token)) {
      return plain(403, "This image address is not valid or has expired.", refused);
    }
    const image = images.find((each) => each.sha256 === sha256);
    if (image?.data === undefined) return plain(404, "Not found", refused);
    return carriedImageResponse(request, image, {
      ...FRAME_HEADERS,
      "content-security-policy": refused,
      // A sandboxed frame's origin is opaque, so its own images are a
      // cross-origin load; the token in the address is the authority.
      "access-control-allow-origin": "*",
      "cross-origin-resource-policy": "cross-origin",
    });
  }
  const mode: FrameMode | undefined = readFrameToken(key, id, share.revision, blockId, now, token);
  if (mode === undefined)
    return plain(403, "This frame address is not valid or has expired.", refused);
  if (block?.kind !== "design") return plain(404, "Not found", refused);
  // A token minted for a static frame never opens the script policy, and a
  // running token only opens a design that declared it runs script.
  if (mode === "running" && block.runsScript !== true) return plain(404, "Not found", refused);
  const base = `/f/${id}/${encodeURIComponent(blockId)}/images/`;
  const imageToken = encodeURIComponent(mintFrameImageToken(key, id, share.revision, blockId, now));
  const imagePrefix = images.length === 0 ? "" : `${new URL(ctx.usercontentOrigin).origin}${base}`;
  const address = (image: CanvasShareImage) => `${base}${image.sha256}?t=${imageToken}`;
  return new Response(renderDesignFramePage(block, images, address), {
    status: 200,
    headers: {
      ...FRAME_HEADERS,
      "content-type": "text/html; charset=utf-8",
      "content-security-policy":
        mode === "running"
          ? runningFramePolicy(ctx.publicOrigin, imagePrefix)
          : staticFramePolicy(ctx.publicOrigin, imagePrefix),
    },
  });
}
