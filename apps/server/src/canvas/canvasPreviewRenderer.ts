import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { chromium, type Browser } from "playwright-core";
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

/** The image is never wider than this, whatever the requested width. */
export const CANVAS_PREVIEW_MAX_IMAGE_WIDTH = 1_600;
/** A taller Canvas is cut off here; the warnings still read the whole document. */
export const CANVAS_PREVIEW_MAX_IMAGE_HEIGHT = 4_096;

/**
 * The origin the preview page is loaded under. `.invalid` never resolves, so
 * even a request that escaped interception could not reach a real host.
 */
export const CANVAS_PREVIEW_ORIGIN = "http://canvas-preview.octant.invalid";
/** The preview page's folder inside the built web assets. */
export const CANVAS_PREVIEW_ASSET_FOLDER = "canvas-preview";
export const CANVAS_PREVIEW_PAGE = "canvas-preview.html";
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
): CanvasPreviewRenderer {
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

  return {
    available: async () => (await resolveExecutable()) !== undefined,
    render: async (request) => {
      const executable = await resolveExecutable();
      if (executable === undefined) return { kind: "unavailable", reason: "no-browser" };
      let pageMarkup: string;
      try {
        pageMarkup = await readFile(resolve(previewRoot, CANVAS_PREVIEW_PAGE), "utf8");
      } catch {
        return { kind: "unavailable", reason: "no-renderer" };
      }
      const designPages = request.designPages ?? [];
      const page = canvasPreviewPageWithInput(pageMarkup, {
        definition: request.definition,
        theme: request.theme,
        placement: request.placement,
        designAssets: request.designAssets ?? [],
        designPages: designPages.map((entry, index) => ({
          blockId: entry.blockId,
          path: `${CANVAS_PREVIEW_DESIGN_PAGE_PREFIX}${String(index)}`,
        })),
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
        const context = await browser.newContext({
          viewport: { width, height: 600 },
          deviceScaleFactor: 1,
          colorScheme: request.theme,
          serviceWorkers: "block",
          acceptDownloads: false,
        });
        // Every request, not only navigations. Only the preview page's own built
        // files are answered, from disk; anything else is a bug, not a
        // resource, and is aborted so the network stays off.
        await context.route("**/*", async (route) => {
          const url = route.request().url();
          if (url === `${CANVAS_PREVIEW_ORIGIN}/${CANVAS_PREVIEW_PAGE}`) {
            await route.fulfill({ status: 200, contentType: "text/html", body: page });
            return;
          }
          const designPage = designPages[canvasPreviewDesignPageIndex(url) ?? -1];
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
        const tab = await context.newPage();
        await tab.goto(`${CANVAS_PREVIEW_ORIGIN}/${CANVAS_PREVIEW_PAGE}`, {
          waitUntil: "load",
          timeout: SETTLE_TIMEOUT_MS,
        });
        await tab.waitForSelector("html[data-canvas-preview]", {
          state: "attached",
          timeout: SETTLE_TIMEOUT_MS,
        });
        if ((await tab.getAttribute("html", "data-canvas-preview")) !== "ready") {
          return { kind: "unavailable", reason: "failed" };
        }
        if (designPages.length > 0) await tab.waitForTimeout(RUNNING_DESIGN_SETTLE_MS);
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
  };
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
