import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { chromium, type Browser } from "playwright-core";
import type { CanvasDefinition } from "@octant/contracts/canvas";
import { DEFAULT_BROWSER_EXECUTABLE_CANDIDATES } from "../browser/playwrightBrowserRuntime";

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
 * preview page's own built folder is answered from disk, and every other
 * request is aborted, so nothing leaves the process. The page has no address
 * for the host's server and holds no credential, and its own content security
 * policy forbids connections as well.
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
}

export type CanvasPreviewRenderOutcome =
  | { readonly kind: "rendered"; readonly png: Uint8Array; readonly height: number }
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
const CANVAS_PREVIEW_PAGE = "canvas-preview.html";
/** How long the page may take to load and settle before the look is abandoned. */
const SETTLE_TIMEOUT_MS = 15_000;

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
    ((executablePath: string) => chromium.launch({ executablePath, headless: true }));

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
      const page = canvasPreviewPageWithInput(pageMarkup, {
        definition: request.definition,
        theme: request.theme,
        placement: request.placement,
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
        const box = await tab.locator(".canvas-preview-page").boundingBox();
        const height = Math.min(
          CANVAS_PREVIEW_MAX_IMAGE_HEIGHT,
          Math.max(1, Math.ceil(box?.height ?? 1)),
        );
        const png = await tab.screenshot({
          type: "png",
          fullPage: true,
          clip: { x: 0, y: 0, width, height },
        });
        await context.close();
        return { kind: "rendered", png, height };
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
