import { randomBytes } from "node:crypto";
import {
  CANVAS_DESIGN_ASSET_SCHEME,
  CANVAS_DESIGN_ASSETS_MAX_BYTES,
  CANVAS_DESIGN_BRIDGE_CHANNEL,
  CANVAS_DESIGN_BRIDGE_MAX_ERROR_LENGTH,
  CANVAS_DESIGN_HEARTBEAT_INTERVAL_MS,
  CANVAS_DESIGN_PAGE_PATH,
  CANVAS_DESIGN_RUN_TICKET_TTL_MS,
  CANVAS_DESIGN_VIEWPORT,
  type CanvasBlockId,
  type CanvasDesignAssetResolution,
  type CanvasDesignBlock,
  type CanvasId,
  type CanvasProvenance,
  type CanvasVersionId,
} from "@octant/contracts/canvas";
import type { CanvasStaticExportDocument } from "@octant/contracts/canvas-share";
import { getDefaultToken } from "@octant/theme";

/**
 * The page a running design is served as, and the tickets that open it.
 *
 * A running design's script cannot run in a `srcdoc` frame: that page
 * inherits Octant's own policy, which admits only Octant's script. So the host
 * serves the page itself, under a policy of its own that admits the page's
 * inline script and loads nothing. The `sandbox` directive gives the page an
 * opaque origin even if it is opened outside its frame, so it can reach no
 * cookie, storage, or Octant page, and the parent frame repeats the same
 * sandbox. Nothing here is an Octant credential: the address carries only a
 * ticket for one page, which the host forgets once it is used or expires.
 */

/** The policy a running page is served under, exactly. */
export const CANVAS_DESIGN_PAGE_POLICY =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";

/** Every response from the page route, a page or a refusal, carries these. */
export function canvasDesignPageHeaders(contentType: string): Record<string, string> {
  return {
    "content-type": contentType,
    "content-security-policy": CANVAS_DESIGN_PAGE_POLICY,
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
}

/** What one ticket opens: a design in one Canvas version, from one frame. */
export interface CanvasDesignRunGrant {
  readonly canvasId: CanvasId;
  readonly versionId: CanvasVersionId;
  readonly blockId: CanvasBlockId;
  readonly startFrameId: string;
  /** The version is immutable, so the design is kept as it was authorized. */
  readonly block: CanvasDesignBlock;
  /**
   * The authority the design's declared images resolve under. Absent for a
   * design read from a shared snapshot, which carries no image to resolve.
   */
  readonly provenance?: CanvasProvenance;
}

// A reader asks for a ticket just before it loads the page, so only a handful
// are ever outstanding. The bound keeps a caller that asks without loading
// from holding designs in memory; the oldest ticket is forgotten first.
const MAX_OUTSTANDING_TICKETS = 64;

/**
 * Single-use tickets for running pages, held in memory only. A ticket is 32
 * random bytes; redeeming one forgets it whether or not it is still fresh, so
 * a replayed, expired, or guessed ticket opens nothing.
 */
export class CanvasDesignRunTickets {
  readonly #now: () => number;
  readonly #tickets = new Map<
    string,
    { readonly grant: CanvasDesignRunGrant; readonly expiresAt: number }
  >();

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  issue(grant: CanvasDesignRunGrant): string {
    const ticket = randomBytes(32).toString("base64url");
    this.#forgetExpired();
    while (this.#tickets.size >= MAX_OUTSTANDING_TICKETS) {
      const oldest = this.#tickets.keys().next().value;
      if (oldest === undefined) break;
      this.#tickets.delete(oldest);
    }
    this.#tickets.set(ticket, { grant, expiresAt: this.#now() + CANVAS_DESIGN_RUN_TICKET_TTL_MS });
    return ticket;
  }

  redeem(ticket: string): CanvasDesignRunGrant | undefined {
    const entry = this.#tickets.get(ticket);
    if (entry === undefined) return undefined;
    this.#tickets.delete(ticket);
    return this.#now() < entry.expiresAt ? entry.grant : undefined;
  }

  #forgetExpired(): void {
    const now = this.#now();
    for (const [ticket, entry] of this.#tickets) {
      if (now >= entry.expiresAt) this.#tickets.delete(ticket);
    }
  }
}

/**
 * A ticketed page for one of a shared snapshot's prototypes, or `undefined`
 * when there is none to offer: the snapshot holds no running design by that
 * id, the frame is not one of its frames, or this host issues no tickets. The
 * caller has already decided, and journaled, that this reader may open the
 * snapshot; the page is that snapshot's own design and nothing else.
 */
export function issueSharedDesignRun(
  tickets: CanvasDesignRunTickets | undefined,
  document: Pick<CanvasStaticExportDocument, "canvasId" | "versionId" | "blocks">,
  run: { readonly blockId: CanvasBlockId; readonly frameId?: string | undefined },
): string | undefined {
  if (tickets === undefined) return undefined;
  const block = document.blocks.find(
    (candidate) => candidate.kind === "design" && String(candidate.blockId) === String(run.blockId),
  );
  if (block?.kind !== "design" || block.runsScript !== true) return undefined;
  const startFrameId = run.frameId ?? block.frames[0]?.frameId;
  if (
    startFrameId === undefined ||
    !block.frames.some((frame) => String(frame.frameId) === String(startFrameId))
  ) {
    return undefined;
  }
  return canvasDesignPagePath(
    tickets.issue({
      canvasId: document.canvasId,
      versionId: document.versionId,
      blockId: run.blockId,
      startFrameId: String(startFrameId),
      // A shared design is a design without declared images.
      block: block as CanvasDesignBlock,
    }),
  );
}

/** The path a reader loads a ticket's page from. */
export function canvasDesignPagePath(ticket: string): string {
  return `${CANVAS_DESIGN_PAGE_PATH}?ticket=${ticket}`;
}

/**
 * The bridge, written first in the page so it runs before the author's script.
 * It reports the page's height, its uncaught errors, and a heartbeat, and it
 * keeps its own references so an author who replaces `setInterval` or
 * `postMessage` later does not silence it by accident. It is not a boundary:
 * the author's script can post the same messages, and the host bounds each
 * one. It asks the host for nothing.
 */
const BRIDGE_SCRIPT = `(function () {
  "use strict";
  var channel = ${JSON.stringify(CANVAS_DESIGN_BRIDGE_CHANNEL)};
  var host = window.parent;
  var send = host.postMessage.bind(host);
  var every = window.setInterval.bind(window);
  var post = function (type, fields) {
    var message = { channel: channel, type: type };
    for (var key in fields) message[key] = fields[key];
    try { send(message, "*"); } catch (_) {}
  };
  var text = function (value) {
    try { return String(value).slice(0, ${String(CANVAS_DESIGN_BRIDGE_MAX_ERROR_LENGTH)}); } catch (_) { return "Script error"; }
  };
  window.addEventListener("error", function (event) {
    post("error", { message: text(event.message || "Script error") });
  });
  window.addEventListener("unhandledrejection", function (event) {
    var reason = event.reason;
    post("error", { message: text(reason && reason.message ? reason.message : reason) });
  });
  var last = -1;
  var measure = function () {
    var body = document.body;
    if (!body) return;
    var height = Math.ceil(body.getBoundingClientRect().height);
    if (height === last) return;
    last = height;
    post("size", { height: height });
  };
  document.addEventListener("DOMContentLoaded", function () {
    measure();
    if (typeof ResizeObserver === "function") new ResizeObserver(measure).observe(document.body);
  });
  post("heartbeat", {});
  every(function () { post("heartbeat", {}); }, ${String(CANVAS_DESIGN_HEARTBEAT_INTERVAL_MS)});
})();`;

/**
 * One frame shown at a time on a device size, as in a static design: the one
 * the address names, the one holding the section it names, or else the start
 * frame. A document shows every frame in order and is measured by its body.
 */
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
// A running design is the author's own page; one that sets no colours reads
// as a browser would show it, whatever theme Octant is in.
const UNTHEMED_PAGE = "html { color-scheme: light; background: white; color: black; }";

/**
 * The page for one running design. Declared images the host resolved are
 * written in as `data:` images, and any other is a placeholder, so the page
 * requests nothing.
 */
export function renderCanvasDesignPage(
  block: CanvasDesignBlock,
  startFrameId: string,
  assets: ReadonlyArray<CanvasDesignAssetResolution>,
): string {
  const isDocument = block.size === "document";
  const viewportWidth =
    block.size === "document" ? "device-width" : String(CANVAS_DESIGN_VIEWPORT[block.size].width);
  const urls = new Map<string, string>();
  for (const asset of block.assets ?? []) {
    const id = String(asset.assetId);
    const outcome = assets.find((entry) => String(entry.assetId) === id);
    urls.set(
      id,
      outcome?.status === "resolved"
        ? `data:${outcome.mediaType};base64,${outcome.data}`
        : assetPlaceholder(id),
    );
  }
  const budget = new PageAssetBudget(urls);
  const frames = block.frames
    .map((frame) => {
      const id = String(frame.frameId);
      const start = id === startFrameId ? " data-start" : "";
      return `<div class="octant-frame" id="${escapeAttribute(id)}"${start}>${withAssets(frame.html, budget)}</div>`;
    })
    .join("");
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8">',
    `<script>${BRIDGE_SCRIPT}</script>`,
    `<meta name="viewport" content="width=${viewportWidth}">`,
    `<style>${isDocument ? DOCUMENT_FRAME_RULES : DEVICE_FRAME_RULES}</style>`,
    `<style>${UNTHEMED_PAGE}</style>`,
    // The host refuses a stylesheet that closes its element; this keeps that
    // true for a document that reached the host some other way.
    `<style>${withAssets(block.styles ?? "", budget).replace(/<\/style/gi, "<\\/style")}</style>`,
    `</head><body>${frames}</body></html>`,
  ].join("");
}

/**
 * The policy an exported static frame carries inside its own page: the frame
 * policy a reader's static frame is drawn under. An exported file has no host
 * to send a header, so the page says it itself, before anything else in it.
 */
export const CANVAS_DESIGN_EXPORT_STATIC_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'";
/**
 * The same for an exported running frame: the served page's policy without
 * `sandbox`, which a page cannot declare for itself; the frame's `sandbox`
 * attribute carries that part.
 */
export const CANVAS_DESIGN_EXPORT_RUNNING_POLICY = CANVAS_DESIGN_PAGE_POLICY.replace(
  /^sandbox allow-scripts; /,
  "",
);

/** One frame of an exported design: the page and the sandbox it is drawn in. */
export interface CanvasDesignExportFrame {
  readonly title: string;
  readonly sandbox: "" | "allow-scripts";
  readonly width: number | undefined;
  readonly height: number;
  readonly page: string;
}

/**
 * A design as an exported HTML file draws it, or `undefined` for a design the
 * export cannot draw as written: one in the workspace theme, whose tokens and
 * frame kit an exported file does not carry.
 *
 * A static design is one page per screen, each holding that screen alone and
 * running nothing. A running design is one page holding every screen, because
 * its script is one program. Neither names an image: a declared image
 * resolves only under this host's authority, so its place draws a placeholder.
 * The bridge is left out; an exported page has no host to report to.
 */
export function renderCanvasDesignExportFrames(
  block: CanvasDesignBlock,
): ReadonlyArray<CanvasDesignExportFrame> | undefined {
  const themed =
    (block.theme ?? (block.size === "document" ? "workspace" : "none")) === "workspace";
  if (themed) return undefined;
  const isDocument = block.size === "document";
  const viewport = block.size === "document" ? undefined : CANVAS_DESIGN_VIEWPORT[block.size];
  const running = block.runsScript === true;
  const page = (frames: CanvasDesignBlock["frames"], startFrameId: string): string => {
    const budget = new PageAssetBudget(new Map());
    const body = frames
      .map((frame) => {
        const id = String(frame.frameId);
        const start = id === startFrameId ? " data-start" : "";
        return `<div class="octant-frame" id="${escapeAttribute(id)}"${start}>${withOwnAddress(withAssets(frame.html, budget))}</div>`;
      })
      .join("");
    return [
      "<!doctype html>",
      '<html><head><meta charset="utf-8">',
      `<meta http-equiv="Content-Security-Policy" content="${running ? CANVAS_DESIGN_EXPORT_RUNNING_POLICY : CANVAS_DESIGN_EXPORT_STATIC_POLICY}">`,
      `<meta name="viewport" content="width=${viewport === undefined ? "device-width" : String(viewport.width)}">`,
      `<style>${isDocument ? DOCUMENT_FRAME_RULES : DEVICE_FRAME_RULES}</style>`,
      `<style>${UNTHEMED_PAGE}</style>`,
      `<style>${withAssets(block.styles ?? "", budget).replace(/<\/style/gi, "<\\/style")}</style>`,
      `</head><body>${body}</body></html>`,
    ].join("");
  };
  const size = { width: viewport?.width, height: viewport?.height ?? EXPORT_DOCUMENT_HEIGHT };
  if (running) {
    const first = String(block.frames[0]?.frameId ?? "");
    return [
      { title: block.title, sandbox: "allow-scripts", ...size, page: page(block.frames, first) },
    ];
  }
  return block.frames.map((frame) => ({
    title: frame.title,
    sandbox: "",
    ...size,
    page: page([frame], String(frame.frameId)),
  }));
}

/** An exported document frame cannot be measured, so it scrolls at this height. */
const EXPORT_DOCUMENT_HEIGHT = 640;

/**
 * A `srcdoc` page resolves a bare fragment against the file that holds it, so
 * a link between screens would load that file into the frame. The markup
 * policy admits only fragment links, so each one is written against the
 * frame's own address, as the app's renderer writes them.
 */
function withOwnAddress(html: string): string {
  return html.replace(/([\s/"'](?:xlink:)?href\s*=\s*["']?\s*)#/gi, "$1about:srcdoc#");
}

/** The page a refused or spent ticket gets: a line of text that runs nothing. */
export function canvasDesignPageRefusal(): string {
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8"><title>Prototype not available</title></head>',
    "<body><p>This prototype link was already used or has expired. Run the prototype again from Octant.</p></body></html>",
  ].join("");
}

// What stands right before an address the browser loads, in the positions the
// host's markup policy admits a reference: a `url()`, a `src`, `srcset`,
// `poster`, or `background` value (or a later srcset candidate), and a quoted
// `image-set()` candidate. The same token in prose, `alt`, or any other
// attribute is the author's text and is left as written. The Canvas renderer
// reads static frames the same way.
const ADDRESS_LEAD = String.raw`(?:url\(\s*["']?\s*|(?:^|[\s"'/])(?:src|srcset|poster|background)\s*=\s*["']?\s*|(?:^|[\s"'/])srcset\s*=\s*(?:"[^"]*?,\s*|'[^']*?,\s*)|image-set\((?:[^()]|\([^()]*\))*?["']\s*)`;
const ASSET_REFERENCE = new RegExp(
  `(?<=${ADDRESS_LEAD})${CANVAS_DESIGN_ASSET_SCHEME.replace(/[-:]/g, "\\$&")}([A-Za-z0-9][A-Za-z0-9._-]{0,63})`,
  "gi",
);

/**
 * How much image data one page may carry: every declared image once, at the
 * host's per-design budget written as base64, and room for placeholders. A
 * reference is written in as a whole `data:` image, so a design that names a
 * 3 MiB image twice would otherwise pass the 8 MiB a remote client is served,
 * and arrive cut short.
 */
const PAGE_ASSET_BUDGET = Math.ceil(CANVAS_DESIGN_ASSETS_MAX_BYTES / 3) * 4 + 128 * 1024;

/**
 * The address each reference is drawn from, charged against the page budget.
 * Each declared image's first reference is reserved up front, so a repeat
 * early in the page cannot crowd out a different image later. A repeat that
 * would pass the budget draws the placeholder, and past that an empty image.
 */
class PageAssetBudget {
  readonly #urls: ReadonlyMap<string, string>;
  readonly #drawn = new Set<string>();
  #spent = 0;

  constructor(urls: ReadonlyMap<string, string>) {
    this.#urls = urls;
    for (const url of urls.values()) this.#spent += url.length;
  }

  address(id: string): string {
    const url = this.#urls.get(id);
    if (url !== undefined && !this.#drawn.has(id)) {
      this.#drawn.add(id);
      return url;
    }
    for (const candidate of [url, assetPlaceholder(id)]) {
      if (candidate !== undefined && this.#spent + candidate.length <= PAGE_ASSET_BUDGET) {
        this.#spent += candidate.length;
        return candidate;
      }
    }
    return "data:,";
  }
}

function withAssets(markup: string, budget: PageAssetBudget): string {
  if (!markup.includes(CANVAS_DESIGN_ASSET_SCHEME)) return markup;
  return markup.replace(ASSET_REFERENCE, (reference: string, id: string) =>
    reference.startsWith(CANVAS_DESIGN_ASSET_SCHEME) ? budget.address(id) : reference,
  );
}

/**
 * The image drawn where a declared asset could not be: a dashed panel naming
 * the asset, in the default light theme's neutrals.
 */
function assetPlaceholder(assetId: string): string {
  const id = /^[A-Za-z0-9._-]{1,64}$/.test(assetId) ? assetId : "asset";
  const ground = getDefaultToken("control-hover", "light");
  const edge = getDefaultToken("border-strong", "light");
  const ink = getDefaultToken("text-secondary", "light");
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200">',
    `<rect width="320" height="200" fill="${ground}"/>`,
    `<rect x="1" y="1" width="318" height="198" fill="none" stroke="${edge}" stroke-dasharray="6 4" stroke-width="2"/>`,
    `<text x="160" y="106" text-anchor="middle" font-family="ui-monospace, monospace" font-size="12" fill="${ink}">${id}</text>`,
    "</svg>",
  ].join("");
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
