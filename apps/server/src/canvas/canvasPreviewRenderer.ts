import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { chromium } from "playwright-core";
import type { CanvasDefinition } from "@octant/contracts/canvas";
import { DEFAULT_BROWSER_EXECUTABLE_CANDIDATES } from "../browser/playwrightBrowserRuntime";
import { renderArtifactSvg, type ArtifactThumbnailPalette } from "./artifactRender";

/**
 * Rasterising a Canvas through the host's own headless Chromium.
 *
 * The page is built by the host from its own renderer — the shared, first-party
 * drawing the export and the mirror already use — and carries no script and no
 * remote reference of any kind. Chromium's whole job is to turn that drawing
 * into the raster an agent can look at; the network is aborted on every request,
 * so a page that tried to reach out would fail rather than leak.
 *
 * The executable is found the same way the browser runtime and the Canvas
 * browser smoke find one: the same candidate list, the same X_OK check. No
 * second browser and no second renderer is introduced.
 */
export interface CanvasPreviewRenderRequest {
  readonly definition: Pick<CanvasDefinition, "title" | "blocks">;
  /** The drawn width in CSS pixels. */
  readonly width: number;
  /** The drawn height in CSS pixels. */
  readonly height: number;
  readonly palette: ArtifactThumbnailPalette;
}

export type CanvasPreviewRenderOutcome =
  | { readonly kind: "rendered"; readonly png: Uint8Array }
  | { readonly kind: "unavailable" };

export interface CanvasPreviewRenderer {
  /** Whether a Chromium executable the host may drive was found. */
  available(): Promise<boolean>;
  render(request: CanvasPreviewRenderRequest): Promise<CanvasPreviewRenderOutcome>;
}

/** The image is never wider than this, whatever the requested width. */
export const CANVAS_PREVIEW_MAX_IMAGE_WIDTH = 1_600;

export interface PlaywrightCanvasPreviewRendererOptions {
  readonly executableCandidates?: ReadonlyArray<string>;
  readonly executable?: (path: string) => Promise<boolean>;
}

export function createPlaywrightCanvasPreviewRenderer(
  options: PlaywrightCanvasPreviewRendererOptions = {},
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
      if (executable === undefined) return { kind: "unavailable" };
      const width = Math.min(
        CANVAS_PREVIEW_MAX_IMAGE_WIDTH,
        Math.max(1, Math.round(request.width)),
      );
      const height = Math.min(4_096, Math.max(1, Math.round(request.height)));
      const markup = renderArtifactSvg(request.definition, {
        width,
        height,
        palette: request.palette,
      });
      const browser = await chromium.launch({ executablePath: executable, headless: true });
      try {
        const context = await browser.newContext({
          viewport: { width, height },
          deviceScaleFactor: 1,
        });
        // Every request, not only navigations: the page carries the drawing and
        // nothing else, so a request that leaves the process is a bug, not a
        // resource. Aborting is how the network stays off.
        await context.route("**/*", async (route) => {
          await route.abort();
        });
        const page = await context.newPage();
        await page.setContent(previewDocument(markup), { waitUntil: "load" });
        const png = await page.screenshot({ type: "png", fullPage: true });
        await context.close();
        return { kind: "rendered", png };
      } catch {
        return { kind: "unavailable" };
      } finally {
        await browser.close().catch(() => undefined);
      }
    },
  };
}

/**
 * The page Chromium is given.
 *
 * The first-party drawing is embedded inline and the page declares no other
 * resource: no script, no stylesheet, no font of its own, no image. That is
 * what makes "the page loads only the host's own renderer and the Canvas data"
 * true by construction rather than by convention.
 */
export function previewDocument(svgMarkup: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#ffffff}svg{display:block}</style></head><body>${svgMarkup}</body></html>`;
}
