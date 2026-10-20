import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The Canvas preview page a development host screenshots for an agent.
 *
 * The page is a second Vite build of the web app, so a host that runs the
 * renderer on Vite alone has none and every preview reports no renderer. A
 * development launcher builds it here before the host starts, and again only
 * when the renderer's sources are newer than the built page, so a preview
 * draws the Canvas the way the renderer being edited draws it.
 */
export const CANVAS_PREVIEW_PAGE_PATH = "dist/canvas-preview/canvas-preview.html";

/**
 * What the page is built from, relative to the web root; a newer one makes the
 * page stale. The workspace packages are bundled from their sources, so an edit
 * to a schema, a domain rule or a theme role changes the page as much as an
 * edit under `src` does.
 */
const CANVAS_PREVIEW_SOURCES: ReadonlyArray<string> = [
  "src",
  "../../packages/contracts/src",
  "../../packages/domain/src",
  "../../packages/theme/src",
  "canvas-preview.html",
  "vite.canvas-preview.config.ts",
  "vite.fonts.ts",
];

export interface EnsureCanvasPreviewPageOptions {
  /** The web package root (`apps/web`). */
  readonly webRoot: string;
  /** Runs the web package's preview build and resolves with its exit code. */
  readonly build?: (webRoot: string) => Promise<number>;
}

export type CanvasPreviewPageOutcome =
  | { readonly status: "current" }
  | { readonly status: "built" }
  | { readonly status: "failed"; readonly exitCode: number };

export async function ensureCanvasPreviewPage(
  options: EnsureCanvasPreviewPageOptions,
): Promise<CanvasPreviewPageOutcome> {
  if (!canvasPreviewPageStale(options.webRoot)) return { status: "current" };
  const exitCode = await (options.build ?? buildCanvasPreviewPage)(options.webRoot);
  return exitCode === 0 ? { status: "built" } : { status: "failed", exitCode };
}

function canvasPreviewPageStale(webRoot: string): boolean {
  const page = join(webRoot, CANVAS_PREVIEW_PAGE_PATH);
  if (!existsSync(page)) return true;
  const builtAt = statSync(page).mtimeMs;
  return CANVAS_PREVIEW_SOURCES.some((source) => newestModifiedAt(join(webRoot, source)) > builtAt);
}

function newestModifiedAt(path: string): number {
  if (!existsSync(path)) return 0;
  const info = statSync(path);
  if (!info.isDirectory()) return info.mtimeMs;
  let newest = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const modifiedAt = newestModifiedAt(join(path, entry.name));
    if (modifiedAt > newest) newest = modifiedAt;
  }
  return newest;
}

async function buildCanvasPreviewPage(webRoot: string): Promise<number> {
  const child = Bun.spawn({
    cmd: ["bun", "run", "--cwd", webRoot, "build:canvas-preview"],
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exited;
}
