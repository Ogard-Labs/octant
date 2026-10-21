import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import type { CanvasDefinition, CanvasDesignAssetResolution } from "@octant/contracts/canvas";
import { DEFAULT_BROWSER_EXECUTABLE_CANDIDATES } from "../browser/playwrightBrowserRuntime";
import { canvasDesignPageHeaders } from "./canvasDesignPage";
import { readPreviewDesignFrames, type CanvasPreviewDesignReading } from "./canvasPreviewFrames";

/**
 * Screenshotting a Canvas the way a person sees it.
 *
 * The host's headless Chromium loads the web app's own Canvas preview page —
 * the same renderer and stylesheet the thread draws a Canvas with, built into
 * the web assets — and the screenshot is taken once that page says the drawing
 * has settled. The document reaches the page as inert JSON written into the
 * page by the host.
 *
 * The page reaches nothing. Every request is intercepted: a file under the
 * preview page's own built folder is answered from disk, a running design's
 * page the host built is answered from memory, and every other request is
 * aborted, so nothing leaves the process. The page has no address for the
 * host's server and holds no credential, and its own content security policy
 * forbids connections as well.
 *
 * A running design's script runs here, in a frame sandboxed to scripts alone
 * under the same page policy a reader's frame gets. Request interception does
 * not see WebRTC, so the browser is also started with no route out: every
 * connection is sent to a proxy that does not exist, names never resolve, and
 * WebRTC may not use UDP outside that proxy.
 *
 * The executable is found the same way the browser runtime and the Canvas
 * browser smoke find one: the same candidate list, the same X_OK check. No
 * second browser and no second renderer is introduced.
 */
export interface CanvasPreviewRenderRequest {
  readonly definition: CanvasDefinition;
  /** The drawn width in CSS pixels. */
  readonly width: number;
  readonly theme: "light" | "dark";
  /** `thread` draws the Canvas as it sits inline in a thread, without its title. */
  readonly placement: "document" | "thread";
  /**
   * Each design's images, already resolved by the host under the thread's
   * authority, so the picture shows what a reader sees. The page inlines
   * them; it still requests nothing.
   */
  readonly designAssets?: ReadonlyArray<CanvasPreviewDesignAssets>;
  /**
   * Each running design's page, built by the host as the page route builds
   * it. The preview page loads them in frames so a prototype runs, and its
   * bridge reports its errors, before the picture is taken.
   */
  readonly designPages?: ReadonlyArray<CanvasPreviewDesignPage>;
}

export interface CanvasPreviewDesignPage {
  readonly blockId: string;
  readonly html: string;
}

export interface CanvasPreviewDesignAssets {
  readonly blockId: string;
  readonly assets: ReadonlyArray<CanvasDesignAssetResolution>;
}

export type CanvasPreviewRenderOutcome =
  | {
      readonly kind: "rendered";
      readonly png: Uint8Array;
      readonly height: number;
      /** What the browser measured in each design it drew. */
      readonly designs: ReadonlyArray<CanvasPreviewDesignReading>;
    }
  | {
      readonly kind: "unavailable";
      /**
       * `no-browser`: no Chromium the host may drive. `no-renderer`: the web
       * assets carry no preview page, as in a development checkout that has not
       * built the web app. `failed`: the page did not settle or the screenshot
       * failed.
       */
      readonly reason: "no-browser" | "no-renderer" | "failed";
    };

export interface CanvasPreviewRenderer {
  /** Whether a Chromium executable the host may drive was found. */
  available(): Promise<boolean>;
  render(request: CanvasPreviewRenderRequest): Promise<CanvasPreviewRenderOutcome>;
}

/**
 * One frame of a design drawn as a picture: the standalone page the HTML
 * export writes for it, the sandbox that page is drawn in, and its size.
 */
export interface CanvasExportPictureFrame {
  readonly page: string;
  readonly sandbox: "" | "allow-scripts";
  readonly width: number;
  readonly height: number;
}

/**
 * What a picture export draws. A design's frames are drawn one to a sheet at
 * their own size — a PNG each, or a PDF page each. A Canvas with no such
 * frames is drawn as the preview page draws it: one tall PNG, or a PDF the
 * browser paginates.
 */
export interface CanvasExportPictureRequest {
  readonly format: "png" | "pdf";
  readonly theme: "light" | "dark";
  readonly subject:
    | { readonly kind: "frames"; readonly frames: ReadonlyArray<CanvasExportPictureFrame> }
    | {
        readonly kind: "document";
        readonly definition: CanvasDefinition;
        readonly designPages?: ReadonlyArray<CanvasPreviewDesignPage>;
      };
}

export type CanvasExportPictureOutcome =
  | {
      readonly kind: "rendered";
      /** One PNG per frame (or one of the document), or exactly one PDF. */
      readonly files: ReadonlyArray<Uint8Array>;
    }
  | {
      readonly kind: "unavailable";
      readonly reason: "no-browser" | "no-renderer" | "failed";
    };

/** The seam a picture export reaches the browser through; a test fakes it here. */
export interface CanvasExportRenderer {
  available(): Promise<boolean>;
  renderPictures(request: CanvasExportPictureRequest): Promise<CanvasExportPictureOutcome>;
}

/** The image is never wider than this, whatever the requested width. */
export const CANVAS_PREVIEW_MAX_IMAGE_WIDTH = 1_600;
/** A taller Canvas is cut off here; the warnings still read the whole document. */
export const CANVAS_PREVIEW_MAX_IMAGE_HEIGHT = 4_096;
/** A document exported as one PNG is drawn this wide, and cut off this tall. */
export const CANVAS_EXPORT_DOCUMENT_PICTURE_WIDTH = 1_200;
export const CANVAS_EXPORT_DOCUMENT_PICTURE_MAX_HEIGHT = 16_384;
/**
 * A document exported as a PDF is laid out at the width of an A4 page inside
 * its margins, so the browser paginates the same column a reader would print.
 */
export const CANVAS_EXPORT_DOCUMENT_PDF_WIDTH = 700;
const CANVAS_EXPORT_DOCUMENT_PDF_MARGIN = "12mm";
/** Design frames in a PDF are pictures; drawn at twice their size they stay crisp. */
const CANVAS_EXPORT_PDF_FRAME_SCALE = 2;

/**
 * The origin the preview page is loaded under. `.invalid` never resolves, so
 * even a request that escaped interception could not reach a real host.
 */
export const CANVAS_PREVIEW_ORIGIN = "http://canvas-preview.octant.invalid";
/** The preview page's folder inside the built web assets. */
export const CANVAS_PREVIEW_ASSET_FOLDER = "canvas-preview";
export const CANVAS_PREVIEW_PAGE = "canvas-preview.html";
/** The page that lays a design's frames out one to a sheet, built in memory. */
const CANVAS_EXPORT_SHEETS_PAGE = "canvas-export-sheets.html";
/** Where the preview page finds a running design's page, by its position. */
const CANVAS_PREVIEW_DESIGN_PAGE_PREFIX = "/design-page/";
/** How long the page may take to load and settle before the look is abandoned. */
const SETTLE_TIMEOUT_MS = 15_000;
/**
 * How long a running design gets to load, run its first script, and report
 * through its bridge before it is measured. An error thrown later, on a click,
 * is not seen by a preview.
 */
const RUNNING_DESIGN_SETTLE_MS = 800;
/**
 * No route out of the preview browser. Interception already aborts every
 * request it sees; these close what it does not see. Port 1 is never a proxy,
 * so a connection sent there fails on this machine. Measured against Chrome
 * with a prototype that opened a peer connection to listeners on this
 * machine: without the WebRTC policy its STUN datagrams arrived, without the
 * loopback rule its TURN connection over TCP arrived, and with all of these
 * nothing did. The `--force-` spelling of the WebRTC switch changed nothing.
 */
export const CANVAS_PREVIEW_BROWSER_ARGS: ReadonlyArray<string> = [
  "--proxy-server=socks5://127.0.0.1:1",
  // A browser reaches this machine's own addresses without its proxy unless
  // told otherwise, and a prototype must not reach a local service either.
  "--proxy-bypass-list=<-loopback>",
  "--host-resolver-rules=MAP * ~NOTFOUND",
  "--webrtc-ip-handling-policy=disable_non_proxied_udp",
];

export interface PlaywrightCanvasPreviewRendererOptions {
  /** The built web assets folder (`apps/web/dist`). */
  readonly webAssetsPath: string;
  readonly executableCandidates?: ReadonlyArray<string>;
  readonly executable?: (path: string) => Promise<boolean>;
  /** Starts the headless browser; injectable so a test can make it fail. */
  readonly launch?: (executablePath: string) => Promise<Browser>;
}

export function createPlaywrightCanvasPreviewRenderer(
  options: PlaywrightCanvasPreviewRendererOptions,
): CanvasPreviewRenderer & CanvasExportRenderer {
  const candidates =
    options.executableCandidates ??
    (process.env.OCTANT_BROWSER_EXECUTABLE === undefined
      ? DEFAULT_BROWSER_EXECUTABLE_CANDIDATES
      : [process.env.OCTANT_BROWSER_EXECUTABLE, ...DEFAULT_BROWSER_EXECUTABLE_CANDIDATES]);
  const isExecutable =
    options.executable ??
    (async (path: string) => {
      try {
        await access(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  const previewRoot = resolve(options.webAssetsPath, CANVAS_PREVIEW_ASSET_FOLDER);
  const launch =
    options.launch ??
    ((executablePath: string) =>
      chromium.launch({ executablePath, headless: true, args: [...CANVAS_PREVIEW_BROWSER_ARGS] }));

  async function resolveExecutable(): Promise<string | undefined> {
    for (const candidate of candidates) {
      if (await isExecutable(candidate)) return candidate;
    }
    return undefined;
  }

  /**
   * The preview page with this document written into it, or why there is
   * none: a build without the page, or a page that is not the preview page.
   */
  async function previewPage(input: {
    readonly definition: CanvasDefinition;
    readonly theme: "light" | "dark";
    readonly placement: "document" | "thread";
    readonly designAssets: ReadonlyArray<CanvasPreviewDesignAssets>;
    readonly designPages: ReadonlyArray<CanvasPreviewDesignPage>;
  }): Promise<string | undefined> {
    let pageMarkup: string;
    try {
      pageMarkup = await readFile(resolve(previewRoot, CANVAS_PREVIEW_PAGE), "utf8");
    } catch {
      return undefined;
    }
    return canvasPreviewPageWithInput(pageMarkup, {
      definition: input.definition,
      theme: input.theme,
      placement: input.placement,
      designAssets: input.designAssets,
      designPages: input.designPages.map((entry, index) => ({
        blockId: entry.blockId,
        path: `${CANVAS_PREVIEW_DESIGN_PAGE_PREFIX}${String(index)}`,
      })),
    });
  }

  /**
   * A browser context that answers only what the host built — the page named
   * here, a design page by its position, and the preview page's own built
   * files from disk — and aborts every other request, so the network stays
   * off. Every request, not only navigations.
   */
  async function openContext(
    browser: Browser,
    input: {
      readonly viewport: { readonly width: number; readonly height: number };
      readonly theme: "light" | "dark";
      readonly page: { readonly name: string; readonly html: string };
      readonly designPages: ReadonlyArray<{ readonly html: string }>;
      readonly deviceScaleFactor?: number;
    },
  ): Promise<BrowserContext> {
    const context = await browser.newContext({
      viewport: { width: input.viewport.width, height: input.viewport.height },
      deviceScaleFactor: input.deviceScaleFactor ?? 1,
      colorScheme: input.theme,
      serviceWorkers: "block",
      acceptDownloads: false,
    });
    await context.route("**/*", async (route) => {
      const url = route.request().url();
      if (url === `${CANVAS_PREVIEW_ORIGIN}/${input.page.name}`) {
        await route.fulfill({ status: 200, contentType: "text/html", body: input.page.html });
        return;
      }
      const designPage = input.designPages[canvasPreviewDesignPageIndex(url) ?? -1];
      if (designPage !== undefined) {
        await route.fulfill({
          status: 200,
          headers: canvasDesignPageHeaders("text/html; charset=utf-8"),
          body: designPage.html,
        });
        return;
      }
      const asset = canvasPreviewAssetPath(url, previewRoot);
      if (asset === undefined) {
        await route.abort();
        return;
      }
      try {
        const body = await readFile(asset);
        await route.fulfill({ status: 200, contentType: contentTypeFor(asset), body });
      } catch {
        await route.abort();
      }
    });
    return context;
  }

  /** The preview page opened and settled, or `undefined` when it never said ready. */
  async function openPreviewPage(
    context: BrowserContext,
    runningDesigns: boolean,
  ): Promise<Page | undefined> {
    const tab = await context.newPage();
    await tab.goto(`${CANVAS_PREVIEW_ORIGIN}/${CANVAS_PREVIEW_PAGE}`, {
      waitUntil: "load",
      timeout: SETTLE_TIMEOUT_MS,
    });
    await tab.waitForSelector("html[data-canvas-preview]", {
      state: "attached",
      timeout: SETTLE_TIMEOUT_MS,
    });
    if ((await tab.getAttribute("html", "data-canvas-preview")) !== "ready") return undefined;
    if (runningDesigns) await tab.waitForTimeout(RUNNING_DESIGN_SETTLE_MS);
    return tab;
  }

  return {
    available: async () => (await resolveExecutable()) !== undefined,
    render: async (request) => {
      const executable = await resolveExecutable();
      if (executable === undefined) return { kind: "unavailable", reason: "no-browser" };
      const designPages = request.designPages ?? [];
      const page = await previewPage({
        definition: request.definition,
        theme: request.theme,
        placement: request.placement,
        designAssets: request.designAssets ?? [],
        designPages,
      });
      if (page === undefined) return { kind: "unavailable", reason: "no-renderer" };

      const width = Math.min(
        CANVAS_PREVIEW_MAX_IMAGE_WIDTH,
        Math.max(1, Math.round(request.width)),
      );
      // A browser that will not start is a failed look, reported as a value
      // like any other, not an exception thrown at the tool caller.
      let browser: Browser | undefined;
      try {
        browser = await launch(executable);
        const context = await openContext(browser, {
          viewport: { width, height: 600 },
          theme: request.theme,
          page: { name: CANVAS_PREVIEW_PAGE, html: page },
          designPages,
        });
        const tab = await openPreviewPage(context, designPages.length > 0);
        if (tab === undefined) return { kind: "unavailable", reason: "failed" };
        const designs = await readPreviewDesignFrames(tab);
        const box = await tab.locator(".canvas-preview-page").boundingBox();
        const height = Math.min(
          CANVAS_PREVIEW_MAX_IMAGE_HEIGHT,
          Math.max(1, Math.ceil(box?.height ?? 1)),
        );
        const png = await tab.screenshot({
          type: "png",
          fullPage: true,
          clip: { x: 0, y: 0, width, height },
          timeout: SETTLE_TIMEOUT_MS,
        });
        await context.close();
        return { kind: "rendered", png, height, designs };
      } catch {
        return { kind: "unavailable", reason: "failed" };
      } finally {
        await browser?.close().catch(() => undefined);
      }
    },
    renderPictures: async (request) => {
      const executable = await resolveExecutable();
      if (executable === undefined) return { kind: "unavailable", reason: "no-browser" };
      const subject = request.subject;
      // What is opened: a design's frames on sheets of their own size, or the
      // preview page at the width the picture is drawn at.
      let opened:
        | {
            readonly kind: "sheets";
            readonly html: string;
            readonly frames: ReadonlyArray<CanvasExportPictureFrame>;
          }
        | { readonly kind: "preview"; readonly html: string };
      let viewport: { readonly width: number; readonly height: number };
      let designPages: ReadonlyArray<{ readonly html: string }>;
      if (subject.kind === "frames") {
        if (subject.frames.length === 0) return { kind: "unavailable", reason: "failed" };
        opened = {
          kind: "sheets",
          html: canvasExportSheetsPage(subject.frames),
          frames: subject.frames,
        };
        viewport = {
          width: Math.max(...subject.frames.map((frame) => frame.width)),
          height: Math.max(...subject.frames.map((frame) => frame.height)),
        };
        designPages = subject.frames.map((frame) => ({ html: frame.page }));
      } else {
        const pages = subject.designPages ?? [];
        const html = await previewPage({
          definition: subject.definition,
          theme: request.theme,
          placement: "document",
          designAssets: [],
          designPages: pages,
        });
        if (html === undefined) return { kind: "unavailable", reason: "no-renderer" };
        opened = { kind: "preview", html };
        viewport = {
          width:
            request.format === "pdf"
              ? CANVAS_EXPORT_DOCUMENT_PDF_WIDTH
              : CANVAS_EXPORT_DOCUMENT_PICTURE_WIDTH,
          height: 600,
        };
        designPages = pages;
      }
      const drawsFramesAsImages = request.format === "pdf" && opened.kind === "sheets";
      let browser: Browser | undefined;
      try {
        browser = await launch(executable);
        const context = await openContext(browser, {
          viewport,
          theme: request.theme,
          deviceScaleFactor: drawsFramesAsImages ? CANVAS_EXPORT_PDF_FRAME_SCALE : 1,
          page:
            opened.kind === "sheets"
              ? { name: CANVAS_EXPORT_SHEETS_PAGE, html: opened.html }
              : { name: CANVAS_PREVIEW_PAGE, html: opened.html },
          designPages,
        });
        let tab: Page | undefined;
        if (opened.kind === "sheets") {
          tab = await context.newPage();
          // The page's own load waits for every sheet's frame; a frame that
          // runs script gets the same settle a preview gives it.
          await tab.goto(`${CANVAS_PREVIEW_ORIGIN}/${CANVAS_EXPORT_SHEETS_PAGE}`, {
            waitUntil: "load",
            timeout: SETTLE_TIMEOUT_MS,
          });
          await tab.evaluate(() => document.fonts.ready.then(() => undefined));
          if (opened.frames.some((frame) => frame.sandbox === "allow-scripts")) {
            await tab.waitForTimeout(RUNNING_DESIGN_SETTLE_MS);
          }
        } else {
          tab = await openPreviewPage(context, designPages.length > 0);
          if (tab === undefined) return { kind: "unavailable", reason: "failed" };
        }
        let files: Uint8Array[];
        if (request.format === "pdf" && opened.kind === "sheets") {
          // Each sheet is drawn as the screen draws it and the PDF holds those
          // pictures, one page per sheet (see the sheets page for why).
          const pictures: Uint8Array[] = [];
          for (let index = 0; index < opened.frames.length; index += 1) {
            pictures.push(
              await tab
                .locator(".octant-sheet")
                .nth(index)
                .screenshot({ type: "png", timeout: SETTLE_TIMEOUT_MS }),
            );
          }
          const printTab = await context.newPage();
          await printTab.setContent(canvasExportSheetsPage(opened.frames, pictures), {
            waitUntil: "load",
            timeout: SETTLE_TIMEOUT_MS,
          });
          // Each sheet declares its own page size, so the PDF has one page per
          // frame at the frame's size and no margin.
          files = [
            await printTab.pdf({
              printBackground: true,
              preferCSSPageSize: true,
              margin: NO_MARGIN,
            }),
          ];
        } else if (request.format === "pdf") {
          files = [
            await tab.pdf({
              printBackground: true,
              format: "A4",
              margin: {
                top: CANVAS_EXPORT_DOCUMENT_PDF_MARGIN,
                right: CANVAS_EXPORT_DOCUMENT_PDF_MARGIN,
                bottom: CANVAS_EXPORT_DOCUMENT_PDF_MARGIN,
                left: CANVAS_EXPORT_DOCUMENT_PDF_MARGIN,
              },
            }),
          ];
        } else if (opened.kind === "sheets") {
          files = [];
          for (let index = 0; index < opened.frames.length; index += 1) {
            files.push(
              await tab
                .locator(".octant-sheet")
                .nth(index)
                .screenshot({ type: "png", timeout: SETTLE_TIMEOUT_MS }),
            );
          }
        } else {
          const box = await tab.locator(".canvas-preview-page").boundingBox();
          const height = Math.min(
            CANVAS_EXPORT_DOCUMENT_PICTURE_MAX_HEIGHT,
            Math.max(1, Math.ceil(box?.height ?? 1)),
          );
          files = [
            await tab.screenshot({
              type: "png",
              fullPage: true,
              clip: { x: 0, y: 0, width: viewport.width, height },
              timeout: SETTLE_TIMEOUT_MS,
            }),
          ];
        }
        await context.close();
        return { kind: "rendered", files };
      } catch {
        return { kind: "unavailable", reason: "failed" };
      } finally {
        await browser?.close().catch(() => undefined);
      }
    },
  };
}

const NO_MARGIN = { top: "0", right: "0", bottom: "0", left: "0" } as const;

/**
 * The page that holds a design's frames one to a sheet, each a frame of the
 * served design page at its position, at the frame's own size. A sheet is a
 * page of its own size when printed — a named `@page` per distinct size,
 * because frames of two designs can differ — and the box a PNG is cut from
 * on screen. The page loads nothing but those frames; its policy says so.
 *
 * With `pictures` (one PNG per frame) each sheet holds the frame's picture
 * instead, inline: a PDF printed from that page keeps what the screen drew,
 * where print mode drops backgrounds inside child frames and flattens blur
 * filters and large shadows.
 */
export function canvasExportSheetsPage(
  frames: ReadonlyArray<CanvasExportPictureFrame>,
  pictures?: ReadonlyArray<Uint8Array>,
): string {
  const sizes = new Map<string, { readonly width: number; readonly height: number }>();
  const pageNames: string[] = [];
  for (const frame of frames) {
    const key = `${String(frame.width)}x${String(frame.height)}`;
    if (!sizes.has(key)) sizes.set(key, { width: frame.width, height: frame.height });
    pageNames.push(`sheet-${key}`);
  }
  const pageRules = [...sizes.entries()]
    .map(
      ([key, size]) =>
        `@page sheet-${key} { size: ${String(size.width)}px ${String(size.height)}px; margin: 0; }`,
    )
    .join("\n");
  const sheets = frames
    .map((frame, index) => {
      const style = `width:${String(frame.width)}px;height:${String(frame.height)}px;page:${pageNames[index] ?? "auto"}`;
      const size = `width:${String(frame.width)}px;height:${String(frame.height)}px`;
      const picture = pictures?.[index];
      const content =
        picture === undefined
          ? `<iframe sandbox="${frame.sandbox}" src="${CANVAS_PREVIEW_DESIGN_PAGE_PREFIX}${String(index)}" style="${size}"></iframe>`
          : `<img alt="" src="data:image/png;base64,${Buffer.from(picture).toString("base64")}" style="${size}">`;
      return `<div class="octant-sheet" style="${style}">${content}</div>`;
    })
    .join("");
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; ${pictures === undefined ? "frame-src 'self'" : "img-src data:"}">`,
    "<style>",
    "html, body { margin: 0; background: white; }",
    ".octant-sheet { overflow: hidden; break-after: page; page-break-after: always; }",
    ".octant-sheet:last-child { break-after: auto; page-break-after: auto; }",
    ".octant-sheet iframe, .octant-sheet img { display: block; border: 0; }",
    pageRules,
    "</style></head>",
    `<body>${sheets}</body></html>`,
  ].join("");
}

/**
 * The preview page with the document written into it as inert JSON.
 *
 * The JSON is escaped so no character of the document can end the data block
 * or open markup; the page reads it with `JSON.parse`, never as script. A page
 * without a head is not the preview page, and `undefined` says so.
 */
export function canvasPreviewPageWithInput(
  pageMarkup: string,
  input: {
    readonly definition: CanvasDefinition;
    readonly theme: "light" | "dark";
    readonly placement: "document" | "thread";
    readonly designAssets?: ReadonlyArray<CanvasPreviewDesignAssets>;
    readonly designPages?: ReadonlyArray<{ readonly blockId: string; readonly path: string }>;
  },
): string | undefined {
  const headEnd = pageMarkup.indexOf("</head>");
  if (headEnd < 0) return undefined;
  const json = JSON.stringify(input)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll(" ", "\\u2028")
    .replaceAll(" ", "\\u2029");
  const data = `<script type="application/json" id="canvas-preview-data">${json}</script>`;
  return `${pageMarkup.slice(0, headEnd)}${data}${pageMarkup.slice(headEnd)}`;
}

/**
 * The file a preview request may be answered with, or `undefined` to abort it.
 *
 * Only a request to the preview origin for a file inside the preview page's
 * own built folder is answered. A different origin, a path that climbs out of
 * the folder, or one that cannot be read as a path is refused.
 */
export function canvasPreviewAssetPath(url: string, previewRoot: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.origin !== CANVAS_PREVIEW_ORIGIN) return undefined;
  let pathname: string;
  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return undefined;
  }
  if (pathname.includes("\0")) return undefined;
  const root = resolve(previewRoot);
  const candidate = resolve(root, `.${pathname}`);
  return candidate.startsWith(`${root}${sep}`) ? candidate : undefined;
}

/**
 * Which running design's page a request asks for, or `undefined` when it asks
 * for none: the preview origin, the design-page folder, and a position.
 */
export function canvasPreviewDesignPageIndex(url: string): number | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.origin !== CANVAS_PREVIEW_ORIGIN || parsed.search !== "") return undefined;
  if (!parsed.pathname.startsWith(CANVAS_PREVIEW_DESIGN_PAGE_PREFIX)) return undefined;
  const position = parsed.pathname.slice(CANVAS_PREVIEW_DESIGN_PAGE_PREFIX.length);
  return /^\d{1,3}$/.test(position) ? Number(position) : undefined;
}

function contentTypeFor(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".js":
      return "text/javascript";
    case ".css":
      return "text/css";
    case ".woff2":
      return "font/woff2";
    case ".woff":
      return "font/woff";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    default:
      return "application/octet-stream";
  }
}
